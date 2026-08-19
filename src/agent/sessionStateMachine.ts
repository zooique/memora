/**
 * 会话状态机 —— 不中断工作模型的核心状态流转。
 * 三态迁移契约：
 *   RUNNING→PAUSED（用户/Agent/系统双向暂停）；PAUSED→RUNNING（恢复，无阻塞条件时）；
 *   RUNNING→ERROR（异常：LLM 超时/工具失败/连接断开）；ERROR→RUNNING（恢复：须 error.recovered===true 且 cause 已解除）。
 * 非法转换：PAUSED→ERROR、ERROR→PAUSED 均不允许。
 * 设计意图：ERROR 态语义 =「崩溃残留 → 恢复前强制校验」，仅两条显式路径进入（宿主显式 triggerError()、检查点恢复回填 status='error'）；
 * 生产运行时异常走 `yield { type:'error' }` 事件流（agent.ts），不翻状态机。若要让运行时异常自动翻状态机，需在 yield error 处接线 triggerError（行为变更，需产品决策）。
 * 单实例事件队列串行处理，无并发写路径。
 */
import type { SessionCheckpoint, StatusTransition, SessionStatus } from '@/agent/types.js';

/** 暂停来源 */
export type PauseSource = 'user' | 'agent' | 'system';

// SessionStatus 在 agent/types.ts 定义，本文件直接导入共用
/**
 * 会话状态机：管理三态流转确保转换合法且可追溯，实例绑定单会话由 SessionManager 持有。
 */
export class SessionStateMachine {
  /** 当前状态 */
  private currentStatus: SessionStatus;
  /** 暂停原因（仅 PAUSED 有效） */
  private pauseReason: string | null = null;
  /** 暂停来源（仅 PAUSED 有效） */
  private pauseSource: PauseSource | null = null;
  /** 异常原因（仅 ERROR 有效） */
  private errorCause: string | null = null;
  /** 待处理暂停原因（软暂停申请，loop 边界挂起后消费）；Agent/AgentLoop 四处冗余字段在此收口为状态机唯一持有 */
  private pendingPauseReason?: string;
  /** 待处理暂停来源（仅 pendingPauseReason 有值时有效） */
  private pendingPauseSource: PauseSource = 'user';

  /** @param initialStatus 初始状态，默认 'running' */
  constructor(initialStatus: SessionStatus = 'running') {
    this.currentStatus = initialStatus;
  }

  /** 当前状态 */
  get status(): SessionStatus {
    return this.currentStatus;
  }

  /** 暂停原因/来源（仅 PAUSED 有效，否则 null） */
  get pauseInfo(): { reason: string; source: PauseSource } | null {
    if (this.currentStatus !== 'paused') return null;
    return { reason: this.pauseReason!, source: this.pauseSource! };
  }

  /** 异常原因（仅 ERROR 有效，否则 null） */
  get errorInfo(): string | null {
    return this.currentStatus === 'error' ? this.errorCause : null;
  }

