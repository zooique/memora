/**
 * 角色选择器面板管理器 — 角色选择器 UI 逻辑独立子模块
 *
 * 职责：
 * - 管理角色选择器 DOM 元素引用
 * - 初始化角色选择器事件监听（点击、键盘导航、下拉菜单）
 * - 渲染角色下拉菜单列表
 * - 更新当前角色名称和角色匹配模式标签
 * - 管理角色切换和召回记忆点击回调
 *
 * 设计原则：
 * - 遵循 SettingsPanelManager / ProfilePanelManager 的组合模式，UIManager 持有实例并委托
 * - 自管理事件监听器，提供 cleanup() 清理
 * - DOM 元素由构造函数注入，不自行查找
 *
 * 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 220 行。
 */

import { clearElement } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import type { PersonaItem } from '../types.js';

// ─── 角色选择器面板管理器类 ──────────────────────────────

export class PersonaPanelManager {
  // ─── 角色选择器 DOM 元素 ────────────────────────────────
  /** 角色选择器触发区域（点击展开下拉菜单） */
  private personaSelectorEl: HTMLElement | null;
  /** 角色下拉菜单容器 */
  private personaDropdownEl: HTMLElement | null;
  /** 当前角色名称显示元素 */
  private personaNameEl: HTMLElement | null;

  // ─── 回调 ────────────────────────────────────────────────
  /** 角色切换回调：点击下拉菜单项时触发，传递角色名称 */
  private personaSwitchCallback: ((name: string) => void) | null = null;
  /** 召回记忆点击回调：点击精灵消息内的召回标签时触发，跳转到记忆详情 */
  private memoryRecallClickCallback: ((memoryName: string) => void) | null = null;

  // ─── 事件清理 ────────────────────────────────────────────
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events: EventTracker;

  /**
   * @param personaSelectorEl 角色选择器触发区域 DOM 元素
   * @param personaDropdownEl 角色下拉菜单容器 DOM 元素
   * @param personaNameEl 当前角色名称显示 DOM 元素
   * @param events 事件跟踪器实例（用于统一管理事件监听器生命周期）
   */
  constructor(
    personaSelectorEl: HTMLElement | null,
    personaDropdownEl: HTMLElement | null,
    personaNameEl: HTMLElement | null,
    events: EventTracker,
  ) {
    this.personaSelectorEl = personaSelectorEl;
    this.personaDropdownEl = personaDropdownEl;
    this.personaNameEl = personaNameEl;
    this.events = events;
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.events.cleanup();
  }

  // ─── 初始化 ─────────────────────────────────────────────

