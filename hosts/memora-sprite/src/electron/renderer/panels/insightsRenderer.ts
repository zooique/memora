/**
 * 洞察渲染器 — 仪表盘内"记忆洞察"子区域渲染
 *
 * 职责：
 * - 显示洞察面板加载态（IPC 调用前）
 * - 渲染记忆洞察数据（统计卡片 + source 分布条形图 + 关系摘要）
 * - 显示加载失败状态（带重试按钮，触发回调重新拉取数据）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 C（自包含 EventTracker）：重试按钮的事件通过 EventTracker 统一管理
 * - 模式 D 衍生：onReloadInsights() 回调注册接口与外部协作
 * - 由 DashboardPanelManager 持有实例，外观方法委托调用
 */

import { clearElement, createEl, showPanelLoading } from '../helpers/domHelpers.js';
// getSourceLabel 将 source 字符串映射为中文标签（UX-2：source 分布条形图标签中文化）
import { getSourceLabel } from '../helpers/sourceLabel.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { getSourceColorClass } from '../helpers/sourceColor.js';
import type { RelationGraphData } from '../components/relationGraph.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 洞察面板所需的仪表盘数据子集 */
export interface InsightsDashboardData {
  /** 记忆总数 */
  total: number;
  /** 各 source 类型对应的记忆数量 */
  bySource: Record<string, number>;
  /** 冲突数（优先使用，若未提供则从 edges 推断） */
  conflictCount?: number;
}

/** 关系摘要最多展示的条数 */
const MAX_RELATION_ITEMS = 3;

// ─── 洞察渲染器 ────────────────────────────────────────────

/**
 * 洞察渲染器
 *
 * 负责仪表盘内"记忆洞察"子区域的全部渲染逻辑。
 * 由 DashboardPanelManager 持有，通过外观方法委托调用。
 */
export class InsightsRenderer {
  /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
  private events = new EventTracker();

  /** 重试加载洞察数据回调（用户点击重试按钮时触发） */
  private reloadCallback: (() => void) | null = null;

  // ─── 回调注册 ──────────────────────────────────────────

