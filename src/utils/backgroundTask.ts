/**
 * 后台任务统一收口门面 —— 一个「后台副作用」的单一启动入口（**实例级**）。
 *
 * 收敛散落的 `fire-and-forget`（摘要生成 round-summary / 命中刷新 search_memories.touch / 会话命名 session-title）：
 * - 统一启动：不阻塞调用方，业务 Promise 交给门面兜底；
 * - 统一兜底：失败统一记日志，业务侧补救经 onFailure 挂载（如宿主事件 emit）；
 * - 统一限流：最大并发槽位防止上述三类任务无界并发耗尽资源。
 *
 * ⚠️ **同名异物**（与 `src/agent/backgroundTasks.ts` 的 `BackgroundTaskRegistry` 严格区分）：
 * 本类是「**内存型 fire-and-forget 副作用的任务槽位调度器**」（摘要/命名/打分，随 Agent 生命周期）；
 * `BackgroundTaskRegistry` 是「**shell 子进程任务注册表**」（run_command background，可被 kill_command 寻址）。
 * 两者同名不同物，勿混用。
 *
 * ⚠️ **实例级**（形态定案：一个 Agent = 一个项目）：并发槽位与排队队列绑定实例，
 * N 个 Agent 实例各自 5 槽、各自 FIFO，互不挤占（见测试 MULTI-AGENT-1「隔离验证」块）。
 * 旧版为模块级单例 —— 多实例共享槽位属已知代价，已按 SSOT 归位到实例。
 *
 * 删后注记（2026-10-16 · 5.0.0）：曾有 BackgroundTaskStats 统计快照出口
 * （getBackgroundTaskStats + completed/failed 累计字段）——Agent 公开面包装零宿主消费，
 * 连带拆除后 completed/failed 成只写字段（僵尸），遂整链删除。在途观测由
 * awaitPending 的返回值承担；勿加回。
 */
import { logger } from '@/logging/logger.js';

/** 后台任务最大并发数（每实例上限；生产安全性：防止无界并发耗尽资源） */
const MAX_CONCURRENT_BACKGROUND_TASKS = 5;

/** 排队等待执行的任务（FIFO） */
interface QueuedTask {
  /** 任务标签（日志/观测区分用途） */
  label: string;
  /** 返回业务 Promise 的工厂 */
  factory: () => Promise<unknown>;
  /** 失败时的业务侧补救（如宿主事件 emit） */
  onFailure?: (err: unknown) => void;
}

/**
 * 后台任务槽位调度器（实例级）
 *
 * 每实例持有独立的并发计数与排队队列。由装配期创建，归属 Agent 实例：
 * 经 SeedDeps（摘要/命名）+ BuiltinToolHandlers（命中 touch）注入，close() 时等待/清场。
 */
export class BackgroundTaskScheduler {
  /** 当前正在执行的任务数（不含排队中的） */
  private activeCount = 0;

  /** 排队等待执行的任务（FIFO） */
  private pendingQueue: QueuedTask[] = [];

  /** 在途任务数（调用即纳入在途计数，无论立即执行还是排队等待） */
  private pendingCount = 0;

  /**
   * 启动一个后台任务（不阻塞调用方）。统一计数 + 兜底失败日志 + 并发槽位控制。
   * 保留「调用即纳入在途计数」的契约——无论立即执行还是排队等待。
   *
   * @param label 任务标签（日志/观测区分用途）
   * @param factory 返回业务 Promise 的工厂；内部不要自行 `catch`，交给本门面统一兜底计数
   * @param onFailure 失败时的业务侧补救（如宿主事件 emit）；缺省仅记日志
   */
  schedule(
    label: string,
    factory: () => Promise<unknown>,
    onFailure?: (err: unknown) => void,
  ): void {
    // 调用即计入在途（立即执行 or 排队均算）
    this.pendingCount++;

    if (this.activeCount < MAX_CONCURRENT_BACKGROUND_TASKS) {
      // 有空闲槽位 → 立即执行
      this.executeTask(label, factory, onFailure);
    } else {
      // 槽位已满 → 排队等待
      logger.debug({ label }, '后台任务排队等待执行');
      this.pendingQueue.push({ label, factory, onFailure });
    }
  }

