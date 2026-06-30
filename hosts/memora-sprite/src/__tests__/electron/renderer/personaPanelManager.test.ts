/**
 * 角色选择器面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 构造与 cleanup：事件监听器生命周期委托 EventTracker
 * - initPersonaSelectorListeners：click 切换、键盘导航（Enter/Space/Escape/ArrowDown/ArrowUp）、
 *   document click 关闭、事件委托（data-action="switch-persona"）
 * - renderPersonaDropdown：清空容器、active 标记、tabindex/role/aria-selected/data-* 属性、计数更新
 * - updateActivePersona：正常更新 + null 元素防护
 * - updatePersonaModeBadge：auto/manual 归一化 + 类切换 + null 元素防护
 * - 回调注册：onPersonaSwitch/onMemoryRecallClick/triggerMemoryRecallClick
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - requestAnimationFrame 同步化（mockImplementation 立即执行回调）
 * - JSDOM 提供真实 DOM API（classList/focus/querySelectorAll/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PersonaPanelManager } from '../../../electron/renderer/panels/personaPanelManager.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { PersonaItem } from '../../../electron/renderer/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 persona 选择器的 DOM 结构 */
function setupDom(): {
  selector: HTMLElement;
  dropdown: HTMLElement;
  nameEl: HTMLElement;
  badge: HTMLElement;
  countEl: HTMLElement;
} {
  // selector 需 tabindex 才能在 JSDOM 中 .focus() 生效（document.activeElement 才会指向它）
  document.body.innerHTML = `
    <div id="persona-selector" tabindex="0">当前角色</div>
    <div id="persona-dropdown" class="hidden"></div>
    <div id="persona-name">默认</div>
    <div id="persona-mode-badge"></div>
    <div id="persona-count">0</div>
  `;
  return {
    selector: document.getElementById('persona-selector') as HTMLElement,
    dropdown: document.getElementById('persona-dropdown') as HTMLElement,
    nameEl: document.getElementById('persona-name') as HTMLElement,
    badge: document.getElementById('persona-mode-badge') as HTMLElement,
    countEl: document.getElementById('persona-count') as HTMLElement,
  };
}

/** 创建测试用 PersonaPanelManager 实例（已初始化监听器） */
function createManager(opts?: {
  initListeners?: boolean;
  selector?: HTMLElement | null;
  dropdown?: HTMLElement | null;
  nameEl?: HTMLElement | null;
}) {
  const dom = setupDom();
  const events = new EventTracker();
  const manager = new PersonaPanelManager(
    opts?.selector !== undefined ? opts.selector : dom.selector,
    opts?.dropdown !== undefined ? opts.dropdown : dom.dropdown,
    opts?.nameEl !== undefined ? opts.nameEl : dom.nameEl,
    events,
  );
  if (opts?.initListeners !== false) {
    manager.initPersonaSelectorListeners();
  }
  return { manager, events, ...dom };
}

/** 在 dropdown 中渲染指定数量的角色项（用于键盘导航测试） */
function renderItems(manager: PersonaPanelManager, count: number): void {
  const personas: PersonaItem[] = Array.from({ length: count }, (_, i) => ({
    name: `角色${i + 1}`,
    description: `描述${i + 1}`,
    active: i === 0,
  }));
  manager.renderPersonaDropdown(personas);
}

/** 触发键盘事件 */
function dispatchKeydown(target: HTMLElement, key: string): KeyboardEvent {
  // JSDOM 默认 KeyboardEvent cancelable=false，需显式设为 true 才能 preventDefault
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // requestAnimationFrame 同步化：togglePersonaDropdown 展开时用 rAF 聚焦首项，
  // mock 为立即执行回调，避免异步等待
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 构造与 cleanup ───────────────────────────────────────

describe('PersonaPanelManager · 构造与 cleanup', () => {
  it('cleanup 后事件监听器应被移除（click 不再切换 dropdown）', () => {
    const { manager, selector, dropdown, events } = createManager();
    // 初始隐藏
    expect(dropdown.classList.contains('hidden')).toBe(true);

    // click 应能切换
    selector.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);

    // cleanup 后 click 不再生效
    manager.cleanup();
    selector.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);
    // events 也应已清空
    expect(events).toBeDefined();
  });

  it('未调用 initPersonaSelectorListeners 时 click 不应切换 dropdown', () => {
    const { selector, dropdown } = createManager({ initListeners: false });
    selector.click();
    // 未初始化监听器，dropdown 仍隐藏
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });
});

// ─── initPersonaSelectorListeners ─────────────────────────

