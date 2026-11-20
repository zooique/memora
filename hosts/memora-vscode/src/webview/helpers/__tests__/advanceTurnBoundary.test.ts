/**
 * 实时回声的展示判据（HOSTED-INTERNAL-SEED-1 的实时侧守卫）
 *
 * 2026-11-20 真机：落定唤醒汇报的内部种子被实时回声上屏，而重放侧一直跳过。
 * 本用例锁住「一个判据」——实时与重放共用 `isInternalSeedSender`，内部种子不产回声。
 */
import { describe, expect, it } from 'vitest';
import { INTERNAL_SEED_SENDER } from '../../../shared/constants.js';
import { advanceTurnBoundary, type LiveFlowBuffer } from '../sessionRuntime.js';

/** 造一条「刚开流、尚未推进轮边界」的 live 缓冲 */
function bufferWith(name: string | undefined): LiveFlowBuffer {
  return {
    sessionId: '2026-11-20-worker',
    eventsByRound: new Map(),
    textByRound: new Map(),
    seedUserMessage: {
      id: 'live-seed',
      role: 'user',
      content: '触发指令',
      timestamp: '2026-11-20T01:00:00.000Z',
      ...(name ? { name } : {}),
    },
    seedOrigin: 'hosted',
  };
}

describe('advanceTurnBoundary · 内部种子不上屏', () => {
  it('内部种子轮：进入新 turn 但不出回声，并标记已处理（后续 turn 不重试）', () => {
    const live = bufferWith(INTERNAL_SEED_SENDER);
    expect(advanceTurnBoundary(live, 'round-1')).toEqual({ began: true });
    expect(live.seedEchoed).toBe(true);
    // 第二轮 chunk（多 turn 任务）不应再尝试上屏
    const again = advanceTurnBoundary(live, 'round-2');
    expect(again).toEqual({ began: true });
    expect(again.echo).toBeUndefined();
  });

  it('派发 seed：照旧随首轮上屏一次（不误伤）', () => {
    const live = bufferWith('统计目录文件数');
    const first = advanceTurnBoundary(live, 'round-1');
    expect(first.echo?.origin).toBe('hosted');
    expect(first.echo?.senderName).toBe('统计目录文件数');
    expect(first.echo?.roundId).toBe('round-1');
    const second = advanceTurnBoundary(live, 'round-2');
    expect(second.echo).toBeUndefined();
  });

  it('用户自输（origin 非 hosted）：不回声', () => {
    const live = bufferWith(undefined);
    live.seedOrigin = 'user';
    expect(advanceTurnBoundary(live, 'round-1').echo).toBeUndefined();
  });
});
