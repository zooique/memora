/**
 * 感知面板情感基调组件
 *
 * 职责（封装 perceptionPanelManager 中 updateAffectDisplay 的 DOM 操作）：
 * - 渲染四维情感进度条（温暖/直接/主动/活泼）+ 等级标签
 * - 渲染情感雷达图（SVG 多边形 + 顶点圆点）
 *
 * 与现有 HTML 模板的关系：
 * - 情感基调 DOM 元素已存在于 index.html 模板中（perception-* 前缀）
 * - mount() 时查询并缓存元素引用，destroy() 仅 nullify
 */

import { Component } from '../base/component.js';
import { getAffectLevel, getAffectColor } from '../../helpers/perceptionLabels.js';
import type { AffectPayload } from '../../ipcListeners.js';

// ─── 组件 ────────────────────────────────────────────────

/**
 * 感知面板情感基调组件
 *
 * 由 PerceptionPanelManager 持有实例，替代原有 ~11 处 document.getElementById。
 * 挂载到现有 HTML 模板中的 #perception-{dim}-fill 等元素。
 */
export class PerceptionAffectComponent extends Component<Record<string, unknown>> {
  // ─── 缓存的 DOM 元素引用 ──
  private fillEls: Record<string, HTMLElement | null> = {};
  private levelEls: Record<string, HTMLElement | null> = {};
  private radarPolygon: SVGPolygonElement | null = null;
  private radarDots: Record<string, SVGCircleElement | null> = {};

  // 四维维度定义
  private static readonly DIMENSIONS = [
    { id: 'warmth', key: 'warmth' as const },
    { id: 'directness', key: 'directness' as const },
    { id: 'initiative', key: 'initiative' as const },
    { id: 'playfulness', key: 'playfulness' as const },
  ] as const;

  constructor() {
    super({});
  }

  /**
   * 挂载——查询并缓存情感基调 DOM 元素
   */
  mount(_container: HTMLElement | string): this {
    // 缓存四维进度条和等级元素
    for (const dim of PerceptionAffectComponent.DIMENSIONS) {
      this.fillEls[dim.id] = document.getElementById(`perception-${dim.id}-fill`);
      this.levelEls[dim.id] = document.getElementById(`perception-${dim.id}-level`);
    }

    // 缓存雷达图元素
    const radarPolygon = document.getElementById('perception-affect-radar');
    this.radarPolygon = radarPolygon instanceof SVGPolygonElement ? radarPolygon : null;
    for (const dim of PerceptionAffectComponent.DIMENSIONS) {
      const dot = document.getElementById(`radar-dot-${dim.id}`);
      this.radarDots[dim.id] = dot instanceof SVGCircleElement ? dot : null;
    }

    this.el = document.getElementById('perception-affect-section');
    return this;
  }

  /**
   * 增量更新——渲染情感基调数据
   *
   * @param affect 四维情感基调数值
   */
  update(affect: AffectPayload): this {
    if (!this.el) return this;
    this.renderAffect(affect);
    return this;
  }

  /**
   * 销毁——nullify 引用
   */
  destroy(): void {
    this.fillEls = {};
    this.levelEls = {};
    this.radarPolygon = null;
    this.radarDots = {};
    super.destroy();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  /**
   * 渲染情感基调数据
   *
   * @param affect 四维情感数值
   */
  private renderAffect(affect: AffectPayload): void {
    // 四维进度条
    for (const dim of PerceptionAffectComponent.DIMENSIONS) {
      const value = affect[dim.key];
      const fillEl = this.fillEls[dim.id];
      const levelEl = this.levelEls[dim.id];

      if (fillEl) {
        const percent = Math.round(value * 100);
        const displayWidth = Math.max(6, percent);
        fillEl.style.width = `${displayWidth}%`;
        fillEl.style.background = getAffectColor(value);
        fillEl.title = `${dim.id}：${percent}%`;
      }

      if (levelEl) {
        levelEl.textContent = `${getAffectLevel(value)} · ${Math.round(value * 100)}%`;
      }
    }

    // 雷达图
    this.renderRadar(affect);
  }

  /**
   * 渲染情感雷达图
   *
   * 中心 (60,60)，最大半径 40，四方向：上(温暖)/右(直接)/下(主动)/左(活泼)
   *
   * @param affect 四维情感数值
   */
  private renderRadar(affect: AffectPayload): void {
    const RADAR_CENTER = 60;
    const RADAR_RADIUS = 40;
    const points: Array<[number, number]> = [
      [RADAR_CENTER, RADAR_CENTER - affect.warmth * RADAR_RADIUS],
      [RADAR_CENTER + affect.directness * RADAR_RADIUS, RADAR_CENTER],
      [RADAR_CENTER, RADAR_CENTER + affect.initiative * RADAR_RADIUS],
      [RADAR_CENTER - affect.playfulness * RADAR_RADIUS, RADAR_CENTER],
    ];

    // 更新多边形
    if (this.radarPolygon) {
      this.radarPolygon.setAttribute('points', points.map(p => p.join(',')).join(' '));
    }

    // 更新四个顶点圆点
    const dotIds = ['warmth', 'directness', 'initiative', 'playfulness'] as const;
    for (let i = 0; i < dotIds.length; i++) {
      const dot = this.radarDots[dotIds[i]];
      const point = points[i];
      if (dot && point) {
        dot.setAttribute('cx', String(point[0]));
        dot.setAttribute('cy', String(point[1]));
      }
    }
  }
}