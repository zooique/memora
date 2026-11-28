/**
 * 配对串对外地址判据单测
 *
 * 锁三件事：
 *   ① 合法形态（域名 / IPv4，可带对外端口）无损规范化，trim 后回显稳定；
 *   ② URI 危险形态（scheme / 路径 / 空白 / IPv6 / 绑定值 / 越界端口）一律拒绝；
 *   ③ 持久化只存规范化文本，读时再校验（旧坏值按未配置回落）。
 */
import { describe, expect, it } from 'vitest';
import {
  clearPublicAddress,
  formatPublicAddress,
  normalizePublicAddress,
  readPublicAddress,
  REMOTE_PUBLIC_ADDRESS_KEY,
  writePublicAddress,
  type PublicAddressMemento,
} from '../remotePublicAddress.js';

/** 最小 Memento 桩（与设备表同款窄接口） */
function makeMemento(): PublicAddressMemento & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    update(key: string, value: unknown): Thenable<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('normalizePublicAddress', () => {
  it('域名与 IPv4 原样通过；首尾空白被裁掉', () => {
    expect(normalizePublicAddress('home.example.com')).toEqual({ host: 'home.example.com' });
    expect(normalizePublicAddress('  192.168.1.9  ')).toEqual({ host: '192.168.1.9' });
  });

  it('带端口时覆盖对外端口，1 与 65535 是合法边界', () => {
    expect(normalizePublicAddress('home.example.com:5890')).toEqual({
      host: 'home.example.com',
      port: 5890,
    });
    expect(normalizePublicAddress('a.example:1')).toEqual({ host: 'a.example', port: 1 });
    expect(normalizePublicAddress('a.example:65535')).toEqual({ host: 'a.example', port: 65535 });
  });

  it('绑定值、空串、非字符串一律拒绝', () => {
    expect(normalizePublicAddress('0.0.0.0')).toBeUndefined();
    expect(normalizePublicAddress('0.0.0.0:5890')).toBeUndefined();
    expect(normalizePublicAddress('')).toBeUndefined();
    expect(normalizePublicAddress('   ')).toBeUndefined();
    expect(normalizePublicAddress(undefined)).toBeUndefined();
    expect(normalizePublicAddress(123)).toBeUndefined();
  });

  it('scheme / 路径 / 查询 / 空白 / IPv6 字面量不进配对串的 h', () => {
    for (const bad of [
      'wss://home.example.com',
      'home.example.com/path',
      'home.example.com?x=1',
      'home.example.com#frag',
      'home.example.com:5890:1',
      '[2001:db8::1]',
      '[2001:db8::1]:5890',
      'a b.example',
      'a\\b.example',
      '-bad.example',
      'bad-.example',
    ]) {
      expect(normalizePublicAddress(bad), bad).toBeUndefined();
    }
  });

  it('端口越界与非数字拒绝', () => {
    for (const bad of ['a.example:0', 'a.example:65536', 'a.example:abc', 'a.example:']) {
      expect(normalizePublicAddress(bad), bad).toBeUndefined();
    }
  });

  it('过长 host 拒绝', () => {
    expect(
      normalizePublicAddress(
        `${'a'.repeat(62)}.${'b'.repeat(62)}.${'c'.repeat(62)}.${'d'.repeat(62)}.com`,
      ),
    ).toBeUndefined();
  });

  it('规范化后格式稳定：带端口直出，不带端口不带冒号', () => {
    expect(formatPublicAddress({ host: 'home.example.com' })).toBe('home.example.com');
    expect(formatPublicAddress({ host: 'home.example.com', port: 5890 })).toBe(
      'home.example.com:5890',
    );
  });
});

describe('对外地址持久化', () => {
  it('写入规范化文本；读回同源', async () => {
    const memento = makeMemento();
    expect(await writePublicAddress(memento, '  home.example.com:5890  ')).toEqual({
      host: 'home.example.com',
      port: 5890,
    });
    expect(memento.values.get(REMOTE_PUBLIC_ADDRESS_KEY)).toBe('home.example.com:5890');
    expect(readPublicAddress(memento)).toEqual({ host: 'home.example.com', port: 5890 });
  });

  it('非法输入不写盘，已有配置保持不变', async () => {
    const memento = makeMemento();
    await writePublicAddress(memento, 'home.example.com:5890');
    expect(await writePublicAddress(memento, 'wss://evil.example')).toBeUndefined();
    expect(memento.values.get(REMOTE_PUBLIC_ADDRESS_KEY)).toBe('home.example.com:5890');
  });

  it('旧坏值读时按未配置回落，不参与配对', () => {
    const memento = makeMemento();
    memento.values.set(REMOTE_PUBLIC_ADDRESS_KEY, 'wss://legacy-bad.example');
    expect(readPublicAddress(memento)).toBeUndefined();
  });

  it('清除只删本键、回落未配置（兑现 UI「留空用 LAN」承诺）', async () => {
    const memento = makeMemento();
    await writePublicAddress(memento, 'home.example.com:5890');
    memento.values.set('memora.other.key', 'keep-me');
    await clearPublicAddress(memento);
    expect(readPublicAddress(memento)).toBeUndefined();
    expect(memento.values.has(REMOTE_PUBLIC_ADDRESS_KEY)).toBe(false);
    expect(memento.values.get('memora.other.key')).toBe('keep-me');
  });
});
