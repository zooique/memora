/**
 * 面板会话锁收尾器（审查 B1；E4 批 3 会话化）
 *
 * 面板按会话长持有跨进程锁（切走**不放**——旧会话仍有活实例在写盘）；「销毁 / 重开 /
 * 流收场 / 握手期间销毁」四处的收尾判据集中在这里，一处来源。
 *
 * 会话化要点：挂起标记从单个 boolean 变成**按会话集合**——同时有多个后台流时，第一个流
 * 收场不能把别的会话的锁也放了（别的流还在写盘）。
 *
 * 为什么外置：`chatPanel.ts` 贴着 eslint `max-lines` 只降不升基线，而本逻辑是自足的
 * 生命周期判据（无 DOM 副作用），外置是顺手续一个本就该独立的面，不是绕闸。
 */

/** 会话锁释放面（未持有时 `release` 应为空操作） */
export interface SessionLockReleaser {
  /** 获取某个会话的跨进程锁（不等待） */
  acquireSessionLock(sessionId: string): Promise<boolean>;
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
 * 不变式：`getSessionId()` 非空 ⇔ 本面板正在显示该会话；**锁的持有面不由此推断**——
 * 面板为每个进入过的会话长持有锁（`held` 集），切会话不改持有集。
 */
export class PanelSessionLockFinalizer {
  /** 本面板为哪些会话长持有锁（只由 `acquire()` 成功入集；切走不删） */
  private readonly held = new Set<string>();
  /** 销毁时仍在跑流的会话（流收场后逐个归还） */
  private readonly pending = new Set<string>();

  /**
   * @param store 会话锁读写面（真源：本进程的锁表）
   * @param access 面板当前会话 id 的读写面
   */
  constructor(
    private readonly store: SessionLockReleaser,
    private readonly access: PanelSessionIdAccess,
  ) {}

  /** 拿锁并入持集（失败不入集）；**面板取锁的唯一入口**（四处调用点都经这里） */
  async acquire(sessionId: string): Promise<boolean> {
    if (!(await this.store.acquireSessionLock(sessionId))) return false;
    this.held.add(sessionId);
    return true;
  }

  /** 本面板是否长持有该会话的锁（历史菜单据此区分长锁 / 一次性短锁） */
  holds(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** 归还某个会话的长锁（未持有则忽略；删除实例 **close 之后** 调用） */
  releaseOne(sessionId: string): void {
    this.pending.delete(sessionId);
    if (!this.held.delete(sessionId)) return;
    this.store.releaseSessionLock(sessionId);
  }

  /**
   * 面板销毁：按持有集逐个处理——流中会话挂起（等流收场再放），其余立即归还
   *
   * 不注销、不关闭任何实例（实例归 extension 登记表所有，见批 3 判据）；
   * 也不因销毁而少放一把（放锁 = 让出跨进程写权，必须与持有集一一对应）。
   *
   * @param streaming 某会话是否仍在跑流（真源 = 面板运行态表）
   */
  onDispose(streaming: (sessionId: string) => boolean): void {
    const held = [...this.held];
    this.access.clearSessionId();
    for (const sessionId of held) {
      if (streaming(sessionId)) this.pending.add(sessionId);
      else this.releaseOne(sessionId);
    }
  }

  /** 面板重开（重新 resolve）：撤销全部挂起——面板回来了就该继续持有 */
  onResolve(): void {
    this.pending.clear();
  }

  /** 某会话的流收场：该会话挂起过才归还；**必须在所有落盘写完之后**调用 */
  onStreamEnd(sessionId: string): void {
    if (this.pending.has(sessionId)) this.releaseOne(sessionId);
  }

  /**
   * 握手期间面板被销毁：补归还刚落到的锁
   *
   * @param acquired claimStartupSession 拿到的会话（空串 = 未拿到）
   * @returns true = 面板已销毁，调用方应中止后续让位 / 提示
   */
  abandonIfDisposed(acquired: string): boolean {
    if (this.access.getSessionId()) return false;
    if (acquired) this.releaseOne(acquired);
    return true;
  }
}
