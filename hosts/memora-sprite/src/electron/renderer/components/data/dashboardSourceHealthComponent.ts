/**
 * 仪表盘记忆源健康诊断组件
 *
 * 职责（封装 dashboardPanelManager 中 renderSourceHealth 的 DOM 操作）：
 * - 渲染记忆源健康诊断列表（按 source 分组的健康状态）
 * - 显示总体健康状态徽章和诊断时间戳
 * - 按 status 严重度排序（critical → warning → healthy）
 * - 空数据时显示空状态文案
 *
 * 与现有 HTML 模板的关系：
 * - 记忆源健康 DOM 元素已存在于 index.html 模板中
 * - 本组件 mount() 时查询并缓存这些已有元素引用
 * - destroy() 不删除 DOM 元素，仅 nullify 引用
 *
 * 对齐 ui-engineering-mindset-rules §四.1 / §四.4：
 * - mount() 缓存元素引用
 * - update() 增量渲染数据
 * - destroy() 彻底清理引用
 */

import { Component } from '../base/component.js';
import { clearElement, formatTimeAgo } from '../../helpers/domHelpers.js';
import { getSourceColorClass } from '../../helpers/sourceColor.js';
import { getSourceLabel } from '../../helpers/sourceLabel.js';

// ─── 类型定义 ──────────────────────────────────────────────

/**
 * 记忆源健康诊断快照（对齐 preload.ts getDashboard 返回的 sourceHealth 结构）
 * 从 dashboardPanelManager 迁入，保持类型定义一致
 */
export interface SourceHealthData {
  /** 各 source 的健康明细 */
  sources: Array<{
    source: string;
    count: number;
    avgScore: number;
    daysSinceLastAccess: number;
    status: 'healthy' | 'warning' | 'critical';
  }>;
  /** 总体健康状态（取最差的 source 状态） */
  overallStatus: 'healthy' | 'warning' | 'critical';
  /** 诊断时间戳（ISO 字符串） */
  diagnosedAt: string;
}

// ─── 选项 / 宿主接口 ──────────────────────────────────────

