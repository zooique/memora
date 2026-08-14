/**
 * hash.ts 单元测试 — sha256Fingerprint 内容指纹
 *
 * 覆盖范围：
 *   - 同输入多次计算返回一致结果（确定性）
 *   - 输出为 64 位小写 hex
 *   - 不同输入生成不同指纹
 *   - 空字符串可正常哈希
 */
import { describe, expect, it } from 'vitest';
import { sha256Fingerprint } from '@/utils/hash.js';

describe('sha256Fingerprint', () => {
  it('同输入多次计算返回一致结果（确定性）', () => {
    const input = '记忆召回结果 + 系统提示内容';
    expect(sha256Fingerprint(input)).toBe(sha256Fingerprint(input));
  });

  it('输出为 64 位小写 hex', () => {
    const hash = sha256Fingerprint('test content');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同输入生成不同指纹', () => {
    const a = sha256Fingerprint('content-a');
    const b = sha256Fingerprint('content-b');
    expect(a).not.toBe(b);
  });

  it('空字符串可正常哈希', () => {
    expect(sha256Fingerprint('')).toMatch(/^[0-9a-f]{64}$/);
  });
});
