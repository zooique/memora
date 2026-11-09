/**
 * 设置面板「加一页」六处接线的静态对拍守卫
 *
 * 治理背景（2026-11-09 排雷）：`shared/settingsTabs.ts` 文件头曾如实写着
 * 「⑤ 样式 / ⑥ load+handleMessage 缺了是静默半残，只有真机发现」。把这句当成
 * 既定事实写进方案，等于接受一个已知无守卫的缺口 —— 不带伤原则不允许。
 * 本文件把这两处**变成可红的**：
 *   - 每个 tab 在 `refreshAll()` 里都有 loader 调用（漏一个即红）；
 *   - 每个 tab 的 root id 都在样式表里出现（漏一个即红）；
 *   - 每个 tab 用到的共享类都被该 root 前缀样式接管（2026-11-09 真机截图补，
 *     第二批把 3 处存量缺口补齐、2 条僵尸豁免清除 ⇒ **零豁免**，任何缺口即红）；
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

  /* ─────────── 共享类接管守卫（2026-11-09 真机 UI 反馈） ─────────── */
  /**
   * 病灶：`.header` / `.hint` 等共享类在兄弟页有规则，不等于本页有——每页都得写
   * 一份 `#<tab>-root .<class>`。works 页首版七个共享类零规则 ⇒ 标题 / 计数 / 刷新
   * 按钮竖向堆叠、说明贴边；DOM 测试不查计算样式，全绿也只有真机截图看得出
   * （与 mcpStyles 头注释记录的 2026-10-24 MCP 首版「样式整层缺失」同类伤）。
   *
   * **零豁免（2026-11-09 第二批）**：首版冻结表的 5 条按「一次性排查脚本」抄来，
   * 该脚本用 `class="[^"]*\bhint\b` 宽松正则 ⇒ `loading-hint` / `security-reset-hint`
   * 被误判含 `hint`；本守卫的 `usesClass` 是 class 属性**精确分词**，两套判据不同源。
   * 按本守卫口径复算：`mcp:hint` / `security:hint` 永不命中（僵尸豁免），
   * 真缺口只有 `skills:stat-bar` / `skills:footer-hint` / `security:header` 三处，
   * 均已在各自样式文件补齐。故冻结表整体删除 —— 留着空 Set 或永不命中的键都是僵尸容器。
   * **判据唯一真源 = 本文件的 `usesClass`**，复算缺口不得另写宽松正则。
   */
  const SHARED_CLASSES = [
    'header',
    'stat-bar',
    'header-actions',
    'hint',
    'footer-hint',
    'btn-icon-solo',
    'btn-icon',
  ] as const;
  const BODY_CONST_FILES: Record<string, string> = {
    MCP_BODY_HTML: 'settingsMcpHtml.ts',
    SECURITY_BODY_HTML: 'settingsSecurityHtml.ts',
    WORKS_BODY_HTML: 'settingsWorksHtml.ts',
  };
  const panelsDir = join(SRC, 'webview/panels');
  const htmlLines = htmlSrc.split('\n');
  // 反引号写成字符码：模板字符串切片时避免与外层模板字面量混淆
  const BACKTICK = String.fromCharCode(96);

  /** 取某 tab 的真实主体骨架：内联模板切片 / 外置常量读同一份产线文件（不手抄夹具） */
  function bodyOf(tab: SettingsTab): string {
    const prefix = `  ${tab}: `;
    const start = htmlLines.findIndex((line) => line.startsWith(prefix));
    if (start < 0) throw new Error(`TAB_BODY_HTML 缺 ${tab} 键（结构已变，守卫需同步）`);
    const first = htmlLines[start]!.slice(prefix.length).trim();
    if (first.startsWith(BACKTICK)) {
      const chunks = [htmlLines[start]!];
      for (let i = start + 1; i < htmlLines.length; i++) {
        chunks.push(htmlLines[i]!);
        if (htmlLines[i]!.trimEnd().endsWith(BACKTICK + ',')) break;
      }
      return chunks.join('\n');
    }
    const file = BODY_CONST_FILES[first.replace(/,$/, '')];
    if (!file) throw new Error(`${tab} 的外置 body 常量未登记（守卫需同步）`);
    return readFileSync(join(panelsDir, file), 'utf8');
  }

  /** 精确按 class 属性分词匹配，避免 `stat-bar` 误命中 `stat-bar-extra` */
  function usesClass(body: string, cls: string): boolean {
    return [...body.matchAll(/class="([^"]*)"/g)].some((m) =>
      (m[1] ?? '').split(/\s+/).includes(cls),
    );
  }

  /**
   * 样式侧同样按选择器词边界匹配，**与 usesClass 对称**。
   * 原写法 `stylesText.includes('#<root> .<cls>')` 是前缀子串：把规则改名成
   * `.stat-bar-MUTATION` 后仍判绿（2026-11-09 变异实证，守卫当场没红）⇒
   * DOM 侧精确、样式侧宽松，两套口径不同源，等于给未来留一条假绿通道。
   * 边界取 `(?![\w-])`：后接 `{` / 空格 / 逗号 / 冒号 / 后代选择器都算命中，
   * 后接 `-` 或字母（`.stat-bar-extra`）不算。
   */
  function stylesClass(root: string, cls: string): boolean {
    return new RegExp(`#${root} \\.${cls}(?![\\w-])`, 'm').test(stylesText);
  }

  it('每个 tab 用到的共享类都有该 root 前缀样式（零豁免，任何缺口即红）', () => {
    const gaps: string[] = [];
    let scanned = 0;
    for (const tab of SETTINGS_TABS) {
      const body = bodyOf(tab);
      // 反向守卫：解析失效返回空串时不得假绿
      expect(body.length, `${tab} 的 body 解析为空（结构已变）`).toBeGreaterThan(100);
      for (const cls of SHARED_CLASSES) {
        if (!usesClass(body, cls)) continue;
        scanned++;
        if (stylesClass(settingsRootId(tab), cls)) continue;
        gaps.push(`${tab}:${cls}`);
      }
    }
    expect(scanned, '未扫到任何共享类引用（解析口径失效）').toBeGreaterThan(10);
    expect(
      gaps,
      `以下选项卡的共享类没有 root 前缀样式（真机会排版塌陷）：[${gaps.join(', ')}]`,
    ).toEqual([]);
  });
});
