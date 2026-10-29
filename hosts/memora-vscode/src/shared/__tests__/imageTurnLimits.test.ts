/**
 * IMG-8 三维聚合限额判据单点（shared/imageTurnLimits）的机测。
 *
 * 判据来源 = IMG-8 拍板（2026-10-29）：张数 ≤5 / 总字节 ≤20 MiB / token ≤25% 窗口；
 * 优先级 张数 → 总字节 → token，首个越界即返回；超限文案必须带具体数字（已用 / 上限 / 超出）。
 * 变异靶（三组各自能单独打红）：① 张数比较撤回；② 总字节比较撤回；③ token 维撤回。
 */
import { describe, expect, it } from 'vitest';
import {
  checkImageTurnLimits,
  IMAGE_TOKEN_WINDOW_RATIO,
  MAX_IMAGES_PER_TURN,
  MAX_TURN_BYTES,
} from '../imageTurnLimits.js';

describe('checkImageTurnLimits · 三维聚合限额（IMG-8）', () => {
  it('三维均不越界 ⇒ 放行且 message 为空', () => {
    const r = checkImageTurnLimits({
      count: MAX_IMAGES_PER_TURN,
      totalBytes: MAX_TURN_BYTES,
      totalTokens: 1000,
      limitTokens: 8000,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('');
  });

  it('张数超限 ⇒ 拒发，文案带实际张数与上限', () => {
    const r = checkImageTurnLimits({ count: 6, totalBytes: 0, totalTokens: 0, limitTokens: 8000 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('6');
    expect(r.message).toContain(String(MAX_IMAGES_PER_TURN));
  });

  it('总字节超限 ⇒ 拒发，文案带 MiB 已用与超出', () => {
    const bytes = MAX_TURN_BYTES + 1024 * 1024;
    const r = checkImageTurnLimits({ count: 1, totalBytes: bytes, totalTokens: 0, limitTokens: 8000 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('21.0');
    expect(r.message).toContain('1.0');
  });

  it('token 超限 ⇒ 拒发，文案带合计、上限（窗口×25% 取整）与超出', () => {
    // 8000 × 0.25 = 2000；合计 2001 ⇒ 超出 1
    const r = checkImageTurnLimits({ count: 1, totalBytes: 0, totalTokens: 2001, limitTokens: 8000 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('2001');
    expect(r.message).toContain('2000');
  });

  it('优先级：张数 → 总字节 → token，首个越界即返回（不合并文案）', () => {
    // 张数与 token 同时越界 ⇒ 只报张数
    const r1 = checkImageTurnLimits({ count: 7, totalBytes: 0, totalTokens: 99999, limitTokens: 8000 });
    expect(r1.message).toContain('张');
    expect(r1.message).not.toContain('token');
    // 张数合规、总字节与 token 同时越界 ⇒ 只报字节
    const r2 = checkImageTurnLimits({
      count: 1,
      totalBytes: MAX_TURN_BYTES + 1,
      totalTokens: 99999,
      limitTokens: 8000,
    });
    expect(r2.message).toContain('MiB');
    expect(r2.message).not.toContain('token');
  });

  it('token 维跳过两态：totalTokens undefined（旧回执缺字段）或 limitTokens 0/undefined（未配置）', () => {
    // 合计未知 ⇒ 不拿部分求和假算，即使窗口很小也放行（token 维整体跳过）
    const r1 = checkImageTurnLimits({ count: 1, totalBytes: 0, totalTokens: undefined, limitTokens: 100 });
    expect(r1.ok).toBe(true);
    // 窗口 0 = 不限（与内核 tokenBudget 口径一致）
    const r2 = checkImageTurnLimits({ count: 1, totalBytes: 0, totalTokens: 999999, limitTokens: 0 });
    expect(r2.ok).toBe(true);
    const r3 = checkImageTurnLimits({ count: 1, totalBytes: 0, totalTokens: 999999, limitTokens: undefined });
    expect(r3.ok).toBe(true);
  });

  it('比例常量 = 0.25 且上限为窗口 × 比例向下取整（与内核 checkImageTokenBudget 同式）', () => {
    expect(IMAGE_TOKEN_WINDOW_RATIO).toBe(0.25);
    // 8001 × 0.25 = 2000.25 ⇒ floor 2000；合计 2000 恰好不越界（> 判据，非 ≥）
    const r = checkImageTurnLimits({ count: 1, totalBytes: 0, totalTokens: 2000, limitTokens: 8001 });
    expect(r.ok).toBe(true);
  });
});
