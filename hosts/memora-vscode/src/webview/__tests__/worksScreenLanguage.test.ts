/**
 * Works page screen-language assertion (B1 sample batch).
 *
 * In the default language the rendered works page must contain no CJK characters. This turns
 * "the English UI still shows Chinese" from an eyeball problem into a red assertion — earlier
 * rounds treated a green guard as acceptance, but that guard asserts source shape, not screen
 * language.
 *
 * Environment: node + explicit JSDOM. Under the jsdom environment, `vi.mock('vscode')` breaks at
 * import-analysis time (bare-module resolution happens before mocking), so the DOM is created
 * here and injected through `createWorksView`'s dependency surface.
 */
// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect, vi } from 'vitest';

/** jsdom has no bundled types in this repo; structural cast is used once here. */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/** CJK ranges: Han + CJK punctuation + fullwidth forms (same family as the source guard). */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

/** Default-language `vscode.l10n.t`: returns the English source key and fills `{n}` placeholders. */
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: (string | number | boolean)[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import { buildWorksBodyHtml } from '../panels/settingsWorksHtml.js';
import { createWorksView } from '../scripts/worksView.js';
import { deriveWorkProjectionView } from '../../extension/host/workProjectionRows.js';

/** Translator double shared by the host-side derivation and the webview-side render. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

describe('works page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="works-root">${buildWorksBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('works-root')!;
    createWorksView({ vscode: { postMessage: () => {} }, window, root });

    const state = deriveWorkProjectionView({
      hasAgent: true,
      listMalformed: false,
      entries: [
        // User-controlled text (file name + description) is the only allowed CJK source.
        { name: '作品一', description: '用户写的说明', source: '作品一.md', resident: true },
        { name: 'notes', description: '', source: 'notes.md', resident: false },
      ],
      residentReport: {
        // Kernel-origin failure text stays in the tooltip attribute, not in screen text.
        failures: [{ source: 'notes.md', reason: 'missing', message: '源文件不存在' }],
        dropped: [],
        listReadable: true,
      },
      l10n: en,
    });
    window.dispatchEvent(
      new window.MessageEvent('message', { data: { type: 'work_projection', state } }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('Works and rules');
    expect(screenText).toContain('2 items');
    // Only user-provided file data may remain CJK.
    const scrubbed = ['作品一', '用户写的说明', '作品一.md'].reduce(
      (s, userText) => s.split(userText).join(''),
      screenText,
    );
    expect(scrubbed).not.toMatch(CJK);
  });
});
