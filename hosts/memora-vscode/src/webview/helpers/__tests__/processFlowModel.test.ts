/**
 * processFlowModel 纯模型层单测（CHATVIEW-SLIM-2 自 chatView.ts 外置后的覆盖）
 *
 * 行为级主路径已由 `__tests__/chatView.test.ts`（DOM 驱动）覆盖；本文件锁**纯函数边界**：
 * 工具行状态四档、终止裁决三分支、思考分桶的稳定键、计划项状态的事件序推导、
 * 证据解析的主配 / 回退双通道。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView } from '../../../shared/protocol.js';
import type { DelegateTerminal } from '../processFlowModel.js';
import {
  buildMemoryHitsEvidenceResolver,
  buildSearchEvidenceResolver,
  countToolFailures,
  decideTerminus,
  delegateRowUi,
  delegateTerminalUi,
  findRunningTool,
  groupThoughtBuckets,
  groupToolBatches,
  isToolFailureResult,
  planItemStatesFromEvents,
  stopReasonLabel,
  thoughtLabel,
  toolRowStatus,
} from '../processFlowModel.js';

const TS = '2026-10-29T10:00:00.000Z';

function event<T extends ProcessEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<ProcessEvent, { type: T }>['payload'],
  ts = TS,
): Extract<ProcessEvent, { type: T }> {
  return { type, seq, ts, payload } as Extract<ProcessEvent, { type: T }>;
}

const toolStart = (
  seq: number,
  id: string,
  name = 'read_file',
): Extract<ProcessEvent, { type: 'tool_start' }> =>
  event('tool_start', seq, { toolCallId: id, name, args: '{}' });
const toolResult = (
  seq: number,
  id: string,
  ok: boolean,
  blocked?: boolean,
): Extract<ProcessEvent, { type: 'tool_result' }> =>
  event('tool_result', seq, { toolCallId: id, name: 'read_file', ok, summary: 'r', blocked });
const boundary = (
  seq: number,
  planItemId?: string,
  ts = TS,
): Extract<ProcessEvent, { type: 'plan_item_boundary' }> =>
  event('plan_item_boundary', seq, { planItemId, title: 'T' }, ts);

describe('toolRowStatus（工具行状态四档）', () => {
  it('无结果 = 进行中（展开）', () => {
    expect(toolRowStatus(undefined)).toEqual({ label: 'Running', open: true, running: true });
  });

  it('成功 = 收起；失败 = 展开', () => {
    const ok = event('tool_result', 2, { toolCallId: 'a', name: 'x', ok: true });
    const bad = event('tool_result', 3, { toolCallId: 'a', name: 'x', ok: false });
    expect(toolRowStatus(ok)).toEqual({ label: 'Succeeded', open: false, running: false });
    expect(toolRowStatus(bad)).toEqual({ label: 'Failed', open: true, running: false });
  });

  it('blocked 优先于 ok（被拦不算成功也不算失败）', () => {
    const blocked = event('tool_result', 4, {
      toolCallId: 'a',
      name: 'x',
      ok: false,
      blocked: true,
    });
    expect(toolRowStatus(blocked)).toEqual({ label: 'Blocked', open: true, running: false });
  });
});

describe('delegate_task 四态映射与失败口径', () => {
  /** 构造一条带内核回执的 delegate tool_result（excerpt/两段耗时是内核给的既定数据） */
  const delegateResult = (
    terminal: DelegateTerminal,
  ): Extract<ProcessEvent, { type: 'tool_result' }> =>
    event('tool_result', 9, {
      toolCallId: 'd',
      name: 'delegate_task',
      ok: terminal === 'completed',
      summary: 'r',
      delegate: { terminal, excerpt: '结论', durationMs: 47_000, queuedMs: 12_000 },
    });

  it('四态文案、视觉档位与默认展开穷尽映射', () => {
    expect(delegateTerminalUi('completed')).toEqual({
      label: 'Subagent completed',
      tone: 'normal',
      open: false,
    });
    expect(delegateTerminalUi('incomplete')).toEqual({
      label: 'Subagent incomplete: the subagent did not produce a conclusion',
      tone: 'warning',
      open: true,
    });
    expect(delegateTerminalUi('interrupted')).toEqual({
      label: 'Subagent interrupted: the turn was stopped before the subagent finished',
      tone: 'muted',
      open: true,
    });
    expect(delegateTerminalUi('failed')).toEqual({
      label: 'Subagent failed',
      tone: 'error',
      open: true,
    });
  });

  it('无 delegate 字段的老数据 / 非 delegate 行 → undefined（回退两态，不补假徽标）', () => {
    expect(delegateRowUi(undefined)).toBeUndefined();
    expect(delegateRowUi(toolResult(2, 'a', false))).toBeUndefined();
    expect(delegateRowUi(delegateResult('incomplete'))?.tone).toBe('warning');
  });

  it('失败口径：只有 failed 计失败，incomplete / interrupted 不算', () => {
    expect(isToolFailureResult(delegateResult('failed').payload)).toBe(true);
    expect(isToolFailureResult(delegateResult('interrupted').payload)).toBe(false);
    expect(isToolFailureResult(delegateResult('incomplete').payload)).toBe(false);
    expect(isToolFailureResult(delegateResult('completed').payload)).toBe(false);
    // 普通工具保持原口径（!ok 且非 blocked）
    expect(isToolFailureResult(toolResult(3, 'b', false).payload)).toBe(true);
    expect(isToolFailureResult(toolResult(4, 'c', true).payload)).toBe(false);
  });

  it('轮指标只数 failed：用户自己按停止不再被算成一次失败', () => {
    const events: ProcessEvent[] = [
      delegateResult('interrupted'),
      delegateResult('incomplete'),
      delegateResult('failed'),
      toolResult(5, 'x', false),
    ];
    expect(countToolFailures(events)).toBe(2);
  });
});

