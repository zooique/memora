/**
 * fmtTime 纯函数单测（纯逻辑抽为可测模块后的覆盖）
 */
import { describe, it, expect } from 'vitest';
import { fmtTime } from '../fmtTime.js';

describe('fmtTime', () => {
  it('空/无效输入返回空串', () => {
    expect(fmtTime()).toBe('');
    expect(fmtTime('')).toBe('');
    expect(fmtTime('not-a-date')).toBe('');
  });

  it('格式化有效 ISO 时间戳为 HH:MM（本地时区）', () => {
    // 用本地时区构造确定性时间：toISOString 为 UTC，fmtTime 再转回本地时区
    const d = new Date(2026, 5, 21, 14, 3); // 本地 14:03
    expect(fmtTime(d.toISOString())).toBe('14:03');
  });
});
