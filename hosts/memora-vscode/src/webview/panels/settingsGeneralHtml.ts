/**
 * 设置面板「常规」选项卡 HTML 主体片段
 *
 * 职责边界：只提供静态 DOM 骨架，零逻辑。交互（语言模式切换 / 写入 / 提示音开关 /
 * 活动指标开关 / 复制诊断动作）由 `scripts/generalView.ts` 承担；持久值回显由宿主
 * `settingsStatusPush.pushGeneralStatus` 推送，复制诊断不回推——提示由命令自身给出。
 *
 * **语言边界（ADR-042）**：本页的「语言」只有 AI 回答语言可改；界面语言真源唯一 =
 * `vscode.env.language`，本页只给只读说明，绝不放开关——原生 NLS 按 locale 取文件，
 * 运行时改配置只会得到「设置了但界面不变」的静默失效。
 *
 * root 容器不由本片段自带，由 `settingsPanelHtml.ts` 的 `buildHtml` 统一生成
 * （id 由 `settingsRootId('general')` 派生）。
 */
export function buildGeneralBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `
  <!-- 常规子视图（general 选项卡：回答语言 / 界面语言说明 / 交互提示音 / 活动指标 / 诊断） -->
    <div class="header">
      <h2>${l10n.t('General')}</h2>
    </div>
    <div class="general-section">
      <div class="general-item">
        <div class="general-item-header">
          <label class="general-label" id="answerLanguageLabel">${l10n.t('AI answer language')}</label>
        </div>
        <p class="general-desc">${l10n.t('Choose how replies are worded. Automatic uses the VS Code display language as a hint; manual pins one language for every reply.')}</p>
        <div class="general-mode-row" role="radiogroup" aria-labelledby="answerLanguageLabel">
          <label class="general-mode">
            <input type="radio" name="answerLanguageMode" value="auto" checked />
            <span>${l10n.t('Automatic')}</span>
          </label>
          <label class="general-mode">
            <input type="radio" name="answerLanguageMode" value="manual" />
            <span>${l10n.t('Manual')}</span>
          </label>
        </div>
        <p class="hint">${l10n.t('Automatic: follow the display language, but follow you when you write in another language in the same turn. Manual: the chosen language always wins.')}</p>
        <input id="answerLanguageInput" class="general-input" type="text" maxlength="60" disabled aria-label="${l10n.t('Custom answer language')}" placeholder="${l10n.t('Language name, e.g. Japanese or English')}" />
        <div class="general-actions">
          <button id="answerLanguageSave" class="btn btn-secondary" type="button">${l10n.t('Save')}</button>
          <span id="answerLanguageStatus" class="general-status" hidden></span>
        </div>
      </div>
      <div class="general-item">
        <div class="general-item-header">
          <label class="general-label">${l10n.t('Interface language')}</label>
        </div>
        <p class="general-desc">${l10n.t('The interface follows the VS Code display language and cannot be changed here. Run "Configure Display Language" from the VS Code Command Palette and restart the window.')}</p>
      </div>
      <div class="general-item">
        <div class="general-item-header">
          <label class="general-label" for="attentionSoundToggle">${l10n.t('Notification sound')}</label>
          <label class="toggle-switch">
            <input id="attentionSoundToggle" type="checkbox" role="switch" aria-label="${l10n.t('Play a sound for approvals, questions and completed rounds')}" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="general-desc">${l10n.t('When the chat panel is in the background, play a system sound for approval cards, questions and completed rounds. Turning it off mutes the sound; badges and unread counts are unaffected.')}</p>
      </div>
      <div class="general-item">
        <div class="general-item-header">
          <label class="general-label" for="showMetricsToggle">${l10n.t('Activity metrics')}</label>
          <label class="toggle-switch">
            <input id="showMetricsToggle" type="checkbox" role="switch" aria-label="${l10n.t('Show debugging metrics in the chat panel')}" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="general-desc">${l10n.t('Show LLM calls, tokens, tool failures and audit counts in the activity drawer. Debug information, hidden by default; takes effect from the next round.')}</p>
      </div>
      <div class="general-item">
        <div class="general-item-header">
          <label class="general-label">${l10n.t('Diagnostics')}</label>
        </div>
        <p class="general-desc">${l10n.t('Copy a sanitized summary (versions, configuration and recent errors) to the clipboard for bug reports. API keys are never included.')}</p>
        <div class="general-actions">
          <button id="copyDiagnosticsBtn" class="btn btn-secondary" type="button">${l10n.t('Copy diagnostic summary')}</button>
        </div>
      </div>
    </div>
`;
}
