/**
 * 精灵设定面板管理器 — 角色/规则/技能三类设定文件的统一 CRUD 面板
 *
 * 职责（精灵设定面板 Epic 4 · U2-U8）：
 *   1. 管理三 tab 框架（角色/规则/技能）切换
 *   2. 渲染三类设定文件列表（1 文件 1 条记录 + 编辑/删除按钮）
 *   3. 统一编辑器组件（frontmatter 表单 + 正文 textarea）
 *   4. 技能拖入安装区（M1 从设置面板迁移）
 *   5. 角色匹配配置区（M3 从设置面板精灵 tab 迁移）
 *   6. 监听 CONFIG_FILES_CHANGED 广播，按 type 分发刷新
 *
 * 设计原则（与 SettingsPanelManager 同模式）：
 *   - 通过 SettingsManagerPanelHost 接口与 UIManager 解耦
 *   - 持有独立 EventTracker，cleanup 时统一清理
 *   - 列表渲染使用 clearElement + DocumentFragment + createElement + textContent（防 XSS）
 *   - 事件委托：data-action + closest<HTMLElement> 统一在容器注册一次 click 监听
 *
 * 与 SettingsPanelManager 的区别：
 *   - SettingsPanelManager 管理系统配置（LLM/精灵行为/项目/画像/审计/帮助）
 *   - SettingsManagerPanel 管理"人写的设定"（persona/rule/skill 文件）
 *   - 二者通过 panel-sprite-settings / panel-settings 隔离，各自独立
 */

import { clearElement, getOptionalElement, showPanelLoading } from '../helpers/domHelpers.js';
import { reportError } from '../helpers/errorHelpers.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { formatErrorMessage } from '../../../shared/errorMessages.js';
import type { ConfirmDialogOptions, ToastType } from '../types.js';
// ConfigFileEntry / ConfigFileOperationResult 从 preload 统一导出（真理源在 sprite.configFileManager）
import type { ConfigFileEntry, ConfigFileOperationResult } from '../../../sprite/configFileManager.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 精灵设定面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface SettingsManagerPanelHost {
  /** 显示确认对话框（删除二次确认） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（操作成功/失败反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 显示模态弹窗（编辑器模态框，启用焦点陷阱） */
  showModal(modalId: string): void;
  /** 隐藏模态弹窗（恢复焦点） */
  hideModal(modalId: string): void;
  /** 更新角色匹配模式标签（顶栏 badge 同步） */
  updatePersonaModeBadge(mode: string): void;
  /**
   * 技能安装回调（拖入/选择文件后调用，委托 UIManager.handleSkillDrop 处理）
   *
   * 复用 UIManager 已有的技能安装链路（installSkill IPC + 热重载 + Toast 反馈），
   * 避免在设定面板重复实现安装逻辑。
   */
  onSkillInstall(files: File[]): void;
}

// ─── 编辑器类型定义 ────────────────────────────────────────

/** 设定文件类型（与 ConfigFileType 对齐，编辑器用） */
type EditorType = 'persona' | 'rule' | 'skill';

/**
 * frontmatter 字段定义（编辑器表单动态渲染用）
 *
 * 每种类型有不同的字段集合：
 *   - persona: name / description / keywords
 *   - rule: name / description
 *   - skill: name / description / keywords / trigger
 */
interface FrontmatterField {
  /** 字段键名（frontmatter key） */
  key: string;
  /** 字段标签（中文显示） */
  label: string;
  /** 输入类型 */
  type: 'text' | 'textarea';
  /** 是否必填 */
  required: boolean;
  /** 占位提示 */
  placeholder?: string;
}

/**
 * 各类型的 frontmatter 字段配置
 *
 * 集中定义，避免散落在 openEditor 中的 if-else 分支。
 * 新增类型只需在此表添加一行配置。
 */
