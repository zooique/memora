/**
 * shared/dispatchKey 单测
 *
 * 这个函数存在的唯一理由就是「两处必须逐字相同」，所以这里同时钉死**两种消费形态**：
 * 落定通知的 `（sid=…，round=…）` 外壳，和账本行的 `(sid=…，round=…)` 外壳——
 * 身份片段本身只能有一份。
 */
import { describe, expect, it } from 'vitest';
import { formatDispatchKey } from '../dispatchKey.js';

describe('formatDispatchKey · 派活对账身份片段', () => {
  it('有轮时带全角逗号与 round', () => {
    expect(formatDispatchKey('2026-11-24-a', '2026-11-24-a-1')).toBe(
      'sid=2026-11-24-a，round=2026-11-24-a-1',
    );
  });

  it('无轮 / 空白轮只出 sid，不写空 round=', () => {
    expect(formatDispatchKey('2026-11-24-a')).toBe('sid=2026-11-24-a');
    expect(formatDispatchKey('2026-11-24-a', '   ')).toBe('sid=2026-11-24-a');
  });
});
