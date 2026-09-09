/**
 * 记忆治理共享常量 — score 提升量/上限/下限的统一真理源。
 * memoryInspector / memoryAdvisor 原来各自维护同一份 score 常量，集中到此改 1 处。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 *
 * 治理模型（2026-08-27 收敛）：supersede（写时取代）+ boost（越常用越重要）；
 * 衰减（原 L0）已移除——摘要是事实记录无"过时"语义，记忆有效性由 superseded 写时取代判定，
 * 低频记忆经相关性排序自然后移退出召回面，无"沉底/自然遗忘归档"语义（2026-09-09 定性，
 * 连带移除 listFading 观测与 INACTIVITY_SINK_DAYS 常量）。
 */
/** score 提升量——「越常用越重要」；消费者：recall.ts boostScore（被动）、memoryInspector.writeBoost（主动） */
export const BOOST_INCREMENT = 0.05;

/** score 上限，防 boost 超过 1.0 */
export const SCORE_CEILING = 1.0;

/** score 下限（incrementScore clamp）；消费者：InMemoryStorage/WorkspaceStorage incrementScore（demote 场景向下 clamp） */
export const SCORE_FLOOR = 0.1;

/**
 * source 健康度阈值：仅按**平均 score**判定，不含任何时间维度。
 * 消费者：memoryAdvisor.sourceHealth()。
 *
 * 纪律（D7 / ADR-025）：记忆有效性由**语义状态**判定（superseded 写时取代），
 * 不由时间流逝判定——用户久未使用不构成记忆"过期"或"沉底"的理由。
 * 「用时间代理语义状态」是读时猜测，违反 ADR-021「写时定、不读时猜」，已废弃
 * （2026-09-09：原 CRITICAL_DAYS=30 / WARNING_DAYS=7 时间分支移除）。
 */
export const SOURCE_HEALTH_THRESHOLDS = {
  /** 平均 score 低于此值 → critical */
  CRITICAL_SCORE: 0.2,
  /** 平均 score 低于此值 → warning */
  WARNING_SCORE: 0.5,
} as const;

/**
 * 治理源列表：实际写入记忆库的 source 才参与去重 / 冲突治理。
 * 当前记忆库唯一自动轨 = round-summary（摘要即记忆本体，见 memory-as-summary.md），
 * 其治理由 superseded 写时取代承担，不入本数组；content 历史残留 source 无生产写入路径
 * （2026-09-09 剪枝清空）。空列表时 dedup/冲突检测空转（测试可显式注入治理源）。
 */
export const GOVERNANCE_SOURCES: readonly string[] = [];