const FRONTMATTER_FIELDS: Record<EditorType, FrontmatterField[]> = {
  persona: [
    { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：导师' },
    { key: 'description', label: '描述', type: 'text', required: false, placeholder: '一句话描述角色定位' },
    { key: 'keywords', label: '关键词', type: 'text', required: true, placeholder: '逗号分隔，如：教学,指导,解释' },
  ],
  rule: [
    { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：代码规范' },
    { key: 'description', label: '描述', type: 'text', required: false, placeholder: '一句话描述规则用途' },
  ],
  skill: [
    { key: 'name', label: '名称', type: 'text', required: true, placeholder: '如：翻译' },
    { key: 'description', label: '描述', type: 'text', required: false, placeholder: '一句话描述技能用途' },
    { key: 'keywords', label: '关键词', type: 'text', required: true, placeholder: '逗号分隔，触发关键词' },
    { key: 'trigger', label: '触发模式', type: 'text', required: false, placeholder: '可选，正则触发模式' },
  ],
};

// ─── 精灵设定面板管理器类 ─────────────────────────────────

export class SettingsManagerPanelManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // ─── DOM 元素引用 - 列表容器 ──────────────────────────
  /** 角色列表容器 */
  private personaConfigList: HTMLElement | null;
  /** 角色列表空状态 */
  private personaConfigEmpty: HTMLElement | null;
  /** 规则列表容器 */
  private ruleConfigList: HTMLElement | null;
  /** 规则列表空状态 */
  private ruleConfigEmpty: HTMLElement | null;
  /** 护栏规则列表容器（只读） */
  private guardrailConfigList: HTMLElement | null;
  /** 护栏规则列表空状态 */
  private guardrailConfigEmpty: HTMLElement | null;
  /** 项目级规则列表容器（只读） */
  private projectRuleConfigList: HTMLElement | null;
  /** 项目级规则列表空状态 */
  private projectRuleConfigEmpty: HTMLElement | null;
  /** 技能列表容器 */
  private skillConfigList: HTMLElement | null;
  /** 技能列表空状态 */
  private skillConfigEmpty: HTMLElement | null;

  // ─── DOM 元素引用 - 编辑器模态框 ──────────────────────
  /** 编辑器模态框容器 */
  private editorModal: HTMLElement | null;
  /** 编辑器标题 */
  private editorTitle: HTMLElement | null;
  /** frontmatter 表单容器（动态渲染字段） */
  private editorForm: HTMLElement | null;
  /** 正文 textarea */
  private editorContent: HTMLTextAreaElement | null;

  // ─── DOM 元素引用 - 角色匹配配置区（M3 迁移） ──────────
  /** 角色匹配模式 radio 组 */
  private personaModeRadios: NodeListOf<HTMLInputElement>;
  /** 默认角色下拉框（动态从角色列表读取 options，避免手敲错误角色名） */
  private cfgDefaultPersona: HTMLSelectElement | null;

  // ─── DOM 元素引用 - 技能拖入安装区（M1 迁移） ──────────
  /** 技能拖入安装区 */
  private skillDropzone: HTMLElement | null;
  /** 技能文件选择 input */
  private skillFileInput: HTMLInputElement | null;

  // ─── 编辑器运行时状态 ────────────────────────────────
  /** 当前编辑的类型（openEditor 时设置，closeEditor 时重置） */
  private currentEditorType: EditorType | null = null;
  /** 当前编辑的配置名（编辑模式时填充，新建模式为 null） */
  private currentEditorName: string | null = null;

  // ─── 角色匹配配置区状态（M3 迁移） ────────────────────
  /** 角色匹配模式变更回调（持久化到 spriteConfig） */
  private personaModeChangeCallback: ((mode: 'auto' | 'manual') => void) | null = null;
  /** 默认角色变更回调（持久化到 spriteConfig） */
  private defaultPersonaChangeCallback: ((value: string) => void) | null = null;
  /** 当前默认角色名暂存（options 未填充时 setDefaultPersona 先记此字段，renderPersonaList 刷新 options 后恢复选中） */
  private currentDefaultPersona = '';

  constructor(private host: SettingsManagerPanelHost) {
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

    // 编辑器模态框
    this.editorModal = document.getElementById('config-file-editor-modal');
    this.editorTitle = document.getElementById('config-file-editor-title');
    this.editorForm = document.getElementById('config-file-editor-form');
    this.editorContent = getOptionalElement('config-file-editor-content', 'textarea');

    // 角色匹配配置区（M3 从设置面板迁移，DOM 在 panel-sprite-settings 内）
    // sprite- 前缀作为面板归属标识（与 perception-/dashboard-/archive- 同模式），非冲突规避
    this.personaModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="sprite-persona-mode"]');
    this.cfgDefaultPersona = getOptionalElement('cfg-sprite-default-persona', 'select');

    // 技能拖入安装区（M1 从设置面板迁移，DOM 在 panel-sprite-settings 内）
    // sprite- 前缀作为面板归属标识（与 perception-/dashboard-/archive- 同模式），非冲突规避
    this.skillDropzone = document.getElementById('sprite-skill-dropzone');
    this.skillFileInput = document.getElementById('sprite-skill-file-input') as HTMLInputElement | null;
  }

  // ─── 生命周期 ────────────────────────────────────────

  /**
   * 初始化设定面板事件监听
   *
   * 绑定内容：
   *   1. tab 切换（角色/规则/技能）
   *   2. 新建按钮（三类各自的新建按钮）
   *   3. 列表项事件委托（编辑/删除按钮，data-action）
   *   4. 编辑器模态框（保存/取消/关闭）
   *   5. 角色匹配配置区（模式切换 + 默认角色下拉选择）
   *   6. 技能拖入安装区（拖入/点击选择）
   *
   * 在 UIManager 构造函数末尾调用（与 settingsPanelManager.initListeners 同模式）。
   */
  init(): void {
    this.initTabSwitching();
    this.initCreateButtons();
    this.initListEventDelegation();
    this.initEditorListeners();
    this.initPersonaConfigArea();
    this.initSkillDropzone();
  }

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 数据加载 ────────────────────────────────────────

  /**
   * 加载全部三类设定文件列表
   *
   * 面板首次可见时调用，或 CONFIG_FILES_CHANGED 广播到达时按需刷新。
   * 三类列表并行加载，互不阻塞。
   */
  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadPersonaList(),
      this.loadRuleList(),
      this.loadSkillList(),
    ]);
    // 护栏规则和项目级规则暂为空状态展示（数据源待后续迭代）
    this.renderGuardrailEmpty();
    this.renderProjectRuleEmpty();
  }

  /** 加载角色文件列表并渲染 */
  private async loadPersonaList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    if (this.personaConfigList) showPanelLoading(this.personaConfigList, '加载角色列表…');
    try {
      // listPersonas 返回 { personas: Array<{ name, description, active }> }
      // 角色 active 状态由主进程维护，设定面板直接渲染（无需文件级 mtime）
      const { personas } = await window.electronAPI.listPersonas();
      this.renderPersonaList(personas);
    } catch (error) {
      reportError('loadPersonaList', error);
      this.host.showToast('加载角色列表失败', 'error');
    }
  }

  /** 加载规则文件列表并渲染 */
  private async loadRuleList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    if (this.ruleConfigList) showPanelLoading(this.ruleConfigList, '加载规则列表…');
    try {
      const entries = await window.electronAPI.listRules();
      this.renderRuleList(entries);
    } catch (error) {
      reportError('loadRuleList', error);
      this.host.showToast('加载规则列表失败', 'error');
    }
  }

  /** 加载技能文件列表并渲染 */
  private async loadSkillList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    if (this.skillConfigList) showPanelLoading(this.skillConfigList, '加载技能列表…');
    try {
      const entries = await window.electronAPI.listSkills();
      this.renderSkillList(entries);
    } catch (error) {
      reportError('loadSkillList', error);
      this.host.showToast('加载技能列表失败', 'error');
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
   */
  private renderPersonaList(
    personas: Array<{ name: string; description: string; active: boolean }>,
  ): void {
    const listEl = this.personaConfigList;
    const emptyEl = this.personaConfigEmpty;
    if (!listEl) return;

    // 空状态处理
    if (personas.length === 0) {
      clearElement(listEl);
      emptyEl?.classList.remove('hidden');
      // 同步清空默认角色下拉 options（避免删除全部角色后 select 残留旧角色名）
      this.refreshDefaultPersonaOptions(personas);
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

    // 刷新默认角色下拉 options（动态从角色列表读取，角色增删后自动同步）
    this.refreshDefaultPersonaOptions(personas);
  }

  /**
   * 刷新默认角色下拉框 options
   *
   * 由 renderPersonaList 末尾调用，保证角色增删后 select options 同步更新。
   * 选中值优先取 currentDefaultPersona（syncSpriteSettingsState 可能先于角色列表加载调用），
   * 若选中值不在角色列表中则回退到空（自动匹配）。
   *
   * @param personas 当前角色列表（用于填充 options）
   */
  private refreshDefaultPersonaOptions(
    personas: Array<{ name: string; description: string; active: boolean }>,
  ): void {
    const select = this.cfgDefaultPersona;
    if (!select) return;

    // 清空并重建 options（保留占位项）
    clearElement(select);
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '（自动匹配）';
    select.appendChild(placeholder);
    for (const p of personas) {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      select.appendChild(opt);
    }

    // 恢复选中（值不在 options 中则回退空）
    const value = this.currentDefaultPersona;
    select.value = value && personas.some(p => p.name === value) ? value : '';
  }

  /**
   * 渲染规则列表
   *
   * @param entries 规则文件条目（来自 RULE_LIST IPC，按 mtime 降序）
   */
  private renderRuleList(entries: ConfigFileEntry[]): void {
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
  private renderSkillList(entries: ConfigFileEntry[]): void {
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

  /**
   * 创建列表项 DOM 元素
   *
   * 统一三类列表项的 DOM 结构，使用 data-action + data-type + data-name 属性
   * 供事件委托识别点击目标。
   *
   * DOM 结构：
   *   <div class="sprite-settings-item" data-type="persona" data-name="导师">
   *     <span class="sprite-settings-item-name">导师</span>
   *     <span class="sprite-settings-item-desc">描述文本</span>
   *     <span class="sprite-settings-item-active">当前</span>  <!-- 仅 active 时 -->
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
    // 这样操作按钮区始终靠右对齐，不受内容长度影响
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

  /** 渲染护栏规则空状态（数据源待后续迭代） */
  private renderGuardrailEmpty(): void {
    this.guardrailConfigList && clearElement(this.guardrailConfigList);
    this.guardrailConfigEmpty?.classList.remove('hidden');
  }

  /** 渲染项目级规则空状态（数据源待后续迭代） */
  private renderProjectRuleEmpty(): void {
    this.projectRuleConfigList && clearElement(this.projectRuleConfigList);
    this.projectRuleConfigEmpty?.classList.remove('hidden');
  }

  // ─── 事件绑定 ────────────────────────────────────────

  /**
   * 初始化 tab 切换
   *
   * 点击 tab 按钮时切换对应内容区，保持 active 状态同步。
   * 与 settingsPanelManager.initSettingsTabListeners 同模式。
   */
  private initTabSwitching(): void {
    const tabButtons = document.querySelectorAll<HTMLElement>('.sprite-settings-tab');
    const tabContents = document.querySelectorAll<HTMLElement>('.sprite-settings-tab-content');

    tabButtons.forEach((btn) => {
      this.events.addEventListener(btn, 'click', () => {
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
      });
    });
  }

  /**
   * 初始化新建按钮
   *
   * 三类各自的新建按钮，点击后打开编辑器（新建模式）。
   */
  private initCreateButtons(): void {
    const btnAddPersona = getOptionalElement('btn-add-persona', 'button');
    if (btnAddPersona) {
      this.events.addEventListener(btnAddPersona, 'click', () => {
        this.openEditor('persona', null);
      });
    }

    const btnAddRule = getOptionalElement('btn-add-rule', 'button');
    if (btnAddRule) {
      this.events.addEventListener(btnAddRule, 'click', () => {
        this.openEditor('rule', null);
      });
    }

    const btnAddSkill = getOptionalElement('btn-add-skill', 'button');
    if (btnAddSkill) {
      this.events.addEventListener(btnAddSkill, 'click', () => {
        this.openEditor('skill', null);
      });
    }
  }

  /**
   * 初始化列表项事件委托
   *
   * 在三类列表容器上统一注册 click 监听，通过 data-action 识别编辑/删除操作。
   * 避免在每个列表项上单独绑定事件（性能 + 内存优势）。
   */
  private initListEventDelegation(): void {
    const listContainers = [
      this.personaConfigList,
      this.ruleConfigList,
      this.skillConfigList,
    ];

    for (const container of listContainers) {
      if (!container) continue;
      this.events.addEventListener(container, 'click', (e: Event) => {
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
          this.openEditor(type, name);
        } else if (action === 'delete') {
          void this.handleDelete(type, name);
        }
      });
    }
  }

  /**
   * 初始化编辑器模态框事件
   *
   * 绑定保存/取消/关闭按钮 + overlay 点击关闭。
   * 使用 data-action 委托，统一在模态框容器注册一次 click 监听。
   */
  private initEditorListeners(): void {
    if (!this.editorModal) return;

    this.events.addEventListener(this.editorModal, 'click', (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const actionEl = target.closest<HTMLElement>('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === 'close-editor' || action === 'cancel-editor') {
        this.closeEditor();
      } else if (action === 'save-editor') {
        void this.handleSave();
      } else if (action === 'open-config-dir') {
        void this.openConfigDir();
      }
    });
  }

  /**
   * 打开配置文件目录
   *
   * 技能编辑时的辅助功能：复杂技能可跳转到文件目录手动编辑。
   * 调用 IPC 打开配置目录（personas/skills/rules 所在目录）。
   */
  private async openConfigDir(): Promise<void> {
    try {
      const result = await window.electronAPI.openConfigDir();
      if (!result.success && result.error) {
        this.host.showToast(result.error, 'error');
      }
    } catch (error) {
      reportError('openConfigDir', error);
      this.host.showToast('打开目录失败', 'error');
    }
  }

  /**
   * 初始化角色匹配配置区（M3 从设置面板迁移）
   *
   * 绑定：
   *   1. persona-mode radio 切换 → 实时更新标签 + 持久化
   *   2. cfg-default-persona 下拉选择 → change 时持久化
   */
  private initPersonaConfigArea(): void {
    // 角色匹配模式 radio：切换时实时更新标签 + 触发回调持久化
    this.personaModeRadios.forEach((radio) => {
      this.events.addEventListener(radio, 'change', () => {
        const selectedMode = radio.value as 'auto' | 'manual';
        this.host.updatePersonaModeBadge(selectedMode);
        this.personaModeChangeCallback?.(selectedMode);
      });
    });

    // 默认角色下拉框：change 时持久化（select 选择即触发，无需防抖）
    const select = this.cfgDefaultPersona;
    if (select) {
      this.events.addEventListener(select, 'change', () => {
        this.defaultPersonaChangeCallback?.(select.value.trim());
      });
    }
  }

  /**
   * 初始化技能拖入安装区（M1 从设置面板迁移）
   *
   * 绑定 dragenter/dragover/dragleave/drop + click + change + keydown，
   * 委托 host.onSkillInstall 处理安装逻辑（复用 UIManager 已有链路）。
   */
  private initSkillDropzone(): void {
    const dropzone = this.skillDropzone;
    if (!dropzone) return;

    // dragenter/dragover：阻止默认行为 + 添加高亮类
    const handleDragOver = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('is-dragover');
    };

    // dragleave：移除高亮类（仅当离开 dropzone 本身时）
    const handleDragLeave = (e: Event): void => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      const related = dragEvent.relatedTarget as Node | null;
      if (!related || !dropzone.contains(related)) {
        dropzone.classList.remove('is-dragover');
      }
    };

    // drop：提取文件 + 移除高亮 + 委托 host 安装
    const handleDrop = (e: Event): void => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      dropzone.classList.remove('is-dragover');
      const files = dragEvent.dataTransfer?.files;
      if (files && files.length > 0) {
        this.host.onSkillInstall(Array.from(files));
      }
    };

    // click：触发文件选择对话框
    const handleClick = (): void => {
      this.skillFileInput?.click();
    };

    // keydown：Enter/Space 触发点击（键盘可访问性）
    const handleKeydown = (e: Event): void => {
      const keyboardEvent = e as KeyboardEvent;
      if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        keyboardEvent.preventDefault();
        this.skillFileInput?.click();
      }
    };

    // change：文件选择后触发
    const handleFileChange = (): void => {
      if (this.skillFileInput?.files && this.skillFileInput.files.length > 0) {
        this.host.onSkillInstall(Array.from(this.skillFileInput.files));
        // 清空 input.value 允许重复选择同一文件
        this.skillFileInput.value = '';
      }
    };

    this.events.addEventListener(dropzone, 'dragenter', handleDragOver);
    this.events.addEventListener(dropzone, 'dragover', handleDragOver);
    this.events.addEventListener(dropzone, 'dragleave', handleDragLeave);
    this.events.addEventListener(dropzone, 'drop', handleDrop);
    this.events.addEventListener(dropzone, 'click', handleClick);
    this.events.addEventListener(dropzone, 'keydown', handleKeydown);
    if (this.skillFileInput) {
      this.events.addEventListener(this.skillFileInput, 'change', handleFileChange);
    }
  }

  // ─── 编辑器逻辑 ──────────────────────────────────────

  /**
   * 打开编辑器
   *
   * 新建模式：name = null，编辑器初始为空
   * 编辑模式：name = 已有配置名，编辑器加载已有内容
   *
   * 流程：
   *   1. 设置 currentEditorType / currentEditorName
   *   2. 渲染 frontmatter 表单（按类型动态生成字段）
   *   3. 编辑模式：读取文件内容，填充表单 + textarea
   *   4. 显示模态框
   *
   * @param type 配置类型
   * @param name 配置名（null 表示新建）
   */
  private async openEditor(type: EditorType, name: string | null): Promise<void> {
    this.currentEditorType = type;
    this.currentEditorName = name;

    // 渲染标题
    if (this.editorTitle) {
      const typeLabel = type === 'persona' ? '角色' : type === 'rule' ? '规则' : '技能';
      this.editorTitle.textContent = name ? `编辑${typeLabel}` : `新建${typeLabel}`;
    }

    // 渲染 frontmatter 表单
    this.renderFrontmatterForm(type);

    // 清空正文
    if (this.editorContent) {
      this.editorContent.value = '';
    }

    // 技能类型：隐藏正文区域（技能正文内容复杂，建议在文件目录中手动编辑），显示打开目录按钮
    // 其他类型：显示正文区域，隐藏打开目录按钮
    this.toggleEditorBodySection(type);

    // 编辑模式：加载已有内容
    if (name) {
      try {
        const entry = await this.readConfigFile(type, name);
        if (entry) {
          this.fillEditorForm(entry.content);
        }
      } catch (error) {
        reportError('openEditor.load', error);
        this.host.showToast('加载文件内容失败', 'error');
      }
    }

    // 显示模态框
    this.host.showModal('config-file-editor-modal');
  }

  /**
   * 切换编辑器打开目录按钮的显示状态
   *
   * 技能类型：显示打开目录按钮（复杂技能可跳转文件目录手动编辑），同时保留正文 textarea 供简单技能直接编辑
   * 角色/规则类型：隐藏打开目录按钮
   *
   * @param type 配置类型
   */
  private toggleEditorBodySection(type: EditorType): void {
    const openDirBtn = document.querySelector('.config-file-editor-open-dir');

    if (type === 'skill') {
      // 技能：显示打开目录按钮（正文 textarea 始终显示，简单技能可直接编辑）
      openDirBtn?.classList.remove('hidden');
    } else {
      // 角色/规则：隐藏打开目录按钮
      openDirBtn?.classList.add('hidden');
    }
  }

  /**
   * 读取配置文件内容（按类型选择 IPC）
   *
   * @param type 配置类型
   * @param name 配置名
   * @returns 文件条目（含完整内容）；文件不存在返回 null
   */
  private async readConfigFile(type: EditorType, name: string): Promise<ConfigFileEntry | null> {
    if (type === 'persona') {
      return window.electronAPI.readPersonaFile(name);
    }
    if (type === 'rule') {
      return window.electronAPI.readRule(name);
    }
    if (type === 'skill') {
      return window.electronAPI.readSkill(name);
    }
    return null;
  }

  /**
   * 渲染 frontmatter 表单（按类型动态生成字段）
   *
   * @param type 配置类型
   */
  private renderFrontmatterForm(type: EditorType): void {
    if (!this.editorForm) return;
    clearElement(this.editorForm);

    const fields = FRONTMATTER_FIELDS[type];
    const fragment = document.createDocumentFragment();

    for (const field of fields) {
      // 字段容器
      const row = document.createElement('div');
      row.className = 'config-file-editor-field';

      // label
      const label = document.createElement('label');
      label.htmlFor = `cfg-editor-${field.key}`;
      label.textContent = field.required ? `${field.label} *` : field.label;
      row.appendChild(label);

      // input
      const input = document.createElement('input');
      input.type = 'text';
      input.id = `cfg-editor-${field.key}`;
      input.dataset.frontmatterKey = field.key;
      input.placeholder = field.placeholder ?? '';
      row.appendChild(input);

      fragment.appendChild(row);
    }

    this.editorForm.appendChild(fragment);
  }

  /**
   * 填充编辑器表单（编辑模式加载已有内容）
   *
   * 解析文件内容（frontmatter + body），分别填充表单字段和正文 textarea。
   *
   * @param content 文件完整内容（含 frontmatter + body）
   */
  private fillEditorForm(content: string): void {
    // 解析 frontmatter（optional chaining + 空值合并，兼容 noUncheckedIndexedAccess）
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    const frontmatterText = frontmatterMatch?.[1] ?? '';
    const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

    // 填充 frontmatter 字段（简单 YAML 解析：key: value）
    const frontmatterValues: Record<string, string> = {};
    for (const line of frontmatterText.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      const fmKey = match?.[1];
      const fmValue = match?.[2];
      if (fmKey !== undefined && fmValue !== undefined) {
        frontmatterValues[fmKey] = fmValue.trim().replace(/^["']|["']$/g, '');
      }
    }

    // 填充表单 input（取值判断代替 key in，TS 能收窄 undefined）
    const inputs = this.editorForm?.querySelectorAll<HTMLInputElement>('input[data-frontmatter-key]');
    inputs?.forEach((input) => {
      const key = input.dataset.frontmatterKey;
      const value = key ? frontmatterValues[key] : undefined;
      if (value !== undefined) {
        input.value = value;
      }
    });

    // 填充正文 textarea
    if (this.editorContent) {
      this.editorContent.value = body.trim();
    }
  }

  /**
   * 处理保存
   *
   * 流程：
   *   1. 收集 frontmatter 表单值 + 正文 textarea
   *   2. 序列化为 .md 文件内容（frontmatter + body）
   *   3. 校验 name 字段非空
   *   4. 调用对应类型的 save IPC
   *   5. 成功后关闭编辑器 + Toast 反馈
   *   6. 失败时 Toast 显示错误（编辑器保持打开，用户可修正后重试）
   */
  private async handleSave(): Promise<void> {
    if (!this.currentEditorType) return;

    const type = this.currentEditorType;
    // 编辑模式用原 name，新建模式用表单输入的 name
    const name = this.currentEditorName ?? this.collectFrontmatterValue('name');
    if (!name) {
      this.host.showToast('请填写名称', 'error');
      return;
    }

    const content = this.serializeEditorContent();
    if (!content) {
      this.host.showToast('正文不能为空', 'error');
      return;
    }

    try {
      const result = await this.saveConfigFile(type, name, content);
      if (result.success) {
        const typeLabel = type === 'persona' ? '角色' : type === 'rule' ? '规则' : '技能';
        this.host.showToast(`${typeLabel}已保存`, 'success');
        this.closeEditor();
        // 刷新对应类型列表
        await this.refreshByType(type);
      } else {
        this.host.showToast(formatErrorMessage('保存失败', result.error), 'error');
      }
    } catch (error) {
      reportError('handleSave', error);
      this.host.showToast(formatErrorMessage('保存失败', error), 'error');
    }
  }

  /**
   * 保存配置文件（按类型选择 IPC）
   *
   * @param type 配置类型
   * @param name 配置名
   * @param content 文件内容
   * @returns 操作结果
   */
  private async saveConfigFile(
    type: EditorType,
    name: string,
    content: string,
  ): Promise<ConfigFileOperationResult> {
    if (type === 'persona') {
      return window.electronAPI.savePersonaFile(name, content);
    }
    if (type === 'rule') {
      return window.electronAPI.saveRule(name, content);
    }
    // skill 类型复用 installSkill 通道（已含热重载逻辑）
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const installResult = await window.electronAPI.installSkill(fileName, content);
    return {
      success: installResult.success,
      error: installResult.error,
      filePath: undefined,
    };
  }

  /**
   * 处理删除
   *
   * 流程：
   *   1. 弹出确认对话框（二次确认）
   *   2. 调用对应类型的 delete IPC
   *   3. 成功后 Toast 反馈 + 刷新列表
   *
   * @param type 配置类型
   * @param name 配置名
   */
  private async handleDelete(type: EditorType, name: string): Promise<void> {
    const typeLabel = type === 'persona' ? '角色' : type === 'rule' ? '规则' : '技能';
    const confirmed = await this.host.showConfirmDialog({
      title: `删除${typeLabel}`,
      message: `确定要删除${typeLabel}"${name}"吗？删除后不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;

    try {
      const result = await this.deleteConfigFile(type, name);
      if (result.success) {
        this.host.showToast(`${typeLabel}已删除`, 'success');
        await this.refreshByType(type);
      } else {
        this.host.showToast(formatErrorMessage('删除失败', result.error), 'error');
      }
    } catch (error) {
      reportError('handleDelete', error);
      this.host.showToast(formatErrorMessage('删除失败', error), 'error');
    }
  }

  /**
   * 删除配置文件（按类型选择 IPC）
   *
   * @param type 配置类型
   * @param name 配置名
   * @returns 操作结果
   */
  private async deleteConfigFile(
    type: EditorType,
    name: string,
  ): Promise<ConfigFileOperationResult> {
    if (type === 'persona') {
      return window.electronAPI.deletePersonaFile(name);
    }
    if (type === 'rule') {
      return window.electronAPI.deleteRule(name);
    }
    return window.electronAPI.deleteSkill(name);
  }

  /** 关闭编辑器（重置状态 + 隐藏模态框） */
  private closeEditor(): void {
    this.currentEditorType = null;
    this.currentEditorName = null;
    this.host.hideModal('config-file-editor-modal');
  }

  // ─── 编辑器辅助方法 ──────────────────────────────────

  /**
   * 收集 frontmatter 表单值
   *
   * @returns frontmatter 键值对
   */
  private collectFrontmatter(): Record<string, string> {
    const values: Record<string, string> = {};
    const inputs = this.editorForm?.querySelectorAll<HTMLInputElement>('input[data-frontmatter-key]');
    inputs?.forEach((input) => {
      const key = input.dataset.frontmatterKey;
      if (key) {
        values[key] = input.value.trim();
      }
    });
    return values;
  }

  /**
   * 收集指定 frontmatter 字段值
   *
   * @param key 字段键名
   * @returns 字段值（找不到返回空字符串）
   */
  private collectFrontmatterValue(key: string): string {
    const input = this.editorForm?.querySelector<HTMLInputElement>(`input[data-frontmatter-key="${key}"]`);
    return input?.value.trim() ?? '';
  }

  /**
   * 序列化编辑器内容为 .md 文件
   *
   * 格式：frontmatter（YAML）+ body（Markdown）
   *
   * @returns 文件内容（含 frontmatter + body）；正文为空返回 null
   */
  private serializeEditorContent(): string | null {
    const frontmatter = this.collectFrontmatter();
    const body = this.editorContent?.value.trim() ?? '';
    if (!body) return null;

    // 构造 frontmatter YAML
    const frontmatterLines: string[] = ['---'];
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value) {
        frontmatterLines.push(`${key}: ${value}`);
      }
    }
    frontmatterLines.push('---', '');

    return frontmatterLines.join('\n') + body;
  }

  // ─── 广播刷新 ────────────────────────────────────────

  /**
   * 按 type 刷新对应列表
   *
   * CONFIG_FILES_CHANGED 广播到达后由 renderer.ts 直接调用，
   * 按 payload.type 分发到对应的 loadXxxList。
   *
   * @param type 配置类型
   */
  async refreshByType(type: 'persona' | 'rule' | 'skill'): Promise<void> {
    if (type === 'persona') {
      await this.loadPersonaList();
    } else if (type === 'rule') {
      await this.loadRuleList();
    } else if (type === 'skill') {
      await this.loadSkillList();
    }
  }

  // ─── 角色匹配配置区（M3 迁移） ──────────────────────

  /**
   * 设置角色匹配模式
   *
   * 由 renderer.ts 加载配置后调用，初始化 radio 选中状态。
   *
   * @param mode 当前模式（'auto' | 'manual'）
   */
  setPersonaMode(mode: 'auto' | 'manual'): void {
    this.personaModeRadios.forEach((radio) => {
      radio.checked = radio.value === mode;
    });
  }

  /**
   * 设置默认角色输入框值
   *
   * 由 renderer.ts 加载配置后调用。
   *
   * @param value 默认角色名（空字符串表示未设置）
   */
  setDefaultPersona(value: string): void {
    // 暂存值，供 renderPersonaList 刷新 options 后恢复选中（options 可能尚未填充）
    this.currentDefaultPersona = value;
    if (this.cfgDefaultPersona) {
      this.cfgDefaultPersona.value = value;
    }
  }

  /**
   * 注册角色匹配模式变更回调
   *
   * 由 renderer.ts 注册：radio 切换时持久化到 spriteConfig。
   *
   * @param callback 模式变更回调
   */
  onPersonaModeChange(callback: (mode: 'auto' | 'manual') => void): void {
    this.personaModeChangeCallback = callback;
  }

  /**
   * 注册默认角色变更回调
   *
   * 由 renderer.ts 注册：输入框失焦时持久化到 spriteConfig。
   *
   * @param callback 默认角色变更回调
   */
  onDefaultPersonaChange(callback: (value: string) => void): void {
    this.defaultPersonaChangeCallback = callback;
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
