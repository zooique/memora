/**
 * 会话状态机 —— 不中断工作模型的核心状态流转
 *
 * 设计文档：docs/根基/不中断工作模型演进.html（v1.6）
 *
 * 三态状态机：
 *   RUNNING → PAUSED（双向暂停：用户/Agent/系统均可触发）
 *   PAUSED → RUNNING（恢复：无阻塞条件时允许）
 *   RUNNING → ERROR（异常：LLM 超时/工具失败/连接断开）
 *   ERROR → RUNNING（恢复校验：须 error.recovered===true 且 cause 已解除）
 *
 * ERROR 态触发面（SSOT 排雷 T2-2 定性，2026-08-09）：
 *   - 生产内部**无运行时自动触发者**——Agent 运行时异常（LLM 超时/工具失败等）
 *     走 `yield { type: 'error' }` 事件流（agent.ts:540/979/1057），不翻状态机。
 *   - 实际进入 ERROR 态的两条路径：
 *     ① 公开 API `agent.triggerError()`（宿主显式调用，agent.ts:1444）；
 *     ② 检查点恢复回填——磁盘/外部检查点 status='error' 时
 *        （sessionManager.ts:481 loadPersistedCheckpoint / :541 restoreFromCheckpoint）。
 *   因此 ERROR 态不可删：它是「崩溃残留 → 恢复前强制校验」语义的载体。
 *   若未来要让运行时异常自动翻状态机，需在 yield error 处接线 triggerError（行为变更，需产品决策）。
 *
 * 非法转换：
 *   PAUSED → ERROR（不允许：暂停中不应产生新异常）
 *   ERROR → PAUSED（不允许：异常状态独立可见，不自动降级）
 *
 * 单实例事件队列 + 串行处理，无并发写路径。
 */
import type { SessionCheckpoint, StatusTransition, SessionStatus } from '@/agent/types.js';

/** 暂停来源 */
export type PauseSource = 'user' | 'agent' | 'system';

/** 会话状态（从 agent/types.ts 导入，SSOT 单一真理源） */
// SessionStatus 类型在 agent/types.ts 中定义，本文件直接导入使用

/**
 * 会话状态机
 *
 * 管理不中断工作模型的三态流转，确保状态转换合法且可追溯。
 * 实例绑定到单个会话，由 SessionManager 持有。
 */
export class SessionStateMachine {
  /** 当前状态 */
  private currentStatus: SessionStatus;
  /** 暂停原因（仅 PAUSED 状态时有效） */
  private pauseReason: string | null = null;
  /** 暂停来源（仅 PAUSED 状态时有效） */
  private pauseSource: PauseSource | null = null;
  /** 异常原因（仅 ERROR 状态时有效） */
  private errorCause: string | null = null;
  /**
   * 待处理的暂停原因（SSOT 收口：四方冗余 → 状态机唯一持有）
   *
   * 流中 requestPause 置位，loop 边界真正挂起后由 consumePendingPause() 消费，
   * cancelPendingPause() 主动清理。空闲态直翻 PAUSED 不置位。
   * Agent._pendingPauseReason / Agent._pendingPauseSource / AgentLoop.pauseRequested
   * 四方冗余在此收口为状态机私有字段。
   */
  private pendingPauseReason?: string;
  /** 待处理的暂停来源（仅 pendingPauseReason 有值时有效） */
  private pendingPauseSource: PauseSource = 'user';

  /**
   * @param initialStatus - 初始状态，默认 'running'
   */
  constructor(initialStatus: SessionStatus = 'running') {
    this.currentStatus = initialStatus;
  }

  /** 获取当前状态 */
  get status(): SessionStatus {
    return this.currentStatus;
  }

  /** 获取暂停原因（仅 PAUSED 时有效） */
  get pauseInfo(): { reason: string; source: PauseSource } | null {
    if (this.currentStatus !== 'paused') return null;
    return {
      reason: this.pauseReason!,
      source: this.pauseSource!,
    };
  }

