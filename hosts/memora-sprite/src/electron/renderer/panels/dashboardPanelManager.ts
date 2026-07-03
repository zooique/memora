/**
 * 仪表盘面板管理器 — 感知系统 + 仪表盘渲染独立子模块
 *
 * 职责：
 * - 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
 * - 渲染 Agent 运行时指标、技能列表、里程碑成就、对话回顾
 * - 渲染记忆洞察面板（统计卡片 + source 分布条形图 + 关系摘要）
 * - 渲染记忆健康度仪表盘（评分/徽章/三维度进度条/详情计数/清理按钮可见性）
 * - 渲染感知系统（情感基调/默契度/对话上下文/模式洞察/叙事摘要）
 * - 自管理脉冲动画定时器与事件监听器
 *
 * 设计原则：
 * - 遵循 MemoryPanelManager 的组合模式，UIManager 持有实例并委托
 * - Controller 仅做 IPC 编排，拉取数据后调用 Manager 渲染方法
 * - 渲染所需纯函数（getAffectLevel/getAffectColor/getRapportLevelLabel 等）封装为本模块私有
 * - 跨模块关注点（showToast）通过 host 回调注入
 */

import { clearElement } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import { PartnerInsightsRenderer } from './partnerInsightsRenderer.js';
import { HealthDashboardRenderer } from './healthDashboardRenderer.js';
import { InsightsRenderer } from './insightsRenderer.js';
import { PerceptionRenderer } from './perceptionRenderer.js';
// 复用 source → CSS 颜色类映射（与 InsightsRenderer 的 source 分布条形图共享配色）
import { getSourceColorClass } from './memoryPanelManager.js';
import type { ToastType } from '../types.js';
import type { HealthDashboardPayload, ReviewDataPayload } from '../../preload.js';
import type { RelationGraphData } from '../components/relationGraph.js';
// 感知数据 Payload 类型从 ipcListeners（IPC 契约真理源）导入
import type { AffectPayload, RapportPayload, ContextPayload, PatternsPayload, PresencePayload } from '../ipcListeners.js';
// 缺口 G+H：主动提示统计类型从 sprite controllers（真理源）导入（preload 仅内部使用，不 re-export）
import type { ProactiveStats } from '../../../sprite/controllers/index.js';
// 仪表盘脉冲动画间隔常量从 constants.ts 真理源导入
import { DASHBOARD_PULSE_MS } from '../../../sprite/constants.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 仪表盘面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface DashboardPanelHost {
  /** 显示 toast 通知（清理失败等场景反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── 类型定义（避免重复 inline，提升可读性） ─────────────

/** Agent 运行时指标快照（对齐内核 agent.getMetrics() 返回结构） */
export interface AgentMetrics {
  /** LLM 调用统计 */
  llm: {
    callCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  /** 召回统计 */
  recall: {
    totalCount: number;
    hitCount: number;
    hitRate: number;
  };
  /** 工具调用统计 */
  tools: {
    callCount: number;
    failureCount: number;
  };
  /** 上下文管理统计 */
  context: {
    truncationCount: number;
    messageCount: number;
    estimatedTokens: number;
  };
  /** 衰减统计（null 表示从未运行过衰减） */
  decay: {
    runCount: number;
    totalDecayedCount: number;
    lastRunAt: string | null;
  } | null;
}

/**
 * 记忆源健康诊断快照（对齐 preload.ts getDashboard 返回的 sourceHealth 结构）
 *
 * 消费内核 agent.memory.sourceHealth()，展示每个 source 的质量维度：
 * - count：该 source 记忆数
 * - avgScore：平均分（0-1，反映记忆整体质量）
 * - daysSinceLastAccess：距上次访问天数（反映活跃度）
 * - status：健康状态徽章（healthy/warning/critical）
 */
export interface SourceHealth {
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

/**
 * 仪表盘视图模型（对齐 IPC getDashboard 返回结构，仅声明 Manager 用到的字段）
 *
 * 与 sprite 层 memoryController.DashboardData 概念不同：
 * - sprite 层 DashboardData 是"记忆仪表盘业务数据"
 * - 本类型是"完整仪表盘视图模型"（含事件/触发器/技能等 UI 字段）
 */
export interface DashboardViewModel {
  /** 累积事件数 */
  pendingNotices: number;
  /** 主动提示阈值 */
  proactiveThreshold: number;
  /** 已注册触发器名称列表 */
  registeredTriggers: string[];
  /** 推荐记忆列表 */
  suggestions: Array<{
    /** 记忆唯一标识（source:name 格式，用于点击跳转详情） */
    id: string;
    name: string;
    source: string;
    reason: string;
    relevance: number;
    contentPreview: string;
  }>;
  /** 全量记忆总数 */
  total: number;
  /** source → 计数映射 */
  bySource: Record<string, number>;
  /** 记忆源健康诊断（null 表示不可用，消费内核 sourceHealth()） */
  sourceHealth: SourceHealth | null;
  /** Agent 运行时指标（null 表示不可用） */
  metrics: AgentMetrics | null;
  /** 已加载技能列表 */
  skills: Array<{
    name: string;
    keywords: string[];
    description: string;
    layer: string;
  }>;
}

// P1 类型统一：感知数据 Payload 类型从 ipcListeners.ts（IPC 契约真理源）导入

// ─── 常量 ────────────────────────────────────────────────

/** 累积事件接近阈值的百分比（>=80% 显示黄色高亮） */
const NEAR_THRESHOLD_RATIO = 0.8;

/** 对话趋势方向 → 箭头符号映射 */
const TREND_ARROW_MAP: Record<string, string> = {
  growing: '↑',
  stable: '→',
  declining: '↓',
};

/** 记忆量级里程碑 → 中文标签映射（key = Math.floor(Math.log10(total))） */
const MAGNITUDE_LABELS: Record<number, string> = {
  2: '百条记忆',
  3: '千条记忆',
  4: '万条记忆',
  5: '十万记忆',
};

// ─── 导出的纯函数（保持向后兼容） ─────────────────────────

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

// ─── 仪表盘面板管理器类 ───────────────────────────────────

/**
 * 仪表盘面板管理器（Facade）
 *
 * 组合 4 个独立子渲染器，通过委托模式分发渲染请求：
 * - PartnerInsightsRenderer：伙伴洞察子区域（profile 卡片 / 知识缺口 / 增长趋势图）
 * - HealthDashboardRenderer：记忆健康度子区域（评分 / 徽章 / 三维度 / 清理按钮）
 * - InsightsRenderer：记忆洞察子区域（统计卡片 / source 分布 / 关系摘要）
 * - PerceptionRenderer：感知系统子区域（情感 / 默契度 / 上下文 / 模式 / 在场状态 / 叙事合成）
 *
 * 自管理：脉冲动画定时器（pulseTimers）+ EventTracker（事件监听器跟踪）+ 重试回调。
 * 生命周期：UIManager 在挂载时创建实例，在卸载时调用 cleanup() 释放资源。
 *
 * 设计依据：ADR-SP-015 PanelManager 组合模式（4 种依赖注入模式 + 委托规范 + 生命周期契约）
 */
export class DashboardPanelManager {
  // ─── 内部状态 ────────────────────────────────────────────
  /** 脉冲动画定时器句柄列表（cleanup 时统一清理，避免回调在 DOM 销毁后触发） */
  private pulseTimers: number[] = [];

