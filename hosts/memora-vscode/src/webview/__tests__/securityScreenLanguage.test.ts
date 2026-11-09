/**
 * 安全页屏上语言断言（B7）
 *
 * 默认语言下，安全页渲染出来的文本必须是**零 CJK**。与 `mcpScreenLanguage.test.ts` 同族：
 * 源码形态守卫（判据⑰）只能证明源文件里没有中文字面量，证明不了用户实际看到的屏上文本；
 * 这里直接断言渲染结果——载荷里的项目路径 / 目录 / 引擎名 / 错误原因全部是 ASCII，
 * 屏上任何 CJK 都只可能来自 UI 文案本身。
 *
 * 环境：node + 显式 JSDOM（jsdom 环境下 `vi.mock('vscode')` 对模块图解析过晚，
 * 这里建真实 DOM 再注入 `createSecurityView`，与 MCP 页用例同法）。
 */
// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

/** 本仓未带 jsdom 类型；此处做一次结构断言即可 */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/** CJK 区段：汉字 + CJK 标点 + 全角字符（与源码守卫同族） */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

import { buildSecurityBodyHtml } from '../panels/settingsSecurityHtml.js';
import { createSecurityView } from '../scripts/securityView.js';

/** 默认语言译者替身：原样返回英文源键，并按参填充 `{n}` */
const en = {
  t: (message: string, ...args: (string | number | boolean)[]) =>
    message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
};

/** 挂载一份安全页并返回根容器（初始 HTML 即产线骨架，本地化器为默认语言） */
function mountSecurity(): { window: Window & typeof globalThis; root: HTMLElement } {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="security-root">${buildSecurityBodyHtml(en)}</div></body></html>`,
  );
  const { window } = dom;
  const root = window.document.getElementById('security-root')!;
  createSecurityView({ vscode: { postMessage: () => {} }, window, root });
  return { window, root };
}

describe('安全页：默认语言屏上文本', () => {
  it('各状态推送后屏上零 CJK（骨架 + 三种状态 + 恢复初始状态回执）', () => {
    const { window, root } = mountSecurity();

    // 载荷全部 ASCII：路径 / 引擎名 / 失败原因都不该是中文来源
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'security_status', confirmScripts: true },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'allowed_paths_status',
          projectPath: '/tmp/proj',
          paths: ['/tmp/notes', '/tmp/docs'],
        },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'custom_search_engines_status',
          engines: [
            {
              name: 'my-eng',
              urlTemplate: 'https://example.com/s?q={query}',
              parseStrategy: 'openSearchRss',
            },
          ],
        },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'search_engine_status', engine: 'auto' },
      }),
    );
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: {
          type: 'reset_user_data_result',
          ok: false,
          message: 'reset exploded',
        },
      }),
    );

    const screenText = root.textContent ?? '';
    // 正向控制：页面确实渲染了（空白页不能靠「没文本」通过断言）
    expect(screenText).toContain('Confirm before running');
    expect(screenText).toContain('Allowed path allow-list');
    expect(screenText).toContain('Enabled: approval before scripts/commands run');
    expect(screenText).toContain('Base (always allowed)');
    expect(screenText).toContain('/tmp/notes');
    expect(screenText).toContain('my-eng');
    expect(screenText).toContain('Restore initial state');
    expect(screenText).toContain('Clear user-level data…');
    expect(screenText).toContain('reset exploded');
    // 删除按钮的可访问名也是 UI 文案（口述给读屏用户）
    const removeBtn = root.querySelector<HTMLButtonElement>('.allowed-path-remove');
    expect(removeBtn?.getAttribute('aria-label')).toBe('Remove /tmp/notes');

    expect(screenText).not.toMatch(CJK);
  });

  it('新增自定义引擎草稿展开后仍零 CJK（编辑器字段全部走键面）', () => {
    const { window, root } = mountSecurity();
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { type: 'custom_search_engines_status', engines: [] },
      }),
    );
    root.querySelector<HTMLButtonElement>('#addCustomEngineBtn')?.click();

    const screenText = root.textContent ?? '';
    expect(screenText).toContain('New engine');
    expect(screenText).toContain('No URL');
    expect(screenText).toContain('Collapse');
    expect(screenText).toContain('Strategy');
    // 字段提示走属性面（placeholder / aria-label），不在 textContent 里：逐个点名核对
    expect(root.querySelector<HTMLInputElement>('.ce-name')?.getAttribute('placeholder')).toBe(
      'Engine name',
    );
    expect(root.querySelector<HTMLSelectElement>('.ce-parse')?.getAttribute('aria-label')).toBe(
      'Parse strategy',
    );
    expect(screenText).not.toMatch(CJK);
  });

  it('正向控制：渲染结果里出现中文一定会被检出（守卫自身不失明）', () => {
    const { root } = mountSecurity();
    // 注入一个只可能来自 UI 文案的中文串，确认断言口径真能红
    const probe = root.querySelector<HTMLElement>('.header h2');
    if (probe) probe.textContent = '安全';
    expect(root.textContent ?? '').toMatch(CJK);
  });
});
