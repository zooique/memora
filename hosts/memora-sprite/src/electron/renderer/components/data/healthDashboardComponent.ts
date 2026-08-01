/**
 * 健康度仪表盘组件
 *
 * 职责（与原子健康度渲染器一致）：
 * - 显示健康度面板加载态（IPC 调用前）
 * - 渲染健康度仪表盘数据（迷你徽章/评分/等级徽章/三维度进度条/详情计数/清理按钮可见性）
 * - 显示加载失败状态（带重试按钮，触发回调重新拉取数据）
 *
 * 组件化改造（HEAL-17 Phase B，对齐 ui-engineering-mindset-rules §四.1 / §四.4）：
 * - 由 HealthDashboardRenderer 升级为 Component 子类，统一生命周期 mount/update/destroy
 * - 采用「采纳静态容器」变体：#memory-health-bar 是 index.html 预留的富骨架静态容器
 *   （header + 评分 + 维度 + 诊断 + 治理操作），mount() 直接将其采纳为 this.el 并缓存内部引用，
 *   不再用 document.getElementById 查内部元素（规则 §四.1 消除「组件查自身外部 DOM」反模式）
 * - update({data}) 增量刷新（textContent/style/classList，与原实现一致，本就无 innerHTML 重建）
 * - destroy() 不移除静态容器：该容器是共享挂载点，亦承载 #health-llm-result 子区（后续 LLM 治理组件），
 *   故销毁前将 this.el 置 null，使基类 destroy 跳过 el.remove()，仅清理事件与引用
 *
 * 由 MemoryPanelManager 持有实例（Manager 持有 Component，不直接操作 DOM，对齐 §四.4）。
 * 关闭按钮 #btn-close-health 由 memoryPanelEvents 在 #memory-health-bar 上委托处理，组件不绑定。
 */

import { Component } from '../base/Component.js';
import { showPanelLoading, hidePanelLoading } from '../../helpers/domHelpers.js';
// renderErrorState 统一面板错误态渲染（图标 + 文字 + 重试按钮），4 处面板共用
import { renderErrorState } from '../../helpers/errorState.js';
import { EventTracker } from '../../helpers/eventTracker.js';
import type { HealthDashboardPayload } from '../../../preload.js';

// ─── 常量 ────────────────────────────────────────────────

/** 健康等级中文标签映射表（本组件的唯⼀真理源，已从 dashboardPanelManager 迁入） */
const HEALTH_LABEL_MAP: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '一般',
  poor: '较差',
};

/** 三维度配置：id（DOM 前缀）/ value（数值）/ cssClass（进度条样式类） */
interface DimensionConfig {
  /** DOM 元素 ID 前缀（如 'uniqueness' 对应 #health-uniqueness 和 #health-uniqueness-val） */
  id: string;
  /** 数值（0-100） */
  value: number;
  /** 进度条样式类（与维度同名，用于不同颜色的进度条） */
  cssClass: string;
}

/** 三维度 id 列表（mount 时缓存对应内部引用，update 时原地写） */
const DIMENSION_IDS = ['uniqueness', 'freshness', 'completeness'] as const;

// ─── 选项 ────────────────────────────────────────────────

/** HealthDashboardComponent 配置（对齐 Component<P> 泛型契约） */
export interface HealthDashboardOptions {
  /** 健康度数据（render 时的可变 prop，由 Controller 拉取后传入） */
  data?: HealthDashboardPayload;
}

// ─── 组件 ────────────────────────────────────────────────

/**
 * 健康度仪表盘组件
 *
 * 负责仪表盘内"记忆健康度"子区域的全部渲染逻辑。
 * 由 MemoryPanelManager 持有，通过外观方法委托调用。
 */
export class HealthDashboardComponent extends Component<HealthDashboardOptions> {
  /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
  private events = new EventTracker();

  /** 重试加载健康度数据回调（用户点击重试按钮时触发） */
  private reloadCallback: (() => void) | null = null;

  // ─── 持久化内部引用（替代原 getElementById 内部查找，均为 #memory-health-bar 子树内元素） ──
  private metricsEl: HTMLElement | null = null;
  private scoreEl: HTMLElement | null = null;
  private scoreSampleEl: HTMLElement | null = null;
  private badgeEl: HTMLElement | null = null;
  private dimFillEls: Record<string, HTMLElement | null> = {};
  private dimValEls: Record<string, HTMLElement | null> = {};
  private dupEl: HTMLElement | null = null;
  private staleEl: HTMLElement | null = null;
  private lowEl: HTMLElement | null = null;
  private descEl: HTMLElement | null = null;
  private dupBtn: HTMLElement | null = null;
  private staleBtn: HTMLElement | null = null;
  private allBtn: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;

  /**
   * 构造函数——只合并配置，无副作用（对齐 §四.1）
   *
   * @param options 组件配置（data 可选，由 update 传入）
   */
  constructor(options: HealthDashboardOptions = {}) {
    super(options);
  }

