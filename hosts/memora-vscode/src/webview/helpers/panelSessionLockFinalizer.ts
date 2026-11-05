/**
 * 面板会话锁收尾器（审查 B1）
 *
 * 面板在 `resolveWebviewView` 时可能长持有当前会话的跨进程锁；「销毁 / 重开 / 流收场 /
 * 握手期间销毁」四处的收尾判据集中在这里，一处来源。
 *
 * 为什么外置：`chatPanel.ts` 贴着 eslint `max-lines` 只降不升基线，而本逻辑是自足的
 * 生命周期判据（无 DOM 副作用），外置是顺手续一个本就该独立的面，不是绕闸。
 */

/** 会话锁释放面（未持有时 `release` 应为空操作） */
export interface SessionLockReleaser {
  /** 归还某个会话的跨进程锁 */
  releaseSessionLock(sessionId: string): void;
}

/** 面板当前会话 id 的读写面：真源仍在面板，收尾器不另存一份 */
export interface PanelSessionIdAccess {
  /** 读当前会话 id（空串 = 未持有锁） */
  getSessionId(): string;
  /** 清空当前会话 id（**纯内存**，不得落盘） */
  clearSessionId(): void;
}

/**
 * 面板会话锁收尾器
 *
 * 不变式：`getSessionId()` 非空 ⇔ 本面板持有该会话的锁（创建 / 切换 / 分叉都是
 * 「先拿新锁、成功后才改 id」，失败则回滚 id）。
 */
export class PanelSessionLockFinalizer {
  /** 面板在流中销毁时的挂起标记：流还在写盘，提前放锁会让别窗口接管后本进程写断言失败 */
  private releasePending = false;

  /**
   * @param store 会话锁释放面
   * @param access 面板当前会话 id 的读写面
   */
  constructor(
    private readonly store: SessionLockReleaser,
    private readonly access: PanelSessionIdAccess,
  ) {}

  /** 面板销毁：流中挂起（等流收场再放），非流中立即归还并清空 */
  onDispose(streaming: boolean): void {
    if (streaming) this.releasePending = true;
    else this.release();
  }

  /** 面板重开（重新 resolve）：撤销挂起——面板回来了就该继续持有 */
  onResolve(): void {
    this.releasePending = false;
  }

  /** 流收场：挂起过才归还；**必须在所有落盘写完之后**调用 */
  onStreamEnd(): void {
    if (!this.releasePending) return;
    this.releasePending = false;
    this.release();
  }

  /**
   * 握手期间面板被销毁：补归还刚落到的锁
   *
   * @param acquired claimStartupSession 拿到的会话（空串 = 未拿到）
   * @returns true = 面板已销毁，调用方应中止后续让位 / 提示
   */
  abandonIfDisposed(acquired: string): boolean {
    if (this.access.getSessionId()) return false;
    if (acquired) this.store.releaseSessionLock(acquired);
    return true;
  }

  /** 归还并清空（销毁 / 流收场共用） */
  private release(): void {
    const held = this.access.getSessionId();
    this.access.clearSessionId();
    if (held) this.store.releaseSessionLock(held);
  }
}
