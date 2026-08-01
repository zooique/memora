/**
 * 精灵设定文件列表组件
 *
 * 职责（封装 settingsManagerPanel 中文件列表区的 DOM 操作）：
 * - 管理 6 组列表容器 + 空状态元素的 DOM 引用
 * - 管理 tab 切换按钮和内容区域元素的 DOM 引用
 * - 渲染三类设定文件列表（角色/规则/技能）
 * - 渲染护栏规则和项目级规则空状态
 * - 刷新默认角色下拉 options
 * - 统一创建列表项 DOM 元素
 * - tab 切换事件绑定
 *
 * 与现有 HTML 模板的关系：
 * - 列表容器和空状态元素已存在于 index.html 模板中
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用
 *
 * 对齐 ARCH-COMP-1 阶段 3 方案：
 * - Manager 持有 Component 实例，调用 mount/update/destroy
 * - Manager 通过 renderPersonaList/renderRuleList 等方法委托列表渲染
 * - Manager 提供 onEdit/onDelete 回调，Component 内部处理事件委托
 * - 业务逻辑（IPC 调用、数据加载、编辑/删除操作）保留在 Manager
 */

import { Component } from '../base/component.js';
import { clearElement } from '../../helpers/domHelpers.js';
import type { ConfigFileEntry } from '../../../../sprite/configFileManager.js';

// ─── 类型定义 ──────────────────────────────────────────────

/** 设定文件编辑类型（与 SettingsEditorComponent 对齐） */
type EditorType = 'persona' | 'rule' | 'skill';

// ─── 组件选项 ──────────────────────────────────────────────

/** SettingsFileListComponent 配置 */
export interface SettingsFileListOptions {
  // 当前无跨模块关注点注入，保留接口供后续扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 精灵设定文件列表组件
 *
 * 由 SettingsManagerPanelManager 持有实例，替代原有 10 处 document.getElementById
 * 直接 DOM 操作（6 组列表容器 + 6 组空状态）。
 * 挂载到现有 HTML 模板中的 #persona-config-list 等相关元素。
 * 提供列表渲染、tab 切换事件绑定、列表项事件委托等能力。
 */
export class SettingsFileListComponent extends Component<SettingsFileListOptions> {
  // ─── 缓存的 DOM 元素引用 - 列表容器（mount 时查询，destroy 时 nullify） ──
  /** 角色列表容器 */
  private personaConfigList: HTMLElement | null = null;
  /** 角色列表空状态 */
  private personaConfigEmpty: HTMLElement | null = null;
  /** 规则列表容器 */
  private ruleConfigList: HTMLElement | null = null;
  /** 规则列表空状态 */
  private ruleConfigEmpty: HTMLElement | null = null;
  /** 护栏规则列表容器（只读） */
  private guardrailConfigList: HTMLElement | null = null;
  /** 护栏规则列表空状态 */
  private guardrailConfigEmpty: HTMLElement | null = null;
  /** 项目级规则列表容器（只读） */
  private projectRuleConfigList: HTMLElement | null = null;
  /** 项目级规则列表空状态 */
  private projectRuleConfigEmpty: HTMLElement | null = null;
  /** 技能列表容器 */
  private skillConfigList: HTMLElement | null = null;
  /** 技能列表空状态 */
  private skillConfigEmpty: HTMLElement | null = null;

  // ─── 事件委托回调（由 Manager 注册） ──────────────────

  /** 编辑按钮点击回调 */
  onEdit: ((type: EditorType, name: string) => void) | null = null;
  /** 删除按钮点击回调 */
  onDelete: ((type: EditorType, name: string) => void) | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: SettingsFileListOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 列表容器和空状态元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 列表容器
    this.personaConfigList = document.getElementById('persona-config-list');
    this.personaConfigEmpty = document.getElementById('persona-config-empty');
    this.ruleConfigList = document.getElementById('rule-config-list');
    this.ruleConfigEmpty = document.getElementById('rule-config-empty');
    this.guardrailConfigList = document.getElementById('guardrail-config-list');
    this.guardrailConfigEmpty = document.getElementById('guardrail-config-empty');
    this.projectRuleConfigList = document.getElementById('project-rule-config-list');
    this.projectRuleConfigEmpty = document.getElementById('project-rule-config-empty');
    this.skillConfigList = document.getElementById('skill-config-list');
    this.skillConfigEmpty = document.getElementById('skill-config-empty');

