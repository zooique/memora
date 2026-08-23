/**
 * 后台任务统一收口门面 —— 一个「后台副作用」的单一启动/观测入口。
 *
 * 收敛散落的 `fire-and-forget`（摘要生成 / boost 打分 / 会话命名 / 时效评估 / 向量清理）：
 * - 统一启动：不阻塞调用方，业务 Promise 交给门面兜底；
 * - 统一观测：按 label 累计 pending/completed/failed，宿主可读后台健康度；
 * - 统一兜底：失败统一记日志，业务侧补救经 onFailure 挂载（如宿主事件 emit）。
 *
 * 与模块级 logger 同模式（全局单例，组件直接 import，零注入成本）。
 */
import { logger } from '@/logging/logger.js';

/** 后台任务累计统计快照（宿主读后台健康度，纯只读） */
export interface BackgroundTaskStats {
  /** 在途任务数 */
  pending: number;
  /** 成功完成数（累计） */
  completed: number;
  /** 失败数（累计，未被业务侧消化的） */
  failed: number;
}

/** 后台任务累计统计（模块级单例状态） */
const stats: BackgroundTaskStats = { pending: 0, completed: 0, failed: 0 };

/**
 * 启动一个后台任务（不阻塞调用方）。统一计数 + 兜底失败日志；可选 onFailure 承载业务侧补救。
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
  // 同步启动 factory：保留「调用即发起副作用」的契约（如 vector delete 需同步触发），
  // 失败兜底与计数统一挂在返回 promise 上，不阻塞调用方
  const task = factory();
  stats.pending++;
  task.then(
    () => {
      stats.pending--;
      stats.completed++;
      logger.debug({ label }, '后台任务完成');
    },
    (err: unknown) => {
      stats.pending--;
      stats.failed++;
      logger.warn({ err, label }, '后台任务失败');
      onFailure?.(err);
    },
  );
}

/** 读取后台任务累计统计快照（只读副本，宿主可观测后台健康度） */
export function getBackgroundTaskStats(): BackgroundTaskStats {
  return { ...stats };
}

/**
 * 等待所有在途后台任务完成（带超时保护，防止任务永不返回阻塞 close）。
 * Agent.close() 必须调用此函数——否则后台 boost/摘要生成等任务可能在 storage 关闭后 upsert 失效。
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
