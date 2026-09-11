/**
 * 可观测性 — 运行时指标测试
 *
 * 覆盖 AgentLoop.getMetrics() 和 Agent.getMetrics() 的指标统计正确性：
 *   - LLM 调用指标（callCount、totalInputTokens、totalOutputTokens）
 *   - 工具调用指标（callCount、failureCount）
 *   （记忆召回命中率指标已随自动注入退役删除，见下）
 *   - 上下文管理指标（truncationCount、messageCount、estimatedTokens）
 *   - Agent.getMetrics() 聚合行为
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { AgentMetrics } from '@/agent/tracer.js';

// ═══════════════════════════════════════════════════════════════
// Mock 工具
// ═══════════════════════════════════════════════════════════════

type ChunkItem = { content?: string; toolCalls?: Message['toolCalls']; finishReason?: string };

/**
 * 创建单轮模拟 LLM Provider，每次 chat() 返回同样的一组 chunks
 */
function mockProvider(chunks: ChunkItem[]): LlmProvider {
  return {
    name: 'mock',
    async *chat() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

/**
 * 创建多轮模拟 LLM Provider，每轮 chat() 按顺序消费 turns 中的一个
 */
function mockMultiTurnProvider(turns: ChunkItem[][]): LlmProvider {
  let turnIndex = 0;
  return {
    name: 'mock',
    async *chat() {
      const chunks = turns[turnIndex] ?? [];
      turnIndex++;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

/**
 * 消费 AsyncGenerator 的所有 chunk
 */
async function consumeGenerator(gen: AsyncGenerator<AgentChunk>): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

// ═══════════════════════════════════════════════════════════════
// 初始状态测试
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · getMetrics 初始状态', () => {
  it('新构造的 AgentLoop 指标应全为零', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const metrics = loop.getMetrics();

    expect(metrics.llm.callCount).toBe(0);
    expect(metrics.llm.totalInputTokens).toBe(0);
    expect(metrics.llm.totalOutputTokens).toBe(0);
    expect(metrics.llm.actualInputTokens).toBe(0);
    expect(metrics.llm.actualOutputTokens).toBe(0);
    expect(metrics.tools.callCount).toBe(0);
    expect(metrics.tools.failureCount).toBe(0);
    expect(metrics.context.truncationCount).toBe(0);
    // messageCount 为 1（仅 system prompt）
    expect(metrics.context.messageCount).toBe(1);
    // estimatedTokens > 0（system prompt 有内容）
    expect(metrics.context.estimatedTokens).toBeGreaterThan(0);
    // tasks 初始状态全零
    expect(metrics.tasks.totalCount).toBe(0);
    expect(metrics.tasks.successCount).toBe(0);
    expect(metrics.tasks.failureCount).toBe(0);
    expect(metrics.tasks.successRate).toBe(0);
    expect(metrics.tasks.avgDurationMs).toBe(0);
  });

  it('getMetrics 返回的对象应是快照（不可变副本）', () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 消费一轮对话触发指标累加
    return consumeGenerator(loop.processUserInput('测试')).then(() => {
      const metrics1 = loop.getMetrics();
      const metrics2 = loop.getMetrics();
      // 两次调用返回的值应相同（纯只读快照）
      expect(metrics1.llm.callCount).toBe(metrics2.llm.callCount);
      expect(metrics1.tools.callCount).toBe(metrics2.tools.callCount);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM 调用指标测试
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · LLM 调用指标', () => {
  it('单轮对话后 callCount 应为 1，token 数应大于 0', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '你好，我是助手' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    await consumeGenerator(loop.processUserInput('你好'));

    const metrics = loop.getMetrics();
    expect(metrics.llm.callCount).toBe(1);
    // 输入 token = system prompt + user 消息的估算
    expect(metrics.llm.totalInputTokens).toBeGreaterThan(0);
    // 输出 token = assistant 回复的估算
    expect(metrics.llm.totalOutputTokens).toBeGreaterThan(0);
  });

  it('多轮对话后 callCount 应累加', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    await consumeGenerator(loop.processUserInput('第一轮'));
    await consumeGenerator(loop.processUserInput('第二轮'));
    await consumeGenerator(loop.processUserInput('第三轮'));

    const metrics = loop.getMetrics();
    expect(metrics.llm.callCount).toBe(3);
  });

  it('工具调用循环中多次 LLM 调用都应计数', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('工具结果');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 第一轮：返回 toolCalls
        [{ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] }],
        // 第二轮：返回纯文本
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    await consumeGenerator(loop.processUserInput('调用工具'));

    const metrics = loop.getMetrics();
    // 两次 LLM 调用（第一次返回 toolCalls，第二次返回纯文本）
    expect(metrics.llm.callCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具调用指标测试
//
// 记忆召回指标维度（recall.totalCount/hitCount/hitRate）已于 2026-09-11 随
// LoopMetrics/AgentMetrics 中的字段一并物理删除：自动召回退役后三者零写点、
// hitRate 恒 0（假指标）。记忆检索唯一入口 = search_memories 工具（TOOL_EXEC span）。
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · 工具调用指标', () => {
  it('成功执行工具后 callCount 应累加，failureCount 为 0', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('工具结果');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    await consumeGenerator(loop.processUserInput('调用工具'));

    const metrics = loop.getMetrics();
    expect(metrics.tools.callCount).toBe(1);
    expect(metrics.tools.failureCount).toBe(0);
  });

  it('工具执行失败时 failureCount 应累加', async () => {
    const toolExecutor = vi.fn().mockRejectedValue(new Error('工具执行失败'));
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'test_tool', arguments: '{}' } }] }],
        [{ content: '工具失败了，我换个方式' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    await consumeGenerator(loop.processUserInput('调用工具'));

    const metrics = loop.getMetrics();
    expect(metrics.tools.callCount).toBe(1);
    expect(metrics.tools.failureCount).toBe(1);
  });

  it('多个工具调用都应计数', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('结果');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{
          toolCalls: [
            { id: 'tc1', type: 'function', function: { name: 'tool1', arguments: '{}' } },
            { id: 'tc2', type: 'function', function: { name: 'tool2', arguments: '{}' } },
            { id: 'tc3', type: 'function', function: { name: 'tool3', arguments: '{}' } },
          ],
        }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    await consumeGenerator(loop.processUserInput('调用多个工具'));

    const metrics = loop.getMetrics();
    expect(metrics.tools.callCount).toBe(3);
    expect(metrics.tools.failureCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 上下文管理指标测试
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · 上下文管理指标', () => {
  it('未触发截断时 truncationCount 为 0', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      maxContextTokens: 8000, // 足够大，不触发截断
    });

    await consumeGenerator(loop.processUserInput('你好'));

    const metrics = loop.getMetrics();
    expect(metrics.context.truncationCount).toBe(0);
    // system + user + assistant = 3
    expect(metrics.context.messageCount).toBe(3);
    expect(metrics.context.estimatedTokens).toBeGreaterThan(0);
  });

  it('触发截断时 truncationCount 应累加', async () => {
    // 设置极小的 maxContextTokens 强制触发截断
    // 注意：truncateMessages 要求 messages.length > 3 且 estimated > maxContextTokens
    // system prompt 本身约 17 tokens，需要用户输入足够长才能超 50 tokens
    const longInput = '这是一段非常长的用户输入内容用于确保总 token 数超过 maxContextTokens 阈值从而触发上下文截断逻辑';
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      maxContextTokens: 50, // 极小，必然触发截断
    });

    // 第一轮：messages = [system, user, assistant] = 3 条，不截断（length <= 3）
    await consumeGenerator(loop.processUserInput(longInput));
    // 第二轮：messages = [system, user1, assistant1, user2] = 4 条，token 超 50，触发截断
    await consumeGenerator(loop.processUserInput(longInput));

    const metrics = loop.getMetrics();
    expect(metrics.context.truncationCount).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// AgentMetrics 类型结构验证
// ═══════════════════════════════════════════════════════════════

describe('AgentMetrics · 类型结构', () => {
  it('getMetrics 返回的对象应包含所有 5 个维度', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const metrics: AgentMetrics = loop.getMetrics();

    // 验证 4 个维度都存在
    expect(metrics).toHaveProperty('llm');
    expect(metrics).toHaveProperty('tools');
    expect(metrics).toHaveProperty('context');
    expect(metrics).toHaveProperty('tasks');

    // 验证 LLM 维度字段
    expect(metrics.llm).toHaveProperty('callCount');
    expect(metrics.llm).toHaveProperty('totalInputTokens');
    expect(metrics.llm).toHaveProperty('totalOutputTokens');
    expect(metrics.llm).toHaveProperty('actualInputTokens');
    expect(metrics.llm).toHaveProperty('actualOutputTokens');

    // 验证 tools 维度字段
    expect(metrics.tools).toHaveProperty('callCount');
    expect(metrics.tools).toHaveProperty('failureCount');

    // 验证 context 维度字段
    expect(metrics.context).toHaveProperty('truncationCount');
    expect(metrics.context).toHaveProperty('messageCount');
    expect(metrics.context).toHaveProperty('estimatedTokens');

    // 验证 tasks 维度字段
    expect(metrics.tasks).toHaveProperty('totalCount');
    expect(metrics.tasks).toHaveProperty('successCount');
    expect(metrics.tasks).toHaveProperty('failureCount');
    expect(metrics.tasks).toHaveProperty('successRate');
    expect(metrics.tasks).toHaveProperty('avgDurationMs');
  });

  it('recordBudget 后 getMetrics().context.budget 透出（④ 预算可视化）', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 未记录时 budget 缺省
    expect(loop.getMetrics().context.budget).toBeUndefined();

    // prepare 期 recordBudget → 快照透出最近一轮预算构成
    loop.recordBudget({
      availableTokens: 97_000,
      anchorTokens: 200,
      remainingTokens: 96_800,
      dialogueBudgetTokens: 87_120,
    });
    const budget = loop.getMetrics().context.budget;
    expect(budget).toBeDefined();
    expect(budget!.dialogueBudgetTokens).toBe(87_120);
  });

  it('recordOccupancy 后 getMetrics().context.occupancy 透出（④ 预算可视化·真实占用）', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 未记录时 occupancy 缺省
    expect(loop.getMetrics().context.occupancy).toBeUndefined();

    // prepare 期 recordOccupancy → 快照透出最近一轮真实占用
    loop.recordOccupancy({
      totalTokens: 120_000,
      rolePackBaseTokens: 3_000,
      dialogueTokens: 12_000,
      dialogueCount: 3,
      inputAnchorTokens: 800,
      outputReserveTokens: 18_000,
      freeTokens: 86_200,
    });
    const occ = loop.getMetrics().context.occupancy;
    expect(occ).toBeDefined();
    expect(occ!.totalTokens).toBe(120_000);
    expect(occ!.dialogueTokens).toBe(12_000);
  });

  it('对话占用实时刷新：user 输入后 dialogueCount 按问答闭环重算（+1），容量含新输入', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    // 预置 3 个已落库 user 消息（模拟已有 3 个问答闭环）
    const msgs = loop as unknown as { messages: Array<{ role: string; content: string }> };
    msgs.messages.push(
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    );
    // 模拟 prepare 期已记录快照（dialogueCount 占位 99，验证会被真实重算覆盖）
    loop.recordOccupancy({
      totalTokens: 120_000,
      rolePackBaseTokens: 3_000,
      dialogueTokens: 12_000,
      dialogueCount: 99,
      inputAnchorTokens: 0,
      outputReserveTokens: 18_000,
      freeTokens: 87_000,
    });
    // 用户输入第 4 条（一个问答闭环）→ 触发占用实时刷新
    (loop as unknown as { appendUserMessage: (c: string) => void }).appendUserMessage('新问题');
    const occ = loop.getMetrics().context.occupancy!;
    // 计数标准：user 消息数 = 4（占位 99 被真实重算覆盖）
    expect(occ.dialogueCount).toBe(4);
    // 容量诚实统计：dialogueTokens 重算为真实 messages 估算（含新用户输入，>0 且等于直接估算）
    const conv = (loop as unknown as { getConversationMessages: () => Array<{ role: string }> }).getConversationMessages();
    expect(occ.dialogueTokens).toBe(loop.estimateTokens(conv as never));
    expect(occ.dialogueTokens).toBeGreaterThan(0);
    // 其余段不被重算（守 SSOT，沿用快照）
    expect(occ.rolePackBaseTokens).toBe(3_000);
  });

  it('对话占用实时刷新：assistant 落盘后容量补含回答（残缺/中止回复如实计入容量）', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    const msgs = loop as unknown as { messages: Array<{ role: string; content: string }> };
    msgs.messages.push({ role: 'user', content: 'q1' });
    loop.recordOccupancy({
      totalTokens: 120_000,
      rolePackBaseTokens: 3_000,
      dialogueTokens: 5_000,
      dialogueCount: 99,
      inputAnchorTokens: 0,
      outputReserveTokens: 18_000,
      freeTokens: 94_000,
    });
    // user 输入第 2 条 → dialogueCount 重算为 2
    (loop as unknown as { appendUserMessage: (c: string) => void }).appendUserMessage('问题');
    expect(loop.getMetrics().context.occupancy!.dialogueCount).toBe(2);
    const beforeTokens = loop.getMetrics().context.occupancy!.dialogueTokens;
    // assistant 落盘（哪怕残缺/被中止也如实 append）→ 容量补含回答全文
    (loop as unknown as { appendAssistantText: (c: string) => void }).appendAssistantText('这是回复');
    const occ = loop.getMetrics().context.occupancy!;
    expect(occ.dialogueCount).toBe(2); // 条数仍以 user 计，assistant 不增条数
    expect(occ.dialogueTokens).toBeGreaterThan(beforeTokens); // 容量含 assistant 全文
  });

  it('setRolePackBaseTokens 经构造/设值写入，getMetrics().context.rolePackBaseTokens 透出（装配即确定，冷启动可用）', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      rolePackBaseTokens: 5_000,
    });
    // 构造期注入（装配即确定，早于 prepare）
    expect(loop.getMetrics().context.rolePackBaseTokens).toBe(5_000);

    // 切换角色包后实时更新（不依赖跑 prepare）
    loop.setRolePackBaseTokens(9_000);
    expect(loop.getRolePackBaseTokens()).toBe(9_000);
    expect(loop.getMetrics().context.rolePackBaseTokens).toBe(9_000);
  });
});