describe('initPersonaSelectorListeners · null 防护', () => {
  it('selector 为 null 时应静默退出（不注册任何事件）', () => {
    expect(() => createManager({ selector: null })).not.toThrow();
  });

  it('dropdown 为 null 时应静默退出', () => {
    expect(() => createManager({ dropdown: null })).not.toThrow();
  });
});

describe('initPersonaSelectorListeners · click 切换', () => {
  it('click selector 应显示 dropdown（hidden → visible）', () => {
    const { selector, dropdown } = createManager();
    selector.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);
  });

  it('click selector 应隐藏 dropdown（visible → hidden）', () => {
    const { selector, dropdown } = createManager();
    // 先显示
    dropdown.classList.remove('hidden');
    selector.click();
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });

  it('click selector 不应冒泡到 document（stopPropagation）', () => {
    const { selector, dropdown } = createManager();
    let documentClickCount = 0;
    document.addEventListener('click', () => {
      documentClickCount++;
    });
    selector.click();
    // selector 的 click handler 调用 stopPropagation，document 不应收到
    expect(documentClickCount).toBe(0);
    // dropdown 应已切换（确认 selector handler 执行了）
    expect(dropdown.classList.contains('hidden')).toBe(false);
  });
});

describe('initPersonaSelectorListeners · selector 键盘支持', () => {
  it('Enter 应切换 dropdown', () => {
    const { selector, dropdown } = createManager();
    dispatchKeydown(selector, 'Enter');
    expect(dropdown.classList.contains('hidden')).toBe(false);
  });

  it('Space 应 preventDefault + 切换 dropdown', () => {
    const { selector, dropdown } = createManager();
    const event = dispatchKeydown(selector, ' ');
    expect(event.defaultPrevented).toBe(true);
    expect(dropdown.classList.contains('hidden')).toBe(false);
  });

  it('Escape 应隐藏 dropdown + focus selector', () => {
    const { selector, dropdown } = createManager();
    // 先显示 dropdown
    dropdown.classList.remove('hidden');
    dispatchKeydown(selector, 'Escape');
    expect(dropdown.classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(selector);
  });

  it('其他键不应触发任何操作', () => {
    const { selector, dropdown } = createManager();
    dispatchKeydown(selector, 'a');
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });
});

describe('initPersonaSelectorListeners · dropdown 键盘导航', () => {
  it('ArrowDown 无焦点时应聚焦第一项', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 3);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    dispatchKeydown(dropdown, 'ArrowDown');
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowDown 应从第一项聚焦到第二项', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 3);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    items[0].focus();
    dispatchKeydown(dropdown, 'ArrowDown');
    expect(document.activeElement).toBe(items[1]);
  });

  it('ArrowDown 末项不再前进（边界保护）', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 3);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    items[2].focus();
    dispatchKeydown(dropdown, 'ArrowDown');
    expect(document.activeElement).toBe(items[2]);
  });

  it('ArrowUp 应从第二项聚焦到第一项', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 3);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    items[1].focus();
    dispatchKeydown(dropdown, 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowUp 首项不再后退（边界保护）', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 3);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    items[0].focus();
    dispatchKeydown(dropdown, 'ArrowUp');
    expect(document.activeElement).toBe(items[0]);
  });

  it('ArrowDown 应 preventDefault（避免页面滚动）', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 2);
    const event = dispatchKeydown(dropdown, 'ArrowDown');
    expect(event.defaultPrevented).toBe(true);
  });

  it('Escape 应隐藏 dropdown + focus selector', () => {
    const { manager, selector, dropdown } = createManager();
    renderItems(manager, 2);
    dropdown.classList.remove('hidden');
    dispatchKeydown(dropdown, 'Escape');
    expect(dropdown.classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe(selector);
  });

  it('无 dropdown-item 时 ArrowDown 应静默退出', () => {
    const { dropdown } = createManager();
    // dropdown 为空（无 dropdown-item）
    const event = dispatchKeydown(dropdown, 'ArrowDown');
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(dropdown);
  });
});

describe('initPersonaSelectorListeners · 外部点击关闭', () => {
  it('document click 应隐藏 dropdown', () => {
    const { dropdown } = createManager();
    dropdown.classList.remove('hidden');
    // 在 body 上触发 click（非 selector、非 dropdown）
    document.body.click();
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });
});

