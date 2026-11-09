/**
 * skillsView — 设置面板「全局技能」选项卡运行时（自 settingsView.ts 外置）
 *
 * 为什么独立成文件（同 rolesView / memoryView / configView）：
 *   - settingsView.ts 曾同时承载技能与安全两个子视图，而本地化判据按**文件**登记——文件里只要
 *     还留着安全页中文，技能页就不能登记 migrated（判据⑰ 生效不了）。按 tab 外置后每页可见文案
 *     各自成网，安全页随 B7 批次外置。
 *   - 技能域自身职责已足够重（分页 / 禁用名单 / 正文渐进披露 / 项目→用户级提升），与选项卡容器
 *     分离后容器只保留「挂载表 + 切换 + ready 握手」。
 *
 * 行为零变更：代码原样搬移，只把 createSkillsView 改为导出。
 */

// 命名空间导入而非裸 `t`：静态键采集（判据⑨）只认 `l10n.t('…')`
import * as l10n from '@vscode/l10n';
import type {
  ExtensionToWebviewMessage,
  SkillDto,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { createPager, PagerController } from './pager.js';
import { populateIcons } from './icons.js';
// escapeHtml：HTML 转义纯函数单一真理源（SSOT 收敛，见 helpers/escapeHtml.ts）
import { escapeHtml } from '../helpers/escapeHtml.js';
/**
 * 技能子视图初始化与渲染
 *
 * 职责：
 *   - 监听 host 的 skills_loaded 消息，渲染全局技能列表（分页：全量前端切片）
 *   - 提供刷新按钮，触发 skills_load 请求
 */
export function createSkillsView({
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
        const cached = contentMap.has(s.name)
          ? contentMap.get(s.name) || l10n.t('(Skill content not found)')
          : '';
        const isOpen = expanded.has(s.name);
        // 延长线开关：全局池（builtin/user）渲染真实禁用开关；角色包技能对禁用清单免疫（定案，
        // 随角色启停），渲染弱化说明文字替代开关——避免用户在卡片上找开关而不得。
        // checked = 已禁用态；点击只发消息不本地翻转，以 skills_loaded 回推为准。
        // 注释必须留在模板串之外：守卫把模板串整体当字符串扫 CJK，注释写在 `${}` 里会被判残留。
        const toggleHtml =
          s.layer === 'rolepack'
            ? `<span class="skill-rolepack-hint" title="${l10n.t('Role pack skills follow the role: activating a role enables its skill set and switching swaps it; they are not managed by the disabled list')}">${l10n.t('Follows the role')}</span>`
            : `<label class="skill-disable-toggle" title="${l10n.t('Toggle the disabled state of "{0}" (writes to memora.disabledSkills)', escapeHtml(s.name))}">
                 <input type="checkbox" class="skill-disable-check" data-skill-name="${escapeHtml(s.name)}" aria-label="${l10n.t('Toggle the disabled state of {0}', escapeHtml(s.name))}" ${s.disabled ? 'checked' : ''} />
                 <span class="skill-disable-slider"></span>
               </label>`;
        // 项目级技能专属动作：复制一份到用户级。用户级目录已收回 LLM 写权限，升级路径只此一条
        //（宿主事务化复制）；标题必须写清「拷贝非同步」。
        const promoteHtml =
          s.layer === 'project'
            ? `<button class="skill-promote btn btn-secondary" data-skill-name="${escapeHtml(s.name)}" title="${l10n.t('Copy into the user-level directory (a copy, not a sync; an existing item is backed up before being overwritten, and failure rolls back)')}">${l10n.t('Add to user level')}</button>`
            : '';
        // 同名覆盖事实（合法覆盖语义的可见出口）：让用户知道本条盖掉了谁，而不是静默吞并。
        // 只陈述来源，不改变生效者、不引导用户「修复」——覆盖本身不是错误。
        const overrideHtml = s.overriddenLayer
          ? `<p class="skill-override">${l10n.t('Overrides the same-named {0} skill (the overridden version is not shown in this list)', l10n.t(LAYER_LABELS[s.overriddenLayer]))}</p>`
          : '';
        return `
    <div class="skill-item ${meta.item}" data-skill-name="${escapeHtml(s.name)}">
      <div class="skill-header">
        <h3 class="skill-name">${escapeHtml(s.displayName ?? s.name)}</h3>
        <span class="skill-badge ${meta.badge}">${l10n.t(LAYER_LABELS[s.layer ?? 'builtin'])}</span>
        ${s.health && s.health !== 'ok' ? `<span class="health-badge health-${s.health}">${s.health === 'error' ? l10n.t('Not active') : l10n.t('Can be improved')}</span>` : ''}
        ${s.disabled ? `<span class="disabled-badge" title="${l10n.t('Disabled in memora.disabledSkills: it does not exist for the model (not listed / not readable / L3 unreachable)')}">${l10n.t('Disabled')}</span>` : ''}
        ${toggleHtml}
        <button class="skill-content-toggle btn btn-ghost" data-skill-name="${escapeHtml(s.name)}" title="${l10n.t('View skill content')}">${isOpen ? l10n.t('Hide content') : l10n.t('View content')}</button>
        ${promoteHtml}
      </div>
      <p class="skill-desc">${escapeHtml(s.description)}</p>
      ${overrideHtml}
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
    // 必须触发 host 侧真实重扫（skills_refresh），不能发 skills_load——
    // 后者只读内存快照，用户刚放进目录的文件永远不出现（「建了不生效」的根因）
    vscode.postMessage({ type: 'skills_refresh' });
    listEl.innerHTML = `<p class="loading-hint">${l10n.t('Loading…')}</p>`;
    contentMap.clear();
    expanded.clear();
  });

  // 打开目录按钮事件
  if (openDirBtn) {
    openDirBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'skills_open_dir' });
    });
  }

  // 导入 .zip 按钮：交 host 统一命令（与命令面板 / 角色包区共用同一处理器，开框与校验都在 host 侧）
  const importBtn = root.querySelector<HTMLButtonElement>('#btnImportSkillZip');
  if (importBtn) {
    importBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'import_asset_zip' });
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
      contentEl.textContent = contentMap.get(skillName) || l10n.t('(Skill content not found)');
      contentEl.hidden = !nextOpen;
      btn.textContent = nextOpen ? l10n.t('Hide content') : l10n.t('View content');
      return;
    }
    // 未加载 → 请求内容
    btn.textContent = l10n.t('Loading…');
    vscode.postMessage({ type: 'skills_read_content', skillName });
  });

  // 「添加到用户级」：项目级技能卡片专属。点击只发消息，**不做本地乐观更新**——
  // 复制是否成功、是否覆盖均由宿主执行面裁决，成功后以 skills_loaded 重推为准
  //（与禁用开关同口径：UI 不预判能力位）。
  listEl.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.skill-promote') as HTMLButtonElement | null;
    if (!btn) return;
    const skillName = btn.dataset.skillName;
    if (!skillName) return;
    vscode.postMessage({ type: 'asset_copy_to_user', assetKind: 'skill', name: skillName });
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
      //   ① 页序保持（页数变少时向前夹取）——判据单点 = `pager.showKeepingPage`；
      //   ② 正文缓存按名字逐出**已消失**的技能，不整体清空。
      // 「整体清空」只属于用户显式点刷新（见 refreshBtn 处理器）——两个判据不同源，别合并。
      for (const name of [...contentMap.keys()]) {
        if (!allSkills.some((s) => s.name === name)) {
          contentMap.delete(name);
          expanded.delete(name);
        }
      }
      pager.showKeepingPage(allSkills);
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
            btn.textContent = l10n.t('Hide content');
          } else {
            contentEl.textContent = l10n.t('(Skill content not found)');
            contentEl.hidden = false;
            btn.textContent = l10n.t('View content');
          }
        }
      }
    }
  });
}

/** 技能列表每页条数（分页组件；全量前端切片分页） */
const SKILL_PAGE_SIZE = 10;

/** 技能来源分类元数据（SSOT 收紧）：**只存**图层 item/badge class；标签文案在 {@link LAYER_LABELS} */
const LAYER_META: Record<
  'builtin' | 'rolepack' | 'user' | 'project',
  { item: string; badge: string }
> = {
  project: { item: 'skill-project', badge: 'badge-project' },
  builtin: { item: 'skill-agent', badge: 'badge-agent' },
  rolepack: { item: 'skill-rolepack', badge: 'badge-rolepack' },
  user: { item: 'skill-user', badge: 'badge-user' },
};

/**
 * 技能来源标签（英文源键，翻译在消费侧 `l10n.t` 做）
 *
 * 单独成表而非塞进 {@link LAYER_META}：`// @nls-keys` 会把标记块内**所有**字符串值当文案键
 * 采集，而 LAYER_META 的 `item`/`badge` 是 CSS 类名，混进去会造出一批假键（B3 的
 * `control: 'switch'` 同型缺陷）。也不在模块级直接 `l10n.t` 求值——webview 的 l10n 配置
 * 在模块加载后才注入，早求值会锁死成默认语言。
 */
// @nls-keys
const LAYER_LABELS: Record<'builtin' | 'rolepack' | 'user' | 'project', string> = {
  project: 'Project',
  builtin: 'Built-in',
  rolepack: 'Role pack',
  user: 'User',
};

/**
 * 技能列表数据入口（skills_loaded 应答）：
 * 更新计数 + 处理空态，返回按三源排序的全量数组（分页组件据此切片渲染）。
 */
function renderSkills(listEl: HTMLElement, countEl: HTMLElement, skills: SkillDto[]): SkillDto[] {
  // 分别统计项目级 / 内置 / 启用角色包 / 用户四源技能
  const projectCount = skills.filter((s) => s.layer === 'project').length;
  const builtinCount = skills.filter((s) => s.layer === 'builtin').length;
  const rolePackCount = skills.filter((s) => s.layer === 'rolepack').length;
  const userCount = skills.filter((s) => s.layer === 'user').length;

  // 更新计数
  if (skills.length > 0) {
    // 计数各段都是完整语义句（数字作插值），分隔符 ` · ` 局部拼接；末段「共 N 个」并进整句键
    const parts: string[] = [];
    if (projectCount > 0) parts.push(l10n.t('{0} project', projectCount));
    if (builtinCount > 0) parts.push(l10n.t('{0} built-in', builtinCount));
    if (rolePackCount > 0) parts.push(l10n.t('{0} role pack', rolePackCount));
    if (userCount > 0) parts.push(l10n.t('{0} user', userCount));
    countEl.textContent =
      parts.length > 0
        ? parts.join(' · ') + l10n.t(' · {0} total', skills.length)
        : l10n.t('{0} skills', skills.length);
    countEl.hidden = false;
  } else {
    countEl.hidden = true;
  }

  // 空状态（列表渲染由分页组件 renderPage 负责——renderSkillItems 空数组不覆盖）
  if (skills.length === 0) {
    // 三句各自成键（句内保留 <code> 内联标记，与 settingsSkillsHtml 同口径），不拆半句
    listEl.innerHTML = `<p class="hint">${l10n.t('No skills yet.')}<br><span class="btn-icon hint-icon" data-icon="folder"></span> ${l10n.t('User skills directory: <code>VS Code global storage / skills /</code>')}<br>${l10n.t('Create a <code>.md</code> file in that directory to add a custom skill.')}</p>`;
    // 运行期设置 innerHTML → 初始化时的 populateIcons（document.body）未覆盖 → 此处补填充
    // （图标语言唯一 = icons.ts 柔和线条 SVG）
    populateIcons(listEl);
    return [];
  }

  // 按类型分组排序：项目 → 内置 → 角色包 → 用户，同类型按名称排序
  // （与宿主 SOURCE_ORDER 同一展示习惯；它不是同名裁决表——裁决由内核加载顺序决定）
  const LAYER_ORDER: Record<'builtin' | 'rolepack' | 'user' | 'project', number> = {
    project: 0,
    builtin: 1,
    rolepack: 2,
    user: 3,
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
  // 分隔符并进整句（名称是插值内容，不参与翻译）；英文用「, 」而非中文顿号
  tip.textContent = l10n.t('No matching skill found to disable: {0}', unmatched.join(', '));
  countEl.after(tip);
}
