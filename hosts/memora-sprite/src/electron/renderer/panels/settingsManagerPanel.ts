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

import { getOptionalElement, showPanelLoading } from '../helpers/domHelpers.js';
import { reportError } from '../helpers/errorHelpers.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { formatErrorMessage } from '../../../shared/errorMessages.js';
import type { ConfirmDialogOptions, ToastType } from '../types.js';
// ConfigFileEntry / ConfigFileOperationResult 从 preload 统一导出（真理源在 sprite.configFileManager）
import type { ConfigFileEntry, ConfigFileOperationResult } from '../../../sprite/configFileManager.js';
// 设定面板 Component（ARCH-COMP-1 阶段 3：封装 DOM 操作，替代直接查询）
import { SettingsEditorComponent } from '../components/data/settingsEditorComponent.js';
import { SettingsFileListComponent } from '../components/data/settingsFileListComponent.js';
import { SettingsDropZoneComponent } from '../components/data/settingsDropZoneComponent.js';
import type { EditorType } from '../components/data/settingsEditorComponent.js';

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

// EditorType 从 settingsEditorComponent 导入，FRONTMATTER_FIELDS 已迁入 Component

// ─── 精灵设定面板管理器类 ─────────────────────────────────

export class SettingsManagerPanelManager {
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();

  // ─── Component 实例（ARCH-COMP-1 阶段 3：封装 DOM 操作，替代直接查询） ─
  /** 编辑器组件（模态框/标题/表单/content DOM 操作） */
  private editorComponent: SettingsEditorComponent;
  /** 文件列表组件（tab 切换 + 6 组列表容器 + 空状态 + 列表渲染） */
  private fileListComponent: SettingsFileListComponent;
  /** 技能拖入安装区组件（拖拽/点击/键盘事件） */
  private dropZoneComponent: SettingsDropZoneComponent;

  // ─── DOM 元素引用 - 角色匹配配置区（M3 迁移，保留在 Manager） ──
  /** 角色匹配模式 radio 组 */
  private personaModeRadios: NodeListOf<HTMLInputElement>;
  /** 默认角色下拉框（动态从角色列表读取 options，避免手敲错误角色名） */
  private cfgDefaultPersona: HTMLSelectElement | null;

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
    // 创建 Component 实例并挂载到现有 HTML 模板元素
    this.editorComponent = new SettingsEditorComponent().mount('');
    this.fileListComponent = new SettingsFileListComponent().mount('');
    this.dropZoneComponent = new SettingsDropZoneComponent().mount('');

    // 角色匹配配置区（M3 从设置面板迁移，DOM 在 panel-sprite-settings 内）
    // sprite- 前缀作为面板归属标识（与 perception-/dashboard-/archive- 同模式），非冲突规避
    this.personaModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="sprite-persona-mode"]');
    this.cfgDefaultPersona = document.getElementById('cfg-sprite-default-persona') as HTMLSelectElement | null;
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
    // 委托 Component 处理 tab 切换和列表项事件委托
    this.fileListComponent.initTabSwitching();
    this.fileListComponent.initEventDelegation();
    // 注册列表项编辑/删除回调
    this.fileListComponent.onEdit = (type, name) => this.openEditor(type, name);
    this.fileListComponent.onDelete = (type, name) => void this.handleDelete(type, name);

    this.initCreateButtons();
    this.initEditorListeners();
    this.initPersonaConfigArea();

    // 委托 Component 处理技能拖入安装区事件
    this.dropZoneComponent.onSkillInstall = (files) => this.host.onSkillInstall(files);
    this.dropZoneComponent.initEvents();
  }

  /** 清理所有事件监听器和 Component 实例 */
  cleanup(): void {
    this.events.cleanup();
    // 销毁 Component 实例（解绑事件 + nullify 引用）
    this.editorComponent.destroy();
    this.fileListComponent.destroy();
    this.dropZoneComponent.destroy();
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
    this.fileListComponent.renderGuardrailEmpty();
    this.fileListComponent.renderProjectRuleEmpty();
  }

  /** 加载角色文件列表并渲染 */
  private async loadPersonaList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    const personaList = document.getElementById('persona-config-list');
    if (personaList) showPanelLoading(personaList, '加载角色列表…');
    try {
      // listPersonas 返回 { personas: Array<{ name, description, active }> }
      // 角色 active 状态由主进程维护，设定面板直接渲染（无需文件级 mtime）
      const { personas } = await window.electronAPI.listPersonas();
      this.fileListComponent.renderPersonaList(personas, this.currentDefaultPersona, this.cfgDefaultPersona);
    } catch (error) {
      reportError('loadPersonaList', error);
      this.host.showToast('加载角色列表失败', 'error');
    }
  }

  /** 加载规则文件列表并渲染 */
  private async loadRuleList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    const ruleList = document.getElementById('rule-config-list');
    if (ruleList) showPanelLoading(ruleList, '加载规则列表…');
    try {
      const entries = await window.electronAPI.listRules();
      this.fileListComponent.renderRuleList(entries);
    } catch (error) {
      reportError('loadRuleList', error);
      this.host.showToast('加载规则列表失败', 'error');
    }
  }

  /** 加载技能文件列表并渲染 */
  private async loadSkillList(): Promise<void> {
    // UX-REVIEW-08：加载前显示 loading 反馈，与 profilePanel/healthDashboard 对齐
    const skillList = document.getElementById('skill-config-list');
    if (skillList) showPanelLoading(skillList, '加载技能列表…');
    try {
      const entries = await window.electronAPI.listSkills();
      this.fileListComponent.renderSkillList(entries);
    } catch (error) {
      reportError('loadSkillList', error);
      this.host.showToast('加载技能列表失败', 'error');
    }
  }

  // ─── 列表渲染（已委托给 fileListComponent） ──────────

  // ─── 事件绑定 ────────────────────────────────────────

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
   * 初始化编辑器模态框事件
   *
   * 绑定保存/取消/关闭按钮 + overlay 点击关闭。
   * 使用 data-action 委托，统一在模态框容器注册一次 click 监听。
   * 编辑器模态框 DOM 引用通过 editorComponent 获取。
   */
  private initEditorListeners(): void {
    const editorModal = this.editorComponent.getElement();
    if (!editorModal) return;

    this.events.addEventListener(editorModal, 'click', (e: Event) => {
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

    // 委托 Component 处理编辑器 DOM 操作（标题/表单/正文/正文区域切换）
    this.editorComponent.open(type, name);

    // 编辑模式：加载已有内容
    if (name) {
      try {
        const entry = await this.readConfigFile(type, name);
        if (entry) {
          this.editorComponent.fillForm(entry.content);
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
    const name = this.currentEditorName ?? this.editorComponent.collectFrontmatterValue('name');
    if (!name) {
      this.host.showToast('请填写名称', 'error');
      return;
    }

    const content = this.editorComponent.serializeContent();
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
   * MIND2-A4：persona/rule 统一走 saveConfigFile 通道，skill 复用 installSkill（含热重载）
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
    if (type === 'persona' || type === 'rule') {
      // MIND2-A4：统一调用 saveConfigFile，type 参数区分 persona/rule
      return window.electronAPI.saveConfigFile(type, name, content);
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
    // 委托 Component 清理编辑器 DOM（清空表单和正文）
    this.editorComponent.close();
    this.host.hideModal('config-file-editor-modal');
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
}
