/**
 * 记忆治理共享常量 — LLM 治理源列表 + score 提升量/上限的统一真理源
 *
 * 设计原因：memoryInspector / memoryAdvisor / memoryDecayScheduler 三个治理模块
 * 各自维护同一份治理源列表，存在多处独立维护。
 * 提取到共享模块后，未来调整治理范围只需改 1 处。
 *
 * 同时收纳 score 提升量/上限常量（recall.ts 召回 boost + memoryInspector 采纳反哺 boost），
 * 消除跨模块重复。
 *
 * 依赖方向：memory/governance.ts 是纯常量模块（零依赖，仅类型 import），
 * 被 agent/managers/ 多个模块消费，符合 agent → memory 单向依赖原则。
 *
 * 治理源：仅保留 WORK_PROJECTION 单一治理源；
 * PROFILE（画像）已随角色包边界收敛（ADR-025）移除，不再参与运行时治理。
 *
 * 详见 ADR-004（记忆统一模型）：所有 source 都是开放字符串，治理范围由本文件集中维护。
 */
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * LLM 治理源列表 — 参与去重 / 冲突检测 / 时效性评估 / 衰减的 source 集合
 *
 * 不含配置型记忆（persona / rule / skill），这些是启动时加载的永驻记忆，
 * 不参与运行时治理。如未来扩展治理范围，仅需修改此数组。
 */
export const GOVERNANCE_SOURCES: readonly string[] = [
  SOURCE_LABELS.WORK_PROJECTION,
];

/**
 * score 提升量 — "越常用越重要"语义统一
 *
 * 消费者：
 *   - recall.ts boostScore：召回时触发（被动）
 *   - memoryInspector.writeBoost：用户主动采纳时触发（主动）
 */
export const BOOST_INCREMENT = 0.05;

/**
 * score 上限 — 防止 boost 超过 1.0
 *
 * 消费者：recall.ts / memoryInspector.ts
 */
export const SCORE_CEILING = 1.0;

/**
 * score 下限 — 衰减/demote 的底线（MIND2-L3：incrementScore clamp 下限）
 *
 * 消费者：
 *   - recall.ts applyDecayToMemory（衰减下限）
 *   - InMemoryStorage / SqliteStorage incrementScore（clamp 下限）
 */
export const DECAY_FLOOR = 0.1;

/**
 * 衰减：未访问天数阈值（天）— 超过此天数才开始衰减
 *
 * 消费者：
 *   - recall.ts applyDecayToMemory（内存衰减判断）
 *   - SqliteStorage.decayScores（SQL 衰减 WHERE 条件）
 *
 * 修改时必须同步两处（v2 神木回天：消除跨层重复硬编码）
 */
export const DECAY_AGE_DAYS = 7;

/**
 * 衰减：每过一个周期 score 降低量
 *
 * 消费者：
 *   - recall.ts applyDecayToMemory（内存衰减计算）
 *   - SqliteStorage.decayScores（SQL 衰减 SET 计算）
 *
 * 修改时必须同步两处（v2 神木回天：消除跨层重复硬编码）
 */
export const DECAY_AMOUNT = 0.02;
