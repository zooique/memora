/**
 * securityView — 设置面板「安全」选项卡运行时（自 settingsView.ts 外置）
 *
 * 为什么独立成文件（同 skillsView / mcpView）：本地化判据按**文件**登记——容器
 * `settingsView.ts` 里只要还留着安全页中文，安全页就不能登记 `migrated`（判据⑰ 生效不了）。
 * 按 tab 外置后每页可见文案各自成网，容器只保留「挂载表 + 切换 + ready 握手」。
 *
 * 职责：
 *   - 执行二次确认开关（security_toggle / security_status）
 *   - 允许路径白名单（allowed_paths_set / allowed_paths_status）
 *   - 网页搜索引擎下拉 + 自定义引擎编辑器（search_engine_set / custom_search_engines_set /
 *     custom_search_engine_test）
 *   - 「恢复初始状态」按钮（reset_user_data / reset_user_data_result）
 *
 * 本地化口径：键 = 英文源文案本身，插值一律 `{0}`；命名空间导入而非裸 `t`（判据⑨采集面）。
 */
// 命名空间导入而非裸 `t`：静态键采集（判据⑨）只认 `l10n.t('…')`
import * as l10n from '@vscode/l10n';
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  HostParseStrategy,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
import { populateIcons } from './icons.js';
// escapeHtml：HTML 转义纯函数单一真理源（SSOT 收敛，见 helpers/escapeHtml.ts）
import { escapeHtml } from '../helpers/escapeHtml.js';

/**
 * 安全子视图初始化与渲染（执行确认 + 路径白名单 + 搜索引擎 + 恢复初始状态）
 *
 * @param deps 视图依赖（共享 postMessage + 自有 root 容器）
 */
