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

import { clearElement, showPanelLoading } from '../helpers/domHelpers.js';
import type { EventTracker } from '../helpers/eventTracker.js';
import { getSourceColorClass } from './memoryPanelManager.js';
import type { ToastType } from '../types.js';
import type { HealthDashboardPayload, ReviewDataPayload } from '../../preload.js';
import type { RelationGraphData } from '../components/relationGraph.js';
// P1 类型统一：感知数据 Payload 类型从 ipcListeners（IPC 契约真理源）导入，消除 Data/Payload 双写
import type { AffectPayload, RapportPayload, ContextPayload, PatternsPayload, PresencePayload } from '../ipcListeners.js';
// P2 剪枝：仪表盘脉冲动画间隔常量从 constants.ts 真理源导入，消除散落定义
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
 * 仪表盘视图模型（对齐 IPC getDashboard 返回结构，仅声明 Manager 用到的字段）
 *
 * P0 类型统一：原 DashboardData 与 sprite 层 memoryController.DashboardData 同名冲突，
 * 重命名为 DashboardViewModel 以消除歧义。sprite 层 DashboardData 是"记忆仪表盘业务数据"，
 * 本类型是"完整仪表盘视图模型"（含事件/触发器/技能等 UI 字段），二者概念不同。
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

// P1 类型统一：AffectPayload/RapportPayload/ContextPayload/PatternsPayload
// 已从 ipcListeners.ts 导入（IPC 契约真理源），消除 Data/Payload 双写。
// 原AffectData/RapportData/ContextData/PatternsPayload 重复定义已删除。

// ─── 常量 ────────────────────────────────────────────────

/** 累积事件接近阈值的百分比（>=80% 显示黄色高亮） */
const NEAR_THRESHOLD_RATIO = 0.8;

/** 健康等级 → 中文标签映射 */
const HEALTH_LABEL_MAP: Record<string, string> = {
  excellent: '优秀',
  good: '良好',
  fair: '一般',
  poor: '较差',
};

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

/** 情感维度等级划分阈值：< AFFECT_LOW_THRESHOLD 为"低"，< AFFECT_MID_THRESHOLD 为"中"，否则为"高" */
const AFFECT_LOW_THRESHOLD = 0.33;
const AFFECT_MID_THRESHOLD = 0.67;

/** 叙事基调判定阈值：warmth/directness/initiative 超过此值时计入基调描述 */
const AFFECT_TONE_THRESHOLD = 0.6;

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

export class DashboardPanelManager {
  // ─── 内部状态 ────────────────────────────────────────────
  /** 脉冲动画定时器句柄列表（cleanup 时统一清理，避免回调在 DOM 销毁后触发） */
  private pulseTimers: number[] = [];

  // ─── FD-01 叙事摘要：闭包级状态（跨事件累积，供 generateNarrative 合成） ──
  /** 最近一次上下文状态（P1：从 ContextPayload 派生，消除内联重复） */
  private lastNarrativeContext: Pick<ContextPayload, 'rhythm' | 'coherence' | 'depth' | 'dominantSource'> | null = null;
  /** 最近一次情感基调 */
  private lastNarrativeAffect: AffectPayload | null = null;
  /** 最近一次默契度（P1：从 RapportPayload 派生，消除内联重复） */
  private lastNarrativeRapport: Pick<RapportPayload, 'level' | 'trust'> | null = null;
  /** 最近一次检测到的模式 */
  private lastNarrativePatterns: Array<{ type: string; summary: string }> = [];
  /**
   * Phase 3.2：最近一次在场状态（首屏查询 + 事件累积统一入口）
   * awaySince 为 null 表示用户在场；非 null 为离开起始时间戳（毫秒）。
   */
  private lastNarrativePresence: { state: 'present' | 'away'; awaySince: number | null } | null = null;

