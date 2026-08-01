/**
 * 命令面板组件
 *
 * 职责（封装 CommandPaletteManager 中面板自身的 DOM 操作）：
 * - 管理命令面板 DOM 元素引用（容器/输入框/结果容器）
 * - 面板打开/关闭的 DOM 操作（显示/隐藏/清空/聚焦/aria-modal）
 * - 搜索结果渲染（按 section 分组 + 高亮匹配 + 选中态标记）
 * - 事件绑定（输入搜索/键盘导航/遮罩点击/结果项点击委托）
 *
 * 与现有 HTML 模板的关系：
 * - 面板 DOM 元素已存在于 index.html 模板中（command-palette 等）
 * - 本组件 mount() 时查询并缓存这些已有元素引用，不创建新元素
 * - destroy() 不删除 DOM 元素（模板部分），仅解绑事件 + nullify 引用
 *
 * 对齐 ARCH-COMP-1 阶段 4 方案：
 * - Manager 持有 Component 实例，调用 mount/initEvents/open/close/renderResults/destroy
 * - Manager 的 open/close/search 委托 Component 的 DOM 操作方法
 * - 业务逻辑（命令注册/搜索排序/键盘导航/执行延迟）保留在 Manager
 */

import { Component } from '../base/component.js';
// clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
import { clearElement } from '../../helpers/domHelpers.js';
// type-only 引用：编译期擦除，避免与 Manager 形成运行时循环依赖
import type { SearchResult } from '../../panels/commandPaletteManager.js';

// ─── 组件选项 ──────────────────────────────────────────────

/** CommandPaletteComponent 配置（当前无外部配置，保留接口供后续扩展） */
export interface CommandPaletteOptions {
  // 当前无跨模块关注点注入，保留接口供后续扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * 命令面板组件
 *
 * 由 CommandPaletteManager 持有实例，替代原有 3 处 document.getElementById
 * 直接 DOM 操作（command-palette / command-palette-input / command-palette-results）。
 * 封装面板显示/隐藏、输入清空/聚焦、搜索结果分组渲染、事件委托等能力。
 */
export class CommandPaletteComponent extends Component<CommandPaletteOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 面板容器（模态框 overlay） */
  private paletteEl: HTMLElement | null = null;
  /** 搜索输入框 */
  private inputEl: HTMLInputElement | null = null;
  /** 搜索结果容器 */
  private resultsEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: CommandPaletteOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 面板 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   * mount 成功后 this.el 指向 paletteEl，外部通过 getElement() 判断挂载是否成功。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约，实际不使用）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    this.paletteEl = document.getElementById('command-palette');
    const inputEl = document.getElementById('command-palette-input');
    this.inputEl = inputEl instanceof HTMLInputElement ? inputEl : null;
    this.resultsEl = document.getElementById('command-palette-results');

    // 设置 this.el 为 paletteEl（Component 基类需要，用于 getElement() 判断挂载成功）
    this.el = this.paletteEl;

