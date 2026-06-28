/**
 * 记忆控制器 — 记忆面板业务逻辑 + 仪表盘数据加载
 *
 * 职责：
 * - 设置记忆面板回调（搜索/筛选/点击/删除/添加）
 * - 加载记忆列表到 UI
 * - 加载仪表盘数据（累积事件/触发器/推荐记忆）
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - 搜索回调内置序列号竞态保护（防止快速输入时旧结果覆盖新结果）
 * - 仪表盘高亮状态：接近阈值（>=80%）黄色，达到阈值粉色
 */

import type { UIManager } from '../ui.js';
import { setButtonLoading, clearElement, showPanelLoading } from '../helpers/domHelpers.js';
import type { MemoryListItem } from '../types.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';
import { getSourceColorClass } from '../panels/memoryPanelManager.js';
import type { HealthDashboardPayload } from '../../preload.js';
// 复用内核 getDuplicateRemovalIds，消除渲染层重复实现
import { getDuplicateRemovalIds } from '../../../sprite/controllers/memoryHealth.js';

/** 仪表盘计数脉冲动画时长（毫秒），对齐 layout.css @keyframes numberPulse 的 0.3s */

/**
 * 获取当前搜索参数（Phase 2：组合搜索，模块级）
 *
 * 从搜索栏、source 筛选、排序下拉、时间范围下拉中读取当前值，
 * 统一返回 SearchParams 对象供搜索和列表加载共用。
 * DOM 元素缺失时返回默认值，避免测试环境报错。
 */
function getSearchParams(): { query: string; source: string; sort: string; timeRange: string } {
  const searchEl = document.getElementById('memory-search');
  const sourceEl = document.getElementById('memory-filter-source');
  const sortEl = document.getElementById('memory-sort-order');
  const timeEl = document.getElementById('memory-time-range');
  return {
    query: (searchEl instanceof HTMLInputElement ? searchEl.value : '').trim(),
    source: sourceEl instanceof HTMLSelectElement ? sourceEl.value : '',
    sort: sortEl instanceof HTMLSelectElement ? sortEl.value : 'relevance',
    timeRange: timeEl instanceof HTMLSelectElement ? timeEl.value : '',
  };
}

/**
 * 客户端排序 + 时间过滤（Phase 2：搜索增强，模块级）
 *
 * 在 IPC 返回结果后，根据当前排序方式和时间范围对结果进行二次处理。
 * 搜索模式下使用 hits（含 similarity 字段），列表模式下使用 memories。
 *
 * @param items 记忆列表项
 * @param params 搜索参数（sort + timeRange）
 * @returns 排序和过滤后的列表
 */
function applyClientFilters(
  items: MemoryListItem[],
  params: { sort: string; timeRange: string },
): MemoryListItem[] {
  let result = [...items];

  // 时间范围过滤（客户端，基于 createdAt 字段）
  if (params.timeRange) {
    const now = Date.now();
    const rangeMs: Record<string, number> = {
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
      '90d': 90 * 24 * 60 * 60 * 1000,
    };
    const cutoff = now - (rangeMs[params.timeRange] || 0);
    result = result.filter((item) => {
      if (!item.createdAt) return true; // 无时间信息的记忆保留
      return new Date(item.createdAt).getTime() >= cutoff;
    });
  }

  // 排序
  if (params.sort === 'score') {
    result.sort((a, b) => b.score - a.score);
  } else if (params.sort === 'time') {
    result.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta; // 最新在前
    });
  }
  // 'relevance' 保持原始顺序（搜索已按相关度排序，列表按 score 排序）

  return result;
}
const DASHBOARD_PULSE_MS = 300;

/** 累积事件接近阈值的百分比（>=80% 显示黄色高亮） */
const NEAR_THRESHOLD_RATIO = 0.8;

/** QC-STATE-01 修复：pulseTimers 已移入 createMemoryController 闭包内 */

/**
 * 格式化 token 数显示
 *
 * 超过 1000 时显示为 "1.2k" 格式，否则直接显示数字。
 * 供仪表盘 LLM Token 指标卡片使用。
 *
 * @param tokens token 数量
 * @returns 格式化后的字符串（如 "999" / "1.2k"）
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return String(tokens);
}

/**
 * 创建记忆控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 记忆控制器接口（设置回调、加载列表、加载仪表盘）
 */
