/**
 * settingsView — 设置面板 webview 运行时脚本（选项卡合并）
 *
 * 由 settingsPanelHtml.ts 的 buildHtml 引用：以工厂函数 createSettingsView 接收依赖
 * （acquireVsCodeApi / window）并初始化全部交互。
 *
 * 职责：
 *   - 选项卡栏切换（全部 tab 的清单见 `shared/settingsTabs.ts`，本文件不写 tab 名单）：
 *     点击按钮切换高亮 + 显示对应子视图；
 *   - 挂载各子视图工厂，共享同一 webview 文档，各自以 root 容器隔离 id 空间
 *     （#list/#statBar 等在各自根内不冲突，故它们是「根内唯一」而非全局唯一）；
 *   - 监听 host 的 settings_switch_tab 指令（configureModel 命令 → 大模型选项卡）。
 *
 * 挂载顺序（重要约定）：config → memory → roles → skills → mcp → security → works。**ready 握手由
 * 容器在本函数末尾统一发出**（不是某个子视图发的）：等全部子视图挂载完、消息监听器都注册
 * 之后才请 host 推送，host 侧待切选项卡的补发才安全 —— 对齐 chatPanel replaySession 的
 * ready 时序修复范式。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/settingsView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  CustomSearchEngineConfig,
  ExtensionToWebviewMessage,
  HostParseStrategy,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
import { createConfigView } from './configView.js';
import { createMemoryView } from './memoryView.js';
import { createRolesView } from './rolesView.js';
// MCP 子视图（观察面 + 增删改停启）已按域拆出：本文件是选项卡容器，不该长成第二个大文件
import { createMcpView } from './mcpView.js';
import { createWorksView } from './worksView.js';
// 技能子视图已按 tab 外置（分页 / 禁用名单 / 正文渐进披露自成一域；本地化判据按文件登记）
import { createSkillsView } from './skillsView.js';
import { populateIcons } from './icons.js';
// escapeHtml：HTML 转义纯函数单一真理源（SSOT 收敛，见 helpers/escapeHtml.ts）
import { escapeHtml } from '../helpers/escapeHtml.js';
// 全局通知 toast 单一实现（UI-TOAST-1 三面收口：settings notice 与 config 操作反馈合一）
import { showToast } from '../helpers/toast.js';
import {
  SETTINGS_TABS,
  isSettingsTab,
  settingsRootId,
  type SettingsTab,
} from '../../shared/settingsTabs.js';

/** settingsView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface SettingsViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/**
 * 子视图挂载工厂的公共签名
 *
 * 六个 `createXxxView` 各自的 Deps 接口（`ConfigViewDeps` / `MemoryViewDeps` / …）结构完全一致
 * （vscode / window / root 三字段），TS 结构类型下可直接赋给本签名 ⇒ 数组驱动挂载表无需改动
 * 那六个文件。任一视图**新增必填依赖**时本表会编译红——这正是想要的：新增依赖意味着
 * 「谁提供它」需要重议，不该静默塞进容器。
 */
export type MountFactory = (deps: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}) => void;

/**
 * 子视图挂载表（**顺序 = 初始化时序**，≠ `SETTINGS_TABS` 的 UI 顺序；后者 memory 在首位）
 *
 * config / memory / roles 先（老三页），skills / mcp / security 后。改顺序前先确认无跨页依赖。
 *
 * **为什么在模块级导出**（2026-10-26）：这张表此前在 `createSettingsView` 函数作用域内 ⇒
 * `settingsTabs.ts` 文件头承诺的「加一页 = ④ 本表一行」**无法被任何测试钉住**，而漏一行的
 * 表现是「该页有按钮、无内容」，tsc 与其他测试全绿、只有真机能发现（该文件自注「④-⑥ 缺 =
 * 静默半残，测试红不了」）。导出后由 `settingsView.test.ts` 断言「表内 name 集合 ==
 * `SETTINGS_TABS`」把这条承诺变成可红的——**这是本表能被写成承诺的前提，勿再移回函数内**。
 */
