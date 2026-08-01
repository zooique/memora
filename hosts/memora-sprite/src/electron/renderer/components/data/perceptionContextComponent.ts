/**
 * 感知面板对话上下文组件
 *
 * 职责（封装 perceptionPanelManager 中 updateContextDisplay 的 DOM 操作）：
 * - 渲染节奏指标（perception-pace-value）
 * - 渲染话题连贯性指标（perception-topic-value）
 * - 渲染深度指标（perception-depth-value）
 */

import { Component } from '../base/component.js';
import { describeRhythm, describeCoherence, describeDepth } from '../../helpers/perceptionLabels.js';
import type { ContextPayload } from '../../ipcListeners.js';

// ─── 组件 ────────────────────────────────────────────────

/**
 * 感知面板对话上下文组件
 *
 * 由 PerceptionPanelManager 持有实例，替代原有 ~3 处 document.getElementById。
 */
export class PerceptionContextComponent extends Component<ContextPayload> {
  private paceEl: HTMLElement | null = null;
  private topicEl: HTMLElement | null = null;
  private depthEl: HTMLElement | null = null;

  constructor() {
    // 传入空对象作为默认配置（子类不使用 this.options，渲染依赖 update 入参）
    super({} as ContextPayload);
  }

  /**
   * 挂载——查询并缓存上下文 DOM 元素
   */
  mount(_container: HTMLElement | string): this {
    this.paceEl = document.getElementById('perception-pace-value');
    this.topicEl = document.getElementById('perception-topic-value');
    this.depthEl = document.getElementById('perception-depth-value');
    this.el = document.getElementById('perception-context-section');
    return this;
  }

  /**
   * 增量更新——渲染对话上下文数据
   *
   * @param newOptions 对话上下文数据
   */
  update(newOptions: Partial<ContextPayload>): this {
    if (!this.el) return this;
    this.renderContext(newOptions as ContextPayload);
    return this;
  }

  /**
   * 销毁——nullify 引用
   */
  destroy(): void {
    this.paceEl = null;
    this.topicEl = null;
    this.depthEl = null;
    super.destroy();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  /**
   * 渲染对话上下文数据
   *
   * @param context 对话上下文数据
   */
  private renderContext(context: ContextPayload): void {
    // 节奏
    if (this.paceEl) {
      this.paceEl.textContent = describeRhythm(context.rhythm);
    }

    // 话题连贯性
    if (this.topicEl) {
      this.topicEl.textContent = describeCoherence(context.coherence);
    }

    // 深度
    if (this.depthEl) {
      this.depthEl.textContent = describeDepth(context.depth);
    }
  }
}