/**
 * 设置面板「角色」选项卡 HTML 主体片段
 *
 * 为什么独立成文件（同 `settingsWorksHtml.ts` / `settingsMemoryHtml.ts`）：
 * `settingsPanelHtml.ts` 的 tab 主体表是线性增长域，每页骨架内联会把「加一页」变成压线工程；
 * 按 tab 拆文件后，本页所有可见文案在此一处，判据⑰ 的采集面也清晰。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑、零动态插值**。角色卡片 / 队伍标注 / 分页
 * 全由 `roles_loaded` 驱动 `scripts/rolesView.ts` 渲染。
 *
 * ⚠️ 本片段**不带外层 root 容器**：`buildHtml()` 用 `settingsRootId('roles')` 统一生成
 * `roles-root` 并按是否默认首页决定 `hidden`。
 */

/**
 * 构造角色子视图主体（注入本地化器）。
 *
 * 注入而非 `import vscode`：本模块会被 jsdom 用例直接引用，那里解析不了 `vscode` 裸模块；
 * 真实宿主侧由 `settingsPanelHtml.ts` 传入 `vscode.l10n`。
 *
 * 参数是**命名空间对象**而非裸 `t` 函数：静态键采集只认 `l10n.t('…')`，裸 `t('…')`
 * 会让这些键在 bundle 里变成孤儿（与判据⑯ 禁裸导同源）。
 *
 * @param l10n 本地化器（英文源键 → 当前 UI 语言）
 */
export function buildRolesBodyHtml(l10n: { t(message: string): string }): string {
  return `
  <!-- 角色子视图（roles 选项卡） -->
    <div class="header">
      <h2>${l10n.t('Roles')}</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnImportRolePackZip" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Import a .zip role pack (user-level or project-level)')}">
          <span class="btn-icon" data-icon="import"></span>
        </button>
        <button id="btnOpenRolePacksDir" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Open the user role pack directory')}">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshRolePacks" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Reload role packs (rescan project and user role pack directories)')}">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div id="list">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>
    <p class="footer-hint">${l10n.t('“Current” = the role this session is using (“Set as current” switches only this session); “Default” = the role that new sessions use automatically from now on (“Set as default” only affects future sessions and does not change existing ones); “Take into chat” also jumps to the chat and prefills a transition sentence (not sent automatically; you can edit it before sending). If the default role uses a read-only strategy, every new session from then on loses write capability.')}</p>`;
}
