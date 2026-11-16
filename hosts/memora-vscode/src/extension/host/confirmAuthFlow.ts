/**
 * confirmAuthFlow — 异步授权流（`always-ask` 命令的「问一句再执行」闭环 · HOSTED-CONFIRM-AUTH-1）
 *
 * 域职责：托管会话（代理驱动）撞上 `always-ask` 档命令时，**不代批、不弹内核确认卡**，
 * 把命令转述成授权请求推到托管座位时间线（带允许/拒绝按钮的 A 类卡），内核侧收
 * `deferred`（待授权）——代理那一轮正常落定并向用户解释。用户允许 → 写授权条目 +
 * 叫醒代理重试；重试同一命令经条目放行（走既有代批链路，决策留痕同源）。拒绝 → 只
 * 通知代理改道，不写条目。
 *
 * 为什么宿主只做「转述」而不替代理判断：授权判据是内核 `classifyCommand` 的 `always-ask`
 * 档（单一真源），宿主不重跑分类（第二真源必漂移）；宿主只认 `info.verdict` 与授权条目。
 *
 * 与 `ConfirmCoordinator` 的分工（两条判据流，禁揉进一处）：
 *   - 本域只处理 `verdict === 'always-ask'` 且代理驱动且**无授权**的命令/脚本确认——
 *     返 `'deferred'` 后内核不挂起等待（工具结果 `blocked(auth_required)`），没有超时概念；
 *   - 其余全部确认（写入面、normal 档、有授权的重试、自助会话）仍走 `ConfirmCoordinator`
 *     的入队/推送/计时/应答链路，行为逐字不变；
 *   - 分流点在 `ConfirmCoordinator.bindSession` 的 handler 第一步（唯一注入点，单问一句）。
 *
 * 授权条目生命周期（v1 从简，诚实边界）：
 *   - 绑定 **工作会话 + 命令原文**：改一个字符 = 新授权请求（不做「同类前缀」放行——
 *     前缀归类若宿主自算即第二判据源；内核若将来在 `WriteConfirmationInfo` 补 category
 *     字段，宿主可平滑升级为类别级）；
 *   - TTL 内同命令重试不再问；**settlement（轮落定）不清条目**——多轮任务中途落定的
 *     轮不该作废已授权的重试路径，任务边界以 TTL 近似（宁可授权略宽于必要，不可
 *     把「问一次」退化成「每轮问」后还谎称任务级）；
 *   - 会话删除（`disposeSession`）立即清空该会话全部条目与请求。
 *
 * 投递模型（与确认卡的「防跨会话串台」同纪律）：
 *   - 授权卡只渲染在**托管座位**前台；座位非前台时请求入暂存队列 + 离屏提醒，
 *     切回（`flushForSeat`）或视图重建（`repostForSeat`）补推；
 *   - 一次只推一张卡（多请求 FIFO），裁决后队列非空即推下一条；
 *   - 决策记录（允许/拒绝）只发生在座位前台（用户点击的前提），`post` 不串台。
 *
 * 提醒：复用 `attentionNotice.onConfirmShown`（去重键 `confirm:${requestId}`，requestId
 * 前缀 `auth_` 不与确认卡 `wc_` 冲突）——授权请求与确认卡同属「有事情等用户处理」，
 * 音效通道不分事件种类，不为此扩 `AttentionKind`。
 *
 * 本模块**不 import vscode**（依赖全注入）——宿主 host 层纪律，单测无需 mock vscode。
 *
 * @module confirmAuthFlow
 */

import type { WriteConfirmationInfo } from '@zooique/memora';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type { HostedDispatchResult } from './workSessionTools.js';

/**
 * 授权条目有效期（ms）：TTL 内同会话同命令的重试直接放行，过期后再次询问。
 *
 * ⚠️ 与 `CONFIRM_TIMEOUT_MS`（30 分钟，确认卡超时自动拒）数值巧合、语义无关：
 * 本值约束的是「用户的允许管多久」，不是「等多久必须拒绝」。授权请求**没有超时**——
 * 内核 `deferred` 不挂起，用户什么时候答都行；禁合并为同一常量。
 */
const AUTH_GRANT_TTL_MS = 30 * 60 * 1000;

/** 单条授权（绑定工作会话 + 命令原文；TTL 内有效） */
interface AuthGrantEntry {
  /** 允许时刻（epoch ms，仅留痕） */
  grantedAt: number;
  /** 过期时刻（epoch ms） */
  expiresAt: number;
}

