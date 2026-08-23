/**
 * 记忆治理共享常量 — 治理源列表 + score 提升量/上限/下限/衰减的统一真理源。
 * memoryInspector / memoryAdvisor / memoryDecayScheduler 原来各自维护同一份治理源列表与 score 常量，集中到此改 1 处。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 */
/**
 * 参与去重 / 冲突检测 / 时效性评估 / 衰减的 source 集合。
 * 衰减对象：非 round-summary 类型的记忆（content/persona/rule/skill/work-projection/profile 等）。
 * 不衰减：round-summary（会话摘要，事实记录语义）。
 */
export const GOVERNANCE_SOURCES: readonly string[] = [
  'content',       // 用户主动添加的记忆
  'persona',       // 角色设定记忆
  'rule',          // 规则记忆
  'skill',         // 技能记忆
  'work-projection', // 作品投影记忆
  'profile',       // 用户画像记忆
];

/** score 提升量——「越常用越重要」；消费者：recall.ts boostScore（被动）、memoryInspector.writeBoost（主动） */
export const BOOST_INCREMENT = 0.05;

/** score 上限，防 boost 超过 1.0 */
export const SCORE_CEILING = 1.0;

/** 衰减/demote 下限（incrementScore clamp）；消费者：applyDecayToMemory、InMemory/SqliteStorage incrementScore */
export const DECAY_FLOOR = 0.1;

/** 衰减未访问天数阈值（超此天数开始衰减）；消费者：applyDecayToMemory、SqliteStorage.decayScores——修改须同步两处 */
export const DECAY_AGE_DAYS = 7;

/** 每过一个周期 score 降低量；消费者：applyDecayToMemory、SqliteStorage.decayScores——修改须同步两处 */
export const DECAY_AMOUNT = 0.02;

/**
 * 指数衰减半衰期（天）。
 * 30 天半衰期意味着：记忆 30 天后 score 降为一半，60 天后降为 1/4，90 天后降为 1/8。
 * 消费者：applyDecayToMemory（指数衰减公式）
 */
export const EXPONENTIAL_DECAY_HALF_LIFE_DAYS = 30;