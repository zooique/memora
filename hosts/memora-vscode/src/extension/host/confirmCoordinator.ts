import * as vscode from 'vscode';
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
 *
 * **函数而非常量**：`l10n.t` 必须在调用时刻取——模块顶层求值会绕过语言包就绪窗口，
 * 把语言焊死在加载期（同 chatPanel 的 `snapshotOversizeNotice` 先例）。
 */
function confirmTimeoutNotice(): string {
  return vscode.l10n.t('User did not confirm in time; declined automatically');
}

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
  /**
   * 审批卡已推出 webview 之后的钩子（交互提醒，HOST-ATTN-1）
   *
   * **可选**：不注入 = 零行为（既有测试与其它装配点无需改动）。
   * 载荷只给 `requestId` + `label`（`工具：文件名` 简写，与决策记录同一取法）：
   * 通知里**不得**承载 diff 全文——`info.description` 是全文级内容，进 toast 即撑爆且泄露。
   */
  onConfirmShown?: (info: { requestId: string; label: string }) => void;
  /**
   * 某会话的「待处理确认」数量变化（入队 / 裁决 / 超时）
   *
   * 宿主据此重算列表标识与入口角标。**必须按会话回调**：后台会话的确认请求入队时
   * 也要亮标识，否则「后台在等你处理」对用户完全不可见（静默挂起）。
   */
  onPendingChanged?: (sessionId: string, count: number) => void;
}

/** 单条确认请求（入队即定型：requestId / logLabel 只算一次，重推不换身份） */
interface ConfirmEntry {
  requestId: string;
  info: Parameters<WriteConfirmationRequest>[0];
  resolve: (v: boolean) => void;
  /** 决策记录工具面（预计算 `${toolLabel}：${basename}`；裁决/超时同源消费，不记载荷全文） */
  logLabel: string;
  /** 是否已推出过审批卡（切走后置 false，切回按需重推） */
  presented: boolean;
  /** 超时计时器（**首次推出时**才启动；从未上屏的后台请求不烧超时额度） */
  timer?: ReturnType<typeof setTimeout>;
}

/** 单会话确认队列（FIFO 串行：同会话同时只推一张卡） */
interface SessionConfirmState {
  /** 尚未送审的请求 */
  queue: ConfirmEntry[];
  /** 当前在途（已推出或待重推）的请求；null = 无在途 */
  current: ConfirmEntry | null;
}

/**
 * 确认请求协调器（自 chatPanel.ts 迁出，2026-10-21 · HOST-SPLIT-1 第 2 刀）
 *
 * 承载**全部四类**确认请求（写入 / 命令 / 代码 / 脚本执行）——它们在内核共用 `confirmGate`，
 * 宿主只认这一个注入点，故方法名中的 `Write` 是历史命名，不代表「只管写入」。
 *
 * 职责 = 注册回调 + 每会话 FIFO 排队 + 推送审批卡 + 裁决应答 + 决策留痕 + 收卡，
 * 故名 `ConfirmCoordinator`（协调器）而非 `ConfirmQueue`——域不止队列这一件事。
 *
 * **E4 批 4 起按会话绑定**（后台运行与前台一视同仁的唯一例外是「屏幕能显示哪个会话」）：
 *   - 每会话独立队列与在途请求（`_sessions`），后台会话的确认**照常入队、照常可被裁决**，
 *     只是**卡先不上屏**——避免 A 的审批卡盖在 B 的界面上（同为「跨会话串台」）；
 *   - 切到该会话时补推卡（`setForeground`）；切走时收卡但**不终结请求**（回来还能答）；
 *   - 时延计时只在「卡真正上屏」时启动——排队中的请求不白烧超时额度（沿用 FIFO 语义）。
 */
export class ConfirmCoordinator {
  /** 会话 → 该会话的确认队列（懒建；键 = 会话 id） */
  private readonly _sessions = new Map<string, SessionConfirmState>();
  /** 当前显示会话（唯一允许上屏的会话；初值 '' 服务直接驱动协调器的测试） */
  private _foreground = '';

  constructor(private readonly _deps: ConfirmDeps) {}

  /**
   * 为某会话的 Agent 绑定确认回调（`SecurityGuard.onWriteConfirmation` 唯一注入口）
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
   *
   * @param sessionId 该 Agent 所属会话（决定卡推到哪个会话、切会话时的挂起/重推）
   * @param agent     该会话的实例（缺省时静默返回，供装配未完成的容错路径）
   */
  bindSession(sessionId: string, agent: Agent | undefined): void {
    const guard = agent?.security;
    if (!guard) return;
    // 注入确认回调（幂等：onWriteConfirmation 内部覆盖赋值，无重复注册风险）
    const handler: WriteConfirmationRequest = (info) =>
      new Promise<boolean>((resolve) => {
        this._enqueue(sessionId, info, resolve);
      });
    guard.onWriteConfirmation(handler);
  }

