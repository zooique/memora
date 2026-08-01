/**
 * Provider 选择器组件
 *
 * 职责（封装 InputAreaManager 中 Provider 选择器的 DOM 操作）：
 * - 管理 Provider 选择器 DOM 元素引用（selector/name/dropdown）
 * - 渲染 Provider 列表与空状态提示
 * - 绑定选择器交互事件（点击切换、外部关闭、键盘导航）
 * - 切换下拉显隐、更新显示名称、设置配置状态
 *
 * 与现有 HTML 模板的关系：
 * - 选择器 DOM 元素已存在于 index.html 模板中（#provider-selector 等）
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素（模板部分），仅 nullify 引用 + 解绑事件
 *
 * 对齐 ARCH-COMP-1 阶段 4 方案：
 * - Manager 持有 Component 实例，调用 mount/initEvents/render* 方法
 * - Manager 的 initProviderSelector/loadProviderSelector 调用 Component 的 DOM 操作方法
 * - 业务逻辑（IPC 调用 setActiveLlmProvider、loadProviderSelector 重新加载）保留在 Manager
 */

import { Component } from '../base/component.js';
// clearElement 替代 innerHTML=''，遵循统一 DOM 操作模式
import { clearElement } from '../../helpers/domHelpers.js';

// ─── 类型定义 ──────────────────────────────────────────────

/**
 * Provider 选项数据
 *
 * 用于 renderProviders 渲染下拉菜单项。
 * Manager 从 IPC 获取的 providers 结构兼容此接口（至少包含 key + name）。
 */
export interface ProviderOption {
  /** Provider 唯一键（用于 setActiveLlmProvider IPC） */
  key: string;
  /** Provider 显示名称（渲染为下拉项文本） */
  name: string;
}

// ─── 组件选项 ──────────────────────────────────────────────

/** ProviderSelectorComponent 配置（当前无跨模块关注点注入，保留接口供后续扩展） */
export interface ProviderSelectorOptions {
  // 预留扩展
}

// ─── 组件 ──────────────────────────────────────────────────

/**
 * Provider 选择器组件
 *
 * 由 InputAreaManager 持有实例，替代原有 3 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #provider-selector / #provider-name / #provider-dropdown。
 * 提供下拉切换、列表渲染、事件绑定等 DOM 操作方法。
 */
