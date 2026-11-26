/**
 * 一次性配对口令单测 —— 正确一次即废 / 过期 / 次数耗尽 / 无口令
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §5.3（8 位数字、5 分钟、一次即废）、
 *   §5.8（口令 + 人工批准共同完成首次信任）
 */
import { describe, expect, it } from 'vitest';
import { RemotePairing } from '../remotePairing.js';

/** 构造带可控时钟与固定随机源的实例 */
function makePairing(overrides: Partial<{ ttlMs: number; maxAttempts: number }> = {}): {
  pairing: RemotePairing;
  advance: (ms: number) => void;
} {
  let now = 1_000;
  const pairing = new RemotePairing({
    now: () => now,
    ttlMs: overrides.ttlMs ?? 60_000,
    maxAttempts: overrides.maxAttempts ?? 5,
    // 固定返回 42：验证前导零补齐（8 位数字）
    randomInt: () => 42,
  });
  return { pairing, advance: (ms) => (now += ms) };
}

describe('RemotePairing — 基本语义', () => {
  it('start 生成 8 位数字口令（含前导零），正确口令一次通过且二次失效', () => {
    const { pairing } = makePairing();
    const challenge = pairing.start();
    expect(challenge.code).toBe('00000042');
    expect(challenge.expiresAt).toBe(61_000);

    expect(pairing.verify('00000042')).toBe('ok');
    expect(pairing.verify('00000042')).toBe('none');
    expect(pairing.current()).toBeUndefined();
  });

  it('没有口令时返回 none（手机应索取新口令）', () => {
    const { pairing } = makePairing();
    expect(pairing.verify('00000042')).toBe('none');
  });

  it('过期：返回 expired 并清除挑战', () => {
    const { pairing, advance } = makePairing();
    pairing.start();
    advance(60_000); // 恰好到期（>= expiresAt）
    expect(pairing.verify('00000042')).toBe('expired');
    expect(pairing.current()).toBeUndefined();
    expect(pairing.verify('00000042')).toBe('none');
  });

  it('错口令：先 mismatch，达到 5 次后 exhausted 并清除挑战', () => {
    const { pairing } = makePairing();
    pairing.start();
    for (let i = 1; i <= 4; i += 1) {
      expect(pairing.verify('99999999')).toBe('mismatch');
    }
    expect(pairing.verify('99999999')).toBe('exhausted');
    // 耗尽后连正确口令也不再受理
    expect(pairing.verify('00000042')).toBe('none');
  });

  it('clear 立即失效；start 会覆盖旧口令并重置尝试次数', () => {
    const { pairing } = makePairing();
    pairing.start();
    pairing.clear();
    expect(pairing.verify('00000042')).toBe('none');

    pairing.start();
    expect(pairing.verify('99999999')).toBe('mismatch');
    pairing.start(); // 重置
    expect(pairing.verify('00000042')).toBe('ok');
  });

  it('长度不同直接 mismatch（timingSafeEqual 前置判据）', () => {
    const { pairing } = makePairing();
    pairing.start();
    expect(pairing.verify('42')).toBe('mismatch');
  });
});