  /** 初始化角色选择器事件监听 */
  initPersonaSelectorListeners(): void {
    if (!this.personaSelectorEl || !this.personaDropdownEl) return;
    // 提取局部常量，避免闭包内控制流分析断裂导致的非空断言
    const selectorEl = this.personaSelectorEl;
    const dropdownEl = this.personaDropdownEl;

    // 点击选择器切换下拉菜单
    this.events.addEventListener(selectorEl, 'click', (e) => {
      e.stopPropagation();
      this.togglePersonaDropdown();
    });

    // UI-AR-01 键盘支持：Enter/Space 展开下拉，Escape 关闭
    this.events.addEventListener(selectorEl, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' || ke.key === ' ') {
        ke.preventDefault();
        this.togglePersonaDropdown();
      } else if (ke.key === 'Escape') {
        this.closePersonaDropdown();
        selectorEl.focus();
      }
    });

    // UI-AR-01 键盘导航：在下拉菜单内用方向键移动焦点
    this.events.addEventListener(dropdownEl, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      const items = dropdownEl.querySelectorAll<HTMLElement>('.dropdown-item');
      if (items.length === 0) return;

      const currentIdx = Array.from(items).findIndex(
        (item) => item === document.activeElement,
      );

      if (ke.key === 'ArrowDown') {
        ke.preventDefault();
        const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
        const nextItem = items[nextIdx];
        if (nextItem) nextItem.focus();
      } else if (ke.key === 'ArrowUp') {
        ke.preventDefault();
        const prevIdx = currentIdx < 0 ? items.length - 1 : Math.max(currentIdx - 1, 0);
        const prevItem = items[prevIdx];
        if (prevItem) prevItem.focus();
      } else if (ke.key === 'Escape') {
        this.closePersonaDropdown();
        selectorEl.focus();
      }
    });

    // 点击页面其他区域关闭下拉菜单（走统一清理机制）
    this.events.addEventListener(document, 'click', () => {
      this.closePersonaDropdown();
    });

    // QC-22 角色下拉菜单事件委托：在 dropdown 容器上注册统一 click 监听器，
    // 通过 data-action="switch-persona" + data-persona-name 分发，
    // 替代动态列表项各自的 addEventListener，统一纳入 EventTracker 管理
    this.events.addEventListener(this.personaDropdownEl, 'click', (e: Event) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>('[data-action="switch-persona"]');
      if (item) {
        e.stopPropagation();
        const personaName = item.dataset.personaName ?? '';
        this.personaSwitchCallback?.(personaName);
        this.closePersonaDropdown();
      }
    });
  }

  // ─── 私有辅助方法 ───────────────────────────────────────

  /** 关闭角色下拉菜单（统一管理 aria-expanded 状态） */
  private closePersonaDropdown(): void {
    if (!this.personaDropdownEl || !this.personaSelectorEl) return;
    this.personaDropdownEl.classList.add('hidden');
    this.personaSelectorEl.setAttribute('aria-expanded', 'false');
  }

  /** UI-AR-01 切换角色下拉菜单的显示/隐藏 */
  private togglePersonaDropdown(): void {
    if (!this.personaDropdownEl || !this.personaSelectorEl) return;
    const isHidden = this.personaDropdownEl.classList.contains('hidden');
    this.personaDropdownEl.classList.toggle('hidden');
    this.personaSelectorEl.setAttribute('aria-expanded', isHidden ? 'true' : 'false');

    // 展开时聚焦第一个选项，方便键盘导航
    if (isHidden) {
      const firstItem = this.personaDropdownEl.querySelector<HTMLElement>('.dropdown-item');
      if (firstItem) {
        // 给 DOM 渲染时间，确保元素可见后再聚焦
        requestAnimationFrame(() => firstItem.focus());
      }
    }
  }

  // ─── 公共 API ───────────────────────────────────────────

  /** 渲染角色下拉菜单 */
  renderPersonaDropdown(personas: PersonaItem[]): void {
    if (!this.personaDropdownEl) return;

    // 捕获局部引用，避免闭包中的 null 检查问题
    const dropdown = this.personaDropdownEl;

    // 安全清空容器（与 renderMemoryList 保持一致，使用 clearElement 封装）
    clearElement(dropdown);

    for (const p of personas) {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (p.active ? ' active' : '');
      // UX-04：角色名称作为主标题，描述作为副标题直接可见
      const nameEl = document.createElement('div');
      nameEl.className = 'dropdown-item-name';
      nameEl.textContent = p.name;
      const descEl = document.createElement('div');
      descEl.className = 'dropdown-item-desc';
      descEl.textContent = p.description;
      item.appendChild(nameEl);
      item.appendChild(descEl);
      item.title = p.description;
      // UI-AR-01 可聚焦但不参与 Tab 顺序（键盘导航用方向键）
      item.setAttribute('tabindex', '-1');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', p.active ? 'true' : 'false');
      // QC-22 事件委托：用 data-action + data-persona-name 替代直接 addEventListener
      item.setAttribute('data-action', 'switch-persona');
      item.setAttribute('data-persona-name', p.name);

      dropdown.appendChild(item);
    }

    // 更新角色计数
    const countEl = document.getElementById('persona-count');
    if (countEl) {
      countEl.textContent = String(personas.length);
    }
  }

  /** 更新当前角色显示 */
  updateActivePersona(name: string): void {
    if (this.personaNameEl) {
      this.personaNameEl.textContent = name;
    }
  }

  /**
   * IX-07 更新角色匹配模式标签
   *
   * 在角色选择器旁显示当前模式（auto/manual），
   * 对齐 CLI /mode 查询能力，让 UI 用户也能一眼看到当前模式。
   *
   * @param mode 模式值：'auto' | 'manual'（其他值回退为 'auto'）
   */
  updatePersonaModeBadge(mode: string): void {
    const badge = document.getElementById('persona-mode-badge');
    if (!badge) return;

    const normalizedMode = mode === 'manual' ? 'manual' : 'auto';
    const label = normalizedMode === 'auto' ? '自动' : '手动';
    const title = normalizedMode === 'auto'
      ? '角色匹配模式：自动（根据上下文自动切换角色）'
      : '角色匹配模式：手动（仅手动切换角色，不自动匹配）';

    badge.textContent = label;
    badge.title = title;
    badge.classList.remove('auto', 'manual');
    badge.classList.add(normalizedMode);
  }

  // ─── 回调注册 ───────────────────────────────────────────

  /** 注册角色切换回调 */
  onPersonaSwitch(cb: (name: string) => void): void {
    this.personaSwitchCallback = cb;
  }

  /** 注册召回记忆点击回调 */
  onMemoryRecallClick(cb: (memoryName: string) => void): void {
    this.memoryRecallClickCallback = cb;
  }

  /** 触发召回记忆点击回调（供外部调用，如点击召回记忆标签时跳转记忆详情） */
  triggerMemoryRecallClick(memoryName: string): void {
    this.memoryRecallClickCallback?.(memoryName);
  }
}