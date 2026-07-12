/**
 * ChatLockManager — chat() 并发锁管理器
 *
 * 职责：
 *   - chat() 并发锁（防止多轮 chat 同时执行）
 *   - token 校验（防止 race condition：超时释放后新调用获取锁，旧 finally 误清新调用者资源）
 *   - 超时保护（LLM 卡死时中断 generator + 释放锁）
 *   - 外部 signal 合并（外部 abort 时触发内部 abort）
 *
 * 从 agent.ts 提取（AUDIT-1-1，ADR-017 架构层先行原则首次实践）
 *
 * race condition 防护设计：
 *   原锁是简单布尔值 `_chatBusy`，无 owner 校验。超时回调与 finally 块无差别清理，
 *   导致 race condition：T=0 A 获取锁 → T=180s 超时释放 → T=181s B 获取锁
 *   → T=182s A 的 finally 误清 B 的锁/计时器/controller。
 *
 *   防护方案：
 *   - 获取锁时 token 递增：`const myToken = ++this._chatLockToken`
 *   - 超时回调校验 `this._chatLockToken === myToken` 后才释放
 *   - finally 块校验 `this._chatLockToken === myToken` 后才清理
 *   - 不匹配时跳过清理，避免误清新调用者的资源
 *
 *   选择 number 而非 Symbol：递增计数器可序列化、零依赖、足够唯一（同一 Agent 实例内）
 */

import { clearSafeTimeout, safeSetTimeout } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';

/**
 * chat() 并发锁管理器
 *
 * 使用方式：
 *   const mgr = new ChatLockManager();
 *   const { token, internalAbort } = mgr.acquire(180_000);
 *   const cleanup = mgr.attachExternalSignal(externalSignal, internalAbort);
 *   try {
 *     // ... 使用 internalAbort.signal 传递给 generator ...
 *   } finally {
 *     mgr.release(token);
 *     cleanup();
 *   }
 *
 * 强制释放（宿主兜底）：
 *   mgr.forceRelease();
 *
 * 销毁（Agent.close 时）：
 *   mgr.dispose();
 */
export class ChatLockManager {
  /** chat() 是否正在执行（并发锁） */
  private _chatBusy = false;
  /**
   * chat() 锁持有者 token（race condition 防护）
   *
   * 获取锁时递增，超时回调和 finally 块据此判断是否仍是当前持有者。
   * 不匹配时跳过清理，避免误清新调用者的资源。
   */
  private _chatLockToken: number = 0;
  /** 聊天锁超时计时器（防止 LLM 卡死时锁永久持有） */
  private chatLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** chat() 内部 AbortController（超时时中断 generator，防止并发） */
  private chatAbortController: AbortController | null = null;

  /** 当前是否持有锁 */
  get isBusy(): boolean {
    return this._chatBusy;
  }

  /**
   * 获取锁，返回 token + 内部 AbortController
   *
   * @param timeoutMs 锁超时时间（LLM 卡死保护）
   * @param onTimeout 超时回调（用于日志记录等）
   * @returns token（用于 finally 校验）+ internalAbort（用于传递给 loop.processUserInput）
   */
  acquire(
    timeoutMs: number,
    onTimeout?: () => void,
  ): { token: number; internalAbort: AbortController } {
    this._chatBusy = true;
    // 分配本调用的 token，超时回调和 finally 块据此判断是否仍是当前持有者
    // 避免 race condition：超时释放后新调用获取锁，旧 finally 误清新调用者的资源
    const token = ++this._chatLockToken;
    // 内部 AbortController，超时时中断 generator 而非仅释放锁
    const internalAbort = new AbortController();
    this.chatAbortController = internalAbort;

    // 超时保护：LLM 卡死时中断 generator + 释放锁，防止并发
    // 超时回调校验 token 后才清理，避免误清新调用者的资源
    this.chatLockTimer = safeSetTimeout(() => {
      // 令牌不匹配：锁已被新调用者获取（或本调用已正常退出），跳过清理
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

  /**
   * 合并外部 signal：外部 abort 时触发内部 abort
   *
   * addEventListener 对已 aborted 的 signal 不触发回调，
   * 需手动检查并触发 internalAbort，否则外部已取消的请求仍会进入主流程。
   *
   * @returns 清理函数（finally 块中调用 removeEventListener）
   */
  attachExternalSignal(
    externalSignal: AbortSignal | undefined,
    internalAbort: AbortController,
  ): () => void {
    if (!externalSignal) return () => {};
    const onExternalAbort = () => internalAbort.abort();
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    // addEventListener 对已 aborted 的 signal 不触发回调
    // 需手动检查并触发 internalAbort，否则外部已取消的请求仍会进入主流程
    if (externalSignal.aborted) {
      internalAbort.abort();
    }
    return () => externalSignal.removeEventListener('abort', onExternalAbort);
  }

  /**
   * finally 块清理（token 校验后）
   *
   * 仅当本调用仍是当前锁持有者时才清理资源。
   * 若 token 已变（超时释放后被新调用者获取），跳过清理避免误清新调用者的状态。
   */
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
   * 强制释放对话锁（宿主无进展超时兜底）
   *
   * 场景：宿主主进程"无进展超时"兜底后，generator 可能仍卡在不可中断的 await 点
   *   （executeToolCalls 和 generateContextSummary 已覆盖 signal 响应，但其他
   *   第三方库或未来新增的 await 点仍可能不响应 signal）。
   *   此时 _chatBusy 锁未释放，用户再发消息会被 chat() 的竞态保护拒绝，
   *   表现为"UI 能操作但发不出消息"，需等到 3 分钟锁超时才能恢复。
   *
   * 安全机制：
   *   - 递增 _chatLockToken，让原 chat() 的 finally 块检测到 token 不匹配后
   *     跳过资源清理（避免误清新调用者的 _chatBusy/chatAbortController）
   *   - abort chatAbortController，让响应 signal 的 await 点（如 fetch）退出
   *   - 原 generator 仍可能在后台运行（无法真正中断不响应 signal 的 await），
   *     但其 finally 块的 token 校验会阻止它影响新调用
   *
   * 幂等性：_chatBusy 已 false 时 no-op（多次调用安全）
   */
  forceRelease(): void {
    if (!this._chatBusy) return;
    // 递增 token 让原 chat() 的 finally 块跳过清理（避免误清新调用者的资源）
    this._chatLockToken++;
    // abort 当前 generator（响应 signal 的 await 点会 throw AbortError 退出）
    if (this.chatAbortController) {
      this.chatAbortController.abort();
      this.chatAbortController = null;
    }
    // 清理锁超时定时器（避免后续触发重复清理）
    if (this.chatLockTimer) {
      clearSafeTimeout(this.chatLockTimer);
      this.chatLockTimer = null;
    }
    this._chatBusy = false;
    logger.warn('对话锁被强制释放（宿主无进展超时兜底）');
  }

  /**
   * 销毁管理器（Agent.close 时调用）
   *
   * 与 forceRelease() 的区别：不记录 warn 日志（close 是正常生命周期，非异常场景）。
   * 递增 token 使任何进行中的 chat() generator 的 finally 块检测到 token 变化后
   * 跳过资源清理（close 已接管清理职责）。
   */
  dispose(): void {
    // 递增 token，使任何进行中的 chat() generator 的 finally 块
    // 检测到 token 变化后跳过资源清理（close 已接管清理职责）
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
