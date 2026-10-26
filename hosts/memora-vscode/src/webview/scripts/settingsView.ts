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
 * 挂载顺序（重要约定）：config → memory → roles → skills → mcp → security。**ready 握手由
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
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { PRESET_SEARCH_ENGINES } from '../../shared/protocol.js';
import { createConfigView } from './configView.js';
import { createMemoryView } from './memoryView.js';
import { createRolesView } from './rolesView.js';
// MCP 子视图（观察面 + 增删改停启）已按域拆出：本文件是选项卡容器，不该长成第二个大文件
import { createMcpView } from './mcpView.js';
import { populateIcons } from './icons.js';
import { createPager, PagerController } from './pager.js';
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
type MountFactory = (deps: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}) => void;

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
  // 为什么是一张表而不是六段 try/catch：手抄版每加一页要复制 7 行样板，而「漏复制一段」
  // **不会让任何测试红**——该页有按钮无内容，只有真机能发现（2026-10-26 L3 审查实证：
  // 原注释承诺「加 tab 只改一行数组」与实际改动面差 5 处，本表把其中一处压回一行）。
  //
  // 顺序 = **初始化时序**（与 `SETTINGS_TABS` 的 UI 展示顺序不同，后者 memory 在首位）：
  // config / memory / roles 先（老三页），skills / mcp / security 后。改顺序前先确认无跨页依赖。
  //
  // 每个挂载独立 try/catch：任一子视图异常不阻断其余，尤其不能截断末尾的 ready 握手
  // （ready 未发 ⇒ host 不推数据 ⇒ 全面板空白）。
  const mounts: ReadonlyArray<{ name: SettingsTab; make: MountFactory }> = [
    { name: 'config', make: createConfigView },
    { name: 'memory', make: createMemoryView },
    { name: 'roles', make: createRolesView },
    { name: 'skills', make: createSkillsView },
    { name: 'mcp', make: createMcpView },
    { name: 'security', make: createSecurityView },
  ];
  for (const { name, make } of mounts) {
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
 * 技能子视图初始化与渲染
 *
 * 职责：
 *   - 监听 host 的 skills_loaded 消息，渲染全局技能列表（分页：全量前端切片）
 *   - 提供刷新按钮，触发 skills_load 请求
 */
function createSkillsView({
  vscode,
  window,
  root,
}: {
  vscode: { postMessage(msg: WebviewToExtensionMessage): void };
  window: Window;
  root: HTMLElement;
}): void {
  const listEl = root.querySelector<HTMLElement>('#skillsList');
  const countEl = root.querySelector<HTMLElement>('#skillCount');
  const refreshBtn = root.querySelector<HTMLButtonElement>('#btnRefreshSkills');
  const openDirBtn = root.querySelector<HTMLButtonElement>('#btnOpenSkillsDir');

  if (!listEl || !countEl || !refreshBtn) return;

  // L2 渐进披露：已加载的技能正文缓存（按技能名，跨分页保留——切页重建 DOM 后内容不丢）
  const contentMap = new Map<string, string>();
  /**
   * 已展开正文的技能名（**展开态唯一真源**，DOM 的 `hidden` 与按钮文案均由它派生）
   *
   * 为什么不能只存在 DOM 上：`renderSkillItems` 每次翻页 / 数据重推都会重建卡片 DOM。
   * 设置面板开了 `retainContextWhenHidden`，每次切回都会重推一次 `skills_loaded`
   * （见 settingsPanel.refreshAll）——展开态只挂在 DOM 上，用户正在读的正文每次切走
   * 再回来都会被收起，等于把「保上下文」反向抵消掉。
   */
  const expanded = new Set<string>();
  /** 全量技能列表（skills_loaded 全量推送到前端，分页组件本地切片） */
  let allSkills: SkillDto[] = [];

  /** 分页组件 renderPage 回调：渲染单页技能卡片（空数组不覆盖空态——renderSkills 已设） */
  function renderSkillItems(items: readonly SkillDto[]): void {
    if (!items || items.length === 0) return;
    // listEl 在函数入口 if 守卫后恒非空（闭包内 TS 不保留窄化，用非空断言）
    listEl!.innerHTML = items
      .map((s) => {
        const meta = LAYER_META[s.layer ?? 'builtin'];
        // L2 已缓存正文：预填 content（display 保持隐藏，点击「查看正文」才展开）
        const cached = contentMap.has(s.name) ? contentMap.get(s.name) || '（未找到技能正文）' : '';
        const isOpen = expanded.has(s.name);
        return `
    <div class="skill-item ${meta.item}" data-skill-name="${escapeHtml(s.name)}">
      <div class="skill-header">
        <h3 class="skill-name">${escapeHtml(s.name)}</h3>
        <span class="skill-badge ${meta.badge}">${meta.label}</span>
        ${s.health && s.health !== 'ok' ? `<span class="health-badge health-${s.health}">${s.health === 'error' ? '未生效' : '可优化'}</span>` : ''}
        ${s.disabled ? '<span class="disabled-badge" title="已在 memora.disabledSkills 中禁用：对模型不存在（不进清单 / 不可读取 / L3 不可达）">已禁用</span>' : ''}
        ${
          // 延长线开关：全局池（builtin/user）渲染真实禁用开关；角色包技能
          // 对禁用清单免疫（定案，随角色启停），渲染弱化说明文字替代开关——避免用户在卡片上
          // 找开关而不得。checked = 已禁用态；点击只发消息不本地翻转，以 skills_loaded 回推为准。
          s.layer === 'rolepack'
            ? '<span class="skill-rolepack-hint" title="角色包技能随角色启停：激活角色即启用技能集、切换角色即切换，不受禁用清单管理">随角色启停</span>'
            : `<label class="skill-disable-toggle" title="切换「${escapeHtml(s.name)}」的禁用状态（写入 memora.disabledSkills）">
                 <input type="checkbox" class="skill-disable-check" data-skill-name="${escapeHtml(s.name)}" aria-label="切换 ${escapeHtml(s.name)} 的禁用状态" ${s.disabled ? 'checked' : ''} />
                 <span class="skill-disable-slider"></span>
               </label>`
        }
        <button class="skill-content-toggle btn btn-ghost" data-skill-name="${escapeHtml(s.name)}" title="查看技能正文">${isOpen ? '收起正文' : '查看正文'}</button>
      </div>
      <p class="skill-desc">${escapeHtml(s.description)}</p>
      ${
        s.issues && s.issues.length > 0
          ? `<ul class="skill-problems">${s.issues.map((i) => `<li class="prob-${i.level}">${escapeHtml(i.message)}</li>`).join('')}</ul>`
          : ''
      }
      <div class="skill-content" ${isOpen ? '' : 'hidden'} ${cached ? '' : 'data-pending="1"'}>${escapeHtml(cached)}</div>
    </div>
  `;
      })
      .join('');
  }

  // 分页组件：技能全量前端分页。分页条插在列表之后；单页自动隐藏。
  let pagerCtrl: PagerController<SkillDto> | null = null;
  const pager = createPager<SkillDto>({
    root,
    mountRoot: root,
    anchor: listEl,
    pageSize: SKILL_PAGE_SIZE,
    renderPage: (items) => renderSkillItems(items),
    fetchPage: (page, pageSize) => {
      // 全量前端分页：本地数组切片后同步填充（总数为全量长度）
      const start = (page - 1) * pageSize;
      pagerCtrl!.show(page, allSkills.slice(start, start + pageSize), allSkills.length);
    },
  });
  pagerCtrl = pager;

  // 刷新按钮事件：**用户显式要求重载** ⇒ 缓存与展开态一并丢弃（与「被动重推」相反，
  // 见 skills_loaded 处理器——那条必须保状态，这条必须清状态，两者判据不同源）
  refreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'skills_load' });
    listEl.innerHTML = '<p class="loading-hint">加载中…</p>';
    contentMap.clear();
    expanded.clear();
  });

  // 打开目录按钮事件
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'skills_open_dir' });
    });
  }

  // L2：事件委托——点击「查看正文」按钮时请求内容或展开/折叠缓存内容
  listEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest(
      '.skill-content-toggle',
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const skillName = btn.dataset.skillName;
    if (!skillName) return;
    const contentEl = btn
      .closest('.skill-item')
      ?.querySelector('.skill-content') as HTMLElement | null;
    if (!contentEl) return;
    // 已加载 → 用缓存内容切换展开/折叠（切页重建 DOM 后缓存仍在，正文不丢）。
    // 展开态写回 `expanded`：DOM 只是投影，重推 / 翻页重建后靠它恢复。
    if (contentMap.has(skillName)) {
      const nextOpen = !expanded.has(skillName);
      if (nextOpen) expanded.add(skillName);
      else expanded.delete(skillName);
      contentEl.textContent = contentMap.get(skillName) || '（未找到技能正文）';
      contentEl.hidden = !nextOpen;
      btn.textContent = nextOpen ? '收起正文' : '查看正文';
      return;
    }
    // 未加载 → 请求内容
    btn.textContent = '加载中…';
    vscode.postMessage({ type: 'skills_read_content', skillName });
  });

  // S4 延长线开关：事件委托监听全局池技能卡片的禁用开关（change 事件冒泡）——
  // 只发送消息、**不本地乐观翻转**（以 host skills_loaded 回推为准，避免「点击显示已禁
  // 但实际未生效」的假象；host 侧写配置由既有 onDidChangeConfiguration 监听接管）
  listEl.addEventListener('change', (ev) => {
    const input = (ev.target as HTMLElement).closest(
      '.skill-disable-check',
    ) as HTMLInputElement | null;
    if (!input) return;
    const skillName = input.dataset.skillName;
    if (!skillName) return;
    vscode.postMessage({ type: 'toggle_skill_disabled', name: skillName, disabled: input.checked });
  });

  // 监听 host 的 skills_loaded 消息
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'skills_loaded') {
      // renderSkills 更新计数 + 处理空态，返回按三源排序的全量数组
      allSkills = renderSkills(listEl, countEl, msg.skills);
      // 禁用集「未找到需要禁用的技能」提示（非阻断，只进 UI）。
      // 语义 = 如实报告匹配结果，不归咎用户写错；允许提前禁用尚未安装的技能。
      renderUnmatchedDisabledTip(countEl, msg.unmatchedDisabled);
      // **被动重推 ≠ 重置**：本消息有三个触发面（首帧 ready / 技能变更回推 / 面板由隐藏
      // 转可见的 refreshAll）。旧实现一律回第 1 页 + 整体清空正文缓存 ⇒ 每次切走再回来
      // 都从第 1 页重新开始，正在读的正文要重新向宿主取一次。
      //   ① 页序未变就留在原页（页数变少时向前夹取到最后页）；
      //   ② 正文缓存按名字逐出**已消失**的技能，不整体清空。
      // 「整体清空」只属于用户显式点刷新（见 refreshBtn 处理器）——两个判据不同源，别合并。
      for (const name of [...contentMap.keys()]) {
        if (!allSkills.some((s) => s.name === name)) {
          contentMap.delete(name);
          expanded.delete(name);
        }
      }
      const pageCount = Math.max(1, Math.ceil(allSkills.length / SKILL_PAGE_SIZE));
      const page = Math.min(pager.getPage(), pageCount);
      pager.show(
        page,
        allSkills.slice((page - 1) * SKILL_PAGE_SIZE, page * SKILL_PAGE_SIZE),
        allSkills.length,
      );
    } else if (msg.type === 'skill_content') {
      // L2 渐进披露：渲染技能正文（缓存内容供分页切页重建）
      const item = listEl.querySelector(`[data-skill-name="${CSS.escape(msg.skillName)}"]`);
      // 应答即展开（下方两个分支都会把正文显示出来）⇒ 展开态同步落库，重推后才能复现
      expanded.add(msg.skillName);
      if (msg.content) {
        contentMap.set(msg.skillName, msg.content);
      } else {
        contentMap.set(msg.skillName, '');
      }
      if (item) {
        const btn = item.querySelector('.skill-content-toggle') as HTMLButtonElement | null;
        const contentEl = item.querySelector('.skill-content') as HTMLElement | null;
        if (btn && contentEl) {
          if (msg.content) {
            contentEl.textContent = msg.content;
            contentEl.hidden = false;
            btn.textContent = '收起正文';
          } else {
            contentEl.textContent = '（未找到技能正文）';
            contentEl.hidden = false;
            btn.textContent = '查看正文';
          }
        }
      }
    }
  });
}

