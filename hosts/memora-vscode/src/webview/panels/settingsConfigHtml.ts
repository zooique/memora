/**
 * 设置面板「大模型配置」选项卡 HTML 主体片段（B4）
 *
 * 为什么独立成文件（同 `settingsMemoryHtml.ts` / `settingsRolesHtml.ts` / `settingsWorksHtml.ts`）：
 * `settingsPanelHtml.ts` 的 `TAB_BODY_HTML` 混着七页文案，而面板 CJK 判据（⑦⑰）按文件
 * 登记——共享文件里只要还有别的页签中文，整份文件就不能登记 `migrated`。按 tab 前缀
 * 拆文件后，每页的可见文案各自成网，翻完一页就能立刻被守卫钉住。
 *
 * 职责边界：**只给静态 DOM 骨架，零逻辑**。Provider 列表 / 后台模型下拉 / 弹窗回填
 * 全由 `scripts/configView.ts` 消费消息渲染；本文件只负责「翻英文源键 + 注入本地化器」。
 *
 * 注：本片段不带外层 root 容器（`buildHtml()` 用 `settingsRootId('config')` 统一生成）。
 */

/**
 * 构建大模型配置子视图主体（本地化器由宿主注入）
 *
 * 参数是**命名空间对象**而非裸 `t` 函数：静态键采集只认 `l10n.t('…')`，裸 `t('…')`
 * 会让这些键脱离判据⑨的采集面（与判据⑯ 的裸导入禁令同源）。
 *
 * @param l10n 本地化器（英文源键 → 当前 UI 语言）
 */
