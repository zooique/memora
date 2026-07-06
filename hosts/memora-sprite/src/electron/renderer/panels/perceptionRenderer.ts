/**
 * 感知渲染器 — 仪表盘内"感知系统"子区域渲染与叙事合成
 *
 * 职责：
 * - 渲染情感基调（四维进度条 + 状态条）
 * - 渲染默契度（等级徽章 + 信任/熟悉度进度条 + 描述）
 * - 渲染对话上下文（节奏/连贯性/深度三列指标）
 * - 渲染模式洞察（PatternDetector 检测结果列表）
 * - 渲染在场状态（present/away 指示器 + 离开时长）
 * - 跨事件累积 lastNarrative* 状态，合成一句话叙事摘要
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 模式 D（自包含）：无 EventTracker 依赖（感知面板无重试按钮等需清理的事件）
 * - 状态 + 行为整体封装：5 个 lastNarrative* 字段仅供 generateNarrative 消费
 * - 由 DashboardPanelManager 持有实例，外观方法委托调用
 *
 * 行业规范依据：
 * - 封装原则（SRP）：状态与操作它的行为同属一个模块
 * - Facade Pattern（GoF）：Facade 不持有子系统专属状态，只做转发
 * - 高内聚（Cohesion）：感知合成与仪表盘统计渲染职责分离
 * - Information Hiding（Parnas）：generateNarrative 是 private，状态从未泄漏
 */

// P1 类型统一：感知数据 Payload 类型从 ipcListeners（IPC 契约真理源）导入
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from '../ipcListeners.js';
// 缺口 G+H：主动提示统计类型从 sprite controllers（真理源）导入（preload 仅内部使用，不 re-export）
import type { ProactiveStats } from '../../../sprite/controllers/index.js';
import { MS_PER_MINUTE } from '../../../sprite/constants.js';

// ─── 常量 ────────────────────────────────────────────────

/** 情感维度等级划分阈值：< AFFECT_LOW_THRESHOLD 为"低"，< AFFECT_MID_THRESHOLD 为"中"，否则为"高" */
const AFFECT_LOW_THRESHOLD = 0.33;
const AFFECT_MID_THRESHOLD = 0.67;

/** 接受率等级划分阈值：< 0.4 为低，< 0.7 为中，否则为高（与 confidence 徽章一致） */
const ACCEPTANCE_LOW_THRESHOLD = 0.4;
const ACCEPTANCE_MID_THRESHOLD = 0.7;

/** 叙事基调判定阈值：warmth/directness/initiative 超过此值时计入基调描述 */
const AFFECT_TONE_THRESHOLD = 0.6;

// ─── 感知渲染器 ────────────────────────────────────────────

/**
 * 感知渲染器
 *
 * 负责仪表盘内"感知系统"子区域的全部渲染与叙事合成逻辑。
 * 由 DashboardPanelManager 持有，通过外观方法委托调用。
 */
export class PerceptionRenderer {
  // ─── 叙事摘要：闭包级状态（跨事件累积，供 generateNarrative 合成） ──
  /** 最近一次上下文状态（从 ContextPayload 派生，消除内联重复） */
  private lastNarrativeContext: Pick<ContextPayload, 'rhythm' | 'coherence' | 'depth' | 'dominantSource'> | null = null;
  /** 最近一次情感基调 */
  private lastNarrativeAffect: AffectPayload | null = null;
  /** 最近一次默契度（从 RapportPayload 派生，消除内联重复） */
  private lastNarrativeRapport: Pick<RapportPayload, 'level' | 'trust'> | null = null;
  /** 最近一次检测到的模式 */
  private lastNarrativePatterns: Array<{ type: string; summary: string }> = [];
  /**
   * Phase 3.2：最近一次在场状态（首屏查询 + 事件累积统一入口）
   * awaySince 为 null 表示用户在场；非 null 为离开起始时间戳（毫秒）。
   */
  private lastNarrativePresence: { state: 'present' | 'away'; awaySince: number | null } | null = null;

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源（满足 PanelManager 生命周期契约）
   *
   * 感知渲染器无 EventTracker / 定时器等外部资源，方法体为空。
   * 保留方法以符合 ADR-SP-015 生命周期契约，便于未来扩展时统一调用。
   */
  cleanup(): void {
    // 当前无外部资源需清理；状态字段为跨事件累积，cleanup 时不重置
    // （与 DashboardPanelManager 生命周期一致，仅在实例销毁时由 GC 回收）
    // 缺口 K：清理回调引用，与 PartnerInsightsRenderer.cleanup 保持一致（ADR-SP-015 §2）
    this.onMemoryClickCallback = null;
  }