describe('delegate_task 文案键完整性（l10n 成对）', () => {
  it('四条状态键 + 两段/元信息键在两份 bundle 中都存在，且 zh-cn 值非空', () => {
    /** 从测试文件回溯到宿主 l10n 目录（helpers/__tests__ → webview → src → 宿主根） */
    const l10nDir = fileURLToPath(new URL('../../../../l10n/', import.meta.url));
    const en = JSON.parse(readFileSync(`${l10nDir}bundle.l10n.json`, 'utf8')) as Record<
      string,
      string
    >;
    const zh = JSON.parse(readFileSync(`${l10nDir}bundle.l10n.zh-cn.json`, 'utf8')) as Record<
      string,
      string
    >;
    const keys = [
      'Subagent completed',
      'Subagent incomplete: the subagent did not produce a conclusion',
      'Subagent interrupted: the turn was stopped before the subagent finished',
      'Subagent failed',
      'Dispatch',
      'Receipt',
      'Capabilities: {0}',
      'none',
      'Queued {0} · Executed {1}',
      'Truncated',
      '[{0}]',
    ];
    for (const key of keys) {
      expect(en, `en bundle missing: ${key}`).toHaveProperty(key);
      expect(typeof zh[key], `zh bundle missing: ${key}`).toBe('string');
      expect(zh[key].length, `zh bundle empty: ${key}`).toBeGreaterThan(0);
    }
  });
});

describe('stopReasonLabel / decideTerminus', () => {
  it('stopReason 命中映射，未命中回落 reason 原文', () => {
    expect(stopReasonLabel({ reason: 'r', stopReason: 'user' })).toBe(
      'User stopped the conversation',
    );
    expect(stopReasonLabel({ reason: 'r', stopReason: 'timeout' })).toBe(
      'The conversation timed out, please try again later',
    );
    expect(stopReasonLabel({ reason: '原始原因' })).toBe('原始原因');
  });

  it('error 事件 = 异常中断（原因取友好文案）', () => {
    const v = decideTerminus([event('error', 1, { message: 'boom' })]);
    expect(v.kind).toBe('error-interrupted');
    expect(v.reason.length).toBeGreaterThan(0);
  });

  it('aborted + stopReason=user = 用户中断；其余 stopReason = 异常中断', () => {
    expect(decideTerminus([event('aborted', 1, { reason: 'x', stopReason: 'user' })]).kind).toBe(
      'user-interrupted',
    );
    expect(decideTerminus([event('aborted', 2, { reason: 'x', stopReason: 'timeout' })]).kind).toBe(
      'error-interrupted',
    );
  });

  it('无 error / aborted = 用户中断（TERMINUS-SSOT-1 改判：interrupted 收场唯一来源 = handleStop 用户停 + 打捞轮「等同用户停」定案；旧 null 不猜终态令底栏无标签，已退役）', () => {
    const v = decideTerminus([toolStart(1, 'a')]);
    expect(v.kind).toBe('user-interrupted');
    // TERM-REASON-1 收口（2026-10-29）沿革保持：兜底案语义键放法定口袋 stopReason ⇒ 查得译文。
    expect(v.reason).toBe('The conversation was interrupted');
  });
});

