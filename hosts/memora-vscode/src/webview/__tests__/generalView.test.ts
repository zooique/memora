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
import { buildMemoryBodyHtml } from '../panels/settingsMemoryHtml.js';
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

describe('常规视图 — 活动指标', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('开关只上报 showMetrics 布尔值，不做本地乐观翻转', () => {
    const { postMessage, root } = mount();
    const toggle = root.querySelector('#showMetricsToggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    toggle.click();
    expect(lastGeneral(postMessage)).toMatchObject({ kind: 'showMetrics', value: true });
  });

  it('宿主回推按 kind 改写指标开关，不串写提示音（隐式 fallthrough 会在此真红）', () => {
    const { push, root } = mount();
    const metrics = root.querySelector('#showMetricsToggle') as HTMLInputElement;
    const sound = root.querySelector('#attentionSoundToggle') as HTMLInputElement;
    push({ type: 'general_setting', kind: 'showMetrics', value: true });
    expect(metrics.checked).toBe(true);
    expect(sound.checked).toBe(false);
    push({ type: 'general_setting', kind: 'attentionSound', value: true });
    expect(sound.checked).toBe(true);
    expect(metrics.checked).toBe(true);
  });
});

describe('常规视图 — 复制诊断', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('按钮只发动作 kind：不带 value，也不在本地谎报「已复制」', () => {
    const { postMessage, root } = mount();
    (root.querySelector('#copyDiagnosticsBtn') as HTMLButtonElement).click();
    const msg = lastGeneral(postMessage);
    expect(msg.kind).toBe('copyDiagnostics');
    expect('value' in msg).toBe(false);
    expect((root.querySelector('#answerLanguageStatus') as HTMLElement).hidden).toBe(true);
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

// ─── 会话归档模式（2026-11-25 自记忆卡迁入常规卡） ───
// 消息仍走 archive_mode_set / archive_mode_status，不另开 general_setting kind。
describe('常规视图 — 会话归档模式', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('入口只在常规卡：产线骨架含下拉，记忆卡骨架不再含（搬迁结构守卫）', () => {
    expect(BODY_HTML).toContain('archiveModeSelect');
    expect(buildMemoryBodyHtml({ t: (s) => s })).not.toContain('archiveModeSelect');
  });

  it('切换归档模式 → post archive_mode_set（合法枚举才发送）', () => {
    const { postMessage, root } = mount();
    const select = root.querySelector('#archiveModeSelect') as HTMLSelectElement;
    select.value = 'manual';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'archive_mode_set', mode: 'manual' });
  });

  it('archive_mode_status 回推 → 下拉回显（host 真相覆盖本地值）', () => {
    const { push, root } = mount();
    const select = root.querySelector('#archiveModeSelect') as HTMLSelectElement;
    select.value = 'manual';
    push({ type: 'archive_mode_status', mode: 'full' });
    expect(select.value).toBe('full');
  });

  it('首屏不发 archive_mode_set（等 host ready 握手回推，不主动推送偏好）', () => {
    const { postMessage } = mount();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'archive_mode_set' }),
    );
  });

  it('下拉被注入非法 option 并选中 → 不发送（DOM 篡改零信任）', () => {
    // 生产判据：change 处理器在发送前的枚举自校验（`mode === 'full' || mode === 'manual'`）。
    // 下拉只是渲染层封闭枚举，DOM 可被篡改；host 侧亦有同一校验（纵深防御第二道）。
    const { postMessage, root } = mount();
    const select = root.querySelector('#archiveModeSelect') as HTMLSelectElement;
    const rogue = document.createElement('option');
    rogue.value = 'evil';
    rogue.textContent = '越界值';
    select.appendChild(rogue);
    select.value = 'evil';

    select.dispatchEvent(new Event('change'));

    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'archive_mode_set' }),
    );
    // 对照：合法值仍然照发（证明上面的「不发」不是因为监听没挂上）
    select.value = 'manual';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'archive_mode_set', mode: 'manual' });
  });
});