    // 设置 this.el 为 personaConfigList（Component 基类需要，但 destroy 时不会删除模板元素）
    this.el = this.personaConfigList;

    return this;
  }

  /**
   * 增量更新——当前文件列表组件不使用 update 模式
   *
   * 列表渲染通过 renderPersonaList/renderRuleList 等显式方法完成。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 列表元素是 HTML 模板的一部分，不删除 DOM。
   * 仅 nullify 内部引用，防止内存泄漏。
   */
  destroy(): void {
    this.personaConfigList = null;
    this.personaConfigEmpty = null;
    this.ruleConfigList = null;
    this.ruleConfigEmpty = null;
    this.guardrailConfigList = null;
    this.guardrailConfigEmpty = null;
    this.projectRuleConfigList = null;
    this.projectRuleConfigEmpty = null;
    this.skillConfigList = null;
    this.skillConfigEmpty = null;
    this.onEdit = null;
    this.onDelete = null;
    super.destroy();
  }

  // ─── Tab 切换事件绑定 ────────────────────────────────

  /**
   * 初始化 tab 切换事件
   *
   * 点击 tab 按钮时切换对应内容区，保持 active 状态同步。
   * 使用 trackEvent 管理事件清理，由 Component 自身生命周期管理。
   * 由 Manager 的 init() 中调用。
   */
  initTabSwitching(): void {
    const tabButtons = document.querySelectorAll<HTMLElement>('.sprite-settings-tab');
    const tabContents = document.querySelectorAll<HTMLElement>('.sprite-settings-tab-content');

    tabButtons.forEach((btn) => {
      const handler = (): void => {
        const tabName = btn.dataset.spriteSettingsTab;
        if (!tabName) return;

        // 切换 tab 按钮 active 状态
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // 切换 tab 内容区显示
        tabContents.forEach((content) => {
          if (content.dataset.spriteSettingsTab === tabName) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        });
      };

      btn.addEventListener('click', handler);
      this.trackEvent(() => btn.removeEventListener('click', handler));
    });
  }

  /**
   * 初始化列表项事件委托
   *
   * 在三类列表容器上统一注册 click 监听，通过 data-action 识别编辑/删除操作。
   * 通过 onEdit/onDelete 回调委托给 Manager 处理业务逻辑。
   * 由 Manager 的 init() 中调用。
   */
  initEventDelegation(): void {
    const listContainers = [
      this.personaConfigList,
      this.ruleConfigList,
      this.skillConfigList,
    ];

    for (const container of listContainers) {
      if (!container) continue;

      const handler = (e: Event): void => {
        const target = e.target;
        if (!(target instanceof HTMLElement)) return;
        // 向上查找带 data-action 的按钮
        const actionBtn = target.closest<HTMLElement>('[data-action]');
        if (!actionBtn) return;
        // 向上查找列表项容器（带 data-type + data-name）
        const item = actionBtn.closest<HTMLElement>('.sprite-settings-item');
        if (!item) return;

        const action = actionBtn.dataset.action;
        const type = item.dataset.type as EditorType | undefined;
        const name = item.dataset.name;
        if (!action || !type || !name) return;

        if (action === 'edit') {
          this.onEdit?.(type, name);
        } else if (action === 'delete') {
          this.onDelete?.(type, name);
        }
      };

      container.addEventListener('click', handler);
      this.trackEvent(() => container.removeEventListener('click', handler));
    }
  }

