/**
 * 设置面板「加一页」六处接线的静态对拍守卫
 *
 * 治理背景（2026-11-09 排雷）：`shared/settingsTabs.ts` 文件头曾如实写着
 * 「⑤ 样式 / ⑥ load+handleMessage 缺了是静默半残，只有真机发现」。把这句当成
 * 既定事实写进方案，等于接受一个已知无守卫的缺口 —— 不带伤原则不允许。
 * 本文件把这两处**变成可红的**：
 *   - 每个 tab 在 `refreshAll()` 里都有 loader 调用（漏一个即红）；
 *   - 每个 tab 的 root id 都在样式表里出现（漏一个即红）；
 *   - `handleMessage` 有新页的消息分支、`TAB_BODY_HTML` 的键集与 tab 表相等。
 *
 * 判据取源码文本（与 `protocolGuard` / `fileChangeCommands` 同型），不复制一份
 * 手抄清单当第二真源：表用 `satisfies Record<SettingsTab, string>` 让 tsc 强制穷尽，
 * 加 tab 忘了补表名会先编译红。
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_TABS, settingsRootId, type SettingsTab } from '../../shared/settingsTabs.js';

const SRC = join(__dirname, '../..');
const panelSrc = readFileSync(join(SRC, 'webview/panels/settingsPanel.ts'), 'utf8');
const htmlSrc = readFileSync(join(SRC, 'webview/panels/settingsPanelHtml.ts'), 'utf8');
const viewSrc = readFileSync(join(SRC, 'webview/scripts/settingsView.ts'), 'utf8');
const stylesDir = join(SRC, 'webview/styles');
const stylesText = readdirSync(stylesDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(join(stylesDir, f), 'utf8'))
  .join('\n');

/** 每个 tab 在 refreshAll() 内必须出现的调用片段（值只是片段，不是第二份 loader 实现） */
const LOADER_SNIPPETS = {
  memory: 'this.loadMemory()',
  roles: 'this.loadRoles()',
  config: 'this.loadConfig()',
  skills: 'this.loadSkills()',
  mcp: 'this.pushMcpStatus()',
  security: 'pushSecurityStatus(',
  works: 'this.works.load()',
} satisfies Record<SettingsTab, string>;

/** 从 settingsPanel.ts 切出 refreshAll 方法体（结构漂移时显式抛错，不静默返回空串） */
function refreshAllBody(): string {
  const start = panelSrc.indexOf('private refreshAll(): void {');
  if (start < 0) throw new Error('未找到 refreshAll 方法（结构已变，守卫需同步）');
  const end = panelSrc.indexOf('\n  }\n', start);
  if (end < 0) throw new Error('未找到 refreshAll 方法结束（结构已变，守卫需同步）');
  return panelSrc.slice(start, end);
}

describe('加一页接线守卫（静默半残 → 可红）', () => {
  it('每个 SettingsTab 都在 refreshAll() 里有 loader 调用', () => {
    const body = refreshAllBody();
    const missing = SETTINGS_TABS.filter((tab) => !body.includes(LOADER_SNIPPETS[tab]));
    expect(
      missing,
      `以下选项卡没有全量推送入口，ready / 隐藏转可见时会静默停在「加载中…」：[${missing.join(', ')}]`,
    ).toEqual([]);
  });

  it('每个 SettingsTab 的 root id 都有样式（缺样式 = 有按钮无排版，只有真机看得出）', () => {
    const missing = SETTINGS_TABS.filter((tab) => !stylesText.includes(`#${settingsRootId(tab)}`));
    expect(missing, `以下选项卡缺少 root 前缀样式：[${missing.join(', ')}]`).toEqual([]);
  });

  it('TAB_BODY_HTML 的键集与 SETTINGS_TABS 完全相等', () => {
    const start = htmlSrc.indexOf('const TAB_BODY_HTML: Record<SettingsTab, string> = {');
    if (start < 0) throw new Error('未找到 TAB_BODY_HTML（结构已变，守卫需同步）');
    const end = htmlSrc.indexOf('\n};', start);
    const block = htmlSrc.slice(start, end);
    // 只保留 tab 表内的键，避免模板字符串里的 HTML 文本被误抓
    const keys = [...block.matchAll(/^  (\w+):/gm)]
      .map((m) => m[1])
      .filter((k): k is SettingsTab => (SETTINGS_TABS as readonly string[]).includes(k));
    expect([...new Set(keys)].sort()).toEqual([...SETTINGS_TABS].sort());
  });

  it('handleMessage 有作品页消息分支，且入口仍由 ready 握手驱动', () => {
    expect(panelSrc).toContain("msg.type === 'work_projection'");
    expect(viewSrc).toContain("vscode.postMessage({ type: 'ready' })");
  });
});