  /** 暂停会话（用户/Agent/系统双向触发）；仅 RUNNING 可暂停 */
  pause(reason: string, source: PauseSource = 'user'): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'running') {
      return { from, to: 'paused', reason: `无法暂停：当前状态为 ${from}，仅 RUNNING 状态可暂停`, allowed: false };
    }
    this.currentStatus = 'paused';
    this.pauseReason = reason;
    this.pauseSource = source;
    return { from: 'running', to: 'paused', reason: `${source} 暂停：${reason}`, allowed: true };
  }

  /** 恢复会话；仅 PAUSED 可恢复，恢复前确认无阻塞条件（如无未完成工具调用） */
  resume(): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'paused') {
      return { from, to: 'running', reason: `无法恢复：当前状态为 ${from}，仅 PAUSED 状态可恢复`, allowed: false };
    }
    this.currentStatus = 'running';
    this.pauseReason = null;
    this.pauseSource = null;
    return { from: 'paused', to: 'running', reason: '恢复会话', allowed: true };
  }

  /** 触发异常；仅 RUNNING 可触发。PAUSED 不允许产生新异常，ERROR 不允许叠加（保留第一个 cause） */
  triggerError(cause: string): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'running') {
      return { from, to: 'error', reason: `无法触发异常：当前状态为 ${from}，仅 RUNNING 状态可触发异常`, allowed: false };
    }
    this.currentStatus = 'error';
    this.errorCause = cause;
    return { from: 'running', to: 'error', reason: `异常：${cause}`, allowed: true };
  }

  /** 从异常恢复；仅 ERROR 可恢复，须 error.recovered===true 且 cause 已解除（外部条件由调用方恢复前确认） */
  recover(checkpoint: SessionCheckpoint): StatusTransition {
    const from = this.currentStatus;
    if (from !== 'error') {
      return { from, to: 'running', reason: `无法恢复：当前状态为 ${from}，仅 ERROR 状态可恢复`, allowed: false };
    }
    if (!checkpoint.error?.recovered) {
      return { from: 'error', to: 'running', reason: `无法恢复：异常尚未标记为已恢复（error.recovered !== true），异常原因：${checkpoint.error?.cause ?? '未知'}`, allowed: false };
    }
    if (!checkpoint.error.cause) {
      return { from: 'error', to: 'running', reason: '无法恢复：异常原因缺失，无法确认 cause 已解除', allowed: false };
    }
    this.currentStatus = 'running';
    this.errorCause = null;
    return { from: 'error', to: 'running', reason: `恢复完成：异常原因 "${checkpoint.error.cause}" 已解除`, allowed: true };
  }

  /** 当前是否可暂停（仅 RUNNING） */
  canPause(): boolean {
    return this.currentStatus === 'running';
  }

  /** 当前是否可恢复（仅 PAUSED） */
  canResume(): boolean {
    return this.currentStatus === 'paused';
  }

  /** 当前是否处于异常状态 */
  isError(): boolean {
    return this.currentStatus === 'error';
  }

  /** 强制重置到 running（跳过所有转换校验，用于暂停超时等强制清理；正常应走 pause/resume/triggerError/recover） */
  resetToRunning(): void {
    this.currentStatus = 'running';
    this.pauseReason = null;
    this.pauseSource = null;
    this.errorCause = null;
  }

  // ─── pending 暂停请求管理（SSOT 收口） ────────────────

  /** 「是否存在在途暂停申请」唯一判据；requestPause 与 isPausePending 共用，保证同一命题单一套判定（不因 error 态等场景出现两套判据） */
  private hasPendingPause(): boolean {
    return this.pendingPauseReason !== undefined;
  }

  /** 待处理暂停信息（只读不消费）；供 loop.onPaused 读暂停信息写 pauseMeta */
  get pendingPauseInfo(): { reason: string; source: PauseSource } | null {
    if (this.pendingPauseReason === undefined) return null;
    return { reason: this.pendingPauseReason, source: this.pendingPauseSource };
  }

  /** 请求软暂停（仅 RUNNING）；暂存暂停数据，待 loop 边界真正挂起时 consume 消费。true=已注册，false=不接受（非 RUNNING 或已有在途申请） */
  requestPause(reason: string, source: PauseSource = 'user'): boolean {
    if (this.currentStatus !== 'running') return false;
    if (this.hasPendingPause()) return false; // 幂等：已有在途申请
    this.pendingPauseReason = reason;
    this.pendingPauseSource = source;
    return true;
  }

  /** 消费待处理暂停请求（loop 边界真正挂起时调用）；返回并清除，与 cancelPendingPause 互斥 */
  consumePendingPause(): { reason: string; source: PauseSource } | null {
    if (this.pendingPauseReason === undefined) return null;
    const result = { reason: this.pendingPauseReason, source: this.pendingPauseSource };
    this.pendingPauseReason = undefined;
    this.pendingPauseSource = 'user';
    return result;
  }

  /** 取消待处理暂停请求（用户主动取消暂停时调用）；清除 pending，与 consumePendingPause 互斥 */
  cancelPendingPause(): void {
    this.pendingPauseReason = undefined;
    this.pendingPauseSource = 'user';
  }

  /** 是否存在在途暂停申请（状态机仍 running 且未真正挂起）；供宿主三态按钮判断 */
  isPausePending(): boolean {
    return this.hasPendingPause() && this.currentStatus !== 'paused';
  }
}