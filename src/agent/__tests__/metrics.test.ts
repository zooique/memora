/**
 * 可观测性 — 运行时指标测试
 *
 * 覆盖 AgentLoop.getMetrics() 和 Agent.getMetrics() 的指标统计正确性：
 *   - LLM 调用指标（callCount、totalInputTokens、totalOutputTokens）
 *   - 记忆召回命中率指标（totalCount、hitCount、hitRate）
 *   - 工具调用指标（callCount、failureCount）
 *   - 上下文管理指标（truncationCount、messageCount、estimatedTokens）
 *   - Agent.getMetrics() 聚合行为
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { AgentMetrics } from '@/agent/tracer.js';

// ═══════════════════════════════════════════════════════════════
// Mock 工具
// ═══════════════════════════════════════════════════════════════

/**
 * 创建测试用 Memory 对象
 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '你是一个测试助手',
    source: 'persona',
    name: 'test-personality',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 1.0,
    ...overrides,
  };
}

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
    expect(metrics.recall.totalCount).toBe(0);
    expect(metrics.recall.hitCount).toBe(0);
    expect(metrics.recall.hitRate).toBe(0);
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
      expect(metrics1.recall.totalCount).toBe(metrics2.recall.totalCount);
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
// 记忆召回命中率指标测试
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · 记忆召回命中率指标', () => {
  it('无召回记忆时 totalCount=1, hitCount=0, hitRate=0', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 不传入 recalledMemories
    await consumeGenerator(loop.processUserInput('你好'));

    const metrics = loop.getMetrics();
    expect(metrics.recall.totalCount).toBe(1);
    expect(metrics.recall.hitCount).toBe(0);
    expect(metrics.recall.hitRate).toBe(0);
  });

  it('有召回记忆时 totalCount=1, hitCount=1, hitRate=1', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const recalledMemories: Memory[] = [makeMemory({ id: 'content:1', source: 'content' })];
    await consumeGenerator(loop.processUserInput('你好', recalledMemories));

    const metrics = loop.getMetrics();
    expect(metrics.recall.totalCount).toBe(1);
    expect(metrics.recall.hitCount).toBe(1);
    expect(metrics.recall.hitRate).toBe(1);
  });

  it('多轮对话后命中率应正确计算', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 第一轮：无召回
    await consumeGenerator(loop.processUserInput('第一轮'));
    // 第二轮：有召回
    const recalled: Memory[] = [makeMemory({ id: 'content:1' })];
    await consumeGenerator(loop.processUserInput('第二轮', recalled));
    // 第三轮：无召回
    await consumeGenerator(loop.processUserInput('第三轮'));

    const metrics = loop.getMetrics();
    expect(metrics.recall.totalCount).toBe(3);
    expect(metrics.recall.hitCount).toBe(1);
    // hitRate = 1/3 ≈ 0.333
    expect(metrics.recall.hitRate).toBeCloseTo(0.333, 2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具调用指标测试
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

    // 验证 5 个维度都存在
    expect(metrics).toHaveProperty('llm');
    expect(metrics).toHaveProperty('recall');
    expect(metrics).toHaveProperty('tools');
    expect(metrics).toHaveProperty('context');
    expect(metrics).toHaveProperty('tasks');

    // 验证 LLM 维度字段
    expect(metrics.llm).toHaveProperty('callCount');
    expect(metrics.llm).toHaveProperty('totalInputTokens');
    expect(metrics.llm).toHaveProperty('totalOutputTokens');
    expect(metrics.llm).toHaveProperty('actualInputTokens');
    expect(metrics.llm).toHaveProperty('actualOutputTokens');

    // 验证 recall 维度字段
    expect(metrics.recall).toHaveProperty('totalCount');
    expect(metrics.recall).toHaveProperty('hitCount');
    expect(metrics.recall).toHaveProperty('hitRate');

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
      memoryLayerCapTokens: 38_720,
    });
    const budget = loop.getMetrics().context.budget;
    expect(budget).toBeDefined();
    expect(budget!.dialogueBudgetTokens).toBe(87_120);
    expect(budget!.memoryLayerCapTokens).toBe(38_720);
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
      memoryTokens: 4_000,
      memoryCount: 2,
      inputAnchorTokens: 800,
      outputReserveTokens: 18_000,
      freeTokens: 82_200,
    });
    const occ = loop.getMetrics().context.occupancy;
    expect(occ).toBeDefined();
    expect(occ!.totalTokens).toBe(120_000);
    expect(occ!.dialogueTokens).toBe(12_000);
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

  it('hitRate 应在 0-1 范围内', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const recalled: Memory[] = [makeMemory({ id: 'content:1' })];
    await consumeGenerator(loop.processUserInput('你好', recalled));

    const metrics = loop.getMetrics();
    expect(metrics.recall.hitRate).toBeGreaterThanOrEqual(0);
    expect(metrics.recall.hitRate).toBeLessThanOrEqual(1);
  });
});
