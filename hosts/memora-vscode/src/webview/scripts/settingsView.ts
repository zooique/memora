/**
 * settingsView — 设置面板 webview 运行时脚本（2026-08-17 选项卡合并）
 *
 * 由 settingsPanel.ts 的 buildHtml 引用：以工厂函数 createSettingsView 接收依赖
 * （acquireVsCodeApi / window）并初始化全部交互。
 *
 * 职责：
 *   - 选项卡栏切换（角色 / 大模型 / 记忆）：点击按钮切换高亮 + 显示对应子视图；
 *   - 挂载三个子视图工厂（rolesView / configView / memoryView），共享同一 webview 文档，
 *     各自以 root 容器隔离 id 空间（#list/#statBar 等在各自根内不冲突）；
 *   - 监听 host 的 settings_switch_tab 指令（configureModel 命令 → 大模型选项卡）。
 *
 * 挂载顺序（重要约定）：config → memory → roles。rolesView 在挂载末尾发送 ready 握手，
 * host 收到 ready 时全部监听器（含 settings_switch_tab 与本文件内已注册的）都已就绪，
 * 可安全补发待切选项卡 —— 对齐 chatPanel replaySession 的 ready 时序修复范式。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/settingsView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src cspSource）。
 */
import type {
  ExtensionToWebviewMessage,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createConfigView } from './configView.js';
import { createMemoryView } from './memoryView.js';
import { createRolesView } from './rolesView.js';
import { populateIcons } from './icons.js';
import { createPager, PagerController } from './pager.js';
// escapeHtml：HTML 转义纯函数单一真理源（SSOT 收敛 2026-09-21，见 helpers/escapeHtml.ts）
import { escapeHtml } from '../helpers/escapeHtml.js';

/** settingsView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface SettingsViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象 */
  window: Window;
}

