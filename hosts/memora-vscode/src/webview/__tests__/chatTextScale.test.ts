/**
 * 对话文字三档端到端判据（CHAT-TEXT-SCALE-1）
 *
 * 四层各钉一处：
 *   ① CSS：语义令牌只在 tokens.ts 定义一次，body[data-text-scale] 覆写两档，
 *      AI 正文唯一组 + 用户气泡正文都只引该令牌（代码块 / 工具行 / 输入区不引）；
 *   ② 首帧：buildHtml 对 normal 不写属性（与既往逐字等价），small/large 写入；
 *   ③ 热更：入口 helper 只认 chatTextScale kind，写 body dataset、非法值回退；
 *   ④ 常规卡：三档 radio 发档位名、宿主回推按值选中（不写第二份 px）。
 * 首帧 buildHtml 的逐字断言在独立 node 环境文件（jsdom 下无法 mock vscode）。
 *
 * 变异验证四处各改坏一次，确认精确命中后恢复（见台账条目）。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { applyTextScaleMessage } from '../helpers/textScaleView.js';
import { createGeneralView } from '../scripts/generalView.js';
import { buildGeneralBodyHtml } from '../panels/settingsGeneralHtml.js';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

const STYLES = join(__dirname, '..', 'styles');

describe('① 样式层：单一语义令牌 + 两档覆写 + 消费者收敛', () => {
  const tokens = readFileSync(join(STYLES, 'tokens.ts'), 'utf8');
  const chatStyles = readFileSync(join(STYLES, 'chatStyles.ts'), 'utf8');

  it('语义令牌只定义一次，默认跟随 --font-base（现状 13px）', () => {
    // 只看声明行（行首）：注释里出现同名 token 是说明文字，不算第二份定义
    expect(tokens.match(/^\s*--font-chat-text\s*:/gm)).toHaveLength(1);
    expect(tokens).toMatch(/^\s*--font-chat-text:\s*var\(--font-base\);/m);
  });

  it('两档覆写在 tokens 一处，small→md / large→lg，无 normal 覆写', () => {
    expect(tokens).toMatch(
      /body\[data-text-scale='small'\]\s*\{\s*--font-chat-text:\s*var\(--font-md\)/,
    );
    expect(tokens).toMatch(
      /body\[data-text-scale='large'\]\s*\{\s*--font-chat-text:\s*var\(--font-lg\)/,
    );
    expect(tokens).not.toMatch(/^\s*body\[data-text-scale='normal'\]/m);
  });

  it('消费者只有两处（AI 正文唯一组 + 用户气泡），各自只引语义令牌', () => {
    const consumers = [...chatStyles.matchAll(/font-size:\s*var\(--font-chat-text/g)];
    expect(consumers).toHaveLength(2);
    expect(chatStyles).toMatch(/\.msg\.user \{[\s\S]*?font-size:\s*var\(--font-chat-text/);
    expect(chatStyles).toMatch(
      /\.msg\.assistant \.msg-body,\s*\.process-flow__narrate,\s*\.round-block__narrate \{[\s\S]*?font-size:\s*var\(--font-chat-text/,
    );
  });

  it('代码块仍是固定 12px（不随档缩放）', () => {
    expect(chatStyles).toMatch(
      /\.msg\.assistant \.msg-body pre code \{[^}]*font-size:\s*var\(--font-md, 12px\)/,
    );
  });
});

describe('③ 热更：入口 helper 只认本 kind，写 dataset、非法回退', () => {
  it('chatTextScale 消息改写 body dataset', () => {
    const body = document.createElement('body');
    applyTextScaleMessage({ type: 'general_setting', kind: 'chatTextScale', value: 'large' }, body);
    expect(body.dataset.textScale).toBe('large');
  });

  it('非法值回退 normal（消息面不信任）', () => {
    const body = document.createElement('body');
    applyTextScaleMessage({ type: 'general_setting', kind: 'chatTextScale', value: 'huge' }, body);
    expect(body.dataset.textScale).toBe('normal');
  });

  it('其他 kind 一律不碰 dataset（显式分发，非剩余兜底）', () => {
    const body = document.createElement('body');
    body.dataset.textScale = 'small';
    applyTextScaleMessage({ type: 'general_setting', kind: 'showMetrics', value: true }, body);
    applyTextScaleMessage(
      { type: 'notice', level: 'info', message: 'x' } as ExtensionToWebviewMessage,
      body,
    );
    expect(body.dataset.textScale).toBe('small');
  });
});

describe('④′ 热更广播链：配置变更经 public postGlobal 到所有视图', () => {
  const extSrc = readFileSync(join(__dirname, '..', '..', 'extension', 'extension.ts'), 'utf8');
  const panelSrc = readFileSync(join(__dirname, '..', 'panels', 'chatPanel.ts'), 'utf8');

  it('配置分支存在且调 postGlobal（不调用已删的私有封装）', () => {
    expect(extSrc).toMatch(
      /if \(e\.affectsConfiguration\('memora\.chatTextScale'\)\) \{\s*chatProvider\.postGlobal\(\{[\s\S]*?kind:\s*'chatTextScale'/,
    );
    expect(extSrc).not.toMatch(/postChatTextScale/);
  });

  it('postGlobal 是 public（宿主广播链可达）', () => {
    expect(panelSrc).toMatch(/public postGlobal\(msg: ExtensionToWebviewMessage\): void/);
  });
});

describe('④ 常规卡三档：发档位名，宿主回推按值选中', () => {
  function mount(): {
    posts: WebviewToExtensionMessage[];
    push: (msg: ExtensionToWebviewMessage) => void;
    root: HTMLElement;
  } {
    document.body.innerHTML = `<div id="general-root">${buildGeneralBodyHtml({ t: (s) => s })}</div>`;
    const posts: WebviewToExtensionMessage[] = [];
    const root = document.getElementById('general-root') as HTMLElement;
    createGeneralView({
      vscode: { postMessage: (m) => posts.push(m) },
      window,
      root,
    });
    const push = (msg: ExtensionToWebviewMessage) =>
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    return { posts, push, root };
  }

  it('点大档发 kind=chatTextScale + value=large（不写 px）', () => {
    const { posts, root } = mount();
    (root.querySelector('input[value="large"]') as HTMLInputElement).click();
    const hit = posts.filter((m) => m.type === 'general_setting' && m.kind === 'chatTextScale');
    expect(hit).toEqual([{ type: 'general_setting', kind: 'chatTextScale', value: 'large' }]);
  });

  it('宿主回推按值选中，三档互斥', () => {
    const { push, root } = mount();
    push({ type: 'general_setting', kind: 'chatTextScale', value: 'small' });
    const radios = [...root.querySelectorAll<HTMLInputElement>('input[name="chatTextScale"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['small', true],
      ['normal', false],
      ['large', false],
    ]);
  });
});
