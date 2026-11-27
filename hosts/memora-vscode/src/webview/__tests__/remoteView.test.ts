// @vitest-environment jsdom
/**
 * remoteView — 设置页「远程控制」的渲染与动作意图测试
 *
 * 守住四件事：
 *   ① 三种模式如实区分（未启动 / 开发回环 / 局域网），不把 loopback 显示成未启动；
 *   ② 设备表按快照渲染，当前档位按钮禁用（避免「点了没反应」的第三种形态）；
 *   ③ 点击只上报动作意图（确认 / 审计在宿主，不在 webview 复制判据）；
 *   ④ 手机声明的设备名是外部输入：只作文本渲染，绝不生成元素。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRemoteBodyHtml } from '../panels/settingsRemoteHtml.js';
import { createRemoteView } from '../scripts/remoteView.js';
import type { RemoteSettingsStatus } from '../../shared/protocol.js';

/**
 * 构造一份状态快照（未指定字段取「未启动 + 空表」的最小形态）
 *
 * @param over 覆盖字段
 */
function baseStatus(over: Partial<RemoteSettingsStatus> = {}): RemoteSettingsStatus {
  return { mode: 'off', devices: [], audit: [], ...over };
}

/**
 * 挂载视图并取常用节点
 */
function mount(): {
  postMessage: ReturnType<typeof vi.fn>;
  root: HTMLElement;
  el: (id: string) => HTMLElement;
} {
  document.body.innerHTML = `<div id="remote-root">${buildRemoteBodyHtml({ t: (s) => s })}</div>`;
  const postMessage = vi.fn();
  const root = document.getElementById('remote-root') as HTMLElement;
  createRemoteView({ vscode: { postMessage }, window, root });
  return { postMessage, root, el: (id) => root.querySelector(`#${id}`) as HTMLElement };
}

/**
 * 模拟宿主推送状态
 *
 * @param status 状态快照
 */
function push(status: RemoteSettingsStatus): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'remote_settings', status } }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('remoteView', () => {
  it('未启动：如实显示未启动，配对相关行隐藏，重发口令禁用', () => {
    const { el } = mount();
    push(baseStatus());
    expect(el('remoteModeText').textContent).toBe('Bridge is not running.');
    expect((el('remoteRegenerateBtn') as HTMLButtonElement).disabled).toBe(true);
    expect(el('remotePairingText').hidden).toBe(true);
    expect(el('remoteDeviceEmpty').hidden).toBe(false);
    expect(el('remoteAuditEmpty').hidden).toBe(false);
  });

  it('开发回环：显示回环端口而不是「未启动」', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'loopback', port: 4010 }));
    const mode = el('remoteModeText');
    expect(mode.textContent).toContain('Development loopback');
    expect(mode.textContent).toContain('127.0.0.1:4010');
    expect((el('remoteRegenerateBtn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('局域网：渲染地址 / 指纹 / 口令 / 设备表 / 审计，当前档位按钮禁用', () => {
    const { el, root, postMessage } = mount();
    push(
      baseStatus({
        mode: 'lan',
        address: '192.168.1.9',
        port: 4123,
        pcShortFp: 'ABCD1234',
        pairingCode: '123456',
        pairingExpiresAt: Date.now() + 60_000,
        devices: [
          {
            fingerprint: 'FP-1',
            shortFp: 'AAAA1111',
            name: 'Phone',
            tier: 'observe',
            pairedAt: 1,
          },
        ],
        audit: [{ at: Date.now(), event: 'device_paired', detail: 'Phone' }],
      }),
    );
    expect(el('remoteModeText').textContent).toContain('192.168.1.9:4123');
    expect(el('remoteFingerprintText').textContent).toBe('PC fingerprint: ABCD1234');
    expect(el('remotePairingText').textContent).toContain('123456');
    expect((el('remoteRegenerateBtn') as HTMLButtonElement).disabled).toBe(false);

    const row = root.querySelector<HTMLElement>('.remote-device');
    expect(row).not.toBeNull();
    const observeBtn = row?.querySelector<HTMLButtonElement>('button[data-tier="observe"]');
    expect(observeBtn?.disabled).toBe(true);

    row?.querySelector<HTMLButtonElement>('button[data-tier="approve"]')?.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'remote_settings',
      action: 'set_tier',
      fingerprint: 'FP-1',
      tier: 'approve',
    });
    row?.querySelector<HTMLButtonElement>('[data-remote-act="revoke"]')?.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'remote_settings',
      action: 'revoke',
      fingerprint: 'FP-1',
    });

    expect(root.querySelectorAll('.remote-audit-row').length).toBe(1);
    expect(el('remoteAuditEmpty').hidden).toBe(true);
  });

  it('设备名按文本渲染：不生成元素、不执行标记', () => {
    const { root } = mount();
    push(
      baseStatus({
        mode: 'lan',
        address: '192.168.1.9',
        port: 4123,
        devices: [
          {
            fingerprint: 'FP-2',
            shortFp: '',
            name: '<img src=x onerror=alert(1)>',
            tier: 'send',
            pairedAt: 1,
          },
        ],
      }),
    );
    expect(root.querySelector('.remote-device-name')?.textContent).toContain('<img');
    expect(root.querySelector('img')).toBeNull();
  });

  it('审计读取失败：显示错误并隐藏「没有记录」，不伪装成空态', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'lan', address: '192.168.1.9', port: 4123, auditError: 'EACCES' }));
    expect(el('remoteAuditError').hidden).toBe(false);
    expect(el('remoteAuditError').textContent).toContain('EACCES');
    expect(el('remoteAuditEmpty').hidden).toBe(true);
  });

  it('刷新与重发口令：分别上报对应动作', () => {
    const { el, postMessage } = mount();
    push(baseStatus({ mode: 'lan', address: '192.168.1.9', port: 4123 }));
    (el('remoteRefreshBtn') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'remote_settings', action: 'refresh' });
    (el('remoteRegenerateBtn') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'remote_settings', action: 'regenerate' });
  });
});
