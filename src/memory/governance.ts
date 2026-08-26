/**
 * 记忆治理共享常量 — 治理源列表 + score 提升量/上限/下限/衰减的统一真理源。
 * memoryInspector / memoryAdvisor / memoryDecayScheduler 原来各自维护同一份治理源列表与 score 常量，集中到此改 1 处。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 */
/**
 * 参与去重 / 冲突检测 / 时效性评估 / 衰减的 source 集合。
 *
 * 设计演进（2026-08-26 对齐 ADR-025 + 架构收敛）：
 *   - persona / rule / skill 已归角色包管理，不写入记忆库（ADR-025）
 *   - work-projection 已移出记忆库（2026-08-20，落项目目录 projections/）
 *   - profile 已收敛为 round-summary 的 type=preference 召回
 *   - round-summary 不参与衰减（事实记录语义，由 superseded + score 自然沉底）
 *
 * 当前唯一治理对象：content（用户主动添加的记忆）。
 * 空治理源时衰减/去重/冲突检测空转但保留机制，未来新增治理源从此处声明即可。
 */
export const GOVERNANCE_SOURCES: readonly string[] = [
  'content',       // 用户主动添加的记忆（唯一治理对象）
];

/** score 提升量——「越常用越重要」；消费者：recall.ts boostScore（被动）、memoryInspector.writeBoost（主动） */
export const BOOST_INCREMENT = 0.05;

/** score 上限，防 boost 超过 1.0 */
export const SCORE_CEILING = 1.0;

/** 衰减/demote 下限（incrementScore clamp）；消费者：applyDecayToMemory、InMemoryStorage/WorkspaceStorage incrementScore */
export const DECAY_FLOOR = 0.1;

/**
 * 指数衰减半衰期（天）。
 * 30 天半衰期意味着：记忆 30 天后 score 降为一半，60 天后降为 1/4，90 天后降为 1/8。
 * 单一真理源：内核 applyDecayToMemory 和宿主 WorkspaceStorage.decayScores 均使用此常量。
 */
export const EXPONENTIAL_DECAY_HALF_LIFE_DAYS = 30;

/**
 * 自然沉底判定天数（listFading cutoff）。
 * 当记忆距上次访问超过此天数时，判定为"即将自然沉底"，供健康观测面板展示。
 * 默认取半衰期的 2 倍（60 天）：此时 score 已降为 0.25，明显低于初始值。
 */
export const FADING_CUTOFF_DAYS = 60;