export function createMemoryController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /** QC-STATE-01 修复：脉冲动画定时器句柄移入闭包，避免模块级状态违反"不持有模块级状态"原则 */
  let pulseTimers: number[] = [];

  /** 存储当前健康度数据，供清理操作使用（闭包级，setupMemoryPanel 和 loadHealthDashboard 共享） */
  let currentHealthData: HealthDashboardPayload | null = null;

  /**
   * 设置记忆面板回调
   *
   * 包含搜索（带竞态保护）、筛选、点击查看详情、删除、添加。
   */
  function setupMemoryPanel(): void {
    // 搜索请求序列号：防止快速输入时旧结果覆盖新结果（竞态保护）
    let searchSeq = 0;

    // ─── FD-03 叙事卡片点击：展开/折叠详情区 ────────────
    const narrativeCard = document.getElementById('sprite-narrative');
    const detailsContainer = document.getElementById('dashboard-details');
    const toggleArrow = document.getElementById('narrative-toggle');
    if (narrativeCard && detailsContainer && toggleArrow) {
      // 默认折叠详情区
      detailsContainer.classList.add('collapsed');
      narrativeCard.addEventListener('click', () => {
        const isCollapsed = detailsContainer.classList.toggle('collapsed');
        toggleArrow.classList.toggle('expanded', !isCollapsed);
      });
    }

    // ─── FD-03 对话面板叙事行点击：定位到侧边栏叙事卡片 ────
    const chatNarrative = document.getElementById('chat-narrative');
    if (chatNarrative && narrativeCard && detailsContainer) {
      chatNarrative.addEventListener('click', () => {
        // 展开详情区（若已折叠）
        detailsContainer.classList.remove('collapsed');
        if (toggleArrow) toggleArrow.classList.add('expanded');
        // 滚动侧边栏使叙事卡片可见
        narrativeCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // 短暂脉冲动画标记叙事卡片位置
        narrativeCard.classList.remove('narrative-updated');
        void narrativeCard.offsetWidth;
        narrativeCard.classList.add('narrative-updated');
      });
    }

    // ─── 高级搜索栏展开/收起（Phase 2：搜索增强，现收纳到更多菜单） ────────────
    const advSearchBar = document.getElementById('advanced-search-bar');
    const insightsBar = document.getElementById('memory-insights-bar');
    const healthBar = document.getElementById('memory-health-bar');
    const moreBtn = document.getElementById('btn-memory-more');
    const moreMenu = document.getElementById('memory-more-menu');

    /** 切换更多菜单的显示/隐藏 */
    function toggleMoreMenu(show?: boolean): void {
      if (!moreMenu || !moreBtn) return;
      const shouldShow = show ?? moreMenu.classList.contains('hidden');
      moreMenu.classList.toggle('hidden', !shouldShow);
      moreBtn.setAttribute('aria-expanded', String(shouldShow));
    }

    // 更多按钮点击切换菜单
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMoreMenu();
      });
    }

    // 点击外部关闭更多菜单
    document.addEventListener('click', (e) => {
      if (moreMenu && !moreMenu.classList.contains('hidden')) {
        const target = e.target as HTMLElement;
        if (!moreMenu.contains(target) && target !== moreBtn) {
          toggleMoreMenu(false);
        }
      }
    });

    // 更多菜单项事件委托
    if (moreMenu) {
      moreMenu.addEventListener('click', async (e) => {
        const item = (e.target as HTMLElement).closest('.more-menu-item') as HTMLElement | null;
        if (!item) return;
        const action = item.getAttribute('data-action');
        toggleMoreMenu(false);

        if (action === 'advanced-search') {
          // 切换高级筛选栏
          if (advSearchBar) {
            const isHidden = advSearchBar.classList.contains('hidden');
            advSearchBar.classList.toggle('hidden', !isHidden);
          }
        } else if (action === 'insights') {
          // 切换统计洞察栏
          if (insightsBar) {
            const isHidden = insightsBar.classList.contains('hidden');
            insightsBar.classList.toggle('hidden', !isHidden);
            if (isHidden) {
              await loadInsights();
            }
          }
        } else if (action === 'health') {
          // 切换健康度诊断栏
          if (healthBar) {
            const isHidden = healthBar.classList.contains('hidden');
            healthBar.classList.toggle('hidden', !isHidden);
            if (isHidden) {
              await loadHealthDashboard();
            }
          }
        }
      });
    }

    // ─── 清理按钮（Phase 3：智能清理） ────────────────────

    // 清理重复按钮
    const cleanupDupBtn = document.getElementById('health-cleanup-duplicates');
    if (cleanupDupBtn) {
      cleanupDupBtn.addEventListener('click', () => {
        if (!currentHealthData) return;
        const dupIds = getDuplicateRemovalIds(currentHealthData.duplicates);
        if (dupIds.length === 0) {
          uiManager.showToast('没有可清理的重复记忆', 'info');
          return;
        }
        showCleanupConfirm(`确定要清理 ${dupIds.length} 条重复记忆吗？每组将保留分数最高的一条。`, dupIds);
      });
    }

    // 清理过期按钮
    const cleanupStaleBtn = document.getElementById('health-cleanup-stale');
    if (cleanupStaleBtn) {
      cleanupStaleBtn.addEventListener('click', () => {
        if (!currentHealthData) return;
        const staleIds = currentHealthData.staleMemories.map((s) => s.memory.id);
        if (staleIds.length === 0) {
          uiManager.showToast('没有可清理的过期记忆', 'info');
          return;
        }
        showCleanupConfirm(`确定要清理 ${staleIds.length} 条过期记忆吗？这些记忆长期未访问或得分较低。`, staleIds);
      });
    }

    // 一键清理按钮
    const cleanupAllBtn = document.getElementById('health-cleanup-all');
    if (cleanupAllBtn) {
      cleanupAllBtn.addEventListener('click', () => {
        if (!currentHealthData) return;
        const dupIds = getDuplicateRemovalIds(currentHealthData.duplicates);
        const staleIds = currentHealthData.staleMemories.map((s) => s.memory.id);
        const allIds = [...new Set([...dupIds, ...staleIds])];
        if (allIds.length === 0) {
          uiManager.showToast('没有可清理的问题记忆', 'info');
          return;
        }
        showCleanupConfirm(
          `确定要清理 ${allIds.length} 条问题记忆吗？包括 ${dupIds.length} 条重复和 ${staleIds.length} 条过期记忆。`,
          allIds,
        );
      });
    }

    // 清理确认对话框：取消
    const cleanupCancelBtn = document.getElementById('cleanup-confirm-cancel');
    const cleanupDialog = document.getElementById('cleanup-confirm-dialog');
    if (cleanupCancelBtn && cleanupDialog) {
      cleanupCancelBtn.addEventListener('click', () => {
        cleanupDialog.classList.add('hidden');
      });
    }

    // 清理确认对话框：确认
    let pendingCleanupIds: string[] = [];
    const cleanupConfirmBtn = document.getElementById('cleanup-confirm-confirm');
    if (cleanupConfirmBtn && cleanupDialog) {
      cleanupConfirmBtn.addEventListener('click', async () => {
        cleanupDialog.classList.add('hidden');
        if (pendingCleanupIds.length === 0) return;
        try {
          const result = await window.electronAPI.deleteMemoriesBatch(pendingCleanupIds);
          uiManager.showToast(`已清理 ${result.deleted}/${result.total} 条记忆`, 'success');
          // 刷新健康度仪表盘和记忆列表
          await loadHealthDashboard();
          await loadMemoryList();
        } catch (error) {
          reportError('cleanupConfirm', error);
          uiManager.showToast('清理失败，请重试', 'error');
        } finally {
          pendingCleanupIds = [];
        }
      });
    }

    /**
     * 显示清理确认对话框
     *
     * @param message 确认消息
     * @param ids 待清理的记忆 ID 列表
     */
    function showCleanupConfirm(message: string, ids: string[]): void {
      const msgEl = document.getElementById('cleanup-confirm-msg');
      if (msgEl) msgEl.textContent = message;
      pendingCleanupIds = ids;
      if (cleanupDialog) cleanupDialog.classList.remove('hidden');
    }

    // 搜索回调（Phase 2：组合搜索 — 关键词 + source + 排序 + 时间）
    uiManager.onMemorySearch(async (query: string) => {
      const params = getSearchParams();
      if (!query) {
        // 空搜索：加载全部（保留 source 筛选）
        await loadMemoryList();
        return;
      }
      // 递增序列号，捕获当前请求的序号
      const seq = ++searchSeq;
      try {
        const { hits } = await window.electronAPI.searchMemories(query);
        // 若在等待期间有更新的搜索请求发起，丢弃本次过期结果
        if (seq !== searchSeq) return;
        let items: MemoryListItem[] = hits.map(h => ({
          id: h.id,
          name: h.name,
          source: h.source,
          score: h.similarity ?? h.score,
          contentPreview: h.contentPreview,
          createdAt: (h as unknown as Record<string, unknown>).createdAt as string | undefined,
        }));
        // 客户端 source 筛选（搜索 API 不支持 source 参数，客户端过滤）
        if (params.source) {
          items = items.filter(item => item.source === params.source);
        }
        // 客户端排序 + 时间过滤
        items = applyClientFilters(items, params);
        // 传递搜索关键词用于高亮
        uiManager.renderMemoryList(items, query);
      } catch (error) {
        // IX-02 搜索失败时保持原列表，但给用户可见反馈（而非静默吞错）
        if (seq !== searchSeq) return;
        reportError('onMemorySearch', error);
        uiManager.showToast('搜索记忆失败，请重试', 'error');
      }
    });

    // 筛选回调（Phase 2：触发时重新加载，应用当前全部筛选条件）
    uiManager.onMemoryFilter((_source: string) => {
      void loadMemoryList();
    });

    // 排序方式变更（Phase 2：搜索增强）
    // 通过 dispatchEvent 触发搜索输入框的 input 事件，复用已有的 300ms 防抖 + 竞态保护
    const sortEl = document.getElementById('memory-sort-order');
    if (sortEl) {
      sortEl.addEventListener('change', () => {
        const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
        if (searchInput && searchInput.value.trim()) {
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          void loadMemoryList();
        }
      });
    }

    // 时间范围变更（Phase 2：搜索增强）
    const timeEl = document.getElementById('memory-time-range');
    if (timeEl) {
      timeEl.addEventListener('change', () => {
        const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
        if (searchInput && searchInput.value.trim()) {
          searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          void loadMemoryList();
        }
      });
    }

    // 点击记忆条目：查看详情
    uiManager.onMemoryClick(async (id: string) => {
      try {
        const { memory } = await window.electronAPI.showMemory(id);
        if (memory) {
          uiManager.showMemoryDetail(memory);
        }
      } catch (error) {
        reportError('onMemoryClick', error);
      }
    });

    // 删除记忆
    uiManager.onMemoryDelete(async () => {
      const id = uiManager.getCurrentMemoryId();
      if (!id) return;
      // FD-FIX-DELETE-LOADING：删除是不可恢复操作，需防重复点击（与 onMemoryAdd/onMemoryEdit 一致）
      setButtonLoading('btn-memory-delete', true, '删除中...');
      try {
        await window.electronAPI.deleteMemory(id);
        uiManager.hideModal('memory-detail-modal');
        await loadMemoryList();
        // IX-06 操作反馈走 toast
        uiManager.showToast('记忆已删除', 'success');
      } catch (error) {
        handleIpcError('onMemoryDelete', error, '删除记忆失败');
      } finally {
        // FD-FIX-DELETE-LOADING：恢复按钮状态（弹窗已关闭时 setButtonLoading 内部会安全降级）
        setButtonLoading('btn-memory-delete', false);
      }
    });

    // 添加记忆
    uiManager.onMemoryAdd(async (data) => {
      // FD-08 进行中反馈：禁用按钮防止重复点击
      setButtonLoading('btn-memory-add-confirm', true, '添加中...');
      try {
        await window.electronAPI.addMemory(data);
        uiManager.clearAddMemoryForm();
        uiManager.hideModal('memory-add-modal');
        await loadMemoryList();
        // IX-06 操作反馈走 toast
        uiManager.showToast('记忆已添加', 'success');
      } catch (error) {
        handleIpcError('onMemoryAdd', error, '添加记忆失败');
      } finally {
        // FD-08 恢复按钮状态
        setButtonLoading('btn-memory-add-confirm', false);
      }
    });

    // P2-FLOW-08 编辑记忆：复用 MEMORIES_ADD 通道（底层 upsert 语义）
    // 修复 TS6133：id 参数未使用（编辑时通过 dataset 获取 source/name），加下划线前缀
    uiManager.onMemoryEdit(async (_id: string, content: string) => {
      // 从详情弹窗 dataset 获取 source 和 name（编辑时不改变这两个字段）
      const detailModal = document.getElementById('memory-detail-modal');
      const source = detailModal?.dataset.memorySource ?? '';
      const name = detailModal?.dataset.memoryName ?? '';
      if (!source || !name) return;

      setButtonLoading('btn-memory-edit-save', true, '保存中...');
      try {
        // 复用 addMemory（底层是 upsert，ID 相同时更新内容）
        await window.electronAPI.addMemory({ source, name, content });
        uiManager.hideModal('memory-detail-modal');
        await loadMemoryList();
        uiManager.showToast('记忆已更新', 'success');
      } catch (error) {
        handleIpcError('onMemoryEdit', error, '更新记忆失败');
      } finally {
        setButtonLoading('btn-memory-edit-save', false);
      }
    });

    // FD-ADD-REC-CLICK 仪表盘推荐记忆点击事件委托已迁移到 UIManager.initEventListeners
    // （通过 EventTracker 统一管理，避免内存泄漏，与 dateNavList 委托同模式）

    // ─── 图谱视图切换（ADR-014：拓扑可视化） ────────────────
    // 注册图谱视图切换回调：切换到图谱时请求 IPC 加载数据
    uiManager.onGraphToggle(async (mode) => {
      if (mode === 'graph') {
        try {
          const data = await window.electronAPI.getRelationGraph();
          uiManager.loadGraphData(data);
        } catch (error) {
          reportError('onGraphToggle', error);
          uiManager.showToast('加载关系图谱失败', 'error');
          // 失败时回退到列表视图
          uiManager.switchMemoryView('list');
        }
      }
    });

    // 切换按钮点击事件（列表 ↔ 图谱 segmented control）
    const listBtn = document.getElementById('btn-list-view');
    const graphBtn = document.getElementById('btn-graph-view');

    function switchViewBtn(view: 'list' | 'graph'): void {
      if (listBtn) listBtn.classList.toggle('active', view === 'list');
      if (graphBtn) graphBtn.classList.toggle('active', view === 'graph');
      if (listBtn) listBtn.setAttribute('aria-selected', String(view === 'list'));
      if (graphBtn) graphBtn.setAttribute('aria-selected', String(view === 'graph'));
    }

    if (listBtn) {
      listBtn.addEventListener('click', () => {
        uiManager.switchMemoryView('list');
        switchViewBtn('list');
      });
    }

    if (graphBtn) {
      graphBtn.addEventListener('click', () => {
        const graphContainer = document.getElementById('memory-graph-container');
        const isGraphView = graphContainer && graphContainer.style.display !== 'none';

        if (isGraphView) {
          uiManager.switchMemoryView('list');
          switchViewBtn('list');
        } else {
          uiManager.switchMemoryView('graph');
          switchViewBtn('graph');
        }
      });
    }
  }

  /**
   * 加载记忆洞察数据（Phase 3：记忆洞察面板）
   *
   * 并行请求仪表盘数据和关系图谱数据，聚合渲染：
   * - 统计卡片：记忆总数 / 关系数 / 来源数
   * - source 分布：CSS 条形图（零依赖，无需图表库）
   * - 关系摘要：最近 3 条关系 + 类型标签
   *
   * 纯代码计算，不增加 LLM 调用。
   */
  async function loadInsights(): Promise<void> {
    // FD-02 加载态：在 IPC 调用前显示加载指示器
    const distEl = document.getElementById('insights-distribution');
    const summaryEl = document.getElementById('insights-relations-summary');
    if (distEl) showPanelLoading(distEl, '加载洞察数据...');
    if (summaryEl) showPanelLoading(summaryEl, '加载关系数据...');

    try {
      // 并行请求（Promise.all 避免串行延迟）
      const [dashboard, graph] = await Promise.all([
        window.electronAPI.getDashboard(),
        window.electronAPI.getRelationGraph(),
      ]);

      // ─── 统计卡片 ────────────────────────────────────
      const totalEl = document.getElementById('insights-total');
      const relationsEl = document.getElementById('insights-relations');
      const sourcesEl = document.getElementById('insights-sources');
      if (totalEl) totalEl.textContent = String(dashboard.total);
      if (relationsEl) relationsEl.textContent = String(graph.edges.length);
      if (sourcesEl) sourcesEl.textContent = String(Object.keys(dashboard.bySource).length);

      // ─── source 分布条形图 ────────────────────────────
      // 每种 source 用对应颜色 + 宽度按比例，零外部依赖
      const distEl = document.getElementById('insights-distribution');
      if (distEl) {
        clearElement(distEl);
        const sources = Object.entries(dashboard.bySource).sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(1, ...sources.map((s) => s[1]));
        for (const [source, count] of sources) {
          const bar = document.createElement('div');
          bar.className = 'insights-distribution-bar';
          bar.title = `${source}: ${count} 条`;

          const label = document.createElement('span');
          label.className = 'distribution-label';
          label.textContent = source;

          const fill = document.createElement('div');
          fill.className = `distribution-fill source-${getSourceColorClass(source)}`;
          fill.style.width = `${(count / maxCount) * 100}%`;

          const countSpan = document.createElement('span');
          countSpan.className = 'distribution-count';
          countSpan.textContent = String(count);

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
            .slice(0, 3);

          const title = document.createElement('div');
          title.className = 'insights-section-title';
          title.textContent = '最近关系';
          summaryEl.appendChild(title);

          for (const edge of recentEdges) {
            const item = document.createElement('div');
            item.className = 'insights-relation-item';

            const sourceName = nodeNameMap.get(edge.sourceId) || edge.sourceId;
            const targetName = nodeNameMap.get(edge.targetId) || edge.targetId;

            const typeTag = document.createElement('span');
            typeTag.className = `relation-type-tag relation-type-${edge.type}`;
            typeTag.textContent = edge.type;

            const desc = document.createElement('span');
            desc.className = 'relation-desc';
            desc.textContent = `${sourceName} → ${targetName}`;

            item.appendChild(typeTag);
            item.appendChild(desc);
            summaryEl.appendChild(item);
          }
        }
      }
    } catch (error) {
      reportError('loadInsights', error);
      // 加载失败时显示带重试按钮的错误状态（与 loadMemoryList 的 showPanelError 一致）
      if (distEl) {
        clearElement(distEl);
        distEl.textContent = '加载失败';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'panel-error-btn inline-retry-btn';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', () => void loadInsights());
        distEl.appendChild(retryBtn);
      }
      if (summaryEl) {
        clearElement(summaryEl);
        summaryEl.textContent = '加载失败';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'panel-error-btn inline-retry-btn';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', () => void loadInsights());
        summaryEl.appendChild(retryBtn);
      }
      // 洞察加载失败不阻塞记忆面板主流程
    }
  }

  /**
   * 加载记忆健康度仪表盘数据（Phase 1：健康度诊断）
   *
   * 请求 IPC 获取健康度数据，渲染：
   * - 健康度评分（总分 + 三维度进度条）
   * - 健康等级徽章
   * - 重复/过期/低质量计数
   * - 健康描述文字
   *
   * 纯 DOM 操作，不依赖 LLM。
   */
  async function loadHealthDashboard(): Promise<void> {
    // FD-02 加载态：在 IPC 调用前显示加载指示器
    const healthBar = document.getElementById('memory-health-bar');
    // 在 health-metrics 区域插入加载态（不影响 header 区域）
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl) showPanelLoading(metricsEl, '加载健康度数据...');

    try {
      const data = await window.electronAPI.getHealthDashboard();

      // 存储数据供清理操作使用
      currentHealthData = data;

      // ─── 迷你健康分徽章（工具栏内） ────────────────────
      const miniScore = document.getElementById('health-mini-score');
      if (miniScore) {
        miniScore.textContent = String(data.scores.overall);
        miniScore.className = `health-mini-score ${data.healthLabel}`;
        miniScore.classList.remove('hidden');
      }

      // ─── 健康度评分 ────────────────────────────────────
      const scoreEl = document.getElementById('health-score');
      if (scoreEl) scoreEl.textContent = String(data.scores.overall);

      // ─── 健康等级徽章 ──────────────────────────────────
      const badgeEl = document.getElementById('health-badge');
      if (badgeEl) {
        // 清除旧等级类名
        badgeEl.className = 'health-badge';
        badgeEl.classList.add(data.healthLabel);
        const labelMap: Record<string, string> = {
          excellent: '优秀',
          good: '良好',
          fair: '一般',
          poor: '较差',
        };
        badgeEl.textContent = labelMap[data.healthLabel] || data.healthLabel;
      }

      // ─── 三维度进度条 ──────────────────────────────────
      const dimensions: Array<{ id: string; value: number; cssClass: string }> = [
        { id: 'uniqueness', value: data.scores.uniqueness, cssClass: 'uniqueness' },
        { id: 'freshness', value: data.scores.freshness, cssClass: 'freshness' },
        { id: 'completeness', value: data.scores.completeness, cssClass: 'completeness' },
      ];
      for (const dim of dimensions) {
        const fillEl = document.getElementById(`health-${dim.id}`);
        const valEl = document.getElementById(`health-${dim.id}-val`);
        if (fillEl) {
          fillEl.style.width = `${dim.value}%`;
          fillEl.className = `health-metric-fill ${dim.cssClass}`;
        }
        if (valEl) valEl.textContent = String(dim.value);
      }

      // ─── 详情计数（重复/过期/低质量） ──────────────────
      const duplicateCount = data.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
      const dupEl = document.getElementById('health-duplicates');
      if (dupEl) {
        dupEl.textContent = `重复: ${duplicateCount}`;
        dupEl.className = 'health-detail-item';
        if (duplicateCount > 0) dupEl.classList.add('warning');
      }

      const staleEl = document.getElementById('health-stale');
      if (staleEl) {
        staleEl.textContent = `过期: ${data.staleMemories.length}`;
        staleEl.className = 'health-detail-item';
        if (data.staleMemories.length > 0) staleEl.classList.add('warning');
      }

      const lowEl = document.getElementById('health-low-quality');
      if (lowEl) {
        lowEl.textContent = `低质量: ${data.lowQualityCount}`;
        lowEl.className = 'health-detail-item';
        if (data.lowQualityCount > 0) lowEl.classList.add('warning');
      }

      // ─── 健康描述 ──────────────────────────────────────
      const descEl = document.getElementById('health-description');
      if (descEl) descEl.textContent = data.healthDescription;

      // ─── 清理按钮：仅在有可清理项时显示 ──────────────
      const dupCount = data.duplicates.reduce((sum, g) => sum + g.memories.length, 0);
      const staleCount = data.staleMemories.length;
      const dupBtn = document.getElementById('health-cleanup-duplicates');
      const staleBtn = document.getElementById('health-cleanup-stale');
      const allBtn = document.getElementById('health-cleanup-all');
      const actionsEl = document.getElementById('health-actions');

      if (dupBtn) dupBtn.style.display = dupCount > 0 ? '' : 'none';
      if (staleBtn) staleBtn.style.display = staleCount > 0 ? '' : 'none';
      if (allBtn) allBtn.style.display = (dupCount > 0 || staleCount > 0) ? '' : 'none';
      if (actionsEl) actionsEl.style.display = (dupCount > 0 || staleCount > 0) ? '' : 'none';

    } catch (error) {
      reportError('loadHealthDashboard', error);
      // 加载失败时清空 currentHealthData，避免清理按钮基于过期数据触发
      currentHealthData = null;
      // 加载失败时显示带重试按钮的错误状态（与 loadMemoryList 的 showPanelError 一致）
      if (metricsEl) {
        clearElement(metricsEl);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';
        errorDiv.textContent = '加载失败';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'panel-error-btn inline-retry-btn';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', () => void loadHealthDashboard());
        errorDiv.appendChild(retryBtn);
        metricsEl.appendChild(errorDiv);
      }
      // 健康度加载失败不阻塞记忆面板主流程
    }
  }

  /** 加载记忆列表（Phase 2：支持组合筛选 + 客户端排序/时间过滤） */
  async function loadMemoryList(): Promise<void> {
    // FD-02 加载态：在 IPC 调用前显示加载指示器
    const listEl = document.getElementById('memory-list');
    if (listEl) showPanelLoading(listEl, '加载记忆列表...');

    try {
      const params = getSearchParams();
      const { memories } = await window.electronAPI.listMemories(
        params.source ? { source: params.source } : {},
      );
      // 客户端排序 + 时间过滤
      const filtered = applyClientFilters(memories, params);
      // 传递空字符串表示无搜索关键词（不高亮）
      // renderMemoryList 内部会 clearElement 清除加载态
      uiManager.renderMemoryList(filtered, '');

      // 更新仪表盘记忆计数
      const countEl = document.getElementById('memory-count');
      if (countEl) {
        countEl.textContent = String(filtered.length);
      }
    } catch (error) {
      reportError('loadMemoryList', error);
      // 加载失败时清除加载态，显示带重试按钮的内联错误状态
      // 与 loadInsights/loadHealthDashboard 一致——使用 createElement + textContent，避免 innerHTML（XSS 防御 + 项目规范）
      if (listEl) {
        clearElement(listEl);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';
        errorDiv.textContent = '加载记忆列表失败';
        const retryBtn = document.createElement('button');
        retryBtn.className = 'panel-error-btn inline-retry-btn';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', () => void loadMemoryList());
        errorDiv.appendChild(retryBtn);
        listEl.appendChild(errorDiv);
      }
      uiManager.showPanelError('memory', '加载记忆列表失败，请检查连接后重试', () => loadMemoryList());
    }
  }

  /**
   * QC-PERF-01 防抖定时器句柄（loadDashboard 高频调用时合并为单次执行）
   *
   * memoryNoticed/insightGained 事件密集触发时，避免每次都发起 IPC + DOM 操作，
   * 300ms 内的多次调用合并为一次。
   */
  let dashboardDebounceTimer: number | null = null;

  /** QC-PERF-01 防抖延迟（毫秒），在事件密集触发时合并 loadDashboard 调用 */
  const DASHBOARD_DEBOUNCE_MS = 300;

  /**
   * FD-03 加载完整仪表盘数据
   *
   * 对齐 CLI /dashboard 命令，在侧边栏仪表盘显示：
   * - 累积事件数 / 主动提示阈值（接近阈值黄色，达到阈值粉色）
   * - 已注册触发器数量（hover 看触发器名称列表）
   * - 推荐记忆列表（对齐方案 §6.3 推荐区）
   */
  async function loadDashboard(): Promise<void> {
    try {
      const data = await window.electronAPI.getDashboard();

      // 累积事件数 / 阈值
      const pendingEl = document.getElementById('pending-count');
      const dashPending = document.getElementById('dash-pending');
      if (pendingEl && dashPending) {
        pendingEl.textContent = `${data.pendingNotices}/${data.proactiveThreshold}`;
        // 高亮状态：接近阈值（>=80%）黄色，达到阈值粉色
        dashPending.classList.remove('near-threshold', 'at-threshold');
        if (data.pendingNotices >= data.proactiveThreshold) {
          dashPending.classList.add('at-threshold');
        } else if (data.proactiveThreshold > 0
          && data.pendingNotices / data.proactiveThreshold >= NEAR_THRESHOLD_RATIO) {
          dashPending.classList.add('near-threshold');
        }
      }

      // 已注册触发器数量（合并到事件卡片的 sub-value）
      const triggerEl = document.getElementById('trigger-count');
      const dashPending = document.getElementById('dash-pending');
      if (triggerEl && dashPending) {
        triggerEl.textContent = `${data.registeredTriggers.length} 触发器`;
        // hover 显示触发器名称列表
        const triggerList = data.registeredTriggers.length > 0
          ? data.registeredTriggers.join(', ')
          : '无触发器';
        // 更新 title（事件卡片 title 已包含基础信息，追加触发器详情）
        const baseTitle = dashPending.title.split(' · ')[0];
        dashPending.title = `${baseTitle} · 触发器：${triggerList}`;
      }

      // 渲染推荐记忆列表（合并到学习与回顾节）
      const recList = document.getElementById('recommendation-list');
      const learningSection = document.getElementById('learning-progress');
      if (recList && learningSection) {
        if (data.suggestions && data.suggestions.length > 0) {
          clearElement(recList);
          for (const s of data.suggestions) {
            const li = document.createElement('li');
            li.title = `${s.contentPreview}\n\n${s.reason}`;
            li.dataset.action = 'view-recommendation';
            li.dataset.memoryName = s.name;
            const nameSpan = document.createElement('span');
            nameSpan.textContent = s.name;
            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'suggestion-score';
            scoreSpan.textContent = s.relevance.toFixed(2);
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            recList.appendChild(li);
          }
          // 确保学习与回顾节可见
          learningSection.classList.remove('hidden');
        }
        // 无推荐时保持列表为空，不隐藏整个节（因为还有回顾数据）
      }

      // OBS-01 Agent 运行时指标渲染（消费内核 agent.getMetrics()）
      renderAgentMetrics(data.metrics);

      // 更新记忆总数（data.total 为全量记忆数，不受筛选影响）
      const memoryCountEl = document.getElementById('memory-count');
      if (memoryCountEl) memoryCountEl.textContent = String(data.total);

      // 更新洞察计数（bySource 中 source='insight' 的记忆数）
      const insightCount = data.bySource['insight'] ?? 0;
      const insightCountEl = document.getElementById('insight-count');
      if (insightCountEl) insightCountEl.textContent = String(insightCount);

      // 更新建议计数（suggestions 数组长度，供 updateLearningProgress 读取）
      const suggestionCountEl = document.getElementById('suggestion-count');
      if (suggestionCountEl) suggestionCountEl.textContent = String(data.suggestions.length);

      // GAP-1 已加载技能列表渲染（消费内核 agent.skills.list）
      renderSkills(data.skills);

      // H3 仪表盘加载完成后更新学习进度卡片
      uiManager.updateLearningProgress();

      // ─── 对话回顾数据（合并到学习与回顾节） ──────────────
      await loadReviewPanel();
    } catch (error) {
      reportError('loadDashboard', error);
    }
  }

  /**
   * 加载对话回顾数据（合并到学习与回顾节）
   *
   * 渲染到 #learning-progress 内的今日回顾行和趋势柱状图。
   * 不再有独立的 review-panel 和 recommendations 节。
   */
  async function loadReviewPanel(): Promise<void> {
    try {
      const data = await window.electronAPI.getReviewData();

      // ─── 今日概况 ──────────────────────────────────────
      const todayMemories = document.getElementById('review-today-memories');
      const todayInsights = document.getElementById('review-today-insights');
      if (todayMemories) todayMemories.textContent = String(data.today.newMemories);
      if (todayInsights) todayInsights.textContent = String(data.today.newInsights);

      // ─── 增长趋势 ──────────────────────────────────────
      const trendDir = document.getElementById('review-trend-dir');
      if (trendDir) {
        const dirMap: Record<string, string> = { growing: '↑', stable: '→', declining: '↓' };
        trendDir.textContent = dirMap[data.trend.direction] || '—';
        trendDir.className = `review-trend-direction ${data.trend.direction}`;
      }

      // ─── 趋势柱状图（7 天） ────────────────────────────
      const barsEl = document.getElementById('review-trend-bars');
      if (barsEl) {
        clearElement(barsEl);
        const maxCount = Math.max(1, ...data.trend.daily.map((d) => d.newMemories));
        const today = new Date().toISOString().slice(0, 10);
        for (const day of data.trend.daily) {
          const bar = document.createElement('div');
          bar.className = 'review-trend-bar';
          const height = Math.max(4, Math.round((day.newMemories / maxCount) * 36));
          bar.style.height = `${height}px`;
          if (day.date === today) bar.classList.add('today');
          bar.title = `${day.date}: ${day.newMemories} 条记忆`;
          barsEl.appendChild(bar);
        }
      }

      // ─── 最近洞察列表（渲染 ReviewData.insights.recent） ─
      const insightsListEl = document.getElementById('recent-insights-list');
      if (insightsListEl) {
        clearElement(insightsListEl);
        for (const insight of data.insights.recent) {
          const li = document.createElement('li');
          li.className = 'recent-insight-item';
          const nameEl = document.createElement('span');
          nameEl.className = 'recent-insight-name';
          nameEl.textContent = insight.name;
          const previewEl = document.createElement('span');
          previewEl.className = 'recent-insight-preview';
          previewEl.textContent = insight.contentPreview;
          li.appendChild(nameEl);
          li.appendChild(previewEl);
          insightsListEl.appendChild(li);
        }
      }

    } catch (error) {
      reportError('loadReviewPanel', error);
    }
  }

  /**
   * 仪表盘计数 +1 并触发脉冲动画
   *
   * 对齐 HTML 预览 §6.3 .stat-value.pulse。
   * 由精灵事件监听器在 memoryNoticed/insightGained 事件时调用。
   */
  function pulseCounter(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(parseInt(el.textContent ?? '0') + 1);
    el.classList.add('pulse');
    // IX-03 跟踪定时器句柄，支持 beforeunload 时统一清理
    const timer = window.setTimeout(() => {
      el.classList.remove('pulse');
      // 从跟踪数组中移除已完成的定时器
      const idx = pulseTimers.indexOf(timer);
      if (idx !== -1) pulseTimers.splice(idx, 1);
    }, DASHBOARD_PULSE_MS);
    pulseTimers.push(timer);
  }

  /**
   * OBS-01 渲染 Agent 运行时指标
   *
   * 消费内核 agent.getMetrics() 数据，在仪表盘中展示 6 项运行时指标：
   * - LLM 调用次数 / Token 数 / 召回命中率 / 工具失败率 / 截断次数 / 衰减次数
   *
   * 无数据时隐藏指标区域。token 数超过 1000 时显示为 "1.2k" 格式。
   *
   * @param metrics Agent 运行时指标快照（null 表示不可用）
   */
  function renderAgentMetrics(metrics: {
    llm: {
      callCount: number;
      totalInputTokens: number;
      totalOutputTokens: number;
    };
    recall: {
      totalCount: number;
      hitCount: number;
      hitRate: number;
    };
    tools: {
      callCount: number;
      failureCount: number;
    };
    context: {
      truncationCount: number;
      messageCount: number;
      estimatedTokens: number;
    };
    decay: {
      runCount: number;
      totalDecayedCount: number;
      lastRunAt: string | null;
    } | null;
  } | null): void {
    const metricsSection = document.getElementById('agent-metrics');
    if (!metricsSection) return;

    // 无数据时隐藏
    if (!metrics) {
      metricsSection.classList.add('hidden');
      return;
    }

    metricsSection.classList.remove('hidden');

    // LLM 调用次数
    const callsEl = document.getElementById('metric-llm-calls');
    if (callsEl) {
      callsEl.textContent = String(metrics.llm.callCount);
    }

    // Token 数（输入 + 输出，超过 1000 显示 k 格式）
    const tokensEl = document.getElementById('metric-llm-tokens');
    if (tokensEl) {
      const totalTokens = metrics.llm.totalInputTokens + metrics.llm.totalOutputTokens;
      tokensEl.textContent = formatTokenCount(totalTokens);
    }

    // 召回命中率（百分比，保留 0 位小数）
    const recallEl = document.getElementById('metric-recall-hit');
    if (recallEl) {
      recallEl.textContent = `${Math.round(metrics.recall.hitRate * 100)}%`;
    }

    // 工具失败率（callCount=0 时显示 "—"，避免 0/0 误显示为 0%）
    const toolFailEl = document.getElementById('metric-tool-fail');
    if (toolFailEl) {
      if (metrics.tools.callCount > 0) {
        const failRate = metrics.tools.failureCount / metrics.tools.callCount;
        toolFailEl.textContent = `${Math.round(failRate * 100)}%`;
      } else {
        toolFailEl.textContent = '—';
      }
    }

    // 上下文截断次数
    const truncEl = document.getElementById('metric-context-trunc');
    if (truncEl) {
      truncEl.textContent = String(metrics.context.truncationCount);
    }

    // 衰减次数 / 累计衰减条数
    const decayEl = document.getElementById('metric-decay');
    if (decayEl) {
      const runCount = metrics.decay?.runCount ?? 0;
      const totalDecayed = metrics.decay?.totalDecayedCount ?? 0;
      decayEl.textContent = `${runCount}/${totalDecayed}`;
    }
  }

  /**
   * GAP-1 渲染已加载技能列表
   *
   * 消费内核 agent.skills.list，在设置面板"技能"选项卡展示当前加载的技能。
   * 每个技能项展示名称、关键词标签和来源层级（project/agent）。
   * 无技能时隐藏列表区域，显示空状态占位。
   *
   * @param skills 技能列表（由 DASHBOARD_GET 返回）
   */
  function renderSkills(skills: Array<{ name: string; keywords: string[]; description: string; layer: string }>): void {
    // 更新仪表盘技能计数（合并到事件卡片的 sub-value）
    const countEl = document.getElementById('skill-count');
    if (countEl) {
      countEl.textContent = `${skills.length} 技能`;
    }

    const listEl = document.getElementById('skills-list');
    const sectionEl = document.getElementById('skills-section');
    const emptyEl = document.getElementById('skills-empty');
    if (!listEl || !sectionEl) return;

    if (!skills || skills.length === 0) {
      sectionEl.classList.add('hidden');
      // 显示空状态占位（设置面板技能选项卡）
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    clearElement(listEl);

    // QC-PERF-02：使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const fragment = document.createDocumentFragment();

    for (const skill of skills) {
      const li = document.createElement('li');
      li.className = 'skill-item';
      li.title = skill.description || skill.name;

      // 技能名称
      const nameSpan = document.createElement('span');
      nameSpan.className = 'skill-name';
      nameSpan.textContent = skill.name;

      // 来源层级标签（project/agent）
      const layerSpan = document.createElement('span');
      layerSpan.className = `skill-layer skill-layer-${skill.layer}`;
      layerSpan.textContent = skill.layer === 'agent' ? '全局' : '项目';

      // 关键词标签
      if (skill.keywords.length > 0) {
        const kwSpan = document.createElement('span');
        kwSpan.className = 'skill-keywords';
        kwSpan.textContent = skill.keywords.slice(0, 5).join(' · ');
        li.appendChild(nameSpan);
        li.appendChild(layerSpan);
        li.appendChild(kwSpan);
      } else {
        li.appendChild(nameSpan);
        li.appendChild(layerSpan);
      }

      fragment.appendChild(li);
    }

    listEl.appendChild(fragment);
    sectionEl.classList.remove('hidden');
    // 隐藏空状态占位（有技能时）
    if (emptyEl) emptyEl.classList.add('hidden');
  }

  /**
   * QC-PERF-01 防抖版 loadDashboard
   *
   * 在事件密集触发时（memoryNoticed/insightGained），300ms 内的多次调用合并为一次。
   * 首次调用（如 Agent 就绪后初始化）立即执行，后续调用延迟合并。
   */
  function loadDashboardDebounced(): void {
    if (dashboardDebounceTimer !== null) {
      window.clearTimeout(dashboardDebounceTimer);
    }
    dashboardDebounceTimer = window.setTimeout(async () => {
      dashboardDebounceTimer = null;
      await loadDashboard();
    }, DASHBOARD_DEBOUNCE_MS);
  }

  /**
   * Phase 2.1：更新情感基调展示（四维进度条）
   *
   * 由 affectUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
   *
   * @param affect 四维情感基调数值
   */
  function updateAffectDisplay(affect: { warmth: number; playfulness: number; directness: number; initiative: number }): void {
    // 定义四维映射：id 前缀 → 数值
    const dimensions: Array<{ id: string; value: number }> = [
      { id: 'warmth', value: affect.warmth },
      { id: 'directness', value: affect.directness },
      { id: 'initiative', value: affect.initiative },
      { id: 'playfulness', value: affect.playfulness },
    ];

    // ─── 仪表盘进度条（仅在仪表盘已加载时更新） ──────
    const affectDisplay = document.getElementById('affect-display');
    if (affectDisplay) {
      affectDisplay.classList.remove('hidden');

      for (const dim of dimensions) {
        const fillEl = document.getElementById(`affect-${dim.id}`);
        const levelEl = document.getElementById(`affect-${dim.id}-level`);
        if (!fillEl || !levelEl) continue;

        fillEl.style.width = `${Math.round(dim.value * 100)}%`;
        fillEl.style.background = getAffectColor(dim.value);
        levelEl.textContent = getAffectLevel(dim.value);
      }
    }

    // ─── Phase 2.2：对话面板情感指示器（四色圆点，始终可见） ────
    const chatIndicator = document.getElementById('chat-affect-indicator');
    if (chatIndicator) {
      chatIndicator.classList.remove('hidden');
      for (const dim of dimensions) {
        const dotEl = document.getElementById(`chat-affect-${dim.id}`);
        if (dotEl) {
          dotEl.style.background = getAffectColor(dim.value);
          // 更新 title 属性：hover 时显示维度名 + 等级
          dotEl.title = `${dotEl.title.split('：')[0]}：${getAffectLevel(dim.value)}`;
        }
      }
    }
  }

  /**
   * 将 0-1 数值映射为中文等级描述
   */
  function getAffectLevel(value: number): string {
    if (value < 0.33) return '低';
    if (value < 0.67) return '中';
    return '高';
  }

  /**
   * 将 0-1 数值映射为进度条颜色（CSS 变量引用）
   *
   * 低→var(--affect-low) 中→var(--affect-mid) 高→var(--affect-high)
   * 使用 CSS 变量支持主题切换
   */
  function getAffectColor(value: number): string {
    if (value < 0.33) return 'var(--affect-low)';
    if (value < 0.67) return 'var(--affect-mid)';
    return 'var(--affect-high)';
  }

  /**
   * 将默契度等级映射为中文标签（Phase 3）
   */
  function getRapportLevelLabel(level: string): string {
    switch (level) {
      case 'stranger': return '初识';
      case 'acquaintance': return '相识';
      case 'familiar': return '熟悉';
      case 'close': return '亲密';
      default: return level;
    }
  }

  /**
   * 将对话节奏映射为中文标签（Phase 4，与 ContextAwareness.describeRhythm 一致）
   */
  function describeRhythm(rhythm: string): string {
    switch (rhythm) {
      case 'rapid': return '快节奏';
      case 'normal': return '正常';
      case 'slow': return '慢节奏';
      case 'idle': return '空闲';
      default: return rhythm;
    }
  }

  /**
   * 将话题连贯性映射为中文标签（Phase 4，与 ContextAwareness.describeCoherence 一致）
   */
  function describeCoherence(coherence: string): string {
    switch (coherence) {
      case 'focused': return '专注';
      case 'moderate': return '中等';
      case 'scattered': return '分散';
      case 'none': return '无';
      default: return coherence;
    }
  }

  /**
   * 将对话深度映射为中文标签（Phase 4，与 ContextAwareness.describeDepth 一致）
   */
  function describeDepth(depth: string): string {
    switch (depth) {
      case 'deep': return '深度讨论';
      case 'moderate': return '一般讨论';
      case 'shallow': return '浅层问答';
      case 'none': return '无';
      default: return depth;
    }
  }

  /**
   * Phase 2+：模式类型 → 图标映射
   *
   * 用于洞察面板中每个模式项的图标展示。
   */
  function getPatternDetectorIcon(type: string): string {
    switch (type) {
      case 'recurring_topic': return '🔄';
      case 'knowledge_gap': return '❓';
      case 'interest_drift': return '📈';
      default: return '💡';
    }
  }

  // ─── FD-01 叙事摘要：闭包级状态（跨事件累积，供 generateNarrative 合成） ──

  /** 最近一次上下文状态 */
  let lastNarrativeContext: { rhythm: string; coherence: string; depth: string; dominantSource: string | null } | null = null;
  /** 最近一次情感基调 */
  let lastNarrativeAffect: { warmth: number; directness: number; initiative: number; playfulness: number } | null = null;
  /** 最近一次默契度 */
  let lastNarrativeRapport: { level: string; trust: number } | null = null;
  /** 最近一次检测到的模式 */
  let lastNarrativePatterns: Array<{ type: string; summary: string }> = [];

  /**
   * FD-01 综合感知系统输出，生成一句话叙事摘要
   *
   * 数据来源：ContextAwareness + AffectController + RapportController + PatternDetector
   * 纯客户端合成，不触发 IPC，不依赖 LLM。
   */
  function generateNarrative(): string {
    const parts: string[] = [];

    // 对话上下文
    if (lastNarrativeContext && lastNarrativeContext.rhythm !== 'idle') {
      const rhythmLabel = describeRhythm(lastNarrativeContext.rhythm);
      parts.push(`对话节奏${rhythmLabel}`);
    }
    if (lastNarrativeContext && lastNarrativeContext.coherence === 'focused' && lastNarrativeContext.dominantSource) {
      parts.push(`正在专注讨论${lastNarrativeContext.dominantSource}相关话题`);
    } else if (lastNarrativeContext && lastNarrativeContext.coherence === 'scattered') {
      parts.push('话题较为分散');
    }

    // 互动基调
    if (lastNarrativeAffect) {
      const tones: string[] = [];
      if (lastNarrativeAffect.warmth > 0.6) tones.push('温暖');
      if (lastNarrativeAffect.directness > 0.6) tones.push('直接');
      if (lastNarrativeAffect.initiative > 0.6) tones.push('主动');
      if (tones.length > 0) {
        parts.push(`基调${tones.join('、')}`);
      }
    }

    // 默契度
    if (lastNarrativeRapport) {
      const levelLabel = getRapportLevelLabel(lastNarrativeRapport.level);
      if (levelLabel !== '初识') {
        parts.push(`默契度：${levelLabel}`);
      }
    }

    // 模式洞察
    if (lastNarrativePatterns.length > 0) {
      const recurringCount = lastNarrativePatterns.filter(p => p.type === 'recurring_topic').length;
      const gapCount = lastNarrativePatterns.filter(p => p.type === 'knowledge_gap').length;
      const patternDescs: string[] = [];
      if (recurringCount > 0) patternDescs.push(`${recurringCount} 个重复主题`);
      if (gapCount > 0) patternDescs.push(`${gapCount} 个知识缺口`);
      if (patternDescs.length > 0) {
        parts.push(`检测到${patternDescs.join('、')}`);
      }
    }

    if (parts.length === 0) {
      return '精灵正在感知中...';
    }

    return parts.join('，') + '。';
  }

  /**
   * FD-01 更新叙事摘要 DOM
   *
   * 每次感知数据更新时调用，渲染到 #sprite-narrative。
   */
  function updateNarrative(): void {
    const narrativeEl = document.getElementById('sprite-narrative');
    const textEl = document.getElementById('sprite-narrative-text');
    if (!narrativeEl || !textEl) return;

    const narrative = generateNarrative();
    // FD-03 仅当叙事文本实际变化时触发脉冲动画
    const textChanged = textEl.textContent !== narrative;
    textEl.textContent = narrative;

    // FD-03 叙事卡片始终可见，只切换 active/idle 状态
    if (lastNarrativeContext?.rhythm === 'idle' || !lastNarrativeContext) {
      narrativeEl.classList.add('idle');
      narrativeEl.classList.remove('active');
    } else {
      narrativeEl.classList.add('active');
      narrativeEl.classList.remove('idle');
    }

    // FD-03 同步更新对话面板叙事摘要行
    const chatNarrativeText = document.getElementById('chat-narrative-text');
    if (chatNarrativeText) {
      chatNarrativeText.textContent = narrative;
    }

    // FD-03 感知数据变化时触发脉冲动画（去重：仅文本变化时触发）
    if (textChanged) {
      narrativeEl.classList.remove('narrative-updated');
      void narrativeEl.offsetWidth; // 强制回流以重新触发动画
      narrativeEl.classList.add('narrative-updated');

      // 同步脉冲动画到对话面板叙事行
      const chatNarrative = document.getElementById('chat-narrative');
      if (chatNarrative) {
        chatNarrative.classList.remove('narrative-updated');
        void chatNarrative.offsetWidth;
        chatNarrative.classList.add('narrative-updated');
      }
    }
  }

  return {
    setupMemoryPanel,
    loadMemoryList,
    loadDashboard,
    loadHealthDashboard,
    /** QC-PERF-01 防抖版 loadDashboard（事件密集触发时使用） */
    loadDashboardDebounced,
    pulseCounter,
    /**
     * Phase 2.1：更新情感基调展示（四维进度条）
     *
     * 由 affectUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
     * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
     */
    updateAffectDisplay: (affect: { warmth: number; playfulness: number; directness: number; initiative: number }) => {
      // FD-01：保存状态供叙事摘要合成
      lastNarrativeAffect = affect;
      updateAffectDisplay(affect);
      updateNarrative();
    },
    /**
     * Phase 3：更新默契度展示（等级徽章 + 双进度条 + 描述）
     *
     * 由 rapportUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
     */
    updateRapportDisplay: (rapport: { trust: number; familiarity: number; level: string; description: string }) => {
      const rapportDisplay = document.getElementById('rapport-display');
      if (!rapportDisplay) return;

      // 显示默契度卡片
      rapportDisplay.classList.remove('hidden');

      // 更新等级徽章
      const badgeEl = document.getElementById('rapport-level-badge');
      if (badgeEl) {
        badgeEl.textContent = getRapportLevelLabel(rapport.level);
        badgeEl.setAttribute('data-level', rapport.level);
      }

      // 更新信任度进度条
      const trustFill = document.getElementById('rapport-trust');
      const trustLevel = document.getElementById('rapport-trust-level');
      if (trustFill && trustLevel) {
        trustFill.style.width = `${Math.round(rapport.trust * 100)}%`;
        trustFill.style.background = getAffectColor(rapport.trust);
        trustLevel.textContent = getAffectLevel(rapport.trust);
      }

      // 更新熟悉度进度条
      const familiarityFill = document.getElementById('rapport-familiarity');
      const familiarityLevel = document.getElementById('rapport-familiarity-level');
      if (familiarityFill && familiarityLevel) {
        familiarityFill.style.width = `${Math.round(rapport.familiarity * 100)}%`;
        familiarityFill.style.background = getAffectColor(rapport.familiarity);
        familiarityLevel.textContent = getAffectLevel(rapport.familiarity);
      }

      // 更新描述文本
      const descEl = document.getElementById('rapport-description');
      if (descEl) {
        descEl.textContent = rapport.description;
      }
      // FD-01：保存状态供叙事摘要合成
      lastNarrativeRapport = { level: rapport.level, trust: rapport.trust };
      updateNarrative();
    },
    /**
     * Phase 4：更新对话上下文展示（三列指标）
     *
     * 由 contextUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
     */
    updateContextDisplay: (context: { rhythm: string; coherence: string; depth: string; dominantSource: string | null; description: string }) => {
      const contextDisplay = document.getElementById('context-display');
      if (!contextDisplay) return;

      // 显示上下文卡片
      contextDisplay.classList.remove('hidden');

      // 更新节奏
      const rhythmEl = document.getElementById('context-rhythm');
      if (rhythmEl) {
        rhythmEl.textContent = describeRhythm(context.rhythm);
      }

      // 更新话题
      const coherenceEl = document.getElementById('context-coherence');
      if (coherenceEl) {
        coherenceEl.textContent = describeCoherence(context.coherence);
      }

      // 更新深度
      const depthEl = document.getElementById('context-depth');
      if (depthEl) {
        depthEl.textContent = describeDepth(context.depth);
      }

      // 更新描述文本
      const descEl = document.getElementById('context-description');
      if (descEl) {
        descEl.textContent = context.description;
      }
      // FD-01：保存状态供叙事摘要合成
      lastNarrativeContext = {
        rhythm: context.rhythm,
        coherence: context.coherence,
        depth: context.depth,
        dominantSource: context.dominantSource,
      };
      updateNarrative();
    },
    /**
     * Phase 2+：更新模式洞察面板（PatternDetector 检测结果）
     *
     * 由 patternsUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
     * 展示重复主题、知识缺口和兴趣漂移等检测到的用户模式。
     */
    updatePatternsDisplay: (payload: { patterns: Array<{ type: string; summary: string; confidence: number; suggestion?: string }> }) => {
      // FD-01：保存状态供叙事摘要合成
      lastNarrativePatterns = payload.patterns.map(p => ({ type: p.type, summary: p.summary }));

      const patternsDisplay = document.getElementById('patterns-display');
      if (!patternsDisplay) {
        updateNarrative();
        return;
      }

      const patternsList = document.getElementById('patterns-list');
      if (!patternsList) {
        updateNarrative();
        return;
      }

      // 无模式数据时隐藏（但仍更新叙事摘要）
      if (payload.patterns.length === 0) {
        patternsDisplay.classList.add('hidden');
        updateNarrative();
        return;
      }

      // 显示洞察面板
      patternsDisplay.classList.remove('hidden');

      // 清空并重建列表
      while (patternsList.firstChild) {
        patternsList.removeChild(patternsList.firstChild);
      }

      for (const pattern of payload.patterns) {
        const item = document.createElement('div');
        item.className = 'pattern-item';

        // 图标：根据模式类型选择
        const icon = document.createElement('span');
        icon.className = 'pattern-icon';
        icon.textContent = getPatternDetectorIcon(pattern.type);

        // 文本
        const text = document.createElement('span');
        text.className = 'pattern-text';
        text.textContent = pattern.summary;

        item.appendChild(icon);
        item.appendChild(text);

        patternsList.appendChild(item);
      }

      updateNarrative();
    },
    /**
     * FD-01 更新叙事摘要（综合感知系统输出）
     *
     * 由渲染器在每次感知数据更新后调用，不需要额外参数。
     * 内部从闭包级状态变量合成叙事文本。
     */
    updateNarrative: () => {
      updateNarrative();
    },
    /** IX-03 清理脉冲动画定时器 + 防抖定时器（由 renderer.ts beforeunload 调用） */
    cleanup: () => {
      for (const t of pulseTimers) window.clearTimeout(t);
      pulseTimers = [];
      if (dashboardDebounceTimer !== null) {
        window.clearTimeout(dashboardDebounceTimer);
        dashboardDebounceTimer = null;
      }
    },
  };
}
