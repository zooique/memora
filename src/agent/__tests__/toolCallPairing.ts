/**
 * 测试断言助手：tool_call 批次成形配对不变量（**生产谓词的薄壳**，SSOT）。
 *
 * 背景：FAIL-1/G1/G2/G3 四破口共同的底层契约 = 「发往 OpenAI 兼容端的 assistant.toolCalls
 * 必须逐条配对 tool 消息，且无孤立」。此前该不变量被各测试**手内联**验（口径各异、易只验一半），
 * 且与生产实现可能分叉——违反「断言须与不变量同源」。本助手不再手写判定，而是**复测生产谓词
 * `auditToolCallPairing`**：实现判据与测试断言同源，根治「断言口径 ≠ 实现」的复发。
 *
 * 使用：对**最终定型**的消息流（turn 已完成 / 恢复态）断言；挂起中间态（ask 尚未回答那半批）
 * 不适用（彼时 ask 调用刻意暂无配对 tool 消息）。失败时打印全部违规（id + 违反的约束）。
 */

import { expect } from 'vitest';
import { auditToolCallPairing, type ToolPairingCandidate } from '@/agent/managers/toolCallHelpers.js';

/**
 * 断言配对不变量：生产谓词 `auditToolCallPairing` 对 untyped 消息零违规。
 * 薄壳——不做任何额外判定，仅在违规非空时报错并附明细（fail-fast 诊断友好）。
 */
export function expectWellFormedToolPairing(messages: readonly ToolPairingCandidate[]): void {
  const violations = auditToolCallPairing(messages);
  expect(violations).toEqual([]);
}