  // ─── 感知数据渲染入口 ──────────────────────────────────

  /**
   * 更新情感基调展示（仪表盘四维进度条 + 状态条指示）
   *
   * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
   * 渲染到仪表盘感知区 (#dashboard-{dim}-fill / #dashboard-{dim}-level)。
   * 同时更新精灵状态条 (#sprite-status-text-bar / #sprite-status-dot-bar)。
   * 同时保存状态供叙事摘要合成。
   *
   * @param affect 四维情感基调数值
   */
  updateAffectDisplay(affect: AffectPayload): void {
    // 保存状态供叙事摘要合成
    this.lastNarrativeAffect = affect;

    // 定义四维映射：id 前缀 → 数值
    const dimensions: Array<{ id: string; value: number }> = [
      { id: 'warmth', value: affect.warmth },
      { id: 'directness', value: affect.directness },
      { id: 'initiative', value: affect.initiative },
      { id: 'playfulness', value: affect.playfulness },
    ];

    // ─── 仪表盘情感进度条 ──────────────────────────
    for (const dim of dimensions) {
      const fillEl = document.getElementById(`dashboard-${dim.id}-fill`);
      const levelEl = document.getElementById(`dashboard-${dim.id}-level`);
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
   * 更新默契度展示（仪表盘等级徽章 + 双进度条 + 描述）
   *
   * 渲染到仪表盘感知区：等级徽章 (#dashboard-rapport-badge)、信任度进度条
   * (#dashboard-trust-fill)、熟悉度进度条 (#dashboard-familiarity-fill)、
   * 描述文本 (#dashboard-rapport-desc)。
   * 由 rapportUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 同时保存状态供叙事摘要合成。
   *
   * @param rapport 默契度数据
   */
  updateRapportDisplay(rapport: RapportPayload): void {
    // ─── 感知面板等级徽章 ────────────────────────────
    const rapportBadge = document.getElementById('dashboard-rapport-badge');
    if (rapportBadge) {
      rapportBadge.textContent = this.getRapportLevelLabel(rapport.level);
      rapportBadge.setAttribute('data-level', rapport.level);
    }

    // ─── 感知面板信任度进度条 ──────────────────────────
    const trustFill = document.getElementById('dashboard-trust-fill');
    if (trustFill) {
      trustFill.style.width = `${Math.round(rapport.trust * 100)}%`;
      trustFill.style.background = this.getAffectColor(rapport.trust);
    }

    // ─── 感知面板熟悉度进度条 ──────────────────────────
    const familiarityFill = document.getElementById('dashboard-familiarity-fill');
    if (familiarityFill) {
      familiarityFill.style.width = `${Math.round(rapport.familiarity * 100)}%`;
      familiarityFill.style.background = this.getAffectColor(rapport.familiarity);
    }

    // ─── 感知面板描述文本 ──────────────────────────────
    const rapportDesc = document.getElementById('dashboard-rapport-desc');
    if (rapportDesc) {
      rapportDesc.textContent = rapport.description;
    }

    // 保存状态供叙事摘要合成
    this.lastNarrativeRapport = { level: rapport.level, trust: rapport.trust };
    this.updateNarrative();
  }

  /**
   * 更新对话上下文展示（仪表盘三列指标）
   *
   * 渲染到仪表盘感知区：节奏 (#dashboard-pace-value)、话题 (#dashboard-topic-value)、
   * 深度 (#dashboard-depth-value)。
   * 由 contextUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 同时保存状态供叙事摘要合成。
   *
   * @param context 对话上下文数据
   */
  updateContextDisplay(context: ContextPayload): void {
    // ─── 感知面板节奏指标 ────────────────────────────
    const paceEl = document.getElementById('dashboard-pace-value');
    if (paceEl) {
      paceEl.textContent = this.describeRhythm(context.rhythm);
    }

    // ─── 感知面板话题连贯性指标 ────────────────────────
    const topicEl = document.getElementById('dashboard-topic-value');
    if (topicEl) {
      topicEl.textContent = this.describeCoherence(context.coherence);
    }

    // ─── 感知面板深度指标 ────────────────────────────
    const depthEl = document.getElementById('dashboard-depth-value');
    if (depthEl) {
      depthEl.textContent = this.describeDepth(context.depth);
    }

    // 保存状态供叙事摘要合成
    this.lastNarrativeContext = {
      rhythm: context.rhythm,
      coherence: context.coherence,
      depth: context.depth,
      dominantSource: context.dominantSource,
    };
    this.updateNarrative();
  }

  /**
   * 缺口 K：记忆跳转回调（点击模式洞察的"关联记忆"按钮时触发）
   *
   * 复用 DashboardPanelManager.onMemoryClick 注入路径，与 PartnerInsightsRenderer
   * 共享同一回调，点击后跳转记忆详情面板（showMemoryDetail）。
   */
  private onMemoryClickCallback: ((memoryId: string) => void) | null = null;

  /** 缺口 K：注册记忆跳转回调（由 DashboardPanelManager.onMemoryClick 委托注入） */
  onMemoryClick(cb: (memoryId: string) => void): void {
    this.onMemoryClickCallback = cb;
  }

  /**
   * 更新模式洞察面板（PatternDetector 检测结果）
   *
   * 由 patternsUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 渲染到仪表盘 #dashboard-patterns-list 容器中，每个 pattern 包含
   * 类型标签（repeat/gap/drift）和摘要文本。
   * 同时保存状态供叙事摘要合成。
   *
   * @param payload 模式洞察 payload
   */
  updatePatternsDisplay(payload: PatternsPayload): void {
    // 保存状态供叙事摘要合成
    this.lastNarrativePatterns = payload.patterns.map((p) => ({
      type: p.type,
      summary: p.summary,
    }));

    // 渲染到感知面板模式洞察容器
    const patternsList = document.getElementById('dashboard-patterns-list');
    // 紧凑布局：空列表时隐藏整个 section，避免占用空间
    const patternsSection = document.getElementById('dashboard-patterns');
    if (!patternsList) {
      this.updateNarrative();
      return;
    }

    // 无模式数据时清空列表并隐藏 section（但仍更新叙事摘要）
    if (payload.patterns.length === 0) {
      while (patternsList.firstChild) {
        patternsList.removeChild(patternsList.firstChild);
      }
      patternsSection?.classList.add('hidden');
      this.updateNarrative();
      return;
    }

    // 有数据时显示 section（可能之前被隐藏）
    patternsSection?.classList.remove('hidden');

    // 清空并重建列表（遵循项目规范：while + removeChild）
    while (patternsList.firstChild) {
      patternsList.removeChild(patternsList.firstChild);
    }

    for (const pattern of payload.patterns) {
      const item = document.createElement('div');
      item.className = 'perception-pattern-item';

      // 主行容器：类型徽章 + 置信度徽章 + 摘要文本横向排列
      const main = document.createElement('div');
      main.className = 'perception-pattern-main';

      // 类型标签：根据模式类型选择对应样式和文字
      // 后端 PatternType 映射：recurring_topic→重复、knowledge_gap→缺口、interest_drift→漂移
      const typeSpan = document.createElement('span');
      typeSpan.className = 'perception-pattern-type';
      switch (pattern.type) {
        case 'recurring_topic':
        case 'repeat':
          typeSpan.classList.add('repeat');
          typeSpan.textContent = '重复';
          break;
        case 'knowledge_gap':
        case 'gap':
          typeSpan.classList.add('gap');
          typeSpan.textContent = '缺口';
          break;
        case 'interest_drift':
        case 'drift':
          typeSpan.classList.add('drift');
          typeSpan.textContent = '漂移';
          break;
        default:
          typeSpan.classList.add('repeat');
          typeSpan.textContent = pattern.type;
          break;
      }

      // 置信度徽章：>= 0.7 高（绿）/ 0.4-0.7 中（黄）/ < 0.4 低（灰）
      // 让用户一眼看出该模式的可信程度，辅助判断是否需要采取行动
      const confidenceSpan = document.createElement('span');
      confidenceSpan.className = 'perception-pattern-confidence';
      if (pattern.confidence >= 0.7) {
        confidenceSpan.classList.add('high');
        confidenceSpan.textContent = '高置信';
      } else if (pattern.confidence >= 0.4) {
        confidenceSpan.classList.add('mid');
        confidenceSpan.textContent = '中置信';
      } else {
        confidenceSpan.classList.add('low');
        confidenceSpan.textContent = '低置信';
      }
      // 精确百分比作为 tooltip，hover 时可见
      confidenceSpan.title = `置信度 ${Math.round(pattern.confidence * 100)}%`;

      // 摘要文本（flex:1 占据剩余宽度，自然换行）
      const text = document.createElement('span');
      text.className = 'perception-pattern-text';
      text.textContent = pattern.summary;

      main.appendChild(typeSpan);
      main.appendChild(confidenceSpan);
      main.appendChild(text);

      item.appendChild(main);

      // 建议操作行：仅当 PatternDetector 提供了 suggestion 时渲染
      // 斜体灰色显示，作为给用户的可选行动指引
      if (pattern.suggestion) {
        const suggestion = document.createElement('div');
        suggestion.className = 'perception-pattern-suggestion';
        suggestion.textContent = `建议：${pattern.suggestion}`;
        item.appendChild(suggestion);
      }

      // 缺口 K：相关记忆跳转按钮（仅当 PatternDetector 检测到 relatedMemoryIds 时渲染）
      // 点击跳转第一条相关记忆详情，复用 onMemoryClick 回调（与伙伴洞察共享跳转路径）
      const relatedIds = pattern.relatedMemoryIds;
      if (relatedIds && relatedIds.length > 0) {
        // 非空断言：length > 0 保证 [0] 存在
        const firstId: string = relatedIds[0]!;
        const relatedBtn = document.createElement('button');
        relatedBtn.type = 'button';
        relatedBtn.className = 'perception-pattern-related';
        relatedBtn.textContent = `关联 ${relatedIds.length} 条记忆`;
        relatedBtn.title = '点击查看最相关的一条记忆';
        relatedBtn.addEventListener('click', () => {
          this.onMemoryClickCallback?.(firstId);
        });
        item.appendChild(relatedBtn);
      }

      patternsList.appendChild(item);
    }

    this.updateNarrative();
  }

  /**
   * 缺口 G+H：更新主动提示统计展示
   *
   * 消费 ProactiveEngine.getStats() 返回的统计快照，在感知面板展示：
   *   1. 历史反馈：建议数 / 接受数 / 接受率徽章（高/中/低 三色）
   *   2. 当前生效冷却：连续拒绝数 + 生效冷却时长（与基础冷却对比展示）
   *
   * 设计意图：让用户看到"我与精灵的互动累计"以及"为什么连续拒绝后精灵变安静"，
   * 与 pendingNotices/proactiveThreshold 形成"当前累积 + 历史反馈 + 生效参数"三位一体的主动度视图。
   *
   * @param stats 主动提示统计快照（null 时静默跳过，保持 DOM 默认值）
   */
  updateProactiveStatsDisplay(stats: ProactiveStats | null): void {
    // 无数据时静默跳过（保持 DOM 默认占位值，不阻塞面板渲染）
    if (!stats) return;

    // ─── 历史反馈：建议数 / 接受数 ──────────────────────
    const suggestEl = document.getElementById('dashboard-proactive-suggest');
    const acceptEl = document.getElementById('dashboard-proactive-accept');
    if (suggestEl) suggestEl.textContent = String(stats.suggestCount);
    if (acceptEl) acceptEl.textContent = String(stats.acceptCount);

    // ─── 接受率徽章（高/中/低 三色，与 PatternDetector confidence 徽章一致） ──
    const rateEl = document.getElementById('dashboard-proactive-rate');
    if (rateEl) {
      rateEl.textContent = `${Math.round(stats.acceptanceRate * 100)}%`;
      rateEl.classList.remove('high', 'mid', 'low');
      if (stats.acceptanceRate >= ACCEPTANCE_MID_THRESHOLD) {
        rateEl.classList.add('high');
      } else if (stats.acceptanceRate >= ACCEPTANCE_LOW_THRESHOLD) {
        rateEl.classList.add('mid');
      } else {
        rateEl.classList.add('low');
      }
      // suggestCount=0 时 acceptanceRate 为默认值 0.5，标注 tooltip 提示无实际数据
      rateEl.title = stats.suggestCount === 0
        ? '暂无互动数据（默认 50%）'
        : `接受率 ${Math.round(stats.acceptanceRate * 100)}%（${stats.acceptCount}/${stats.suggestCount}）`;
    }

    // ─── 连续拒绝数（>0 时高亮，提示用户精灵正在延长冷却） ──
    const rejectsEl = document.getElementById('dashboard-proactive-rejects');
    if (rejectsEl) {
      rejectsEl.textContent = String(stats.consecutiveRejects);
      rejectsEl.classList.toggle('warning', stats.consecutiveRejects > 0);
      rejectsEl.title = stats.consecutiveRejects > 0
        ? `连续拒绝 ${stats.consecutiveRejects} 次，冷却延长 ${Math.round((1 + stats.consecutiveRejects * 0.5) * 100)}%`
        : '无连续拒绝（冷却正常）';
    }

    // ─── 生效冷却时长（与基础冷却对比，体现默契度 + 拒绝惩罚双调节） ──
    const cooldownEl = document.getElementById('dashboard-proactive-cooldown');
    if (cooldownEl) {
      cooldownEl.textContent = this.formatCooldownMinutes(stats.effectiveCooldownMs);
      // 生效冷却 > 基础冷却时高亮，提示用户当前处于惩罚状态
      cooldownEl.classList.toggle('warning', stats.effectiveCooldownMs > stats.baseCooldownMs);
      cooldownEl.title = `基础 ${this.formatCooldownMinutes(stats.baseCooldownMs)} → 生效 ${this.formatCooldownMinutes(stats.effectiveCooldownMs)}`;
    }
  }

  /**
   * 将毫秒冷却时长格式化为人类可读的分钟/小时字符串
   *
   * < 1 分钟显示秒级，< 1 小时显示分钟，否则显示小时。
   * 用于主动提示生效冷却展示，让用户直观感知冷却长度。
   *
   * @param ms 冷却毫秒数
   * @returns 格式化后的字符串（如 "30 分钟" / "1.5 小时"）
   */
  private formatCooldownMinutes(ms: number): string {
    if (ms < MS_PER_MINUTE) return '< 1 分钟';
    const minutes = Math.round(ms / MS_PER_MINUTE);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours} 小时`;
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

    // 更新感知面板在场状态指示器 DOM
    const presenceDot = document.getElementById('dashboard-presence-dot');
    const presenceText = document.getElementById('dashboard-presence-text');
    if (presenceDot && presenceText) {
      if (payload.state === 'present') {
        presenceDot.className = 'presence-dot present';
        presenceText.textContent = '用户在场';
      } else {
        presenceDot.className = 'presence-dot away';
        // 计算离开时长显示
        const awayDurationMs = payload.awayDurationMs ?? 0;
        const awayMinutes = Math.floor(awayDurationMs / 60000);
        if (awayMinutes < 1) {
          presenceText.textContent = '用户刚离开';
        } else if (awayMinutes < 60) {
          presenceText.textContent = `用户已离开 ${awayMinutes} 分钟`;
        } else {
          const awayHours = Math.floor(awayMinutes / 60);
          presenceText.textContent = `用户已离开 ${awayHours} 小时`;
        }
      }
    }

    this.updateNarrative();
  }

  // ─── 叙事合成 ──────────────────────────────────────────

  /**
   * 更新叙事摘要 DOM
   *
   * 每次感知数据更新时调用，更新精灵状态条 #sprite-status-text-bar。
   * 内部从闭包级状态变量合成叙事文本。
   */
  updateNarrative(): void {
    const narrative = this.generateNarrative();

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
   * 综合感知系统输出，生成一句话叙事摘要
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
}
