/**
 * 种子聚合目录出口
 *
 * 对外暴露 SeedOrchestrator（单 turn 动态 step 循环编排器）与 SeedDeps 契约类型。
 * 复杂任务（task_table_write + 动态规划）在一个 turn 的 step 循环里自然生长，
 * 不再强制拆成多 turn 编排（收敛依据见 docs/architecture/agent-design-philosophy.md 第一章 闭环）。
 */

export { SeedOrchestrator } from './orchestrator.js';
export type { StreamConsumeResult, SeedParts, SeedDeps, SeedPrepareResult } from './types.js';
export { SeedPrepare } from './prepare.js';