  // ─── 列表渲染 ────────────────────────────────────────

  /**
   * 渲染角色列表
   *
   * 使用 listPersonas 返回的角色信息（含 active 状态），每条渲染为：
   *   名称 + 描述 + 激活标记 + 编辑/删除按钮
   *
   * @param personas 角色信息列表（来自 PERSONA_LIST IPC）
   * @param currentDefaultPersona 当前默认角色名（供刷新下拉 options 后恢复选中）
   * @param selectEl 默认角色下拉 select 元素（由 Manager 传入，不在此组件管理范围内）
   */
  renderPersonaList(
    personas: Array<{ name: string; description: string; active: boolean }>,
    currentDefaultPersona?: string,
    selectEl?: HTMLSelectElement | null,
  ): void {
    const listEl = this.personaConfigList;
    const emptyEl = this.personaConfigEmpty;
    if (!listEl) return;

    // 空状态处理
    if (personas.length === 0) {
      clearElement(listEl);
      emptyEl?.classList.remove('hidden');
      // 同步清空默认角色下拉 options
      this.refreshDefaultPersonaOptions(personas, currentDefaultPersona ?? '', selectEl);
      return;
    }

    emptyEl?.classList.add('hidden');
    clearElement(listEl);

    // 使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const fragment = document.createDocumentFragment();
    for (const persona of personas) {
      const item = this.createListItem('persona', persona.name, persona.description, persona.active);
      fragment.appendChild(item);
    }
    listEl.appendChild(fragment);

    // 刷新默认角色下拉 options
    this.refreshDefaultPersonaOptions(personas, currentDefaultPersona ?? '', selectEl);
  }

