/**
 * 记忆控制器 — 记忆面板业务编排 + 仪表盘数据加载
 *
 * 职责：
 * - 设置记忆面板回调（搜索/筛选/点击/删除/添加）
 * - 加载记忆列表（IPC + 客户端排序/过滤，渲染委托 UIManager）
 * - 加载仪表盘数据（IPC 编排，渲染委托 DashboardPanelManager）
 * - 加载洞察/健康度数据（IPC 编排，渲染委托 DashboardPanelManager）
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - 搜索回调内置序列号竞态保护（防止快速输入时旧结果覆盖新结果）
 * - Controller 仅做 IPC 编排 + 数据加工，所有 DOM 渲染委托 PanelManager
 * - 渲染错误状态由 DashboardPanelManager.showXxxError 渲染，重试按钮通过 onReloadXxx 回调触发 Controller 重新加载
 */

import type { UIManager } from '../ui.js';
import { setButtonLoading, showPanelLoading } from '../helpers/domHelpers.js';
import type { MemoryListItem } from '../types.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';
import type { HealthDashboardPayload } from '../../preload.js';
// 复用内核 getDuplicateRemovalIds 计算待清理 ID
import { getDuplicateRemovalIds } from '../../../sprite/controllers/memoryHealth.js';

/**
 * 获取当前搜索参数（组合搜索，模块级）
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
 * 客户端排序 + 时间过滤（搜索增强，模块级）
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

/** QC-PERF-01 防抖延迟（毫秒），在事件密集触发时合并 loadDashboard 调用 */
const DASHBOARD_DEBOUNCE_MS = 300;

/**
 * 创建记忆控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 记忆控制器接口（设置回调、加载列表、加载仪表盘）
 */