describe('findRunningTool（未配对的最后一个 tool_start）', () => {
  it('返回最新一个无 result 的 start；全部配对则 null', () => {
    expect(
      findRunningTool([toolStart(1, 'a'), toolResult(2, 'a', true), toolStart(3, 'b')])?.payload
        .toolCallId,
    ).toBe('b');
    expect(findRunningTool([toolStart(1, 'a'), toolResult(2, 'a', true)])).toBeNull();
  });
});

describe('groupThoughtBuckets / thoughtLabel', () => {
  it('按 stepIndex 分桶，键缺省为 root，桶按 anchorSeq 排序', () => {
    const buckets = groupThoughtBuckets([
      event('thought', 1, { content: '无步' }),
      event('thought', 2, { content: '一', stepIndex: 1 }),
      event('thought', 3, { content: '一续', stepIndex: 1 }),
    ]);
    expect(buckets.map((b) => b.key)).toEqual(['root', '1']);
    expect(buckets[1]!.items.map((i) => i.content)).toEqual(['一', '一续']);
  });

  it('标签仅有 / 无步号两形态', () => {
    expect(thoughtLabel(2)).toBe('Thinking · step 2');
    expect(thoughtLabel(undefined)).toBe('Thinking');
  });
});

describe('planItemStatesFromEvents（计划项状态推导）', () => {
  it('快照之后出现的边界项置 active，快照内状态保留', () => {
    const states = planItemStatesFromEvents([
      event('plan_snapshot', 1, { items: [{ planItemId: 'p1', status: 'done' }] }),
      boundary(2, 'p2'),
    ]);
    expect(states.get('p1')).toBe('done');
    expect(states.get('p2')).toBe('active');
  });

  it('无快照时取最后一个边界项为 active', () => {
    const states = planItemStatesFromEvents([boundary(1, 'p1'), boundary(2, 'p2')]);
    expect([...states.entries()]).toEqual([['p2', 'active']]);
  });
});

// narrateChainText 的用例已随实现迁移到 `shared/__tests__/narrateText.test.ts`
// （该投影与宿主崩溃打捞共用一份实现，单点在哪就测在哪，不在这里留替身）

describe('buildMemoryHitsEvidenceResolver（按 toolCallId 归组）', () => {
  it('同调用内按记忆 id 去重；无 toolCallId 的证据丢弃', () => {
    const evidence = [
      {
        type: 'memory_hits',
        payload: {
          toolCallId: 'c1',
          hits: [
            { id: 'm1', name: 'n', source: 's' },
            { id: 'm1', name: 'n', source: 's' },
          ],
        },
      },
      { type: 'memory_hits', payload: { hits: [{ id: 'm2', name: 'n', source: 's' }] } },
    ] as unknown as RoundView['evidence'];
    const map = buildMemoryHitsEvidenceResolver(evidence);
    expect(map.get('c1')?.size).toBe(1);
    expect(map.size).toBe(1);
  });
});