/** 子选项卡标识（与 HTML 中 data-tab / 根容器 id 对齐） */
type SettingsTab = 'roles' | 'config' | 'memory' | 'skills' | 'security';

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
  const roots: Record<SettingsTab, HTMLElement> = {
    roles: document.getElementById('roles-root') as HTMLElement,
    config: document.getElementById('config-root') as HTMLElement,
    memory: document.getElementById('memory-root') as HTMLElement,
    skills: document.getElementById('skills-root') as HTMLElement,
    security: document.getElementById('security-root') as HTMLElement,
  };

  /** 切换子选项卡：高亮对应按钮 + 显示对应根容器（其余隐藏；保留子视图 DOM 不重建，无闪烁） */
  function switchTab(tab: SettingsTab): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    (Object.keys(roots) as SettingsTab[]).forEach((key) => {
      roots[key].hidden = key !== tab;
    });
  }

  // 点击选项卡按钮切换
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'roles' || tab === 'config' || tab === 'memory' || tab === 'skills' || tab === 'security') switchTab(tab);
    });
  });

  // host 指令切换（configureModel 命令 → 大模型选项卡）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'settings_switch_tab') switchTab(msg.tab);
    else if (msg.type === 'notice') showSettingsNotice(msg.level, msg.message);
  });

  /** 通知 toast 自动隐藏计时器（连续 notice 复用同元素，需 clearTimeout 重置） */
  let toastTimer: number | null = null;

  /**
   * 展示设置面板全局通知 toast（settingsPanel 通过 notice 推送操作反馈）。
   *
   * settings 视图消费 notice（角色/模型/引擎/审批等操作反馈）的唯一入口——
   * 不消费则操作反馈被静默丢弃（SSOT 跨侧断链）。实现为最小侵入——不复用 chatView 的 activity-history
   * 复杂度，仅单条临时胶囊条，textContent 渲染防注入。
   *
   * @param level 级别（error 标红醒目，info 常规）
   * @param message 文本正文
   */
  function showSettingsNotice(level: 'info' | 'error', message: string): void {
    let toast = document.getElementById('settings-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'settings-toast';
      toast.className = 'settings-toast';
      document.body.appendChild(toast);
    }
    // textContent 渲染（XXS 纪律：用户可控文本不进 innerHTML）
    toast.className = 'settings-toast' + (level === 'error' ? ' error' : '');
    toast.textContent = message;
    // 强制重排以重启过渡动画（同元素连续展示时 opacity transition 不自动重触发）
    void toast.offsetWidth;
    toast.classList.add('show');
    window.clearTimeout(toastTimer as number);
    toastTimer = window.setTimeout(() => toast?.classList.remove('show'), 2500);
  }

  // 挂载三个子视图（config/memory 先，roles 后；全部用共享 vscode 实例）。
  // 初始选项卡为「记忆」，与 HTML 默认态一致（用户请求 2026-08-17）。
  // 每个挂载独立 try/catch：任一子视图挂载异常不阻断其余子视图，错误输出到 webview console。
  try {
    createConfigView({ vscode, window, root: roots.config });
  } catch (err) {
    console.error('[memora-settings] configView 挂载失败:', err);
  }
  try {
    createMemoryView({ vscode, window, root: roots.memory });
  } catch (err) {
    console.error('[memora-settings] memoryView 挂载失败:', err);
  }
  try {
    createRolesView({ vscode, window, root: roots.roles });
  } catch (err) {
    console.error('[memora-settings] rolesView 挂载失败:', err);
  }

  // 技能子视图初始化（2026-08-22 新增）：独立 try/catch（对齐上方三挂载），
  // 防单视图挂载异常截断后续 security 挂载与 ready 握手（ready 未发 → host 不推数据，全面板空白）
  try {
    createSkillsView({ vscode, window, root: roots.skills });
  } catch (err) {
    console.error('[memora-settings] skillsView 挂载失败:', err);
  }

  // 安全子视图初始化（H0 写入审批）
  try {
    createSecurityView({ vscode, window, root: roots.security });
  } catch (err) {
    console.error('[memora-settings] securityView 挂载失败:', err);
  }

  // ready 握手：三个子视图全部挂载（消息监听器已注册）后，由容器统一通知 host 就绪；
  // host 收到后统一推送三个子视图数据（对齐 chatPanel replaySession 的 ready 时序修复，
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
        return `
    <div class="skill-item ${meta.item}" data-skill-name="${escapeHtml(s.name)}">
      <div class="skill-header">
        <h3 class="skill-name">${escapeHtml(s.name)}</h3>
        <span class="skill-badge ${meta.badge}">${meta.label}</span>
        ${s.health && s.health !== 'ok' ? `<span class="health-badge health-${s.health}">${s.health === 'error' ? '未生效' : '可优化'}</span>` : ''}
        ${s.disabled ? '<span class="disabled-badge" title="已在 memora.disabledSkills 中禁用：对模型不存在（不进清单 / 不可读取 / L3 不可达）">已禁用</span>' : ''}
        ${
          // S4 延长线开关（2026-09-22）：全局池（builtin/user）渲染真实禁用开关；角色包技能
          // 对禁用清单免疫（定案，随角色启停），渲染弱化说明文字替代开关——避免用户在卡片上
          // 找开关而不得。checked = 已禁用态；点击只发消息不本地翻转，以 skills_loaded 回推为准。
          s.layer === 'rolepack'
            ? '<span class="skill-rolepack-hint" title="角色包技能随角色启停：激活角色即启用技能集、切换角色即切换，不受禁用清单管理">随角色启停</span>'
            : `<label class="skill-disable-toggle" title="切换「${escapeHtml(s.name)}」的禁用状态（写入 memora.disabledSkills）">
                 <input type="checkbox" class="skill-disable-check" data-skill-name="${escapeHtml(s.name)}" aria-label="切换 ${escapeHtml(s.name)} 的禁用状态" ${s.disabled ? 'checked' : ''} />
                 <span class="skill-disable-slider"></span>
               </label>`
        }
        <button class="skill-content-toggle btn btn-ghost" data-skill-name="${escapeHtml(s.name)}" title="查看技能正文">查看正文</button>
      </div>
      <p class="skill-desc">${escapeHtml(s.description)}</p>
      ${
        s.issues && s.issues.length > 0
          ? `<ul class="skill-problems">${s.issues.map((i) => `<li class="prob-${i.level}">${escapeHtml(i.message)}</li>`).join('')}</ul>`
          : ''
      }
      <div class="skill-content" style="display:none" ${cached ? '' : 'data-pending="1"'}>${escapeHtml(cached)}</div>
    </div>
  `;
      })
      .join('');
  }

  // 分页组件（2026-09-08）：技能全量前端分页。分页条插在列表之后；单页自动隐藏。
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

  // 刷新按钮事件
  refreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'skills_load' });
    listEl.innerHTML = '<p class="loading-hint">加载中…</p>';
    contentMap.clear();
  });

  // 打开目录按钮事件
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'skills_open_dir' });
    });
  }

  // L2：事件委托——点击「查看正文」按钮时请求内容或展开/折叠缓存内容
  listEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.skill-content-toggle') as HTMLButtonElement | null;
    if (!btn) return;
    const skillName = btn.dataset.skillName;
    if (!skillName) return;
    const contentEl = btn.closest('.skill-item')?.querySelector('.skill-content') as HTMLElement | null;
    if (!contentEl) return;
    // 已加载 → 用缓存内容切换展开/折叠（切页重建 DOM 后缓存仍在，正文不丢）
    if (contentMap.has(skillName)) {
      const isHidden = contentEl.style.display === 'none';
      contentEl.textContent = contentMap.get(skillName) || '（未找到技能正文）';
      contentEl.style.display = isHidden ? 'block' : 'none';
      btn.textContent = isHidden ? '收起正文' : '查看正文';
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
    const input = (ev.target as HTMLElement).closest('.skill-disable-check') as HTMLInputElement | null;
    if (!input) return;
    const skillName = input.dataset.skillName;
    if (!skillName) return;
    vscode.postMessage({ type: 'toggle_skill_disabled', name: skillName, disabled: input.checked });
  });

  // 监听 host 的 skills_loaded 消息
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'skills_loaded') {
      // renderSkills 更新计数 + 处理空态，返回按三源排序的全量数组 → 分页组件回第 1 页
      allSkills = renderSkills(listEl, countEl, msg.skills);
      // D（2026-09-22）：禁用集「未找到需要禁用的技能」提示（非阻断，只进 UI）。
      // 语义 = 如实报告匹配结果，不归咎用户写错；允许提前禁用尚未安装的技能。
      renderUnmatchedDisabledTip(countEl, msg.unmatchedDisabled);
      contentMap.clear();
      pager.show(1, allSkills.slice(0, SKILL_PAGE_SIZE), allSkills.length);
    } else if (msg.type === 'skill_content') {
      // L2 渐进披露：渲染技能正文（缓存内容供分页切页重建）
      const item = listEl.querySelector(`[data-skill-name="${CSS.escape(msg.skillName)}"]`);
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
            contentEl.style.display = 'block';
            btn.textContent = '收起正文';
          } else {
            contentEl.textContent = '（未找到技能正文）';
            contentEl.style.display = 'block';
            btn.textContent = '查看正文';
          }
        }
      }
    }
  });
}