/** 一条待授权请求（入队即定型：requestId / 标签只算一次，重推不换身份） */
interface AuthRequestEntry {
  requestId: string;
  /** 命令所属工作会话（授权条目的绑定键；也是叫醒代理的目标） */
  sessionId: string;
  /** 待授权命令原文（授权条目键） */
  command: string;
  /** 工具名（run_command 等，展示用） */
  tool: string;
  /** 工作会话展示名（卡片标注「哪条活」；定型时取好，重推不重查） */
  sessionLabel: string;
  /**
   * 决策记录标签（预计算：工具名：命令摘要；摘要截断防超长脚本撑爆时间线）
   */
  logLabel: string;
}

/** 域依赖（全部注入；chatPanel 构造闭包，不外泄面板实例） */
export interface ConfirmAuthFlowDeps {
  /** 该会话当前是否由代理驱动（判据真源与 ConfirmDeps.isAgentDrivenSession 同一闭包） */
  isAgentDrivenSession: (sessionId: string) => boolean;
  /** 托管座位会话 id（undefined = 本进程没有托管座位，授权流整体不启用） */
  getManagedSeatId: () => string | undefined;
  /** 面板当前显示会话（座位是否前台 = 与 getManagedSeatId 对比） */
  currentForeground: () => string;
  /** 会话展示名（卡片标注；取不到展示名时实现方退回会话 id） */
  getSessionLabel: (sessionId: string) => string;
  /** 消息投递单点（chatPanel 既有 `this.post`） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 离屏提醒（复用确认卡同钩子，见模块头注释；可选 = 缺省不提醒） */
  onAttention?: (info: { requestId: string; label: string }) => void;
  /**
   * 叫醒代理：向工作会话投一条通知轮（实现 = `chatPanel.dispatchHostedInput(座位 → 目标)`，
   * 身份/判忙/写锁/origin='hosted' 全走既有链路）。E_BUSY（目标在跑）不是失败：
   * 授权条目已写入，代理下一轮重试自然放行，实现方无需为此重试。
   */
  wakeAgent: (targetSessionId: string, text: string) => Promise<HostedDispatchResult>;
  /**
   * 文案（注入而非常量：本模块不 import vscode（host 层纪律），l10n 须在调用时刻取——
   * 实现方在闭包里 `vscode.l10n.t`，见 confirmTimeoutNotice 先例）。
   */
  words: {
    /** 决策记录「已授权」词 */
    authorized: () => string;
    /** 决策记录「已拒绝授权」词 */
    authorizationDenied: () => string;
    /** 叫醒代理「已批准请继续」正文（{0} = 命令原文） */
    wakeApproved: (command: string) => string;
    /** 叫醒代理「已拒绝请改道」正文（{0} = 命令原文） */
    wakeDenied: (command: string) => string;
  };
}

/**
 * 异步授权流协调器。实例由 chatPanel 持有（先于 `ConfirmCoordinator` 构造——分流判据
 * 在 handler 第一步就要问它），并经 `ConfirmDeps.authFlow` 交给协调器转发生命周期钩子。
 */
export class ConfirmAuthFlow {
  /** 工作会话 → 命令原文 → 授权条目（TTL 惰性校验：读取时比对 expiresAt） */
  private readonly _grants = new Map<string, Map<string, AuthGrantEntry>>();
  /** requestId → 请求条目（在途 + 暂存共用一张表；裁决/清理时摘除） */
  private readonly _requests = new Map<string, AuthRequestEntry>();
  /** 座位暂存队列（座位非前台，或前台但有在途卡时的请求） */
  private readonly _pendingForSeat: AuthRequestEntry[] = [];
  /** 当前渲染中的授权卡 requestId（null = 无在途卡） */
  private _activeRequestId: string | null = null;

  constructor(private readonly _deps: ConfirmAuthFlowDeps) {}

  // ─── 分流（ConfirmCoordinator handler 第一步） ───────────────────

