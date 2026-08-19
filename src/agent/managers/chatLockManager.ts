/**
 * ChatLockManager — chat() 并发锁管理器：并发锁 + token 校验 + 超时保护 + 外部 signal 合并。
 *
 * race condition 防护（token 机制）：原锁仅布尔 _chatBusy，超时回调与 finally 块无差别清理，
 * 可能误清新调用者的资源（T=0 A 获取→超时释放→B 获取→A finally 误清 B）。
 * 故获取锁时递增 token，超时回调/finally 均校验 token 是否仍是当前持有者，不匹配则跳过清理。
 */

import { clearSafeTimeout, safeSetTimeout } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';

/**
 * chat() 并发锁管理器。acquire 返回 token+internalAbort，finally 中 release(token)。
 * forceRelease 供宿主无进展超时兜底；dispose 供 Agent.close。
 */
export class ChatLockManager {
  /** 并发锁标志 */
  private _chatBusy = false;
  /** 锁持有者 token（race condition 防护，校验当前持有者避免误清新调用者资源） */
  private _chatLockToken: number = 0;
  /** 锁超时计时器（防 LLM 卡死时锁永久持有） */
  private chatLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** 内部 AbortController（超时时中断 generator） */
  private chatAbortController: AbortController | null = null;

  /** 当前是否持有锁 */
  get isBusy(): boolean {
    return this._chatBusy;
  }

  /**
   * 获取锁，返回 token（finally 校验）+ internalAbort（传给 loop.processUserInput）。
   * 超时保护：LLM 卡死时中断 generator 并释放锁。
   */
  acquire(
    timeoutMs: number,
    onTimeout?: () => void,
  ): { token: number; internalAbort: AbortController } {
    this._chatBusy = true;
    // 分配本调用 token，超时/finally 据此判断是否仍是持有者，避免误清新调用者资源
    const token = ++this._chatLockToken;
    // 超时时中断 generator 而非仅释放锁
    const internalAbort = new AbortController();
    this.chatAbortController = internalAbort;

    this.chatLockTimer = safeSetTimeout(() => {
      // token 不匹配：锁已被新调用者获取（或本调用已正常退出），跳过清理
      if (this._chatLockToken !== token) {
        return;
      }
      logger.warn(
        { timeoutMs },
        'chat() 锁超时，中断 generator 并释放锁',
      );
      internalAbort.abort();
      this._chatBusy = false;
      this.chatLockTimer = null;
      this.chatAbortController = null;
      onTimeout?.();
    }, timeoutMs);

    return { token, internalAbort };
  }

  /** 合并外部 signal：外部 abort 时触发内部 abort；返回 cleanup。addEventListener 对已 aborted 的 signal 不触发，需手动检查。 */
  attachExternalSignal(
    externalSignal: AbortSignal | undefined,
    internalAbort: AbortController,
  ): () => void {
    if (!externalSignal) return () => {};
    const onExternalAbort = () => internalAbort.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    // 外部 signal 已 aborted 时不触发回调，手动触发一次，避免外部已取消请求仍进入主流程
    if (externalSignal.aborted) {
      internalAbort.abort();
    }
    return () => externalSignal.removeEventListener('abort', onExternalAbort);
  }

  /** finally 清理（token 校验）：仅当前持有者清理，token 已变则跳过避免误清新调用者状态 */
  release(token: number): void {
    if (this._chatLockToken !== token) {
      return;
    }
    this._chatBusy = false;
    this.chatAbortController = null;
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
  }

  /**
   * 强制释放对话锁（宿主无进展超时兜底）。幂等：_chatBusy 已 false 时 no-op。
   * generator 可能卡在不可响应的 await 点，递增 token 让原 finally 跳过清理；
   * abort controller 让响应 signal 的 await 点退出。原 generator 后台残留也无法影响新调用。
   */
  forceRelease(): void {
    if (!this._chatBusy) return;
    // 递增 token 让原 chat() finally 跳过清理（避免误清新调用者资源）
    this._chatLockToken++;
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
    }
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
    this._chatBusy = false;
    logger.warn('对话锁被强制释放（宿主无进展超时兜底）');
  }

  /**
   * 销毁管理器（Agent.close 时调用）。与 forceRelease 同行为但不记 warn 日志
   * （close 为正常生命周期）。递增 token 使进行中 generator 的 finally 跳过清理。
   */
  dispose(): void {
    // 递增 token，让进行中 chat() finally 跳过资源清理（close 已接管清理职责）
    this._chatLockToken++;
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
    }
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
    this._chatBusy = false;
  }
}
