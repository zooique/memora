/**
 * 感知面板默契度组件
 *
 * 职责（封装 perceptionPanelManager 中 updateRapportDisplay 的 DOM 操作）：
 * - 渲染等级徽章（perception-rapport-badge）
 * - 渲染信任度进度条（perception-trust-fill）
 * - 渲染熟悉度进度条（perception-familiarity-fill）
 * - 渲染描述文本（perception-rapport-desc）
 */

import { Component } from '../base/component.js';
import { getRapportLevelLabel, getAffectColor } from '../../helpers/perceptionLabels.js';
import type { RapportPayload } from '../../ipcListeners.js';

// ─── 组件 ────────────────────────────────────────────────

/**
 * 感知面板默契度组件
 *
 * 由 PerceptionPanelManager 持有实例，替代原有 ~4 处 document.getElementById。
 */
export class PerceptionRapportComponent extends Component<Record<string, unknown>> {
  private badgeEl: HTMLElement | null = null;
  private trustFillEl: HTMLElement | null = null;
  private familiarityFillEl: HTMLElement | null = null;
  private descEl: HTMLElement | null = null;

  constructor() {
    super({});
  }

  /**
   * 挂载——查询并缓存默契度 DOM 元素
   */
  mount(_container: HTMLElement | string): this {
    this.badgeEl = document.getElementById('perception-rapport-badge');
    this.trustFillEl = document.getElementById('perception-trust-fill');
    this.familiarityFillEl = document.getElementById('perception-familiarity-fill');
    this.descEl = document.getElementById('perception-rapport-desc');
    this.el = document.getElementById('perception-rapport-section');
    return this;
  }

  /**
   * 增量更新——渲染默契度数据
   *
   * @param newOptions 默契度数据
   */
  update(newOptions: Partial<RapportPayload>): this {
    if (!this.el) return this;
    this.renderRapport(newOptions as RapportPayload);
    return this;
  }

  /**
   * 销毁——nullify 引用
   */
  destroy(): void {
    this.badgeEl = null;
    this.trustFillEl = null;
    this.familiarityFillEl = null;
    this.descEl = null;
    super.destroy();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  /**
   * 渲染默契度数据
   *
   * @param rapport 默契度数据
   */
  private renderRapport(rapport: RapportPayload): void {
    // 等级徽章
    if (this.badgeEl) {
      this.badgeEl.textContent = getRapportLevelLabel(rapport.level);
      this.badgeEl.setAttribute('data-level', rapport.level);
    }

    // 信任度进度条
    if (this.trustFillEl) {
      const trustPercent = Math.round(rapport.trust * 100);
      this.trustFillEl.style.width = `${Math.max(6, trustPercent)}%`;
      this.trustFillEl.style.background = getAffectColor(rapport.trust);
      this.trustFillEl.title = `信任度 ${trustPercent}%`;
    }

    // 熟悉度进度条
    if (this.familiarityFillEl) {
      const familiarityPercent = Math.round(rapport.familiarity * 100);
      this.familiarityFillEl.style.width = `${Math.max(6, familiarityPercent)}%`;
      this.familiarityFillEl.style.background = getAffectColor(rapport.familiarity);
      this.familiarityFillEl.title = `熟悉度 ${familiarityPercent}%`;
    }

    // 描述文本
    if (this.descEl) {
      this.descEl.textContent = rapport.description;
    }
  }
}