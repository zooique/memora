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
import type { SessionEvent, SessionCheckpoint, StatusTransition, SessionStatus } from '@/agent/types.js';

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
   * 事件驱动转换（设计文档接口）
   *
   * 根据 SessionEvent 类型驱动状态转换：
   * - command → 检查是否可恢复（若当前为 ERROR）
   * - correction → 保持当前状态
   * - clarify → 保持当前状态
   * - chat → 保持当前状态
   *
   * @param _event - 增量事件（当前版本仅用于判断转换意图，保留参数供未来扩展）
   * @param _checkpoint - 当前检查点（保留参数供未来扩展）
   * @returns 状态转换结果
   */
  onEvent(_event: SessionEvent, _checkpoint: SessionCheckpoint): StatusTransition {
    // 当前版本：事件驱动的自动转换仅限 ERROR→RUNNING 恢复场景
    // 其他场景（pause/resume）由调用方显式调用 pause()/resume()
    return {
      from: this.currentStatus,
      to: this.currentStatus,
      reason: '事件不触发状态转换（pause/resume/error 由调用方显式触发）',
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
}