    return this;
  }

  /**
   * 增量更新——当前命令面板组件不使用 update 模式
   *
   * 面板操作通过 open/close/renderResults 等显式方法完成。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 面板元素是 HTML 模板的一部分，不删除 DOM。
   * 先 nullify this.el 防止基类 el.remove() 删除模板元素，再调 super.destroy() 清理事件。
   */
  destroy(): void {
    this.paletteEl = null;
    this.inputEl = null;
    this.resultsEl = null;
    // 先 nullify this.el，防止基类 el.remove() 删除 HTML 模板元素
    this.el = null;
    super.destroy();
  }

  // ─── 事件绑定 ──────────────────────────────────────────

  /**
   * 初始化面板事件
   *
   * 绑定 4 类事件，全部通过 trackEvent 注册解绑函数，由 destroy() 统一清理。
   * 由 Manager 的 init() 中调用。
   *
   * @param onInput 输入时回调（接收输入框值）
   * @param onKeydown 键盘导航回调（接收 KeyboardEvent）
   * @param onOverlayClick 点击遮罩层关闭回调
   * @param onItemClick 点击结果项执行回调（接收索引值）
   */
  initEvents(
    onInput: (value: string) => void,
    onKeydown: (e: KeyboardEvent) => void,
    onOverlayClick: () => void,
    onItemClick: (index: number) => void,
  ): void {
    const palette = this.paletteEl;
    const input = this.inputEl;
    const results = this.resultsEl;
    if (!palette || !input || !results) return;

    // 点击遮罩层关闭（仅当点击目标 === 面板容器本身时触发）
    const handleOverlayClick = (e: Event): void => {
      if (e.target === palette) {
        onOverlayClick();
      }
    };
    this.trackEvent(() => palette.removeEventListener('click', handleOverlayClick));
    palette.addEventListener('click', handleOverlayClick);

    // 输入时实时搜索
    const handleInput = (): void => {
      onInput(input.value);
    };
    this.trackEvent(() => input.removeEventListener('input', handleInput));
    input.addEventListener('input', handleInput);

    // 键盘导航（↑↓ / Enter / Esc）
    const handleKeydown = (e: Event): void => {
      onKeydown(e as KeyboardEvent);
    };
    this.trackEvent(() => input.removeEventListener('keydown', handleKeydown));
    input.addEventListener('keydown', handleKeydown);

    // 结果项点击——事件委托（单监听器挂在 resultsEl 上，通过 data-index 匹配）
    // 避免每次 renderResults 重建 DOM 时逐项 addEventListener 导致 _cleanups 无限增长
    const handleClick = (e: Event): void => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const item = target.closest<HTMLElement>('[data-index]');
      if (!item) return;
      const indexStr = item.dataset.index;
      if (indexStr === undefined || indexStr === '') return;
      const index = parseInt(indexStr, 10);
      if (Number.isFinite(index)) {
        onItemClick(index);
      }
    };
    this.trackEvent(() => results.removeEventListener('click', handleClick));
    results.addEventListener('click', handleClick);
  }

  // ─── 面板操作 ──────────────────────────────────────────

  /**
   * 打开面板
   *
   * 显示面板 + 设置 aria-modal + 清空输入 + 聚焦输入框。
   * Manager 负责焦点保存/滚动锁定/命令加载等业务逻辑。
   */
  open(): void {
    if (!this.paletteEl || !this.inputEl) return;

    this.paletteEl.classList.remove('hidden');
    // aria-modal 动态设置：通知屏幕阅读器进入对话框模式
    this.paletteEl.setAttribute('aria-modal', 'true');

    // 清空输入并聚焦
    this.inputEl.value = '';
    this.inputEl.focus();
  }

  /**
   * 关闭面板
   *
   * 隐藏面板 + 移除 aria-modal + 清空输入。
   * Manager 负责焦点恢复/滚动解锁等业务逻辑。
   */
  close(): void {
    if (!this.paletteEl) return;

    this.paletteEl.classList.add('hidden');
    // 移除 aria-modal，避免屏幕阅读器误判隐藏的对话框仍为活跃状态
    this.paletteEl.removeAttribute('aria-modal');

    // 清空输入
    if (this.inputEl) {
      this.inputEl.value = '';
    }
  }

  /**
   * 获取输入框当前值
   *
   * 供 Manager 的 highlightMatch() 使用，替代原有直接访问 inputEl.value。
   *
   * @returns 输入框值（未挂载时返回空字符串）
   */
  getInputValue(): string {
    return this.inputEl?.value ?? '';
  }

  // ─── 结果渲染 ──────────────────────────────────────────

  /**
   * 渲染搜索结果列表
   *
   * 按 section 分组渲染，高亮匹配文本，标记选中项。
   * 使用 clearElement + createElement 替代 innerHTML 拼接，防 XSS。
   *
   * @param results 搜索结果数组（已按得分降序排列）
   * @param selectedIndex 当前选中索引（高亮标记）
   * @param highlightFn 高亮函数（接收文本，返回带 <mark> 标签的 HTML 字符串）
   */
  renderResults(
    results: SearchResult[],
    selectedIndex: number,
    highlightFn: (text: string) => string,
  ): void {
    if (!this.resultsEl) return;

    // 清空旧结果
    clearElement(this.resultsEl);

    // 无匹配时显示空状态
    if (results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'command-palette-empty';
      empty.textContent = '无匹配命令';
      this.resultsEl.appendChild(empty);
      return;
    }

    // 按 section 分组渲染
    let lastSection = '';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result) continue;
      const { command } = result;

      // 分组标题（section 变化时插入）
      if (command.section !== lastSection) {
        lastSection = command.section;
        const header = document.createElement('div');
        header.className = 'command-palette-section';
        header.textContent = command.section;
        this.resultsEl.appendChild(header);
      }

      // 命令项容器
      const item = document.createElement('div');
      item.className = `command-palette-item flex-between${i === selectedIndex ? ' active' : ''}`;
      item.setAttribute('data-index', String(i));

      // 命令名称（高亮匹配文本）
      const labelSpan = document.createElement('span');
      labelSpan.className = 'command-palette-label';
      labelSpan.innerHTML = highlightFn(command.label);
      item.appendChild(labelSpan);

      // 快捷键提示（可选）
      if (command.shortcut) {
        const kbd = document.createElement('kbd');
        kbd.className = 'command-palette-shortcut flex-shrink-0';
        kbd.textContent = command.shortcut;
        item.appendChild(kbd);
      }

      // 点击执行通过事件委托处理（initEvents 中绑定），此处无需单独 addEventListener
      this.resultsEl.appendChild(item);
    }
  }
}
