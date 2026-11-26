/**
 * PC 身份单测 —— 生成 / 重载 / 损坏重建 / TLS 可用性
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §19.9（自签证书 DER 指纹固定）、
 *   §5.4（指纹短码形态）、§5.7（私钥只进 SecretStorage）
 */
import { describe, expect, it } from 'vitest';
import { createSecureContext } from 'node:tls';
import {
  loadOrCreateRemoteIdentity,
  REMOTE_IDENTITY_SECRET_KEY,
  type RemoteIdentitySecretStore,
} from '../remoteIdentity.js';
// 指纹短码已迁到纯模块（激活链路不加载证书栈），测试按新归属引入
import { shortFingerprint } from '../remoteFingerprint.js';

/** 内存版 SecretStorage（模拟 vscode.secrets 的读写语义） */
class MemorySecretStore implements RemoteIdentitySecretStore {
  /** 键 → 值（测试可直读，验证落库形态） */
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

describe('remoteIdentity — 生成与持久化', () => {
  it('首次生成：指纹为 64 位大写 hex，短码形如 AB12-CD34', async () => {
    const store = new MemorySecretStore();
    const identity = await loadOrCreateRemoteIdentity(store);

    expect(identity.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(identity.shortFp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(identity.shortFp).toBe(
      `${identity.fingerprint.slice(0, 4)}-${identity.fingerprint.slice(4, 8)}`,
    );
    // 落库的是 JSON（keyPem + certPem），不含任何派生指纹字段
    const raw = store.values.get(REMOTE_IDENTITY_SECRET_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['certPem', 'keyPem']);
  });

  it('同一 store 再次读取：指纹 / 密钥 / 证书都不变（证书 DER 派生是稳定的）', async () => {
    const store = new MemorySecretStore();
    const first = await loadOrCreateRemoteIdentity(store);
    const second = await loadOrCreateRemoteIdentity(store);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.keyPem).toBe(first.keyPem);
    expect(second.certPem).toBe(first.certPem);
  });

  it('从另一份 store（同一份落库内容）重载：指纹不变', async () => {
    const source = new MemorySecretStore();
    const created = await loadOrCreateRemoteIdentity(source);
    const target = new MemorySecretStore();
    target.values.set(
      REMOTE_IDENTITY_SECRET_KEY,
      JSON.stringify({
        keyPem: created.keyPem,
        certPem: created.certPem,
      }),
    );

    const reloaded = await loadOrCreateRemoteIdentity(target);
    expect(reloaded.fingerprint).toBe(created.fingerprint);
  });
});

describe('remoteIdentity — 损坏重建', () => {
  it('JSON 解析失败：重建并覆盖写入（不抛错）', async () => {
    const store = new MemorySecretStore();
    store.values.set(REMOTE_IDENTITY_SECRET_KEY, '{ 这不是 JSON');
    const logs: string[] = [];

    const identity = await loadOrCreateRemoteIdentity(store, (m) => logs.push(m));

    expect(identity.fingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(logs.some((line) => line.includes('损坏'))).toBe(true);
    // 覆盖写入后能再次正常解析
    const again = await loadOrCreateRemoteIdentity(store);
    expect(again.fingerprint).toBe(identity.fingerprint);
  });

  it('证书无法解析：重建（不得把坏证书继续喂给 TLS）', async () => {
    const store = new MemorySecretStore();
    store.values.set(
      REMOTE_IDENTITY_SECRET_KEY,
      JSON.stringify({
        keyPem: 'not-a-key',
        certPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      }),
    );

    const identity = await loadOrCreateRemoteIdentity(store);
    expect(identity.certPem).not.toContain('AAAA');
    expect(() =>
      createSecureContext({ key: identity.keyPem, cert: identity.certPem }),
    ).not.toThrow();
  });
});

describe('remoteIdentity — 交给 Node TLS 可用', () => {
  it('keyPem + certPem 能被 tls.createSecureContext 接受', async () => {
    const identity = await loadOrCreateRemoteIdentity(new MemorySecretStore());
    expect(identity.keyPem).toContain('-----BEGIN PRIVATE KEY-----');
    expect(identity.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(() =>
      createSecureContext({ key: identity.keyPem, cert: identity.certPem }),
    ).not.toThrow();
  });

  it('shortFingerprint 只取前 8 hex 且大小写归一', () => {
    const fingerprint = 'ab12cd34' + 'f'.repeat(56);
    expect(shortFingerprint(fingerprint)).toBe('AB12-CD34');
    expect(shortFingerprint('AB12-CD34')).toBe('AB12-CD34');
  });
});
