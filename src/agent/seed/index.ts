/**
 * 种子聚合目录出口
 *
 * 对外暴露 SeedOrchestrator（最小问答闭环编排器）与 SeedDeps 契约类型，
 * 供门面（agent.ts）委托与组织 seed 单测。流向：agent/seed/* → agent/loop，
 * agent.ts → agent/seed（种子消费引擎，门面委托种子，不新建顶层模块）。
 */

export { SeedOrchestrator } from './orchestrator.js';
export type { StreamConsumeResult, SeedParts, SeedDeps, SeedPrepareResult } from './types.js';
// 三阶段 + Handoff 执行器（门面按路径复用单阶段能力）
export { SeedPrepare } from './prepare.js';
export { SeedAct } from './act.js';
export { SeedReflect } from './reflect.js';
export { SeedHandoff } from './handoff.js';