describe('buildSearchEvidenceResolver（主配 ID / 回退 query 游标）', () => {
  const hit = (query: string, toolCallId?: string) =>
    ({
      type: 'web_search_result',
      payload: { query, count: 1, titles: ['t'], toolCallId },
    }) as unknown as NonNullable<RoundView['evidence']>[number];

  it('无 toolCallId 的旧证据按 query + 行序消费', () => {
    const resolve = buildSearchEvidenceResolver([hit('q1'), hit('q1')]);
    const start = (id: string, args: string) =>
      event('tool_start', 1, { toolCallId: id, name: 'web_search', args });
    expect(resolve(start('a', '{"query":"q1"}'))).toBeDefined();
    expect(resolve(start('b', '{"query":"q1"}'))).toBeDefined();
    expect(resolve(start('c', '{"query":"q1"}'))).toBeUndefined();
  });

  it('带 ID 的证据优先直取，不受消费顺序影响；非 web_search 不返回', () => {
    const resolve = buildSearchEvidenceResolver([hit('q1', 'c1')]);
    const start = (name: string, id: string) =>
      event('tool_start', 1, { toolCallId: id, name, args: '{"query":"q1"}' });
    expect(resolve(start('web_search', 'c1'))).toBeDefined();
    expect(resolve(start('web_search', 'c2'))).toBeUndefined();
    expect(resolve(start('read_file', 'c1'))).toBeUndefined();
  });
});

describe('groupToolBatches（工具批切段判据真源）', () => {
  const TS2 = '2026-10-29T10:00:10.000Z';
  const TS3 = '2026-10-29T10:00:05.000Z';
  const start = (
    seq: number,
    id: string,
    stepIndex?: number,
    ts = TS,
  ): Extract<ProcessEvent, { type: 'tool_start' }> =>
    event('tool_start', seq, { toolCallId: id, name: 'read_file', args: '{}', stepIndex }, ts);
  const thought = (seq: number, stepIndex?: number): Extract<ProcessEvent, { type: 'thought' }> =>
    event('thought', seq, { content: '想', stepIndex });
  const narrate = (seq: number): Extract<ProcessEvent, { type: 'narrate' }> =>
    event('narrate', seq, { content: '叙述' });

  it('相邻工具（同 step、无打断物）并一批，segId = 首个 tool_start 的 seq', () => {
    const batches = groupToolBatches([start(1, 'a', 0), start(2, 'b', 0)], []);
    expect(batches).toHaveLength(1);
    expect(batches[0].segId).toBe(1);
    expect(batches[0].entries.map((e) => e.start.payload.toolCallId)).toEqual(['a', 'b']);
  });

  it('打断物（narrate）断段：两侧工具各自成批', () => {
    const batches = groupToolBatches([start(1, 'a'), narrate(2), start(3, 'b')], []);
    expect(batches.map((b) => b.entries.length)).toEqual([1, 1]);
  });

  it('思考换 step 断段；同 step 的思考碎片不断段', () => {
    const same = groupToolBatches([start(1, 'a', 0), thought(2, 0), start(3, 'b', 0)], []);
    expect(same).toHaveLength(1);
    const changed = groupToolBatches([start(1, 'a', 0), thought(2, 1), start(3, 'b', 1)], []);
    expect(changed).toHaveLength(2);
  });

  it('两侧 stepIndex 缺省（旧数据）→ 回落相邻性，不断段', () => {
    expect(groupToolBatches([start(1, 'a'), thought(2, 1), start(3, 'b')], [])).toHaveLength(1);
  });

  it('跨问答卡断段：边界桶号随 ts 变化即断', () => {
    // 边界 ts 落在两条工具之间（判据 = b < ts 的边界数）：第一条桶 0、第二条桶 1 ⇒ 断段
    const batches = groupToolBatches([start(1, 'a', 0, TS), start(2, 'b', 0, TS2)], [TS3]);
    expect(batches).toHaveLength(2);
    const noBoundary = groupToolBatches([start(1, 'a', 0, TS), start(2, 'b', 0, TS2)], []);
    expect(noBoundary).toHaveLength(1);
  });

  it('tool_result 按 toolCallId 配对归属其 start（结果晚于打断物到达仍归位）', () => {
    const batches = groupToolBatches(
      [start(1, 'a'), narrate(2), toolResult(3, 'a', true), start(4, 'b')],
      [],
    );
    expect(batches).toHaveLength(2);
    expect(batches[0].entries[0].result?.payload.ok).toBe(true);
    expect(batches[1].entries[0].result).toBeUndefined();
  });

  it('空流返回空数组', () => {
    expect(groupToolBatches([], [])).toEqual([]);
  });
});
