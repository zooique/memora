/**
 * 下拉选择器渲染（CHATVIEW-SLIM-3 首刀·零状态批，自 chatView.ts 外置）
 *
 * 域职责：模型选择器等下拉共用单一渲染器（「清空菜单 → 遍历建项 → 更新触发器」）；
 * 角色选择器独立在「角色」视图。picker 通过 { menu, trigger, items, activeName, 文案 }
 * 配置声明差异（对齐 §四.2 声明式工厂）。
 *
 * **边界（与 `processFlowCells` 同一形态宪法）**：本域不持有任何 chatView 状态，
 * 不注册事件监听、不启动定时器 ⇒ 无 `dispose`。DOM 入口只经 deps 注入的 `document`
 * （禁读全局 document，保证 jsdom 下可测）。
 *
 * @module pickerView
 */

/** 下拉项数据（name 为事件 id，displayName 为展示名，description 可选副标题） */
export interface PickerItem {
  name: string;
  displayName: string;
  description?: string;
}

/** 下拉渲染依赖：仅文档对象 */
export interface PickerViewDeps {
  /** webview 文档对象（构造唯一 DOM 入口；禁在模块内读全局 document） */
  document: Document;
}

/** 下拉渲染窄接口：chatView 仅经此驱动 */
export interface PickerView {
  /** 渲染下拉选择器：构建菜单项 + 更新触发器文本 + 可访问性标签（textContent 防注入） */
  renderPicker(
    menu: HTMLElement | null,
    trigger: HTMLElement | null,
    items: PickerItem[],
    activeName: string | undefined,
    opts: { emptyText?: string; labelFallback: string; ariaLabel: string },
  ): void;
}

export function createPickerView(deps: PickerViewDeps): PickerView {
  const { document } = deps;

  /** 渲染下拉选择器：构建菜单项 + 更新触发器文本 + 可访问性标签（textContent 防注入） */
  function renderPicker(
    menu: HTMLElement | null,
    trigger: HTMLElement | null,
    items: PickerItem[],
    activeName: string | undefined,
    opts: { emptyText?: string; labelFallback: string; ariaLabel: string },
  ): void {
    if (!menu) return;
    // 防注入：名称来自用户配置/角色包，禁止 innerHTML 拼接，一律 createElement + textContent
    menu.textContent = '';
    if (items.length > 0) {
      items.forEach((p) => {
        const isActive = p.name === activeName;
        const btn = document.createElement('button');
        btn.className = 'treedd__item' + (isActive ? ' is-active' : '');
        btn.setAttribute('role', 'menuitem');
        btn.setAttribute('data-treedd-id', p.name);
        const nameEl = document.createElement('span');
        nameEl.className = 'dd-item-name';
        nameEl.textContent = p.displayName || p.name;
        btn.appendChild(nameEl);
        // 可选描述副标题（角色包定位，供下拉展示；无描述时仅显示名称）
        if (p.description) {
          const descEl = document.createElement('span');
          descEl.className = 'dd-item-desc';
          descEl.textContent = p.description;
          btn.appendChild(descEl);
        }
        menu.appendChild(btn);
      });
    } else if (opts.emptyText) {
      const empty = document.createElement('div');
      empty.className = 'treedd__empty';
      empty.textContent = opts.emptyText;
      menu.appendChild(empty);
    }
    // 更新触发器显示当前项（textContent 防注入）。
    // SSOT：用 <span class="dd-trigger-name"> 包裹名称，CSS 只对此 span 做 ellipsis 截断，
    // 而 ::after 下拉箭头 flex-shrink:0 永远外露（dd-trigger-name 为通用语义类，模型/角色共用）
    if (trigger) {
      const active = items.find((p) => p.name === activeName);
      const label = active ? active.displayName : opts.labelFallback;
      trigger.textContent = '';
      const span = document.createElement('span');
      span.className = 'dd-trigger-name';
      span.textContent = label;
      trigger.appendChild(span);
      // 触发器可访问性：为读屏提供名称（aria-haspopup 已在组件 HTML 中声明）
      trigger.setAttribute('aria-label', opts.ariaLabel + '：' + label);
    }
  }

  return { renderPicker };
}
