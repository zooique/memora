/**
 * SCRIPT-2 · 工具结果 status 字段化 —— **双轨一致性守卫**
 *
 * ## 为什么这个文件独立存在
 *
 * 双轨期并存两条成文判定：
 *   ① 既有文本判据 `ok = !blocked && !isToolFailure(result)`
 *   ② 新增结构化判据 `ToolOutcome.status`
 *
 * 二者若在某条路径上分叉，`toolFailureCount` 就会**同时混用两套口径且无人知晓** ——
 * 这比不做 status 化更糟（status 化的卖点就是消灭口径分裂，分裂即证伪）。
 * `loop._crossCheckOutcome` 在每条工具结果后立即比对；本文件是它的**行为证据**。
 *
 * ## 覆盖的映射
 *
 * | 情形 | status 来源 | 既有判定 |
 * |:--|:--|:--|
 * | 正常成功 | 执行层（ToolRunner） | `ok=true` |
 * | 执行失败 | 执行层 | `ok=false, blocked=false` |
 * | 执行层闸门拒绝 / 幂等跳过 | 执行层报 blocked | `ok=false`（已知口径分歧） |
 * | loop 护栏拦截 | loop 拦截点补写（B2-b，blocked 同向一致） | `ok=false, blocked=true` |
 * | loop 内自执行旁路（compress / remember） | `_bypassOutcomeOf` 派生（B2-b） | 拒绝形 `ok=true`（已知口径分歧） |
 *
 * B2-b 起全部路径都有 outcome 上报 ⇒ `toolOutcomeUnreportedCount` 归零
 * （该观测集保留作「未来新增路径漏报」的哨兵，非僵尸容器）。
 *
 * ## 变异靶标（已实证红→绿，勿改坏）
 *
 * · 执行层恒报 `ok` ⇒ 本文件 2 条 + loop.test 8 条转红
 *   （错误信息含 toolCallId + 两 status + text 开头）
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

/** Provider 每轮的产出项（loop.test.ts 同款：不是 Message 本身，是「本轮说什么」的形状） */
type ChunkItem = {
  content?: string;
  toolCalls?: Message['toolCalls'];
  finishReason?: string;
  thought?: string;
};