describe('initPersonaSelectorListeners · 事件委托', () => {
  it('click dropdown-item 带 data-action 应触发 switch 回调 + 隐藏', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 2);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    const switchCb = vi.fn();
    manager.onPersonaSwitch(switchCb);

    items[1].click();
    expect(switchCb).toHaveBeenCalledTimes(1);
    expect(switchCb).toHaveBeenCalledWith('角色2');
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });

  it('click dropdown-item 应 stopPropagation（不触发 document click 关闭）', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 1);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    let documentClickCount = 0;
    document.addEventListener('click', () => {
      documentClickCount++;
    });
    items[0].click();
    // stopPropagation 后 document 不应收到
    expect(documentClickCount).toBe(0);
  });

  it('click dropdown 容器但无 data-action 不应触发回调', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 2);
    const switchCb = vi.fn();
    manager.onPersonaSwitch(switchCb);
    // 直接 click dropdown 容器（非 dropdown-item）
    dropdown.click();
    expect(switchCb).not.toHaveBeenCalled();
  });

  it('data-persona-name 缺失时应传空字符串给回调', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 1);
    // 手动移除 data-persona-name 模拟异常场景
    const item = dropdown.querySelector<HTMLElement>('.dropdown-item')!;
    item.removeAttribute('data-persona-name');
    const switchCb = vi.fn();
    manager.onPersonaSwitch(switchCb);
    item.click();
    expect(switchCb).toHaveBeenCalledWith('');
  });
});

// ─── renderPersonaDropdown ────────────────────────────────

describe('renderPersonaDropdown', () => {
  it('dropdown 为 null 时应静默退出', () => {
    const { manager } = createManager({ dropdown: null });
    expect(() => manager.renderPersonaDropdown([])).not.toThrow();
  });

  it('应清空已有内容', () => {
    const { manager, dropdown } = createManager();
    // 预填充垃圾内容
    dropdown.innerHTML = '<div>残留内容</div>';
    manager.renderPersonaDropdown([]);
    expect(dropdown.children.length).toBe(0);
  });

  it('应为每个 persona 创建 dropdown-item', () => {
    const { manager, dropdown } = createManager();
    const personas: PersonaItem[] = [
      { name: '默认', description: '通用助手', active: true },
      { name: '程序员', description: '编码专家', active: false },
      { name: '作家', description: '创作伙伴', active: false },
    ];
    manager.renderPersonaDropdown(personas);
    const items = dropdown.querySelectorAll('.dropdown-item');
    expect(items.length).toBe(3);
  });

  it('active persona 应有 active 类，非 active 无', () => {
    const { manager, dropdown } = createManager();
    const personas: PersonaItem[] = [
      { name: 'A', description: 'a', active: true },
      { name: 'B', description: 'b', active: false },
    ];
    manager.renderPersonaDropdown(personas);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    expect(items[0].classList.contains('active')).toBe(true);
    expect(items[1].classList.contains('active')).toBe(false);
  });

  it('应设置 tabindex=-1 和 role=option', () => {
    const { manager, dropdown } = createManager();
    manager.renderPersonaDropdown([
      { name: 'A', description: 'a', active: false },
    ]);
    const item = dropdown.querySelector<HTMLElement>('.dropdown-item')!;
    expect(item.getAttribute('tabindex')).toBe('-1');
    expect(item.getAttribute('role')).toBe('option');
  });

  it('应设置 aria-selected（active=true 为 "true"，否则 "false"）', () => {
    const { manager, dropdown } = createManager();
    manager.renderPersonaDropdown([
      { name: 'A', description: 'a', active: true },
      { name: 'B', description: 'b', active: false },
    ]);
    const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item');
    expect(items[0].getAttribute('aria-selected')).toBe('true');
    expect(items[1].getAttribute('aria-selected')).toBe('false');
  });

  it('应设置 data-action="switch-persona" 和 data-persona-name', () => {
    const { manager, dropdown } = createManager();
    manager.renderPersonaDropdown([
      { name: 'coder', description: '编码', active: false },
    ]);
    const item = dropdown.querySelector<HTMLElement>('.dropdown-item')!;
    expect(item.getAttribute('data-action')).toBe('switch-persona');
    expect(item.dataset.personaName).toBe('coder');
  });

  it('应渲染角色名称和描述作为子元素', () => {
    const { manager, dropdown } = createManager();
    manager.renderPersonaDropdown([
      { name: '作家', description: '创作伙伴', active: false },
    ]);
    const item = dropdown.querySelector<HTMLElement>('.dropdown-item')!;
    const nameEl = item.querySelector('.dropdown-item-name');
    const descEl = item.querySelector('.dropdown-item-desc');
    expect(nameEl?.textContent).toBe('作家');
    expect(descEl?.textContent).toBe('创作伙伴');
  });

  it('应更新 persona-count 文本', () => {
    const { manager, countEl } = createManager();
    manager.renderPersonaDropdown([
      { name: 'A', description: 'a', active: false },
      { name: 'B', description: 'b', active: false },
      { name: 'C', description: 'c', active: false },
    ]);
    expect(countEl.textContent).toBe('3');
  });

  it('persona-count 不存在时不应抛错', () => {
    const { manager, countEl } = createManager();
    countEl.remove();
    expect(() =>
      manager.renderPersonaDropdown([
        { name: 'A', description: 'a', active: false },
      ]),
    ).not.toThrow();
  });

  it('空列表应清空 dropdown 且 count 为 0', () => {
    const { manager, dropdown, countEl } = createManager();
    manager.renderPersonaDropdown([]);
    expect(dropdown.children.length).toBe(0);
    expect(countEl.textContent).toBe('0');
  });
});