  /**
   * 判定该确认是否应走异步授权（命中 ⇒ 协调器不入队，handler 返 `'deferred'`）
   *
   * 判据四条缺一不可：
   *   ① `info.verdict === 'always-ask'`（写入面 verdict 为 undefined，天然不命中；
   *      normal 档照常走确认卡）；
   *   ② 该会话由代理驱动（自助会话的确认卡行为逐字不变）；
   *   ③ 本进程有托管座位（无座位 = 无人可问，不拦——防把请求推进无人认领的黑洞）；
   *   ④ 无有效授权（有授权 ⇒ 返 null，走既有入队 + 代批链路，决策留痕同源）。
   *
   * 命中时完成三件事：生成请求条目、按前台状态投递或暂存（+提醒）、返回 `'deferred'`。
   *
   * @param sessionId 确认所属会话（= 工作会话 = 授权绑定键）
   * @param info      内核确认载荷（verdict / targetPath=命令原文 / tool）
   * @returns `'deferred'` = 已转授权请求；`null` = 不归本域，协调器照常入队。
   *          刻意用字面量联合而非内核 `WriteConfirmationResult` 别名——后者刻意不进
   *          公共面（PUBLIC-API-SURFACE-1 向 A），宿主写 `return 'deferred'` 即由
   *          `WriteConfirmationRequest` 签名推导获得同一校验，不为命名纯度扩面。
   */
  maybeDefer(sessionId: string, info: WriteConfirmationInfo): 'deferred' | null {
    if (info.verdict !== 'always-ask') return null;
    if (!this._deps.isAgentDrivenSession(sessionId)) return null;
    const seatId = this._deps.getManagedSeatId();
    if (seatId === undefined) return null;
    if (this.hasGrant(sessionId, info.targetPath)) return null;

    // 幂等收敛：同会话同命令的旧请求（可能尚未裁决）直接顶替——代理重试同一命令时
    // 不该累积多张同文卡；旧条目按已终结处理（若在途则推 closed，webview 覆盖渲染新卡）
    const superseded = [...this._requests.values()].find(
      (entry) => entry.sessionId === sessionId && entry.command === info.targetPath,
    );
    if (superseded) this._retire(superseded, 'void');

    const toolLabel = info.tool;
    // 决策记录摘要：单行截断，防超长脚本正文撑爆时间线（载荷全文不进提醒面，同确认卡纪律）
    const summary =
      info.targetPath.length > 80 ? `${info.targetPath.slice(0, 77)}…` : info.targetPath;
    const entry: AuthRequestEntry = {
      requestId: `auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      command: info.targetPath,
      tool: info.tool,
      sessionLabel: this._deps.getSessionLabel(sessionId),
      logLabel: `${toolLabel}: ${summary}`,
    };
    this._requests.set(entry.requestId, entry);
    this._deliverOrQueue(entry);
    return 'deferred';
  }

  // ─── 裁决（webview `auth_answer` 的唯一处理点） ──────────────────

  /**
   * 用户裁决授权请求
   *
   * 允许 → 写条目（TTL）+ 叫醒代理继续；拒绝 → 只叫醒代理改道。两条路径都**先摘条目
   * 再叫醒**（叫醒是异步通知轮，摘条目保证裁决幂等：迟到双击第二发查无此条即丢弃）。
   *
   * @param requestId 请求身份
   * @param approved  true = 允许；false = 拒绝
   * @returns 是否受理（false = 查无此条 / 已终结——与确认卡迟到回执同纪律）
   */
  answer(requestId: string, approved: boolean): boolean {
    const entry = this._requests.get(requestId);
    if (!entry) return false;
    this._requests.delete(requestId);
    // 在途卡必是它（一次一张）：摘除后立即推 closed（等待态提示由 webview 按 outcome 呈现）
    if (this._activeRequestId === requestId) this._activeRequestId = null;
    this._deps.post({
      type: 'auth_closed',
      requestId,
      outcome: approved ? 'granted' : 'denied',
    });
    // 决策记录（座位时间线；answer 的前提是用户正看着座位 ⇒ post 不串台）
    this._deps.post({
      type: 'notice',
      level: approved ? 'info' : 'error',
      message: approved
        ? `${this._deps.words.authorized()} ${entry.logLabel}`
        : `${this._deps.words.authorizationDenied()} ${entry.logLabel}`,
      kind: 'decision',
    });
    if (approved) this.grant(entry.sessionId, entry.command);
    // 叫醒代理（允许 = 继续；拒绝 = 改道）。不 await：通知轮受理由 dispatchHostedInput
    // 闭环（判忙/写锁），失败已在其回执语义内；授权条目不依赖通知成功与否。
    const text = approved
      ? this._deps.words.wakeApproved(entry.command)
      : this._deps.words.wakeDenied(entry.command);
    void this._deps.wakeAgent(entry.sessionId, text);
    // 队列非空且座位前台 ⇒ 推下一条（一次一张）
    this._pumpSeat();
    return true;
  }

  // ─── 生命周期钩子（ConfirmCoordinator 转发） ─────────────────────

  /**
   * 座位切到前台：补推暂存请求（无在途卡时推队首）
   *
   * 仅当切入的会话就是托管座位才动作；其他会话的切换不触碰授权流。
   */
  flushForSeat(sessionId: string): void {
    if (sessionId !== this._deps.getManagedSeatId()) return;
    this._pumpSeat();
  }

  /** webview 重建补推（同 `repostForeground` 时机）：座位前台且有在途请求 ⇒ 重推 */
  repostForSeat(sessionId: string): void {
    if (sessionId !== this._deps.getManagedSeatId()) return;
    if (this._activeRequestId === null) {
      this._pumpSeat();
      return;
    }
    const entry = this._requests.get(this._activeRequestId);
    if (entry) this._post(entry);
  }

  /**
   * 会话被删除：清空该会话全部授权条目与请求（含座位暂存）
   *
   * 在途卡若是该会话的请求 ⇒ 推 `auth_closed { outcome: 'void' }`（座位前台时）。
   * 与确认卡 `disposeSession` 同向：条目摘除后迟到回执查无此条，零副作用。
   */
  disposeSession(sessionId: string): void {
    this._grants.delete(sessionId);
    for (const [requestId, entry] of [...this._requests]) {
      if (entry.sessionId === sessionId) this._retire(this._requests.get(requestId)!, 'void');
    }
    // 暂存队列同步清（_retire 只动 _requests / _activeRequestId，不遍历暂存）
    for (let i = this._pendingForSeat.length - 1; i >= 0; i -= 1) {
      if (this._pendingForSeat[i]!.sessionId === sessionId) this._pendingForSeat.splice(i, 1);
    }
  }

  // ─── 内部 ────────────────────────────────────────────────────────

  /** 是否存在有效授权（TTL 惰性校验：过期条目当场清） */
  private hasGrant(sessionId: string, command: string): boolean {
    const grants = this._grants.get(sessionId);
    const entry = grants?.get(command);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      grants!.delete(command);
      return false;
    }
    return true;
  }

  /** 写授权条目（同会话同命令覆盖旧条目：TTL 从最近一次允许起算） */
  private grant(sessionId: string, command: string): void {
    let grants = this._grants.get(sessionId);
    if (!grants) {
      grants = new Map();
      this._grants.set(sessionId, grants);
    }
    grants.set(command, { grantedAt: Date.now(), expiresAt: Date.now() + AUTH_GRANT_TTL_MS });
  }

  /** 投递或暂存：座位前台且无在途卡 ⇒ 直接渲染；否则入暂存 + 提醒 */
  private _deliverOrQueue(entry: AuthRequestEntry): void {
    if (
      this._deps.currentForeground() === this._deps.getManagedSeatId() &&
      this._activeRequestId === null
    ) {
      this._activeRequestId = entry.requestId;
      this._post(entry);
      return;
    }
    this._pendingForSeat.push(entry);
    // 离屏提醒（可选）：请求在等用户拍板。与确认卡同钩子同去重键空间（auth_ 前缀自隔离）。
    this._deps.onAttention?.({ requestId: entry.requestId, label: entry.logLabel });
  }

  /** 把一条请求推到 webview（首推 / 补推共用唯一出口） */
  private _post(entry: AuthRequestEntry): void {
    this._deps.post({
      type: 'auth_request',
      requestId: entry.requestId,
      command: entry.command,
      tool: entry.tool,
      sessionLabel: entry.sessionLabel,
    });
  }

  /** 座位前台且无在途卡时从暂存队列推队首 */
  private _pumpSeat(): void {
    if (this._activeRequestId !== null) return;
    if (this._deps.currentForeground() !== this._deps.getManagedSeatId()) return;
    const next = this._pendingForSeat.shift();
    if (!next) return;
    // 迟到摘除防御：条目可能已被 disposeSession 摘掉（_requests 查无即跳过）
    if (!this._requests.has(next.requestId)) return;
    this._activeRequestId = next.requestId;
    this._post(next);
  }

  /** 终结一条请求（摘表 + 摘在途 + 前台推 closed） */
  private _retire(entry: AuthRequestEntry, outcome: 'granted' | 'denied' | 'void'): void {
    this._requests.delete(entry.requestId);
    if (this._activeRequestId === entry.requestId) {
      this._activeRequestId = null;
      this._deps.post({ type: 'auth_closed', requestId: entry.requestId, outcome });
    }
    const idx = this._pendingForSeat.findIndex((e) => e.requestId === entry.requestId);
    if (idx >= 0) this._pendingForSeat.splice(idx, 1);
  }
}
