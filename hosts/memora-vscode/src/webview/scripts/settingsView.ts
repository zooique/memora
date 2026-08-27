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
  });

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

  // 技能子视图初始化（2026-08-22 新增）
  createSkillsView({ vscode, window, root: roots.skills });

  // 安全子视图初始化（H0 写入审批）
  createSecurityView({ vscode, window, root: roots.security });

  // ready 握手：三个子视图全部挂载（消息监听器已注册）后，由容器统一通知 host 就绪；
  // host 收到后统一推送三个子视图数据（对齐 chatPanel replaySession 的 ready 时序修复，
  // 避免首帧推送在监听器注册前到达而被丢弃）
  vscode.postMessage({ type: 'ready' });
}

/**
 * 技能子视图初始化与渲染
 *
 * 职责：
 *   - 监听 host 的 skills_loaded 消息，渲染全局技能列表
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

  // L2 渐进披露：已加载正文的技能名集合（避免重复请求）
  const loadedContents = new Set<string>();

  // 刷新按钮事件
  refreshBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'skills_load' });
    listEl.innerHTML = '<p class="loading-hint">加载中…</p>';
    loadedContents.clear();
  });

  // 打开目录按钮事件
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'skills_open_dir' });
    });
  }

  // L2：事件委托——点击「查看正文」按钮时请求内容
  listEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.skill-toggle') as HTMLButtonElement | null;
    if (!btn) return;
    const skillName = btn.dataset.skillName;
    if (!skillName) return;
    const contentEl = btn.closest('.skill-item')?.querySelector('.skill-content') as HTMLElement | null;
    if (!contentEl) return;
    // 已加载 → 切换展开/折叠
    if (loadedContents.has(skillName)) {
      const isHidden = contentEl.style.display === 'none';
      contentEl.style.display = isHidden ? 'block' : 'none';
      btn.textContent = isHidden ? '收起正文' : '查看正文';
      return;
    }
    // 未加载 → 请求内容
    btn.textContent = '加载中…';
    vscode.postMessage({ type: 'skills_read_content', skillName });
  });

  // 监听 host 的 skills_loaded 消息
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'skills_loaded') {
      renderSkills(listEl, countEl, msg.skills);
      loadedContents.clear();
    } else if (msg.type === 'skill_content') {
      // L2 渐进披露：渲染技能正文
      const item = listEl.querySelector(`[data-skill-name="${CSS.escape(msg.skillName)}"]`);
      if (item) {
        const btn = item.querySelector('.skill-toggle') as HTMLButtonElement | null;
        const contentEl = item.querySelector('.skill-content') as HTMLElement | null;
        if (btn && contentEl) {
          if (msg.content) {
            contentEl.textContent = msg.content;
            contentEl.style.display = 'block';
            btn.textContent = '收起正文';
            loadedContents.add(msg.skillName);
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

/** 渲染技能列表 */
function renderSkills(
  listEl: HTMLElement,
  countEl: HTMLElement,
  skills: SkillDto[],
): void {
  // 三源分类元数据（SSOT 收紧，2026-08-25）：图层 item/badge class + 中文标签
  const LAYER_META: Record<'builtin' | 'rolepack' | 'user', { item: string; badge: string; label: string }> = {
    builtin: { item: 'skill-agent', badge: 'badge-agent', label: '内置' },
    rolepack: { item: 'skill-rolepack', badge: 'badge-rolepack', label: '角色包' },
    user: { item: 'skill-user', badge: 'badge-user', label: '用户' },
  };
  const metaOf = (s: SkillDto) => LAYER_META[s.layer ?? 'builtin'];

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

  // 空状态
  if (skills.length === 0) {
    listEl.innerHTML = '<p class="hint">暂无技能。<br>📁 用户技能目录：<code>VS Code 全局存储 / skills /</code><br>在该目录下创建 <code>.md</code> 文件即可添加自定义技能。</p>';
    return;
  }

  // 按类型分组排序：内置 → 角色包 → 用户，同类型按名称排序
  const LAYER_ORDER: Record<'builtin' | 'rolepack' | 'user', number> = { builtin: 0, rolepack: 1, user: 2 };
  const sorted = [...skills].sort((a, b) => {
    const oa = LAYER_ORDER[a.layer ?? 'builtin'];
    const ob = LAYER_ORDER[b.layer ?? 'builtin'];
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });

  // 渲染技能卡片（L1 元数据 + L2 按需加载正文的展开区）
  listEl.innerHTML = sorted
    .map(
      (s) => `
    <div class="skill-item ${metaOf(s).item}" data-skill-name="${escapeHtml(s.name)}">
      <div class="skill-header">
        <h3 class="skill-name">${escapeHtml(s.name)}</h3>
        <span class="skill-badge ${metaOf(s).badge}">${metaOf(s).label}</span>
        ${s.health && s.health !== 'ok' ? `<span class="health-badge health-${s.health}">${s.health === 'error' ? '未生效' : '可优化'}</span>` : ''}
        ${s.trigger ? `<code class="skill-trigger">${escapeHtml(s.trigger)}</code>` : ''}
        <button class="skill-toggle btn btn-ghost" data-skill-name="${escapeHtml(s.name)}" title="查看技能正文">查看正文</button>
      </div>
      <p class="skill-desc">${escapeHtml(s.description)}</p>
      ${
        s.issues && s.issues.length > 0
          ? `<ul class="skill-problems">${s.issues.map((i) => `<li class="prob-${i.level}">${escapeHtml(i.message)}</li>`).join('')}</ul>`
          : ''
      }
      ${
        s.keywords.length > 0
          ? `<div class="skill-keywords">${s.keywords.map((k) => `<span class="keyword-chip">${escapeHtml(k)}</span>`).join('')}</div>`
          : ''
      }
      <div class="skill-content" style="display:none"></div>
    </div>
  `,
    )
    .join('');
}

/** HTML 转义（防注入） */
function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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
          `<button class="allowed-path-remove btn btn-ghost" type="button" data-index="${i}" aria-label="删除 ${escapeHtml(p)}">✕</button>` +
        `</li>`,
      );
    });
    listEl.innerHTML = rows.join('');
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

  // 监听 host 的 security_status / allowed_paths_status 消息
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
    const msg = event.data;
    if (msg.type === 'security_status' && toggle) {
      toggle.checked = msg.confirmWrites;
      if (statusEl) {
        statusEl.textContent = msg.confirmWrites ? '已开启：写文件前将弹出审批卡' : '已关闭：写文件自动批准';
        statusEl.hidden = false;
      }
    }
    if (msg.type === 'allowed_paths_status') {
      currentProjectPath = msg.projectPath;
      currentPaths = msg.paths ?? [];
      renderAllowedPaths();
    }
  });
}

/**
 * 记忆诊断子视图初始化与渲染（已移除：2026-08-24 第一性原理复盘，诊断粒度超越主流且
 * 明文 JSON 已可读，内核治理机制（取代/加权/自然沉底）强制自动跑，无终端用户场景）
 */
