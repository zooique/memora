/**
 * Skills page screen-language assertion (B5).
 *
 * In the default language the rendered global-skills page must contain no CJK characters.
 * Same class as `configScreenLanguage.test.ts` / `rolesScreenLanguage.test.ts`: source-shape guards
 * cannot prove what the user actually sees, so the rendered screen text is asserted directly.
 *
 * Environment: node + explicit JSDOM (same reason as the config page test: under the jsdom
 * environment `vi.mock('vscode')` resolves too late for the module graph, so a real DOM is created
 * here and injected through `createSkillsView`'s dependency surface).
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

import { buildSkillsBodyHtml } from '../panels/settingsSkillsHtml.js';
import { createSkillsView } from '../scripts/skillsView.js';

/** Default-language translator double: returns the English source key and fills `{n}`. */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

describe('skills page: default-language screen text', () => {
  it('renders with zero CJK outside user-provided strings', () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><div id="skills-root">${buildSkillsBodyHtml(en)}</div></body></html>`,
    );
    const { window } = dom;
    const root = window.document.getElementById('skills-root')!;
    // 卡片渲染走全局 `document`（空态 / 未匹配提示），node 环境需先挂到 globalThis
    (globalThis as unknown as { document: Document }).document = window.document;
    createSkillsView({ vscode: { postMessage: () => {} }, window, root });

    // 载荷覆盖全部分支：来源四分类 / 健康徽章两态 / 禁用徽章 / 角色包说明 / 正文展开 /
    // 项目级提升按钮 / 同名覆盖说明 / manifest 问题列表 / 未匹配禁用名提示
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'skills_loaded',
          skills: [
            {
              name: 'proj-skill',
              description: 'Project level skill',
              displayName: 'Proj Skill',
              layer: 'project',
              overriddenLayer: 'user',
            },
            {
              name: 'builtin-skill',
              description: 'Built-in skill',
              layer: 'builtin',
              health: 'error',
            },
            { name: 'role-skill', description: 'Role pack skill', layer: 'rolepack' },
            {
              name: 'user-skill',
              description: 'User level skill',
              layer: 'user',
              disabled: true,
              health: 'warn',
              contentChars: 25000,
              issues: [{ level: 'warn', message: 'Frontmatter hint' }],
            },
          ],
          unmatchedDisabled: ['ghost-skill'],
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // Positive control: the page really rendered (a blank page must not pass this assertion).
    expect(screenText).toContain('Global skills');
    expect(screenText).toContain('Project');
    expect(screenText).toContain('Built-in');
    expect(screenText).toContain('Role pack');
    expect(screenText).toContain('Not active');
    expect(screenText).toContain('Can be improved');
    expect(screenText).toContain('Disabled');
    expect(screenText).toContain('Follows the role');
    expect(screenText).toContain('View content');
    expect(screenText).toContain('Add to user level');
    expect(screenText).toContain('Overrides the same-named User skill');
    expect(screenText).toContain('No matching skill found to disable: ghost-skill');

    // 夹具里的技能名 / 描述 / 问题文案均为 ASCII —— 屏上任何 CJK 都只可能来自 UI 文案
    expect(screenText).not.toMatch(CJK);
  });
});
