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
 * dispose 供 Agent.close（原 forceRelease 供宿主无进展超时兜底——宿主从未调用，已随 5.0.0 拆除）。
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
   * 超时保护：锁超时后自动释放锁（允许新对话进入），但不中断生成流——
   * LLM 无进展由 provider 层请求级/事件停滞超时兜底，锁不对整次对话时长设硬上限。
   */
  acquire(
    timeoutMs: number,
    onTimeout?: () => void,
  ): { token: number; internalAbort: AbortController } {
    this._chatBusy = true;
    // 分配本调用 token，超时/finally 据此判断是否仍是持有者，避免误清新调用资源
    const token = ++this._chatLockToken;
    // 中断信号（用户 stop / 插话 / 锁释放会 abort 它；锁自身超时不 abort）
    const internalAbort = new AbortController();
    this.chatAbortController = internalAbort;

    this.chatLockTimer = safeSetTimeout(() => {
      // token 不匹配：锁已被新调用者获取（或本调用已正常退出），跳过清理
      if (this._chatLockToken !== token) {
        return;
      }
      logger.warn({ timeoutMs }, 'chat() 锁超时，自动释放锁（不中断生成流）');
      // 仅释放锁（自增 token 令旧 generator 的 finally release 跳过清理，避免误清新调用），
      // 不 abort 生成流——LLM 无进展/停滞由 provider 层超时兜底（请求级 120s + SSE 事件停滞 120s），
      // 锁不再对「整次对话时长」设硬上限，慢但正常的长时间对话不被误杀。
      this._chatLockToken++;
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

  // 删后注记（2026-10-16 · 5.0.0）：曾有 forceRelease()——被公开 Agent.forceReleaseChatLock 唯一调用；
  // 该门面宿主零真实调用（承诺的无进展超时兜底从未接线），门面拆除后本方法无调用者，一并删除。
  // 锁释放现仅走 release(token)（正常路径）与 dispose()（Agent.close）。勿加回。

  /**
   * 销毁管理器（Agent.close 时调用）。递增 token 使进行中 generator 的 finally 跳过清理
   * （close 为正常生命周期，已接管清理职责）。
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