/** 技能列表每页条数（分页组件；全量前端切片分页） */
const SKILL_PAGE_SIZE = 10;

/** 三源分类元数据（SSOT 收紧）：图层 item/badge class + 中文标签；模块级供分页渲染复用 */
const LAYER_META: Record<
  'builtin' | 'rolepack' | 'user',
  { item: string; badge: string; label: string }
> = {
  builtin: { item: 'skill-agent', badge: 'badge-agent', label: '内置' },
  rolepack: { item: 'skill-rolepack', badge: 'badge-rolepack', label: '角色包' },
  user: { item: 'skill-user', badge: 'badge-user', label: '用户' },
};

/**
 * 技能列表数据入口（skills_loaded 应答）：
 * 更新计数 + 处理空态，返回按三源排序的全量数组（分页组件据此切片渲染）。
 */
function renderSkills(listEl: HTMLElement, countEl: HTMLElement, skills: SkillDto[]): SkillDto[] {
  // 分别统计内置 / 启用角色包 / 用户三源技能
  const builtinCount = skills.filter((s) => s.layer === 'builtin').length;
  const rolePackCount = skills.filter((s) => s.layer === 'rolepack').length;
  const userCount = skills.filter((s) => s.layer === 'user').length;

  // 更新计数
  if (skills.length > 0) {
    const parts: string[] = [];
    if (builtinCount > 0) parts.push(`${builtinCount} 内置`);
    if (rolePackCount > 0) parts.push(`${rolePackCount} 角色包`);
    if (userCount > 0) parts.push(`${userCount} 用户`);
    countEl.textContent =
      parts.length > 0
        ? parts.join(' · ') + ` · 共 ${skills.length} 个`
        : `${skills.length} 个技能`;
    countEl.hidden = false;
  } else {
    countEl.hidden = true;
  }

  // 空状态（列表渲染由分页组件 renderPage 负责——renderSkillItems 空数组不覆盖）
  if (skills.length === 0) {
    listEl.innerHTML =
      '<p class="hint">暂无技能。<br><span class="btn-icon hint-icon" data-icon="folder"></span> 用户技能目录：<code>VS Code 全局存储 / skills /</code><br>在该目录下创建 <code>.md</code> 文件即可添加自定义技能。</p>';
    // 运行期设置 innerHTML → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充
    // （图标语言唯一 = icons.ts 柔和线条 SVG）
    populateIcons(listEl);
    return [];
  }

  // 按类型分组排序：内置 → 角色包 → 用户，同类型按名称排序
  const LAYER_ORDER: Record<'builtin' | 'rolepack' | 'user', number> = {
    builtin: 0,
    rolepack: 1,
    user: 2,
  };
  return [...skills].sort((a, b) => {
    const oa = LAYER_ORDER[a.layer ?? 'builtin'];
    const ob = LAYER_ORDER[b.layer ?? 'builtin'];
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 渲染「禁用集未匹配任何技能」的非阻断提示。
 *
 * 语义 = **「未找到需要禁用的技能」**：如实报告匹配结果，不归咎用户写错，
 * 兼容「提前禁用尚未安装的技能」。插在计数行之后、列表之前；每次 skills_loaded
 * 重建（移除旧提示再插新提示），避免重复堆积。
 */
function renderUnmatchedDisabledTip(countEl: HTMLElement, unmatched: string[] | undefined): void {
  // 清理上一次的提示（skills_loaded 可能连发，防堆积）；countEl 相邻节点即旧提示
  document.querySelector('.skill-unmatched-tip')?.remove();
  if (!unmatched || unmatched.length === 0) return;
  const tip = document.createElement('p');
  tip.className = 'skill-unmatched-tip';
  tip.textContent = `未找到需要禁用的技能：${unmatched.join('、')}`;
  countEl.after(tip);
}

/**
 * 安全子视图初始化与渲染（写入审批）
 *
 * 职责：
 *   - 渲染「写入二次确认」toggle 开关
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
  const toggle = root.querySelector<HTMLInputElement>('#confirmWritesToggle');
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

  // 开关切换事件：通知 host（仅当 toggle 存在时）
  if (toggle) {
    toggle.addEventListener('change', () => {
      vscode.postMessage({
        type: 'security_toggle',
        target: 'confirmWrites',
        enabled: toggle.checked,
      });
      if (statusEl) {
        statusEl.textContent = toggle.checked
          ? '已开启：写文件前将弹出审批卡'
          : '已关闭：写文件自动批准';
        statusEl.hidden = false;
      }
    });
  }

  // 脚本执行二次确认开关：通知 host（security_toggle target=confirmScripts）
  if (scriptsToggle) {
    scriptsToggle.addEventListener('change', () => {
      vscode.postMessage({
        type: 'security_toggle',
        target: 'confirmScripts',
        enabled: scriptsToggle.checked,
      });
      if (statusEl) {
        statusEl.textContent = scriptsToggle.checked
          ? '已开启：运行脚本/代码前将弹出审批卡'
          : '已关闭：脚本自动运行';
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
      if (toggle) toggle.checked = msg.confirmWrites;
      if (scriptsToggle) scriptsToggle.checked = msg.confirmScripts;
      if (statusEl) {
        const parts: string[] = [];
        parts.push(msg.confirmWrites ? '写文件前审批' : '写文件自动批准');
        parts.push(msg.confirmScripts ? '脚本/命令执行前审批' : '脚本/命令自动放行');
        statusEl.textContent = `已开启：${parts.join(' · ')}`;
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
