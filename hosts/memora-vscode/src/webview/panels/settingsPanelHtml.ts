/**
 * settingsPanelHtml — 设置面板 webview 静态骨架（自 settingsPanel.ts 拆出）
 *
 * **为什么拆（与 settingsSecurityHtml.ts 同款理由）**：settingsPanel 是贴 eslint
 * max-lines 上限的 TARGET 文件（**只降不升**，见根 eslint.config.mjs 的存量清单）。
 * 静态骨架是典型的线性增长域——每加一个选项卡就多一屏 HTML，留在大文件必爆线。
 * 拆出后「加一个选项卡」不再消耗 settingsPanel 的行 budgets（只加一行 tab id + 一本 body）。
 *
 * 职责边界（与 settingsSecurityHtml.ts 同）：**只提供静态 DOM 骨架，零逻辑**。交互全部由
 * settingsPanel.ts 的消息处理与 webview 侧 settingsView.ts 承担；本模块不读状态、不插值动态
 * 数据（唯一插值 = 构建期常量 {@link MEMORY_RECYCLE_RETENTION_DAYS} 与 scriptUri）。
 *
 * **tab 按钮与 root 容器不再手写**：由 {@link SETTINGS_TABS} 驱动生成，顺序与 id 同源于
 * `shared/settingsTabs.ts`。此前 5 个按钮 + 5 个 root 各写一遍，且与脚本侧 / 协议侧的 tab
 * 联合类型互不相同源（已漂移出「路由不到 security 页」的洞）。现在：新增 tab id ⇒ 缺
 * body / 缺可见名 = 编译红，编译期兜住而不是上线后点了没反应。
 */
import * as vscode from 'vscode';
import { buildHtmlHead, resolveHtmlLang } from '../helpers/htmlShell.js';
import { settingsStyles } from '../styles/settingsStyles.js';
import { MCP_BODY_HTML } from './settingsMcpHtml.js';
import { SECURITY_BODY_HTML } from './settingsSecurityHtml.js';
import { buildConfigBodyHtml } from './settingsConfigHtml.js';
import { buildMemoryBodyHtml } from './settingsMemoryHtml.js';
import { buildRolesBodyHtml } from './settingsRolesHtml.js';
import { buildWorksBodyHtml } from './settingsWorksHtml.js';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TABS,
  SETTINGS_TAB_ARIA_LABELS,
  SETTINGS_TAB_LABELS,
  settingsRootId,
  type SettingsTab,
} from '../../shared/settingsTabs.js';

/** Works body built at import time with the host localizer (`vscode.l10n` is available here). */
const WORKS_BODY_HTML = buildWorksBodyHtml(vscode.l10n);

/** Memory body built at import time with the host localizer (same reason as the works body). */
const MEMORY_BODY_HTML = buildMemoryBodyHtml(vscode.l10n);

/** Roles body built at import time with the host localizer (same reason as the works body). */
const ROLES_BODY_HTML = buildRolesBodyHtml(vscode.l10n);

/** Config body built at import time with the host localizer (same reason as the works body). */
const CONFIG_BODY_HTML = buildConfigBodyHtml(vscode.l10n);

/**
 * 各选项卡主体骨架（**不含外层 root 容器**——root 与 tab 按钮均由 {@link buildHtml} 统一生成）
 *
 * `Record` 穷尽性 = 机器化的「不许漏」：加了 tab id 却忘了给主体 ⇒ 编译不过。
 */
const TAB_BODY_HTML: Record<SettingsTab, string> = {
  memory: MEMORY_BODY_HTML,
  roles: ROLES_BODY_HTML,
  config: CONFIG_BODY_HTML,
  skills: `  <!-- 技能子视图（skills 选项卡） -->
    <div class="header">
      <h2>全局技能</h2>
      <span id="skillCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnImportSkillZip" class="btn btn-secondary btn-icon-solo" title="导入 .zip 技能（可导入到用户级或项目级）">
          <span class="btn-icon" data-icon="import"></span>
        </button>
        <button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-solo" title="打开用户技能目录">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshSkills" class="btn btn-secondary btn-icon-solo" title="刷新技能列表（重扫项目与用户技能目录）">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint">全局技能是所有角色包共享的能力。支持单文件 <code>.md</code> 和文件夹 <code>SKILL.md</code> 两种格式。</div>
    <div id="skillsList">
      <p class="loading-hint">加载中…</p>
    </div>
    <p class="footer-hint">用户技能目录：<code>VS Code 全局存储 / skills /</code></p>`,
  mcp: MCP_BODY_HTML,
  security: SECURITY_BODY_HTML,
  works: WORKS_BODY_HTML,
};

/** 选项卡按钮栏（顺序、默认高亮、`aria-selected` 全部由 tab 表派生） */
function buildTabButtons(): string {
  return SETTINGS_TABS.map((tab) => {
    const active = tab === DEFAULT_SETTINGS_TAB;
    // 表值只存英文源键，本地化在消费侧做（shared/ 两侧共用，不能在里面调任何一侧的 l10n API）
    return `    <button class="tab-btn${active ? ' active' : ''}" data-tab="${tab}" role="tab" aria-selected="${String(active)}">${vscode.l10n.t(SETTINGS_TAB_LABELS[tab])}</button>`;
  }).join('\n');
}

/** 子视图根容器 + 主体（默认首页不 `hidden`，其余默认隐藏；id 由 {@link settingsRootId} 派生） */
function buildTabPanels(): string {
  return SETTINGS_TABS.map((tab) => {
    const hidden = tab === DEFAULT_SETTINGS_TAB ? '' : ' hidden';
    return `  <div id="${settingsRootId(tab)}" class="tab-panel" role="tabpanel" aria-label="${vscode.l10n.t(SETTINGS_TAB_ARIA_LABELS[tab])}"${hidden}>\n${TAB_BODY_HTML[tab]}\n  </div>`;
  }).join('\n\n');
}

/**
 * 构造设置面板 webview 的完整 HTML
 *
 * @param scriptUri 外部脚本 settingsView.js 的 asWebviewUri（CSP script-src cspSource 加载）
 * @param cspSource webview 本地资源源（webview.cspSource，供 CSP 放行外部脚本）
 */
export function buildHtml(scriptUri: vscode.Uri, cspSource: string): string {
  return `${buildHtmlHead({
    lang: resolveHtmlLang(vscode.env?.language),
    cspSource,
    styles: settingsStyles,
    // P1 基建：宿主译文随 HTML 内联（默认语言 bundle 为 undefined ⇒ 不注入）；
    // `?.` 守测试侧 vscode mock 未提供 l10n 的场景，真实 API 恒存在
    l10nBundle: vscode.l10n?.bundle,
  })}
<body>
  <div class="tabs" role="tablist" aria-label="${vscode.l10n.t('Settings tabs')}">
${buildTabButtons()}
  </div>

${buildTabPanels()}

  <script src="${scriptUri}"></script>
</body>
</html>`;
}
