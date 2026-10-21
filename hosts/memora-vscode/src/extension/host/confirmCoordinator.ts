import type { Agent, WriteConfirmationRequest } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { getToolDisplayName } from '../../webview/helpers/toolNameMap.js';

/**
 * confirm 确认等待超时（ms）：无响应 → **自动拒绝**（fail-closed）。0/负值 = 禁用超时。
 *
 * ⚠️ 与 ASK_TIMEOUT_MS 的语义**刻意不同，勿统一**（2026-10-05 定案，登记为有意的风险分级）：
 *   - ask 超时 → 自动**继续**：不回答 = 什么都不执行，agent 空转往前走，无副作用；
 *   - confirm 超时 → 自动**拒绝**：不批准 = 不执行。执行有副作用（命令/脚本/写入），
 *     默认必须是「不做」。改成自动确认 = fail-open 安全模型反转，已驳回（见方案文档 §二）。
 *
 * 时长取值依据：fail-closed 下超时长度不带来安全风险（风险来自「超时后做什么」而非
 * 「等多久」），30 分钟覆盖「用户离开一会儿」的场景；代价仅是 loop 挂起更久（不烧 token）。
 *
 * ⚠️ 2026-10-13 起与 ASK_TIMEOUT_MS **数值同为 30 分钟**：这是**时长巧合**，不是同一判据。
 * 二者终态相反（continue vs deny），**禁合并为同一常量**——合并即抹掉风险分级这一有意设计。
 * （ASK 侧的真源与对应说明在 `askCoordinator.ts` 的 `ASK_TIMEOUT_MS`。）
 */
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * confirm 超时交互记录正文（镜像语义：与 timeout 分支的 resolve(false) 同因，供用户可知）
 */
const CONFIRM_TIMEOUT_NOTICE = '用户未在时限内确认，已自动拒绝';

/** 协调器全部反向依赖（均由 chatPanel 构造时注入） */
export interface ConfirmDeps {
  /**
   * 读**最新** agent（getter 委托，非快照）
   *
   * ⚠️ 禁改为构造时快照：`setAgent` 会替换 chatPanel 的 `_agent`（换 agent = 投影源切换），
   * 快照会让重新绑定时绑到**旧** agent 的 security 守卫上 ⇒ 确认回调失活（静默）。
   */
  getAgent: () => Agent | undefined;
  /** 消息投递单点（chatPanel 既有 `this.post`） */
  post: (msg: ExtensionToWebviewMessage) => void;
}

/**
 * 确认请求协调器（自 chatPanel.ts 迁出，2026-10-21 · HOST-SPLIT-1 第 2 刀）
 *
 * 承载**全部四类**确认请求（写入 / 命令 / 代码 / 脚本执行）——它们在内核共用 `confirmGate`，
 * 宿主只认这一个注入点，故方法名中的 `Write` 是历史命名，不代表「只管写入」。
 *
 * 职责 = 注册回调 + FIFO 排队 + 推送审批卡 + 裁决应答 + 决策留痕 + 收卡，
 * 故名 `ConfirmCoordinator`（协调器）而非 `ConfirmQueue`——域不止队列这一件事。
 */
