/**
 * 失败限流单测 —— 阈值封禁 / 到期解封 / 成功清零 / 键上限淘汰
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §16.2 G4、§4.5.5
 *   （5 分钟内失败 ≥5 次 ⇒ 封 30 分钟；TLL 到期自动解封）
 */
import { describe, expect, it } from 'vitest';
import { RemoteFailureLimiter } from '../remoteRateLimiter.js';

/** 30 分钟（方案 §4.5.5 的封禁时长） */
const BAN_MS = 30 * 60 * 1000;

describe('RemoteFailureLimiter — 阈值与解封', () => {
  it('窗口内 5 次失败后封禁，retryAfterMs = 封禁时长', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, windowMs: 60_000, banMs: BAN_MS });

    for (let i = 0; i < 4; i += 1) {
      expect(limiter.noteFailure('1.2.3.4').blocked).toBe(false);
      now += 1;
    }
    const fifth = limiter.noteFailure('1.2.3.4');
    expect(fifth.blocked).toBe(true);
    expect(fifth.retryAfterMs).toBe(BAN_MS);
    expect(limiter.check('1.2.3.4')).toEqual({ blocked: true, retryAfterMs: BAN_MS });
  });

  it('封禁到期后自动解封（check 返回未封禁）', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, windowMs: 60_000, banMs: BAN_MS });
    for (let i = 0; i < 5; i += 1) limiter.noteFailure('ip');
    expect(limiter.check('ip').blocked).toBe(true);

    now += BAN_MS;
    expect(limiter.check('ip')).toEqual({ blocked: false, retryAfterMs: 0 });
    // 解封后重新计数，不会立刻再封
    expect(limiter.noteFailure('ip').blocked).toBe(false);
  });

  it('成功清零：之前的失败不再累积', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, windowMs: 60_000, banMs: BAN_MS });
    for (let i = 0; i < 4; i += 1) limiter.noteFailure('key');
    limiter.noteSuccess('key');
    for (let i = 0; i < 4; i += 1) {
      expect(limiter.noteFailure('key').blocked).toBe(false);
    }
  });

  it('封禁期内继续失败不延长封禁', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, windowMs: 60_000, banMs: BAN_MS });
    for (let i = 0; i < 5; i += 1) limiter.noteFailure('k');
    now += 1000;
    const again = limiter.noteFailure('k');
    expect(again.blocked).toBe(true);
    expect(again.retryAfterMs).toBe(BAN_MS - 1000);
  });

  it('窗口外的失败不计入阈值', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, windowMs: 1_000, banMs: BAN_MS });
    for (let i = 0; i < 4; i += 1) {
      limiter.noteFailure('slow');
      now += 1_001; // 每次间隔都超过窗口 ⇒ 旧失败全部过期
    }
    expect(limiter.noteFailure('slow').blocked).toBe(false);
  });
});

describe('RemoteFailureLimiter — 内存有界', () => {
  it('超过 maxKeys 时淘汰最久未活动的键', () => {
    let now = 0;
    const logs: string[] = [];
    const limiter = new RemoteFailureLimiter({
      now: () => now,
      windowMs: 60_000,
      banMs: BAN_MS,
      maxKeys: 2,
      log: (m) => logs.push(m),
    });

    // a 累积 4 次失败（再失败一次就会封禁）
    for (let i = 0; i < 4; i += 1) {
      limiter.noteFailure('a');
      now += 1;
    }
    now += 1;
    limiter.noteFailure('b'); // 现在有 a、b
    now += 1;
    limiter.noteFailure('c'); // 超上限 ⇒ 淘汰最久未活动的 a

    expect(logs.some((line) => line.includes('淘汰'))).toBe(true);
    // a 已被淘汰：失败计数从零开始，这一次不会触发封禁（若未淘汰则应正好第 5 次）
    expect(limiter.noteFailure('a').blocked).toBe(false);
  });

  it('成功记录会删除键（不再占用内存）', () => {
    let now = 0;
    const limiter = new RemoteFailureLimiter({ now: () => now, maxKeys: 1, log: () => undefined });
    limiter.noteFailure('a');
    limiter.noteSuccess('a');
    // 空出位置后写入新键不会被淘汰（无日志断言，仅确认不抛错且状态正确）
    expect(limiter.noteFailure('b').blocked).toBe(false);
    expect(limiter.check('b').blocked).toBe(false);
  });
});
