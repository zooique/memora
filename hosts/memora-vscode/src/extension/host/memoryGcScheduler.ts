/**
 * 孤儿 Round GC 的宿主共享调度点（6.0.0 E6）
 *
 * 背景：内核每个 Agent 实例在 `createPostInitComponents` 里各挂一个周期定时器
 * （`GCService.startPeriodic(GC_INTERVAL_MS)`）。B 方案（一会话一 Agent 实例）下
 * N 个实例共享**同一对** `sessionStore` / `roundStore` 单例（E3 硬约束，台账
 * `ROUNDSIDX-SHARED-1`），于是 N 个定时器会给同一份存储重复扫描 N 次——既浪费，
 * 又扩大「扫描与写入交错」的窗口。
 *
 * 收口方式：内核 Agent 统一传 `autoStartGc: false`（只登记不启动，GCService 仍在、
 * `gcNow()` 仍可手动调用），周期驱动只由本类一个定时器负责。
 *
 * 单点语义的判据（宿主测试用计数断言，不靠肉眼）：定时器每触发一次，
 * `scan` 只调用一次；N 个实例在册不改变该次数——扫描对象是共享存储，
 * 扫一次即覆盖全量。
 *
 * 与 E3「陈旧索引只会少删」的配合：`scan` 走 Agent 的 `gcNow()`，其引用集在每次扫描时
 * 现读 `sessionStore.referencedIds()`（不缓存）；而 `referencedIds()` 本身按 **`sessions/`
 * 目录现场扫盘**求并集（不是本进程内存快照），故另一窗口新建/分叉出的会话所引用的轮
 * 也在集合内——单点驱动不会退化成「漏删仍被引用的轮」。
 * ⚠ 边界（诚实登记）：只覆盖**已落盘**的会话文件；某次会话写盘失败（写断言拒绝）的瞬时
 * 内存态不在盘上，也就不在引用集里。
 */

/**
 * 共享 GC 调度器：一个宿主进程只应创建一份，全实例共用。
 */
export class MemoryGcScheduler {
  /** 周期定时器句柄（null = 未启动；启动幂等，重复调用不会叠加第二个定时器） */
  private _timer: ReturnType<typeof setInterval> | null = null;

  /** 累计扫描次数（观测/测试判据：每个周期 +1，与实例数量无关） */
  private _scanCount = 0;

  /** 真正执行一次扫描的动作（宿主注入，通常是「首个登记 Agent 的 gcNow()」） */
  private readonly _scan: () => void;

  /**
   * @param scan 单次扫描动作（必须是幂等存储扫描，而不是「每实例各扫一份」）
   */
  constructor(scan: () => void) {
    this._scan = scan;
  }

  /** 累计已执行的扫描次数（测试断言「1 次 / 周期」的唯一观测面） */
  get scanCount(): number {
    return this._scanCount;
  }

  /** 定时器是否在运行 */
  get running(): boolean {
    return this._timer !== null;
  }

  /**
   * 启动周期驱动（幂等：已启动时直接返回，不会挂第二个定时器）
   *
   * 与内核 `GCService.startPeriodic` 同款语义：启动即先扫一次，之后按间隔重复。
   *
   * @param intervalMs 周期（毫秒；生产取内核 `AGENT_CONSTANTS.GC_INTERVAL_MS`）
   */
  startPeriodic(intervalMs: number): void {
    if (this._timer !== null) return;
    // 启动即扫一次（对齐内核 startPeriodic 的立即执行语义）
    this.runOnce();
    this._timer = setInterval(() => this.runOnce(), intervalMs);
  }

  /** 停止周期驱动（deactivate 时调用；已停止时无操作） */
  stopPeriodic(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /** 立即执行一次扫描（供定时器与测试/手动触发共用同一条路径） */
  runOnce(): void {
    this._scanCount += 1;
    this._scan();
  }
}