  /**
   * 等待所有在途后台任务完成（带超时保护，防止任务永不返回阻塞 close）。
   * Agent.close() 必须调用此方法——否则后台命中刷新/摘要生成等任务可能在 storage 关闭后 upsert 失效。
   *
   * @param timeoutMs 超时时间（毫秒），默认 5000ms
   * @returns **等待开始时**的在途任务数（0 = 进入本函数时无在途任务）。
   *   ⚠️ 该值是「曾经在途」而非「已等到完成」：超时放弃剩余任务时返回值仍为初始在途数，
   *   不代表实际完成数。调用方据此判断「是否有在途任务」是正确的（如 `Agent.close()` 的
   *   `awaited > 0`），但**不可当作已完成计数**使用。
   */
  async awaitPending(timeoutMs = 5000): Promise<number> {
    const initialPending = this.pendingCount;
    if (initialPending === 0) return 0;

    logger.debug({ pending: initialPending }, '等待后台任务完成...');

    const startTime = Date.now();
    while (this.pendingCount > 0) {
      if (Date.now() - startTime > timeoutMs) {
        logger.warn({ pending: this.pendingCount, timeoutMs }, '等待后台任务超时，放弃剩余任务');
        break;
      }
      // 等待下一个微任务周期，让 pending 计数有机会被更新
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return initialPending;
  }

  /**
   * 取消**尚未启动**的排队任务（丢弃队列，不中断在途任务）。
   *
   * 用途：close() 在 awaitPending 超时后调用，防止「关后仍从队列启动任务 → 写已关 storage」。
   * ⚠️ 语义边界（勿外溢）：本方法**只清未启动队列**（pendingQueue），**不中断（不可中断）已在途任务**——
   * 在途任务仍会跑完并各自计数回落；此处**不承诺**「关后不再有任何后台写入」。
   *
   * @returns 被丢弃的排队任务数（已计入 pendingCount 者相应扣除）
   */
  cancelPending(): number {
    const discarded = this.pendingQueue.length;
    if (discarded === 0) return 0;
    // 排队任务在入队时已计入 pendingCount，丢弃时同步扣回
    this.pendingQueue.length = 0;
    this.pendingCount -= discarded;
    logger.warn({ discarded }, 'close: 丢弃未启动的排队后台任务');
    return discarded;
  }

  /**
   * 执行一个任务（内部方法）。在有空闲槽位时调用。
   * 任务完成后自动释放槽位并消费排队中的下一个任务。
   */
  private executeTask(
    label: string,
    factory: () => Promise<unknown>,
    onFailure?: (err: unknown) => void,
  ): void {
    this.activeCount++;
    const task = factory();
    task.then(
      () => {
        this.settle(label, null, onFailure);
      },
      (err: unknown) => {
        this.settle(label, err, onFailure);
      },
    );
  }

  /**
   * 任务结算（内部方法）：释放槽位 + 回落计数 + 记日志（失败另触发业务兜底）+ 消费队列。
   * @param err null 表示成功，非 null 表示失败原因
   */
  private settle(label: string, err: unknown, onFailure?: (err: unknown) => void): void {
    this.pendingCount--;
    this.activeCount--;
    if (err === null) {
      logger.debug({ label }, '后台任务完成');
    } else {
      logger.warn({ err, label }, '后台任务失败');
      onFailure?.(err);
    }
    this.drainQueue();
  }

  /**
   * 从排队队列中消费一个任务执行（并发槽位释放时调用）。
   * 保证不超过 MAX_CONCURRENT_BACKGROUND_TASKS 上限。
   */
  private drainQueue(): void {
    if (this.activeCount >= MAX_CONCURRENT_BACKGROUND_TASKS) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    // 排队任务启动时仍计入 pending（已在入队时计数），这里仅消费槽位
    this.executeTask(next.label, next.factory, next.onFailure);
  }
}
