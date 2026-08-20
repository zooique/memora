/**
 * 记忆治理共享常量 — 治理源列表 + score 提升量/上限/下限/衰减的统一真理源。
 * memoryInspector / memoryAdvisor / memoryDecayScheduler 原来各自维护同一份治理源列表与 score 常量，集中到此改 1 处。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 * 治理源为空：WORK_PROJECTION 已随作品投影移出记忆库（落项目目录），PROFILE 已随角色包边界
 * 收敛移除；记忆库仅剩 round-summary（不参与运行时治理），故治理层当前无治理对象、全空转。
 */
/** 参与去重 / 冲突检测 / 时效性评估 / 衰减的 source 集合；当前无治理对象（记忆库仅 round-summary） */
export const GOVERNANCE_SOURCES: readonly string[] = [];

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