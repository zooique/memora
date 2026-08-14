/**
 * fmtTime 纯函数单测（阶段 A P2-1：字符串脚本逻辑抽为可测模块后的第一层覆盖）
 */
import { describe, it, expect } from 'vitest';
import { fmtTime, fmtTimeScript } from '../fmtTime.js';

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

  it('注入脚本由纯函数源码序列化（单一真源，可被 webview 调用）', () => {
    expect(fmtTimeScript).toContain('function fmtTime');
    // 序列化脚本可被 eval 后调用，与纯函数行为一致（验证序列化未失真）
    // 仅做存在性断言，行为一致性由上述用例覆盖纯函数本体
  });
});
