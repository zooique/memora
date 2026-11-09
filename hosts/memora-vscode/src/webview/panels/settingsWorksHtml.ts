/**
 * 设置面板「作品和规则」选项卡 HTML 主体片段
 *
 * 为什么独立成文件（同 `settingsMcpHtml.ts` / `settingsSecurityHtml.ts`）：
 * `settingsPanel.ts` 与 `settingsPanelHtml.ts` 都在行数闸下，而选项卡骨架是典型的
 * 线性增长域；按 tab 前缀分文件才不会把「加一页」变成压线工程。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑、零动态插值**。行数据、失效徽标、动作回执
 * 全由 `work_projection` 消息驱动 `scripts/worksView.ts` 渲染。
 *
 * ⚠️ 本片段**不带外层 root 容器**：`buildHtml()` 用 `settingsRootId('works')` 统一生成
 * `works-root` 并按是否默认首页决定 `hidden`。故本文件不得写 `#works-root` 的 `display`
 * ——给 root 写 display 会覆盖 `hidden` 属性（UI 一致性规则 10 的结构性假绿）。
 * 页头 / 说明 / 页尾用的是共享类名，其布局规则在 `styles/worksStyles.ts` 以
 * `#works-root` 前缀接管，不在这里写内联样式。
 */

/**
 * Build the works sub-view body with an injected localizer.
 *
 * Injected (not `import vscode`) because this module is also pulled in by jsdom tests that cannot
 * resolve the `vscode` bare module. The host caller passes `vscode.l10n`.
 *
 * The parameter is a namespace object (not a bare `t` function) on purpose: the static key
 * collector only recognizes `l10n.t('...')`, so a bare `t('...')` would make these keys invisible
 * and they would show up as orphans in the bundle (same failure mode as the ⑯ bare-import rule).
 *
 * @param l10n Localizer: English source text -> current UI language
 */
export function buildWorksBodyHtml(l10n: { t(message: string): string }): string {
  return `
  <!-- 作品和规则子视图（works 选项卡：作品投影清单与项目规则求值） -->
    <div class="header">
      <h2>${l10n.t('Works and rules')}</h2>
      <span id="worksCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnRefreshWorks" class="btn btn-secondary btn-icon-solo" type="button" title="${l10n.t('Reload the list (badges reflect the last assembly; changes are recalculated on the next turn)')}">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint"><code>work-projections.json</code> ${l10n.t('lists works; click <strong>"Set as project rule"</strong> in a row to make it a rule injected automatically every turn. <strong>Click a row to open its source file</strong> and edit it; changes are read at the next assembly.')}</div>
    <div id="worksNotice" class="works-notice" hidden></div>
    <div id="worksList" class="works-list">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>
    <p class="footer-hint">${l10n.t('The row suffix shows whether an entry is a project rule and whether it was actually injected in the last assembly; list changes are visible immediately, while invalid reasons are recalculated by the kernel at each assembly — run a chat turn after editing files.')}</p>`;
}
