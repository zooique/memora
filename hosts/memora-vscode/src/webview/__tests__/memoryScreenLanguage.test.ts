/**
 * Memory page screen-language assertion (B2).
 *
 * In the default language the rendered memory page must contain no CJK characters. This is the
 * same class of assertion as `worksScreenLanguage.test.ts`: source-shape guards cannot prove what
 * the user actually sees, so the rendered screen text is asserted directly.
 *
 * Environment: node + explicit JSDOM. Under the jsdom environment, `vi.mock('vscode')` breaks at
 * import-analysis time (bare-module resolution happens before mocking), so the DOM is created here
 * and injected through `createMemoryView`'s dependency surface.
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

import { buildMemoryBodyHtml } from '../panels/settingsMemoryHtml.js';
import { createMemoryView } from '../scripts/memoryView.js';

/** Default-language translator double: returns the English source key and fills `{n}`. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

describe('memory page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="memory-root">${buildMemoryBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('memory-root')!;
    // pager.ts 是浏览器运行时代码，直接引用全局 `document`；node 环境需先把它挂到 globalThis
    (globalThis as unknown as { document: Document }).document = window.document;
    createMemoryView({ vscode: { postMessage: () => {} }, window, root });

    // 首屏载荷：一条 round-summary 记忆（用户正文 + 会话标识是唯一允许的中文来源）
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'memory_loaded',
          stats: { total: 3, bySource: { 'round-summary': 2, 'work-projection': 1 } },
          memories: [
            {
              id: 'round-summary:demo',
              name: '轮次摘要 2026-11-09-demo',
              source: 'round-summary',
              content: '用户写下的记忆正文',
              summaryType: 'preference',
              sessionName: '2026-11-09-demo',
              roundId: 'round-1',
              isModified: true,
              supersededBy: 'round-summary:newer',
            },
            {
              id: 'work-projection:notes.md',
              name: 'notes.md',
              source: 'work-projection',
              content: 'plain notes',
            },
          ],
        },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'governance_loaded',
          stats: { active: 2, deleted: 1, bySource: { 'round-summary': 1 }, superseded: 1 },
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('Memory');
    expect(screenText).toContain('3 memories');
    expect(screenText).toContain('Superseded');
    // Only user-provided data may remain CJK.
    const scrubbed = [
      '轮次摘要 2026-11-09-demo',
      '用户写下的记忆正文',
      '2026-11-09-demo',
      'round-summary:demo',
      'round-summary:newer',
    ].reduce((s, userText) => s.split(userText).join(''), screenText);
    expect(scrubbed).not.toMatch(CJK);
  });
});
