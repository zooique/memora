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
import { setButtonLoading, clearElement } from '../helpers/domHelpers.js';
import type { MemoryListItem } from '../types.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';
import { getSourceColorClass } from '../panels/memoryPanelManager.js';

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

  /**
   * 设置记忆面板回调
   *
   * 包含搜索（带竞态保护）、筛选、点击查看详情、删除、添加。
   */
  function setupMemoryPanel(): void {
    // 搜索请求序列号：防止快速输入时旧结果覆盖新结果（竞态保护）
    let searchSeq = 0;

    // ─── 高级搜索栏展开/收起（Phase 2：搜索增强） ────────────
    const advSearchBtn = document.getElementById('btn-advanced-search');
    const advSearchBar = document.getElementById('advanced-search-bar');
    if (advSearchBtn && advSearchBar) {
      advSearchBtn.addEventListener('click', () => {
        const isHidden = advSearchBar.classList.contains('hidden');
        advSearchBar.classList.toggle('hidden', !isHidden);
        advSearchBtn.classList.toggle('active', isHidden);
      });
    }

    // ─── 洞察栏展开/收起（Phase 3：记忆洞察面板） ────────────
    // 展开时异步加载仪表盘 + 关系图谱数据，聚合渲染统计 + 分布 + 关系摘要
    const insightsBtn = document.getElementById('btn-insights');
    const insightsBar = document.getElementById('memory-insights-bar');
    if (insightsBtn && insightsBar) {
      insightsBtn.addEventListener('click', async () => {
        const isHidden = insightsBar.classList.contains('hidden');
        insightsBar.classList.toggle('hidden', !isHidden);
        insightsBtn.classList.toggle('active', isHidden);
        // 展开时加载数据（避免折叠状态下浪费 IPC 调用）
        if (isHidden) {
          await loadInsights();
        }
      });
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
          createdAt: (h as Record<string, unknown>).createdAt as string | undefined,
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

    // 切换按钮点击事件（列表 ↔ 图谱）
    const graphBtn = document.getElementById('btn-graph-view');
    if (graphBtn) {
      graphBtn.addEventListener('click', () => {
        const graphContainer = document.getElementById('memory-graph-container');
        const isGraphView = graphContainer && graphContainer.style.display !== 'none';

        if (isGraphView) {
          // 当前是图谱视图 → 切换回列表
          uiManager.switchMemoryView('list');
        } else {
          // 当前是列表视图 → 切换到图谱
          // 如果需要首次加载数据，onGraphToggle 回调会触发 IPC
          uiManager.switchMemoryView('graph');
        }
        // 更新按钮激活态
        updateGraphButtonState();
      });
    }
  }

  /**
   * 更新图谱视图切换按钮的激活态
   *
   * 图谱视图激活时按钮高亮（.active 类），列表视图时恢复默认。
   */
  function updateGraphButtonState(): void {
    const graphBtn = document.getElementById('btn-graph-view');
    if (!graphBtn) return;
    // 通过检查 graph container 是否可见判断当前视图
    const graphContainer = document.getElementById('memory-graph-container');
    const isGraphView = graphContainer && graphContainer.style.display !== 'none';
    graphBtn.classList.toggle('active', isGraphView);
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
      // 洞察加载失败不阻塞记忆面板主流程
    }
  }

  /** 加载记忆列表（Phase 2：支持组合筛选 + 客户端排序/时间过滤） */
  async function loadMemoryList(): Promise<void> {
    try {
      const params = getSearchParams();
      const { memories } = await window.electronAPI.listMemories(
        params.source ? { source: params.source } : {},
      );
      // 客户端排序 + 时间过滤
      const filtered = applyClientFilters(memories, params);
      // 传递空字符串表示无搜索关键词（不高亮）
      uiManager.renderMemoryList(filtered, '');

      // 更新仪表盘记忆计数
      const countEl = document.getElementById('memory-count');
      if (countEl) {
        countEl.textContent = String(filtered.length);
      }
    } catch (error) {
      reportError('loadMemoryList', error);
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

      // 已注册触发器数量 + hover 详情
      const triggerEl = document.getElementById('trigger-count');
      const dashTriggers = document.getElementById('dash-triggers');
      if (triggerEl && dashTriggers) {
        triggerEl.textContent = String(data.registeredTriggers.length);
        // hover 显示触发器名称列表
        const triggerList = data.registeredTriggers.length > 0
          ? data.registeredTriggers.join(', ')
          : '无触发器';
        dashTriggers.title = `已注册触发器：${triggerList}`;
      }

      // 渲染推荐记忆列表（对齐方案 §6.3 推荐区）
      const recList = document.getElementById('recommendation-list');
      const recSection = document.getElementById('recommendations');
      if (recList && recSection) {
        if (data.suggestions && data.suggestions.length > 0) {
          // UX-08：使用 clearElement 统一封装 while + removeChild 模式，与项目约定一致
          clearElement(recList);
          for (const s of data.suggestions) {
            const li = document.createElement('li');
            li.title = `${s.contentPreview}\n\n${s.reason}`;
            // FD-ADD-REC-CLICK：添加 data-action 和 data-memory-name，供事件委托识别点击
            li.dataset.action = 'view-recommendation';
            li.dataset.memoryName = s.name;
            // 记忆名称
            const nameSpan = document.createElement('span');
            nameSpan.textContent = s.name;
            // 相关度分数
            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'suggestion-score';
            scoreSpan.textContent = s.relevance.toFixed(2);
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            recList.appendChild(li);
          }
          recSection.classList.remove('hidden');
        } else {
          // 无推荐时隐藏推荐区
          recSection.classList.add('hidden');
        }
      }

      // 记忆源健康状态渲染（消费内核 sourceHealth()）
      renderSourceHealth(data.sourceHealth);

      // OBS-01 Agent 运行时指标渲染（消费内核 agent.getMetrics()）
      renderAgentMetrics(data.metrics);

      // GAP-1 已加载技能列表渲染（消费内核 agent.skills.list）
      renderSkills(data.skills);

      // H3 仪表盘加载完成后更新学习进度卡片
      uiManager.updateLearningProgress();
    } catch (error) {
      reportError('loadDashboard', error);
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
   * 渲染记忆源健康状态
   *
   * 消费内核 sourceHealth() 数据，在仪表盘中为每个 source 显示
   * 健康状态指示器（healthy=绿 / warning=黄 / critical=红）。
   * 无数据时隐藏健康区域。
   */
  function renderSourceHealth(sourceHealth: {
    sources: Array<{
      source: string;
      count: number;
      avgScore: number;
      daysSinceLastAccess: number;
      status: 'healthy' | 'warning' | 'critical';
    }>;
    overallStatus: 'healthy' | 'warning' | 'critical';
    diagnosedAt: string;
  } | null): void {
    const healthSection = document.getElementById('source-health');
    const healthList = document.getElementById('source-health-list');
    if (!healthSection || !healthList) return;

    // 无数据时隐藏
    if (!sourceHealth || sourceHealth.sources.length === 0) {
      healthSection.classList.add('hidden');
      return;
    }

    healthSection.classList.remove('hidden');
    clearElement(healthList);

    // QC-PERF-02：使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const fragment = document.createDocumentFragment();

    // 状态 → CSS 类名映射
    const statusClass: Record<string, string> = {
      healthy: 'health-ok',
      warning: 'health-warn',
      critical: 'health-crit',
    };

    for (const s of sourceHealth.sources) {
      const li = document.createElement('li');
      li.className = `source-health-item ${statusClass[s.status] ?? ''}`;
      // 状态圆点
      const dot = document.createElement('span');
      dot.className = `health-dot ${statusClass[s.status] ?? ''}`;
      // 来源名 + 数量
      const label = document.createElement('span');
      label.className = 'health-label';
      label.textContent = `${s.source} (${s.count})`;
      // 平均 score + 新鲜度
      const meta = document.createElement('span');
      meta.className = 'health-meta';
      const days = s.daysSinceLastAccess === Infinity ? '从未' : `${s.daysSinceLastAccess}天前`;
      meta.textContent = `score ${s.avgScore.toFixed(2)} · ${days}`;
      // hover 详情
      li.title = `来源：${s.source}\n数量：${s.count}\n平均 score：${s.avgScore}\n上次访问：${days}\n状态：${s.status}`;

      li.appendChild(dot);
      li.appendChild(label);
      li.appendChild(meta);
      fragment.appendChild(li);
    }

    healthList.appendChild(fragment);
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
    // 更新仪表盘技能计数
    const countEl = document.getElementById('skill-count');
    if (countEl) {
      countEl.textContent = String(skills.length);
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
   * 将 0-1 数值映射为进度条颜色
   *
   * 低→蓝色(#5B8DEF) 中→绿色(#4CAF50) 高→橙色(#FF9800)
   */
  function getAffectColor(value: number): string {
    if (value < 0.33) return '#5B8DEF';
    if (value < 0.67) return '#4CAF50';
    return '#FF9800';
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
  function ContextAwarenessDescribeRhythm(rhythm: string): string {
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
  function ContextAwarenessDescribeCoherence(coherence: string): string {
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
  function ContextAwarenessDescribeDepth(depth: string): string {
    switch (depth) {
      case 'deep': return '深度讨论';
      case 'moderate': return '一般讨论';
      case 'shallow': return '浅层问答';
      case 'none': return '无';
      default: return depth;
    }
  }

  return {
    setupMemoryPanel,
    loadMemoryList,
    loadDashboard,
    /** QC-PERF-01 防抖版 loadDashboard（事件密集触发时使用） */
    loadDashboardDebounced,
    pulseCounter,
    renderSourceHealth,
    /**
     * Phase 2.1：更新情感基调展示（四维进度条）
     *
     * 由 affectUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
     * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
     */
    updateAffectDisplay,
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
        rhythmEl.textContent = ContextAwarenessDescribeRhythm(context.rhythm);
      }

      // 更新话题
      const coherenceEl = document.getElementById('context-coherence');
      if (coherenceEl) {
        coherenceEl.textContent = ContextAwarenessDescribeCoherence(context.coherence);
      }

      // 更新深度
      const depthEl = document.getElementById('context-depth');
      if (depthEl) {
        depthEl.textContent = ContextAwarenessDescribeDepth(context.depth);
      }

      // 更新描述文本
      const descEl = document.getElementById('context-description');
      if (descEl) {
        descEl.textContent = context.description;
      }
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