export function createMemoryController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /** 存储当前健康度数据，供清理操作使用（闭包级，setupMemoryPanel 和 loadHealthDashboard 共享） */
  let currentHealthData: HealthDashboardPayload | null = null;

  /**
   * 设置记忆面板回调
   *
   * 包含搜索（带竞态保护）、筛选、点击查看详情、删除、添加。
   * 此处仅注册业务逻辑回调，DOM 事件绑定由 MemoryPanelManager.initMemoryPanelListeners() 完成。
   */
  function setupMemoryPanel(): void {
    // 搜索请求序列号：防止快速输入时旧结果覆盖新结果（竞态保护）
    let searchSeq = 0;

    // ─── 注册仪表盘重试回调（重试按钮由 DashboardPanelManager 渲染） ──
    uiManager.onReloadInsights(() => void loadInsights());
    uiManager.onReloadHealth(() => void loadHealthDashboard());
    uiManager.onReloadMemoryList(() => void loadMemoryList());

    // ─── 更多菜单项回调：切换洞察/健康度面板时加载数据 ────
    uiManager.onMoreMenuAction(async (action: string) => {
      if (action === 'insights') {
        await loadInsights();
      } else if (action === 'health') {
        await loadHealthDashboard();
      }
    });

    // ─── 排序/时间范围变更：触发重新搜索或加载列表 ────────
    const triggerSearchOrReload = () => {
      const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
      if (searchInput && searchInput.value.trim()) {
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        void loadMemoryList();
      }
    };
    uiManager.onSortChange(triggerSearchOrReload);
    uiManager.onTimeRangeChange(triggerSearchOrReload);

    // ─── 清理按钮回调：返回待清理ID列表，由PanelManager显示确认对话框 ──
    uiManager.onCleanupRequest((type: 'duplicates' | 'stale' | 'all'): string[] => {
      if (!currentHealthData) return [];
      if (type === 'duplicates') {
        return getDuplicateRemovalIds(currentHealthData.duplicates);
      } else if (type === 'stale') {
        return currentHealthData.staleMemories.map((s) => s.memory.id);
      } else {
        const dupIds = getDuplicateRemovalIds(currentHealthData.duplicates);
        const staleIds = currentHealthData.staleMemories.map((s) => s.memory.id);
        return [...new Set([...dupIds, ...staleIds])];
      }
    });

    // ─── 清理确认回调：执行批量删除IPC ──────────────────
    uiManager.onCleanupConfirm(async (ids: string[]) => {
      try {
        const result = await window.electronAPI.deleteMemoriesBatch(ids);
        uiManager.showToast(`已清理 ${result.deleted}/${result.total} 条记忆`, 'success');
        // 刷新健康度仪表盘和记忆列表
        await loadHealthDashboard();
        await loadMemoryList();
      } catch (error) {
        reportError('cleanupConfirm', error);
        uiManager.showToast('清理失败，请重试', 'error');
      }
    });

    // ─── 视图切换回调：切换到图谱时加载数据 ──────────────
    uiManager.onViewSwitch(async (mode) => {
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

    // 搜索回调（组合搜索 — 关键词 + source + 排序 + 时间）
    uiManager.onMemorySearch(async (query: string) => {
      const params = getSearchParams();
      if (!query) {
        // 空搜索：加载全部（保留 source 筛选），清除图谱高亮
        uiManager.clearGraphHighlights();
        await loadMemoryList();
        return;
      }
      // 递增序列号，捕获当前请求的序号
      const seq = ++searchSeq;
      try {
        const { hits } = await window.electronAPI.searchMemories(query);
        // 若在等待期间有更新的搜索请求发起，丢弃本次过期结果
        if (seq !== searchSeq) return;
        let items: MemoryListItem[] = hits.map((h) => ({
          id: h.id,
          name: h.name,
          source: h.source,
          score: h.similarity ?? h.score,
          contentPreview: h.contentPreview,
          createdAt: h.createdAt,
        }));
        // 客户端 source 筛选（搜索 API 不支持 source 参数，客户端过滤）
        if (params.source) {
          items = items.filter((item) => item.source === params.source);
        }
        // 客户端排序 + 时间过滤
        items = applyClientFilters(items, params);
        // 传递搜索关键词用于高亮
        uiManager.renderMemoryList(items, query);
        // 图谱联动：搜索命中节点高亮，非命中节点淡化
        uiManager.highlightGraphNodes(items.map((item) => item.id));
      } catch (error) {
        // IX-02 搜索失败时保持原列表，但给用户可见反馈
        if (seq !== searchSeq) return;
        reportError('onMemorySearch', error);
        uiManager.showToast('搜索记忆失败，请重试', 'error');
      }
    });

    // 筛选回调（触发时重新加载，应用当前全部筛选条件）
    uiManager.onMemoryFilter((_source: string) => {
      void loadMemoryList();
    });

    // 点击记忆条目：查看详情 + 图谱联动选中节点
    uiManager.onMemoryClick(async (id: string) => {
      // 图谱联动：选中该节点，显示外发光环并平滑居中
      uiManager.selectGraphNode(id);
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
      // 删除是不可恢复操作，需防重复点击（与 onMemoryAdd/onMemoryEdit 一致）
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
        // 恢复按钮状态（弹窗已关闭时 setButtonLoading 内部会安全降级）
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
    // id 参数未使用（编辑时通过 dataset 获取 source/name），加下划线前缀
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
  }

  /**
   * 加载记忆洞察数据（Phase 3：记忆洞察面板）
   *
   * 并行请求仪表盘数据和关系图谱数据，聚合后委托 DashboardPanelManager 渲染：
   * - 统计卡片：记忆总数 / 关系数 / 来源数
   * - source 分布：CSS 条形图（零依赖，无需图表库）
   * - 关系摘要：最近 3 条关系 + 类型标签
   *
   * 纯代码计算，不增加 LLM 调用。
   */
  async function loadInsights(): Promise<void> {
    // FD-02 加载态：在 IPC 调用前显示加载指示器（委托 DashboardPanelManager）
    uiManager.showInsightsLoading();

    try {
      // 并行请求（Promise.all 避免串行延迟）
      const [dashboard, graph] = await Promise.all([
        window.electronAPI.getDashboard(),
        window.electronAPI.getRelationGraph(),
      ]);

      // 渲染委托 DashboardPanelManager
      uiManager.renderInsights(dashboard, graph);
    } catch (error) {
      reportError('loadInsights', error);
      // 渲染错误状态（含重试按钮，点击触发 onReloadInsights 回调）
      uiManager.showInsightsError();
      // 洞察加载失败不阻塞记忆面板主流程
    }
  }

  /**
   * 加载记忆健康度仪表盘数据（Phase 1：健康度诊断）
   *
   * 请求 IPC 获取健康度数据，渲染委托 DashboardPanelManager：
   * - 健康度评分（总分 + 三维度进度条）
   * - 健康等级徽章
   * - 重复/过期/低质量计数
   * - 健康描述文字
   *
   * 纯 DOM 操作，不依赖 LLM。
   */
  async function loadHealthDashboard(): Promise<void> {
    // FD-02 加载态：在 IPC 调用前显示加载指示器（委托 DashboardPanelManager）
    uiManager.showHealthLoading();

    try {
      const data = await window.electronAPI.getHealthDashboard();

      // 存储数据供清理操作使用
      currentHealthData = data;

      // 渲染委托 DashboardPanelManager
      uiManager.renderHealthDashboard(data);
    } catch (error) {
      reportError('loadHealthDashboard', error);
      // 加载失败时清空 currentHealthData，避免清理按钮基于过期数据触发
      currentHealthData = null;
      // 渲染错误状态（含重试按钮，点击触发 onReloadHealth 回调）
      uiManager.showHealthError();
      // 健康度加载失败不阻塞记忆面板主流程
    }
  }

  /** 加载记忆列表（支持组合筛选 + 客户端排序/时间过滤） */
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
      // 加载全部记忆时清除搜索高亮（保留选中状态）
      uiManager.highlightGraphNodes(null);
    } catch (error) {
      reportError('loadMemoryList', error);
      // 加载失败时渲染错误状态（含重试按钮，点击触发 onReloadMemoryList 回调）
      if (listEl) {
        uiManager.showMemoryListError(listEl);
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

  /**
   * FD-03 加载完整仪表盘数据
   *
   * 对齐 CLI /dashboard 命令，在侧边栏仪表盘显示：
   * - 累积事件数 / 主动提示阈值（接近阈值黄色，达到阈值粉色）
   * - 已注册触发器数量（hover 看触发器名称列表）
   * - 推荐记忆列表（对齐方案 §6.3 推荐区）
   * - Agent 运行时指标、技能列表、里程碑成就、对话回顾
   *
   * 所有渲染委托 DashboardPanelManager，Controller 仅做 IPC 编排和聚合。
   */
  async function loadDashboard(): Promise<void> {
    try {
      const data = await window.electronAPI.getDashboard();

      // 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
      uiManager.renderDashboardStats(data);

      // OBS-01 Agent 运行时指标渲染（消费内核 agent.getMetrics()）
      uiManager.renderAgentMetrics(data.metrics);

      // GAP-1 已加载技能列表渲染（消费内核 agent.skills.list）
      uiManager.renderSkills(data.skills);

      // 里程碑成就展示（从仪表盘数据实时推导）
      uiManager.renderMilestones(data);

      // H3 仪表盘加载完成后更新学习进度卡片
      uiManager.updateLearningProgress();

      // ─── 对话回顾数据（合并到学习与回顾节） ──────────────
      const reviewData = await window.electronAPI.getReviewData();
      uiManager.renderReviewData(reviewData);
    } catch (error) {
      reportError('loadDashboard', error);
      // 仪表盘涉及多子区域（统计/指标/技能/里程碑/回顾），整体失败时用 toast 兜底提示
      uiManager.showToast('仪表盘加载失败，请稍后重试', 'error');
    }
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

  return {
    setupMemoryPanel,
    loadMemoryList,
    loadDashboard,
    loadHealthDashboard,
    /** QC-PERF-01 防抖版 loadDashboard（事件密集触发时使用） */
    loadDashboardDebounced,
    /** 仪表盘计数 +1 并触发脉冲动画（委托 DashboardPanelManager） */
    pulseCounter: (id: string) => uiManager.pulseCounter(id),
    /**
     * 更新情感基调展示（委托 DashboardPanelManager）
     *
     * 由 affectUpdated 事件驱动，Controller 仅做转发。
     */
    updateAffectDisplay: (affect: { warmth: number; playfulness: number; directness: number; initiative: number }) => {
      uiManager.updateAffectDisplay(affect);
    },
    /**
     * Phase 3：更新默契度展示（委托 DashboardPanelManager）
     *
     * 由 rapportUpdated 事件驱动，Controller 仅做转发。
     */
    updateRapportDisplay: (rapport: { trust: number; familiarity: number; level: string; description: string }) => {
      uiManager.updateRapportDisplay(rapport);
    },
    /**
     * Phase 4：更新对话上下文展示（委托 DashboardPanelManager）
     *
     * 由 contextUpdated 事件驱动，Controller 仅做转发。
     */
    updateContextDisplay: (context: { rhythm: string; coherence: string; depth: string; dominantSource: string | null; description: string }) => {
      uiManager.updateContextDisplay(context);
    },
    /**
     * 更新模式洞察面板（委托 DashboardPanelManager）
     *
     * 由 patternsUpdated 事件驱动，Controller 仅做转发。
     */
    updatePatternsDisplay: (payload: { patterns: Array<{ type: string; summary: string; confidence: number; suggestion?: string }> }) => {
      uiManager.updatePatternsDisplay(payload);
    },
    /**
     * FD-01 更新叙事摘要（委托 DashboardPanelManager）
     *
     * 由渲染器在每次感知数据更新后调用，不需要额外参数。
     */
    updateNarrative: () => {
      uiManager.updateNarrative();
    },
    /** IX-03 清理防抖定时器（由 renderer.ts beforeunload 调用） */
    cleanup: () => {
      if (dashboardDebounceTimer !== null) {
        window.clearTimeout(dashboardDebounceTimer);
        dashboardDebounceTimer = null;
      }
    },
  };
}
