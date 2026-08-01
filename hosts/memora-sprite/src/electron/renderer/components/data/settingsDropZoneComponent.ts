/**
 * 精灵设定技能拖入安装区组件
 *
 * 职责（封装 settingsManagerPanel 中技能拖入安装区的 DOM 操作）：
 * - 管理技能拖入安装区 DOM 元素引用（dropzone + file input）
 * - 绑定 dragenter/dragover/dragleave/drop 拖拽事件
 * - 绑定 click/keydown 键盘可访问性事件
 * - 绑定 file input change 事件
 * - 通过回调委托安装逻辑给 Manager
 *
 * 与现有 HTML 模板的关系：
 * - 技能拖入安装区 DOM 元素已存在于 index.html 模板中
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用 + 解绑事件
 *
 * 对齐 ARCH-COMP-1 阶段 3 方案：
 * - Manager 持有 Component 实例，调用 mount/update/destroy
 * - Manager 通过 onSkillInstall 回调处理安装逻辑
 * - 业务逻辑（IPC 调用、安装反馈）保留在 Manager
 */

import { Component } from '../base/component.js';

// ─── 组件选项 ──────────────────────────────────────────────

/** SettingsDropZoneComponent 配置 */
export interface SettingsDropZoneOptions {
  // 当前无跨模块关注点注入，保留接口供后续扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 精灵设定技能拖入安装区组件
 *
 * 由 SettingsManagerPanelManager 持有实例，替代原有 2 处 document.getElementById
 * 直接 DOM 操作（sprite-skill-dropzone + sprite-skill-file-input）。
 * 封装拖拽/点击/键盘事件绑定，通过 onSkillInstall 回调委托安装逻辑。
 */
export class SettingsDropZoneComponent extends Component<SettingsDropZoneOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 技能拖入安装区 */
  private dropzone: HTMLElement | null = null;
  /** 技能文件选择 input */
  private fileInput: HTMLInputElement | null = null;

  // ─── 回调 ────────────────────────────────────────────

  /** 技能安装回调（由 Manager 注册，接收拖入/选择的文件列表） */
  onSkillInstall: ((files: File[]) => void) | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: SettingsDropZoneOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 技能拖入安装区 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    this.dropzone = document.getElementById('sprite-skill-dropzone');
    const inputEl = document.getElementById('sprite-skill-file-input');
    this.fileInput = inputEl instanceof HTMLInputElement ? inputEl : null;

    // 设置 this.el 为 dropzone（Component 基类需要，但 destroy 时不会删除模板元素）
    this.el = this.dropzone;

    return this;
  }

  /**
   * 增量更新——当前拖入安装区组件不使用 update 模式
   *
   * 事件绑定在 initEvents 中一次完成，无动态更新需求。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——解绑事件 + nullify 引用
   *
   * 通过 trackEvent 收集的事件解绑函数由基类 destroy 统一调用。
   * 额外 nullify 回调引用，防止内存泄漏。
   */
  destroy(): void {
    this.dropzone = null;
    this.fileInput = null;
    this.onSkillInstall = null;
    super.destroy();
  }

  /**
   * 初始化事件绑定
   *
   * 绑定拖拽事件（dragenter/dragover/dragleave/drop）+ 点击事件 + 键盘事件 + 文件选择事件。
   * 所有事件通过 trackEvent 注册解绑函数，由 destroy() 统一清理。
   * 由 Manager 的 init() 中调用。
   */
  initEvents(): void {
    const dropzone = this.dropzone;
    if (!dropzone) return;

    // dragenter/dragover：阻止默认行为 + 添加高亮类
    const handleDragOver = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('is-dragover');
    };

    this.trackEvent(() => {
      dropzone.removeEventListener('dragenter', handleDragOver);
      dropzone.removeEventListener('dragover', handleDragOver);
    });
    dropzone.addEventListener('dragenter', handleDragOver);
    dropzone.addEventListener('dragover', handleDragOver);

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

    this.trackEvent(() => dropzone.removeEventListener('dragleave', handleDragLeave));
    dropzone.addEventListener('dragleave', handleDragLeave);

    // drop：提取文件 + 移除高亮 + 委托回调
    const handleDrop = (e: Event): void => {
      const dragEvent = e as DragEvent;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      dropzone.classList.remove('is-dragover');
      const files = dragEvent.dataTransfer?.files;
      if (files && files.length > 0) {
        this.onSkillInstall?.(Array.from(files));
      }
    };

    this.trackEvent(() => dropzone.removeEventListener('drop', handleDrop));
    dropzone.addEventListener('drop', handleDrop);

    // click：触发文件选择对话框
    const handleClick = (): void => {
      this.fileInput?.click();
    };

    this.trackEvent(() => dropzone.removeEventListener('click', handleClick));
    dropzone.addEventListener('click', handleClick);

    // keydown：Enter/Space 触发点击（键盘可访问性）
    const handleKeydown = (e: Event): void => {
      const keyboardEvent = e as KeyboardEvent;
      if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
        keyboardEvent.preventDefault();
        this.fileInput?.click();
      }
    };

    this.trackEvent(() => dropzone.removeEventListener('keydown', handleKeydown));
    dropzone.addEventListener('keydown', handleKeydown);

    // change：文件选择后触发
    const handleFileChange = (): void => {
      if (this.fileInput?.files && this.fileInput.files.length > 0) {
        this.onSkillInstall?.(Array.from(this.fileInput.files));
        // 清空 input.value 允许重复选择同一文件
        this.fileInput.value = '';
      }
    };

    if (this.fileInput) {
      this.trackEvent(() => this.fileInput?.removeEventListener('change', handleFileChange));
      this.fileInput.addEventListener('change', handleFileChange);
    }
  }
}