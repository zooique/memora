/**
 * 远程设置页「对外地址」动作执行面单测
 *
 * 锁三件事：
 *   ① 合法地址经宿主单点校验后落用户级存储，成功提示说明必须重新配对；
 *   ② 非法地址不落盘、回可读错误（页面 finally 回推旧真值复位输入框）；
 *   ③ 执行面缺存储注入时如实失败，不伪造「已保存」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  env: { clipboard: { writeText: vi.fn(async () => undefined) } },
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn() },
}));

vi.mock('../remoteBridgeHost.js', () => ({
  applyDeviceAction: vi.fn(),
  getRemoteBridgeRuntime: vi.fn(() => undefined),
  getRemoteLanHandle: vi.fn(() => undefined),
  regenerateLanPairingCode: vi.fn(),
  toggleRemoteBridge: vi.fn(async () => ({ ok: true })),
}));

import {
  applyRemoteSettingsAction,
  readRemoteSettingsStatus,
} from '../remoteSettingsOps.js';
import {
  readPublicAddress,
  REMOTE_PUBLIC_ADDRESS_KEY,
  writePublicAddress,
  type PublicAddressMemento,
} from '../remotePublicAddress.js';

/** 最小 Memento 桩 */
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

describe('remoteSettingsOps 对外地址动作', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('合法地址落盘并明确提示重新配对', async () => {
    const memento = makeMemento();
    const result = await applyRemoteSettingsAction(
      { action: 'set_public_address', address: '  home.example.com:5890  ' },
      memento,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('pair the phone again');
    expect(memento.values.get(REMOTE_PUBLIC_ADDRESS_KEY)).toBe('home.example.com:5890');
    expect(readPublicAddress(memento)).toEqual({ host: 'home.example.com', port: 5890 });
  });

  it('非法地址不写盘，错误文案可读', async () => {
    const memento = makeMemento();
    const result = await applyRemoteSettingsAction(
      { action: 'set_public_address', address: 'wss://evil.example' },
      memento,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid public address');
    expect(memento.values.has(REMOTE_PUBLIC_ADDRESS_KEY)).toBe(false);
  });

  it('已有配置不被非法输入覆盖', async () => {
    const memento = makeMemento();
    await applyRemoteSettingsAction(
      { action: 'set_public_address', address: 'home.example.com:5890' },
      memento,
    );
    await applyRemoteSettingsAction(
      { action: 'set_public_address', address: '0.0.0.0' },
      memento,
    );
    expect(memento.values.get(REMOTE_PUBLIC_ADDRESS_KEY)).toBe('home.example.com:5890');
  });

  it('缺存储注入：如实失败，不谎报成功', async () => {
    const result = await applyRemoteSettingsAction({
      action: 'set_public_address',
      address: 'home.example.com',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unavailable');
  });

  it('桥未启动也回推已配置地址：先配域名再开桥不被吞', async () => {
    const memento = makeMemento();
    await writePublicAddress(memento, 'home.example.com:5890');
    // getRemoteBridgeRuntime / getRemoteLanHandle 已 mock 为 undefined = 桥未启动
    const status = await readRemoteSettingsStatus({
      globalState: memento,
      globalStorageUri: { fsPath: '/nonexistent-memora-audit-dir' },
    } as never);
    expect(status.mode).toBe('off');
    expect(status.publicAddress).toBe('home.example.com:5890');
  });

  it('留空 = 清除：回落 LAN，不按「无效地址」拒绝', async () => {
    const memento = makeMemento();
    await applyRemoteSettingsAction(
      { action: 'set_public_address', address: 'home.example.com:5890' },
      memento,
    );
    const result = await applyRemoteSettingsAction(
      { action: 'set_public_address', address: '   ' },
      memento,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('cleared');
    expect(readPublicAddress(memento)).toBeUndefined();
  });
});