  /** 获取异常原因（仅 ERROR 时有效） */
  get errorInfo(): string | null {
    return this.currentStatus === 'error' ? this.errorCause : null;
  }

  /**
   * 暂停会话
   *
   * 双向暂停：用户/Agent/系统均可触发。
   * 仅 RUNNING 状态可暂停。
   *
   * @param reason - 暂停原因
   * @param source - 暂停来源
   * @returns 状态转换结果
   */
  pause(reason: string, source: PauseSource = 'user'): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'running') {
      return {
        from,
        to: 'paused',
        reason: `无法暂停：当前状态为 ${from}，仅 RUNNING 状态可暂停`,
        allowed: false,
      };
    }

    this.currentStatus = 'paused';
    this.pauseReason = reason;
    this.pauseSource = source;

    return {
      from: 'running',
      to: 'paused',
      reason: `${source} 暂停：${reason}`,
      allowed: true,
    };
  }

  /**
   * 恢复会话
   *
   * 仅 PAUSED 状态可恢复。
   * 恢复前检查：无阻塞条件（如 Agent 自暂停时确认无未完成工具调用）。
   *
   * @returns 状态转换结果
   */
  resume(): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'paused') {
      return {
        from,
        to: 'running',
        reason: `无法恢复：当前状态为 ${from}，仅 PAUSED 状态可恢复`,
        allowed: false,
      };
    }

    this.currentStatus = 'running';
    this.pauseReason = null;
    this.pauseSource = null;

    return {
      from: 'paused',
      to: 'running',
      reason: '恢复会话',
      allowed: true,
    };
  }

  /**
   * 触发异常
   *
   * 仅 RUNNING 状态可触发异常。
   * PAUSED 状态不允许产生新异常（暂停中异常不应发生），
   * ERROR 状态不允许叠加（保留第一个 cause）。
   *
   * @param cause - 异常原因描述
   * @returns 状态转换结果
   */
  triggerError(cause: string): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'running') {
      return {
        from,
        to: 'error',
        reason: `无法触发异常：当前状态为 ${from}，仅 RUNNING 状态可触发异常`,
        allowed: false,
      };
    }

    this.currentStatus = 'error';
    this.errorCause = cause;

    return {
      from: 'running',
      to: 'error',
      reason: `异常：${cause}`,
      allowed: true,
    };
  }

  /**
   * 从异常恢复
   *
   * 校验恢复条件（v1.6）：
   * - 仅 ERROR 状态可恢复
   * - 须 checkpoint.error.recovered === true
   * - 须 cause 已解除（由调用方在恢复前确认）
   *
   * @param checkpoint - 当前会话检查点（用于校验 recovered 标志）
   * @returns 状态转换结果
   */
  recover(checkpoint: SessionCheckpoint): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'error') {
      return {
        from,
        to: 'running',
        reason: `无法恢复：当前状态为 ${from}，仅 ERROR 状态可恢复`,
        allowed: false,
      };
    }

    // 校验恢复条件
    if (!checkpoint.error?.recovered) {
      return {
        from: 'error',
        to: 'running',
        reason: `无法恢复：异常尚未标记为已恢复（error.recovered !== true），异常原因：${checkpoint.error?.cause ?? '未知'}`,
        allowed: false,
      };
    }

    // 校验 cause 已解除（简单检查：cause 不为空且 recovered 已标记）
    // 复杂场景由调用方（SessionManager）在恢复前确认外部条件
    if (!checkpoint.error.cause) {
      return {
        from: 'error',
        to: 'running',
        reason: '无法恢复：异常原因缺失，无法确认 cause 已解除',
        allowed: false,
      };
    }

    this.currentStatus = 'running';
    this.errorCause = null;

    return {
      from: 'error',
      to: 'running',
      reason: `恢复完成：异常原因 "${checkpoint.error.cause}" 已解除`,
      allowed: true,
    };
  }

  /**
   * 检查是否可暂停
   */
  canPause(): boolean {
    return this.currentStatus === 'running';
  }

  /**
   * 检查是否可恢复
   */
  canResume(): boolean {
    return this.currentStatus === 'paused';
  }

  /**
   * 检查是否处于异常状态
   */
  isError(): boolean {
    return this.currentStatus === 'error';
  }

  /**
   * 强制重置状态机到 running 状态（用于暂停超时等强制清理场景）
   *
   * 注意：此方法跳过所有状态转换校验，仅用于强制清理。
   * 正常场景应使用 pause()/resume()/triggerError()/recover()。
   */
  resetToRunning(): void {
    this.currentStatus = 'running';
    this.pauseReason = null;
    this.pauseSource = null;
    this.errorCause = null;
  }

  // ─── pending 暂停请求管理（SSOT 收口） ────────────────

  /**
   * 「是否存在在途暂停申请」的唯一判据（SSOT 收口）
   *
   * `requestPause()` 与 `isPausePending()` 共用同一私有判据，
   * 保证同一命题只有一套判定（不因 error 态等场景产生两套判据打架）。
   *
   * 注：`pendingPauseInfo` / `consumePendingPause` 需依赖 TS 对字段的 undefined 窄化
   * 才能返回 `reason: string`，故仍内联比较——它们读的是同一字段，不构成第二真理源。
   */
  private hasPendingPause(): boolean {
    return this.pendingPauseReason !== undefined;
  }

  /**
   * 获取待处理的暂停信息（只读，不消费）
   *
   * 返回当前 pending 暂停的原因和来源，不会清除 pending 状态。
   * 用于 loop.onPaused 回调中读取暂停信息写 pauseMeta。
   */
  get pendingPauseInfo(): { reason: string; source: PauseSource } | null {
    if (this.pendingPauseReason === undefined) return null;
    return {
      reason: this.pendingPauseReason,
      source: this.pendingPauseSource,
    };
  }

  /**
   * 请求软暂停（仅 RUNNING 状态允许）
   *
   * 暂存暂停原因和来源，待 loop 边界真正挂起时由 consumePendingPause() 消费。
   *
   * @param reason - 暂停原因
   * @param source - 暂停来源
   * @returns true=请求已注册；false=状态机不接受（非 RUNNING）
   */
  requestPause(reason: string, source: PauseSource = 'user'): boolean {
    if (this.currentStatus !== 'running') return false;
    if (this.hasPendingPause()) return false; // 幂等：已有在途申请（判据见 hasPendingPause）
    this.pendingPauseReason = reason;
    this.pendingPauseSource = source;
    return true;
  }

  /**
   * 消费待处理的暂停请求（在 loop 边界真正挂起时调用）
   *
   * 返回并清除 pending 暂停信息。与 cancelPendingPause 互斥：
   * 消费 = 暂停已发生，取消 = 暂停被撤销。
   *
   * @returns 消费的暂停信息，无在途申请时返回 null
   */
  consumePendingPause(): { reason: string; source: PauseSource } | null {
    if (this.pendingPauseReason === undefined) return null;
    const result = {
      reason: this.pendingPauseReason,
      source: this.pendingPauseSource,
    };
    this.pendingPauseReason = undefined;
    this.pendingPauseSource = 'user';
    return result;
  }

  /**
   * 取消待处理的暂停请求（用户主动取消暂停时调用）
   *
   * 清除 pending 暂停信息，让工作通道继续运行。
   * 与 consumePendingPause 互斥。
   */
  cancelPendingPause(): void {
    this.pendingPauseReason = undefined;
    this.pendingPauseSource = 'user';
  }

  /**
   * 检查是否存在在途的暂停申请
   *
   * @returns true=暂停申请在途（状态机仍 running）；false=无在途申请或已暂停
   */
  isPausePending(): boolean {
    // 判据与 requestPause() 共用；status 过滤是本方法额外的语义
    // （「在途且尚未真正挂起」），供宿主三态按钮判断，不属于 hasPendingPause 命题。
    return this.hasPendingPause() && this.currentStatus !== 'paused';
  }
}