  /**
   * 挂载到容器——采纳静态容器为根 + 缓存内部引用
   *
   * #memory-health-bar 是 index.html 预留的富骨架（header + 评分 + 维度 + 诊断 + 治理操作），
   * 组件直接将其采纳为 this.el（不新建 wrapper），并在子树内缓存各内部元素引用，
   * 后续 update/showLoading/showError 仅通过这些引用原地操作，杜绝 getElementById。
   * 容器缺失时安全降级（返回 this，el 保持 null）。
   *
   * @param container 容器元素或选择器（静态挂载点 #memory-health-bar）
   * @returns this（链式调用）
   */
  mount(container: HTMLElement | string): this {
    const target = typeof container === 'string'
      ? document.querySelector<HTMLElement>(container)
      : container;
    if (!target) return this;

    this.el = target;

    // ─── 缓存内部引用（this.el 子树内查找） ──
    this.metricsEl = this.el.querySelector('.health-metrics');
    this.scoreEl = this.el.querySelector('#health-score');
    this.scoreSampleEl = this.el.querySelector('#health-score-sample');
    this.badgeEl = this.el.querySelector('#health-badge');
    for (const id of DIMENSION_IDS) {
      this.dimFillEls[id] = this.el.querySelector(`#health-${id}`);
      this.dimValEls[id] = this.el.querySelector(`#health-${id}-val`);
    }
    this.dupEl = this.el.querySelector('#health-duplicates');
    this.staleEl = this.el.querySelector('#health-stale');
    this.lowEl = this.el.querySelector('#health-low-quality');
    this.descEl = this.el.querySelector('#health-description');
    this.dupBtn = this.el.querySelector('#health-cleanup-duplicates');
    this.staleBtn = this.el.querySelector('#health-cleanup-stale');
    this.allBtn = this.el.querySelector('#health-cleanup-all');
    this.actionsEl = this.el.querySelector('#health-actions');

    return this;
  }

  /**
   * 增量更新内部状态——不重建 DOM，仅刷新数据
   *
   * @param newOptions 新的配置项（data 变化时刷新渲染）
   * @returns this（链式调用）
   */
  update(newOptions: Partial<HealthDashboardOptions> = {}): this {
    if (newOptions.data !== undefined) {
      this.options = { ...this.options, data: newOptions.data };
    }
    if (!this.el) return this;
    const data = this.options.data;
    if (!data) return this;
    this._renderData(data);
    return this;
  }

  /**
   * 显示健康度面板加载态（IPC 调用前调用）
   *
   * 在 health-metrics 区域插入加载态占位，不影响 header 区域。
   */
  showLoading(): void {
    if (this.metricsEl) showPanelLoading(this.metricsEl, '加载健康度数据…');
  }

