/**
 * 感知面板主动提示统计组件
 *
 * 职责（封装 perceptionPanelManager 中 updateProactiveStatsDisplay 的 DOM 操作）：
 * - 显示/隐藏空状态和统计网格
 * - 渲染建议数/接受数/接受率徽章/连续拒绝/生效冷却
 * - 接受率三色徽章（高/中/低）
 * - 冷却时长格式化
 */

import { Component } from '../base/component.js';
import type { ProactiveStats } from '../../../../shared/spriteStats.js';
import { MS_PER_MINUTE } from '../../../../sprite/constants.js';

// ─── 常量 ────────────────────────────────────────────────

/** 接受率等级划分阈值：< 0.4 为低，< 0.7 为中，否则为高 */
const ACCEPTANCE_LOW_THRESHOLD = 0.4;
const ACCEPTANCE_MID_THRESHOLD = 0.7;

// ─── 组件 ────────────────────────────────────────────────

/**
 * 感知面板主动提示统计组件
 *
 * 由 PerceptionPanelManager 持有实例，替代原有 ~7 处 document.getElementById。
 */
export class PerceptionProactiveComponent extends Component<ProactiveStats> {
  private gridEl: HTMLElement | null = null;
  private emptyEl: HTMLElement | null = null;
  private suggestEl: HTMLElement | null = null;
  private acceptEl: HTMLElement | null = null;
  private rateEl: HTMLElement | null = null;
  private rejectsEl: HTMLElement | null = null;
  private cooldownEl: HTMLElement | null = null;

  constructor() {
    super({} as ProactiveStats);
  }

  /**
   * 挂载——查询并缓存主动提示统计 DOM 元素
   */
  mount(_container: HTMLElement | string): this {
    this.gridEl = document.getElementById('perception-proactive-grid');
    this.emptyEl = document.getElementById('perception-proactive-empty');
    this.suggestEl = document.getElementById('perception-proactive-suggest');
    this.acceptEl = document.getElementById('perception-proactive-accept');
    this.rateEl = document.getElementById('perception-proactive-rate');
    this.rejectsEl = document.getElementById('perception-proactive-rejects');
    this.cooldownEl = document.getElementById('perception-proactive-cooldown');
    this.el = document.getElementById('perception-proactive-section');
    return this;
  }

  /**
   * 增量更新——渲染主动提示统计数据
   *
   * @param newOptions 主动提示统计快照（null 时静默跳过）
   */
  update(newOptions: Partial<ProactiveStats> | null): this {
    if (!this.el) return this;
    if (newOptions) {
      this.renderStats(newOptions as ProactiveStats);
    }
    return this;
  }

  /**
   * 销毁——nullify 引用
   */
  destroy(): void {
    this.gridEl = null;
    this.emptyEl = null;
    this.suggestEl = null;
    this.acceptEl = null;
    this.rateEl = null;
    this.rejectsEl = null;
    this.cooldownEl = null;
    super.destroy();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  /**
   * 渲染主动提示统计数据
   *
   * @param stats 主动提示统计快照
   */
  private renderStats(stats: ProactiveStats): void {
    // 空状态：suggestCount=0 时显示友好提示
    if (stats.suggestCount === 0) {
      if (this.gridEl) this.gridEl.classList.add('hidden');
      if (this.emptyEl) this.emptyEl.classList.remove('hidden');
      return;
    }

    // 有数据时显示网格，隐藏空状态
    if (this.gridEl) this.gridEl.classList.remove('hidden');
    if (this.emptyEl) this.emptyEl.classList.add('hidden');

    // 建议数 / 接受数
    if (this.suggestEl) this.suggestEl.textContent = String(stats.suggestCount);
    if (this.acceptEl) this.acceptEl.textContent = String(stats.acceptCount);

    // 接受率徽章
    if (this.rateEl) {
      this.rateEl.textContent = `${Math.round(stats.acceptanceRate * 100)}%`;
      this.rateEl.classList.remove('high', 'mid', 'low');
      if (stats.acceptanceRate >= ACCEPTANCE_MID_THRESHOLD) {
        this.rateEl.classList.add('high');
      } else if (stats.acceptanceRate >= ACCEPTANCE_LOW_THRESHOLD) {
        this.rateEl.classList.add('mid');
      } else {
        this.rateEl.classList.add('low');
      }
      this.rateEl.title = `接受率 ${Math.round(stats.acceptanceRate * 100)}%（${stats.acceptCount}/${stats.suggestCount}）`;
    }

    // 连续拒绝数
    if (this.rejectsEl) {
      this.rejectsEl.textContent = String(stats.consecutiveRejects);
      this.rejectsEl.classList.toggle('warning', stats.consecutiveRejects > 0);
      this.rejectsEl.title = stats.consecutiveRejects > 0
        ? `连续拒绝 ${stats.consecutiveRejects} 次，冷却延长 ${Math.round((1 + stats.consecutiveRejects * 0.5) * 100)}%`
        : '无连续拒绝（冷却正常）';
    }

    // 生效冷却时长
    if (this.cooldownEl) {
      this.cooldownEl.textContent = this.formatCooldownMinutes(stats.effectiveCooldownMs);
      this.cooldownEl.classList.toggle('warning', stats.effectiveCooldownMs > stats.baseCooldownMs);
      this.cooldownEl.title = `基础 ${this.formatCooldownMinutes(stats.baseCooldownMs)} → 生效 ${this.formatCooldownMinutes(stats.effectiveCooldownMs)}`;
    }
  }

  /**
   * 将毫秒冷却时长格式化为人类可读的分钟/小时字符串
   *
   * @param ms 冷却毫秒数
   * @returns 格式化后的字符串（如 "30 分钟" / "1.5 小时"）
   */
  private formatCooldownMinutes(ms: number): string {
    if (ms < MS_PER_MINUTE) return '< 1 分钟';
    const minutes = Math.round(ms / MS_PER_MINUTE);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours} 小时`;
  }
}