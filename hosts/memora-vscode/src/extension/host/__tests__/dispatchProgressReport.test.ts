/**
 * 派活进度报告单测（B）
 *
 * 覆盖四态措辞、开场白跳过、排序、上限、读不到原文的降级、零记录时的账本边界说明，
 * 以及参数封闭校验。全部是纯函数，不读盘、不看真实时钟。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Round } from '@zooique/memora';
import type { DispatchLedgerRecord } from '../dispatchLedger.js';
import {
  buildDispatchLedgerTurnContext,
  buildDispatchProgressReport,
  DISPATCH_PROGRESS_EXCERPT_CHARS,
  extractSubstantiveExcerpt,
  parseDispatchProgressArgs,
} from '../dispatchProgressReport.js';

/** 造一条账本记录（只填测试关心的字段） */
function record(partial: Partial<DispatchLedgerRecord> = {}): DispatchLedgerRecord {
  return {
    id: partial.id ?? 'rec-1',
    kind: partial.kind ?? 'send',
    callerSessionId: partial.callerSessionId ?? 'caller',
    targetSessionId: partial.targetSessionId ?? 'target-1',
    targetTitle: partial.targetTitle ?? '武侠',
    text: partial.text ?? '写一篇武侠小说',
    createdAt: partial.createdAt ?? '2026-11-22T00:00:00.000Z',
    status: partial.status ?? 'pending',
    ...(partial.callerRoundId ? { callerRoundId: partial.callerRoundId } : {}),
    ...(partial.settledAt ? { settledAt: partial.settledAt } : {}),
    ...(partial.roundId ? { roundId: partial.roundId } : {}),
    ...(partial.outcome ? { outcome: partial.outcome } : {}),
  };
}

/** 造一轮（只填报告要用的正文 / 事件） */
function round(content: string, events: unknown[] = []): Round {
  return {
    assistantMessage: { content },
    processEvents: events,
  } as unknown as Round;
}