  /**
   * 兼容入口：把**当前显示会话**的确认回调绑到最新 agent（chatPanel `bindAgent` 的 sugar）
   *
   * 保留理由：chatPanel 的「换实例即重绑」只有这一处收口，拆成调用方自己传 sessionId
   * 会让「绑定会话」与「设置显示会话」在不同方法里各写一次，时序上容易漏。
   */
  bindWriteConfirmation(): void {
    this.bindSession(this._foreground, this._deps.getAgent());
  }

  /**
   * 切换当前显示会话（卡的上屏权随会话走）
   *
   * @param sessionId 新的显示会话
   */
  setForeground(sessionId: string): void {
    if (this._foreground === sessionId) return;
    const previous = this._foreground;
    this._foreground = sessionId;
    // 离开旧会话：先收卡（不终结请求——回来还能答；计时器继续走，属已上屏请求的既定语义）
    const old = this._sessions.get(previous);
    if (old?.current?.presented) {
      old.current.presented = false;
      this._deps.post({ type: 'write_confirm_closed', requestId: old.current.requestId });
    }
    // 进入新会话：有在途未上屏卡 ⇒ 补推；否则泵队首
    const next = this._sessions.get(sessionId);
    if (next?.current && !next.current.presented) {
      this._show(next.current);
    } else if (!next?.current) {
      this._pump(sessionId);
    }
  }

  /**
   * 重推当前显示会话的审批卡（webview 重建 / 面板重开时调用）
   *
   * 视图重建不会终结请求，但新 webview 里没有旧卡 ⇒ 不重推就会「卡凭空消失、用户无从作答」。
   */
  repostForeground(): void {
    const state = this._sessions.get(this._foreground);
    if (state?.current) this._show(state.current);
  }

  /**
   * 某会话未处理确认数（列表标识 / 入口角标的判据）
   *
   * @param sessionId 会话标识
   */
  pendingCount(sessionId: string): number {
    const state = this._sessions.get(sessionId);
    if (!state) return 0;
    return state.queue.length + (state.current ? 1 : 0);
  }

