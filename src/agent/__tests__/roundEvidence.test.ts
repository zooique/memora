/**
 * 裁决证据写点（悬案取证轨）单元测试
 *
 * 背景：带伤悬案「ADR-031 过度拦截 / 规避行为红旗 / 会议空响应」的裁决需要个案证据——
 * 计数器判不了意图、不落盘重启即失忆。本文件锁 loop 两个写点 + 会议轮操作化判据：
 * 1. **空响应写点**：LLM 200 但无文本无工具调用 → 产 empty_response 证据（含轮内迭代位）。
 * 2. **回显写点**：read_file 台账替身回显命中 → 产 ledger_stub_echo 证据（含 path/覆盖区间/请求区间）。
 * 3. **会议轮判据**（操作化单点 isMeetingRound）：任务表 active 任务项声明 rolePack 才算会议轮。
 *
 * 突变验证：写点处的 appendRoundEvidence 回调被摘除 → 本文件三条全部变红（证据归零）。
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { RoundEvidenceEvent } from '@/memory/roundStore.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

type ChunkItem = {
  content?: string;
  toolCalls?: Message['toolCalls'];
  thought?: string;
  finishReason?: string;
};

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

/** 构造工具调用（镜像 stepBoundary 先例） */
function toolCall(
  id: string,
  name: string,
  args = '{}',
): NonNullable<Message['toolCalls']>[number] {
  return { id, type: 'function', function: { name, arguments: args } };
}

/** 跑一轮输入并收集 chunk（镜像 stepBoundary 先例） */
async function collect(loop: AgentLoop, input: string): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of loop.processUserInput(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('AgentLoop · 裁决证据写点', () => {
  it('空响应兜底：产 empty_response 证据（含轮内迭代位 + 诊断三字段；无任务表 → 非会议轮）', async () => {
    // 收集的证据 = appendRoundEvidence 钩子收到的全部事件
    const collected: RoundEvidenceEvent[] = [];
    const loop = new AgentLoop({
      // 首轮即空响应（无文本、无工具调用），provider 恒空 → 每次 chat 尝试都空
      provider: mockMultiTurnProvider([[]]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
      // 分型文案覆盖：瞬态型断言可确定性区分（默认英文不影响判定，此处只为观察分型选择）
      messages: {
        emptyResponseFallback: '瞬态兜底文案',
        emptyResponseFallbackTruncated: (n: number) => `截断兜底文案-${n}`,
      },
    });
    loop.appendRoundEvidence = (ev) => collected.push(ev);

    const chunks = await collect(loop, '问题');

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'empty_response',
      meetingRound: false,
      // 诊断三字段：瞬态型口径——无 thinking、无 finishReason、3 次尝试（首试 + 2 重试）
      payload: { iteration: 1, thinkingChars: 0, attempts: 3 },
    });
    // finishReason 缺省 = 服务端/中转未回传 → 按瞬态型降级裁决（payload 为判别联合，按 type 收窄后取）
    const first = collected[0];
    const payload = first?.type === 'empty_response' ? first.payload : undefined;
    expect(payload?.finishReason).toBeUndefined();
    // 文案分型：瞬态型走现有兜底文案（非截断文案）
    expect(chunks.some((c) => c.type === 'text' && c.content === '瞬态兜底文案')).toBe(true);
  });

  it('截断型空响应：finishReason=length + thinking 体量入证据，文案走截断分型（末次尝试口径）', async () => {
    const collected: RoundEvidenceEvent[] = [];
    const loop = new AgentLoop({
      // 每次尝试思考体量不同（3/5/7 字符）：thinkingChars 应取末次 7（重试重置非累计）；
      // 末次 finishReason='length'（思考吃满输出预算）+ 无正文 → 截断型
      provider: mockMultiTurnProvider([
        [{ thought: 'abc' }],
        [{ thought: 'abcde' }],
        [{ thought: 'abcdefg', finishReason: 'length' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
      messages: {
        emptyResponseFallback: '瞬态兜底文案',
        emptyResponseFallbackTruncated: (n: number) => `截断兜底文案-${n}`,
      },
    });
    loop.appendRoundEvidence = (ev) => collected.push(ev);

    const chunks = await collect(loop, '问题');

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      type: 'empty_response',
      meetingRound: false,
      // finishReason='length' 判截断型；thinkingChars=7 末次口径（非 3+5+7=15 累计）
      payload: { iteration: 1, finishReason: 'length', thinkingChars: 7, attempts: 3 },
    });
    // 文案分型：截断型文案带尝试次数（可指导动作：调大输出上限）
    expect(chunks.some((c) => c.type === 'text' && c.content === '截断兜底文案-3')).toBe(true);
    // 分型互斥：截断型不走瞬态文案
    expect(chunks.some((c) => c.type === 'text' && c.content === '瞬态兜底文案')).toBe(false);
  });

  it('会议轮判据：active 任务项声明 rolePack → meetingRound=true（操作化单点）', async () => {
    const collected: RoundEvidenceEvent[] = [];
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([[]]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('ok'),
    });
    loop.appendRoundEvidence = (ev) => collected.push(ev);
    // 会议轮数据源：任务表 active 任务项带 rolePack（= 会议逐步切换生效中）
    loop.getActivePlanItemMeta = () => ({ planItemId: 's1', title: '调研', rolePack: 'pack-a' });

    await collect(loop, '会议问题');

    expect(collected).toHaveLength(1);
    expect(collected[0]?.meetingRound).toBe(true);
  });

  it('台账替身回显：二次整读被摘要顶替 → 产 ledger_stub_echo 证据（path/覆盖区间/请求区间齐备）', async () => {
    const collected: RoundEvidenceEvent[] = [];
    // 工具返回整读无脚注文本（3 行）→ 台账记覆盖 1-3/3
    const toolExecutor = vi.fn().mockResolvedValue('line1\nline2\nline3');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [toolCall('c1', 'read_file', '{"path":"docs/a.md","limit":100}')] }],
        [{ toolCalls: [toolCall('c2', 'read_file', '{"path":"docs/a.md"}')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    loop.appendRoundEvidence = (ev) => collected.push(ev);

    await collect(loop, '读文件');

    // 第一次真实执行（建覆盖），第二次无 limit 整读被替身回显（有覆盖即冗余）
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    const echoes = collected.filter((e) => e.type === 'ledger_stub_echo');
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({
      meetingRound: false,
      payload: {
        path: 'docs/a.md',
        coverage: { coverStart: 1, coverEnd: 3, totalLines: 3 },
        request: {},
      },
    });
  });
});
