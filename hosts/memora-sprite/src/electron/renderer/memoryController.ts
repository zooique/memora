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

import type { UIManager } from './ui.js';
import { setButtonLoading, clearElement } from './domHelpers.js';
import type { MemoryListItem } from './types.js';
import { createIpcErrorHandler, reportError } from './errorHelpers.js';

/** 仪表盘计数脉冲动画时长（毫秒），对齐 layout.css @keyframes numberPulse 的 0.3s */
const DASHBOARD_PULSE_MS = 300;

/** 累积事件接近阈值的百分比（>=80% 显示黄色高亮） */
const NEAR_THRESHOLD_RATIO = 0.8;

/** 脉冲动画定时器句柄（beforeunload 时清理，避免操作已销毁的 DOM） */
let pulseTimers: number[] = [];

/**
 * 创建记忆控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 记忆控制器接口（设置回调、加载列表、加载仪表盘）
 */
export function createMemoryController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /**
   * 设置记忆面板回调
   *
   * 包含搜索（带竞态保护）、筛选、点击查看详情、删除、添加。
   */
  function setupMemoryPanel(): void {
    // 搜索请求序列号：防止快速输入时旧结果覆盖新结果（竞态保护）
    let searchSeq = 0;

    // 搜索回调
    uiManager.onMemorySearch(async (query: string) => {
      if (!query) {
        // 空搜索：加载全部
        await loadMemoryList();
        return;
      }
      // 递增序列号，捕获当前请求的序号
      const seq = ++searchSeq;
      try {
        const { hits } = await window.electronAPI.searchMemories(query);
        // 若在等待期间有更新的搜索请求发起，丢弃本次过期结果
        if (seq !== searchSeq) return;
        const items: MemoryListItem[] = hits.map(h => ({
          id: h.id,
          name: h.name,
          source: h.source,
          score: h.similarity ?? h.score,
          contentPreview: h.contentPreview,
        }));
        uiManager.renderMemoryList(items);
      } catch (error) {
        // IX-02 搜索失败时保持原列表，但给用户可见反馈（而非静默吞错）
        if (seq !== searchSeq) return;
        reportError('onMemorySearch', error);
        uiManager.showToast('搜索记忆失败，请重试', 'error');
      }
    });

    // 筛选回调
    uiManager.onMemoryFilter((_source: string) => {
      void loadMemoryList();
    });

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
      try {
        await window.electronAPI.deleteMemory(id);
        uiManager.hideModal('memory-detail-modal');
        await loadMemoryList();
        // IX-06 操作反馈走 toast
        uiManager.showToast('记忆已删除', 'success');
      } catch (error) {
        handleIpcError('onMemoryDelete', error, '删除记忆失败');
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
    uiManager.onMemoryEdit(async (id: string, content: string) => {
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

  /** 加载记忆列表 */
  async function loadMemoryList(): Promise<void> {
    try {
      const filterEl = document.getElementById('memory-filter-source');
      const source = filterEl instanceof HTMLSelectElement ? filterEl.value : undefined;
      const { memories } = await window.electronAPI.listMemories(source ? { source } : {});
      uiManager.renderMemoryList(memories);

      // 更新仪表盘记忆计数
      const countEl = document.getElementById('memory-count');
      if (countEl) {
        countEl.textContent = String(memories.length);
      }
    } catch (error) {
      reportError('loadMemoryList', error);
      uiManager.showPanelError('memory', '加载记忆列表失败，请检查连接后重试', () => loadMemoryList());
    }
  }

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
      healthList.appendChild(li);
    }
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
   * 格式化 token 数显示
   *
   * 超过 1000 时显示为 "1.2k" 格式，否则直接显示数字。
   */
  function formatTokenCount(tokens: number): string {
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return String(tokens);
  }

  return {
    setupMemoryPanel,
    loadMemoryList,
    loadDashboard,
    pulseCounter,
    renderSourceHealth,
    /** IX-03 清理脉冲动画定时器（由 renderer.ts beforeunload 调用） */
    cleanup: () => {
      for (const t of pulseTimers) window.clearTimeout(t);
      pulseTimers = [];
    },
  };
}
