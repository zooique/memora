/**
 * 启动会话归属裁决（无状态判据函数 · 取锁副作用全部经 deps 注入 · 面板与验收共用同一份判据）
 *
 * 为什么需要它：用户开两个 VS Code 窗口，两边都会按 `lastActiveAt` 恢复「上次停留的会话」，
 * 极可能落到同一个。第二个窗口拿不到该会话的跨进程写锁 ⇒ 必须让位，否则静默覆盖。
 *
 * 判据（顺序即优先级）：
 *   1. 首选会话可用 → 归属首选，未让位；
 *   2. 首选被占 → 按调用方给的候选顺序（最近写入优先）找第一个可拿的会话 → 让位；
 *   3. 全部候选都被占 / 没有候选 → 返回空 sessionId，由调用方新建一个空会话（窗口仍可用）。
 *
 * 为什么不让调用方自己写循环：面板里再写一遍同样的「首选 → 候选 → 新建」判据，
 * 验收测试就无法证明用户真实路径的行为（测的是另一份实现）。本函数是唯一判据源。
 */
export interface StartupSessionClaimDeps {
  /** 尝试拿某会话的跨进程写锁；false = 被其他进程持有 */
  acquire: (sessionId: string) => Promise<boolean>;
  /** 让位候选（按「最近写入」降序；调用方负责排除首选与留存区会话） */
  fallbackCandidates: () => string[];
}

/** 裁决结果 */
export interface StartupSessionClaimResult {
  /** 最终归属的会话 id；空串 = 没有可用会话（`displaced=true` 时由调用方新建；`displaced=false` 表示从未有过会话——面板在调用前即短路空首选，该分支为防御性） */
  sessionId: string;
  /** 是否因首选被占用而发生了让位（供调用方决定要不要给用户可见提示） */
  displaced: boolean;
}

/**
 * 裁决启动会话归属
 *
 * @param preferred 首选会话（`getInitialSessionId()` 的结果；空串 = 从未有过会话）
 * @param deps 拿锁与候选来源
 * @returns 归属结果（空 sessionId + displaced=true 表示「该新建」）
 */
export async function claimStartupSession(
  preferred: string,
  deps: StartupSessionClaimDeps,
): Promise<StartupSessionClaimResult> {
  if (!preferred) return { sessionId: '', displaced: false };
  if (await deps.acquire(preferred)) return { sessionId: preferred, displaced: false };
  for (const candidate of deps.fallbackCandidates()) {
    if (await deps.acquire(candidate)) return { sessionId: candidate, displaced: true };
  }
  return { sessionId: '', displaced: true };
}
