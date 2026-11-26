/**
 * 指纹纯函数单测 —— 派生 / 短码 / 归一 与「不含证书库」的模块边界
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §19.9（DER 指纹）、§5.4（短码形态）、
 *   §5.7（设备表与握手共用同一指纹形态）
 */
import { describe, expect, it } from 'vitest';
import {
  fingerprintOfCertDer,
  normalizeFingerprint,
  shortFingerprint,
} from '../remoteFingerprint.js';

describe('remoteFingerprint — 派生与形态', () => {
  it('fingerprintOfCertDer：任意字节 → 64 位大写 hex，且确定性', () => {
    const bytes = new Uint8Array([0x01, 0xab, 0xff, 0x00, 0x7e]);
    const first = fingerprintOfCertDer(bytes);
    expect(first).toMatch(/^[0-9A-F]{64}$/);
    expect(fingerprintOfCertDer(bytes)).toBe(first);
    // 不同字节必须得到不同指纹（不是常量退回）
    expect(fingerprintOfCertDer(new Uint8Array([0x02]))).not.toBe(first);
  });

  it('fingerprintOfCertDer：空字节也是合法输入（算出空内容的 SHA-256）', () => {
    expect(fingerprintOfCertDer(new Uint8Array([]))).toMatch(/^[0-9A-F]{64}$/);
  });

  it('shortFingerprint：前 8 hex 分两组，大小写归一', () => {
    expect(shortFingerprint('ab12cd34' + 'f'.repeat(56))).toBe('AB12-CD34');
    // 已经是短码形态时幂等
    expect(shortFingerprint('AB12-CD34')).toBe('AB12-CD34');
  });

  it('shortFingerprint：非法字符被剔除且不抛错', () => {
    expect(() => shortFingerprint('')).not.toThrow();
    expect(() => shortFingerprint('!!!')).not.toThrow();
    expect(shortFingerprint('zz-ab12cd34-zz')).toBe('AB12-CD34');
  });

  it('normalizeFingerprint：去首尾空白并转大写', () => {
    expect(normalizeFingerprint('  ab12cd34  ')).toBe('AB12CD34');
    expect(normalizeFingerprint('')).toBe('');
    expect(() => normalizeFingerprint('a b\t')).not.toThrow();
  });
});

describe('remoteFingerprint — 模块边界（激活成本）', () => {
  it('只导出三个纯函数（不含证书库逻辑 / 无证书模块副作用）', async () => {
    const mod = await import('../remoteFingerprint.js');
    expect(Object.keys(mod).sort()).toEqual([
      'fingerprintOfCertDer',
      'normalizeFingerprint',
      'shortFingerprint',
    ]);
  });
});
