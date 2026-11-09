/**
 * 设置面板「MCP」选项卡 HTML 主体片段
 *
 * 为什么独立成文件（与 settingsSecurityHtml.ts 同款理由）：settingsPanel 是贴 eslint
 * max-lines 上限、只降不升的 TARGET 文件，而选项卡骨架是线性增长域；MCP 页还要随功能
 * 迭代长条目，留在大文件必爆线。
 *
 * 职责边界（同上）：**只提供静态 DOM 骨架，零逻辑、零插值变量**。列表渲染、表单与交互由
 * `scripts/mcpView.ts` 承担（数据经 `mcp_status` 消息下行），配置写入由
 * `panels/mcpServerOps.ts` 承担。
 *
 * 本地化（B6）：文案不再写死中文，改为 `l10n.t(英文源键)` 在构建时求值——构建发生在
 * settingsPanelHtml 模块加载期，此时 host 已把 l10n 配置注入（与 config/skills 两页同口径）。
 * `l10n` 以参数注入而非模块级导入：本文件被 jsdom 用例直接引用，不能依赖 vscode 运行时。
 *
 * **只使用全页面可用的 class**（`security-desc` / `loading-hint` / `btn` 等全局基线）：
 * `.hint` / `.empty-state` / `.footer-hint` 的选择符只挂在 roles/memory/config 三个 root 上
 * （CSS 注释明写 skills 是刻意不并入）⇒ MCP 页复用它们会渲染成裸文本。本页自有样式统一
 * 收在 `styles/mcpStyles.ts`（`#mcp-root` 前缀）。
 *
 * root 容器（`<div id="mcp-root">`）不由本片段自带——与其余选项卡一样由 settingsPanelHtml
 * 按 tab 表统一生成。
 */

/**
 * 构建 MCP 选项卡主体骨架
 *
 * @param l10n 本地化器（生产传 `vscode.l10n`；用例可注入英文直通实现）
 * @returns MCP 选项卡的静态 HTML 片段（不含外层 `#mcp-root`）
 */
export function buildMcpBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `
    <div class="header">
      <div class="header-main">
        <h2>${l10n.t('MCP tool servers')}</h2>
        <span id="mcpCount" class="stat-bar" hidden></span>
      </div>
      <div class="header-actions">
        <button id="mcpImportBtn" class="btn btn-secondary mcp-import-btn" type="button">${l10n.t('Import from JSON')}</button>
        <button id="mcpAddBtn" class="btn btn-secondary mcp-add-btn" type="button">${l10n.t('Add server')}</button>
      </div>
    </div>
    <p class="security-desc">${l10n.t('MCP (Model Context Protocol) servers give the conversation external tools; tool names look like <code>mcp__server__tool</code>. The configuration lives in <strong>user-level</strong> settings (it follows the person, not the project) — this page edits it in place and keeps no copy.')}</p>
    <div id="mcpList">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>
    <div id="mcpEmpty" hidden>
      <p class="security-desc" id="mcpEmptyDefault">${l10n.t("No MCP servers configured yet. Once you add one, its tools appear in the model's tool list as <code>mcp__server__tool</code>; by default you must approve every call.")}</p>
      <p class="security-desc" id="mcpEmptyHidden" hidden>${l10n.t('The configuration has entries, but none can be shown as a card (missing name, or a duplicate of the previous one). They will appear here automatically once fixed; you can also delete and re-add them. The hint line below lists which ones.')}</p>
      <button class="btn btn-secondary mcp-add-btn" type="button">${l10n.t('Add the first server')}</button>
    </div>
    <p id="mcpOmitted" class="mcp-omitted" hidden></p>
    <p class="security-desc">${l10n.t('Allow-listing only skips the confirmation prompt; <strong>every call is still audited</strong>. Two levels are supported: per-tool checkboxes (allow only that tool), or the whole server\'s "allow all" (allows every tool of that server). There is no "allow every server" switch — each server must be authorized on its own. Deleting a server does not clear its allow-list records (re-adding a server with the same name restores them).')}</p>
    <div class="mcp-footer">
      <button class="btn btn-ghost open-setting-btn" type="button" data-setting-key="memora.mcpServers">${l10n.t('Advanced: edit in settings.json')}</button>
    </div>
`;
}
