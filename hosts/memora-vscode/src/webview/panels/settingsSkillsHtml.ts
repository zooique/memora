/**
 * 设置面板「全局技能」选项卡 HTML 主体片段（B5）
 *
 * 为什么独立成文件（同 `settingsConfigHtml.ts` / `settingsMemoryHtml.ts` / `settingsRolesHtml.ts`）：
 * `settingsPanelHtml.ts` 的 `TAB_BODY_HTML` 混着七页文案，而面板 CJK 判据按文件登记——共享文件里
 * 只要还留着别的页签中文，整份文件就不能登记 `migrated`。按 tab 前缀拆文件后，每页可见文案各自成网。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑**。技能列表 / 分页 / 禁用开关 / 正文展开全部由
 * `scripts/settingsView.ts` 的技能子视图消费消息渲染。
 */

/**
 * 构建全局技能子视图主体（本地化器由宿主注入）
 *
 * 参数是**命名空间对象**而非裸 `t` 函数：静态键采集只认 `l10n.t('…')`，裸 `t('…')`
 * 会让这些键脱离判据⑨的采集面。
 *
 * @param l10n 本地化器（英文源键 → 当前 UI 语言）
 */
export function buildSkillsBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `  <!-- 技能子视图（skills 选项卡） -->
    <div class="header">
      <h2>${l10n.t('Global skills')}</h2>
      <span id="skillCount" class="stat-bar" hidden></span>
      <div class="header-actions">
        <button id="btnImportSkillZip" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Import a .zip skill (into the user or project level)')}">
          <span class="btn-icon" data-icon="import"></span>
        </button>
        <button id="btnOpenSkillsDir" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Open the user skills directory')}">
          <span class="btn-icon" data-icon="folder"></span>
        </button>
        <button id="btnRefreshSkills" class="btn btn-secondary btn-icon-solo" title="${l10n.t('Refresh the skill list (rescan project and user skill directories)')}">
          <span class="btn-icon" data-icon="refresh"></span>
        </button>
      </div>
    </div>
    <div class="hint">${l10n.t('Global skills are shared by every role pack. Two formats are supported: a single <code>.md</code> file or a folder with <code>SKILL.md</code>.')}</div>
    <div id="skillsList">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>
    <p class="footer-hint">${l10n.t('User skills directory: <code>VS Code global storage / skills /</code>')}</p>`;
}
