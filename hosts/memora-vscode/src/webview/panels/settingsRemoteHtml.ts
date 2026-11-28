/**
 * 设置面板「远程控制」选项卡 HTML 主体片段
 *
 * 职责边界：只提供静态 DOM 骨架，零逻辑。状态与设备表由宿主 `remoteSettingsOps`
 * 读取后经 `remote_settings` 推送，交互（刷新 / 重发口令 / 改档 / 撤销）由
 * `scripts/remoteView.ts` 承担。
 *
 * 文案纪律（判据⑰）：本文件所有用户可见文案一律走 `l10n.t` 英文源键，注释外零 CJK。
 * 环境变量只做「窗口启动预设」；页内开关管当前窗口的运行时，状态真源仍由宿主回推。
 *
 * root 容器不由本片段自带，由 `settingsPanelHtml.ts` 的 `buildHtml` 统一生成
 * （id 由 `settingsRootId('remote')` 派生）。
 */
export function buildRemoteBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `
  <!-- 远程控制子视图（remote 选项卡：桥状态 / 配对与设备表 / 审计尾） -->
    <div class="header">
      <h2>${l10n.t('Remote control')}</h2>
      <div class="header-actions">
        <button id="remoteToggleBtn" class="btn btn-secondary" type="button" data-remote-act="toggle">${l10n.t('Enable remote control')}</button>
        <button id="remoteRefreshBtn" class="btn btn-secondary" type="button" data-remote-act="refresh">${l10n.t('Refresh')}</button>
      </div>
    </div>
    <p id="remoteModeText" class="hint">${l10n.t('Checking bridge status…')}</p>
    <div class="remote-section">
      <div class="remote-item">
        <div class="remote-item-header">
          <span class="remote-label">${l10n.t('Bridge')}</span>
          <button id="remoteRegenerateBtn" class="btn btn-secondary" type="button" data-remote-act="regenerate">${l10n.t('New pairing code')}</button>
        </div>
        <p id="remoteAddressText" class="remote-value"></p>
        <p id="remoteFingerprintText" class="remote-value"></p>
        <p id="remotePairingText" class="remote-value"></p>
        <div id="remotePairingLinkBox" hidden>
          <div class="remote-item-header">
            <span class="remote-label">${l10n.t('Pairing link')}</span>
            <button id="remoteCopyLinkBtn" class="btn btn-secondary" type="button" data-remote-act="copy_pairing">${l10n.t('Copy pairing link')}</button>
          </div>
          <code id="remotePairingLinkText" class="remote-link-text"></code>
          <p class="hint">${l10n.t('Send this link to one phone. It carries the PC certificate, a client identity for that phone and a one-time code, and expires together with the code. Generate a new pairing code for every phone — one link registers one device (up to 3).')}</p>
        </div>
        <p class="hint">${l10n.t('Use the switch above to start or stop the bridge for this window. MEMORA_REMOTE_BRIDGE only presets the state at window startup (lan, or loopback for development); changing it requires a window reload.')}</p>
      </div>
    </div>
    <div class="remote-section">
      <div class="remote-item-header">
        <span class="remote-label">${l10n.t('Paired devices')}</span>
      </div>
      <p class="hint">${l10n.t('Up to 3 devices can be paired. Each pairing code registers one phone, so generate a new code for every phone. Revoke a device before pairing a fourth.')}</p>
      <ul id="remoteDeviceList" class="remote-list"></ul>
      <p id="remoteDeviceEmpty" class="hint">${l10n.t('No device is paired yet. Use "New pairing code" and confirm the phone on this PC.')}</p>
    </div>
    <div class="remote-section">
      <div class="remote-item-header">
        <span class="remote-label">${l10n.t('Recent activity')}</span>
      </div>
      <ul id="remoteAuditList" class="remote-list"></ul>
      <p id="remoteAuditEmpty" class="hint">${l10n.t('No remote activity has been recorded yet.')}</p>
      <p id="remoteAuditError" class="hint remote-error" hidden></p>
    </div>
`;
}