export class ProviderSelectorComponent extends Component<ProviderSelectorOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** Provider 选择器按钮（点击切换下拉） */
  private selectorEl: HTMLElement | null = null;
  /** Provider 名称显示元素（当前激活 Provider 的名称） */
  private nameEl: HTMLElement | null = null;
  /** Provider 下拉菜单容器（包含列表项或空状态提示） */
  private dropdownEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: ProviderSelectorOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * 选择器 DOM 元素已存在于 index.html 模板中，mount 仅做查询缓存，不创建新元素。
   *
   * @param _container 容器元素或选择器（兼容 Component 契约，本组件不使用）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    // 延迟查询 DOM（可能尚未渲染到 DOM 中），缓存引用供后续方法使用
    this.selectorEl = document.getElementById('provider-selector');
    this.nameEl = document.getElementById('provider-name');
    this.dropdownEl = document.getElementById('provider-dropdown');
    // 设置 this.el 为 selectorEl（Component 基类需要根元素锚点）
    // destroy 时会先 nullify this.el，避免基类 remove() 删除模板元素
    this.el = this.selectorEl;
    return this;
  }

  /**
   * 增量更新——当前组件不使用 update 模式
   *
   * 选择器操作通过 renderProviders/renderEmpty/updateName 等显式方法完成。
   *
   * @returns this
   */
  update(): this {
    return this;
  }

  /**
   * 销毁组件——nullify 引用 + 解绑事件
   *
   * 选择器元素是 HTML 模板的一部分，不删除 DOM。
   * 先 nullify this.el 防止基类 destroy() 的 el.remove() 删除模板元素，
   * 再调用 super.destroy() 清理 trackEvent 收集的事件解绑函数。
   */
  destroy(): void {
    this.selectorEl = null;
    this.nameEl = null;
    this.dropdownEl = null;
    this.el = null; // 防止 super.destroy() 移除模板元素
    super.destroy(); // 清理 _cleanups（事件解绑函数）
  }

  // ─── 事件绑定 ──────────────────────────────────────────

  /**
   * 初始化选择器交互事件
   *
   * 绑定以下事件（通过 trackEvent 收集解绑函数，destroy 时统一清理）：
   * - selector click：切换下拉显隐（stopPropagation 防止 document click 立即关闭）
   * - document click：点击外部区域关闭下拉
   * - dropdown click（事件委托）：点击 Provider 项触发 onSelect，点击空状态提示触发 onGotoSettings
   * - selector keydown：Escape 关闭下拉并聚焦选择器
   * - dropdown keydown：ArrowDown/ArrowUp 导航，Enter 选择，Escape 关闭
   *
   * 设计要点：
   * - 事件委托在 dropdown 容器上绑定一次，通过 data-provider-key / data-action 区分项，
   *   避免 renderProviders 重建 DOM 时重复绑定
   * - 选择 Provider 后由 Component 负责关闭下拉（UI 反馈），onSelect 仅处理业务
   *
   * @param onSelect 选择 Provider 回调（Manager 实现 IPC 调用 + 重新加载 + warning 处理）
   * @param onGotoSettings 空状态跳转设置回调
   */
  initEvents(
    onSelect: (key: string) => Promise<void>,
    onGotoSettings: () => void,
  ): void {
    // 元素缺失时不绑定事件（mount 时元素可能尚未渲染）
    if (!this.selectorEl || !this.dropdownEl) return;

    // 点击 provider 按钮切换下拉（stopPropagation 防止冒泡到 document 触发立即关闭）
    const onSelectorClick = (e: Event) => {
      e.stopPropagation();
      this.toggleDropdown();
    };
    this.selectorEl.addEventListener('click', onSelectorClick);
    this.trackEvent(() => this.selectorEl?.removeEventListener('click', onSelectorClick));

    // 点击页面其他区域关闭下拉
    const onDocClick = () => {
      this.closeDropdown();
    };
    document.addEventListener('click', onDocClick);
    this.trackEvent(() => document.removeEventListener('click', onDocClick));

    // 事件委托：在 dropdown 容器上绑定 click，通过 data-provider-key / data-action 区分项
    // async listener：await onSelect 等待 Manager 完成 IPC + 重新加载（与原实现一致）
    const onDropdownClick = async (e: Event) => {
      const target = e.target as HTMLElement;
      // Provider 项：触发选择回调
      const item = target.closest<HTMLElement>('.dropdown-item[data-provider-key]');
      if (item) {
        const key = item.dataset.providerKey;
        if (key) {
          // 先关闭下拉（UI 反馈），再执行业务（IPC + 重新加载）
          this.closeDropdown();
          await onSelect(key);
        }
        return;
      }
      // 空状态提示项：关闭下拉并跳转到设置面板
      const hint = target.closest<HTMLElement>('[data-action="goto-settings"]');
      if (hint) {
        this.closeDropdown();
        onGotoSettings();
      }
    };
    this.dropdownEl.addEventListener('click', onDropdownClick);
    this.trackEvent(() => this.dropdownEl?.removeEventListener('click', onDropdownClick));

    // 键盘支持：selector 上 Escape 关闭下拉并恢复聚焦（Enter/Space 由原生 button click 自动触发）
    const onSelectorKeydown = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Escape') {
        this.closeDropdown();
        this.focusSelector();
      }
    };
    this.selectorEl.addEventListener('keydown', onSelectorKeydown);
    this.trackEvent(() => this.selectorEl?.removeEventListener('keydown', onSelectorKeydown));

    // 键盘导航：dropdown 内方向键移动焦点，Enter 选择，Escape 关闭
    const onDropdownKeydown = (e: Event) => {
      const ke = e as KeyboardEvent;
      const items = this.dropdownEl!.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');
      if (items.length === 0) return;

      // 当前聚焦项索引（-1 表示无聚焦）
      const currentIdx = Array.from(items).findIndex(
        (item) => item === document.activeElement,
      );

      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        // 无聚焦时聚焦首项，否则聚焦下一项（不越界）
        const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
        items[nextIdx]?.focus();
      } else if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        // 无聚焦时聚焦末项，否则聚焦上一项（不越界）
        const prevIdx = currentIdx < 0 ? items.length - 1 : Math.max(currentIdx - 1, 0);
        items[prevIdx]?.focus();
      } else if (ke.key === 'Enter') {
        ke.preventDefault();
        if (currentIdx >= 0) {
          const key = items[currentIdx]?.dataset.providerKey;
          if (key) {
            // 先关闭下拉，再触发业务（fire-and-forget，与原 IIFE 模式一致）
            this.closeDropdown();
            void onSelect(key);
          }
        }
      } else if (ke.key === 'Escape') {
        this.closeDropdown();
        this.focusSelector();
      }
    };
    this.dropdownEl.addEventListener('keydown', onDropdownKeydown);
    this.trackEvent(() => this.dropdownEl?.removeEventListener('keydown', onDropdownKeydown));
  }

  // ─── DOM 操作方法 ──────────────────────────────────────

  /**
   * 切换下拉菜单显隐
   */
  toggleDropdown(): void {
    this.dropdownEl?.classList.toggle('hidden');
  }

  /**
   * 关闭下拉菜单
   */
  closeDropdown(): void {
    this.dropdownEl?.classList.add('hidden');
  }

  /**
   * 聚焦选择器按钮（Esc 关闭下拉后恢复焦点）
   */
  focusSelector(): void {
    this.selectorEl?.focus();
  }

  /**
   * 渲染 Provider 列表
   *
   * 使用 createElement 替代 innerHTML 拼接，防止 provider 名/key 含特殊字符导致 XSS。
   * 每个项添加 tabindex="-1" 和 role="option" 支持键盘导航。
   *
   * @param providers Provider 列表
   * @param activeKey 当前激活的 Provider key（高亮显示）
   */
  renderProviders(providers: ProviderOption[], activeKey: string): void {
    if (!this.dropdownEl) return;
    clearElement(this.dropdownEl);

    for (const p of providers) {
      const isActive = p.key === activeKey; // 是否为当前激活项
      const item = document.createElement('div');
      item.className = `dropdown-item${isActive ? ' active' : ''}`;
      item.dataset.providerKey = p.key; // dataset 自动转义，避免属性注入
      item.tabIndex = -1; // 支持程序化 focus（键盘导航）
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', isActive ? 'true' : 'false');
      item.textContent = p.name; // textContent 自动转义 HTML，防 XSS
      this.dropdownEl.appendChild(item);
    }
  }

  /**
   * 渲染空状态提示
   *
   * Provider 列表为空时显示跳转设置的提示按钮。
   * 使用 <button> 元素：原生支持 Enter/Space 触发 click，键盘可访问。
   * 点击后跳转到设置面板，让用户快速到达 LLM 配置入口（符合"主动可见"原则）。
   */
  renderEmpty(): void {
    if (!this.dropdownEl) return;
    clearElement(this.dropdownEl);

    const hintBtn = document.createElement('button');
    hintBtn.type = 'button';
    hintBtn.className = 'dropdown-item dropdown-item-hint';
    hintBtn.dataset.action = 'goto-settings';
    hintBtn.textContent = '请在设置中添加 API';
    this.dropdownEl.appendChild(hintBtn);
  }

  /**
   * 更新 Provider 显示名称
   *
   * @param name 显示名称（如 "未配置" / "加载失败" / 实际 Provider 名）
   */
  updateName(name: string): void {
    if (this.nameEl) {
      this.nameEl.textContent = name;
    }
  }

  /**
   * 设置配置状态（添加/移除 configured 类）
   *
   * @param configured true 表示已配置（有可用 Provider），false 表示未配置
   */
  setConfigured(configured: boolean): void {
    if (configured) {
      this.selectorEl?.classList.add('configured');
    } else {
      this.selectorEl?.classList.remove('configured');
    }
  }

  // ─── 元素访问器（供 Manager 守卫检查） ────────────────

  /**
   * 获取选择器元素
   *
   * @returns 选择器元素（未挂载或已销毁时为 null）
   */
  getSelectorEl(): HTMLElement | null {
    return this.selectorEl;
  }

  /**
   * 获取名称元素
   *
   * @returns 名称元素（未挂载或已销毁时为 null）
   */
  getNameEl(): HTMLElement | null {
    return this.nameEl;
  }

  /**
   * 获取下拉菜单元素
   *
   * @returns 下拉菜单元素（未挂载或已销毁时为 null）
   */
  getDropdownEl(): HTMLElement | null {
    return this.dropdownEl;
  }
}
