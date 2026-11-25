/**
 * generalView — 设置面板「常规」选项卡运行时
 *
 * 职责：AI 回答语言的自动 / 手动模式切换与写入、界面语言只读说明（无交互）、
 * 交互提示音与活动指标开关、对话文字三档、会话归档模式、复制诊断动作。持久写入都发
 * `general_setting` 给宿主，由宿主走唯一写入封装 `settingsWrite.writeSetting()`；复制诊断
 * 同通道但按 kind 分流为命令动作（不写配置、不回推），提示由命令自身弹。归档模式入口
 * 2026-11-25 自记忆卡迁入，但消息仍走既有 `archive_mode_set` / `archive_mode_status`——
 * 不为「放在常规页」另开 kind，避免同一配置两条写入通道。本模块零配置 API 调用、
 * 零本地持久化。
 *
 * **模式的唯一真源是配置值本身**：空 / `auto` = 自动（宿主 `responseLanguage.ts` 判定），
 * 非空 = 手动。本模块只按宿主回推的 `mode` 回显，绝不自己再判一次 `auto` 字面量
 * ——否则「自动」的判定会在宿主与 webview 各有一份，改一处就漂移。
 */
import * as l10n from '@vscode/l10n';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

export function createGeneralView({
  vscode,
  window,
  root,
}: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}): void {
  const autoRadio = root.querySelector<HTMLInputElement>(
    'input[name="answerLanguageMode"][value="auto"]',
  );
  const manualRadio = root.querySelector<HTMLInputElement>(
    'input[name="answerLanguageMode"][value="manual"]',
  );
  const input = root.querySelector<HTMLInputElement>('#answerLanguageInput');
  const saveBtn = root.querySelector<HTMLButtonElement>('#answerLanguageSave');
  const statusEl = root.querySelector<HTMLElement>('#answerLanguageStatus');
  const soundToggle = root.querySelector<HTMLInputElement>('#attentionSoundToggle');
  const metricsToggle = root.querySelector<HTMLInputElement>('#showMetricsToggle');
  const copyDiagnosticsBtn = root.querySelector<HTMLButtonElement>('#copyDiagnosticsBtn');
  const scaleRadios = [...root.querySelectorAll<HTMLInputElement>('input[name="chatTextScale"]')];
  // 会话归档模式下拉（内核 archiveMode 投影；入口 2026-11-25 自记忆卡迁入）。
  // 变更只发消息，回显由 host 推 archive_mode_status（与记忆视图同一契约，仅挂载页变了）。
  const archiveModeSelect = root.querySelector<HTMLSelectElement>('#archiveModeSelect');

  /** 当前 UI 模式（只由宿主回推的 mode 改写；用户点 radio 是待保存的意图） */
  let mode: 'auto' | 'manual' = 'auto';
  /** 仅用于「点过保存」的回执显示：初始化回推不应弹「已保存」 */
  let savePending = false;

  function applyMode(next: 'auto' | 'manual'): void {
    mode = next;
    if (autoRadio) autoRadio.checked = next === 'auto';
    if (manualRadio) manualRadio.checked = next === 'manual';
    if (input) input.disabled = next === 'auto';
  }

  autoRadio?.addEventListener('change', () => {
    if (autoRadio.checked) applyMode('auto');
  });
  manualRadio?.addEventListener('change', () => {
    if (manualRadio.checked) applyMode('manual');
  });

  saveBtn?.addEventListener('click', () => {
    // 自动模式写空串 = 宿主读到的「不覆盖」，不是另有 mode 键存真值。
    const value = mode === 'auto' ? '' : (input?.value ?? '').trim();
    savePending = true;
    vscode.postMessage({ type: 'general_setting', kind: 'answerLanguage', value });
    if (statusEl) {
      statusEl.textContent = l10n.t('Saving…');
      statusEl.hidden = false;
    }
  });

  soundToggle?.addEventListener('change', () => {
    vscode.postMessage({
      type: 'general_setting',
      kind: 'attentionSound',
      value: soundToggle.checked,
    });
  });

  metricsToggle?.addEventListener('change', () => {
    vscode.postMessage({
      type: 'general_setting',
      kind: 'showMetrics',
      value: metricsToggle.checked,
    });
  });

  // 三档只发档位名，px 映射在宿主 CSS 令牌层一处完成；webview 不自己存第二份值。
  for (const radio of scaleRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) {
        vscode.postMessage({ type: 'general_setting', kind: 'chatTextScale', value: radio.value });
      }
    });
  }

  // 动作型 kind：不写配置、不等回执。宿主复用命令面板同一命令提示，
  // webview 乐观显示「已复制」会在命令失败时谎报成功。
  copyDiagnosticsBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'general_setting', kind: 'copyDiagnostics' });
  });

  // 归档模式切换：只发消息（持久化 + 热更新 + 回推全在 host 侧，webview 不做乐观翻转）。
  // 下拉是封闭枚举（full/manual）：越界值（DOM 被篡改）不发送——host 侧亦有同一校验。
  archiveModeSelect?.addEventListener('change', () => {
    const mode = archiveModeSelect.value;
    if (mode === 'full' || mode === 'manual') {
      vscode.postMessage({ type: 'archive_mode_set', mode });
    }
  });

  // 归档模式的回显不是 general_setting：必须在下面的 kind 分流 **之前** 接住，
  // 否则会被 `msg.type !== 'general_setting'` 提前 return，下拉永远停在旧偏好上。
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'archive_mode_status') {
      if (archiveModeSelect) archiveModeSelect.value = msg.mode;
      return;
    }
    if (msg.type !== 'general_setting') return;
    // 按 kind 显式分发：不可「非 answerLanguage 就当提示音」，否则新增回推会静默写错控件。
    if (msg.kind === 'answerLanguage') {
      applyMode(msg.mode);
      if (input) input.value = msg.value;
      if (statusEl && savePending) {
        statusEl.textContent = l10n.t('Saved');
        statusEl.hidden = false;
        savePending = false;
      }
      return;
    }
    if (msg.kind === 'attentionSound') {
      if (soundToggle) soundToggle.checked = msg.value;
      return;
    }
    if (msg.kind === 'showMetrics') {
      if (metricsToggle) metricsToggle.checked = msg.value;
      return;
    }
    if (msg.kind === 'chatTextScale') {
      for (const radio of scaleRadios) radio.checked = radio.value === msg.value;
    }
  });
}