/** 工具调用元素（loop.test.ts 同款构造，刻意不共享导出——夹具自持有更稳） */
const call = (id: string, name: string, args: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

/** 逐轮返回预设 chunk 序列的 Provider（loop.test.ts 同款） */
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

/** 跑一轮，收集 chunk 流 */
async function runOnce(loop: AgentLoop, input: string): Promise<AgentChunk[]> {
  const chunks: AgentChunk[] = [];
  for await (const chunk of loop.processUserInput(input)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('SCRIPT-2 · status 与既有 ok 判据的一致性（P1 期双轨守卫）', () => {
  it('成功路径：正常输出 → status=ok 侧与既有 ok=true 同侧（不抛错即通过）', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('文件正文');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [call('c1', 'read_file', '{"path":"docs/a.md"}')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    // 不抛错 = 核对通过。若 status 接线断掉或恒报失败，本用例会抛。
    const chunks = await runOnce(loop, '读一下');
    const results = chunks.filter((c) => c.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });

  it('失败路径：`[ERR:…` 失败串 → status=failed 侧与既有 ok=false 同侧', async () => {
    // 覆盖两种失败前缀形态：内核结构化错误族 + 执行三态族
    for (const text of [
      '[ERR:TOOL:FILE_NOT_FOUND] 文件不存在',
      '[COMMAND_ERROR] 命令执行失败（退出码: 1）\nstdout:\nstderr: boom',
    ]) {
      const toolExecutor = vi.fn().mockResolvedValue(text);
      const loop = new AgentLoop({
        provider: mockMultiTurnProvider([
          [{ toolCalls: [call('c1', 'read_file', '{"path":"missing.md"}')] }],
          [{ content: '完成' }],
        ]),
        bootstrapMemories: [],
        toolExecutor,
      });
      const chunks = await runOnce(loop, '读一个不存在的文件');
      const results = chunks.filter((c) => c.type === 'tool_result');
      expect(results).toHaveLength(1);
      // 既有判据：判失败
      expect(results[0]!.ok).toBe(false);
      // 核对未抛错 ⇒ status 侧同判 failed（不一致会抛）
    }
  });

  it('★ blocked 路径：loop 护栏拦截 → B2-b 拦截点补写 outcome，unreported 归零', async () => {
    // 两次同 path 读取 → 第二次命中 read_dedup 护栏，**工具根本没进 ToolRunner**。
    // B2-b 在编排层结果循环补写 blockedOutcome（read_dedup），与编排层 blocked 同向一致。
    const toolExecutor = vi.fn().mockResolvedValue('文件正文');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [call('c1', 'read_file', '{"path":"docs/a.md"}')] }],
        [{ toolCalls: [call('c2', 'read_file', '{"path":"docs/a.md"}')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });
    const chunks = await runOnce(loop, '重复读');
    const reads = chunks.filter(
      (c): c is Extract<AgentChunk, { type: 'tool_result' }> =>
        c.type === 'tool_result' && c.name === 'read_file',
    );
    expect(reads).toHaveLength(2);
    const blockedOne = reads[1]!;
    expect(blockedOne.blocked).toBe(true);
    expect(blockedOne.ok).toBe(false);
    // B2-b：护栏点已补报 outcome ⇒ unreported 归零（非 0 即拦截点补报断线，哨兵立即报警）
    expect(loop.getMetrics().tools.toolOutcomeUnreportedCount).toBe(0);
    expect(toolExecutor).toHaveBeenCalledTimes(1); // 第二次压根没进执行层
  });

  it('失败串前缀变体：判据与既有 ok 判定不得分叉（扫生产代码常见失败前缀）', async () => {
    // 逐个喂常见失败串，既有判据判失败时核对必须一致。
    // 这条锁的是「接线对所有失败前缀都成立」，而非只对某一个成立。
    const failureTexts = [
      '[ERR:TOOL:PERMISSION_DENIED] 权限不足',
      '[ERR:TOOL:ABORTED] 错误：工具执行被中断',
      '[SCRIPT_ERROR] 脚本执行失败（退出码: 9009）',
      '[CODE_TIMEOUT] 代码执行超时（超过 30s）',
    ];
    for (const text of failureTexts) {
      const toolExecutor = vi.fn().mockResolvedValue(text);
      const loop = new AgentLoop({
        provider: mockMultiTurnProvider([
          [{ toolCalls: [call('c1', 'read_file', '{"path":"x.md"}')] }],
          [{ content: '完成' }],
        ]),
        bootstrapMemories: [],
        toolExecutor,
      });
      const chunks = await runOnce(loop, '跑一下');
      const results = chunks.filter((c) => c.type === 'tool_result');
      expect(results[0]!.ok).toBe(false);
    }
  });

  it('★ 口径分歧登记：执行层报 blocked、编排层算 failed（不抛错 · P2/P3 待裁决）', async () => {
    // **本用例锁住一个已实测的真回归及其修法**（2026-10-06）：
    // 执行层闸门（宿主 denied / 只读拒绝 / outbox 幂等跳过）报 status='blocked'
    // （语义：主动挡下的），而既有编排层把这些一律算 ok=false（⇒ 进 metrics 失败计数）。
    // 双轨核对若在此抛错 → **工具流被掐断**（实测 uninterruptedWorkflow 三态 5 条
    // `results` 变空）；若改判据让二者一致 = 为让核对通过而造伤。
    // ⇒ P1 期正确处置：**既不抛错也不改判据**，如实登记为待裁决分歧。
    // 本例断言「流程能走完」+「结果仍是既有行为（ok=false）」= P1 期**行为零变更**。
    const toolExecutor = vi.fn().mockResolvedValue('不应被调用');
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [call('c1', 'read_file', '{"path":"probe.txt"}')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      // 宿主拒绝闸门 = 执行层 denied 路径（报 blocked，编排层算 failed）
      preExecutionCheck: () => ({ denied: true, skip: false, reason: '策略拒绝' }),
    });
    const chunks = await runOnce(loop, '读文件');
    const results = chunks.filter((c) => c.type === 'tool_result');
    // 流程未被中断（这是修法的核心：抛错会掐断流）
    expect(results).toHaveLength(1);
    // 既有行为保持不变：ok=false（未擅自改成 blocked 语义）
    expect(results[0]!.ok).toBe(false);
    // 工具确实没执行
    expect(toolExecutor).not.toHaveBeenCalled();
    // ⭐ 观测必须**可读出口**（否则两个 Set 是僵尸容器、注释里的「施工清单由此读出」是撒谎）：
    // 口径分歧计数必须落到 metrics 上（字段在 `tools` 子对象下 —— tsc 抓过这个错）。
    const m = loop.getMetrics();
    expect(m.tools.toolBlockedDisagreementCount).toBeGreaterThan(0);
  });

  it('★ B2-b 旁路补报：compress_context 无目标 → unreported 归零，拒绝形落已知分歧族', async () => {
    // `compress_context` 由 loop 内自执行、**不经 ToolRunner** ⇒ B2-b 前每次落 unreported
    // （该计数曾是 P2 施工清单的读出口）。B2-b 起编排层按分支形态补报：
    // 无目标 = 主动拒绝 → blocked(no_compress_target)；旧口径判 ok ⇒ 落已知分歧族（B4 裁决）。
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [call('c1', 'compress_context', '{"target":"old"}')] }],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('不应被调用'),
    });
    const chunks = await runOnce(loop, '压缩上下文');
    // 走完了流程（不抛错）
    expect(chunks.length).toBeGreaterThan(0);
    // 旁路已补报 ⇒ unreported 归零（哨兵：非 0 即旁路补报断线）
    expect(loop.getMetrics().tools.toolOutcomeUnreportedCount).toBe(0);
    // 拒绝形（编排算 ok / 上报 blocked）如实登记为已知分歧，不静默
    expect(loop.getMetrics().tools.toolBlockedDisagreementCount).toBeGreaterThan(0);
  });

  it('★ B2-b 旁路补报：remember_intel 非法 note → unreported 归零，拒绝形落已知分歧族', async () => {
    // note 缺失 → handleRememberIntel 返回「未写入」文案 = 主动拒绝写入
    // → blocked(invalid_intel_note)；旧口径判 ok ⇒ 落已知分歧族（B4 裁决）。
    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{ toolCalls: [call('x', 'remember_intel', '{}')] }],
        [{ content: '整合完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('不应被调用'),
    });
    const chunks = await runOnce(loop, '收集情报');
    expect(chunks.length).toBeGreaterThan(0);
    expect(loop.getMetrics().tools.toolOutcomeUnreportedCount).toBe(0);
    expect(loop.getMetrics().tools.toolBlockedDisagreementCount).toBeGreaterThan(0);
  });

  it('★ B2-b 旁路补报：compress_context 成功形 → ok 镜像一致，零分歧', async () => {
    // 成功生成临时摘要 → _bypassOutcomeOf 报 ok；旧口径也判 ok ⇒ 同向一致，不落分歧。
    // 锁「拒绝形落分歧、成功形零分歧」的分野，防分歧计数虚高。
    const provider = mockMultiTurnProvider([
      [{ content: '第一轮回答' }], // turn0：首轮纯文本（建立可压缩历史）
      [
        {
          toolCalls: [call('c1', 'compress_context', '{"target":"earliest_round"}')],
        },
      ], // turn1：触发压缩
      [{ content: '临时摘要：首轮干的事' }], // turn2：压缩摘要
      [{ content: '第二轮回答' }], // turn3：续答
    ]);
    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    for await (const {} of loop.processUserInput('第一个任务')) {
      // drain：建立历史
    }
    for await (const {} of loop.processUserInput('当前任务')) {
      // drain：触发压缩
    }
    const m = loop.getMetrics();
    expect(m.tools.toolOutcomeUnreportedCount).toBe(0);
    expect(m.tools.toolBlockedDisagreementCount).toBe(0);
  });
});