  /**
   * 渲染规则列表
   *
   * @param entries 规则文件条目（来自 RULE_LIST IPC，按 mtime 降序）
   */
  renderRuleList(entries: ConfigFileEntry[]): void {
    const listEl = this.ruleConfigList;
    const emptyEl = this.ruleConfigEmpty;
    if (!listEl) return;

    if (entries.length === 0) {
      clearElement(listEl);
      emptyEl?.classList.remove('hidden');
      return;
    }

    emptyEl?.classList.add('hidden');
    clearElement(listEl);

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      // 规则列表展示文件名（去 .md 扩展名）+ 修改时间
      const item = this.createListItem('rule', entry.name, this.formatTime(entry.mtime), false);
      fragment.appendChild(item);
    }
    listEl.appendChild(fragment);
  }

  /**
   * 渲染技能列表
   *
   * @param entries 技能文件条目（来自 SKILL_LIST IPC，按 mtime 降序）
   */
  renderSkillList(entries: ConfigFileEntry[]): void {
    const listEl = this.skillConfigList;
    const emptyEl = this.skillConfigEmpty;
    if (!listEl) return;

    if (entries.length === 0) {
      clearElement(listEl);
      emptyEl?.classList.remove('hidden');
      return;
    }

    emptyEl?.classList.add('hidden');
    clearElement(listEl);

    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
      const item = this.createListItem('skill', entry.name, this.formatTime(entry.mtime), false);
      fragment.appendChild(item);
    }
    listEl.appendChild(fragment);
  }

  /** 渲染护栏规则空状态（数据源待后续迭代） */
  renderGuardrailEmpty(): void {
    if (this.guardrailConfigList) clearElement(this.guardrailConfigList);
    this.guardrailConfigEmpty?.classList.remove('hidden');
  }

  /** 渲染项目级规则空状态（数据源待后续迭代） */
  renderProjectRuleEmpty(): void {
    if (this.projectRuleConfigList) clearElement(this.projectRuleConfigList);
    this.projectRuleConfigEmpty?.classList.remove('hidden');
  }

  // ─── 默认角色下拉 ──────────────────────────────────────

  /**
   * 刷新默认角色下拉框 options
   *
   * 由 renderPersonaList 末尾调用，保证角色增删后 select options 同步更新。
   * 选中值优先取 currentDefaultPersona，若选中值不在角色列表中则回退到空（自动匹配）。
   *
   * @param personas 当前角色列表（用于填充 options）
   * @param currentDefaultPersona 当前默认角色名
   * @param selectEl 默认角色下拉 select 元素（由 Manager 传入）
   */
  refreshDefaultPersonaOptions(
    personas: Array<{ name: string; description: string; active: boolean }>,
    currentDefaultPersona: string,
    selectEl: HTMLSelectElement | null | undefined,
  ): void {
    if (!selectEl) return;

    // 清空并重建 options（保留占位项）
    clearElement(selectEl);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '（自动匹配）';
    selectEl.appendChild(placeholder);
    for (const p of personas) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      selectEl.appendChild(opt);
    }

    // 恢复选中（值不在 options 中则回退空）
    const value = currentDefaultPersona;
    selectEl.value = value && personas.some(p => p.name === value) ? value : '';
  }

  // ─── 列表项创建 ──────────────────────────────────────

  /**
   * 创建列表项 DOM 元素
   *
   * 统一三类列表项的 DOM 结构，使用 data-action + data-type + data-name 属性
   * 供事件委托识别点击目标。
   *
   * DOM 结构：
   *   <div class="sprite-settings-item" data-type="persona" data-name="导师">
   *     <div class="sprite-settings-item-info">
   *       <span class="sprite-settings-item-name">导师</span>
   *       <span class="sprite-settings-item-desc">描述文本</span>
   *       <span class="sprite-settings-item-active">当前</span>  <!-- 仅 active 时 -->
   *     </div>
   *     <div class="sprite-settings-item-actions">
   *       <button data-action="edit">编辑</button>
   *       <button data-action="delete">删除</button>
   *     </div>
   *   </div>
   *
   * @param type 配置类型
   * @param name 配置名
   * @param description 描述文本
   * @param active 是否激活（仅 persona 有意义）
   * @returns 列表项 DOM 元素
   */
  private createListItem(
    type: EditorType,
    name: string,
    description: string,
    active: boolean,
  ): HTMLElement {
    const item = document.createElement('div');
    item.className = 'sprite-settings-item';
    item.dataset.type = type;
    item.dataset.name = name;

    // 主信息区（名称 + 描述 + active 标记）：包装在容器中，flex: 1 占据剩余空间
    const infoContainer = document.createElement('div');
    infoContainer.className = 'sprite-settings-item-info';

    // 名称
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sprite-settings-item-name';
    nameSpan.textContent = name;
    infoContainer.appendChild(nameSpan);

    // 描述
    if (description) {
      const descSpan = document.createElement('span');
      descSpan.className = 'sprite-settings-item-desc';
      descSpan.textContent = description;
      infoContainer.appendChild(descSpan);
    }

    // 激活标记（仅 persona active 时显示）
    if (active) {
      const activeSpan = document.createElement('span');
      activeSpan.className = 'sprite-settings-item-active';
      activeSpan.textContent = '当前';
      infoContainer.appendChild(activeSpan);
    }

    item.appendChild(infoContainer);

    // 操作按钮区
    const actions = document.createElement('div');
    actions.className = 'sprite-settings-item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-secondary btn-sm';
    editBtn.type = 'button';
    editBtn.dataset.action = 'edit';
    editBtn.textContent = '编辑';
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-secondary btn-sm';
    deleteBtn.type = 'button';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.textContent = '删除';
    actions.appendChild(deleteBtn);

    item.appendChild(actions);
    return item;
  }

  // ─── 工具方法 ────────────────────────────────────────

  /**
   * 格式化时间戳为简短显示
   *
   * @param mtime 毫秒时间戳
   * @returns 简短时间字符串（如"07-23 14:30"）
   */
  private formatTime(mtime: number): string {
    if (!mtime) return '';
    const date = new Date(mtime);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  }
}