export const SETTINGS_VIEW_MOUNTS: ReadonlyArray<{ name: SettingsTab; make: MountFactory }> = [
  { name: 'config', make: createConfigView },
  { name: 'memory', make: createMemoryView },
  { name: 'roles', make: createRolesView },
  { name: 'skills', make: createSkillsView },
  { name: 'mcp', make: createMcpView },
  { name: 'security', make: createSecurityView },
  { name: 'works', make: createWorksView },
];

/**
 * 初始化设置面板 webview 交互（选项卡切换 + 挂载三个子视图）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createSettingsView({ acquireVsCodeApi, window }: SettingsViewDeps): void {
  const document = window.document;
  // SSOT：acquireVsCodeApi 每个 webview 只能调用一次，此处获取一次并注入三个子视图，
  // 避免子视图各自调用导致后续调用返回失效对象、postMessage 静默失败（角色/记忆卡加载根因）
  const vscode = acquireVsCodeApi();

  // 填充 HTML 中的图标容器（统一 SVG 图标管理）
  populateIcons(document.body);

  // 选项卡按钮 + 四个子视图根容器（HTML 骨架固定 id，查询走全局 getElementById——
  // 根容器本身是唯一 id，只有根容器【内部】的子元素才做 root 内查询隔离）
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  // 根容器集合按 tab 表派生（`settingsRootId` 保证 id 与 HTML 同源）——此前 5 个 id 手写在
  // 本文件、产线 HTML、CSS 三处，加 tab 忘一处即「点了没反应」且无编译报错。
  const roots = {} as Record<SettingsTab, HTMLElement>;
  SETTINGS_TABS.forEach((tab) => {
    roots[tab] = document.getElementById(settingsRootId(tab)) as HTMLElement;
  });

  /** 切换子选项卡：高亮对应按钮 + 显示对应根容器（其余隐藏；保留子视图 DOM 不重建，无闪烁） */
  function switchTab(tab: SettingsTab): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    SETTINGS_TABS.forEach((key) => {
      roots[key].hidden = key !== tab;
    });
  }

  // 点击选项卡按钮切换（`data-tab` 值先由 isSettingsTab 收窄：原先是五路 `tab === 'x' || …`
  // 手写比对，漏写一路的表现是「点了没反应」而不是报错）
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (isSettingsTab(tab)) switchTab(tab);
    });
  });

  // ─── 「在设置中调整 / 编辑」导航按钮（页面级统一绑定，**勿下放到子视图**） ───
  // `open_setting` 是页面级导航意图（跳到原生设置对应键），与任何子视图的状态无关 ⇒
  // 绑在容器层、事件委托到 document：任一选项卡新增同类按钮只需写 data-setting-key，零 JS 改动；
  // 子视图后续动态插入的同类按钮也自动生效（`querySelectorAll` 快照做不到）。
  //
  // 反面教材（2026-10-24 实测）：MCP 页首版复用了 `.open-setting-btn` + data-setting-key，但绑定
  // 语句留在安全子视图内查 `#security-root` ⇒ MCP 页的「在设置中编辑」**有按钮、无监听器**，
  // 点击零反应，且无编译错、无测试红（该类按钮当时只有一条用例，且查的是安全页那颗）。
  document.addEventListener('click', (event) => {
    const btn = (event.target as Element | null)?.closest<HTMLButtonElement>('.open-setting-btn');
    const key = btn?.dataset.settingKey;
    if (!key) return;
    vscode.postMessage({ type: 'open_setting', key });
  });

  // host 指令切换（configureModel 命令 → 大模型选项卡）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'settings_switch_tab') switchTab(msg.tab);
    // notice 是 settings 侧操作反馈（角色/模型/引擎/审批等）的唯一入口——不消费则反馈被
    // 静默丢弃（SSOT 跨侧断链）。toast 实现已收口到 helpers/toast.ts（UI-TOAST-1：与
    // config 操作反馈、chat 活动条同元素/同时长/同分级/同令牌，勿在本文件再写一份）。
    else if (msg.type === 'notice') showToast(document, msg.level, msg.message);
  });

  // 挂载各子视图（数据驱动；全部用共享 vscode 实例）。
  // 每个挂载独立 try/catch：任一子视图异常不阻断其余，尤其不能截断末尾的 ready 握手
  // （ready 未发 ⇒ host 不推数据 ⇒ 全面板空白）。表内容与顺序见模块级 SETTINGS_VIEW_MOUNTS。
  for (const { name, make } of SETTINGS_VIEW_MOUNTS) {
    try {
      make({ vscode, window, root: roots[name] });
    } catch (err) {
      console.error(`[memora-settings] ${name}View 挂载失败:`, err);
    }
  }

  // ready 握手：全部子视图挂载（消息监听器已注册）后，由容器统一通知 host 就绪；
  // host 收到后统一推送各子视图数据（对齐 chatPanel replaySession 的 ready 时序修复，
  // 避免首帧推送在监听器注册前到达而被丢弃）
  vscode.postMessage({ type: 'ready' });
}