  /**
   * 渲染记忆健康度仪表盘数据（增量，无 innerHTML 重建）
   *
   * @param data 健康度数据
   */
  private _renderData(data: HealthDashboardPayload): void {
    // 清除 showLoading() 添加的 .panel-loading 覆盖层（修复 loading 永驻 bug）
    // 必须在 setTextContent 前执行，否则覆盖层持续遮挡渲染结果
    if (this.metricsEl) hidePanelLoading(this.metricsEl);

    // ─── 健康度评分（记忆面板 health-bar）+ 评分基数 ──────────────
    if (this.scoreEl) {
      // 评分：纯分数（样本量由 #health-score-sample 承载，CSS-R11 分离层级）
      this.scoreEl.textContent = String(data.scores.overall);
    }
    if (this.scoreSampleEl) {
      // 样本量：基于 N 条记忆，muted 次级信息，不与分数争夺视觉权重
      this.scoreSampleEl.textContent = `（${data.totalMemories} 条）`;
    }

    // ─── 健康等级徽章 ──────────────────────────────────
    if (this.badgeEl) {
      // 清除旧等级类名
      this.badgeEl.className = 'panel-badge';
      this.badgeEl.classList.add(data.healthLabel);
      this.badgeEl.textContent = HEALTH_LABEL_MAP[data.healthLabel] || data.healthLabel;
    }

    // ─── 三维度进度条 ──────────────────────────────────
    const dimensions: DimensionConfig[] = [
      { id: 'uniqueness', value: data.scores.uniqueness, cssClass: 'uniqueness' },
      { id: 'freshness', value: data.scores.freshness, cssClass: 'freshness' },
      { id: 'completeness', value: data.scores.completeness, cssClass: 'completeness' },
    ];
    for (const dim of dimensions) {
      const fillEl = this.dimFillEls[dim.id];
      const valEl = this.dimValEls[dim.id];
      if (fillEl) {
        fillEl.style.width = `${dim.value}%`;
        fillEl.className = `metric-track__fill ${dim.cssClass}`;
      }
      if (valEl) valEl.textContent = String(dim.value);
    }

    // ─── 详情计数（重复/过期/低质量）+ 数据点补全 ──────────────────
    const duplicateCount = data.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
    if (this.dupEl) {
      // 重复组追加平均相似度（payload 的 similarity 为 0-1，越小越相似，转为百分比展示）
      // 空值保护：similarity 为可选字段，未提供时不追加
      const similarities = data.duplicates
        .map((g) => g.similarity)
        .filter((s): s is number => typeof s === 'number' && !Number.isNaN(s));
      const avgSimilarity =
        similarities.length > 0
          ? Math.round((similarities.reduce((sum, s) => sum + s, 0) / similarities.length) * 100)
          : null;
      const dupText = avgSimilarity !== null
        ? `重复: ${duplicateCount}（相似度 ${avgSimilarity}%）`
        : `重复: ${duplicateCount}`;
      this.dupEl.textContent = dupText;
      // title 悬停展示完整详情（避免单行溢出）
      this.dupEl.title = duplicateCount > 0 ? `${duplicateCount} 条重复记忆，平均相似度 ${avgSimilarity ?? '未知'}%` : '';
      this.dupEl.className = 'panel-chip';
      if (duplicateCount > 0) this.dupEl.classList.add('warning');
    }

    if (this.staleEl) {
      // 过期记忆追加原因分类（old_age / low_score / both）+ 最长闲置天数
      // 原因分类让用户区分"长期未访问"与"低分"两类过期，针对性清理
      const reasonCounts = { old_age: 0, low_score: 0, both: 0 } as Record<string, number>;
      let maxDays = 0;
      for (const item of data.staleMemories) {
        reasonCounts[item.reason] = (reasonCounts[item.reason] ?? 0) + 1;
        if (item.daysSinceAccess > maxDays) maxDays = item.daysSinceAccess;
      }
      const staleCount = data.staleMemories.length;
      const parts: string[] = [`过期: ${staleCount}`];
      if (staleCount > 0) {
        // 原因分类（仅展示非零项）
        const reasonParts: string[] = [];
        if ((reasonCounts.old_age ?? 0) > 0) reasonParts.push(`老化 ${reasonCounts.old_age}`);
        if ((reasonCounts.low_score ?? 0) > 0) reasonParts.push(`低分 ${reasonCounts.low_score}`);
        if ((reasonCounts.both ?? 0) > 0) reasonParts.push(`双重 ${reasonCounts.both}`);
        if (reasonParts.length > 0) parts.push(`（${reasonParts.join(' / ')}）`);
        // 最长闲置天数
        if (maxDays > 0) parts.push(`· 最长 ${maxDays} 天`);
      }
      this.staleEl.textContent = parts.join('');
      // title 悬停展示完整详情
      this.staleEl.title = staleCount > 0
        ? `${staleCount} 条过期记忆：老化 ${reasonCounts.old_age ?? 0} / 低分 ${reasonCounts.low_score ?? 0} / 双重 ${reasonCounts.both ?? 0}，最长闲置 ${maxDays} 天`
        : '';
      this.staleEl.className = 'panel-chip';
      if (staleCount > 0) this.staleEl.classList.add('warning');
    }

    if (this.lowEl) {
      this.lowEl.textContent = `低质量: ${data.lowQualityCount}`;
      this.lowEl.className = 'panel-chip';
      if (data.lowQualityCount > 0) this.lowEl.classList.add('warning');
    }

    // ─── 健康描述 ──────────────────────────────────────
    if (this.descEl) this.descEl.textContent = data.healthDescription;

    // ─── 清理按钮：仅在有可清理项时显示 ──────────────
    const staleCount = data.staleMemories.length;
    const hasCleanupTarget = duplicateCount > 0 || staleCount > 0;
    if (this.dupBtn) this.dupBtn.style.display = duplicateCount > 0 ? '' : 'none';
    if (this.staleBtn) this.staleBtn.style.display = staleCount > 0 ? '' : 'none';
    if (this.allBtn) this.allBtn.style.display = hasCleanupTarget ? '' : 'none';
    if (this.actionsEl) this.actionsEl.style.display = hasCleanupTarget ? '' : 'none';
  }

  /**
   * 显示健康度面板加载失败状态（带重试按钮）
   *
   * 复用 renderErrorState 统一错误态结构（图标 + 文字 + 重试按钮），
   * 与 profilePanel/auditPanel/workProjectionPanel 对齐。
   * 用户点击重试按钮时触发 onReloadHealth 回调，由 Controller 重新拉取数据。
   */
  showError(): void {
    if (!(this.metricsEl instanceof HTMLElement)) return;
    renderErrorState(
      this.metricsEl,
      '加载失败',
      () => this.reloadCallback?.(),
      this.events,
    );
  }

  /**
   * 注册重试加载健康度数据回调
   *
   * 用户点击重试按钮时触发，由 Controller 重新拉取数据。
   *
   * @param cb 回调函数
   */
  onReloadHealth(cb: () => void): void {
    this.reloadCallback = cb;
  }

  /**
   * 销毁组件——彻底清理
   *
   * 先清理事件跟踪器（解绑重试按钮监听）与引用，再调用基类 destroy。
   * 注意：静态容器 #memory-health-bar 为共享挂载点（亦承载 #health-llm-result 子区），
   * destroy 不应移除它——故先置 this.el = null，使基类 destroy 跳过 el.remove()，
   * 仅执行 _cleanups 与 this.el 置空。关闭按钮未直接绑定，交由 memoryPanelEvents 委托处理。
   */
  destroy(): void {
    this.events.cleanup();
    this.reloadCallback = null;
    this.el = null;
    super.destroy();
  }
}