  /** 伙伴洞察渲染器（组合模式：委托 partner-insights 子区域渲染） */
  private partnerInsights = new PartnerInsightsRenderer();

  /** 健康度仪表盘渲染器（组合模式：委托 health 子区域渲染） */
  private healthDashboard = new HealthDashboardRenderer();

  /** 洞察渲染器（组合模式：委托 insights 子区域渲染） */
  private insights = new InsightsRenderer();

  /** 感知渲染器（组合模式：委托 perception 子区域渲染 + 叙事合成） */
  private perception = new PerceptionRenderer();

  // ─── 回调（由 Controller 注册，用于重试按钮触发数据重新加载） ──
  /** 重试加载记忆列表回调 */
  private reloadMemoryListCallback: (() => void) | null = null;

  constructor(
    /** 事件监听器跟踪器（统一管理重试按钮事件，避免内存泄漏） */
    private events: EventTracker,
  ) {}

  // ─── 资源清理 ──────────────────────────────────────────

  /** 清理脉冲动画定时器和事件监听器（页面卸载时调用，避免回调在 DOM 销毁后触发） */
  cleanup(): void {
    for (const t of this.pulseTimers) {
      window.clearTimeout(t);
    }
    this.pulseTimers = [];
    this.events.cleanup();
    this.partnerInsights.cleanup();
    this.healthDashboard.cleanup();
    this.insights.cleanup();
    this.perception.cleanup();
  }

