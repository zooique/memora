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
// AgentLoop · 任务表观测量（实证任务表是否被 LLM 触发）
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · 任务表观测量', () => {
  it('调用 task_table_write 后 plan.taskTableWriteCount 累加', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{
          toolCalls: [
            {
              id: 'tc1',
              type: 'function',
              function: {
                name: 'task_table_write',
                arguments: '{"mode":"overwrite","steps":[{"description":"步骤1"},{"description":"步骤2"}]}',
              },
            },
          ],
        }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('[OK] 任务表已更新'),
    });

    await consumeGenerator(loop.processUserInput('执行多步任务'));

    const metrics = loop.getMetrics();
    expect(metrics.plan.taskTableWriteCount).toBe(1);
  });

  it('产生 active step 边界后 plan.stepBoundaryCount 累加', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '完成' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    // 模拟已有任务表 active step（真实场景由 assembler 装配 getActiveStepMeta）
    loop.getActiveStepMeta = () => ({ stepId: 's1', title: '步骤1' });

    await consumeGenerator(loop.processUserInput('任务'));

    const metrics = loop.getMetrics();
    expect(metrics.plan.stepBoundaryCount).toBe(1);
  });

  it('needsPlanning 命中 → 首迭代注入命令式任务表引导', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '完成' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      needsPlanningOverride: () => true,
    });

    await consumeGenerator(loop.processUserInput('重构这个模块'));

    expect(loop.getMessages().some((m) => m.content.includes('任务表强制提示'))).toBe(true);
  });

  it('needsPlanning 未命中 → 零打扰（不注入任务表引导）', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '完成' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      needsPlanningOverride: () => false,
    });

    await consumeGenerator(loop.processUserInput('你好，简单回答即可'));

    expect(loop.getMessages().some((m) => m.content.includes('任务表强制提示'))).toBe(false);
  });

  it('已有在途任务表（hasInflightPlan 为真）→ 命中 needsPlanning 也不注入引导', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '完成' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      needsPlanningOverride: () => true,
    });
    // 在途信号由装配注入（真实来源 = assembler 装配 SessionManager.hasInflightPlan；
    // 装配链端到端见 assembler.test「在途任务表判定」用例）
    loop.hasInflightPlan = () => true;

    // 已建表时 nudge 的「先拆解建表」是冗余/误导 → 不注入
    await consumeGenerator(loop.processUserInput('小组会议：继续讨论 A、B、C 的选型'));

    expect(loop.getMessages().some((m) => m.content.includes('任务表强制提示'))).toBe(false);
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

    // 验证 plan 维度字段（2026-09-14 层0：任务表触发观测量）
    expect(metrics.plan).toHaveProperty('taskTableWriteCount');
    expect(metrics.plan).toHaveProperty('stepBoundaryCount');
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

describe('AgentLoop · 空响应兜底计数（2026-09-15 边界补缝）', () => {
  it('provider 恒空 → 重试耗尽后兜底文案可见 + metrics.llm.emptyResponseCount 递增', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([]), // 空 chunks = 200 但 0 token 的空响应
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    await consumeGenerator(loop.processUserInput('你好'));

    // 兜底命中计数（空响应最终落到 loop 英文兜底 = 用户看到零产出的可量化信号）
    expect(loop.getMetrics().llm.emptyResponseCount).toBe(1);
    // 兜底文案出现在 assistant 消息（未把模型拒绝/瞬态空误当合法产出）
    expect(
      loop.getMessages().some((m) => m.role === 'assistant' && String(m.content).includes('empty response')),
    ).toBe(true);
  });
});

describe('AgentLoop · 配对守卫计数出闸（2026-09-16 僵尸声明消缺）', () => {
  it('getMetrics().llm 必须带 pairingGuardFires —— 只自增不外露的计数等于没记', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    // 职责分工：**计数会不会递增**由 `llmCaller.test.ts` 守住（守卫真拒发 → +1）；
    // 此处只守**出闸**——内核拦下坏批次是守门行为，宿主 / tracer 看不见即为「僵尸声明」
    // （派生字段零消费者）：花了成本拦，却无人能观测到拦过。
    // 变异验证：删掉出闸行 → tsc(TS2741) 与本用例**双重变红**。
    // **已知未覆盖**：写成硬编码常量（`pairingGuardFires: 0`）时本用例绿——类型仍合规，
    // 而「计数会不会递增」另有 llmCaller.test.ts 守住。补源码扫描守卫可覆盖该形态，
    // 但会锚定代码书写格式（格式微调即误红），性价比低，故登记缺口而非加固。
    expect(loop.getMetrics().llm.pairingGuardFires).toBe(0);
  });
});
