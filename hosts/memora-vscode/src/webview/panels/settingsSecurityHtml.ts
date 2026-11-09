/**
 * 设置面板「安全」选项卡 HTML 主体片段（B7 本地化）
 *
 * 为什么独立成文件（自 settingsPanel.ts 拆出）：settingsPanel 是贴 eslint max-lines
 * 上限的 TARGET 文件（只降不升），而安全页每加一个配置项入口就多一段静态 HTML，
 * 是典型的线性增长域，留在大文件必爆线（同 hostDiagnostics.ts / injectionBodies.ts 先例）。
 *
 * 职责边界：本模块只提供静态 DOM 骨架，零逻辑。交互（开关读写、路径增删、引擎测试、
 * open_setting 导航）全部由 securityServerOps.ts（宿主）与 webview 侧 `scripts/securityView.ts`
 * 承担。片段内不得出现插值变量——一旦需要动态数据，说明它该留在宿主或走消息通道。
 *
 * **本地化形态（B7）**：键 = 英文源文案本身，插值一律 `{0}`；本地化器由宿主注入
 * （`vscode.l10n`）。参数是**命名空间对象**而非裸 `t` 函数——静态键采集只认
 * `l10n.t('…')`，裸 `t('…')` 会让这些键脱离判据⑨的采集面。
 *
 * **root 容器的归属（2026-10-24 tab 表收口）**：`<div id="security-root" role="tabpanel">`
 * 不由本片段自带，由 `settingsPanelHtml.ts` 的 {@link buildHtml} 与其余选项卡统一生成
 * （id 由 `settingsRootId('security')` 派生、`hidden` 由是否默认首页决定）。
 */

/**
 * 构建安全子视图主体（本地化器由宿主注入）
 *
 * @param l10n 本地化器（英文源键 → 当前 UI 语言）
 */
export function buildSecurityBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `
  <!-- 安全子视图（security 选项卡：执行审批 / 路径白名单） -->
    <div class="header">
      <h2>${l10n.t('Security')}</h2>
    </div>
    <div class="security-section">
      <div class="security-item">
        <div class="security-item-header">
          <label for="confirmScriptsToggle" class="security-label">${l10n.t('Confirm before running')}</label>
          <label class="toggle-switch">
            <input id="confirmScriptsToggle" type="checkbox" role="switch" aria-label="${l10n.t('Secondary confirmation for script and command execution')}" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="security-desc">${l10n.t('When enabled, the AI asks for approval before running scripts/code (run_project_script / run_code) or executing ordinary shell commands (run_command). Off by default (auto-approve). This only controls whether to ask; it does not affect the capabilities themselves (always available). <strong>Note: git write operations (commit / push / reset / rebase / merge) and npm publish are not affected by this switch — they always ask and cannot be exempted</strong> — they are irreversible.')}</p>
      </div>
      <div id="securityStatus" class="security-status" hidden></div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">${l10n.t('Allowed path allow-list')}</label>
        </div>
        <p class="security-desc">${l10n.t('The project directory is always accessible. You can add trusted directories outside the project (for example, personal notes or documents) and the Agent can read and write them; additions and deletions take effect immediately and persist after a restart. The blacklist for sensitive files (.env/.ssh etc.) still blocks access.')}</p>
        <ul id="allowedPathsList" class="allowed-paths-list"></ul>
        <div class="allowed-paths-add">
          <input id="allowedPathsInput" type="text" class="allowed-paths-input" placeholder="${l10n.t('Enter an absolute directory path, e.g. D:/my-notes')}" aria-label="${l10n.t('Add an allowed path')}" />
          <button id="allowedPathsAdd" class="btn btn-secondary" type="button">${l10n.t('Add')}</button>
        </div>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label" for="searchEngineSelect">${l10n.t('Web search engine')}</label>
        </div>
        <p class="security-desc">${l10n.t('The internal search backend used by the web search tool. Auto = Bing first, falling back to DuckDuckGo; for Chinese content, switching to Baidu or Sogou improves hit quality. You can also use a custom engine below. Reload the window after changing this.')}</p>
        <select id="searchEngineSelect" class="security-select" aria-label="${l10n.t('Web search engine')}"></select>
        <p class="security-desc">${l10n.t('Custom engines must return structured results: OpenSearch RSS / Atom, or JSON (<code>{results:[{title,url,…}]}</code>). Ordinary web pages (a pile of HTML) and platforms that require sign-in are not supported. Click Edit, fill in the form, then Test before Save.')}</p>
        <div id="customSearchEngines" class="custom-search-engines"></div>
        <button id="addCustomEngineBtn" class="btn btn-secondary ce-add-btn" type="button">${l10n.t('+ Add a custom search engine')}</button>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">${l10n.t('Script interpreter (node path)')}</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.scriptNodePath">${l10n.t('Adjust in Settings')}</button>
        </div>
        <p class="security-desc">${l10n.t('The node interpreter used by skill scripts and project scripts. Leave empty to use the system PATH; if a script reports "spawn node ENOENT" (node not found), enter the absolute path to the node executable here. Reload the window after changing this.')}</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">${l10n.t('Activity metrics (debug)')}</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.showMetrics">${l10n.t('Adjust in Settings')}</button>
        </div>
        <p class="security-desc">${l10n.t('Debug information such as LLM call counts / tokens / security audit / fingerprints in the activity drawer. Hidden by default; once enabled, it appears in the drawer starting from the next conversation.')}</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">${l10n.t('Notification sound')}</label>
          <button class="btn btn-secondary open-setting-btn" type="button" data-setting-key="memora.attentionSound">${l10n.t('Adjust in Settings')}</button>
        </div>
        <p class="security-desc">${l10n.t('When the chat panel is not in the foreground, a system sound plays when an approval card appears / the AI waits for an answer / a round completes. On by default; turning it off mutes it completely, while in-panel badges and unread counts are unaffected.')}</p>
      </div>
      <div class="security-item">
        <div class="security-item-header">
          <label class="security-label">${l10n.t('Restore initial state')}</label>
        </div>
        <p class="security-desc">${l10n.t('Clear <strong>all user-level data</strong> of the plugin in one click: user skills, user role packs, LLM configuration (including API keys), the active role pack, role pack teams, security toggles and user-level settings, restoring the state of the first launch. <strong>Project data is fully preserved</strong>: memories and session records (.memora/) of the current project, plus project settings, are untouched — they are already part of the project. The window reloads automatically after clearing; in-progress conversations are interrupted.')}</p>
        <button id="resetUserDataBtn" class="btn btn-danger security-reset-btn" type="button">${l10n.t('Clear user-level data…')}</button>
        <span id="resetUserDataHint" class="security-status security-reset-hint" hidden></span>
      </div>
    </div>
`;
}