export class ConfirmCoordinator {
  /**
   * 待处理确认请求（写入 / 命令 / 代码 / 脚本执行共用同一张审批卡）
   *
   * 内核触发任一确认时，host 创建 requestId + pending Promise，向 webview 推送
   * write_confirm_request 审批卡；用户确认/拒绝后 webview 回传 write_confirm_answer，
   * host resolve 对应 pending Promise，回调内核 confirmationHandler。
   * 超时自动拒绝（fail-closed）。协议名沿用 write_* 历史命名（改协议面 = breaking，不值）。
   *
   * ⚠️ 并发语义（2026-10-05 串行化，修 S2）：内核同一 step 内可**并行**发起多个确认
   * （如并行 write_file），原先「同时推给 webview、webview 只展示最新」⇒ 旧请求用户根本
   * 看不到、只能等超时被动拒绝（静默拒绝）。现改 **FIFO 串行**：先入队，一次只推一条，
   * 裁决/超时后再推下一条 ⇒ 每个请求都真正经过用户，无静默拒绝。
   * 附带收益：计时从「推送时刻」起算，排在后面的请求不会在排队期间白烧超时额度。
   */
  private _pending = new Map<
    string,
    {
      resolve: (v: boolean) => void;
      timer: ReturnType<typeof setTimeout>;
      /** 决策记录工具面（预计算 `${toolLabel}：${basename}`；裁决/超时同源消费，不记载荷全文） */
      logLabel: string;
    }
  >();
  /** 待推送的确认请求队列（FIFO；内核并发确认在此排队，逐个送审）
   *  载荷类型从 `WriteConfirmationRequest` 形参推导——不自抄一份接口，也无需多引一个类型。 */
  private _queue: Array<{
    info: Parameters<WriteConfirmationRequest>[0];
    resolve: (v: boolean) => void;
  }> = [];
  /** 当前正在送审的 requestId（null = 无在途请求，可推下一条） */
  private _currentId: string | null = null;

  constructor(private readonly _deps: ConfirmDeps) {}

  /**
   * 绑定确认回调（`SecurityGuard.onWriteConfirmation` 唯一注入口）
   *
   * 触发条件随内核判据：写入 = `guest || confirmWrites`；命令 = `classifyCommand` 三档；
   * 代码与脚本 = `guest || confirmScripts`。
   * 默认 fail-closed：内核未走到确认分支时直接 auto-approve，不会调用本回调。
   * 交互走 webview 审批卡（write_confirm_request / write_confirm_answer）。
   *
   * ⚠️ 超时语义（2026-10-05 对齐实现，勿再信旧措辞）：**只有超时兜底，没有「不可达即拒」**。
   * 原注释写过「webview 不可达或超时自动拒绝」——「不可达」分支从未实现，且**刻意不补**：
   * VS Code 切走/隐藏面板也会触发 onDidDispose，若在 dispose 时逐个 resolve(false)，
   * 用户切走看个东西回来就被拒（误伤）。正确兜底链 = ①超时（CONFIRM_TIMEOUT_MS，fail-closed）
   * ②webview ready 时补推 pending 队列快照（P2，保证切回来卡还在）。本方法**不在** dispose 清理。
   */
  bindWriteConfirmation(): void {
    const agent = this._deps.getAgent();
    const guard = agent?.security;
    if (!guard) return;
    // 注入确认回调（幂等：onWriteConfirmation 内部覆盖赋值，无重复注册风险）
    const handler: WriteConfirmationRequest = (info) =>
      // 入队后尝试推送（FIFO 串行）：并发确认逐个送审，杜绝「只展示最新、旧请求静默超时」
      new Promise<boolean>((resolve) => {
        this._queue.push({ info, resolve });
        this._pump();
      });
    guard.onWriteConfirmation(handler);
  }