/**
 * 安全子视图初始化与渲染（执行确认 + 路径白名单）
 *
 * 职责：
 *   - 渲染「执行二次确认」toggle 开关（写入确认开关已退役：写文件一律直接落盘）
 *   - 监听 host 的 security_status 消息更新开关状态
 *   - 开关切换时发送 security_toggle 消息通知 host
 */
function createSecurityView({
  vscode,
  window,
  root,
}: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}): void {
  const scriptsToggle = root.querySelector<HTMLInputElement>('#confirmScriptsToggle');
  const statusEl = root.querySelector<HTMLElement>('#securityStatus');

  // ─── 白名单额外路径 ───
  let currentProjectPath = '';
  let currentPaths: string[] = [];

  const listEl = root.querySelector<HTMLUListElement>('#allowedPathsList');
  const inputEl = root.querySelector<HTMLInputElement>('#allowedPathsInput');
  const addBtn = root.querySelector<HTMLButtonElement>('#allowedPathsAdd');

  function renderAllowedPaths(): void {
    if (!listEl) return;
    const rows: string[] = [];
    // 基准根（只读、灰显，不可删除）
    if (currentProjectPath) {
      rows.push(
        `<li class="allowed-path-row allowed-path-base">` +
          `<span class="allowed-path-text" title="${escapeHtml(currentProjectPath)}">${escapeHtml(currentProjectPath)}</span>` +
          `<span class="allowed-path-tag">基准（始终允许）</span>` +
          `</li>`,
      );
    }
    // 用户额外目录（可删除，按索引定位避免路径含引号破坏属性）
    currentPaths.forEach((p, i) => {
      rows.push(
        `<li class="allowed-path-row">` +
          `<span class="allowed-path-text" title="${escapeHtml(p)}">${escapeHtml(p)}</span>` +
          `<button class="allowed-path-remove btn btn-ghost" type="button" data-index="${i}" aria-label="删除 ${escapeHtml(p)}"><span class="btn-icon" data-icon="close"></span></button>` +
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
          ? '已开启：脚本/命令执行前审批'
          : '已关闭：脚本/命令自动放行';
        statusEl.hidden = false;
      }
    });
  }

  // ─── 「在设置中调整」导航按钮 ───
  // 绑定已上移到 createSettingsView（页面级事件委托）：`open_setting` 与安全子视图无关，
  // 绑在这里会让别的选项卡（MCP 页）复用同一 class 时静默失效。**勿在此处加回。**

  // ─── 网页搜索引擎下拉（选项由 custom_search_engines_status 动态重建，单一真理源 PRESET_SEARCH_ENGINES）───
  const engineSelect = root.querySelector<HTMLSelectElement>('#searchEngineSelect');
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
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name === 'auto' ? '自动（Bing → DuckDuckGo）' : name;
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
  let editingIndex: number | null = null;
  let editingDraft: CustomSearchEngineConfig | null = null;
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

  function setStatus(card: HTMLElement, text: string, kind: 'ok' | 'fail' | 'idle'): void {
    const el = card.querySelector<HTMLSpanElement>('.ce-test-status');
    if (!el) return;
    el.textContent = text;
    el.className = `ce-test-status${kind === 'idle' ? '' : ` ${kind}`}`;
  }

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
    const card = document.createElement('div');
    card.className = `custom-engine${expanded ? ' expanded' : ''}`;
    card.innerHTML = `
      <div class="ce-summary">
        <span class="ce-dot"></span>
        <span class="ce-label">${escapeHtml(cfg.name || '新引擎')}</span>
        <span class="ce-host">${escapeHtml(cfg.urlTemplate ? hostOf(cfg.urlTemplate) : '未填写 URL')}</span>
        <button class="ce-edit btn btn-secondary" type="button">${expanded ? '收起' : '编辑'}</button>
        ${isDraft ? '' : '<button class="ce-remove btn btn-secondary" type="button">删除</button>'}
      </div>
      ${
        expanded
          ? `<div class="ce-editor">
        <label class="ce-field"><span>名称</span><input class="ce-name" type="text" placeholder="引擎名" aria-label="引擎名" value="${escapeHtml(cfg.name)}" /></label>
        <label class="ce-field"><span>URL</span><input class="ce-url" type="text" placeholder="https://example.com/search?q={query}" aria-label="搜索 URL" value="${escapeHtml(cfg.urlTemplate)}" /></label>
        <label class="ce-field"><span>策略</span><select class="ce-parse" aria-label="解析策略">
          <option value="openSearchRss">OpenSearch RSS / Atom</option>
          <option value="jsonApi">JSON 搜索 API</option>
        </select></label>
        <div class="ce-actions">
          <button class="ce-test btn btn-secondary" type="button">测试</button>
          <button class="ce-save btn" type="button">保存</button>
          <button class="ce-cancel btn btn-secondary" type="button">取消</button>
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
        if (labelEl) labelEl.textContent = rawName || '新引擎';
        if (hostEl) hostEl.textContent = rawUrl ? hostOf(rawUrl) : '未填写 URL';
      };
      nameInput?.addEventListener('input', commitDraft);
      urlInput?.addEventListener('input', commitDraft);
      parseSelect?.addEventListener('change', commitDraft);
      // 「测试」：把当前表单内容交给 host 实测抓取+解析（纯预览，无持久化语义）
      card.querySelector<HTMLButtonElement>('.ce-test')?.addEventListener('click', () => {
        setStatus(card, '验证中…', 'idle');
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
    resetBtn.textContent = '清理中…';
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
          ? '已开启：脚本/命令执行前审批'
          : '已关闭：脚本/命令自动放行';
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
            ? `验证通过，返回 ${count} 条`
            : '接口可达，但未解析出结果（0 条）'
          : `未通过：${error ?? `无结果（${count} 条）`}`;
        setStatus(card, status, ok ? 'ok' : 'fail');
        // 状态点只在「确有命中」时点亮 ok；接口可达但 0 命中保持中性，不误导
        if (ok && count > 0) card.querySelector<HTMLElement>('.ce-dot')?.classList.add('ok');
        const sampleEl = card.querySelector<HTMLElement>('.ce-sample');
        if (sampleEl) {
          sampleEl.innerHTML = '';
          for (const s of sample ?? []) {
            const li = document.createElement('li');
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
        if (resetBtn) resetBtn.textContent = '即将重载…';
      } else {
        // 失败/取消：恢复按钮可重试（host 侧各步骤幂等，重试安全）
        if (resetBtn) {
          resetBtn.disabled = false;
          resetBtn.textContent = '清空用户级数据…';
        }
        if (resetHint) {
          resetHint.textContent = msg.message ?? '初始化失败，请重试';
          resetHint.hidden = false;
          // 取消 ≠ 失败：用户主动取消不渲染成红色错误（谎报状态）
          resetHint.classList.toggle('security-reset-error', msg.cancelled !== true);
        }
      }
    }
  });
}
