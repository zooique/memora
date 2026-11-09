/**
 * MCP page screen-language assertion (B6).
 *
 * In the default language the rendered MCP page must contain no CJK characters.
 * Same class as `skillsScreenLanguage.test.ts` / `configScreenLanguage.test.ts`: source-shape guards
 * cannot prove what the user actually sees, so the rendered screen text is asserted directly.
 *
 * Environment: node + explicit JSDOM (under the jsdom environment `vi.mock('vscode')` resolves too
 * late for the module graph, so a real DOM is created here and injected through `createMcpView`).
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

import { buildMcpBodyHtml } from '../panels/settingsMcpHtml.js';
import { createMcpView } from '../scripts/mcpView.js';

/** Default-language translator double: returns the English source key and fills `{n}`. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

describe('mcp page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="mcp-root">${buildMcpBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('mcp-root')!;
    createMcpView({ vscode: { postMessage: () => {} }, window, root });

    // 载荷覆盖五态 + 工具明细（含改名提示）+ 免确认两级 + 被隐藏条目解释：
    // server 名 / 工具名 / 失败原因 / 缺项原因全部是 ASCII，屏上任何 CJK 都只可能来自 UI 文案
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'mcp_status',
          servers: [
            {
              name: 'fs',
              state: 'running',
              enabled: true,
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem'],
              toolCount: 2,
              tools: [
                {
                  derivedName: 'mcp__fs__read_file',
                  originalName: 'read_file',
                  allowKey: 'mcp__fs__read_file',
                  allowlisted: true,
                },
                {
                  derivedName: 'mcp__fs__list_dir_v2',
                  originalName: 'list_dir',
                  allowKey: 'mcp__fs__list_dir_v2',
                  allowlisted: false,
                },
              ],
              serverAllowKey: 'mcp__fs__*',
              serverAllowlisted: false,
            },
            {
              name: 'remote',
              state: 'failed',
              enabled: true,
              transport: 'http',
              url: 'https://example.invalid/mcp',
              toolCount: 0,
              tools: [],
              serverAllowKey: 'mcp__remote__*',
              serverAllowlisted: false,
              error: 'Connection closed (subprocess exited or transport closed)',
            },
            {
              name: 'dead',
              state: 'invalid',
              enabled: true,
              command: '',
              toolCount: 0,
              tools: [],
              serverAllowKey: 'mcp__dead__*',
              serverAllowlisted: false,
              problem: 'Missing command',
            },
            {
              name: 'off',
              state: 'disabled',
              enabled: false,
              command: 'node',
              toolCount: 0,
              tools: [],
              serverAllowKey: 'mcp__off__*',
              serverAllowlisted: false,
            },
            {
              name: 'later',
              state: 'pending',
              enabled: true,
              command: 'uvx',
              toolCount: 0,
              tools: [],
              serverAllowKey: 'mcp__later__*',
              serverAllowlisted: false,
            },
          ],
          omitted: { configured: 7, missingName: 1, duplicate: 1 },
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('MCP tool servers');
    expect(screenText).toContain('Connected');
    expect(screenText).toContain('Failed to start');
    expect(screenText).toContain('Incomplete configuration');
    expect(screenText).toContain('Disabled');
    expect(screenText).toContain('Not connected');
    expect(screenText).toContain('Allow-list');
    expect(screenText).toContain('Restart');
    expect(screenText).toContain('Delete');
    expect(screenText).toContain('Remote');
    expect(screenText).toContain('7 servers');
    expect(screenText).toContain('are not shown in the list above');

    expect(screenText).not.toMatch(CJK);
  });
});
