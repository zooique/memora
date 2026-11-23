/**
 * 中断原因投影单测（`shared/interruptReason.ts`）
 *
 * 钉住「原因只写真实可测的」：用户停 / 超时 / 异常 / 崩溃恢复 / 取不到 五档，以及
 * 「无事件 ≠ 用户停」这条与 `decideTerminus` 展示兜底刻意分家的边界。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import { deriveInterruptReason } from '../interruptReason.js';

const TS = '2026-11-14T10:00:00.000Z';

/**
 * 造一条 aborted 事件
 *
 * @param stopReason 结构化停止原因（缺省 = 旧数据没有该字段）
 * @param reason 自由文本原因
 */
function aborted(
  stopReason?: 'user' | 'timeout' | 'interrupted' | 'connection',
  reason = '原始原因',
): ProcessEvent {
  return {
    type: 'aborted',
    seq: 1,
    ts: TS,
    payload: { reason, ...(stopReason ? { stopReason } : {}) },
  };
}

/**
 * 造一条 error 事件
 *
 * @param message 原始错误文本（必须原样带回，不能被吞）
 */
function errorEvent(message = 'boom'): ProcessEvent {
  return { type: 'error', seq: 1, ts: TS, payload: { message } };
}

describe('deriveInterruptReason', () => {
  it("aborted + stopReason='user' → 原因归用户", () => {
    const r = deriveInterruptReason([aborted('user')]);
    expect(r.stopper).toBe('user');
    expect(r.source?.type).toBe('aborted');
  });

  it("aborted + stopReason='timeout' → 原因是超时（不并入用户/异常）", () => {
    expect(deriveInterruptReason([aborted('timeout')]).stopper).toBe('timeout');
  });

  it("aborted + stopReason='interrupted' → 崩溃恢复（不冒充用户停、也不算异常）", () => {
    const r = deriveInterruptReason([aborted('interrupted')]);
    expect(r.stopper).toBe('recovered');
    expect(r.source?.type).toBe('aborted');
  });

  it('aborted 但 stopReason 是未登记值 / 缺省 → 如实取不到（不冒充任何人）', () => {
    expect(deriveInterruptReason([aborted('connection')]).stopper).toBe('unavailable');
    // 旧数据没有 stopReason：保留原始事件，但仍不编造「用户停」
    const legacy = deriveInterruptReason([aborted()]);
    expect(legacy.stopper).toBe('unavailable');
    expect(legacy.source?.type).toBe('aborted');
  });

  it('error 事件 → 原因归异常，且带回原始错误文本', () => {
    const r = deriveInterruptReason([errorEvent('模型拒绝服务')]);
    expect(r.stopper).toBe('error');
    expect(r.source?.type === 'error' && r.source.payload.message).toBe('模型拒绝服务');
  });

  it('error 与 aborted 异常共存时 error 优先（与 decideTerminus 同序）', () => {
    expect(deriveInterruptReason([aborted('user'), errorEvent()]).stopper).toBe('error');
  });

  it('无事件 + 宿主确实 abort → 原因归用户（abort 唯一生产点 = 用户停止）', () => {
    const r = deriveInterruptReason([], { hostAborted: true });
    expect(r.stopper).toBe('user');
    expect(r.source).toBeUndefined();
  });

  it('无事件且宿主未 abort → 如实取不到（不套用展示层的「用户中断」兜底）', () => {
    const r = deriveInterruptReason([]);
    expect(r.stopper).toBe('unavailable');
    expect(r.source).toBeUndefined();
  });
});
