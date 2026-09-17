/**
 * 后台任务统一收口门面 —— 一个「后台副作用」的单一启动/观测入口。
 *
 * 收敛散落的 `fire-and-forget`（摘要生成 round-summary / 命中刷新 search_memories.touch / 会话命名 session-title / 向量清理 vector-delete）：
 * - 统一启动：不阻塞调用方，业务 Promise 交给门面兜底；
 * - 统一观测：按 label 累计 pending/completed/failed，宿主可读后台健康度；
 * - 统一兜底：失败统一记日志，业务侧补救经 onFailure 挂载（如宿主事件 emit）；
 * - 统一限流：最大并发槽位防止上述四类任务无界并发耗尽资源。
 *
 * 与模块级 logger 同模式（全局单例，组件直接 import，零注入成本）。
 */
import { logger } from '@/logging/logger.js';

/** 后台任务累计统计快照（宿主读后台健康度，纯只读） */
export interface BackgroundTaskStats {
  /** 在途任务数（含排队中的） */
  pending: number;
  /** 成功完成数（累计） */
  completed: number;
  /** 失败数（累计，未被业务侧消化的） */
  failed: number;
}

/** 后台任务累计统计（模块级单例状态） */
const stats: BackgroundTaskStats = { pending: 0, completed: 0, failed: 0 };

/** 后台任务最大并发数（生产安全性：防止无界并发耗尽资源） */
const MAX_CONCURRENT_BACKGROUND_TASKS = 5;

/** 当前正在执行的任务数（不含排队中的） */
let activeCount = 0;

/** 排队等待执行的任务（FIFO） */
interface QueuedTask {
  label: string;
  factory: () => Promise<unknown>;
  onFailure?: (err: unknown) => void;
}
const pendingQueue: QueuedTask[] = [];

/**
 * 启动一个后台任务（不阻塞调用方）。统一计数 + 兜底失败日志 + 并发槽位控制。
 * 保留「调用即纳入在途计数」的契约——无论立即执行还是排队等待。
 *
 * @param label 任务标签（日志/观测区分用途）
 * @param factory 返回业务 Promise 的工厂；内部不要自行 `catch`，交给本门面统一兜底计数
 * @param onFailure 失败时的业务侧补救（如宿主事件 emit）；缺省仅记日志
 */
export function backgroundTask(
  label: string,
  factory: () => Promise<unknown>,
  onFailure?: (err: unknown) => void,
): void {
  stats.pending++;

  if (activeCount < MAX_CONCURRENT_BACKGROUND_TASKS) {
    // 有空闲槽位 → 立即执行
    executeTask(label, factory, onFailure);
  } else {
    // 槽位已满 → 排队等待
    logger.debug({ label }, '后台任务排队等待执行');
    pendingQueue.push({ label, factory, onFailure });
  }
}

/**
 * 执行一个任务（内部方法）。在有空闲槽位时调用。
 * 任务完成后自动释放槽位并消费排队中的下一个任务。
 */
function executeTask(
  label: string,
  factory: () => Promise<unknown>,
  onFailure?: (err: unknown) => void,
): void {
  activeCount++;
  const task = factory();
  task.then(
    () => {
      stats.pending--;
      stats.completed++;
      activeCount--;
      logger.debug({ label }, '后台任务完成');
      drainQueue();
    },
    (err: unknown) => {
      stats.pending--;
      stats.failed++;
      activeCount--;
      logger.warn({ err, label }, '后台任务失败');
      onFailure?.(err);
      drainQueue();
    },
  );
}

/**
 * 从排队队列中消费一个任务执行（并发槽位释放时调用）。
 * 保证不超过 MAX_CONCURRENT_BACKGROUND_TASKS 上限。
 */
function drainQueue(): void {
  if (activeCount >= MAX_CONCURRENT_BACKGROUND_TASKS) return;
  const next = pendingQueue.shift();
  if (!next) return;
  // 排队任务启动时仍计入 pending（已在入队时计数），这里仅消费槽位
  executeTask(next.label, next.factory, next.onFailure);
}

/** 读取后台任务累计统计快照（只读副本，宿主可观测后台健康度） */
export function getBackgroundTaskStats(): BackgroundTaskStats {
  return { ...stats };
}

/**
 * 等待所有在途后台任务完成（带超时保护，防止任务永不返回阻塞 close）。
 * Agent.close() 必须调用此函数——否则后台命中刷新/摘要生成等任务可能在 storage 关闭后 upsert 失效。
 *
 * @param timeoutMs 超时时间（毫秒），默认 5000ms
 * @returns 实际等待到的 pending 任务数（0 表示无在途任务）
 */
export async function awaitBackgroundTasks(timeoutMs = 5000): Promise<number> {
  const initialPending = stats.pending;
  if (initialPending === 0) return 0;

  logger.debug({ pending: initialPending }, '等待后台任务完成...');

  const startTime = Date.now();
  while (stats.pending > 0) {
    if (Date.now() - startTime > timeoutMs) {
      logger.warn(
        { pending: stats.pending, timeoutMs },
        '等待后台任务超时，放弃剩余任务',
      );
      break;
    }
    // 等待下一个微任务周期，让 pending 计数有机会被更新
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return initialPending;
}

/**
 * 重置模块级状态（仅测试使用，生产代码禁止调用）。
 * 清理 activeCount、pendingQueue、stats，确保测试用例间状态隔离。
 * @internal
 */
export function _resetBackgroundTaskState(): void {
  stats.pending = 0;
  stats.completed = 0;
  stats.failed = 0;
  activeCount = 0;
  pendingQueue.length = 0;
}