  /**
   * 入队（同一会话 FIFO 串行）
   *
   * 只有**当前显示会话**才立即尝试送审；后台会话只入队（标识由 `pendingCount` 亮起），
   * 等 `setForeground` 切过去再上屏——这是「卡不跨会话串台」的唯一实现点。
   */
  private _enqueue(
    sessionId: string,
    info: Parameters<WriteConfirmationRequest>[0],
    resolve: (v: boolean) => void,
  ): void {
    // 工具中文名走 toolNameMap 单一真源（复用公开入口 getToolDisplayName）：
    // 本地另建映射易产生幽灵键（edit_file / create_file / append_file 内核并不存在——
    // 唯一写入工具是 write_file），还可能同工具异名双写（「写文件」vs「写入文件」）；
    // 复用入口后内核工具更名/新增无需第二处同步。
    // 表值是**英文源键**（B9-A 起，两侧共用同一张表）：宿主侧必须过 `vscode.l10n.t`
    // 才是译文——webview 用 `@vscode/l10n`，两个本地化器不可互换。
    const toolLabel = vscode.l10n.t(getToolDisplayName(info.tool));
    const entry: ConfirmEntry = {
      requestId: `wc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      info,
      resolve,
      // 决策记录工具面：basename 与安全审计同款取法，防折叠区冗长且不泄露完整目录结构
      logLabel: vscode.l10n.t(
        '{0}: {1}',
        toolLabel,
        info.targetPath.split(/[\\/]/).pop() ?? info.targetPath,
      ),
      presented: false,
    };
    const state = this._stateFor(sessionId);
    state.queue.push(entry);
    this._deps.onPendingChanged?.(sessionId, this.pendingCount(sessionId));
    if (sessionId === this._foreground) this._pump(sessionId);
  }

  /** 取（或建）某会话的确认队列 */
  private _stateFor(sessionId: string): SessionConfirmState {
    let state = this._sessions.get(sessionId);
    if (!state) {
      state = { queue: [], current: null };
      this._sessions.set(sessionId, state);
    }
    return state;
  }

  /**
   * 推送该会话队首确认请求（FIFO 串行送审的唯一推送点）
   *
   * 有在途请求则**不推**（等其裁决/超时后由 `_settle` 再泵）——同时推多条会让
   * webview 只留最后一张卡，其余用户根本看不到（S2 静默拒绝的根因）。
   * 计时自推送时刻起算：排在后面的请求不会在排队期间白烧超时额度。
   */
  private _pump(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state || state.current) return;
    const next = state.queue.shift();
    if (!next) return;
    state.current = next;
    this._show(next);
  }

  /**
   * 把一条请求推出 webview（首推 / 切回重推共用）
   *
   * 同一 requestId 可以推多次（webview 按 id 覆盖渲染）：请求身份不因上屏次数而变。
   */
  private _show(entry: ConfirmEntry): void {
    entry.presented = true;
    const { info, requestId } = entry;
    this._deps.post({
      type: 'write_confirm_request',
      requestId,
      targetPath: info.targetPath,
      tool: info.tool,
      description:
        info.description ||
        vscode.l10n.t('{0}: {1}', vscode.l10n.t(getToolDisplayName(info.tool)), info.targetPath),
      permission: info.permission,
      beforeContent: info.beforeContent ?? null,
      afterContent: info.afterContent,
      // diff 域判据透传内核单点判定结果（hasDiff），webview 据此决定是否渲染对比区
      hasDiff: info.hasDiff,
      // 超时时长透传（A5 SSOT）：真源是本模块的 CONFIRM_TIMEOUT_MS，webview 只投影、
      // 不自算，末段倒计时因此不可能与宿主计时漂移。
      timeoutMs: CONFIRM_TIMEOUT_MS,
    });
    // 首次上屏才起计时：从未上屏的排队请求不得白烧超时额度
    if (!entry.timer && CONFIRM_TIMEOUT_MS > 0) {
      entry.timer = setTimeout(() => this._timeout(entry), CONFIRM_TIMEOUT_MS);
    }
    // 交互提醒钩子（可选）：卡已推出 ⇒ 通知不在面板前的用户。放在 post 之后：
    // 只有卡真的发出去了，提醒才有承接面（先提醒后发卡 = 用户回来找不到卡）。
    this._deps.onConfirmShown?.({ requestId, label: entry.logLabel });
  }

  /**
   * 超时 fail-closed（不批准 = 不执行）
   *
   * @param entry 已上屏的请求
   */
  private _timeout(entry: ConfirmEntry): void {
    entry.resolve(false);
    // 超时拒同样走决策记录（唯一发点 _logDecision）：红条警示 + 时间线留痕，单条双职不双写
    this._logDecision(entry, 'timeout');
    this._settle(entry);
  }

  /**
   * 决策记录唯一发点（C2）：批准 / 拒绝 / 超时自动拒三路径同构入时间线
   *
   * 载荷纪律：**只记工具面（`logLabel`）+ 裁决结果，不记载荷全文**——`info.description`
   * 是 diff 全文级内容，入线即撑爆时间线窗口（20 条淘汰下挤掉的全是别人的记录）。
   * 超时拒 level 保留 error（红条警示职责不变，单条双职：瞬态条 + 时间线决策行，不双写）。
   */
  private _logDecision(entry: ConfirmEntry, verdict: 'approved' | 'declined' | 'timeout'): void {
    const word =
      verdict === 'approved'
        ? vscode.l10n.t('Approved')
        : verdict === 'declined'
          ? vscode.l10n.t('Declined')
          : confirmTimeoutNotice();
    this._deps.post({
      type: 'notice',
      level: verdict === 'timeout' ? 'error' : 'info',
      // 动作词中性化：同一张卡也承载命令/代码/脚本执行确认，写「写入」即失实。
      // 超时行用 `({0})` 键（中英括号形态不同，不能拼字面量括号）；批准/拒绝行词与面之间留空格。
      message:
        verdict === 'timeout'
          ? `${word} ${vscode.l10n.t('({0})', entry.logLabel)}`
          : `${word} ${entry.logLabel}`,
      kind: 'decision',
    });
  }

  /**
   * 终结某会话的当前在途请求（裁决 / 超时同源）并泵下一条
   *
   * 队列还有 ⇒ 仅当该会话是显示会话才**立即**推下一条（卡片被覆盖渲染，不出现「关了又开」
   * 的闪烁，composer 也不会中途恢复）；队列空 ⇒ 推 write_confirm_closed 收卡
   * （否则卡残留成僵尸交互）。
   */
  private _settle(entry: ConfirmEntry): void {
    const sessionId = this._findSession(entry);
    // 空串是合法会话键（协调器单测直驱时的默认会话）⇒ 必须判 undefined，不能用 falsy 判
    if (sessionId === undefined) return;
    const state = this._sessions.get(sessionId)!;
    if (state.current?.requestId !== entry.requestId) return; // 迟到旧回执不得推进新请求
    if (entry.timer) clearTimeout(entry.timer);
    state.current = null;
    this._deps.onPendingChanged?.(sessionId, this.pendingCount(sessionId));
    if (sessionId !== this._foreground) return; // 后台会话裁决后不驱动屏幕
    if (state.queue.length > 0) {
      this._pump(sessionId);
      return;
    }
    this._deps.post({ type: 'write_confirm_closed', requestId: entry.requestId });
  }

  /** 按 requestId 反查所属会话（裁决/超时终结用） */
  private _findSession(entry: ConfirmEntry): string | undefined {
    for (const [sessionId, state] of this._sessions) {
      if (state.current?.requestId === entry.requestId) return sessionId;
    }
    return undefined;
  }

  /**
   * 某会话被删除时丢弃其确认队列（会话级僵尸清理 · E4 批 3）
   *
   * 为什么必须丢弃：`_sessions` 按会话懒建、单条终结只在裁决/超时路径发生，**没有任何
   * 「整会话移除」的出口** ⇒ 已删会话的条目永久留在表里，排队中的 Promise 永不 settle
   * （内核一直等），计时器继续烧，`pendingCount` 还持续给已删会话亮待处理标识。
   *
   * 语义 = fail-closed：所有未裁决请求一律 `resolve(false)`（不批准 = 不执行），与超时同向。
   * **刻意不写决策记录**——会话已删，把「已拒绝」行推到别的会话的时间线就是跨会话串台。
   *
   * @param sessionId 被删除的会话
   */
  disposeSession(sessionId: string): void {
    const state = this._sessions.get(sessionId);
    if (!state) return;
    // ① 该会话正在前台且卡已上屏 ⇒ 收卡（否则 webview 残留一张点了无响应的僵尸卡）
    if (sessionId === this._foreground && state.current?.presented) {
      this._deps.post({ type: 'write_confirm_closed', requestId: state.current.requestId });
    }
    // ② 清计时器 + fail-closed 终结全部未裁决请求（在途 + 排队，一个不留）
    const entries = [state.current, ...state.queue].filter(
      (entry): entry is ConfirmEntry => entry !== null,
    );
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(false);
    }
    // ③ 整会话条目摘除：此后 pendingCount 恒 0，迟到回执经 `answer` 查无此会话 ⇒ 零副作用
    this._sessions.delete(sessionId);
    this._deps.onPendingChanged?.(sessionId, 0);
  }

  /**
   * 按会话应答入口（远程/桥用）：对**指定会话**的在途确认裁决
   *
   * 与 `answer` 的唯一差别是会话可寻址——`answer` 只服务「屏幕上那张卡」，
   * 远程控制需要「任意 sid 的待决审批也能答」，故把寻址拆出来，`answer` 退化为
   * 「对前台会话调用本方法」的 sugar（对外行为逐字不变）。
   *
   * 受理判据与 `answer` 完全一致：只认该会话的**在途**请求（`current`），
   * 排队中（未上屏）的请求与未知 requestId 一律丢弃——排队请求尚未进入用户视野，
   * 提前裁决会让「卡还没出现就被答了」，与 FIFO 串行语义冲突。
   *
   * ⚠️ 决策留痕（notice）**只在该会话正是显示会话时发**：notice 载荷没有会话寻址能力，
   * 给后台会话发就会写进当前屏幕的时间线（跨会话串台）。这条门控不改变 `answer` 的
   * 既有行为（`answer` 恒传前台会话），只约束新增的远程路径。
   *
   * @param sessionId 会话标识（确认请求所属会话）
   * @param requestId 该会话在途请求的 id
   * @param approved  true = 批准；false = 拒绝（fail-closed 语义不变：拒绝即不执行）
   * @returns 是否受理（false = 会话无在途请求 / requestId 不匹配 / 迟到回执）
   */
  answerFor(sessionId: string, requestId: string, approved: boolean): boolean {
    const state = this._sessions.get(sessionId);
    const entry = state?.current;
    if (!entry || entry.requestId !== requestId) return false;
    // 顺序与 answer 原样一致：① resolve → ② 决策留痕（仅前台）→ ③ 终结 + 泵下一条
    entry.resolve(approved);
    if (sessionId === this._foreground) {
      this._logDecision(entry, approved ? 'approved' : 'declined');
    }
    this._settle(entry);
    return true;
  }

  /**
   * 应答入口（webview 回传 `write_confirm_answer` 的唯一处理点）
   *
   * 只接受**当前显示会话**的在途请求：切走后收卡，迟到回执（或别的会话的 id）一律丢弃，
   * 杜绝「B 的界面点了 A 的确认」这类跨会话串台。
   *
   * 顺序**原样保留**（不可调换）：
   *   ① resolve 挂起的 Promise → 内核 confirmationHandler 得裁决
   *   ② 决策留痕（唯一发点 `_logDecision`）：批准/拒绝与超时拒同构入时间线（C2）
   *   ③ 终结 + 泵下一条（卡片关闭/覆盖的唯一真源在宿主「请求已终结」这一事实，
   *      webview 侧不再自行假设「点了就算关」）
   */
  answer(requestId: string, approved: boolean): void {
    // 委托 answerFor：寻址规则只有一份（前台会话），此处不再重写判据
    this.answerFor(this._foreground, requestId, approved);
  }
}
