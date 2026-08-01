/**
 * 精灵设定编辑器组件
 *
 * 职责（封装 settingsManagerPanel 中编辑器模态框的 DOM 操作）：
 * - 管理编辑器模态框 DOM 元素引用（modal/title/form/content）
 * - 按类型动态渲染 frontmatter 表单字段
 * - 内容序列化与反序列化（frontmatter + body）
 * - 编辑器打开/关闭/填充的 DOM 操作
 *
 * 与现有 HTML 模板的关系：
 * - 编辑器 DOM 元素已存在于 index.html 模板中（config-file-editor-modal）
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用
 *
 * 对齐 ARCH-COMP-1 阶段 3 方案：
 * - Manager 持有 Component 实例，调用 mount/update/destroy
 * - Manager 的 openEditor/handleSave 调用 Component 的 DOM 操作方法
 * - 业务逻辑（IPC 调用、数据加载）保留在 Manager
 */

import { Component } from '../base/component.js';
import { clearElement } from '../../helpers/domHelpers.js';

// ─── 类型定义 ──────────────────────────────────────────────

/** 设定文件编辑类型（与 ConfigFileType 对齐） */
export type EditorType = 'persona' | 'rule' | 'skill';

/**
 * frontmatter 字段定义
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
 * 集中定义，避免散落在编辑器逻辑中的 if-else 分支。
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

// ─── 组件选项 ──────────────────────────────────────────────

/** SettingsEditorComponent 配置 */
export interface SettingsEditorOptions {
  // 当前无跨模块关注点注入，保留接口供后续扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 精灵设定编辑器组件
 *
 * 由 SettingsManagerPanelManager 持有实例，替代原有 4 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #config-file-editor-modal 及相关元素。
 * 提供编辑器打开/关闭、表单渲染、内容序列化等 DOM 操作方法。
 */
export class SettingsEditorComponent extends Component<SettingsEditorOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 编辑器模态框容器 */
  private editorModal: HTMLElement | null = null;
  /** 编辑器标题 */
  private editorTitle: HTMLElement | null = null;
  /** frontmatter 表单容器（动态渲染字段） */
  private editorForm: HTMLElement | null = null;
  /** 正文 textarea */
  private editorContent: HTMLTextAreaElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: SettingsEditorOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 编辑器 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    this.editorModal = document.getElementById('config-file-editor-modal');
    this.editorTitle = document.getElementById('config-file-editor-title');
    this.editorForm = document.getElementById('config-file-editor-form');
    const contentEl = document.getElementById('config-file-editor-content');
    this.editorContent = contentEl instanceof HTMLTextAreaElement ? contentEl : null;

    // 设置 this.el 为 editorModal（Component 基类需要，但 destroy 时不会删除模板元素）
    this.el = this.editorModal;

    return this;
  }

  /**
   * 增量更新——当前编辑器组件不使用 update 模式
   *
   * 编辑器操作通过 open/close/fillForm 等显式方法完成。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 编辑器元素是 HTML 模板的一部分，不删除 DOM。
   * 仅 nullify 内部引用，防止内存泄漏。
   */
  destroy(): void {
    this.editorModal = null;
    this.editorTitle = null;
    this.editorForm = null;
    this.editorContent = null;
    super.destroy();
  }

  // ─── 编辑器打开/关闭 ──────────────────────────────────

  /**
   * 打开编辑器——设置标题、渲染表单、清空正文、切换正文区域显示
   *
   * 仅处理 DOM 操作，不涉及 IPC 加载。
   * Manager 调用此方法后，再通过 IPC 加载内容并调用 fillForm。
   *
   * @param type 配置类型
   * @param name 配置名（null 表示新建模式）
   */
  open(type: EditorType, name: string | null): void {
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

    // 切换正文区域显示（技能类型显示打开目录按钮）
    this.toggleEditorBodySection(type);
  }

  /**
   * 关闭编辑器——重置状态
   *
   * 仅处理 DOM 操作，不涉及模态框隐藏（由 Host 接口处理）。
   */
  close(): void {
    // 清空表单和正文（下次打开时重新渲染）
    if (this.editorForm) {
      clearElement(this.editorForm);
    }
    if (this.editorContent) {
      this.editorContent.value = '';
    }
  }

  // ─── 表单操作 ──────────────────────────────────────────

  /**
   * 填充编辑器表单（编辑模式加载已有内容）
   *
   * 解析文件内容（frontmatter + body），分别填充表单字段和正文 textarea。
   *
   * @param content 文件完整内容（含 frontmatter + body）
   */
  fillForm(content: string): void {
    // 解析 frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
    const frontmatterText = frontmatterMatch?.[1] ?? '';
    const body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;

    // 解析 frontmatter 键值对
    const frontmatterValues: Record<string, string> = {};
    for (const line of frontmatterText.split('\n')) {
      const match = line.match(/^(\w+):\s*(.*)$/);
      const fmKey = match?.[1];
      const fmValue = match?.[2];
      if (fmKey !== undefined && fmValue !== undefined) {
        frontmatterValues[fmKey] = fmValue.trim().replace(/^["']|["']$/g, '');
      }
    }

    // 填充表单 input
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
   * 收集 frontmatter 表单值
   *
   * @returns frontmatter 键值对
   */
  collectFrontmatter(): Record<string, string> {
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
  collectFrontmatterValue(key: string): string {
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
  serializeContent(): string | null {
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

  // ─── 私有方法 ──────────────────────────────────────────

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
   * 切换编辑器打开目录按钮的显示状态
   *
   * 技能类型：显示打开目录按钮
   * 角色/规则类型：隐藏打开目录按钮
   *
   * @param type 配置类型
   */
  private toggleEditorBodySection(type: EditorType): void {
    const openDirBtn = document.querySelector('.config-file-editor-open-dir');

    if (type === 'skill') {
      openDirBtn?.classList.remove('hidden');
    } else {
      openDirBtn?.classList.add('hidden');
    }
  }
}