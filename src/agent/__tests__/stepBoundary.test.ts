/**
 * 迭代边界信号 `step_boundary`（迭代原子落盘）
 *
 * 背景（见 docs/architecture/step-atomic-persistence.md §九）：若把宿主增量落盘挂在
 * `plan_item_boundary` 上，而该 chunk 只在「有任务表且任务项推进」时产出 → 无任务表的长工具循环
 * **零增量落盘**，崩溃即全丢。本 chunk 补该覆盖缺口：只要迭代完成且将继续下一轮，就产一条，
 * 与有无任务表无关。
 *
 * 本文件锁五条不变量：
 * 1. **产出条件** = `handleToolCalls` 返回 'continue'（还有下一轮）——终态迭代不产（流尾兜底），
 *    这同时保住「终态 chunk 是末条」的既有流契约（宿主 paused 分支据 break）。
 * 2. **顺序契约** = 同迭代内 `plan_item_boundary` 先于 `step_boundary`——保证宿主落盘快照
 *    已含该步折叠边界，崩溃重放不错位。
 * 3. **瞬态** = 不进正文/不进 messages（只是落盘触发信号）。
 * 4. **边界不劈思考（STEP-BUCKET-1 前提）** = `plan_item_boundary` 只落 step 之间，不得插入
 *    同一 step 的 thought 流中间——webview 桶查找按任务项容器作用域（`data-step-bucket` 查询
 *    限容器内），thought 流若被边界劈成两段，两个容器会各建一个同 key 桶 →「思考 · 第 N 步」重影。
 * 5. **打断物不劈工具段（TOOL-RUN-1 前提）** = 同一 step 的工具事件段（tool_start → 末个
 *    tool_result）内不得夹打断物（`narrate` / `plan_item_boundary` / 正文）——webview 批分组
 *    按「相邻 + 无打断物」切段（docs/方案-工具批折叠合并-20260925.md §3.1），工具段若被劈开，
 *    一个 step 的工具会碎成多批。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

type ChunkItem = { content?: string; thought?: string; toolCalls?: Message['toolCalls'] };

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
    const planItemIdx = chunks.findIndex((c) => c.type === 'plan_item_boundary');
    const iterIdx = chunks.findIndex((c) => c.type === 'step_boundary');
    expect(planItemIdx).toBeGreaterThanOrEqual(0);
    expect(iterIdx).toBeGreaterThanOrEqual(0);
    // 反序 → 宿主本次落盘快照缺该步折叠边界 → 崩溃重放分组错位
    expect(planItemIdx).toBeLessThan(iterIdx);
  });

  it('★ 任务项边界产出时机（方案-任务项边界产出时机前移-20260926）：边界早于本迭代的思考与工具', async () => {
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ thought: 's1-想', toolCalls: [toolCall('c1', 'tool_a')] } as ChunkItem],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
    });
    // 有任务表场景（active 任务项恒定）：首个迭代即应拿到边界
    loop.getActivePlanItemMeta = () => ({ planItemId: 'plan-item-1', title: '任务项一' });

    const chunks = await collect(loop, '带任务表');

    const boundaryIdx = chunks.findIndex((c) => c.type === 'plan_item_boundary');
    const firstThought = chunks.findIndex((c) => c.type === 'thought');
    const firstToolStart = chunks.findIndex((c) => c.type === 'tool_start');
    // 场景自证（防假绿）：三类 chunk 都真产出了
    expect(boundaryIdx).toBeGreaterThanOrEqual(0);
    expect(firstThought).toBeGreaterThanOrEqual(0);
    expect(firstToolStart).toBeGreaterThanOrEqual(0);
    // 边界语义 = 「以下内容属于该任务项」→ 必须早于它所罩住的思考与工具。
    // 晚于则宿主「向前找边界」的判据必然落空 → 首个迭代的思考/工具掉出任务项折叠块。
    expect(
      boundaryIdx,
      'plan_item_boundary 晚于本迭代思考：宿主向前找边界落空，内容掉出折叠块',
    ).toBeLessThan(firstThought);
    expect(
      boundaryIdx,
      'plan_item_boundary 晚于本迭代工具：宿主向前找边界落空，内容掉出折叠块',
    ).toBeLessThan(firstToolStart);
  });

  it('★ STEP-BUCKET-1 前提固化：plan_item_boundary 不劈同一 step 的 thought 流（桶 key 不重影）', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // step 1：两段思考碎片 + 工具调用（碎片相邻成组是前提的直接观测对象）
        [{ thought: 's1-想A' }, { thought: 's1-想B' }, { toolCalls: [toolCall('c1', 'tool_a')] }],
        // step 2：两段思考碎片 + 工具调用（active 任务项推进 → 本迭代开始应产 plan_item_boundary）
        [{ thought: 's2-想A' }, { thought: 's2-想B' }, { toolCalls: [toolCall('c2', 'tool_b')] }],
        // step 3：纯文本收尾（active 任务项未再推进，不产新边界）
        [{ thought: 's3-想', content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    // 任务项逐步推进：两次工具迭代各取一次 meta，planItemId 变化 → 各产一条 plan_item_boundary
    const metaSeq = [
      { planItemId: 'plan-item-1', title: '任务项一' },
      { planItemId: 'plan-item-2', title: '任务项二' },
    ];
    let metaCall = 0; // meta 取用计数（多取不越界，停在末项）
    loop.getActivePlanItemMeta = () => metaSeq[Math.min(metaCall++, metaSeq.length - 1)]!;

    const chunks = await collect(loop, '带任务表多步思考');

    // 场景自证（防假绿）：边界真产出了、thought 真带归属了——否则下方断言空过不算守卫
    expect(chunks.filter((c) => c.type === 'plan_item_boundary').length).toBeGreaterThan(0);
    const thoughts = chunks.filter((c) => c.type === 'thought');
    expect(thoughts.length).toBeGreaterThanOrEqual(2);
    expect(thoughts.every((c) => c.type === 'thought' && c.stepIndex !== undefined)).toBe(true);

    // ★ 前提断言：每个 stepIndex 的 thought 位置区间内不得夹 plan_item_boundary。
    // 若被劈开 → webview 容器作用域查找会在两个任务项容器各建同 key 桶（「思考 · 第 N 步」重影）。
    const posByStep = new Map<number, number[]>(); // stepIndex → 该 step 各 thought 的 chunk 下标
    chunks.forEach((c, idx) => {
      if (c.type !== 'thought' || c.stepIndex === undefined) return;
      const positions = posByStep.get(c.stepIndex) ?? [];
      positions.push(idx);
      posByStep.set(c.stepIndex, positions);
    });
    for (const [stepIndex, positions] of posByStep) {
      const lo = Math.min(...positions); // 该 step 首个 thought 位置
      const hi = Math.max(...positions); // 该 step 末个 thought 位置
      const split = chunks.slice(lo, hi + 1).some((c) => c.type === 'plan_item_boundary');
      expect(split, `step ${stepIndex} 的 thought 流被 plan_item_boundary 打断（桶将重影）`).toBe(false);
    }
  });

  it('★ TOOL-RUN-1 前提固化：打断物不劈同一 step 的工具段（批不碎）', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // step 1：思考 + 并发双工具（工具段 = 同 step 的 tool_start/tool_result 连续区）
        [
          { thought: 's1-想' },
          {
            toolCalls: [
              toolCall('c1', 'tool_a', '{"path":"a"}'),
              toolCall('c2', 'tool_b', '{"path":"b"}'),
            ],
          },
        ],
        // step 2：思考 + 单工具（active 任务项推进 → 本迭代开始应产 plan_item_boundary 打断物）
        [{ thought: 's2-想' }, { toolCalls: [toolCall('c3', 'tool_a', '{"path":"c"}')] }],
        // step 3：纯文本收尾
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    // 任务项逐步推进 → 各产一条 plan_item_boundary（打断物真产出，防假绿）
    const metaSeq = [
      { planItemId: 'plan-item-1', title: '任务项一' },
      { planItemId: 'plan-item-2', title: '任务项二' },
    ];
    let metaCall = 0; // meta 取用计数（多取不越界，停在末项）
    loop.getActivePlanItemMeta = () => metaSeq[Math.min(metaCall++, metaSeq.length - 1)]!;

    const chunks = await collect(loop, '带任务表多步工具');

    // 场景自证（防假绿）：工具真产出且真打了归属标、打断物真在流里
    const toolEvents = chunks.filter((c) => c.type === 'tool_start' || c.type === 'tool_result');
    expect(toolEvents.length).toBeGreaterThanOrEqual(4);
    expect(chunks.filter((c) => c.type === 'plan_item_boundary').length).toBeGreaterThan(0);
    expect(
      chunks.filter((c) => c.type === 'tool_start').every((c) => c.type === 'tool_start' && c.stepIndex !== undefined),
    ).toBe(true);

    // tool_result 经 toolCallId 归属（事实单点、不重复盖章）→ 先建 id→step 映射再按 step 分段
    const callIndex = new Map<string, number>(); // toolCallId → 所属 step 轮内序号
    for (const c of chunks) {
      if (c.type === 'tool_start' && c.stepIndex !== undefined) callIndex.set(c.toolCallId, c.stepIndex);
    }
    const posByStep = new Map<number, number[]>(); // stepIndex → 该 step 各工具事件的 chunk 下标
    chunks.forEach((c, idx) => {
      if (c.type !== 'tool_start' && c.type !== 'tool_result') return;
      const owner = c.type === 'tool_start' ? c.stepIndex : callIndex.get(c.toolCallId);
      if (owner === undefined) return;
      const positions = posByStep.get(owner) ?? [];
      positions.push(idx);
      posByStep.set(owner, positions);
    });

    // ★ 前提断言：每个 step 的工具事件连续区（首尾之间）不得夹打断物。
    // 打断物（chunk 层，**保守取并集**）= narrate / plan_item_boundary / text——守护宿主切段判据
    // （chatView.ts `BATCH_SPLITTER_TYPES`）所依赖的前提「同 step 的工具事件本就连成一片」；
    // 若被劈开 → 同一 step 的工具会被碎成多批。
    // ⚠ 两层**非严格同构**：chunk 层 `text` 分 stage='answer'（主回答正文，走内容轨、宿主落盘
    // **不产**过程事件）与 stage='self_review'（→ 落盘 `text_self_review`）两档，此处保守全收；
    // 不得据此推论「宿主有正文打断物」——正文根本不在过程条目流里。
    const isSplitter = (c: AgentChunk): boolean =>
      c.type === 'narrate' || c.type === 'plan_item_boundary' || c.type === 'text';
    for (const [stepIndex, positions] of posByStep) {
      const lo = Math.min(...positions); // 该 step 首个工具事件位置
      const hi = Math.max(...positions); // 该 step 末个工具事件位置
      const split = chunks.slice(lo, hi + 1).some(isSplitter);
      expect(split, `step ${stepIndex} 的工具段被劈开（批分组将碎成多批）`).toBe(false);
    }
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