export function createSecurityView({
  vscode,
  window,
  root,
}: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}): void {
  // 文档取自 root 的 ownerDocument（不读全局 `document`）：单测可注入独立 JSDOM，
  // 产线两者同一个文档，行为不变。
  const doc = root.ownerDocument;
  const scriptsToggle = root.querySelector<HTMLInputElement>('#confirmScriptsToggle');
  const statusEl = root.querySelector<HTMLElement>('#securityStatus');

  // ─── 白名单额外路径 ───
  /** 当前项目根（只读基准根，由 host 回推） */
  let currentProjectPath = '';
  /** 用户额外允许的目录（不含基准根） */
  let currentPaths: string[] = [];

  const listEl = root.querySelector<HTMLUListElement>('#allowedPathsList');
  const inputEl = root.querySelector<HTMLInputElement>('#allowedPathsInput');
  const addBtn = root.querySelector<HTMLButtonElement>('#allowedPathsAdd');

  /** 渲染白名单清单：第一行是只读基准根，其后是用户额外目录（可删除） */
  function renderAllowedPaths(): void {
    if (!listEl) return;
    const rows: string[] = [];
    // 基准根（只读、灰显，不可删除）
    if (currentProjectPath) {
      rows.push(
        `<li class="allowed-path-row allowed-path-base">` +
          `<span class="allowed-path-text" title="${escapeHtml(currentProjectPath)}">${escapeHtml(currentProjectPath)}</span>` +
          `<span class="allowed-path-tag">${l10n.t('Base (always allowed)')}</span>` +
          `</li>`,
      );
    }
    // 用户额外目录（可删除，按索引定位避免路径含引号破坏属性）
    currentPaths.forEach((p, i) => {
      rows.push(
        `<li class="allowed-path-row">` +
          `<span class="allowed-path-text" title="${escapeHtml(p)}">${escapeHtml(p)}</span>` +
          `<button class="allowed-path-remove btn btn-ghost" type="button" data-index="${i}" aria-label="${l10n.t('Remove {0}', escapeHtml(p))}"><span class="btn-icon" data-icon="close"></span></button>` +
          `</li>`,
      );
    });
    listEl.innerHTML = rows.join('');
    // 运行期设置 innerHTML → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充
    // （图标语言唯一 = icons.ts 柔和线条 SVG）
    populateIcons(listEl);
    listEl.querySelectorAll<HTMLButtonElement>('.allowed-path-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (!Number.isNaN(idx)) currentPaths.splice(idx, 1);
        renderAllowedPaths();
        vscode.postMessage({ type: 'allowed_paths_set', paths: currentPaths });
      });
    });
  }

  addBtn?.addEventListener('click', () => {
    const p = inputEl?.value.trim();
    if (!p) return;
    if (!currentPaths.includes(p)) currentPaths.push(p);
    if (inputEl) inputEl.value = '';
    renderAllowedPaths();
    vscode.postMessage({ type: 'allowed_paths_set', paths: currentPaths });
  });

  // 执行二次确认开关：通知 host（security_toggle；写入确认已退役，通道只剩这一项）
  if (scriptsToggle) {
    scriptsToggle.addEventListener('change', () => {
      vscode.postMessage({
        type: 'security_toggle',
        enabled: scriptsToggle.checked,
      });
      if (statusEl) {
        // 文案与 security_status 分支同源（同一判据两处措辞必漂移）：统一说「脚本/命令」
        statusEl.textContent = scriptsToggle.checked
          ? l10n.t('Enabled: approval before scripts/commands run')
          : l10n.t('Disabled: scripts/commands run without approval');
        statusEl.hidden = false;
      }
    });
  }

  // ─── 「在设置中调整」导航按钮 ───
  // 绑定已上移到 createSettingsView（页面级事件委托）：`open_setting` 与安全子视图无关，
  // 绑在这里会让别的选项卡（MCP 页）复用同一 class 时静默失效。**勿在此处加回。**

  // ─── 网页搜索引擎下拉（选项由 custom_search_engines_status 动态重建，单一真理源 PRESET_SEARCH_ENGINES）───
  const engineSelect = root.querySelector<HTMLSelectElement>('#searchEngineSelect');
  /** 已持久化的自定义引擎清单（host 回推；下拉选项与卡片共用） */
  let currentCustomEngines: CustomSearchEngineConfig[] = [];
  engineSelect?.addEventListener('change', () => {
    const engine = engineSelect.value;
    // 下拉仅含合法选项；空值（占位）不推送
    if (engine) vscode.postMessage({ type: 'search_engine_set', engine });
  });

  // ─── 自定义搜索引擎（SSOT：与内核 SearchEndpoint 单一嫁接，解析策略宿主预置）───
  const customEnginesBox = root.querySelector<HTMLElement>('#customSearchEngines');
  const addCustomBtn = root.querySelector<HTMLButtonElement>('#addCustomEngineBtn');

  /** 依据预设 + 自定义重建下拉选项，保留当前选中 */
  function rebuildEngineOptions(customs: CustomSearchEngineConfig[]): void {
    if (!engineSelect) return;
    const selected = engineSelect.value || 'auto';
    const names = new Set<string>([...PRESET_SEARCH_ENGINES, ...customs.map((c) => c.name)]);
    engineSelect.innerHTML = '';
    for (const name of names) {
      const opt = doc.createElement('option');
      opt.value = name;
      opt.textContent = name === 'auto' ? l10n.t('Auto (Bing → DuckDuckGo)') : name;
      engineSelect.appendChild(opt);
    }
    engineSelect.value = names.has(selected) ? selected : 'auto';
  }

  /**
   * 自定义搜索引擎编辑器：紧凑清单 + 手风琴单编辑区 + 显式保存。
   *
   * 状态分层（SSOT）：
   *   - currentCustomEngines = **已持久化**清单，只由 host 回推的 custom_search_engines_status 更新 ⇒ 单一真相；
   *   - editingDraft / editingIndex = 本地未保存草稿，及它要落到第几行（=length 表示新增）；
   *   - pendingSave = 已提交待确认的清单，拿它和回推状态比对即可判定「保存成功 / 被拒回滚」。
   *
   * 由此得到两个关键收益：编辑过程不发消息（不触发网络探针、不被错误提示打扰）；
   * 且无论成功还是被拒，界面最终都收敛到 host 的持久化真相。
   */
  /** 当前展开编辑的行号（null = 无展开；= 清单长度表示新增草稿行） */
  let editingIndex: number | null = null;
  /** 当前编辑草稿（展开表单的唯一权威；重渲染不丢字） */
  let editingDraft: CustomSearchEngineConfig | null = null;
  /** 已提交待确认的清单（用于判定「保存成功 / 被拒回滚」） */
  let pendingSave: CustomSearchEngineConfig[] | null = null;

  /** 取 URL 模板的域名（收起态一行摘要用；不用 URL 构造器，避免 {query} 占位符误伤） */
  function hostOf(tpl: string): string {
    const m = tpl.match(/^(?:https?:\/\/)?([^/?#]+)/i);
    return m ? m[1] : tpl;
  }

  /** 从展开表单读取当前草稿（不判合法性，交由 host 权威裁决） */
  function readDraft(card: HTMLElement): CustomSearchEngineConfig {
    return {
      name: card.querySelector<HTMLInputElement>('.ce-name')?.value.trim() ?? '',
      urlTemplate: card.querySelector<HTMLInputElement>('.ce-url')?.value.trim() ?? '',
      parseStrategy: (card.querySelector<HTMLSelectElement>('.ce-parse')?.value ??
        'openSearchRss') as HostParseStrategy,
    };
  }

  /** 设置某张卡片的测试状态文案与语义色（ok / fail / idle） */
  function setStatus(card: HTMLElement, text: string, kind: 'ok' | 'fail' | 'idle'): void {
    const el = card.querySelector<HTMLSpanElement>('.ce-test-status');
    if (!el) return;
    el.textContent = text;
    el.className = `ce-test-status${kind === 'idle' ? '' : ` ${kind}`}`;
  }

  /** 两份引擎清单是否逐项相同（判定回推状态是否与本次提交一致） */
  function sameEngines(
    a: readonly CustomSearchEngineConfig[],
    b: readonly CustomSearchEngineConfig[],
  ): boolean {
    return (
      a.length === b.length &&
      a.every(
        (e, i) =>
          e.name === b[i].name &&
          e.urlTemplate === b[i].urlTemplate &&
          e.parseStrategy === b[i].parseStrategy,
      )
    );
  }

  /** 渲染引擎清单：收起态一行一条；草稿（新增/编辑）展开唯一表单 */
  function renderCustomEngines(engines: CustomSearchEngineConfig[]): void {
    if (!customEnginesBox) return;
    customEnginesBox.innerHTML = '';
    engines.forEach((eng, idx) => {
      const expanded = editingIndex === idx;
      // 展开态渲染草稿（含未保存修改）；收起态渲染已持久化值
      const view = expanded && editingDraft ? editingDraft : eng;
      customEnginesBox.appendChild(buildEngineCard(view, idx, expanded, false));
    });
    // 新增草稿行（仅本地存在，未提交 ⇒ 不触发 host 校验/探针）
    if (editingIndex !== null && editingIndex >= engines.length && editingDraft) {
      customEnginesBox.appendChild(buildEngineCard(editingDraft, editingIndex, true, true));
    }
  }

  /**
   * 构建一张引擎卡：
   *   - 收起态：一行摘要（状态点 + 名称 + 域名 + 编辑/删除）≈ 33px，N 个引擎线性只涨行高；
   *   - 展开态：摘要行下方展开唯一编辑表单（名称/URL/策略 + 测试/保存/取消）。
   * 静态校验不在此实现——host 是唯一权威，非法配置由 host 回拒绝结果并回推状态。
   */
  function buildEngineCard(
    cfg: CustomSearchEngineConfig,
    idx: number,
    expanded: boolean,
    isDraft: boolean,
  ): HTMLElement {
    const card = doc.createElement('div');
    card.className = `custom-engine${expanded ? ' expanded' : ''}`;
    card.innerHTML = `
      <div class="ce-summary">
        <span class="ce-dot"></span>
        <span class="ce-label">${escapeHtml(cfg.name || l10n.t('New engine'))}</span>
        <span class="ce-host">${escapeHtml(cfg.urlTemplate ? hostOf(cfg.urlTemplate) : l10n.t('No URL'))}</span>
        <button class="ce-edit btn btn-secondary" type="button">${expanded ? l10n.t('Collapse') : l10n.t('Edit')}</button>
        ${isDraft ? '' : `<button class="ce-remove btn btn-secondary" type="button">${l10n.t('Delete')}</button>`}
      </div>
      ${
        expanded
          ? `<div class="ce-editor">
        <label class="ce-field"><span>${l10n.t('Name')}</span><input class="ce-name" type="text" placeholder="${l10n.t('Engine name')}" aria-label="${l10n.t('Engine name')}" value="${escapeHtml(cfg.name)}" /></label>
        <label class="ce-field"><span>URL</span><input class="ce-url" type="text" placeholder="https://example.com/search?q={query}" aria-label="${l10n.t('Search URL')}" value="${escapeHtml(cfg.urlTemplate)}" /></label>
        <label class="ce-field"><span>${l10n.t('Strategy')}</span><select class="ce-parse" aria-label="${l10n.t('Parse strategy')}">
          <option value="openSearchRss">OpenSearch RSS / Atom</option>
          <option value="jsonApi">${l10n.t('JSON search API')}</option>
        </select></label>
        <div class="ce-actions">
          <button class="ce-test btn btn-secondary" type="button">${l10n.t('Test')}</button>
          <button class="ce-save btn" type="button">${l10n.t('Save')}</button>
          <button class="ce-cancel btn btn-secondary" type="button">${l10n.t('Cancel')}</button>
          <span class="ce-test-status" role="status" aria-live="polite"></span>
        </div>
        <ul class="ce-sample" role="list"></ul>
      </div>`
          : ''
      }
    `;
    // 收起/展开：同一时刻仅一个编辑区（点已展开的行 = 收起）
    card.querySelector<HTMLButtonElement>('.ce-edit')?.addEventListener('click', () => {
      if (editingIndex === idx) {
        editingIndex = null;
        editingDraft = null;
      } else {
        editingIndex = idx;
        editingDraft = { ...cfg };
      }
      pendingSave = null;
      renderCustomEngines(currentCustomEngines);
    });
    // 删除：立即持久化（剩余项相对持久化清单未变 ⇒ 不触发探针）
    card.querySelector<HTMLButtonElement>('.ce-remove')?.addEventListener('click', () => {
      currentCustomEngines = currentCustomEngines.filter((_, i) => i !== idx);
      editingIndex = null;
      editingDraft = null;
      pendingSave = null;
      renderCustomEngines(currentCustomEngines);
      rebuildEngineOptions(currentCustomEngines);
      vscode.postMessage({ type: 'custom_search_engines_set', engines: currentCustomEngines });
    });
    if (expanded) {
      const parseSelect = card.querySelector<HTMLSelectElement>('.ce-parse');
      if (parseSelect) parseSelect.value = cfg.parseStrategy;
      const labelEl = card.querySelector<HTMLSpanElement>('.ce-label');
      const hostEl = card.querySelector<HTMLSpanElement>('.ce-host');
      const nameInput = card.querySelector<HTMLInputElement>('.ce-name');
      const urlInput = card.querySelector<HTMLInputElement>('.ce-url');
      // 草稿是唯一权威：输入即回写 editingDraft（重渲染不丢字），摘要行同步更新
      const commitDraft = (): void => {
        const rawName = nameInput?.value.trim() ?? '';
        const rawUrl = urlInput?.value.trim() ?? '';
        editingDraft = {
          name: rawName,
          urlTemplate: rawUrl,
          parseStrategy: (parseSelect?.value ?? 'openSearchRss') as HostParseStrategy,
        };
        if (labelEl) labelEl.textContent = rawName || l10n.t('New engine');
        if (hostEl) hostEl.textContent = rawUrl ? hostOf(rawUrl) : l10n.t('No URL');
      };
      nameInput?.addEventListener('input', commitDraft);
      urlInput?.addEventListener('input', commitDraft);
      parseSelect?.addEventListener('change', commitDraft);
      // 「测试」：把当前表单内容交给 host 实测抓取+解析（纯预览，无持久化语义）
      card.querySelector<HTMLButtonElement>('.ce-test')?.addEventListener('click', () => {
        setStatus(card, l10n.t('Verifying…'), 'idle');
        vscode.postMessage({ type: 'custom_search_engine_test', engine: readDraft(card) });
      });
      // 「保存」：草稿 → host（静态校验 + 仅变化项实测探针；失败由 host 回推状态回滚）
      card.querySelector<HTMLButtonElement>('.ce-save')?.addEventListener('click', () => {
        const draft = readDraft(card);
        const next = currentCustomEngines.slice();
        if (idx < next.length) next[idx] = draft;
        else next.push(draft);
        pendingSave = next;
        currentCustomEngines = next;
        vscode.postMessage({ type: 'custom_search_engines_set', engines: next });
      });
      // 「取消」：丢弃本次草稿，回到已持久化状态
      card.querySelector<HTMLButtonElement>('.ce-cancel')?.addEventListener('click', () => {
        editingIndex = null;
        editingDraft = null;
        pendingSave = null;
        renderCustomEngines(currentCustomEngines);
      });
    }
    return card;
  }

  // 「+ 添加」：只落一条本地草稿并展开表单，不发消息 ⇒ 不再触发 host「（空）配置无效」误报
  addCustomBtn?.addEventListener('click', () => {
    editingIndex = currentCustomEngines.length;
    editingDraft = { name: '', urlTemplate: '', parseStrategy: 'openSearchRss' };
    pendingSave = null;
    renderCustomEngines(currentCustomEngines);
  });

  // ─── 恢复初始状态（清空用户级数据 + 自动重载；确认弹窗在 host 侧） ───
  // webview 只做三件事：禁用按钮防重复点击 → 发请求 → 按回执恢复/保持禁用。
  // 失败时按钮恢复可重试（清理各步骤幂等，host 侧重试安全）；成功时保持禁用
  // （窗口即将重载，恢复无意义）。
  const resetBtn = root.querySelector<HTMLButtonElement>('#resetUserDataBtn');
  const resetHint = root.querySelector<HTMLElement>('#resetUserDataHint');
  resetBtn?.addEventListener('click', () => {
    if (resetBtn.disabled) return;
    resetBtn.disabled = true;
    resetBtn.textContent = l10n.t('Clearing…');
    if (resetHint) {
      resetHint.textContent = '';
      resetHint.hidden = true;
      resetHint.classList.remove('security-reset-error');
    }
    vscode.postMessage({ type: 'reset_user_data' });
  });

  // 监听 host 的 security_status / allowed_paths_status / search_engine_status 消息
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'security_status') {
      if (scriptsToggle) scriptsToggle.checked = msg.confirmScripts;
      if (statusEl) {
        statusEl.textContent = msg.confirmScripts
          ? l10n.t('Enabled: approval before scripts/commands run')
          : l10n.t('Disabled: scripts/commands run without approval');
        statusEl.hidden = false;
      }
    }
    if (msg.type === 'allowed_paths_status') {
      currentProjectPath = msg.projectPath;
      currentPaths = msg.paths ?? [];
      renderAllowedPaths();
    }
    if (msg.type === 'custom_search_engines_status') {
      const next = msg.engines ?? [];
      // 回推状态即 host 持久化真相：与本次提交一致 = 保存成功（收起表单）；
      // 不一致 = 被拒回滚（保留草稿，方便改完重试）
      const saved = pendingSave !== null && sameEngines(pendingSave, next);
      currentCustomEngines = next;
      if (saved) {
        editingIndex = null;
        editingDraft = null;
      }
      pendingSave = null;
      renderCustomEngines(next);
      rebuildEngineOptions(next);
    }
    if (msg.type === 'custom_search_engine_test_result') {
      // 回显到当前唯一展开的编辑区（谁发起测试就回显到谁）
      const { ok, count, error, sample } = msg.result;
      const card = root.querySelector<HTMLElement>('.custom-engine.expanded');
      if (card) {
        // ok = 管线通（URL 可达 + 响应体可解析）；count = 实际命中数，二者独立：
        // 小众引擎对探测词 0 命中是正常的，此时显示「接口可达」而非误导为失败。
        // 文案不带 ✓/✗ 字符图标（iconLanguage 守卫：UI 图标语言 = icons.ts SVG），
        // 成败区分由 .ok/.fail 的语义色承担（状态点 + 文字色）。
        const status = ok
          ? count > 0
            ? l10n.t('Verified: {0} results returned', count)
            : l10n.t('Endpoint reachable, but no results were parsed (0)')
          : l10n.t('Failed: {0}', error ?? l10n.t('no results ({0})', count));
        setStatus(card, status, ok ? 'ok' : 'fail');
        // 状态点只在「确有命中」时点亮 ok；接口可达但 0 命中保持中性，不误导
        if (ok && count > 0) card.querySelector<HTMLElement>('.ce-dot')?.classList.add('ok');
        const sampleEl = card.querySelector<HTMLElement>('.ce-sample');
        if (sampleEl) {
          sampleEl.innerHTML = '';
          for (const s of sample ?? []) {
            const li = doc.createElement('li');
            // textContent 安全路径：样例标题/URL 来自外部接口，绝不进 innerHTML
            li.textContent = `${s.title} · ${s.url}`;
            sampleEl.appendChild(li);
          }
        }
      }
    }
    if (msg.type === 'search_engine_status' && engineSelect) {
      engineSelect.value = msg.engine;
    }
    if (msg.type === 'reset_user_data_result') {
      if (msg.ok) {
        // 成功：窗口即将重载，按钮保持禁用（恢复无意义）
        if (resetBtn) resetBtn.textContent = l10n.t('Reloading soon…');
      } else {
        // 失败/取消：恢复按钮可重试（host 侧各步骤幂等，重试安全）
        if (resetBtn) {
          resetBtn.disabled = false;
          resetBtn.textContent = l10n.t('Clear user-level data…');
        }
        if (resetHint) {
          resetHint.textContent = msg.message ?? l10n.t('Reset failed; please try again');
          resetHint.hidden = false;
          // 取消 ≠ 失败：用户主动取消不渲染成红色错误（谎报状态）
          resetHint.classList.toggle('security-reset-error', msg.cancelled !== true);
        }
      }
    }
  });
}
