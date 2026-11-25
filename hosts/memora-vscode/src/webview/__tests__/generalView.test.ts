/**
 * 常规视图运行时测试（`scripts/generalView`）
 *
 * 钉住「自动 / 手动」语言模式的判据边界：
 *   - 模式唯一真源是宿主回推的 `mode`（配置值本身派生），webview 不自行判 `auto` 字面量；
 *   - 自动模式保存写空串（= 宿主「不覆盖」，不是另有 mode 键），手动写输入框值；
 *   - 写入一律发 `general_setting` 给宿主，本模块零配置 API、零本地持久化；
 *   - 初始化回推不弹「已保存」，点过保存才弹——避免把回显谎报成写入成功。
 *
 * 测试形态：jsdom（`@vscode/l10n` 未加载 bundle 时 `t()` 直出英文源文案）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createGeneralView } from '../scripts/generalView.js';
import { buildGeneralBodyHtml } from '../panels/settingsGeneralHtml.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/** 骨架直接取产线构建函数（避免手抄夹具失同步） */
const BODY_HTML = buildGeneralBodyHtml({ t: (s) => s });

function mount(): {
  postMessage: ReturnType<typeof vi.fn>;
  push: (msg: ExtensionToWebviewMessage) => void;
  root: HTMLElement;
} {
  document.body.innerHTML = `<div id="general-root">${BODY_HTML}</div>`;
  const postMessage = vi.fn();
  const root = document.getElementById('general-root') as HTMLElement;
  createGeneralView({
    vscode: { postMessage: postMessage as (msg: WebviewToExtensionMessage) => void },
    window,
    root,
  });
  const push = (msg: ExtensionToWebviewMessage) =>
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  return { postMessage, push, root };
}

/** 取当前 postMessage 里最后一条 general_setting 消息 */
function lastGeneral(postMessage: ReturnType<typeof vi.fn>): WebviewToExtensionMessage & {
  kind: string;
  value: unknown;
} {
  const calls = postMessage.mock.calls.map((c) => c[0] as WebviewToExtensionMessage);
  return calls.filter((m) => m.type === 'general_setting').at(-1) as WebviewToExtensionMessage & {
    kind: string;
    value: unknown;
  };
}

describe('常规视图 — 回答语言自动 / 手动模式', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('自动模式保存写空串（不覆盖），而非写入 auto 字面量', () => {
    const { postMessage, root } = mount();
    (root.querySelector('#answerLanguageInput') as HTMLInputElement).value = '日语';
    (root.querySelector('#answerLanguageSave') as HTMLButtonElement).click();
    expect(lastGeneral(postMessage)).toMatchObject({ kind: 'answerLanguage', value: '' });
  });

  it('手动模式保存写输入框值（trim 后）', () => {
    const { postMessage, root } = mount();
    (root.querySelector('input[value="manual"]') as HTMLInputElement).click();
    (root.querySelector('#answerLanguageInput') as HTMLInputElement).value = '  Japanese  ';
    (root.querySelector('#answerLanguageSave') as HTMLButtonElement).click();
    expect(lastGeneral(postMessage)).toMatchObject({ kind: 'answerLanguage', value: 'Japanese' });
  });

  it('自动模式输入框禁用、手动模式解禁（radio 只表达待保存意图）', () => {
    const { root } = mount();
    const input = root.querySelector('#answerLanguageInput') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    (root.querySelector('input[value="manual"]') as HTMLInputElement).click();
    expect(input.disabled).toBe(false);
    (root.querySelector('input[value="auto"]') as HTMLInputElement).click();
    expect(input.disabled).toBe(true);
  });

  it('宿主回推 mode 是唯一真源：manual + 值能反向改写 UI（webview 不自行判定）', () => {
    const { push, root } = mount();
    const input = root.querySelector('#answerLanguageInput') as HTMLInputElement;
    const manual = root.querySelector('input[value="manual"]') as HTMLInputElement;
    const auto = root.querySelector('input[value="auto"]') as HTMLInputElement;
    push({ type: 'general_setting', kind: 'answerLanguage', mode: 'manual', value: 'Français' });
    expect(manual.checked).toBe(true);
    expect(auto.checked).toBe(false);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('Français');
    push({ type: 'general_setting', kind: 'answerLanguage', mode: 'auto', value: '' });
    expect(auto.checked).toBe(true);
    expect(manual.checked).toBe(false);
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('');
  });

  it('初始化回推不弹「已保存」，点过保存的回推才弹', () => {
    const { push, postMessage, root } = mount();
    const status = root.querySelector('#answerLanguageStatus') as HTMLElement;
    push({ type: 'general_setting', kind: 'answerLanguage', mode: 'auto', value: '' });
    expect(status.hidden).toBe(true);
    (root.querySelector('#answerLanguageSave') as HTMLButtonElement).click();
    expect(status.hidden).toBe(false);
    push({ type: 'general_setting', kind: 'answerLanguage', mode: 'auto', value: '' });
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Saved');
    expect(postMessage).toBeDefined();
  });
});

describe('常规视图 — 交互提示音', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('开关只上报布尔值，不做本地乐观翻转', () => {
    const { postMessage, root } = mount();
    const toggle = root.querySelector('#attentionSoundToggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    toggle.click();
    expect(lastGeneral(postMessage)).toMatchObject({ kind: 'attentionSound', value: true });
  });

  it('宿主回推能改写开关（真源在配置）', () => {
    const { push, root } = mount();
    const toggle = root.querySelector('#attentionSoundToggle') as HTMLInputElement;
    push({ type: 'general_setting', kind: 'attentionSound', value: true });
    expect(toggle.checked).toBe(true);
  });
});