  // ─── 回调（由 Controller 注册，用于重试按钮触发数据重新加载） ──
  /** 重试加载洞察数据回调 */
  private reloadInsightsCallback: (() => void) | null = null;
  /** 重试加载健康度数据回调 */
  private reloadHealthCallback: (() => void) | null = null;
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
  }

  // ─── 回调注册 ──────────────────────────────────────────

  /** 注册重试加载洞察数据回调（用户点击重试按钮时触发） */
  onReloadInsights(cb: () => void): void {
    this.reloadInsightsCallback = cb;
  }

  /** 注册重试加载健康度数据回调（用户点击重试按钮时触发） */
  onReloadHealth(cb: () => void): void {
    this.reloadHealthCallback = cb;
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

  // ─── 记忆洞察面板渲染 ──────────────────────────────────

  /**
   * 显示洞察面板加载态（IPC 调用前调用）
   */
  showInsightsLoading(): void {
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
  renderInsights(
    dashboard: { total: number; bySource: Record<string, number>; conflictCount?: number },
    graph: RelationGraphData,
  ): void {
    // ─── 统计卡片 ────────────────────────────────────
    const totalEl = document.getElementById('insights-total');
    const relationsEl = document.getElementById('insights-relations');
    const conflictsEl = document.getElementById('insights-conflicts');
    const sourcesEl = document.getElementById('insights-sources');
    if (totalEl) totalEl.textContent = String(dashboard.total);
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
  }

  /**
   * 显示洞察面板加载失败状态（带重试按钮）
   *
   * 用户点击重试按钮时触发 onReloadInsights 回调，由 Controller 重新拉取数据。
   */
  showInsightsError(): void {
    const distEl = document.getElementById('insights-distribution');
    const summaryEl = document.getElementById('insights-relations-summary');

    if (distEl) {
      clearElement(distEl);
      distEl.textContent = '加载失败';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'panel-error-btn inline-retry-btn';
      retryBtn.textContent = '重试';
      this.events.addEventListener(retryBtn, 'click', () => {
        this.reloadInsightsCallback?.();
      });
      distEl.appendChild(retryBtn);
    }
    if (summaryEl) {
      clearElement(summaryEl);
      summaryEl.textContent = '加载失败';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'panel-error-btn inline-retry-btn';
      retryBtn.textContent = '重试';
      this.events.addEventListener(retryBtn, 'click', () => {
        this.reloadInsightsCallback?.();
      });
      summaryEl.appendChild(retryBtn);
    }
  }

  // ─── 健康度仪表盘渲染 ──────────────────────────────────

  /**
   * 显示健康度面板加载态（IPC 调用前调用）
   */
  showHealthLoading(): void {
    const healthBar = document.getElementById('memory-health-bar');
    // 在 health-metrics 区域插入加载态（不影响 header 区域）
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl) showPanelLoading(metricsEl, '加载健康度数据...');
  }

  /**
   * 渲染记忆健康度仪表盘数据（Phase 1：健康度诊断）
   *
   * 接收 Controller 拉取的健康度数据，渲染：
   * - 迷你健康分徽章（工具栏内）
   * - 健康度评分（总分）+ 健康等级徽章
   * - 三维度进度条（uniqueness/freshness/completeness）
   * - 详情计数（重复/过期/低质量）
   * - 健康描述文字
   * - 清理按钮可见性（仅在有可清理项时显示）
   *
   * @param data 健康度数据
   */
  renderHealthDashboard(data: HealthDashboardPayload): void {
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
      badgeEl.textContent = HEALTH_LABEL_MAP[data.healthLabel] || data.healthLabel;
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
    const staleCount = data.staleMemories.length;
    const hasCleanupTarget = duplicateCount > 0 || staleCount > 0;
    const dupBtn = document.getElementById('health-cleanup-duplicates');
    const staleBtn = document.getElementById('health-cleanup-stale');
    const allBtn = document.getElementById('health-cleanup-all');
    const actionsEl = document.getElementById('health-actions');

    if (dupBtn) dupBtn.style.display = duplicateCount > 0 ? '' : 'none';
    if (staleBtn) staleBtn.style.display = staleCount > 0 ? '' : 'none';
    if (allBtn) allBtn.style.display = hasCleanupTarget ? '' : 'none';
    if (actionsEl) actionsEl.style.display = hasCleanupTarget ? '' : 'none';
  }

  /**
   * 显示健康度面板加载失败状态（带重试按钮）
   *
   * 用户点击重试按钮时触发 onReloadHealth 回调，由 Controller 重新拉取数据。
   */
  showHealthError(): void {
    const healthBar = document.getElementById('memory-health-bar');
    const metricsEl = healthBar?.querySelector('.health-metrics');
    if (metricsEl) {
      clearElement(metricsEl as HTMLElement);
      const errorDiv = document.createElement('div');
      errorDiv.className = 'error-state';
      errorDiv.textContent = '加载失败';
      const retryBtn = document.createElement('button');
      retryBtn.className = 'panel-error-btn inline-retry-btn';
      retryBtn.textContent = '重试';
      this.events.addEventListener(retryBtn, 'click', () => {
        this.reloadHealthCallback?.();
      });
      errorDiv.appendChild(retryBtn);
      metricsEl.appendChild(errorDiv);
    }
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

  // ─── 感知系统渲染 ──────────────────────────────────────

  /**
   * 更新情感基调展示（感知面板四维进度条 + 状态条指示）
   *
   * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
   * 渲染到感知面板 (#perception-{dim}-fill / #perception-{dim}-level)。
   * 同时更新精灵状态条 (#sprite-status-text-bar / #sprite-status-dot-bar)。
   * 同时保存状态供叙事摘要合成。
   *
   * @param affect 四维情感基调数值
   */
  updateAffectDisplay(affect: AffectPayload): void {
    // FD-01：保存状态供叙事摘要合成
    this.lastNarrativeAffect = affect;

    // 定义四维映射：id 前缀 → 数值
    const dimensions: Array<{ id: string; value: number }> = [
      { id: 'warmth', value: affect.warmth },
      { id: 'directness', value: affect.directness },
      { id: 'initiative', value: affect.initiative },
      { id: 'playfulness', value: affect.playfulness },
    ];

    // ─── 感知面板情感进度条 ──────────────────────────
    for (const dim of dimensions) {
      const fillEl = document.getElementById(`perception-${dim.id}-fill`);
      const levelEl = document.getElementById(`perception-${dim.id}-level`);
      if (fillEl) {
        fillEl.style.width = `${Math.round(dim.value * 100)}%`;
        fillEl.style.background = this.getAffectColor(dim.value);
      }
      if (levelEl) {
        levelEl.textContent = this.getAffectLevel(dim.value);
      }
    }

    // ─── 精灵状态条文字（根据主导情感维度生成简短状态描述） ────
    const statusTextBar = document.getElementById('sprite-status-text-bar');
    if (statusTextBar) {
      const dominant = dimensions.reduce((a, b) => (a.value > b.value ? a : b));
      const dominantLabel = { warmth: '温暖', directness: '直接', initiative: '主动', playfulness: '活泼' }[dominant.id] ?? dominant.id;
      statusTextBar.textContent = `基调：${dominantLabel}（${this.getAffectLevel(dominant.value)}）`;
    }

    // ─── 精灵状态脉冲点（颜色随主导情感维度变化） ────
    const statusDotBar = document.getElementById('sprite-status-dot-bar');
    if (statusDotBar) {
      const dominant = dimensions.reduce((a, b) => (a.value > b.value ? a : b));
      statusDotBar.style.background = this.getAffectColor(dominant.value);
    }

    // 感知数据变化后更新叙事摘要
    this.updateNarrative();
  }

  /**
   * 更新默契度展示（感知面板等级徽章 + 双进度条 + 描述）
   *
   * 渲染到感知面板：等级徽章 (#perception-rapport-badge)、信任度进度条
   * (#perception-trust-fill)、熟悉度进度条 (#perception-familiarity-fill)、
   * 描述文本 (#perception-rapport-desc)。
   * 由 rapportUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 同时保存状态供叙事摘要合成。
   *
   * @param rapport 默契度数据
   */
  updateRapportDisplay(rapport: RapportPayload): void {
    // ─── 感知面板等级徽章 ────────────────────────────
    const rapportBadge = document.getElementById('perception-rapport-badge');
    if (rapportBadge) {
      rapportBadge.textContent = this.getRapportLevelLabel(rapport.level);
      rapportBadge.setAttribute('data-level', rapport.level);
    }

    // ─── 感知面板信任度进度条 ──────────────────────────
    const trustFill = document.getElementById('perception-trust-fill');
    if (trustFill) {
      trustFill.style.width = `${Math.round(rapport.trust * 100)}%`;
      trustFill.style.background = this.getAffectColor(rapport.trust);
    }

    // ─── 感知面板熟悉度进度条 ──────────────────────────
    const familiarityFill = document.getElementById('perception-familiarity-fill');
    if (familiarityFill) {
      familiarityFill.style.width = `${Math.round(rapport.familiarity * 100)}%`;
      familiarityFill.style.background = this.getAffectColor(rapport.familiarity);
    }

    // ─── 感知面板描述文本 ──────────────────────────────
    const rapportDesc = document.getElementById('perception-rapport-desc');
    if (rapportDesc) {
      rapportDesc.textContent = rapport.description;
    }

    // FD-01：保存状态供叙事摘要合成
    this.lastNarrativeRapport = { level: rapport.level, trust: rapport.trust };
    this.updateNarrative();
  }

  /**
   * 更新对话上下文展示（感知面板三列指标）
   *
   * 渲染到感知面板：节奏 (#perception-pace-value)、话题 (#perception-topic-value)、
   * 深度 (#perception-depth-value)。
   * 由 contextUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 同时保存状态供叙事摘要合成。
   *
   * @param context 对话上下文数据
   */
  updateContextDisplay(context: ContextPayload): void {
    // ─── 感知面板节奏指标 ────────────────────────────
    const paceEl = document.getElementById('perception-pace-value');
    if (paceEl) {
      paceEl.textContent = this.describeRhythm(context.rhythm);
    }

    // ─── 感知面板话题连贯性指标 ────────────────────────
    const topicEl = document.getElementById('perception-topic-value');
    if (topicEl) {
      topicEl.textContent = this.describeCoherence(context.coherence);
    }

    // ─── 感知面板深度指标 ────────────────────────────
    const depthEl = document.getElementById('perception-depth-value');
    if (depthEl) {
      depthEl.textContent = this.describeDepth(context.depth);
    }

    // FD-01：保存状态供叙事摘要合成
    this.lastNarrativeContext = {
      rhythm: context.rhythm,
      coherence: context.coherence,
      depth: context.depth,
      dominantSource: context.dominantSource,
    };
    this.updateNarrative();
  }

  /**
   * 更新模式洞察面板（PatternDetector 检测结果）
   *
   * 由 patternsUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 渲染到感知面板 #perception-patterns-list 容器中，每个 pattern 包含
   * 类型标签（repeat/gap/drift）和摘要文本。
   * 同时保存状态供叙事摘要合成。
   *
   * @param payload 模式洞察 payload
   */
  updatePatternsDisplay(payload: PatternsPayload): void {
    // FD-01：保存状态供叙事摘要合成
    this.lastNarrativePatterns = payload.patterns.map((p) => ({
      type: p.type,
      summary: p.summary,
    }));

    // 渲染到感知面板模式洞察容器
    const patternsList = document.getElementById('perception-patterns-list');
    if (!patternsList) {
      this.updateNarrative();
      return;
    }

    // 无模式数据时清空列表（但仍更新叙事摘要）
    if (payload.patterns.length === 0) {
      while (patternsList.firstChild) {
        patternsList.removeChild(patternsList.firstChild);
      }
      this.updateNarrative();
      return;
    }

    // 清空并重建列表（遵循项目规范：while + removeChild）
    while (patternsList.firstChild) {
      patternsList.removeChild(patternsList.firstChild);
    }

    for (const pattern of payload.patterns) {
      const item = document.createElement('div');
      item.className = 'perception-pattern-item';

      // 类型标签：根据模式类型选择对应样式和文字
      const typeSpan = document.createElement('span');
      typeSpan.className = 'perception-pattern-type';
      switch (pattern.type) {
        case 'repeat':
          typeSpan.classList.add('repeat');
          typeSpan.textContent = '重复';
          break;
        case 'gap':
          typeSpan.classList.add('gap');
          typeSpan.textContent = '缺口';
          break;
        case 'drift':
          typeSpan.classList.add('drift');
          typeSpan.textContent = '漂移';
          break;
        default:
          typeSpan.classList.add('repeat');
          typeSpan.textContent = pattern.type;
          break;
      }

      // 摘要文本
      const text = document.createElement('span');
      text.textContent = pattern.summary;

      item.appendChild(typeSpan);
      item.appendChild(text);

      patternsList.appendChild(item);
    }

    this.updateNarrative();
  }

  /**
   * Phase 3.2：更新在场状态展示
   *
   * 统一入口：首屏主动查询（PRESENCE_GET）与被动事件（presenceChanged）均通过此方法接入。
   * 将 PresencePayload 转换为内部 lastNarrativePresence 状态（state + awaySince），
   * 供叙事摘要合成时使用（用户离开时叙事应体现"用户不在"）。
   *
   * @param payload 在场状态事件载荷（首屏查询时由 loadPresence 构造，reason='initial-query'）
   */
  updatePresenceDisplay(payload: PresencePayload): void {
    // 从事件载荷派生 awaySince：
    // - state='present' 时 awaySince=null（用户在场）
    // - state='away' 且有 awayDurationMs 时，awaySince = Date.now() - awayDurationMs
    // - state='away' 且无 awayDurationMs 时，awaySince = Date.now()（兜底，避免 null 歧义）
    if (payload.state === 'present') {
      this.lastNarrativePresence = { state: 'present', awaySince: null };
    } else {
      const awaySince = payload.awayDurationMs !== null && payload.awayDurationMs !== undefined
        ? Date.now() - payload.awayDurationMs
        : Date.now();
      this.lastNarrativePresence = { state: 'away', awaySince };
    }
    this.updateNarrative();
  }

  /**
   * FD-01 更新叙事摘要 DOM
   *
   * 每次感知数据更新时调用，渲染到感知面板 #perception-narrative-text。
   * 同时更新精灵状态条 #sprite-status-text-bar。
   * 内部从闭包级状态变量合成叙事文本。
   */
  updateNarrative(): void {
    const narrative = this.generateNarrative();

    // ─── 感知面板叙事文本 ──────────────────────────────
    const perceptionNarrativeText = document.getElementById('perception-narrative-text');
    if (perceptionNarrativeText) {
      perceptionNarrativeText.textContent = narrative;
    }

    // ─── 精灵状态条文字（非 idle 状态时更新） ────────────
    const isIdle = this.lastNarrativeContext?.rhythm === 'idle' || !this.lastNarrativeContext;
    if (!isIdle) {
      const statusTextBar = document.getElementById('sprite-status-text-bar');
      if (statusTextBar) {
        statusTextBar.textContent = narrative;
      }
    }
  }

  // ─── 私有辅助方法（感知数据映射） ──────────────────────

  /**
   * 将 0-1 数值映射为中文等级描述
   *
   * @param value 0-1 之间的数值
   * @returns 中文等级（低/中/高）
   */
  private getAffectLevel(value: number): string {
    if (value < AFFECT_LOW_THRESHOLD) return '低';
    if (value < AFFECT_MID_THRESHOLD) return '中';
    return '高';
  }

  /**
   * 将 0-1 数值映射为进度条颜色（CSS 变量引用）
   *
   * 低→var(--affect-low) 中→var(--affect-mid) 高→var(--affect-high)
   * 使用 CSS 变量支持主题切换。
   *
   * @param value 0-1 之间的数值
   * @returns CSS 变量引用字符串
   */
  private getAffectColor(value: number): string {
    if (value < AFFECT_LOW_THRESHOLD) return 'var(--affect-low)';
    if (value < AFFECT_MID_THRESHOLD) return 'var(--affect-mid)';
    return 'var(--affect-high)';
  }

  /**
   * 将默契度等级映射为中文标签（Phase 3）
   *
   * @param level 等级标识符（stranger/acquaintance/familiar/close）
   * @returns 中文标签
   */
  private getRapportLevelLabel(level: string): string {
    switch (level) {
      case 'stranger':
        return '初识';
      case 'acquaintance':
        return '相识';
      case 'familiar':
        return '熟悉';
      case 'close':
        return '亲密';
      default:
        return level;
    }
  }

  /**
   * 将对话节奏映射为中文标签（Phase 4，与 ContextAwareness.describeRhythm 一致）
   *
   * @param rhythm 节奏标识符
   * @returns 中文标签
   */
  private describeRhythm(rhythm: string): string {
    switch (rhythm) {
      case 'rapid':
        return '快节奏';
      case 'normal':
        return '正常';
      case 'slow':
        return '慢节奏';
      case 'idle':
        return '空闲';
      default:
        return rhythm;
    }
  }

  /**
   * 将话题连贯性映射为中文标签（Phase 4，与 ContextAwareness.describeCoherence 一致）
   *
   * @param coherence 连贯性标识符
   * @returns 中文标签
   */
  private describeCoherence(coherence: string): string {
    switch (coherence) {
      case 'focused':
        return '专注';
      case 'moderate':
        return '中等';
      case 'scattered':
        return '分散';
      case 'none':
        return '无';
      default:
        return coherence;
    }
  }

  /**
   * 将对话深度映射为中文标签（Phase 4，与 ContextAwareness.describeDepth 一致）
   *
   * @param depth 深度标识符
   * @returns 中文标签
   */
  private describeDepth(depth: string): string {
    switch (depth) {
      case 'deep':
        return '深度讨论';
      case 'moderate':
        return '一般讨论';
      case 'shallow':
        return '浅层问答';
      case 'none':
        return '无';
      default:
        return depth;
    }
  }



  /**
   * FD-01 综合感知系统输出，生成一句话叙事摘要
   *
   * 数据来源：ContextAwareness + AffectController + RapportController + PatternDetector
   * 纯客户端合成，不触发 IPC，不依赖 LLM。
   *
   * @returns 叙事摘要文本
   */
  private generateNarrative(): string {
    const parts: string[] = [];

    // Phase 3.2：在场状态（用户离开时优先展示，覆盖其他叙事）
    if (this.lastNarrativePresence?.state === 'away' && this.lastNarrativePresence.awaySince !== null) {
      const awayMinutes = Math.max(1, Math.floor((Date.now() - this.lastNarrativePresence.awaySince) / 60000));
      parts.push(`用户已离开 ${awayMinutes} 分钟`);
    }

    // 对话上下文
    if (this.lastNarrativeContext && this.lastNarrativeContext.rhythm !== 'idle') {
      const rhythmLabel = this.describeRhythm(this.lastNarrativeContext.rhythm);
      parts.push(`对话节奏${rhythmLabel}`);
    }
    if (
      this.lastNarrativeContext &&
      this.lastNarrativeContext.coherence === 'focused' &&
      this.lastNarrativeContext.dominantSource
    ) {
      parts.push(`正在专注讨论${this.lastNarrativeContext.dominantSource}相关话题`);
    } else if (this.lastNarrativeContext && this.lastNarrativeContext.coherence === 'scattered') {
      parts.push('话题较为分散');
    }

    // 互动基调
    if (this.lastNarrativeAffect) {
      const tones: string[] = [];
      if (this.lastNarrativeAffect.warmth > AFFECT_TONE_THRESHOLD) tones.push('温暖');
      if (this.lastNarrativeAffect.directness > AFFECT_TONE_THRESHOLD) tones.push('直接');
      if (this.lastNarrativeAffect.initiative > AFFECT_TONE_THRESHOLD) tones.push('主动');
      if (tones.length > 0) {
        parts.push(`基调${tones.join('、')}`);
      }
    }

    // 默契度
    if (this.lastNarrativeRapport) {
      const levelLabel = this.getRapportLevelLabel(this.lastNarrativeRapport.level);
      if (levelLabel !== '初识') {
        parts.push(`默契度：${levelLabel}`);
      }
    }

    // 模式洞察
    if (this.lastNarrativePatterns.length > 0) {
      const recurringCount = this.lastNarrativePatterns.filter(
        (p) => p.type === 'recurring_topic',
      ).length;
      const gapCount = this.lastNarrativePatterns.filter(
        (p) => p.type === 'knowledge_gap',
      ).length;
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

// ─── 伙伴洞察面板（Phase 2：伙伴感） ────────────────────────

  /** 伙伴洞察面板记忆点击回调 */
  private onMemoryClickCallback: ((memoryId: string) => void) | null = null;

  /**
   * 注册伙伴洞察面板记忆点击回调
   *
   * 点击 profile 卡片时，通知 controller 切换到记忆面板并定位到该记忆。
   */
  onMemoryClick(cb: (memoryId: string) => void): void {
    this.onMemoryClickCallback = cb;
  }

  /**
   * 渲染伙伴洞察面板
   *
   * 包含三部分：
   * 1. Profile 记忆卡片网格（展示精灵对你的了解）
   * 2. 知识缺口检测（source 类型占比 < 5% 的提醒）
   * 3. 记忆累积趋势图（Canvas 折线图，8 周数据）
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
    const panel = document.getElementById('partner-insights');
    if (!panel) return;

    // 有数据时显示面板，无数据时保持隐藏
    if (memories.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    // 筛选 profile 记忆（精灵对你的了解）
    const profileMems = memories.filter((m) => m.source === 'profile');
    const profileCardsContainer = panel.querySelector('.partner-profile-cards');
    if (profileCardsContainer) {
      this.renderProfileCards(profileMems, profileCardsContainer as HTMLElement);
    }

    // 知识缺口检测
    const gapsContainer = panel.querySelector('.partner-gaps');
    if (gapsContainer) {
      this.renderKnowledgeGaps(memories, gapsContainer as HTMLElement);
    }

    // 记忆累积趋势图
    this.renderGrowthChart(memories);
  }

  /**
   * 渲染 profile 记忆卡片网格
   *
   * 最多展示 6 张卡片，点击可跳转到记忆详情。
   * 使用 CSS 变量适配主题色，与项目设计系统一致。
   */
  private renderProfileCards(
    profileMems: Array<{ id: string; name: string; source: string; contentPreview: string; createdAt?: string }>,
    container: HTMLElement,
  ): void {
    // 清空容器（遵循项目规范：while + removeChild）
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (profileMems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'partner-empty-hint';
      empty.textContent = '精灵还不了解你，多和它聊聊吧';
      container.appendChild(empty);
      return;
    }

    // 最多展示 6 张卡片
    const cards = profileMems.slice(0, 6);
    for (const mem of cards) {
      const card = document.createElement('div');
      card.className = 'partner-profile-card';
      card.title = mem.contentPreview;

      // 卡片被点击时，通过回调通知 controller
      card.addEventListener('click', () => {
        this.onMemoryClickCallback?.(mem.id);
      });

      // 记忆名称
      const nameEl = document.createElement('div');
      nameEl.className = 'partner-profile-card-name';
      nameEl.textContent = mem.name;
      card.appendChild(nameEl);

      // 内容预览（截断 80 字符）
      const previewEl = document.createElement('div');
      previewEl.className = 'partner-profile-card-preview';
      previewEl.textContent = mem.contentPreview.length > 80
        ? mem.contentPreview.slice(0, 80) + '...'
        : mem.contentPreview;
      card.appendChild(previewEl);

      container.appendChild(card);
    }
  }

  /**
   * 渲染知识缺口列表
   *
   * 检测 source 类型占比 < 5% 的类别，提示用户补充对应类型的记忆。
   * 最多展示 3 条缺口。
   */
  private renderKnowledgeGaps(
    memories: Array<{ source: string }>,
    container: HTMLElement,
  ): void {
    // 清空容器
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    if (memories.length === 0) return;

    // 统计各 source 类型数量
    const total = memories.length;
    const sourceCounts: Record<string, number> = {};
    for (const mem of memories) {
      const source = mem.source || 'unknown';
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }

    // 已知的 source 类型及其缺口中文化描述
    const sourceDescriptions: Record<string, string> = {
      profile: '精灵还不了解你的个人信息',
      insight: '精灵还没有形成对你的洞察',
      skill: '精灵还不了解你的技能和专长',
      rule: '你还没有设定与精灵的互动规则',
      guardrail: '精灵还没有设置内容护栏',
      persona: '精灵还没有角色偏好记忆',
      session: '精灵还没有会话总结',
    };

    // 找出占比 < 5% 的类型
    const gaps: Array<{ source: string; description: string }> = [];
    for (const [source, desc] of Object.entries(sourceDescriptions)) {
      const count = sourceCounts[source] || 0;
      if (count / total < 0.05) {
        gaps.push({ source, description: desc });
      }
    }

    if (gaps.length === 0) {
      const complete = document.createElement('p');
      complete.className = 'partner-empty-hint';
      complete.textContent = '精灵对你的了解已经比较全面了';
      container.appendChild(complete);
      return;
    }

    // 最多展示 3 条
    for (const gap of gaps.slice(0, 3)) {
      const item = document.createElement('div');
      item.className = 'partner-gap-item';

      const icon = document.createElement('span');
      icon.className = 'partner-gap-icon';
      icon.textContent = '💡';

      const text = document.createElement('span');
      text.className = 'partner-gap-text';
      text.textContent = gap.description;

      item.appendChild(icon);
      item.appendChild(text);
      container.appendChild(item);
    }
  }

  /**
   * 渲染记忆累积趋势图（Canvas 折线图，零依赖）
   *
   * 按周统计记忆累积数量，绘制折线图展示增长趋势。
   * 使用 Canvas 2D API 纯手绘，不引入任何图表库。
   * 颜色通过 CSS 变量动态读取，支持亮色/暗色主题切换。
   */
  private renderGrowthChart(memories: Array<{ createdAt?: string }>): void {
    const canvas = document.getElementById('partner-growth-chart') as HTMLCanvasElement | null;
    const totalEl = document.getElementById('partner-growth-total');
    if (!canvas) return;

    // 更新总数
    if (totalEl) {
      totalEl.textContent = `${memories.length} 条`;
    }

    // 按周统计（最近 8 周：idx 0=8周前[最远]，idx 7=本周[最近]）
    const now = new Date();
    const weekLabels: string[] = [];
    const weekCounts: number[] = [];

    // 从 8 周前到本周依次初始化
    for (let weeksAgo = 7; weeksAgo >= 0; weeksAgo--) {
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - (weeksAgo * 7 + 6));
      const label = `${weekStart.getMonth() + 1}/${weekStart.getDate()}`;
      weekLabels.push(label);
      weekCounts.push(0);
    }

    // 统计各周的记忆数量
    const WEEK_COUNT = 8;
    for (const mem of memories) {
      if (!mem.createdAt) continue;
      const date = new Date(mem.createdAt);
      for (let idx = 0; idx < WEEK_COUNT; idx++) {
        // weeksAgo: 7-idx（idx=0→7=8周前，idx=7→0=本周）
        const weeksAgo = WEEK_COUNT - 1 - idx;
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (weeksAgo * 7 + 6));
        weekStart.setHours(0, 0, 0, 0);
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() - weeksAgo * 7);
        weekEnd.setHours(23, 59, 59, 999);

        if (date >= weekStart && date <= weekEnd) {
          weekCounts[idx]!++;
          break;
        }
      }
    }

    // 计算累积值（从过去到现在累加）
    const cumulative: number[] = new Array(WEEK_COUNT);
    let runningTotal = 0;
    for (let idx = 0; idx < WEEK_COUNT; idx++) {
      runningTotal += weekCounts[idx]!;
      cumulative[idx] = runningTotal;
    }

    // Canvas 绘制
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = 120;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // 从 CSS 变量读取主题色（与项目主题系统一致，而非硬编码）
    const rootStyle = getComputedStyle(document.documentElement);
    const cssVar = (name: string, fallback: string): string =>
      rootStyle.getPropertyValue(name).trim() || fallback;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = cssVar('--surface0', isDark ? '#1e1e2e' : '#ececee');
    const accentColor = cssVar('--accent', '#0066ff');
    const fillColor = isDark ? 'rgba(0, 102, 255, 0.1)' : 'rgba(0, 102, 255, 0.08)';
    const textColor = cssVar('--text-3', '#a1a1a6');
    const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, w, h);

    // 边距
    const padding = { top: 16, right: 12, bottom: 24, left: 12 };
    const chartW = w - padding.left - padding.right;
    const chartH = h - padding.top - padding.bottom;

    // 计算 Y 轴范围
    const maxVal = Math.max(...cumulative, 1);
    const yMax = maxVal * 1.15; // 留 15% 顶部空间

    // 绘制网格线
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = padding.top + (chartH * i / 3);
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(w - padding.right, y);
      ctx.stroke();
    }

    // 计算折线数据点
    const points: Array<{ x: number; y: number }> = [];
    for (let idx = 0; idx < WEEK_COUNT; idx++) {
      const x = padding.left + (chartW * idx / (WEEK_COUNT - 1));
      const y = padding.top + chartH - (cumulative[idx]! / yMax * chartH);
      points.push({ x, y });
    }

    // 填充区域
    ctx.beginPath();
    ctx.moveTo(points[0]!.x, padding.top + chartH);
    for (const p of points) {
      ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(points[WEEK_COUNT - 1]!.x, padding.top + chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    // 折线
    ctx.beginPath();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let idx = 0; idx < points.length; idx++) {
      if (idx === 0) {
        ctx.moveTo(points[idx]!.x, points[idx]!.y);
      } else {
        ctx.lineTo(points[idx]!.x, points[idx]!.y);
      }
    }
    ctx.stroke();

    // 数据点
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = accentColor;
      ctx.fill();
    }

    // X 轴标签
    ctx.fillStyle = textColor;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    for (let idx = 0; idx < weekLabels.length; idx++) {
      const x = padding.left + (chartW * idx / (weekLabels.length - 1 || 1));
      ctx.fillText(weekLabels[idx]!, x, h - 4);
    }
  }
}