export function buildConfigBodyHtml(l10n: {
  t(message: string, ...args: (string | number)[]): string;
}): string {
  return `  <!-- 大模型配置子视图（config 选项卡） -->
    <div class="header">
      <h2>${l10n.t('LLM configuration')}</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <button id="btnAdd" class="btn">${l10n.t('Add API')}</button>
    </div>
    <!-- 模型通道分区：后台 + 检索归入显式分区，与 Provider 列表的 group-title 语言一致 -->
    <div class="group-title">${l10n.t('Model channels')}</div>
    <!-- 后台模型通道（多 Provider 路由）：后台任务（摘要/归档/润色）独立轻量模型 -->
    <div class="cfg-bg">
      <label for="bgModel" class="cfg-bg-label">${l10n.t('Background model (optional)')}</label>
      <select id="bgModel" class="cfg-bg-select" aria-label="${l10n.t('Background model for background tasks (summaries / archiving / polishing)')}">
        <option value="">${l10n.t('Same as live chat')}</option>
      </select>
      <p class="cfg-bg-hint">${l10n.t('Background tasks (round summaries / conversation archiving / text polishing) use this model; pick a lightweight fast model to save cost.')}</p>
    </div>
    <div id="list">
      <p class="loading-hint">${l10n.t('Loading…')}</p>
    </div>
    <!-- 新增/编辑弹窗 -->
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle">${l10n.t('Add API')}</h3>
        <form id="cfgForm">
          <div class="field">
            <label for="f-name">${l10n.t('Alias (unique; letters, digits and . - _ only)')}</label>
            <input id="f-name" name="name" type="text" placeholder="${l10n.t('e.g. deepseek')}" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-display">${l10n.t('Display name')}</label>
            <input id="f-display" name="displayName" type="text" placeholder="${l10n.t('e.g. DeepSeek')}" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-model">${l10n.t('Model')}</label>
            <input id="f-model" name="model" type="text" placeholder="${l10n.t('e.g. deepseek-chat')}" autocomplete="off" />
          </div>
          <div class="field">
            <label for="f-baseurl">${l10n.t('API Base URL')}</label>
            <input id="f-baseurl" name="baseUrl" type="url" placeholder="https://api.xiaomimimo.com/v1" autocomplete="url" />
          </div>
          <div class="field">
            <label for="f-apikey">${l10n.t('API Key (leave blank to keep it unchanged when editing)')}</label>
            <input id="f-apikey" name="apiKey" type="password" placeholder="sk-…" autocomplete="new-password" />
            <div id="apikeyHint" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-providertype">${l10n.t('Provider type')}</label>
            <select id="f-providertype" name="provider">
              <option value="cloud">${l10n.t('Cloud API (DeepSeek / Doubao / Qwen, etc.)')}</option>
              <option value="local">${l10n.t('Local runtime (Ollama / LM Studio)')}</option>
            </select>
            <div class="key-hint">${l10n.t('Cloud providers enable native tool calling by default; for a local runtime, declare support below (it cannot be inferred from the address).')}</div>
          </div>
          <div id="toolcalling-field" class="field" hidden>
            <label class="checkbox-label" for="f-toolcalling">
              <input id="f-toolcalling" name="supportsToolCalling" type="checkbox" checked />
              <span>${l10n.t('Supports native tool calling (OpenAI Function Calling)')}</span>
            </label>
            <div class="key-hint">${l10n.t('Checked: the local model can call tools (web search / read-write files / build memories, etc.); unchecked: text chat only, the tool channel is withdrawn and the model is told tools are unavailable.')}</div>
          </div>
          <!-- 视觉能力位：与工具能力位不同，**不随来源类型显隐**——
               同一个 OpenAI 兼容接口下 gpt-4o 看得见图、deepseek-chat 看不懂，云端/本地都无法推断，
               故恒由用户显式声明，且默认不勾选（失败必闭：宁可被明确拒收，不可被静默丢图）。 -->
          <div id="vision-field" class="field">
            <label class="checkbox-label" for="f-vision">
              <input id="f-vision" name="supportsVision" type="checkbox" />
              <span>${l10n.t('Supports image input (multimodal vision understanding)')}</span>
            </label>
            <div class="key-hint">${l10n.t('Checked: this model understands images (e.g. GPT-4o / Claude 3.5 / Gemini vision models). If unchecked, sending an image is explicitly rejected instead of being silently dropped; <strong>do not check this unless you are sure</strong> — if it is marked as “can see” but actually cannot, the AI answers beside the point and you cannot tell why.')}</div>
          </div>
          <div class="field">
            <label for="f-contextwindow">${l10n.t('Context window limit (K)')}</label>
            <input id="f-contextwindow" name="contextWindow" type="text" inputmode="decimal" placeholder="${l10n.t('e.g. 128 (leave blank for the default window)')}" autocomplete="off" />
            <div class="key-hint">${l10n.t('Fill in thousands (K); 128 means 128K = 128,000 tokens; decimals are allowed (e.g. 1.5); leave blank to use the kernel default window (the kernel constant is the source of truth, no number is hard-coded here).')}</div>
            <div id="f-contextwindow-feedback" class="key-hint" hidden></div>
          </div>
          <div class="field">
            <label for="f-maxtokens">${l10n.t('Max output (K)')}</label>
            <input id="f-maxtokens" name="maxTokens" type="text" inputmode="decimal" placeholder="${l10n.t('e.g. 64 (leave blank for the server default)')}" autocomplete="off" />
            <div class="key-hint">${l10n.t('Maximum output tokens per reply (including reasoning), e.g. 64 = 64,000 tokens (K = ×1000, the same unit as the context limit); leave blank to omit max_tokens and let the server decide.<span class="hint-warn-icon" data-icon="warning" role="img" aria-label="{0}"></span>Reasoning models share the output budget between thinking and the answer, so leaving this blank easily triggers an empty response — filling it in is recommended (mimo v2.6 suggests 32–64K); if output is still truncated, raise it (exceeding the model limit is reported by the server and never silently applied).', l10n.t('Note'))}</div>
            <div id="f-maxtokens-feedback" class="key-hint" hidden></div>
          </div>
          <div id="testResult" class="test-result" hidden></div>
          <div class="modal-actions">
            <button id="btnTest" type="button" class="btn btn-secondary">${l10n.t('Test connection')}</button>
            <button id="btnCancel" type="button" class="btn btn-secondary">${l10n.t('Cancel')}</button>
            <button id="btnSave" type="submit" class="btn">${l10n.t('Save')}</button>
          </div>
        </form>
      </div>
    </div>`;
}
