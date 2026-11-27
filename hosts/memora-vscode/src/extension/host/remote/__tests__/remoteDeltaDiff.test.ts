/**
 * 富增量差分单测（§6.4.1 / §6.7）—— 直接对拍游标与快照，验「不重不漏」
 *
 * 判据：订阅初始化游标（防历史当增量）、正文前缀只发后缀、事件按 seq 去重、
 * 重复快照零增量（幂等）、轮切换整轮重置。每条都用独立手写期望，
 * 字段漂移或判据反转必须红。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView, TurnState } from '../../../../shared/protocol.js';
import type { SnapshotPayload } from '../remoteBridgeProtocol.js';
import { diffRichDelta, initRichCursor } from '../remoteDeltaDiff.js';

const RUNNING: TurnState = { phase: 'running', roundId: 'r1' };

function toolEvent(seq: number, name: string): ProcessEvent {
  return {
    type: 'tool_start',
    seq,
    ts: '2026-11-27T00:00:00.000Z',
    payload: { toolCallId: `call-${seq}`, name },
  };
}

function liveRound(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'r1',
    live: true,
    userMessage: { role: 'user', content: '问', timestamp: '2026-11-27T00:00:00.000Z' },
    ...overrides,
  } as RoundView;
}

function snapshot(rounds: readonly RoundView[]): SnapshotPayload {
  return { state: RUNNING, rounds, pendingQueue: [] };
}

describe('remoteDeltaDiff — 富增量不重不漏', () => {
  it('订阅初始化游标 = 当前快照；紧接同一快照零增量', () => {
    const snap = snapshot([
      liveRound({
        assistantMessage: {
          id: 'm1',
          role: 'assistant',
          content: '历史正文',
          timestamp: '2026-11-27T00:00:00.000Z',
        },
        processEvents: [toolEvent(1, 'read_file'), toolEvent(3, 'write_file')],
      }),
    ]);
    const cursor = initRichCursor(snap);
    expect(cursor).toEqual({ roundId: 'r1', text: '历史正文', eventSeq: 3 });

    const { specs, next } = diffRichDelta(snap, cursor);
    // 独立手写期望：订阅即重发历史（正文或事件）必须红
    expect(specs).toEqual([]);
    expect(next).toEqual(cursor);
  });

  it('正文单调追加只发后缀；事件按 seq 过滤，重复触发零增量', () => {
    const cursor = initRichCursor(
      snapshot([
        liveRound({
          assistantMessage: {
            id: 'm1',
            role: 'assistant',
            content: '你好',
            timestamp: '2026-11-27T00:00:00.000Z',
          },
          processEvents: [toolEvent(2, 'read_file')],
        }),
      ]),
    );
    const grown = snapshot([
      liveRound({
        assistantMessage: {
          id: 'm1',
          role: 'assistant',
          content: '你好世界',
          timestamp: '2026-11-27T00:00:00.000Z',
        },
        processEvents: [toolEvent(2, 'read_file'), toolEvent(5, 'write_file')],
      }),
    ]);
    const first = diffRichDelta(grown, cursor);
    expect(first.specs).toEqual([
      { kind: 'append_text', roundId: 'r1', text: '世界' },
      { kind: 'process_event', roundId: 'r1', event: toolEvent(5, 'write_file') },
    ]);
    expect(first.next).toEqual({ roundId: 'r1', text: '你好世界', eventSeq: 5 });

    // 同一快照再差分：必须零增量（幂等），否则重复推送
    expect(diffRichDelta(grown, first.next).specs).toEqual([]);
  });

  it('轮切换整轮重置：新轮正文与事件全量发出，不串上一轮游标', () => {
    const cursor = initRichCursor(
      snapshot([
        liveRound({
          assistantMessage: {
            id: 'm1',
            role: 'assistant',
            content: '旧轮正文',
            timestamp: '2026-11-27T00:00:00.000Z',
          },
          processEvents: [toolEvent(9, 'old')],
        }),
      ]),
    );
    const nextRound = snapshot([
      liveRound({
        id: 'r2',
        assistantMessage: {
          id: 'm2',
          role: 'assistant',
          content: '新轮',
          timestamp: '2026-11-27T00:00:00.000Z',
        },
        processEvents: [toolEvent(1, 'new')],
      }),
    ]);
    expect(diffRichDelta(nextRound, cursor).specs).toEqual([
      { kind: 'append_text', roundId: 'r2', text: '新轮' },
      { kind: 'process_event', roundId: 'r2', event: toolEvent(1, 'new') },
    ]);
  });

  it('正文异常回退（非前缀）不发正文帧；无 live 轮静默零增量', () => {
    const cursor = initRichCursor(
      snapshot([
        liveRound({
          assistantMessage: {
            id: 'm1',
            role: 'assistant',
            content: '完整正文',
            timestamp: '2026-11-27T00:00:00.000Z',
          },
        }),
      ]),
    );
    const reverted = snapshot([
      liveRound({
        assistantMessage: {
          id: 'm1',
          role: 'assistant',
          content: '被改写',
          timestamp: '2026-11-27T00:00:00.000Z',
        },
      }),
    ]);
    // 宁可漏一次也不发错位正文；但须标 resync 让桥补快照全量重建（否则错字永久留手机）
    const broken = diffRichDelta(reverted, cursor);
    expect(broken.specs).toEqual([]);
    expect(broken.resync).toBe(true);

    // 收场后无 live 轮：落盘内容由下一次快照覆盖，不发富增量、也不触发 resync
    const settled = snapshot([{ id: 'r1', status: 'complete' } as unknown as RoundView]);
    expect(diffRichDelta(settled, cursor).specs).toEqual([]);
    expect(diffRichDelta(settled, cursor).resync).toBe(false);
  });

  it('正常单调追加不误报 resync；空游标不算断裂', () => {
    const cursor = initRichCursor(
      snapshot([
        liveRound({
          assistantMessage: {
            id: 'm1',
            role: 'assistant',
            content: '先',
            timestamp: '2026-11-27T00:00:00.000Z',
          },
        }),
      ]),
    );
    const grown = snapshot([
      liveRound({
        assistantMessage: {
          id: 'm1',
          role: 'assistant',
          content: '先找一下项目里有没有这个文件。',
          timestamp: '2026-11-27T00:00:00.000Z',
        },
      }),
    ]);
    const normal = diffRichDelta(grown, cursor);
    expect(normal.resync).toBe(false);
    expect(normal.specs).toEqual([
      { kind: 'append_text', roundId: 'r1', text: '找一下项目里有没有这个文件。' },
    ]);

    const emptyCursor = { roundId: 'r1', text: '', eventSeq: 0 };
    const fromEmpty = diffRichDelta(grown, emptyCursor);
    expect(fromEmpty.resync).toBe(false);
    expect(fromEmpty.specs).toEqual([
      { kind: 'append_text', roundId: 'r1', text: '先找一下项目里有没有这个文件。' },
    ]);
  });
});
