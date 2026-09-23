/**
 * 迭代边界信号 `step_boundary`（档3 · 迭代原子落盘，2026-09-23）
 *
 * 背景（见 docs/architecture/step-atomic-persistence.md §九）：档2 把宿主增量落盘挂在
 * `plan_item_boundary` 上，而该 chunk 只在「有任务表且任务项推进」时产出 → 无任务表的长工具循环
 * **零增量落盘**，崩溃即全丢。本 chunk 补该覆盖缺口：只要迭代完成且将继续下一轮，就产一条，
 * 与有无任务表无关。
 *
 * 本文件锁三条不变量：
 * 1. **产出条件** = `handleToolCalls` 返回 'continue'（还有下一轮）——终态迭代不产（流尾兜底），
 *    这同时保住「终态 chunk 是末条」的既有流契约（宿主 paused 分支据 break）。
 * 2. **顺序契约** = 同迭代内 `plan_item_boundary` 先于 `step_boundary`——保证宿主落盘快照
 *    已含该步折叠边界，崩溃重放不错位。
 * 3. **瞬态** = 不进正文/不进 messages（只是落盘触发信号）。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

type ChunkItem = { content?: string; toolCalls?: Message['toolCalls'] };

/** 多轮模拟 Provider：每轮 chat() 顺序消费 turns 中的一组 chunk */
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

function toolCall(id: string, name: string, args = '{}'): NonNullable<Message['toolCalls']>[number] {
  return { id, type: 'function', function: { name, arguments: args } };
}

async function collect(loop: AgentLoop, input: string): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of loop.processUserInput(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('AgentLoop · 迭代边界信号（档3 落盘触发）', () => {
  it('无任务表多轮工具迭代：每次「将继续下一轮」的迭代产一条边界（= 迭代数）', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [toolCall('c1', 'tool_a')] }],
        [{ toolCalls: [toolCall('c2', 'tool_b')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const chunks = await collect(loop, '跑两轮工具');

    // 前两轮各产一条（会继续下一轮）；第三轮是纯文本收尾 → 不产
    const boundaries = chunks.filter((c) => c.type === 'step_boundary');
    expect(boundaries).toHaveLength(2);
    // 边界均在本迭代工具落定之后（工具结果已在宿主缓冲里 → 落盘不丢工具段）
    const firstBoundary = chunks.findIndex((c) => c.type === 'step_boundary');
    const firstToolResult = chunks.findIndex((c) => c.type === 'tool_result');
    expect(firstToolResult).toBeGreaterThanOrEqual(0);
    expect(firstBoundary).toBeGreaterThan(firstToolResult);
    // 末条仍是终态（既有流契约：宿主据终态收场）
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });

  it('★ 档2 覆盖缺口：全程无 plan_item_boundary（无任务表）仍产边界', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [toolCall('c1', 'tool_a')] }],
        [{ toolCalls: [toolCall('c2', 'tool_b')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
    });

    const chunks = await collect(loop, '无任务表长循环');

    // 无任务表 → 任务项边界恒不产（静默）；若把落盘挂它上面，这一轮就是零增量落盘
    expect(chunks.filter((c) => c.type === 'plan_item_boundary')).toHaveLength(0);
    // 而迭代边界照产 —— 这正是本信号存在的唯一理由
    expect(chunks.filter((c) => c.type === 'step_boundary').length).toBeGreaterThan(0);
  });

  it('纯文本单迭代：不产边界（终态迭代由流尾落盘兜底，避免重复写）', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([[{ content: '直接回答' }]]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks = await collect(loop, '你好');
    expect(chunks.filter((c) => c.type === 'step_boundary')).toHaveLength(0);
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });

  it('工具调用被策略屏蔽（终态 done）：不产边界，末条仍为 done', async () => {
    const toolExecutor = vi.fn();
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            content: '我来调用工具',
            toolCalls: [toolCall('c1', 'read_file', '{"path":"a.ts"}')],
          },
        ],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    loop.setStrategy({ toolCallsBlocked: true });

    const chunks = await collect(loop, '读取文件');
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(chunks.filter((c) => c.type === 'step_boundary')).toHaveLength(0);
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });

  it('ask_user 挂起：不产边界，末条仍为 paused（宿主据 paused break，其后不得再有 chunk）', async () => {
    const onPendingQuestion = vi.fn();
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              toolCall(
                'c_ask',
                'ask_user',
                JSON.stringify({ question: '结尾想要什么基调？', options: ['欢快', '深沉'] }),
              ),
            ],
          },
        ],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      onPendingQuestion,
    });

    const chunks = await collect(loop, '写个故事');
    expect(onPendingQuestion).toHaveBeenCalledTimes(1);
    expect(chunks.filter((c) => c.type === 'step_boundary')).toHaveLength(0);
    // 挂起 = 迭代未完成，且「终态 chunk 是末条」是宿主 break 的前提
    expect(chunks[chunks.length - 1]!.type).toBe('paused');
  });

  it('★ 顺序契约：同迭代内 plan_item_boundary 先于 step_boundary（落盘快照必含折叠边界）', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [toolCall('c1', 'tool_a')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
    });
    // 注入 A 任务项元信息（有任务表场景）→ 本迭代应产 plan_item_boundary
    loop.getActivePlanItemMeta = () => ({ planItemId: 'plan-item-1', title: '第一步' });

    const chunks = await collect(loop, '带任务表');
    const stepIdx = chunks.findIndex((c) => c.type === 'plan_item_boundary');
    const iterIdx = chunks.findIndex((c) => c.type === 'step_boundary');
    expect(stepIdx).toBeGreaterThanOrEqual(0);
    expect(iterIdx).toBeGreaterThanOrEqual(0);
    // 反序 → 宿主本次落盘快照缺该步折叠边界 → 崩溃重放分组错位
    expect(stepIdx).toBeLessThan(iterIdx);
  });

  it('瞬态契约：边界不进 messages（不是正文、不是工具结果）', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [toolCall('c1', 'tool_a')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
    });

    await collect(loop, '瞬态检查');
    // 消息序列 = system + user + assistant(tool_calls) + tool + assistant(收尾)，无边界残留
    for (const m of loop.getMessages()) {
      expect(m.content ?? '').not.toContain('step_boundary');
    }
  });
});