  /**
   * 注册重试加载洞察数据回调
   *
   * 用户点击重试按钮时触发，由 Controller 重新拉取数据。
   */
  onReloadInsights(cb: () => void): void {
    this.reloadCallback = cb;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发）
   */
  cleanup(): void {
    this.events.cleanup();
    this.reloadCallback = null;
  }

  // ─── 渲染方法 ──────────────────────────────────────────

  /**
   * 显示洞察面板加载态（IPC 调用前调用）
   *
   * 同时在 source 分布区域和关系摘要区域插入加载态占位。
   */
  showLoading(): void {
    const distEl = document.getElementById('insights-distribution');
    const summaryEl = document.getElementById('insights-relations-summary');
    if (distEl) showPanelLoading(distEl, '加载洞察数据...');
    if (summaryEl) showPanelLoading(summaryEl, '加载关系数据...');
  }

  /**
   * 渲染记忆洞察数据（Phase 3：记忆洞察面板）
   *
   * 接收 Controller 并行请求的仪表盘数据和关系图谱数据，聚合渲染：
   * - 统计卡片：记忆总数 / 关系数 / 来源数
   * - source 分布：CSS 条形图（零依赖，无需图表库）
   * - 关系摘要：最近 3 条关系 + 类型标签
   *
   * @param dashboard 仪表盘数据
   * @param graph 关系图谱数据
   */
  render(dashboard: InsightsDashboardData, graph: RelationGraphData): void {
    // ─── 统计卡片 ────────────────────────────────────
    const totalEl = document.getElementById('insights-total');
    const relationsEl = document.getElementById('insights-relations');
    const conflictsEl = document.getElementById('insights-conflicts');
    const sourcesEl = document.getElementById('insights-sources');
    if (totalEl) totalEl.textContent = String(dashboard.total);
    // 顶部状态徽章同步总数（信息语义，固定青色 good）
    const totalBadgeEl = document.getElementById('insights-total-badge');
    if (totalBadgeEl) totalBadgeEl.textContent = `${dashboard.total} 条记忆`;
    if (relationsEl) relationsEl.textContent = String(graph.edges.length);
    // 冲突数：优先用后端传的 conflictCount，fallback 从 edges 过滤（向后兼容）
    const conflictCount = dashboard.conflictCount ?? graph.edges.filter((e) => e.type === 'contradicts').length;
    if (conflictsEl) {
      conflictsEl.textContent = String(conflictCount);
      // 有冲突时红色高亮警示
      conflictsEl.classList.toggle('has-conflicts', conflictCount > 0);
    }
    if (sourcesEl) sourcesEl.textContent = String(Object.keys(dashboard.bySource).length);

    // ─── source 分布条形图 ────────────────────────────
    // 每种 source 用对应颜色 + 宽度按比例，零外部依赖
    const distEl = document.getElementById('insights-distribution');
    if (distEl) {
      clearElement(distEl);
      const sources = Object.entries(dashboard.bySource).sort((a, b) => b[1] - a[1]);
      const maxCount = Math.max(1, ...sources.map((s) => s[1]));
      for (const [source, count] of sources) {
        const bar = createEl('div', 'dist-bar');
        bar.title = `${getSourceLabel(source)}: ${count} 条`;

        const label = createEl('span', 'dist-bar__label text-truncate', getSourceLabel(source));

        const fill = createEl('div', `dist-bar__fill source-${getSourceColorClass(source)}`);
        fill.style.width = `${(count / maxCount) * 100}%`;

        const countSpan = createEl('span', 'dist-bar__count', String(count));

        bar.appendChild(label);
        bar.appendChild(fill);
        bar.appendChild(countSpan);
        distEl.appendChild(bar);
      }
    }

    // ─── 关系摘要：最近 3 条关系 ──────────────────────
    // 按创建时间倒序取前 3 条，展示类型标签 + 节点名称
    const summaryEl = document.getElementById('insights-relations-summary');
    if (summaryEl) {
      clearElement(summaryEl);
      if (graph.edges.length === 0) {
        summaryEl.textContent = '暂无关系数据';
      } else {
        // 构建节点 id → name 映射
        const nodeNameMap = new Map(graph.nodes.map((n) => [n.id, n.name]));
        // 按时间倒序
        const recentEdges = [...graph.edges]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, MAX_RELATION_ITEMS);

        const title = createEl('div', 'panel-section-title', '最近关系');
        summaryEl.appendChild(title);

        for (const edge of recentEdges) {
          const item = createEl('div', 'relation-item');

          const sourceName = nodeNameMap.get(edge.sourceId) || edge.sourceId;
          const targetName = nodeNameMap.get(edge.targetId) || edge.targetId;

          const typeTag = createEl('span', `relation-type-tag relation-type-${edge.type}`, edge.type);

          const desc = createEl('span', 'relation-desc text-truncate', `${sourceName} → ${targetName}`);

          item.appendChild(typeTag);
          item.appendChild(desc);
          summaryEl.appendChild(item);
        }
      }
    }
  }

  /**
   * 显示洞察面板加载失败状态（带重试按钮）
   *
   * 在 source 分布区域和关系摘要区域分别渲染重试按钮。
   * 用户点击重试按钮时触发 onReloadInsights 回调，由 Controller 重新拉取数据。
   */
  showError(): void {
    const distEl = document.getElementById('insights-distribution');
    const summaryEl = document.getElementById('insights-relations-summary');

    if (distEl) {
      this.renderErrorWithRetry(distEl);
    }
    if (summaryEl) {
      this.renderErrorWithRetry(summaryEl);
    }
  }

  // ─── 私有辅助方法 ──────────────────────────────────────

  /**
   * 在指定容器内渲染"加载失败"文案 + 重试按钮
   *
   * 在指定容器内渲染加载失败文案 + 重试按钮（distEl 和 summaryEl 两处复用）。
   * 抽取为公共方法以消除重复代码。
   */
  private renderErrorWithRetry(container: HTMLElement): void {
    clearElement(container);
    container.textContent = '加载失败';
    const retryBtn = createEl('button', 'panel-error-btn inline-retry-btn', '重试');
    this.events.addEventListener(retryBtn, 'click', () => {
      this.reloadCallback?.();
    });
    container.appendChild(retryBtn);
  }
}