  /**
   * 推送队首确认请求（FIFO 串行送审的唯一推送点）
   *
   * 有在途请求则**不推**（等其裁决/超时后由 `_settle` 再泵）——同时推多条会让
   * webview 只留最后一张卡，其余用户根本看不到（S2 静默拒绝的根因）。
   * 计时自推送时刻起算：排在后面的请求不会在排队期间白烧超时额度。
   */
  private _pump(): void {
    if (this._currentId !== null) return;
    const next = this._queue.shift();
    if (!next) return;
    const { info, resolve } = next;
    // 生成唯一请求 ID，用于匹配 write_confirm_answer
    const requestId = `wc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 工具中文名走 toolNameMap 单一真源（复用公开入口 getToolDisplayName）：
    // 本地另建映射易产生幽灵键（edit_file / create_file / append_file 内核并不存在——
    // 唯一写入工具是 write_file），还可能同工具异名双写（「写文件」vs「写入文件」）；
    // 复用入口后内核工具更名/新增无需第二处同步。
    const toolLabel = getToolDisplayName(info.tool);
    this._currentId = requestId;
    // 决策记录工具面（预计算）：basename 与安全审计同款取法，防折叠区冗长且不泄露完整目录结构
    const logLabel = `${toolLabel}：${info.targetPath.split(/[\\/]/).pop() ?? info.targetPath}`;
    // 超时 timer（fail-closed：超时 = 拒绝）
    const timer = setTimeout(() => {
      resolve(false);
      // 超时拒同样走决策记录（唯一发点 _logDecision）：红条警示 + 时间线留痕，单条双职不双写
      this._logDecision(requestId, 'timeout');
      this._settle(requestId);
    }, CONFIRM_TIMEOUT_MS);
    this._pending.set(requestId, { resolve, timer, logLabel });
    this._deps.post({
      type: 'write_confirm_request',
      requestId,
      targetPath: info.targetPath,
      tool: info.tool,
      description: info.description || `${toolLabel}：${info.targetPath}`,
      permission: info.permission,
      beforeContent: info.beforeContent ?? null,
      afterContent: info.afterContent,
      // diff 域判据透传内核单点判定结果（hasDiff），webview 据此决定是否渲染对比区
      hasDiff: info.hasDiff,
      // 超时时长透传（A5 SSOT）：真源是本模块的 CONFIRM_TIMEOUT_MS，webview 只投影、
      // 不自算，末段倒计时因此不可能与宿主计时漂移。
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
  }

  /**
   * 决策记录唯一发点（C2）：批准 / 拒绝 / 超时自动拒三路径同构入时间线
   *
   * 载荷纪律：**只记工具面（`logLabel`）+ 裁决结果，不记载荷全文**——`info.description`
   * 是 diff 全文级内容，入线即撑爆时间线窗口（20 条淘汰下挤掉的全是别人的记录）。
   * 超时拒 level 保留 error（红条警示职责不变，单条双职：瞬态条 + 时间线决策行，不双写）。
   * 必须在 `_settle` **之前**调用（settle 会 delete pending 表项）。
   */
  private _logDecision(requestId: string, verdict: 'approved' | 'declined' | 'timeout'): void {
    const pending = this._pending.get(requestId);
    if (!pending) return;
    const word =
      verdict === 'approved'
        ? '已批准'
        : verdict === 'declined'
          ? '已拒绝'
          : CONFIRM_TIMEOUT_NOTICE;
    this._deps.post({
      type: 'notice',
      level: verdict === 'timeout' ? 'error' : 'info',
      // 动作词中性化：同一张卡也承载命令/代码/脚本执行确认，写「写入」即失实
      message:
        verdict === 'timeout' ? `${word}（${pending.logLabel}）` : `${word} ${pending.logLabel}`,
      kind: 'decision',
    });
  }

  /**
   * 终结当前在途请求（裁决 / 超时同源）并泵下一条
   *
   * 队列还有 ⇒ **立即**推下一条（卡片被覆盖渲染，不出现「关了又开」的闪烁，composer 也
   * 不会中途恢复）；队列空 ⇒ 推 write_confirm_closed 收卡（否则卡残留成僵尸交互）。
   */
  private _settle(requestId: string): void {
    const pending = this._pending.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this._pending.delete(requestId);
    }
    // 只终结「当前在途」那一个：迟到的旧回执不得清空已推进到的新请求状态
    if (this._currentId !== requestId) return;
    this._currentId = null;
    if (this._queue.length > 0) {
      this._pump();
      return;
    }
    this._deps.post({ type: 'write_confirm_closed', requestId });
  }

  /**
   * 应答入口（webview 回传 `write_confirm_answer` 的唯一处理点）
   *
   * 顺序**原样保留**（不可调换）：
   *   ① resolve 挂起的 Promise → 内核 confirmationHandler 得裁决
   *   ② 决策留痕（唯一发点 `_logDecision`）：批准/拒绝与超时拒同构入时间线（C2）
   *   ③ 终结 + 泵下一条（卡片关闭/覆盖的唯一真源在宿主「请求已终结」这一事实，
   *      webview 侧不再自行假设「点了就算关」）
   */
  answer(requestId: string, approved: boolean): void {
    const pending = this._pending.get(requestId);
    if (!pending) return;
    pending.resolve(approved);
    this._logDecision(requestId, approved ? 'approved' : 'declined');
    this._settle(requestId);
  }
}
