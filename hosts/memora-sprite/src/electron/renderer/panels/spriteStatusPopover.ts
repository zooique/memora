/**
 * 精灵状态浮层组件 — 精灵状态条 hover 时弹出轻量感知摘要
 *
 * 职责：
 * - 管理 popover DOM 元素的显示/隐藏
 * - 缓存感知数据（affect/rapport/context），合成摘要文字
 * - 通过 hover 事件绑定到 #sprite-status-bar
 *
 * 设计原则：
 * - 轻量：不展示完整感知数据，仅 3 行摘要（默契度/情感基调/对话节奏）
 * - 懒更新：仅在数据到达时更新 DOM，不主动轮询
 * - 点击精灵状态条进入仪表盘查看完整感知数据（已有行为）
 *
 * 数据来源：与 PerceptionPanelManager 共享同一 IPC 事件流，
 * 由 ipcListeners 中的感知事件处理器同时更新 popover 和感知面板。
 */
import type { AffectPayload, RapportPayload, ContextPayload } from '../ipcListeners.js';
// 感知标签映射 + 阈值常量（统一真理源）
import { getRapportLevelLabel, describeRhythm, describeCoherence, AFFECT_TONE_THRESHOLD } from '../helpers/perceptionLabels.js';

/**
 * 精灵状态浮层
 *
 * 管理 #sprite-status-popover 的显示/隐藏和数据更新。
 * 由 UIManager 持有实例，在 IPC 感知事件到达时调用 update* 方法。
 */
export class SpriteStatusPopover {
  /** popover 容器 DOM 元素（HTML 模板未加载时为 null） */
  private popoverEl: HTMLElement | null;
  /** 状态条 DOM 元素（hover 触发源，HTML 模板未加载时为 null） */
  private statusBarEl: HTMLElement | null;

  /** 缓存的默契度数据（用于摘要合成） */
  private rapport: RapportPayload | null = null;
  /** 缓存的情感基调数据（用于摘要合成） */
  private affect: AffectPayload | null = null;
  /** 缓存的对话上下文数据（用于摘要合成） */
  private context: ContextPayload | null = null;

  /** hover 进入延迟定时器（防止误触快速划过） */
  private hoverTimer: number | null = null;
  /** hover 离开延迟定时器（给用户时间移入 popover） */
  private leaveTimer: number | null = null;

  /** hover 延迟（毫秒），避免鼠标快速划过时闪烁 */
  private static readonly HOVER_DELAY_MS = 200;

  constructor() {
    // 获取 DOM 元素（HTML 模板在页面加载时已存在）
    this.popoverEl = document.getElementById('sprite-status-popover');
    this.statusBarEl = document.getElementById('sprite-status-bar');

    // 绑定 hover 事件到状态条（鼠标用户）
    if (this.statusBarEl) {
      this.statusBarEl.addEventListener('mouseenter', this.handleStatusBarEnter);
      this.statusBarEl.addEventListener('mouseleave', this.handleStatusBarLeave);
      // 绑定 focus/blur 事件到状态条（键盘用户，tabindex="0" 使状态条可聚焦）
      // 键盘焦点是明确意图，无需 hover 的防闪烁延迟，立即显示/隐藏
      this.statusBarEl.addEventListener('focus', this.handleStatusBarFocus);
      this.statusBarEl.addEventListener('blur', this.handleStatusBarBlur);
    }

    // 绑定 hover 事件到 popover 自身（允许用户从状态条移入 popover）
    if (this.popoverEl) {
      this.popoverEl.addEventListener('mouseenter', this.handlePopoverEnter);
      this.popoverEl.addEventListener('mouseleave', this.handlePopoverLeave);
    }
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理事件监听器和定时器（页面卸载时调用） */
  cleanup(): void {
    if (this.statusBarEl) {
      this.statusBarEl.removeEventListener('mouseenter', this.handleStatusBarEnter);
      this.statusBarEl.removeEventListener('mouseleave', this.handleStatusBarLeave);
      this.statusBarEl.removeEventListener('focus', this.handleStatusBarFocus);
      this.statusBarEl.removeEventListener('blur', this.handleStatusBarBlur);
    }
    if (this.popoverEl) {
      this.popoverEl.removeEventListener('mouseenter', this.handlePopoverEnter);
      this.popoverEl.removeEventListener('mouseleave', this.handlePopoverLeave);
    }
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    if (this.leaveTimer !== null) window.clearTimeout(this.leaveTimer);
  }

  // ─── 数据更新 ──────────────────────────────────────────

  /** 更新默契度数据并刷新摘要文字 */
  updateRapport(rapport: RapportPayload): void {
    this.rapport = rapport;
    this.refreshPopover();
  }

  /** 更新情感基调数据并刷新摘要文字 */
  updateAffect(affect: AffectPayload): void {
    this.affect = affect;
    this.refreshPopover();
  }

  /** 更新对话上下文数据并刷新摘要文字 */
  updateContext(context: ContextPayload): void {
    this.context = context;
    this.refreshPopover();
  }

  // ─── hover 事件处理（箭头函数保持 this 绑定） ──────────

  /** 状态条 hover 进入：延迟显示 popover */
  private handleStatusBarEnter = (): void => {
    if (this.leaveTimer !== null) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this.hoverTimer = window.setTimeout(() => {
      this.show();
    }, SpriteStatusPopover.HOVER_DELAY_MS);
  };

  /** 状态条 hover 离开：延迟隐藏 popover */
  private handleStatusBarLeave = (): void => {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.leaveTimer = window.setTimeout(() => {
      this.hide();
    }, SpriteStatusPopover.HOVER_DELAY_MS);
  };

  /** popover 自身 hover 进入：取消隐藏定时器 */
  private handlePopoverEnter = (): void => {
    if (this.leaveTimer !== null) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
  };

  /** popover 自身 hover 离开：隐藏 */
  private handlePopoverLeave = (): void => {
    this.hide();
  };

  // ─── focus/blur 事件处理（键盘用户，立即响应无延迟） ───

  /** 状态条获得焦点（键盘 Tab）：立即显示 popover，取消 pending 的 hover 定时器 */
  private handleStatusBarFocus = (): void => {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.leaveTimer !== null) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this.show();
  };