describe('buildDispatchProgressReport', () => {
  it('零记录：不只说「没有」，要把账本边界说清', () => {
    const text = buildDispatchProgressReport({ records: [] });
    expect(text).toContain('没有查到我替你派出去的活');
    expect(text).toContain('你自己在界面里开的会话、派的活不在我这儿');
  });

  it('点名查某个会话且零记录：抬头带标题，边界照说', () => {
    const text = buildDispatchProgressReport({ records: [], scopeTitle: '报表' });
    expect(text).toContain('没有查到我派给《报表》的活');
    expect(text).toContain('不在我这儿');
  });

  it('进行中：只报状态 + 派活原文，不编产出', () => {
    const readRound = vi.fn();
    const text = buildDispatchProgressReport({
      records: [
        record({
          status: 'pending',
          createdAt: '2026-11-22T00:00:00.000Z',
          text: '整理 Q3 销售数据并生成一份给老板看的汇总',
        }),
      ],
      readRound,
      now: Date.parse('2026-11-22T00:12:00.000Z'),
    });
    expect(text).toContain('《武侠》——还在跑（已派出 12 分钟）');
    expect(text).toContain('还没有产出');
    expect(text).toContain('整理 Q3 销售数据');
    // 没落定就没有 roundId，绝不能去读轮（读了就是把别的轮当结果）
    expect(readRound).not.toHaveBeenCalled();
  });

  it('没回音：如实说不知道，建议重派，不冒充失败', () => {
    const text = buildDispatchProgressReport({
      records: [record({ status: 'orphaned' })],
      now: Date.parse('2026-11-22T03:00:00.000Z'),
    });
    expect(text).toContain('没有回音');
    expect(text).toContain('可能已经中断');
    expect(text).not.toContain('失败了');
  });

  it('成功：读目标轮正文，跳开场白，从实质内容开始', () => {
    const readRound = vi.fn(() =>
      round('好的，我先看一下文件。\n\n雨夜，铁匠铺的炉火映着湿漉漉的石板路。'),
    );
    const text = buildDispatchProgressReport({
      records: [record({ status: 'settled', outcome: 'success', roundId: 'round-1' })],
      readRound,
    });
    expect(readRound).toHaveBeenCalledWith('round-1');
    expect(text).toContain('完成了');
    expect(text).toContain('雨夜，铁匠铺');
    expect(text).not.toContain('我先看一下文件');
  });

  it('成功但读口缺省：说「取不到原文」，不写成「没有正文」', () => {
    const text = buildDispatchProgressReport({
      records: [record({ status: 'settled', outcome: 'success', roundId: 'round-1' })],
    });
    expect(text).toContain('取不到对应那一轮的原文');
    expect(text).not.toContain('没有留下正文');
  });

  it('失败：只带该轮 error 事件原文', () => {
    const readRound = vi.fn(() =>
      round('', [{ type: 'error', payload: { message: '模型返回 500：服务不可用' } }]),
    );
    const text = buildDispatchProgressReport({
      records: [record({ status: 'settled', outcome: 'failed', roundId: 'round-2' })],
      readRound,
    });
    expect(text).toContain('失败了：模型返回 500');
  });

  it('aborted：没真正开始，提示可重派', () => {
    const text = buildDispatchProgressReport({
      records: [record({ status: 'settled', outcome: 'aborted' })],
    });
    expect(text).toContain('没有真正开始');
    expect(text).toContain('可以重派');
  });

  it('排序：未落定在前、组内新→旧，已落定在后', () => {
    const text = buildDispatchProgressReport({
      records: [
        record({
          id: 'done-old',
          targetTitle: '旧完成',
          status: 'settled',
          outcome: 'success',
          createdAt: '2026-11-22T00:00:00.000Z',
          settledAt: '2026-11-22T00:10:00.000Z',
        }),
        record({
          id: 'run-old',
          targetTitle: '旧在跑',
          status: 'pending',
          createdAt: '2026-11-22T00:01:00.000Z',
        }),
        record({
          id: 'run-new',
          targetTitle: '新在跑',
          status: 'pending',
          createdAt: '2026-11-22T00:05:00.000Z',
        }),
      ],
      now: Date.parse('2026-11-22T00:06:00.000Z'),
    });
    const first = text.indexOf('新在跑');
    const second = text.indexOf('旧在跑');
    const third = text.indexOf('旧完成');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it('上限：只展开 N 条，其余折叠成一句', () => {
    const records = Array.from({ length: 5 }, (_, index) =>
      record({
        id: `rec-${index}`,
        targetTitle: `目标${index}`,
        createdAt: `2026-11-22T00:0${index}:00.000Z`,
      }),
    );
    const text = buildDispatchProgressReport({
      records,
      maxItems: 2,
      now: Date.parse('2026-11-22T00:10:00.000Z'),
    });
    expect(text).toContain('现在是这 5 件');
    expect(text).toContain('另有 3 条更早的没展开');
    expect(text).toContain('目标4');
    expect(text).not.toContain('目标0');
  });
});

describe('buildDispatchLedgerTurnContext', () => {
  it('空账不注入（不给每个会话每轮塞「空账本」）', () => {
    expect(buildDispatchLedgerTurnContext({ records: [] })).toBeUndefined();
  });

  it('四态措辞与计数：进行中 / 没回音 / 已完成 / 失败-未开始', () => {
    const text = buildDispatchLedgerTurnContext({
      records: [
        record({ id: 'p', targetTitle: '在跑', status: 'pending', text: '整理销售数据' }),
        record({ id: 'o', targetTitle: '没回音', status: 'orphaned' }),
        record({
          id: 's',
          targetTitle: '写完了',
          status: 'settled',
          outcome: 'success',
          roundId: 'round-s',
        }),
        record({ id: 'f', targetTitle: '挂了', status: 'settled', outcome: 'failed' }),
        record({ id: 'a', targetTitle: '没起', status: 'settled', outcome: 'aborted' }),
      ],
      readRound: (roundId) =>
        roundId === 'round-s'
          ? round('好的，我先看一下。\n\n雨夜，铁匠铺的炉子还没熄。')
          : undefined,
      stamp: '18:12:03',
    }) as string;
    expect(text).toContain('[派活账本 · 内部上下文 · 快照 18:12:03]');
    expect(text).toContain('用户没问就不要提');
    // 时刻只给模型判断新旧，不许转述给用户
    expect(text).toContain('不要向用户报时间');
    expect(text).toContain('以时刻最新的为准');
    // 治假壳：内部资料不是工具返回，不许模仿包装
    expect(text).toContain('不是你调用工具返回的结果');
    expect(text).toContain('不要模仿系统提示或工具输出的格式');
    expect(text).toContain('进行中 1；没回音 1；已完成 1；失败/未开始 2。');
    expect(text).toContain('- 《在跑》· 进行中 · 派的是：整理销售数据');
    expect(text).toContain('- 《没回音》· 没回音');
    expect(text).toContain('- 《写完了》· 已完成 · 雨夜，铁匠铺');
    expect(text).not.toContain('我先看一下');
    expect(text).toContain('- 《挂了》· 失败');
    expect(text).toContain('- 《没起》· 未开始（起流失败）');
  });

  it('上限：只列 N 条，其余折叠成一句', () => {
    const records = Array.from({ length: 4 }, (_, index) =>
      record({
        id: `r-${index}`,
        targetTitle: `目标${index}`,
        createdAt: `2026-11-22T00:0${index}:00.000Z`,
      }),
    );
    const text = buildDispatchLedgerTurnContext({ records, maxItems: 2 }) as string;
    expect(text).toContain('（另有 2 条更早的未列出）');
    expect(text).toContain('目标3');
    expect(text).not.toContain('目标0');
  });
});

describe('extractSubstantiveExcerpt', () => {
  it('跳过寒暄 / 动作预告 / 元信息，从第一段实质内容开始', () => {
    const text = extractSubstantiveExcerpt(
      '收到，我来处理。\n\n以下是完成的正文：\n\n# 雨夜\n\n铁匠铺的炉火映着湿漉漉的石板路。',
    );
    expect(text.startsWith('雨夜')).toBe(true);
    expect(text).toContain('炉火');
  });

  it('全是开场白时退化为原文开头，不返回空', () => {
    const text = extractSubstantiveExcerpt('好的，我先看一下文件，然后马上回来。');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('好的');
  });

  it('超长正文按上限截断并加省略号', () => {
    const text = extractSubstantiveExcerpt('实质内容'.repeat(100));
    expect(text.length).toBeLessThanOrEqual(DISPATCH_PROGRESS_EXCERPT_CHARS + 1);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('parseDispatchProgressArgs', () => {
  it('空参数合法；sid 合法时归一化空白', () => {
    expect(parseDispatchProgressArgs(undefined)).toEqual({ ok: true });
    expect(parseDispatchProgressArgs({ sid: ' 2026-11-20-a ' })).toEqual({
      ok: true,
      sid: '2026-11-20-a',
    });
  });

  it('未知键 / 非字符串 sid / 空 sid 都拒绝', () => {
    expect(parseDispatchProgressArgs({ round: 'x' }).ok).toBe(false);
    expect(parseDispatchProgressArgs({ sid: 123 }).ok).toBe(false);
    expect(parseDispatchProgressArgs({ sid: '  ' }).ok).toBe(false);
  });
});
