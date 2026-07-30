/**
 * 记忆治理共享常量 — LLM 治理源列表 + score 提升量/上限的统一真理源
 *
 * 设计原因：memoryInspector / memoryAdvisor / memoryDecayScheduler 三个治理模块
 * 各自维护同一份 `[INSIGHT, PROFILE, WORK_PROJECTION]` 列表，存在 5 处独立维护。
 * 提取到共享模块后，未来调整治理范围只需改 1 处（v2 年轮审判 REPEAT-1 闭环）。
 *
 * 同时收纳 score 提升量/上限常量（recall.ts 召回 boost + memoryInspector 采纳反哺 boost），
 * 消除 2 处重复（v2 年轮审判 REPEAT-2 闭环）。
 *
 * 依赖方向：memory/governance.ts 是纯常量模块（零依赖，仅类型 import），
 * 被 agent/managers/ 多个模块消费，符合 agent → memory 单向依赖原则。
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
  SOURCE_LABELS.INSIGHT,
  SOURCE_LABELS.PROFILE,
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
