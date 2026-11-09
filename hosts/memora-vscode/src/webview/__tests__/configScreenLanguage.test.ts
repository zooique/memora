/**
 * Config page screen-language assertion (B4).
 *
 * In the default language the rendered LLM-configuration page must contain no CJK characters.
 * Same class of assertion as `rolesScreenLanguage.test.ts` / `memoryScreenLanguage.test.ts`:
 * source-shape guards cannot prove what the user actually sees, so the rendered screen text is
 * asserted directly instead.
 *
 * Environment: node + explicit JSDOM. Under the jsdom environment, `vi.mock('vscode')` breaks at
 * import-analysis time (bare-module resolution happens before mocking), so the DOM is created here
 * and injected through `createConfigView`'s dependency surface.
 */
// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/** jsdom has no bundled types in this repo; structural cast is used once here. */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/** CJK ranges: Han + CJK punctuation + fullwidth forms (same family as the source guard). */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

import { buildConfigBodyHtml } from '../panels/settingsConfigHtml.js';
import { createConfigView } from '../scripts/configView.js';

/** Default-language translator double: returns the English source key and fills `{n}`. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

/** 用户数据的唯一允许中文来源（Provider 显示名，由用户配置提供，不属于 UI 文案） */
const USER_DISPLAY_NAME = '本地';

describe('config page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="config-root">${buildConfigBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('config-root')!;
    // toast/卡片渲染走浏览器运行时代码（引用全局 `document`）；node 环境需先挂到 globalThis
    (globalThis as unknown as { document: Document }).document = window.document;
    createConfigView({ vscode: { postMessage: () => {} }, window, root });

    // 列表载荷：覆盖「激活分区 / 其他分区 / 当前徽章 / 本地来源后缀 / 上下文与输出标注 /
    // 密钥读取失败痕迹」全部可见分支
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'cfg_loaded',
          activeName: 'cloud',
          backgroundName: 'cloud',
          providers: [
            {
              name: 'cloud',
              displayName: 'Cloud',
              model: 'deepseek-chat',
              baseUrl: 'https://api.example.com/v1',
              contextWindow: 128000,
              maxTokens: 64000,
              maskedKey: 'sk-••••1234',
            },
            {
              name: 'local',
              displayName: USER_DISPLAY_NAME,
              model: 'qwen3',
              baseUrl: 'http://localhost:11434/v1',
              provider: 'local',
              keyError: 'API Key for "local" read failed: credential service not running',
            },
          ],
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('Active provider');
    expect(screenText).toContain('Other providers');
    expect(screenText).toContain('Current');
    expect(screenText).toContain('Max output');
    // 弹窗骨架（默认隐藏，但文案已进 DOM）也要一起验
    expect(screenText).toContain('Test connection');
    expect(screenText).toContain('Save');

    // Only user-provided data may remain CJK (provider display name + its avatar initial).
    const userTexts = [USER_DISPLAY_NAME, USER_DISPLAY_NAME.charAt(0)];
    const scrubbed = userTexts.reduce((s, userText) => s.split(userText).join(''), screenText);
    expect(scrubbed).not.toMatch(CJK);
  });
});
