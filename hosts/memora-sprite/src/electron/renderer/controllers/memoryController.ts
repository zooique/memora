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
import { setButtonLoading } from '../helpers/domHelpers.js';
import type { MemoryListItem } from '../types.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';
// P1 类型统一：感知数据 Payload 类型从 ipcListeners 导入，消除内联类型重复
import type { AffectPayload, RapportPayload, ContextPayload, PatternsPayload, PresencePayload } from '../ipcListeners.js';
import type { HealthDashboardPayload } from '../../preload.js';
// 复用内核 getDuplicateRemovalIds 计算待清理 ID
import { getDuplicateRemovalIds } from '../../../sprite/controllers/memoryHealth.js';
// 复用 sprite 共享时间常量，避免硬编码 24*60*60*1000
import { MS_PER_DAY, DASHBOARD_DEBOUNCE_MS } from '../../../sprite/constants.js';

// getSearchParams 已移至 UIManager.getMemorySearchParams()
// 控制器层不再直接访问 DOM，通过 UIManager 门面读取搜索参数

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
      '7d': 7 * MS_PER_DAY,
      '30d': 30 * MS_PER_DAY,
      '90d': 90 * MS_PER_DAY,
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

    // ─── 伙伴洞察卡片点击回调：点击 profile 卡片展示记忆详情 ──
    uiManager.onPartnerMemoryClick(async (memoryId: string) => {
      try {
        const { memory } = await window.electronAPI.showMemory(memoryId);
        if (memory) {
          uiManager.showMemoryDetail(memory);
        }
      } catch (error) {
        reportError('partnerMemoryClick', error);
      }
    });

    // ─── 更多菜单项回调：切换洞察/健康度面板时加载数据 ────
    uiManager.onMoreMenuAction(async (action: string) => {
      if (action === 'insights') {
        await loadInsights();
      } else if (action === 'health') {
        await loadHealthDashboard();
      } else if (action === 'recycle-bin') {
        // 打开回收站弹窗并加载列表
        await loadRecycleBinList();
        uiManager.showModal('recycle-bin-modal');
      }
    });

    // ─── 回收站操作回调：恢复 / 彻底删除 ─────────────
    uiManager.onRecycleBinAction(async (recycleAction, id) => {
      if (recycleAction === 'restore') {
        // 恢复操作：二次确认（避免误点击）
        const confirmed = await uiManager.showConfirmDialog({
          title: '恢复记忆',
          message: '确定要将此记忆从回收站恢复到活跃列表吗？',
          confirmText: '恢复',
        });
        if (!confirmed) return;
        try {
          const result = await window.electronAPI.restoreMemory(id);
          if (result.restored) {
            uiManager.showToast('记忆已恢复', 'success');
            // P3-2：切换到记忆面板，刷新列表后定位到恢复的记忆
            await uiManager.switchPanel('memory');
            // 刷新回收站列表（移除已恢复项）+ 主列表（显示恢复的记忆）
            await loadRecycleBinList();
            await loadMemoryList();
            // 列表渲染完成后，滚动到目标记忆项并高亮
            uiManager.scrollToMemory(result.id);
          } else {
            uiManager.showToast('恢复失败：记忆可能已被处理', 'error');
          }
        } catch (error) {
          handleIpcError('restoreMemory', error, '恢复记忆失败');
        }
      } else if (recycleAction === 'purge') {
        // 彻底删除：不可恢复操作，danger 确认
        const confirmed = await uiManager.showConfirmDialog({
          title: '彻底删除',
          message: '确定要彻底删除此记忆吗？此操作不可恢复。',
          confirmText: '彻底删除',
          danger: true,
        });
        if (!confirmed) return;
        try {
          const result = await window.electronAPI.purgeMemory(id);
          if (result.purged) {
            uiManager.showToast('记忆已彻底删除', 'success');
            // 刷新回收站列表（移除已删除项）
            await loadRecycleBinList();
          } else {
            uiManager.showToast('删除失败：记忆可能已被处理', 'error');
          }
        } catch (error) {
          handleIpcError('purgeMemory', error, '彻底删除记忆失败');
        }
      }
    });

    // ─── 排序/时间范围变更：触发重新搜索或加载列表 ────────
    const triggerSearchOrReload = () => {
      // 通过 UIManager 门面触发搜索框 input 事件，控制器不直接操作 DOM
      const params = uiManager.getMemorySearchParams();
      if (params.query) {
        uiManager.triggerMemorySearchInput();
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
      const params = uiManager.getMemorySearchParams();
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
        // 搜索失败时保持原列表，但给用户可见反馈
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
          // Phase 5.1：异步加载演化脉络（不阻塞详情弹窗显示，失败静默降级）
          // incoming 方向追溯来源链，maxDepth=3 足够覆盖典型演化深度
          try {
            const path = await window.electronAPI.getRelationPath({
              memoryId: id,
              maxDepth: 3,
              direction: 'incoming',
            });
            uiManager.showMemoryLineage(path);
          } catch {
            // 脉络加载失败不影响详情查看，resetLineage 已在 showMemoryDetail 中调用
          }
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
        // deleteMemory 现为软删除（移入回收站），检查返回值避免假成功
        const result = await window.electronAPI.deleteMemory(id);
        if (!result.deleted) {
          // 主进程返回 deleted=false（如 ID 不存在或已软删除），提示用户
          uiManager.showToast('删除失败：记忆不存在或已被处理', 'error');
          return;
        }
        uiManager.hideModal('memory-detail-modal');
        await loadMemoryList();
        // 操作反馈走 toast（措辞调整为"已移入回收站"，体现软删除语义）
        uiManager.showToast('记忆已移入回收站', 'success');
      } catch (error) {
        handleIpcError('onMemoryDelete', error, '删除记忆失败');
      } finally {
        // 恢复按钮状态（弹窗已关闭时 setButtonLoading 内部会安全降级）
        setButtonLoading('btn-memory-delete', false);
      }
    });

    // 添加记忆
    uiManager.onMemoryAdd(async (data) => {
      // 进行中反馈：禁用按钮防止重复点击
      setButtonLoading('btn-memory-add-confirm', true, '添加中...');
      try {
        await window.electronAPI.addMemory(data);
        uiManager.clearAddMemoryForm();
        uiManager.hideModal('memory-add-modal');
        await loadMemoryList();
        // 操作反馈走 toast
        uiManager.showToast('记忆已添加', 'success');
      } catch (error) {
        handleIpcError('onMemoryAdd', error, '添加记忆失败');
      } finally {
        // 恢复按钮状态
        setButtonLoading('btn-memory-add-confirm', false);
      }
    });

    // 编辑记忆：复用 MEMORIES_ADD 通道（底层 upsert 语义）
    // id 参数未使用（编辑时通过 dataset 获取 source/name），加下划线前缀
    uiManager.onMemoryEdit(async (_id: string, content: string) => {
      // 通过 UIManager 门面读取详情弹窗 dataset，控制器不直接访问 DOM
      const source = uiManager.getMemoryDetailMeta('memorySource');
      const name = uiManager.getMemoryDetailMeta('memoryName');
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

    // ─── 图谱右键菜单操作回调 ─────────────────────────────
    uiManager.onGraphContextMenuAction(async (action: string, nodeId: string) => {
      switch (action) {
        case 'focus-subgraph':
          // 聚焦子图：以当前节点为根，高亮其直接邻居
          uiManager.selectGraphNode(nodeId);
          break;
        case 'view-detail': {
          // 查看详情：与点击节点行为一致
          uiManager.selectGraphNode(nodeId);
          try {
            const { memory } = await window.electronAPI.showMemory(nodeId);
            if (memory) {
              uiManager.showMemoryDetail(memory);
            }
          } catch (error) {
            reportError('graphContextMenu.viewDetail', error);
          }
          break;
        }
        case 'connect-from':
          // 提示用户使用 Ctrl+拖拽 创建连线
          uiManager.showToast('按住 Ctrl 从节点拖拽到另一个节点即可创建连线', 'info');
          break;
        case 'copy-id':
          // 复制节点 ID 到剪贴板
          await navigator.clipboard.writeText(nodeId);
          uiManager.showToast('节点 ID 已复制', 'success');
          break;
      }
    });

    // ─── 关系编辑回调（更新类型/权重） ────────────────────
    uiManager.onRelationEdit(async (sourceId: string, targetId: string, type: string, weight: number) => {
      try {
        await window.electronAPI.updateRelation({ sourceId, targetId, type, weight });
        uiManager.showToast('关系已更新', 'success');
        // 刷新图谱数据
        const data = await window.electronAPI.getRelationGraph();
        uiManager.loadGraphData(data);
      } catch (error) {
        handleIpcError('onRelationEdit', error, '更新关系失败');
      }
    });

    // ─── 关系删除回调 ─────────────────────────────────────
    uiManager.onRelationDelete(async (sourceId: string, targetId: string, type: string) => {
      try {
        await window.electronAPI.removeRelation({ sourceId, targetId, type });
        uiManager.showToast('关系已删除', 'success');
        // 刷新图谱数据
        const data = await window.electronAPI.getRelationGraph();
        uiManager.loadGraphData(data);
      } catch (error) {
        handleIpcError('onRelationDelete', error, '删除关系失败');
      }
    });

    // ─── 关系创建回调（Ctrl+拖拽连线后创建） ──────────────
    uiManager.onRelationCreate(async (sourceId: string, targetId: string, type: string, weight: number) => {
      try {
        await window.electronAPI.addRelation({ sourceId, targetId, type, weight });
        uiManager.showToast('关系已创建', 'success');
        // 刷新图谱数据
        const data = await window.electronAPI.getRelationGraph();
        uiManager.loadGraphData(data);
      } catch (error) {
        handleIpcError('onRelationCreate', error, '创建关系失败');
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
    // 加载态：在 IPC 调用前显示加载指示器（委托 DashboardPanelManager）
    uiManager.showInsightsLoading();

    try {
      // 并行请求（Promise.all 避免串行延迟）
      const [dashboard, graph] = await Promise.all([
        window.electronAPI.getDashboard(),
        window.electronAPI.getRelationGraph(),
      ]);

      // 渲染委托 DashboardPanelManager
      uiManager.renderInsights(dashboard, graph);
      // 伙伴洞察面板：基于记忆列表数据渲染（profile 卡片 + 知识缺口 + 成长趋势）
      const memList = await window.electronAPI.listMemories({});
      uiManager.renderPartnerInsights(memList.memories);
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
    // 加载态：在 IPC 调用前显示加载指示器（委托 DashboardPanelManager）
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
    // 通过 UIManager 门面显示加载态，控制器不直接操作 DOM
    uiManager.setMemoryListState('loading');

    try {
      const params = uiManager.getMemorySearchParams();
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
      // 通过 UIManager 门面显示错误状态（内部查找 #memory-list）
      uiManager.setMemoryListState('error');
      uiManager.showPanelError('memory', '加载记忆列表失败，请检查连接后重试', () => loadMemoryList());
    }
  }

  /**
   * 加载回收站列表
   *
   * 调用 listDeletedMemories IPC 获取软删除记忆，委托 PanelManager 渲染。
   * 失败时显示 toast 错误提示（回收站弹窗内不显示错误态，避免弹窗闪烁）。
   */
  async function loadRecycleBinList(): Promise<void> {
    try {
      const { memories } = await window.electronAPI.listDeletedMemories();
      uiManager.renderRecycleBinList(memories);
    } catch (error) {
      handleIpcError('loadRecycleBinList', error, '加载回收站列表失败');
    }
  }

  /**
   * 防抖定时器句柄（loadDashboard 高频调用时合并为单次执行）
   *
   * memoryNoticed/insightGained 事件密集触发时，避免每次都发起 IPC + DOM 操作，
   * 300ms 内的多次调用合并为一次。
   */
  let dashboardDebounceTimer: number | null = null;

  /**
   * 加载完整仪表盘数据
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
      // 并发加载仪表盘数据、感知快照、对话回顾数据，减少总等待时间
      // 注意：getPerceptionSnapshot / getReviewData 可能不存在（如 Web 调试模式），需用 Promise.resolve + catch 确保安全
      const perceptionPromise = Promise.resolve()
        .then(() => window.electronAPI.getPerceptionSnapshot?.())
        .catch(() => null);
      // Phase 6.2：对话回顾数据（reviewManager.buildReviewData 的 IPC 透传），失败时不阻塞仪表盘其他区域
      const reviewPromise = Promise.resolve()
        .then(() => window.electronAPI.getReviewData?.())
        .catch(() => null);

      const [data, perceptionSnapshot, reviewData] = await Promise.all([
        window.electronAPI.getDashboard(),
        perceptionPromise,
        reviewPromise,
      ]);

      // 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
      uiManager.renderDashboardStats(data);

      // Agent 运行时指标渲染（消费内核 agent.getMetrics()）
      uiManager.renderAgentMetrics(data.metrics);

      // 缺口 E：记忆源健康诊断渲染（消费内核 sourceHealth()，展示每个 source 的质量维度）
      uiManager.renderSourceHealth(data.sourceHealth);

      // 已加载技能列表渲染（消费内核 agent.skills.list）
      uiManager.renderSkills(data.skills);

      // Phase 6.2：增长趋势区块渲染（消费 reviewManager.buildReviewData 已计算的趋势数据）
      if (reviewData) {
        uiManager.renderReviewData(reviewData);
      }

      // 感知快照渲染（情感/默契度/上下文/模式/主动提示统计）
      // 确保仪表盘首次加载时就能显示真实数据，而非占位值
      if (perceptionSnapshot && Object.keys(perceptionSnapshot).length > 0) {
        uiManager.renderPerceptionSnapshot(perceptionSnapshot);
      }
    } catch (error) {
      reportError('loadDashboard', error);
      // 仪表盘涉及多子区域（统计/指标/技能/回顾/感知），整体失败时用 toast 兜底提示
      uiManager.showToast('仪表盘加载失败，请稍后重试', 'error');
    }
  }

  /**
   * 防抖版 loadDashboard
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
    /** 防抖版 loadDashboard（事件密集触发时使用） */
    loadDashboardDebounced,
    /** 仪表盘计数 +1 并触发脉冲动画（委托 DashboardPanelManager） */
    pulseCounter: (id: string) => uiManager.pulseCounter(id),
    /**
     * 更新情感基调展示（委托 DashboardPanelManager）
     *
     * 由 affectUpdated 事件驱动，Controller 仅做转发。
     */
    updateAffectDisplay: (affect: AffectPayload) => {
      uiManager.updateAffectDisplay(affect);
    },
    /**
     * Phase 3：更新默契度展示（委托 DashboardPanelManager）
     *
     * 由 rapportUpdated 事件驱动，Controller 仅做转发。
     */
    updateRapportDisplay: (rapport: RapportPayload) => {
      uiManager.updateRapportDisplay(rapport);
    },
    /**
     * Phase 4：更新对话上下文展示（委托 DashboardPanelManager）
     *
     * 由 contextUpdated 事件驱动，Controller 仅做转发。
     */
    updateContextDisplay: (context: ContextPayload) => {
      uiManager.updateContextDisplay(context);
    },
    /**
     * 更新模式洞察面板（委托 DashboardPanelManager）
     *
     * 由 patternsUpdated 事件驱动，Controller 仅做转发。
     */
    updatePatternsDisplay: (payload: PatternsPayload) => {
      uiManager.updatePatternsDisplay(payload);
    },
    /**
     * Phase 3.2：更新在场状态展示（委托 DashboardPanelManager）
     *
     * 由 presenceChanged 事件驱动，Controller 仅做转发。
     */
    updatePresenceDisplay: (payload: PresencePayload) => {
      uiManager.updatePresenceDisplay(payload);
    },
    /**
     * 更新叙事摘要（委托 DashboardPanelManager）
     *
     * 由渲染器在每次感知数据更新后调用，不需要额外参数。
     */
    updateNarrative: () => {
      uiManager.updateNarrative();
    },
    /** 清理防抖定时器（由 renderer.ts beforeunload 调用） */
    cleanup: () => {
      if (dashboardDebounceTimer !== null) {
        window.clearTimeout(dashboardDebounceTimer);
        dashboardDebounceTimer = null;
      }
    },
  };
}