  /** 状态条失去焦点：立即隐藏 popover，取消 pending 的 hover 定时器 */
  private handleStatusBarBlur = (): void => {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.leaveTimer !== null) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = null;
    }
    this.hide();
  };

  // ─── 显示/隐藏 ─────────────────────────────────────────

  /** 显示 popover（移除 hidden 类，同步 aria-hidden 供辅助技术访问） */
  private show(): void {
    if (!this.popoverEl) return;
    this.refreshPopover();
    this.popoverEl.classList.remove('hidden');
    // 视觉可见时同步告知屏幕阅读器内容可访问（WCAG 2.1 SC 4.1.2）
    this.popoverEl.setAttribute('aria-hidden', 'false');
  }

  /** 隐藏 popover（添加 hidden 类，同步 aria-hidden） */
  private hide(): void {
    if (!this.popoverEl) return;
    this.popoverEl.classList.add('hidden');
    this.popoverEl.setAttribute('aria-hidden', 'true');
  }

  // ─── 摘要合成 ──────────────────────────────────────────

  /**
   * 刷新 popover 内的摘要文字（从缓存数据合成）
   *
   * 注意：不要在这里判断 hidden 状态 —— IPC 数据可能在 popover 隐藏时到达，
   * 此时应直接更新 DOM（textContent 对 hidden 元素也有效，show() 时已就绪）。
   * show() 会在移除 hidden 之前再次调用本方法作为双保险。
   */
  private refreshPopover(): void {
    if (!this.popoverEl) return;

    // 默契度摘要
    const rapportEl = this.popoverEl.querySelector('#popover-rapport');
    if (rapportEl && this.rapport) {
      rapportEl.textContent = this.formatRapportSummary(this.rapport);
    }

    // 情感基调摘要
    const affectEl = this.popoverEl.querySelector('#popover-affect');
    if (affectEl && this.affect) {
      affectEl.textContent = this.formatAffectSummary(this.affect);
    }

    // 对话节奏摘要
    const contextEl = this.popoverEl.querySelector('#popover-context');
    if (contextEl && this.context) {
      contextEl.textContent = this.formatContextSummary(this.context);
    }
  }

  // ─── 格式化辅助方法 ────────────────────────────────────

  /**
   * 格式化默契度摘要
   *
   * 格式：等级名称 · 信任 XX% · 熟悉 XX%
   */
  private formatRapportSummary(r: RapportPayload): string {
    const levelLabel = getRapportLevelLabel(r.level);
    const trustPct = Math.round(r.trust * 100);
    const familiarityPct = Math.round(r.familiarity * 100);
    return `${levelLabel} · 信任 ${trustPct}% · 熟悉 ${familiarityPct}%`;
  }

  /**
   * 格式化情感基调摘要
   *
   * 只展示最突出的 1-2 个维度，避免信息过载
   */
  private formatAffectSummary(a: AffectPayload): string {
    const parts: string[] = [];
    // "显著"阈值统一用 AFFECT_TONE_THRESHOLD；0.3 是"低"对立词阈值，语义不同保持独立
    if (a.warmth >= AFFECT_TONE_THRESHOLD) parts.push('温暖');
    else if (a.warmth <= 0.3) parts.push('冷静');
    if (a.directness >= AFFECT_TONE_THRESHOLD) parts.push('直接');
    else if (a.directness <= 0.3) parts.push('委婉');
    if (a.playfulness >= AFFECT_TONE_THRESHOLD) parts.push('活泼');
    if (a.initiative >= AFFECT_TONE_THRESHOLD) parts.push('主动');
    if (parts.length === 0) parts.push('平稳');
    return parts.join(' · ');
  }

  /**
   * 格式化对话上下文摘要
   *
   * 展示节奏 + 连贯性，简洁描述对话状态。
   * 使用 perceptionLabels 统一标签映射，确保全应用文案一致。
   */
  private formatContextSummary(c: ContextPayload): string {
    const rhythmLabel = describeRhythm(c.rhythm);
    const coherenceLabel = describeCoherence(c.coherence);
    return `${rhythmLabel} · ${coherenceLabel}`;
  }
}