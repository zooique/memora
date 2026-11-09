/**
 * 设置面板「记忆」选项卡 HTML 主体片段（B2）
 *
 * 为什么独立成文件（同 `settingsMcpHtml.ts` / `settingsSecurityHtml.ts` / `settingsWorksHtml.ts`）：
 * `settingsPanelHtml.ts` 的 `TAB_BODY_HTML` 混着七页文案，而面板 CJK 判据（⑦⑰）按文件
 * 登记——共享文件里只要还有别的页签中文，整份文件就不能登记 `migrated`。按 tab 前缀
 * 拆文件后，每页的可见文案各自成网，翻完一页就能立刻被守卫钉住。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑**。列表 / 回收站 / 治理统计 / 归档模式回显
 * 全由 `scripts/memoryView.ts` 消费消息渲染；本文件只负责「翻英文源键 + 注入本地化器」。
 *
 * 注：本片段不带外层 root 容器（`buildHtml()` 用 `settingsRootId('memory')` 统一生成）。
 */
import { MEMORY_RECYCLE_RETENTION_DAYS } from '../../shared/constants.js';

/**
 * 构建记忆子视图主体（本地化器由宿主注入）
 *
 * 参数是**命名空间对象**而非裸 `t` 函数：静态键采集只认 `l10n.t('…')`，裸 `t('…')`
 * 会让这些键脱离判据⑨的采集面（与判据⑯ 的裸导入禁令同源）。
 *
 * @param l10n 本地化器（英文源键 → 当前 UI 语言）
 */
export function buildMemoryBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `  <!-- 记忆子视图（memory 选项卡，默认首页） -->
    <div class="header">
      <h2>${l10n.t('Memory')}</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div class="search-wrap">
      <input id="searchInput" class="search-input" type="text" placeholder="${l10n.t('Search memories…')}" aria-label="${l10n.t('Search memories')}" />
    </div>
    <div id="list">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>

    <!-- 回收站：软删除记忆的可恢复暂存区 -->
    <details id="recycle" class="recycle" role="region" aria-label="${l10n.t('Recycle bin')}">
      <summary>${l10n.t('Recycle bin')}</summary>
      <div id="recycleList"><p class="hint">${l10n.t('The recycle bin is empty.')}</p></div>
    </details>
    <p id="memHint" class="mem-hint" hidden></p>

    <!-- 记忆治理区：统计卡 + 加权/清理操作 -->
    <div id="governance" class="governance" role="region" aria-label="${l10n.t('Memory governance')}">
      <div class="governance-stats">
        <div class="governance-stat">
          <span id="govActive" class="gov-num">0</span>
          <span class="gov-label">${l10n.t('Active')}</span>
        </div>
        <div class="governance-stat">
          <span id="govDeleted" class="gov-num">0</span>
          <span class="gov-label">${l10n.t('Recycle bin')}</span>
        </div>
        <div class="governance-stat">
          <span id="govSuperseded" class="gov-num">0</span>
          <span class="gov-label">${l10n.t('Superseded')}</span>
        </div>
      </div>
      <div class="governance-actions">
        <button id="btnCleanup" class="btn btn-danger" title="${l10n.t('Permanently delete memories soft-deleted more than {0} days ago (cannot be undone)', MEMORY_RECYCLE_RETENTION_DAYS)}">${l10n.t('Clean up expired')}</button>
      </div>
      <p id="govDetail" class="governance-detail" hidden></p>
    </div>

    <!-- 会话归档模式：内核 archiveMode 投影（full=自动归档 / manual=仅手动；设置即热更新，繁忙顺延） -->
    <div id="archiveMode" class="archive-mode" role="region" aria-label="${l10n.t('Conversation archiving')}">
      <div class="archive-mode-item">
        <label class="security-label" for="archiveModeSelect">${l10n.t('Conversation archive mode')}</label>
        <select id="archiveModeSelect" class="security-select" aria-label="${l10n.t('Conversation archive mode')}">
          <option value="full">${l10n.t('Automatic')}</option>
          <option value="manual">${l10n.t('Manual only')}</option>
        </select>
      </div>
      <p class="security-desc">${l10n.t('Automatic: when you switch away from or fork a conversation, a conversation summary and topic are generated automatically (the search data for the history list). Manual only: generated only when triggered by hand. <strong>Round summaries are not affected</strong> (they are always generated, so conversation memories keep accumulating as usual). Switching while a conversation is running is rejected by the kernel for hot reload — the preference takes effect when the current conversation ends.')}</p>
    </div>

    <p class="footer-hint">${l10n.t('Memories are sorted by importance. Click an entry to see its full text.')}</p>`;
}