/** 技能列表每页条数（2026-09-08 分页组件；全量前端切片分页） */
const SKILL_PAGE_SIZE = 10;

/** 三源分类元数据（SSOT 收紧，2026-08-25）：图层 item/badge class + 中文标签；模块级供分页渲染复用 */
const LAYER_META: Record<'builtin' | 'rolepack' | 'user', { item: string; badge: string; label: string }> = {
  builtin: { item: 'skill-agent', badge: 'badge-agent', label: '内置' },
  rolepack: { item: 'skill-rolepack', badge: 'badge-rolepack', label: '角色包' },
  user: { item: 'skill-user', badge: 'badge-user', label: '用户' },
};

/**
 * 技能列表数据入口（skills_loaded 应答）：
 * 更新计数 + 处理空态，返回按三源排序的全量数组（分页组件据此切片渲染）。
 */
function renderSkills(
  listEl: HTMLElement,
  countEl: HTMLElement,
  skills: SkillDto[],
): SkillDto[] {
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
    countEl.textContent = parts.length > 0 ? parts.join(' · ') + ` · 共 ${skills.length} 个` : `${skills.length} 个技能`;
    countEl.hidden = false;
  } else {
    countEl.hidden = true;
  }

  // 空状态（列表渲染由分页组件 renderPage 负责——renderSkillItems 空数组不覆盖）
  if (skills.length === 0) {
    listEl.innerHTML =
      '<p class="hint">暂无技能。<br><span class="btn-icon hint-icon" data-icon="folder"></span> 用户技能目录：<code>VS Code 全局存储 / skills /</code><br>在该目录下创建 <code>.md</code> 文件即可添加自定义技能。</p>';
    // 运行期设置 innerHTML → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充
    // （图标语言唯一 = icons.ts 柔和线条 SVG，原 📁 emoji 剪除，2026-09-19）
    populateIcons(listEl);
    return [];
  }

  // 按类型分组排序：内置 → 角色包 → 用户，同类型按名称排序
  const LAYER_ORDER: Record<'builtin' | 'rolepack' | 'user', number> = { builtin: 0, rolepack: 1, user: 2 };
  return [...skills].sort((a, b) => {
    const oa = LAYER_ORDER[a.layer ?? 'builtin'];
    const ob = LAYER_ORDER[b.layer ?? 'builtin'];
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 渲染「禁用集未匹配任何技能」的非阻断提示（D，2026-09-22）。
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
 * 安全子视图初始化与渲染（H0 写入审批）
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

  // ─── G8 白名单额外路径 ───
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
    // （图标语言唯一 = icons.ts 柔和线条 SVG，原 ✕ 字符剪除，2026-09-19）
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
      vscode.postMessage({ type: 'security_toggle', enabled: toggle.checked });
      if (statusEl) {
        statusEl.textContent = toggle.checked ? '已开启：写文件前将弹出审批卡' : '已关闭：写文件自动批准';
        statusEl.hidden = false;
      }
    });
  }

  // 脚本执行二次确认开关：通知 host（security_scripts_toggle，2026-09-08）
  if (scriptsToggle) {
    scriptsToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'security_scripts_toggle', enabled: scriptsToggle.checked });
      if (statusEl) {
        statusEl.textContent = scriptsToggle.checked ? '已开启：运行脚本/代码前将弹出审批卡' : '已关闭：脚本自动运行';
        statusEl.hidden = false;
      }
    });
  }

  // ─── 网页搜索引擎下拉（方案 A 2026-09-02）───
  const engineSelect = root.querySelector<HTMLSelectElement>('#searchEngineSelect');
  engineSelect?.addEventListener('change', () => {
    const engine = engineSelect.value;
    if (engine === 'auto' || engine === 'bing' || engine === 'baidu' || engine === 'sogou') {
      vscode.postMessage({ type: 'search_engine_set', engine });
    }
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
        parts.push(msg.confirmScripts ? '脚本执行前审批' : '脚本自动运行');
        statusEl.textContent = `已开启：${parts.join(' · ')}`;
        statusEl.hidden = false;
      }
    }
    if (msg.type === 'allowed_paths_status') {
      currentProjectPath = msg.projectPath;
      currentPaths = msg.paths ?? [];
      renderAllowedPaths();
    }
    if (msg.type === 'search_engine_status' && engineSelect) {
      engineSelect.value = msg.engine;
    }
  });
}


