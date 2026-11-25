/**
 * generalView — 设置面板「常规」选项卡运行时
 *
 * 职责：AI 回答语言的自动 / 手动模式切换与写入、界面语言只读说明（无交互）、
 * 交互提示音与活动指标开关、复制诊断动作。持久写入都发 `general_setting` 给宿主，
 * 由宿主走唯一写入封装 `settingsWrite.writeSetting()`；复制诊断同通道但按 kind
 * 分流为命令动作（不写配置、不回推），提示由命令自身弹。本模块零配置 API 调用、
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

  // 动作型 kind：不写配置、不等回执。宿主复用命令面板同一命令提示，
  // webview 乐观显示「已复制」会在命令失败时谎报成功。
  copyDiagnosticsBtn?.addEventListener('click', () => {
    vscode.postMessage({ type: 'general_setting', kind: 'copyDiagnostics' });
  });

  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
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
    if (msg.kind === 'showMetrics' && metricsToggle) metricsToggle.checked = msg.value;
  });
}
