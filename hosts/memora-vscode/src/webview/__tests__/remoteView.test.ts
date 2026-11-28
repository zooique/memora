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
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('remoteView', () => {
  it('未启动：如实显示未启动，配对相关行隐藏，重发口令禁用', () => {
    const { el } = mount();
    push(baseStatus());
    expect(el('remoteModeText').textContent).toBe('Bridge is not running.');
    expect((el('remoteRegenerateBtn') as HTMLButtonElement).disabled).toBe(true);
    expect(el('remotePairingText').hidden).toBe(true);
    expect(el('remotePairingLinkBox').hidden).toBe(true);
    expect(el('remoteDeviceEmpty').hidden).toBe(false);
    expect(el('remoteAuditEmpty').hidden).toBe(false);
  });

  it('开发回环：显示回环端口而不是「未启动」', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'loopback', port: 4010 }));
    const mode = el('remoteModeText');
    expect(mode.textContent).toContain('Development loopback');
    expect(mode.textContent).toContain('127.0.0.1:4010');
    // 回环地址手机拨不到：文案必须显式说清，避免误以为「配对失败是手机的问题」
    expect(mode.textContent).toContain('Phones cannot reach');
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
        pairingLink: 'memora-pair://v1?h=192.168.1.9&p=4123&pin=-_--7wECAwQ&c=123456',
        devices: [
          {
            fingerprint: 'FP-1',
            shortFp: 'AAAA1111',
            name: 'Phone',
            tier: 'observe',
            pairedAt: 1,
            online: true,
          },
        ],
        audit: [{ at: Date.now(), event: 'device_paired', detail: 'Phone' }],
      }),
    );
    expect(el('remoteModeText').textContent).toContain('192.168.1.9:4123');
    expect(el('remoteFingerprintText').textContent).toBe('PC fingerprint: ABCD1234');
    expect(el('remotePairingText').textContent).toContain('123456');
    expect((el('remoteRegenerateBtn') as HTMLButtonElement).disabled).toBe(false);
    expect(el('remotePairingLinkBox').hidden).toBe(false);
    expect(el('remotePairingLinkText').textContent).toBe(
      'memora-pair://v1?h=192.168.1.9&p=4123&pin=-_--7wECAwQ&c=123456',
    );
    (el('remoteCopyLinkBtn') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'remote_settings', action: 'copy_pairing' });

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
            online: false,
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

  it('启停开关：文案只从宿主 mode 派生，点击只上报 toggle 意图', () => {
    const { el, postMessage } = mount();
    push(baseStatus());
    expect(el('remoteToggleBtn').textContent).toBe('Enable remote control');
    expect(el('remoteToggleBtn').title).toBe('Start the LAN bridge for this window');
    (el('remoteToggleBtn') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'remote_settings', action: 'toggle' });

    // 回环也在监听：同样显示关闭，不能把开发档谎报成未启动
    push(baseStatus({ mode: 'loopback', port: 4010 }));
    expect(el('remoteToggleBtn').textContent).toBe('Disable remote control');

    push(baseStatus({ mode: 'lan', address: '192.168.1.9', port: 4123 }));
    expect(el('remoteToggleBtn').textContent).toBe('Disable remote control');
    expect(el('remoteToggleBtn').title).toBe('Stop the remote bridge for this window');
  });

  it('局域网但地址未识别：如实说「拨不到」，不把 0.0.0.0 当可用地址', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'lan', address: '0.0.0.0', port: 4123 }));
    expect(el('remoteModeText').textContent).toContain('no LAN address was detected');
    expect(el('remoteAddressText').hidden).toBe(true);
    expect(el('remotePairingLinkBox').hidden).toBe(true);
  });

  it('口令到期：到点自动请求刷新（过期码不在屏上滞留）', () => {
    vi.useFakeTimers();
    const { postMessage } = mount();
    push(
      baseStatus({
        mode: 'lan',
        address: '192.168.1.9',
        port: 4123,
        pairingCode: '123456',
        pairingExpiresAt: Date.now() + 60_000,
        pairingLink: 'memora-pair://v1?h=192.168.1.9&p=4123&pin=AA&c=123456',
      }),
    );
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000 + 100);
    expect(postMessage).toHaveBeenCalledWith({ type: 'remote_settings', action: 'refresh' });
  });

  it('对外地址：回显宿主真值，地址行显示手机实际拨的地址', () => {
    const { el } = mount();
    const input = el('remotePublicAddressInput') as HTMLInputElement;
    push(baseStatus({ mode: 'lan', address: '192.168.1.9', port: 4123 }));
    expect(input.value).toBe('');
    expect(el('remoteAddressText').textContent).toBe('Address: 192.168.1.9:4123');

    push(
      baseStatus({
        mode: 'lan',
        address: '192.168.1.9',
        port: 4123,
        publicAddress: 'home.example.com:5890',
      }),
    );
    expect(input.value).toBe('home.example.com:5890');
    expect(el('remoteAddressText').textContent).toBe('Address: home.example.com:5890');
  });

  it('对外地址：保存只上报原文，键入中回推不吞输入', () => {
    const { el, postMessage } = mount();
    const input = el('remotePublicAddressInput') as HTMLInputElement;
    const status = baseStatus({
      mode: 'lan',
      address: '192.168.1.9',
      port: 4123,
      publicAddress: 'home.example.com:5890',
    });
    push(status);

    input.focus();
    input.value = 'other.example:6000';
    push(status);
    expect(input.value).toBe('other.example:6000');

    (el('remotePublicAddressSaveBtn') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'remote_settings',
      action: 'set_public_address',
      address: 'other.example:6000',
    });
  });

  it('从正常 LAN 切到无地址：指纹行不残留上一档的值', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'lan', address: '192.168.1.9', port: 4123, pcShortFp: 'ABCD1234' }));
    expect(el('remoteFingerprintText').textContent).toContain('ABCD1234');

    push(baseStatus({ mode: 'lan', address: '0.0.0.0', port: 4123, pcShortFp: 'ABCD1234' }));
    expect(el('remoteFingerprintText').textContent).toBe('');
    expect(el('remoteFingerprintText').hidden).toBe(true);
  });

  it('本机地址未识别但有对外地址：如实说可经该地址连接，不谎报拨不到', () => {
    const { el } = mount();
    push(baseStatus({ mode: 'lan', address: '0.0.0.0', port: 4123 }));
    expect(el('remoteModeText').textContent).toContain('no LAN address was detected');

    push(
      baseStatus({
        mode: 'lan',
        address: '0.0.0.0',
        port: 4123,
        publicAddress: 'home.example.com:5890',
      }),
    );
    expect(el('remoteModeText').textContent).toContain('home.example.com:5890');
    expect(el('remoteAddressText').hidden).toBe(false);
    expect(el('remoteAddressText').textContent).toBe('Address: home.example.com:5890');
  });
});