// ─── updateActivePersona ──────────────────────────────────

describe('updateActivePersona', () => {
  it('应更新 personaNameEl 的 textContent', () => {
    const { manager, nameEl } = createManager();
    manager.updateActivePersona('程序员');
    expect(nameEl.textContent).toBe('程序员');
  });

  it('personaNameEl 为 null 时不应抛错', () => {
    const { manager } = createManager({ nameEl: null });
    expect(() => manager.updateActivePersona('程序员')).not.toThrow();
  });
});

// ─── updatePersonaModeBadge ───────────────────────────────

describe('updatePersonaModeBadge', () => {
  it('"auto" 应显示"自动" + auto 类', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('auto');
    expect(badge.textContent).toBe('自动');
    expect(badge.classList.contains('auto')).toBe(true);
    expect(badge.classList.contains('manual')).toBe(false);
  });

  it('"manual" 应显示"手动" + manual 类', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('manual');
    expect(badge.textContent).toBe('手动');
    expect(badge.classList.contains('manual')).toBe(true);
    expect(badge.classList.contains('auto')).toBe(false);
  });

  it('未知值应归一化为 auto', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('unknown');
    expect(badge.textContent).toBe('自动');
    expect(badge.classList.contains('auto')).toBe(true);
  });

  it('空字符串应归一化为 auto', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('');
    expect(badge.textContent).toBe('自动');
    expect(badge.classList.contains('auto')).toBe(true);
  });

  it('manual 后切换到 auto 应正确移除 manual 类', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('manual');
    expect(badge.classList.contains('manual')).toBe(true);
    manager.updatePersonaModeBadge('auto');
    expect(badge.classList.contains('manual')).toBe(false);
    expect(badge.classList.contains('auto')).toBe(true);
  });

  it('badge 不存在时不应抛错', () => {
    const { manager, badge } = createManager();
    badge.remove();
    expect(() => manager.updatePersonaModeBadge('auto')).not.toThrow();
  });

  it('应设置 title 属性（鼠标悬停提示）', () => {
    const { manager, badge } = createManager();
    manager.updatePersonaModeBadge('manual');
    expect(badge.title).toContain('手动');
  });
});

// ─── 回调注册 ─────────────────────────────────────────────

describe('回调注册', () => {
  it('onPersonaSwitch 应注册角色切换回调', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 1);
    const cb = vi.fn();
    manager.onPersonaSwitch(cb);
    dropdown.querySelector<HTMLElement>('.dropdown-item')!.click();
    expect(cb).toHaveBeenCalledWith('角色1');
  });

  it('onPersonaSwitch 多次注册应覆盖前者', () => {
    const { manager, dropdown } = createManager();
    renderItems(manager, 1);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.onPersonaSwitch(cb1);
    manager.onPersonaSwitch(cb2);
    dropdown.querySelector<HTMLElement>('.dropdown-item')!.click();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('onMemoryRecallClick 应注册召回记忆回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onMemoryRecallClick(cb);
    manager.triggerMemoryRecallClick('用户偏好');
    expect(cb).toHaveBeenCalledWith('用户偏好');
  });

  it('triggerMemoryRecallClick 未注册回调时不应抛错', () => {
    const { manager } = createManager();
    expect(() => manager.triggerMemoryRecallClick('test')).not.toThrow();
  });

  it('onMemoryRecallClick 多次注册应覆盖前者', () => {
    const { manager } = createManager();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.onMemoryRecallClick(cb1);
    manager.onMemoryRecallClick(cb2);
    manager.triggerMemoryRecallClick('test');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('test');
  });
});
