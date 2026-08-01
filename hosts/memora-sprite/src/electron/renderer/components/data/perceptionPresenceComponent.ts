/**
 * 感知面板在场状态组件
 *
 * 职责（封装 perceptionPanelManager 中 updatePresenceDisplay 的 DOM 操作）：
 * - 渲染在场/离开状态指示器（presence-dot）
 * - 渲染状态文本（perception-presence-text）
 * - 离开时长格式化（分钟/小时）
 */

import { Component } from '../base/component.js';
import type { PresencePayload } from '../../ipcListeners.js';

// ─── 组件 ────────────────────────────────────────────────

/**
 * 感知面板在场状态组件
 *
 * 由 PerceptionPanelManager 持有实例，替代原有 ~2 处 document.getElementById。
 */
export class PerceptionPresenceComponent extends Component<PresencePayload> {
  private dotEl: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;

  constructor() {
    super({} as PresencePayload);
  }

  /**
   * 挂载——查询并缓存在场状态 DOM 元素
   */
  mount(_container: HTMLElement | string): this {
    this.dotEl = document.getElementById('perception-presence-dot');
    this.textEl = document.getElementById('perception-presence-text');
    this.el = document.getElementById('perception-presence-section');
    return this;
  }

  /**
   * 增量更新——渲染在场状态数据
   *
   * @param newOptions 在场状态事件载荷
   */
  update(newOptions: Partial<PresencePayload>): this {
    if (!this.el) return this;
    this.renderPresence(newOptions as PresencePayload);
    return this;
  }

  /**
   * 销毁——nullify 引用
   */
  destroy(): void {
    this.dotEl = null;
    this.textEl = null;
    super.destroy();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  /**
   * 渲染在场状态
   *
   * @param payload 在场状态数据
   */
  private renderPresence(payload: PresencePayload): void {
    if (!this.dotEl || !this.textEl) return;

    if (payload.state === 'present') {
      this.dotEl.className = 'presence-dot present flex-shrink-0';
      this.textEl.textContent = '用户在场';
    } else {
      this.dotEl.className = 'presence-dot away flex-shrink-0';
      const awayDurationMs = payload.awayDurationMs ?? 0;
      const awayMinutes = Math.floor(awayDurationMs / 60000);
      if (awayMinutes < 1) {
        this.textEl.textContent = '用户刚离开';
      } else if (awayMinutes < 60) {
        this.textEl.textContent = `用户已离开 ${awayMinutes} 分钟`;
      } else {
        const awayHours = Math.floor(awayMinutes / 60);
        this.textEl.textContent = `用户已离开 ${awayHours} 小时`;
      }
    }
  }
}