/** DashboardSourceHealthComponent 配置 */
export interface DashboardSourceHealthOptions {
  // 当前无跨模块关注点注入，保留 Options 接口供后续扩展
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * 仪表盘记忆源健康诊断组件
 *
 * 由 DashboardPanelManager 持有实例，替代原有 4 处 document.getElementById 直接 DOM 操作。
 * 挂载到现有 HTML 模板中的 #dashboard-source-health 及相关元素。
 */
export class DashboardSourceHealthComponent extends Component<DashboardSourceHealthOptions> {
  // ─── 缓存的 DOM 元素引用（mount 时查询，destroy 时 nullify） ──
  /** 源健康 - 列表容器 */
  private listEl: HTMLElement | null = null;
  /** 源健康 - 区块容器 */
  private sectionEl: HTMLElement | null = null;
  /** 源健康 - 总体状态元素 */
  private overallEl: HTMLElement | null = null;
  /** 源健康 - 诊断时间元素 */
  private diagnosedEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用
   *
   * @param options 组件配置
   */
  constructor(options: DashboardSourceHealthOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——查询并缓存现有 DOM 元素引用
   *
   * @param _container 容器元素或选择器（兼容 Component 契约）
   * @returns this（链式调用）
   */
  mount(_container: HTMLElement | string): this {
    this.listEl = document.getElementById('dashboard-source-health-list');
    this.sectionEl = document.getElementById('dashboard-source-health');
    this.overallEl = document.getElementById('dashboard-source-health-overall');
    this.diagnosedEl = document.getElementById('dashboard-source-health-diagnosed');

    // 设置 this.el（Component 基类契约）
    this.el = this.sectionEl;

    return this;
  }

  /**
   * 增量更新——渲染记忆源健康诊断数据
   *
   * @param sourceHealth 记忆源健康诊断数据（null 表示不可用）
   * @returns this（链式调用）
   */
  update(sourceHealth: SourceHealthData | null): this {
    if (!this.el) return this;
    this.renderSourceHealth(sourceHealth);
    return this;
  }

  /**
   * 销毁组件——nullify 引用
   *
   * 元素是 HTML 模板的一部分，不删除 DOM，仅 nullify 引用。
   */
  destroy(): void {
    this.listEl = null;
    this.sectionEl = null;
    this.overallEl = null;
    this.diagnosedEl = null;
    super.destroy();
  }

  // ─── 数据渲染（从 dashboardPanelManager 迁移） ────────────

  /**
   * 渲染记忆源健康诊断
   *
   * 在仪表盘展示每个 source 的质量维度：计数 / 平均分 / 距上次访问天数 / 健康状态徽章。
   * 采用主行+次行双层布局：主行展示 source 名称和状态徽章，次行展示详细指标。
   * 无数据时保留 section 标题，仅在列表区显示空状态文案。
   *
   * @param sourceHealth 记忆源健康诊断数据（null 表示不可用）
   */
  private renderSourceHealth(sourceHealth: SourceHealthData | null): void {
    if (!this.listEl || !this.sectionEl) return;

    // 无数据时显示空状态
    if (!sourceHealth || sourceHealth.sources.length === 0) {
      this.sectionEl.classList.remove('hidden');
      clearElement(this.listEl);
      const emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.textContent = '暂无记忆源健康数据';
      this.listEl.appendChild(emptyEl);
      if (this.overallEl) this.overallEl.textContent = '';
      if (this.diagnosedEl) this.diagnosedEl.textContent = '';
      return;
    }

    this.sectionEl.classList.remove('hidden');

    // 总体状态徽章
    if (this.overallEl) {
      this.overallEl.textContent = this.getStatusLabel(sourceHealth.overallStatus);
      this.overallEl.className = `source-health-overall ${sourceHealth.overallStatus}`;
    }

    // 诊断时间戳
    if (this.diagnosedEl) {
      this.diagnosedEl.textContent = `诊断于 ${formatTimeAgo(sourceHealth.diagnosedAt)}`;
    }

    // 按 status 严重度排序
    const statusOrder: Record<string, number> = { critical: 0, warning: 1, healthy: 2 };
    const sortedSources = [...sourceHealth.sources].sort(
      (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9),
    );

    clearElement(this.listEl);
    for (const s of sortedSources) {
      const item = document.createElement('div');
      item.className = `source-health-item ${s.status}`;

      // 主行
      const mainRow = document.createElement('div');
      mainRow.className = 'source-health-main flex-between';

      const labelSpan = document.createElement('span');
      labelSpan.className = `source-health-label source-${getSourceColorClass(s.source)}`;
      labelSpan.textContent = getSourceLabel(s.source);

      const statusSpan = document.createElement('span');
      statusSpan.className = `source-health-status ${s.status} flex-shrink-0`;
      statusSpan.textContent = this.getStatusLabel(s.status);

      mainRow.appendChild(labelSpan);
      mainRow.appendChild(statusSpan);

      // 次行
      const metaRow = document.createElement('div');
      metaRow.className = 'source-health-meta';

      const countSpan = document.createElement('span');
      countSpan.textContent = `${s.count} 条`;
      countSpan.title = '该 source 的记忆总数';

      const scoreSpan = document.createElement('span');
      scoreSpan.textContent = `均分 ${Math.round(s.avgScore * 100)}`;
      scoreSpan.title = '该 source 所有记忆的平均分（0-100）';

      const accessSpan = document.createElement('span');
      accessSpan.textContent = s.daysSinceLastAccess === 0
        ? '今日访问'
        : `${s.daysSinceLastAccess} 天未访`;
      accessSpan.title = '距上次访问该 source 的天数';

      metaRow.appendChild(countSpan);
      metaRow.appendChild(scoreSpan);
      metaRow.appendChild(accessSpan);

      item.appendChild(mainRow);
      item.appendChild(metaRow);
      this.listEl.appendChild(item);
    }
  }

  /**
   * 将健康状态映射为中文标签
   *
   * @param status 健康状态标识符
   * @returns 中文标签
   */
  private getStatusLabel(status: 'healthy' | 'warning' | 'critical'): string {
    switch (status) {
      case 'healthy': return '健康';
      case 'warning': return '需关注';
      case 'critical': return '异常';
      default: return status;
    }
  }
}