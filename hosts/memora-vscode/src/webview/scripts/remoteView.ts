/**
 * remoteView — 设置面板「远程控制」选项卡运行时
 *
 * 职责：渲染宿主回推的状态快照（`remote_settings` 带 `status`），并把用户点击
 * 转成动作意图（同一条 `remote_settings` 消息带上 `action`）。
 *
 * 真理源纪律：
 *   - 页面**不判档位合法性、不判设备是否存在**——那是宿主设备表的活；UI 只渲染；
 *   - 所有外部可控文本（手机声明的设备名 / 短码 / 审计 detail）一律走 `textContent`
 *     或 `createElement`，不拼进 innerHTML（与技能正文防注入同口径）；
 *   - 高风险动作（改「可答」/ 撤销）不做本地二次确认：宿主 `applyDeviceAction`
 *     已有模态确认 + 审计，重复确认 = 第二套判据。
 */
import * as l10n from '@vscode/l10n';
import type {
  ExtensionToWebviewMessage,
  RemoteDeviceDto,
  RemoteDeviceTier,
  RemoteSettingsStatus,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/**
 * 权限档的展示顺序（`Record` 穷尽：宿主将来加档位时这里编译红，不会静默少一个按钮）
 *
 * webview 侧仅用于渲染顺序与 DOM 数据集收窄，不承担授权判据（真源在宿主设备表）。
 */
const TIER_ORDER: Record<RemoteDeviceTier, true> = { observe: true, send: true, approve: true };
const TIERS = Object.keys(TIER_ORDER) as RemoteDeviceTier[];

/**
 * 档位 → 界面话术（英文源键，本地化在 `l10n.t` 处完成）
 *
 * @param tier 权限档
 */
function tierLabel(tier: RemoteDeviceTier): string {
  if (tier === 'observe') return l10n.t('Read only');
  if (tier === 'send') return l10n.t('Send');
  return l10n.t('Approve');
}

/**
 * 收窄数据集里的档位字符串
 *
 * @param value DOM `data-tier` 原值
 */
function isTier(value: string | undefined): value is RemoteDeviceTier {
  return value !== undefined && (TIERS as readonly string[]).includes(value);
}

/**
 * 初始化远程控制子视图交互
 *
 * @param deps vscode 通信口 + window + 本页根容器（`MountFactory` 同款签名）
 */
export function createRemoteView({
  vscode,
  window,
  root,
}: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}): void {
  const modeText = root.querySelector<HTMLElement>('#remoteModeText');
  const addressText = root.querySelector<HTMLElement>('#remoteAddressText');
  const fingerprintText = root.querySelector<HTMLElement>('#remoteFingerprintText');
  const pairingText = root.querySelector<HTMLElement>('#remotePairingText');
  const pairingLinkBox = root.querySelector<HTMLElement>('#remotePairingLinkBox');
  const pairingLinkText = root.querySelector<HTMLElement>('#remotePairingLinkText');
  const regenerateBtn = root.querySelector<HTMLButtonElement>('#remoteRegenerateBtn');
  const deviceList = root.querySelector<HTMLUListElement>('#remoteDeviceList');
  const deviceEmpty = root.querySelector<HTMLElement>('#remoteDeviceEmpty');
  const auditList = root.querySelector<HTMLUListElement>('#remoteAuditList');
  const auditEmpty = root.querySelector<HTMLElement>('#remoteAuditEmpty');
  const auditError = root.querySelector<HTMLElement>('#remoteAuditError');

  /** 当前状态快照（仅用于渲染，不作为动作判据） */
  let status: RemoteSettingsStatus | undefined;

  /**
   * 写一行状态文本（空串 = 隐藏该行，避免留下空 `<p>` 的间距）
   *
   * @param el   目标元素
   * @param text 文本内容（已本地化）
   */
  function setLine(el: HTMLElement | null, text: string): void {
    if (!el) return;
    el.textContent = text;
    el.hidden = text === '';
  }

  /** 渲染设备表（重建列表；条目文本全走 textContent） */
  function renderDevices(devices: RemoteDeviceDto[]): void {
    if (!deviceList) return;
    deviceList.textContent = '';
    if (deviceEmpty) deviceEmpty.hidden = devices.length > 0;
    deviceList.hidden = devices.length === 0;
    for (const device of devices) {
      const row = document.createElement('li');
      row.className = 'remote-device';

      const info = document.createElement('div');
      info.className = 'remote-device-info';
      const name = document.createElement('span');
      name.className = 'remote-device-name';
      // 短码缺失时只显示名称，避免尾随分隔符（与命令层 deviceMenuLabel 同一口径）
      name.textContent = device.shortFp ? `${device.name} · ${device.shortFp}` : device.name;
      const tier = document.createElement('span');
      tier.className = 'remote-device-tier';
      tier.textContent = tierLabel(device.tier);
      info.append(name, tier);

      const actions = document.createElement('div');
      actions.className = 'remote-device-actions';
      for (const target of TIERS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost';
        btn.dataset.remoteAct = 'set_tier';
        btn.dataset.fingerprint = device.fingerprint;
        btn.dataset.tier = target;
        btn.textContent = tierLabel(target);
        btn.title = l10n.t('Change permission to {0}', tierLabel(target));
        // 当前档位不给可点按钮（点了也没效果的第三种形态）
        btn.disabled = device.tier === target;
        actions.appendChild(btn);
      }
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'btn btn-ghost remote-revoke';
      revoke.dataset.remoteAct = 'revoke';
      revoke.dataset.fingerprint = device.fingerprint;
      revoke.textContent = l10n.t('Revoke');
      actions.appendChild(revoke);

      row.append(info, actions);
      deviceList.appendChild(row);
    }
  }

  /** 渲染审计尾（最新在后；`detail` 是外部可控文本，走 textContent） */
  function renderAudit(statusValue: RemoteSettingsStatus): void {
    if (!auditList) return;
    auditList.textContent = '';
    const rows = statusValue.audit;
    if (auditError) {
      auditError.hidden = !statusValue.auditError;
      auditError.textContent = statusValue.auditError
        ? l10n.t('Audit log could not be read: {0}', statusValue.auditError)
        : '';
    }
    if (auditEmpty) auditEmpty.hidden = rows.length > 0 || Boolean(statusValue.auditError);
    auditList.hidden = rows.length === 0;
    for (const item of rows) {
      const row = document.createElement('li');
      row.className = 'remote-audit-row';
      const time = document.createElement('span');
      time.className = 'remote-audit-time';
      time.textContent = new Date(item.at).toLocaleTimeString();
      const event = document.createElement('span');
      event.className = 'remote-audit-event';
      event.textContent = item.detail ? `${item.event} — ${item.detail}` : item.event;
      row.append(time, event);
      auditList.appendChild(row);
    }
  }

  /** 按模式渲染桥状态行（未启动 / 开发回环 / 局域网三态如实区分） */
  function renderMode(next: RemoteSettingsStatus): void {
    if (next.mode === 'lan') {
      setLine(
        modeText,
        l10n.t(
          'LAN bridge listening on {0}:{1}.',
          next.address ?? '0.0.0.0',
          String(next.port ?? ''),
        ),
      );
      setLine(
        addressText,
        l10n.t('Address: {0}', `${next.address ?? '0.0.0.0'}:${next.port ?? ''}`),
      );
      setLine(fingerprintText, next.pcShortFp ? l10n.t('PC fingerprint: {0}', next.pcShortFp) : '');
      if (next.pairingCode && next.pairingExpiresAt) {
        setLine(
          pairingText,
          l10n.t(
            'Pairing code {0} · valid until {1}',
            next.pairingCode,
            new Date(next.pairingExpiresAt).toLocaleTimeString(),
          ),
        );
      } else {
        setLine(pairingText, l10n.t('No active pairing code.'));
      }
      return;
    }
    if (next.mode === 'loopback') {
      setLine(
        modeText,
        l10n.t(
          'Development loopback listening on 127.0.0.1:{0} (no pairing).',
          String(next.port ?? ''),
        ),
      );
    } else {
      setLine(modeText, l10n.t('Bridge is not running.'));
    }
    // 回环 / 未启动：配对相关行无意义，清空即如实（不显示上一档的残留值）
    setLine(addressText, '');
    setLine(fingerprintText, '');
    setLine(pairingText, '');
  }

  /**
   * 渲染一次完整状态
   *
   * @param next 宿主回推的快照
   */
  function render(next: RemoteSettingsStatus): void {
    status = next;
    renderMode(next);
    // 连接串只在宿主给出时展示（过期 / 地址未识别 ⇒ 隐藏，绝不显示必然失败的串）
    if (pairingLinkBox && pairingLinkText) {
      const link = next.pairingLink;
      pairingLinkBox.hidden = !link;
      pairingLinkText.textContent = link ?? '';
    }
    // 只有局域网档能生成配对口令：回环档没有配对概念，按钮禁用而不是点了必失败
    if (regenerateBtn) regenerateBtn.disabled = status.mode !== 'lan';
    renderDevices(next.devices);
    renderAudit(next);
  }

  // 宿主 → 本页：只接状态回推（上行同名消息不会回到本进程）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type !== 'remote_settings') return;
    render(msg.status);
  });

  // 本页 → 宿主：动作意图（执行面 / 确认 / 审计全在宿主）
  root.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLElement>('[data-remote-act]');
    if (!btn) return;
    const action = btn.dataset.remoteAct;
    if (action === 'refresh') {
      vscode.postMessage({ type: 'remote_settings', action: 'refresh' });
      return;
    }
    if (action === 'regenerate') {
      if (status?.mode !== 'lan') return;
      vscode.postMessage({ type: 'remote_settings', action: 'regenerate' });
      return;
    }
    if (action === 'copy_pairing') {
      // 无连接串时按钮不该可见；这里再守一次，避免「点了没反应」被当成复制成功
      if (!status?.pairingLink) return;
      vscode.postMessage({ type: 'remote_settings', action: 'copy_pairing' });
      return;
    }
    const fingerprint = btn.dataset.fingerprint;
    if (!fingerprint) return;
    if (action === 'revoke') {
      vscode.postMessage({ type: 'remote_settings', action: 'revoke', fingerprint });
      return;
    }
    const tier = btn.dataset.tier;
    if (action === 'set_tier' && isTier(tier)) {
      vscode.postMessage({ type: 'remote_settings', action: 'set_tier', fingerprint, tier });
    }
  });
}
