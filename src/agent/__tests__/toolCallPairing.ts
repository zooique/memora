/**
 * 测试断言助手：tool_call 批次成形配对不变量（SSOT，供多测试文件复用）。
 *
 * 背景：FAIL-1/G1/G2/G3 四破口共同的底层契约 = 「发往 OpenAI 兼容端的 assistant.toolCalls
 * 必须逐条配对 tool 消息，且无孤立」。此前该不变量被各测试**手内联**验（口径各异、易只验一半），
 * 违反「断言须与不变量同源」——尤其 mock provider 续跑会**重放同一批次**，导致「全局总条数相等」
 * 这类口径误红/假绿。本助手把不变量抽为单一真源，供各测试以**集合包含**而非**总条数**表达。
 *
 * 使用：对**最终定型**的消息流（turn 已完成 / 恢复态）断言；挂起中间态（ask 尚未回答那半批）
 * 不适用（彼时 ask 调用刻意暂无配对 tool 消息）。
 */

import { expect } from 'vitest';

/** 结构化最小形状：只取配对所需的字段，避免深耦合完整 Message 联合类型 */
type PairingCandidate = {
  role: string;
  toolCalls?: readonly { id: string }[];
  toolCallId?: string;
};

/**
 * 断言配对不变量（双向无孤立）：
 *  - 每条 assistant.tool_calls 的 id 都能在 tool 消息里找到（无孤立 assistant 调用）；
 *  - 每条 tool 消息的 toolCallId 都指向存在的 assistant 调用（无孤立 tool 消息）。
 * 用「集合包含」而非「总条数相等」（续跑/重放批次使全局条数不可比）；顺序非契约，不锚定物理顺序。
 */
export function expectWellFormedToolPairing(messages: readonly PairingCandidate[]): void {
  const assistantIds = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.toolCalls ?? [])
    .map((tc) => tc.id);
  const toolIds = messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId);

  for (const id of assistantIds) expect(toolIds).toContain(id);
  for (const id of toolIds) expect(assistantIds).toContain(id);
}