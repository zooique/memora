/**
 * Roles page screen-language assertion (B3).
 *
 * In the default language the rendered roles page must contain no CJK characters. Same class of
 * assertion as `memoryScreenLanguage.test.ts` / `worksScreenLanguage.test.ts`: source-shape guards
 * cannot prove what the user actually sees, so the rendered screen text is asserted directly.
 *
 * Environment: node + explicit JSDOM. Under the jsdom environment, `vi.mock('vscode')` breaks at
 * import-analysis time (bare-module resolution happens before mocking), so the DOM is created here
 * and injected through `createRolesView`'s dependency surface.
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

import { buildRolesBodyHtml } from '../panels/settingsRolesHtml.js';
import { createRolesView } from '../scripts/rolesView.js';

/** Default-language translator double: returns the English source key and fills `{n}`. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

/** 用户数据的唯一允许中文来源（角色包显示名，由角色包 manifest 提供，不属于 UI 文案） */
const PACK_A = '文档打磨';
const PACK_B = '方案设计师';
const GHOST_PACK = '已删除的包';

describe('roles page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="roles-root">${buildRolesBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('roles-root')!;
    // pager.ts 是浏览器运行时代码，直接引用全局 `document`；node 环境需先把它挂到 globalThis
    (globalThis as unknown as { document: Document }).document = window.document;
    createRolesView({ vscode: { postMessage: () => {} }, window, root });

    // 首屏载荷：覆盖「当前角色 / 其他角色 / 队伍标注 / 策略 chip / 能力 chip」全部可见分支
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'roles_loaded',
          activeName: PACK_A,
          defaultName: PACK_B,
          maxTeamMembers: 4,
          packs: [
            {
              name: PACK_A,
              displayName: PACK_A,
              description: 'polish documents',
              source: 'user',
              inTeam: true,
              toolMode: 'allow',
              capabilityState: {
                kind: 'list',
                capabilities: [{ capability: 'file:read', label: 'Read files' }],
              },
              strategy: { temperature: 0.4, toolMode: 'allow' },
              problems: [],
            },
            {
              name: PACK_B,
              displayName: PACK_B,
              description: 'design plans',
              source: 'project',
              toolMode: 'block',
              capabilityState: { kind: 'all' },
              problems: [{ level: 'warn', text: 'missing optional field' }],
            },
            {
              name: 'memora助手',
              displayName: 'memora助手',
              description: 'built-in fallback',
              source: 'builtin',
              isFallback: true,
              toolMode: 'allow',
              capabilityState: { kind: 'all' },
              problems: [],
            },
          ],
          // 遗留队伍：组长包已不存在 ⇒ 覆盖「Orphan teams / Leader ... uninstalled」标注分支
          // leaderMissing 由宿主算好随载荷下发（检测不删除语义：只标注，不自动清理）
          teams: [
            {
              leader: GHOST_PACK,
              members: [PACK_A],
              leaderMissing: true,
              missingMembers: [],
            },
          ],
          keyface: [
            { key: 'temperature', kind: 'number', value: 0.4 },
            { key: 'selfReview', kind: 'number', value: 1 },
          ],
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('Current role');
    expect(screenText).toContain('Other roles');
    expect(screenText).toContain('Orphan teams (1)');
    expect(screenText).toContain('Read files');
    // Only user-provided data may remain CJK (pack names + the avatar initial derived from them).
    const userNames = [PACK_A, PACK_B, GHOST_PACK, 'memora助手'];
    const scrubbed = [...userNames, ...userNames.map((n) => n.charAt(0))].reduce(
      (s, userText) => s.split(userText).join(''),
      screenText,
    );
    expect(scrubbed).not.toMatch(CJK);
  });
});
