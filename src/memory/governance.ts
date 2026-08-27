/**
 * 记忆治理共享常量 — score 提升量/上限/下限 + 自然沉底判定天数的统一真理源。
 * memoryInspector / memoryAdvisor 原来各自维护同一份 score 常量，集中到此改 1 处。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 *
 * 治理模型（2026-08-27 收敛）：supersede（写时取代）+ boost（越常用越重要）；
 * 衰减（原 L0）已移除——摘要是事实记录无"过时"语义，记忆有效性由 superseded 写时取代判定，
 * 低频记忆经相关性排序自然沉底，无需主动 score 衰减。
 */
/** score 提升量——「越常用越重要」；消费者：recall.ts boostScore（被动）、memoryInspector.writeBoost（主动） */
export const BOOST_INCREMENT = 0.05;

/** score 上限，防 boost 超过 1.0 */
export const SCORE_CEILING = 1.0;

/** score 下限（incrementScore clamp）；消费者：InMemoryStorage/WorkspaceStorage incrementScore（demote 场景向下 clamp） */
export const DECAY_FLOOR = 0.1;

/**
 * 自然沉底判定天数（listFading cutoff）。
 * 当记忆距上次访问超过此天数时，判定为"即将自然沉底"，供健康观测面板展示。
 * 默认取保守阈值 60 天：久未访问且低分的记忆在观测面板标记，由 superseded/低相关排序自然退出召回面。
 */
export const FADING_CUTOFF_DAYS = 60;

/**
 * 治理源列表：实际写入记忆库的 source 才参与去重 / 冲突治理；
 * persona / rule / skill 走 RolePack 体系（非记忆库写入），不在此列。
 * 注意：此为「治理源」概念，与已移除的 score 衰减无关。
 */
export const GOVERNANCE_SOURCES: readonly string[] = ['content'];
