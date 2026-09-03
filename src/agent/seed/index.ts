/**
 * 种子聚合目录出口
 *
 * 对外暴露 SeedOrchestrator（turn/多 turn 任务编排器）与 SeedDeps 契约类型，
 * 供门面（agent.ts）委托与组织 seed 单测。流向：agent/seed/* → agent/loop，
 * agent.ts → agent/seed（种子消费引擎，门面委托种子，不新建顶层模块）。
 */

export { SeedOrchestrator } from './orchestrator.js';
export type { StreamConsumeResult, SeedParts, SeedDeps, SeedPrepareResult } from './types.js';
// 回答前执行器（含独立状态 lastStickySessionId，保留独立类）
export { SeedPrepare } from './prepare.js';
// 难度分级（真逻辑 + 独立测试，保留独立类）
export { DifficultyJudge } from './difficulty.js';
export type { Difficulty } from './difficulty.js';