  /**
   * 主题切换时重绘 Canvas 图表
   *
   * Canvas 2D 不会自动响应 CSS 变量变化，主题切换后需主动重绘。
   * 委托到 PartnerInsightsRenderer 使用缓存的记忆数据重新渲染增长趋势图。
   */
  repaintOnThemeChange(): void {
    this.partnerInsights.repaintOnThemeChange();
  }

  // ─── 回调注册 ──────────────────────────────────────────

  /** 注册重试加载洞察数据回调（委托到 InsightsRenderer） */
  onReloadInsights(cb: () => void): void {
    this.insights.onReloadInsights(cb);
  }

  /** 注册重试加载健康度数据回调（委托到 HealthDashboardRenderer） */
  onReloadHealth(cb: () => void): void {
    this.healthDashboard.onReloadHealth(cb);
  }

  /** 注册重试加载记忆列表回调（用户点击重试按钮时触发） */
  onReloadMemoryList(cb: () => void): void {
    this.reloadMemoryListCallback = cb;
  }

  // ─── 仪表盘统计渲染 ────────────────────────────────────

  /**
   * 渲染仪表盘统计数据（累积事件/触发器/推荐记忆/记忆计数/洞察计数/建议计数）
   *
   * 由 Controller 在 loadDashboard 中调用，传入 IPC 返回的仪表盘数据。
   * 原 DOM 位置已移除，所有元素查询均安全降级（null 检查），方法不会崩溃。
   * 推荐记忆列表通过 data-action="view-recommendation" 标记，事件委托由 UIManager 统一处理。
   *
   * @param data 仪表盘数据
   */
  renderDashboardStats(data: DashboardViewModel): void {
    // ─── 累积事件数 / 阈值（高亮状态：接近阈值黄色，达到阈值粉色） ──
    const pendingEl = document.getElementById('perception-pending-count');
    if (pendingEl) {
      pendingEl.textContent = `${data.pendingNotices}/${data.proactiveThreshold}`;
      pendingEl.classList.remove('near-threshold', 'at-threshold');
      if (data.pendingNotices >= data.proactiveThreshold) {
        pendingEl.classList.add('at-threshold');
      } else if (
        data.proactiveThreshold > 0 &&
        data.pendingNotices / data.proactiveThreshold >= NEAR_THRESHOLD_RATIO
      ) {
        pendingEl.classList.add('near-threshold');
      }
    }

    // ─── 已注册触发器数量（更新事件卡片 title 附加信息） ────
    const triggerList =
      data.registeredTriggers.length > 0 ? data.registeredTriggers.join(', ') : '无触发器';
    if (pendingEl) {
      pendingEl.title = `累积待处理事件/阈值 · 触发器：${triggerList}`;
    }

    // ─── 渲染推荐记忆列表（合并到学习与回顾节） ──────────
    const recList = document.getElementById('recommendation-list');
    const learningSection = document.getElementById('learning-progress');
    if (recList && learningSection) {
      if (data.suggestions && data.suggestions.length > 0) {
        clearElement(recList);
        for (const s of data.suggestions) {
          const li = document.createElement('li');
          li.title = `${s.contentPreview}\n\n${s.reason}`;
          li.dataset.action = 'view-recommendation';
          li.dataset.memoryId = s.id;
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

    // ─── 更新记忆总数（data.total 为全量记忆数，不受筛选影响） ──
    const memoryCountEl = document.getElementById('perception-memory-count');
    if (memoryCountEl) memoryCountEl.textContent = String(data.total);

    // ─── 更新洞察计数（bySource 中 source='insight' 的记忆数） ──
    const insightCount = data.bySource['insight'] ?? 0;
    const insightCountEl = document.getElementById('perception-insight-count');
    if (insightCountEl) insightCountEl.textContent = String(insightCount);

    // ─── 更新建议计数（suggestions 数组长度，供 updateLearningProgress 读取） ──
    const suggestionCountEl = document.getElementById('perception-suggestion-count');
    if (suggestionCountEl) suggestionCountEl.textContent = String(data.suggestions.length);
  }

  /**
   * 渲染 Agent 运行时指标（感知面板指标网格）
   *
   * 消费内核 agent.getMetrics() 数据，在感知面板中展示 4 项核心指标：
   * - LLM 调用次数 / Token 数 / 召回命中率 / 工具失败率
   *
   * 无数据时静默 return。token 数超过 1000 时显示为 "1.2k" 格式。
   *
   * @param metrics Agent 运行时指标快照（null 表示不可用）
   */
  renderAgentMetrics(metrics: AgentMetrics | null): void {
    // 无数据时静默跳过
    if (!metrics) return;

    // ─── 感知面板 LLM 调用次数 ──────────────────────────
    const llmCallsEl = document.getElementById('perception-llm-calls');
    if (llmCallsEl) {
      llmCallsEl.textContent = String(metrics.llm.callCount);
    }

    // ─── 感知面板 Token 数（输入 + 输出，超过 1000 显示 k 格式） ──
    const tokensEl = document.getElementById('perception-tokens');
    if (tokensEl) {
      const totalTokens = metrics.llm.totalInputTokens + metrics.llm.totalOutputTokens;
      tokensEl.textContent = formatTokenCount(totalTokens);
    }

    // ─── 感知面板召回命中率（百分比，保留 0 位小数） ────────
    const recallRateEl = document.getElementById('perception-recall-rate');
    if (recallRateEl) {
      recallRateEl.textContent = `${Math.round(metrics.recall.hitRate * 100)}%`;
    }

    // ─── 感知面板工具失败率（callCount=0 时显示 "—"，避免 0/0 误显示为 0%） ──
    const toolFailuresEl = document.getElementById('perception-tool-failures');
    if (toolFailuresEl) {
      if (metrics.tools.callCount > 0) {
        const failRate = metrics.tools.failureCount / metrics.tools.callCount;
        toolFailuresEl.textContent = `${Math.round(failRate * 100)}%`;
      } else {
        toolFailuresEl.textContent = '—';
      }
    }

    // ─── 缺口 F：衰减历史指标（消费 metrics.decay，与 decayCompleted toast 互补） ──
    // decay 为 null 表示从未运行过衰减，此时显示 "—" 占位
    const decayRunsEl = document.getElementById('perception-decay-runs');
    const decayTotalEl = document.getElementById('perception-decay-total');
    if (decayRunsEl) {
      decayRunsEl.textContent = metrics.decay ? String(metrics.decay.runCount) : '—';
    }
    if (decayTotalEl) {
      decayTotalEl.textContent = metrics.decay ? String(metrics.decay.totalDecayedCount) : '—';
    }
  }

  /**
   * 渲染记忆源健康诊断（缺口 E：消费内核 sourceHealth()）
   *
   * 在仪表盘展示每个 source 的质量维度：计数 / 平均分 / 距上次访问天数 / 健康状态徽章。
   * 与 InsightsRenderer 的 source 分布条形图互补：
   * - InsightsRenderer 展示"每个 source 有多少条"（数量维度）
   * - 本方法展示"每个 source 质量如何"（健康维度）
   *
   * 无数据时隐藏整个 section，避免占用空间。有数据时按 status 严重度排序
   * （critical → warning → healthy），让用户优先看到需要关注的 source。
   *
   * @param sourceHealth 记忆源健康诊断数据（null 表示不可用）
   */
  renderSourceHealth(sourceHealth: SourceHealth | null): void {
    const listEl = document.getElementById('source-health-list');
    const sectionEl = document.getElementById('source-health-section');
    const overallEl = document.getElementById('source-health-overall');
    if (!listEl || !sectionEl) return;

    // 无数据时隐藏整个 section（内核降级返回 null 时不展示）
    if (!sourceHealth || sourceHealth.sources.length === 0) {
      sectionEl.classList.add('hidden');
      return;
    }

    sectionEl.classList.remove('hidden');

    // 总体健康状态徽章
    if (overallEl) {
      overallEl.textContent = this.getSourceHealthStatusLabel(sourceHealth.overallStatus);
      overallEl.className = `source-health-overall-badge ${sourceHealth.overallStatus}`;
    }

    // 清空并重建列表（遵循项目规范：while + removeChild）
    while (listEl.firstChild) {
      listEl.removeChild(listEl.firstChild);
    }

    // 按 status 严重度排序：critical(0) → warning(1) → healthy(2)
    // 让需要关注的 source 优先出现在列表顶部
    const statusOrder: Record<string, number> = { critical: 0, warning: 1, healthy: 2 };
    const sortedSources = [...sourceHealth.sources].sort(
      (a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9),
    );

    for (const s of sortedSources) {
      const item = document.createElement('div');
      item.className = `source-health-item ${s.status}`;

      // source 标签（中文化 + 复用 InsightsRenderer 的颜色类）
      const labelSpan = document.createElement('span');
      labelSpan.className = `source-health-label source-${getSourceColorClass(s.source)}`;
      labelSpan.textContent = this.getSourceLabel(s.source);

      // 计数（该 source 记忆数）
      const countSpan = document.createElement('span');
      countSpan.className = 'source-health-count';
      countSpan.textContent = `${s.count} 条`;

      // 平均分（百分比，反映记忆整体质量）
      const scoreSpan = document.createElement('span');
      scoreSpan.className = 'source-health-score';
      scoreSpan.textContent = `均分 ${Math.round(s.avgScore * 100)}`;
      scoreSpan.title = '该 source 所有记忆的平均分（0-100）';

      // 距上次访问天数（反映活跃度，0=今天访问过）
      const accessSpan = document.createElement('span');
      accessSpan.className = 'source-health-access';
      accessSpan.textContent = s.daysSinceLastAccess === 0
        ? '今日访问'
        : `${s.daysSinceLastAccess} 天未访`;
      accessSpan.title = '距上次访问该 source 的天数';

      // 健康状态徽章
      const statusSpan = document.createElement('span');
      statusSpan.className = `source-health-status ${s.status}`;
      statusSpan.textContent = this.getSourceHealthStatusLabel(s.status);

      item.appendChild(labelSpan);
      item.appendChild(countSpan);
      item.appendChild(scoreSpan);
      item.appendChild(accessSpan);
      item.appendChild(statusSpan);

      listEl.appendChild(item);
    }
  }

  /**
   * 渲染已加载技能列表（安全降级）
   *
   * 消费内核 agent.skills.list，在仪表盘展示当前加载的技能。
   * 每个技能项展示名称、关键词标签和来源层级（project/agent）。
   * 无技能时隐藏列表区域，显示空状态占位。
   * 原 DOM 位置可能已移除，所有元素查询均安全降级（null 检查），方法不会崩溃。
   *
   * @param skills 技能列表（由 DASHBOARD_GET 返回）
   */
  renderSkills(
    skills: Array<{
      name: string;
      keywords: string[];
      description: string;
      layer: string;
    }>,
  ): void {
    // 更新仪表盘技能计数（感知面板运行指标区）
    const countEl = document.getElementById('perception-skill-count');
    if (countEl) {
      countEl.textContent = String(skills.length);
    }

    const listEl = document.getElementById('skills-list');
    const sectionEl = document.getElementById('skills-section');
    const emptyEl = document.getElementById('skills-empty');
    if (!listEl || !sectionEl) return;

    if (!skills || skills.length === 0) {
      sectionEl.classList.add('hidden');
      // 显示空状态占位
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
   * 渲染里程碑成就展示（安全降级）
   *
   * 从仪表盘数据实时推导已达成的里程碑，不持久化（符合"自然遗忘"原则）。
   * 检测类型：
   *   1. 记忆量级：100/1000/10000 条
   *   2. 记忆源多样性：已探索的 source 类型数量
   *   3. 关键记忆类型（洞察、画像）
   * 原 DOM 位置可能已移除，所有元素查询均安全降级（null 检查），方法不会崩溃。
   *
   * @param data 仪表盘数据
   */
  renderMilestones(data: { total: number; bySource: Record<string, number> }): void {
    const milestonesDisplay = document.getElementById('milestones-display');
    const milestonesList = document.getElementById('milestones-list');
    if (!milestonesDisplay || !milestonesList) return;

    // 收集已达成的里程碑
    const milestones: Array<{ label: string; icon: string }> = [];

    // 记忆量级里程碑（百/千/万/十万）
    if (data.total >= 100) {
      const magnitude = Math.floor(Math.log10(data.total));
      milestones.push({
        label: MAGNITUDE_LABELS[magnitude] ?? `${Math.pow(10, magnitude)}+ 条`,
        icon: '📚',
      });
    }

    // 记忆源多样性里程碑
    const sourceCount = Object.keys(data.bySource).length;
    if (sourceCount >= 3) {
      milestones.push({
        label: `${sourceCount} 种记忆源`,
        icon: '🔗',
      });
    }

    // 洞察记忆存在里程碑
    if (data.bySource['insight'] && data.bySource['insight'] > 0) {
      milestones.push({
        label: '首个洞察',
        icon: '💡',
      });
    }

    // 画像记忆存在里程碑
    if (data.bySource['profile'] && data.bySource['profile'] > 0) {
      milestones.push({
        label: '建立画像',
        icon: '👤',
      });
    }

    // 无里程碑时隐藏区域
    if (milestones.length === 0) {
      milestonesDisplay.classList.add('hidden');
      return;
    }

    // 显示里程碑区域
    milestonesDisplay.classList.remove('hidden');

    // 清空并重建列表（遵循项目规范：while + removeChild，不用 innerHTML）
    while (milestonesList.firstChild) {
      milestonesList.removeChild(milestonesList.firstChild);
    }

    for (const milestone of milestones) {
      const badge = document.createElement('span');
      badge.className = 'milestone-badge';
      // 里程碑徽章为静态展示文本，使用 textContent 拼接图标和标签
      badge.textContent = `${milestone.icon} ${milestone.label}`;
      milestonesList.appendChild(badge);
    }
  }

  /**
   * 渲染对话回顾数据（安全降级，合并到学习与回顾节）
   *
   * 渲染到 #learning-progress 内的今日回顾行和趋势柱状图。
   * 原 DOM 位置可能已移除，所有元素查询均安全降级（null 检查），方法不会崩溃。
   *
   * @param data 对话回顾数据
   */
  renderReviewData(data: ReviewDataPayload): void {
    // ─── 今日概况 ──────────────────────────────────────
    const todayMemories = document.getElementById('review-today-memories');
    const todayInsights = document.getElementById('review-today-insights');
    if (todayMemories) todayMemories.textContent = String(data.today.newMemories);
    if (todayInsights) todayInsights.textContent = String(data.today.newInsights);

    // ─── 增长趋势 ──────────────────────────────────────
    const trendDir = document.getElementById('review-trend-dir');
    if (trendDir) {
      trendDir.textContent = TREND_ARROW_MAP[data.trend.direction] || '—';
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
    // 隐藏内部 insight.name（如 insight-xxxxx），展示用户可读的 contentPreview
    const insightsListEl = document.getElementById('recent-insights-list');
    if (insightsListEl) {
      clearElement(insightsListEl);
      for (const insight of data.insights.recent) {
        const li = document.createElement('li');
        li.className = 'recent-insight-item';
        // 截断前60字符作为预览，避免内部 ID 泄露
        const previewEl = document.createElement('span');
        previewEl.className = 'recent-insight-preview';
        const preview = insight.contentPreview || '(空洞察)';
        previewEl.textContent = preview.length > 60 ? preview.slice(0, 60) + '…' : preview;
        previewEl.title = preview; // 完整内容放在 title 中，鼠标悬停可查看
        li.appendChild(previewEl);
        insightsListEl.appendChild(li);
      }
    }
  }

  // ─── 记忆洞察面板渲染（委托到 InsightsRenderer） ────────

  /** 显示洞察面板加载态（委托到 InsightsRenderer） */
  showInsightsLoading(): void {
    this.insights.showLoading();
  }

  /**
   * 渲染记忆洞察数据（委托到 InsightsRenderer）
   *
   * @param dashboard 仪表盘数据子集（total/bySource/conflictCount）
   * @param graph 关系图谱数据
   */
  renderInsights(
    dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number },
    graph: RelationGraphData,
  ): void {
    this.insights.render(dashboard, graph);
  }

  /** 显示洞察面板加载失败状态（委托到 InsightsRenderer，带重试按钮） */
  showInsightsError(): void {
    this.insights.showError();
  }

  // ─── 健康度仪表盘渲染（委托到 HealthDashboardRenderer） ──

  /** 显示健康度面板加载态（委托到 HealthDashboardRenderer） */
  showHealthLoading(): void {
    this.healthDashboard.showLoading();
  }

  /**
   * 渲染记忆健康度仪表盘数据（委托到 HealthDashboardRenderer）
   *
   * @param data 健康度数据
   */
  renderHealthDashboard(data: HealthDashboardPayload): void {
    this.healthDashboard.render(data);
  }

  /** 显示健康度面板加载失败状态（委托到 HealthDashboardRenderer） */
  showHealthError(): void {
    this.healthDashboard.showError();
  }

  // ─── 记忆列表加载失败渲染 ──────────────────────────────

  /**
   * 显示记忆列表加载失败状态（带重试按钮）
   *
   * 用户点击重试按钮时触发 onReloadMemoryList 回调，由 Controller 重新拉取数据。
   *
   * @param listEl 记忆列表容器元素
   */
  showMemoryListError(listEl: HTMLElement): void {
    clearElement(listEl);
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-state';
    errorDiv.textContent = '加载记忆列表失败';
    const retryBtn = document.createElement('button');
    retryBtn.className = 'panel-error-btn inline-retry-btn';
    retryBtn.textContent = '重试';
    this.events.addEventListener(retryBtn, 'click', () => {
      this.reloadMemoryListCallback?.();
    });
    errorDiv.appendChild(retryBtn);
    listEl.appendChild(errorDiv);
  }

  // ─── 脉冲计数 ──────────────────────────────────────────

  /**
   * 仪表盘计数 +1 并触发脉冲动画
   *
   * 对齐 HTML 预览 §6.3 .stat-value.pulse。
   * 由精灵事件监听器在 memoryNoticed/insightGained 事件时调用。
   *
   * @param id 计数元素 DOM ID
   */
  pulseCounter(id: string): void {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(parseInt(el.textContent ?? '0') + 1);
    el.classList.add('pulse');
    // IX-03 跟踪定时器句柄，支持 cleanup 时统一清理
    const timer = window.setTimeout(() => {
      el.classList.remove('pulse');
      // 从跟踪数组中移除已完成的定时器
      const idx = this.pulseTimers.indexOf(timer);
      if (idx !== -1) this.pulseTimers.splice(idx, 1);
    }, DASHBOARD_PULSE_MS);
    this.pulseTimers.push(timer);
  }

  // ─── 私有辅助方法（source 健康映射） ──────────────────

  /**
   * 将记忆源健康状态映射为中文标签
   *
   * @param status 健康状态标识符（healthy/warning/critical）
   * @returns 中文标签
   */
  private getSourceHealthStatusLabel(status: 'healthy' | 'warning' | 'critical'): string {
    switch (status) {
      case 'healthy':
        return '健康';
      case 'warning':
        return '需关注';
      case 'critical':
        return '异常';
      default:
        return status;
    }
  }

  /**
   * 将 source 标识符映射为中文友好名称
   *
   * 与 PatternDetector.sourceLabel 保持一致，确保全 UI 层 source 命名统一。
   * 未知 source 透传原值，避免信息丢失。
   *
   * @param source 原始 source 字符串
   * @returns 中文标签
   */
  private getSourceLabel(source: string): string {
    const labels: Record<string, string> = {
      profile: '个人偏好',
      insight: '洞察',
      rule: '规则',
      skill: '技能',
      guardrail: '安全',
      chat: '对话',
      file: '文件',
      work: '工作',
      memory: '记忆',
      summary: '摘要',
      note: '笔记',
      persona: '角色',
      session: '会话',
    };
    return labels[source] ?? source;
  }

  // ─── 感知系统渲染（委托到 PerceptionRenderer） ─────────

  /** 更新情感基调展示（委托到 PerceptionRenderer） */
  updateAffectDisplay(affect: AffectPayload): void {
    this.perception.updateAffectDisplay(affect);
  }

  /** 更新默契度展示（委托到 PerceptionRenderer） */
  updateRapportDisplay(rapport: RapportPayload): void {
    this.perception.updateRapportDisplay(rapport);
  }

  /** 更新对话上下文展示（委托到 PerceptionRenderer） */
  updateContextDisplay(context: ContextPayload): void {
    this.perception.updateContextDisplay(context);
  }

  /** 更新模式洞察面板（委托到 PerceptionRenderer） */
  updatePatternsDisplay(payload: PatternsPayload): void {
    this.perception.updatePatternsDisplay(payload);
  }

  /** 更新主动提示统计展示（委托到 PerceptionRenderer，缺口 G+H） */
  updateProactiveStatsDisplay(stats: ProactiveStats | null): void {
    this.perception.updateProactiveStatsDisplay(stats);
  }

  /** 更新在场状态展示（委托到 PerceptionRenderer） */
  updatePresenceDisplay(payload: PresencePayload): void {
    this.perception.updatePresenceDisplay(payload);
  }

  /** 更新叙事摘要 DOM（委托到 PerceptionRenderer） */
  updateNarrative(): void {
    this.perception.updateNarrative();
  }

// ─── 伙伴洞察面板（委托到 PartnerInsightsRenderer） ─────────

  /**
   * 注册伙伴洞察面板记忆点击回调（委托到 PartnerInsightsRenderer）
   */
  onMemoryClick(cb: (memoryId: string) => void): void {
    this.partnerInsights.onMemoryClick(cb);
    // 缺口 K：感知面板模式洞察也复用同一跳转回调
    this.perception.onMemoryClick(cb);
  }

  /**
   * 渲染伙伴洞察面板（委托到 PartnerInsightsRenderer）
   *
   * @param memories 全量记忆列表（用于统计和趋势图）
   */
  renderPartnerInsights(memories: Array<{
    id: string;
    name: string;
    source: string;
    contentPreview: string;
    createdAt?: string;
  }>): void {
    this.partnerInsights.render(memories);
  }
}
