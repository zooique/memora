/**
 * 感知面板管理器 — 独立感知面板 UI 逻辑
 *
 * 职责：
 * - 管理感知面板所有 DOM 元素引用
 * - 渲染情感基调（四维进度条 + 等级）
 * - 渲染默契度（等级徽章 + 信任/熟悉双进度条 + 描述）
 * - 渲染对话上下文（节奏/话题/深度三卡片）
 * - 渲染模式洞察（PatternDetector 检测结果列表）
 * - 渲染在场状态（present/away 指示器 + 离开时长）
 * - 渲染主动提示统计（建议/接受/接受率/连续拒绝/生效冷却）
 * - 合成叙事摘要（一句话总结当前感知状态）
 *
 * 设计原则（遵循 ADR-SP-015 组合模式）：
 * - 自包含状态（5 个 lastNarrative* 字段仅供 generateNarrative 消费）
 * - 通过 Host 接口与 UIManager 解耦
 * - 与 PerceptionRenderer 共享相同的数据模型但渲染到不同 DOM
 * - 感知面板信息密度更高，是仪表盘感知区的"完整版"
 *
 * 与 DashboardPanelManager 的关系：
 * - 仪表盘保留概览区的默契度徽章（精简版，一眼可见）
 * - 感知面板提供完整的感知数据和叙事摘要
 * - 两者共享同一数据源（事件推送 + 快照查询）
 */

import type { EventTracker } from '../helpers/eventTracker.js';
import type { ToastType } from '../types.js';
// P1 类型统一：感知数据 Payload 类型从 ipcListeners（IPC 契约真理源）导入
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from '../ipcListeners.js';
// 主动提示统计类型从 sprite controllers（真理源）导入
import type { ProactiveStats } from '../../../sprite/controllers/index.js';
import { MS_PER_MINUTE } from '../../../sprite/constants.js';
import { NarrativeGenerator } from '../helpers/narrativeGenerator.js';
// 感知标签映射（统一真理源，消除 6 个私有方法的重复实现）
import {
  getAffectLevel,
  getAffectColor,
  getRapportLevelLabel,
  describeRhythm,
  describeCoherence,
  describeDepth,
} from '../helpers/perceptionLabels.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 感知面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface PerceptionPanelHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
}

// ─── 常量 ────────────────────────────────────────────────

/** 接受率等级划分阈值：< 0.4 为低，< 0.7 为中，否则为高（与 confidence 徽章一致） */
const ACCEPTANCE_LOW_THRESHOLD = 0.4;
const ACCEPTANCE_MID_THRESHOLD = 0.7;

// ─── 感知面板管理器类 ─────────────────────────────────────

/**
 * 感知面板管理器
 *
 * 负责独立感知面板的全部渲染与交互逻辑。
 * 由 UIManager 持有，通过外观方法委托调用。
 * 数据模型与 PerceptionRenderer 一致，但 DOM 元素 ID 前缀为 perception-*
 * （区别于仪表盘的 dashboard-* 前缀）。
 */
export class PerceptionPanelManager {
  // ─── 叙事摘要生成器（统一管理 5 类感知数据累积 + 叙事合成） ──
  /** 叙事摘要生成器实例，替代原 5 个 lastNarrative* 字段 + generateNarrative 方法 */
  private narrativeGenerator = new NarrativeGenerator();

  // ─── 宿主引用 ──────────────────────────────────────────

  /** 宿主能力（跨模块关注点注入，当前感知面板为纯展示型暂未使用，保留供未来扩展） */
  private _host: PerceptionPanelHost;

  // ─── 构造 ──────────────────────────────────────────────

  /**
   * 构造感知面板管理器
   *
   * @param host 宿主能力注入（showToast 等跨模块关注点）
   */
  constructor(host: PerceptionPanelHost) {
    this._host = host;
  }

  // ─── 初始化 ────────────────────────────────────────────

  /**
   * 初始化感知面板事件监听
   *
   * 目前感知面板无交互按钮（纯展示型面板），方法体为空。
   * 保留方法以符合 ADR-SP-015 生命周期契约，便于未来扩展。
   *
   * @param _events 事件跟踪器（预留，当前未使用）
   */
  init(_events: EventTracker): void {
    // 当前感知面板为纯展示型，无事件需绑定
    // 未来添加交互（如模式洞察的"查看关联记忆"按钮）时在此注册
    // 保留 _host 引用供未来扩展交互功能使用（消除 TS6133 未使用警告）
    void this._host;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源（满足 PanelManager 生命周期契约）
   *
   * 感知面板无定时器/事件监听器等外部资源，方法体为空。
   * 保留方法以符合 ADR-SP-015 生命周期契约。
   */
  cleanup(): void {
    // 当前无外部资源需清理
  }

  // ─── 感知数据渲染入口 ──────────────────────────────────

  /**
   * 从感知快照一次性渲染所有感知数据（面板首次加载时调用）
   *
   * 设计背景：原感知数据依赖事件推送，但面板首次加载时若事件尚未触发，
   * 则显示全 0 占位值，用户体验差。
   * 此方法通过 getPerceptionSnapshot() 获取的快照一次性初始化所有感知显示。
   *
   * 各子数据可选存在，仅渲染快照中包含的字段，缺失字段保持原状态。
   *
   * @param snapshot 感知快照（来自 getPerceptionSnapshot()）
   */
  renderPerceptionSnapshot(snapshot: {
    affect?: { warmth: number; playfulness: number; directness: number; initiative: number };
    rapport?: { trust: number; familiarity: number; level: string; description: string };
    context?: { rhythm: string; coherence: string; depth: string; dominantSource: string | null; description: string };
    patterns?: Array<{ type: string; summary: string; confidence: number; suggestion?: string; relatedMemoryIds?: string[] }>;
    proactiveStats?: ProactiveStats;
    presence?: { state: 'present' | 'away'; awayDurationMs?: number };
  }): void {
    // ─── 情感基调 ──────────────────────────────────
    if (snapshot.affect) {
      this.updateAffectDisplay(snapshot.affect as AffectPayload);
    }

    // ─── 默契度 ────────────────────────────────────
    if (snapshot.rapport) {
      this.updateRapportDisplay(snapshot.rapport as RapportPayload);
    }

    // ─── 对话上下文 ────────────────────────────────
    if (snapshot.context) {
      this.updateContextDisplay(snapshot.context as ContextPayload);
    }

    // ─── 模式洞察 ──────────────────────────────────
    if (snapshot.patterns) {
      this.updatePatternsDisplay({ patterns: snapshot.patterns } as PatternsPayload);
    }

    // ─── 主动提示统计 ──────────────────────────────
    if (snapshot.proactiveStats) {
      this.updateProactiveStatsDisplay(snapshot.proactiveStats);
    }

    // ─── 在场状态 ──────────────────────────────────
    if (snapshot.presence) {
      this.updatePresenceDisplay(snapshot.presence as PresencePayload);
    }

    // 数据更新后重新生成叙事摘要
    this.updateNarrative();
  }

  /**
   * 更新情感基调展示（四维进度条 + 等级）
   *
   * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
   * 渲染到感知面板 (#perception-{dim}-fill / #perception-{dim}-level)。
   * 同时保存状态供叙事摘要合成。
   *
   * @param affect 四维情感基调数值
   */
  updateAffectDisplay(affect: AffectPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateAffect(affect);

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
        fillEl.style.background = getAffectColor(dim.value);
      }
      if (levelEl) {
        levelEl.textContent = getAffectLevel(dim.value);
      }
    }

    // 感知数据变化后更新叙事摘要
    this.updateNarrative();
  }

  /**
   * 更新默契度展示（等级徽章 + 双进度条 + 描述）
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
      rapportBadge.textContent = getRapportLevelLabel(rapport.level);
      rapportBadge.setAttribute('data-level', rapport.level);
    }

    // ─── 感知面板信任度进度条 ──────────────────────────
    const trustFill = document.getElementById('perception-trust-fill');
    if (trustFill) {
      trustFill.style.width = `${Math.round(rapport.trust * 100)}%`;
      trustFill.style.background = getAffectColor(rapport.trust);
    }

    // ─── 感知面板熟悉度进度条 ──────────────────────────
    const familiarityFill = document.getElementById('perception-familiarity-fill');
    if (familiarityFill) {
      familiarityFill.style.width = `${Math.round(rapport.familiarity * 100)}%`;
      familiarityFill.style.background = getAffectColor(rapport.familiarity);
    }

    // ─── 感知面板描述文本 ──────────────────────────────
    const rapportDesc = document.getElementById('perception-rapport-desc');
    if (rapportDesc) {
      rapportDesc.textContent = rapport.description;
    }

    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateRapport(rapport);
    this.updateNarrative();
  }

  /**
   * 更新对话上下文展示（三卡片指标）
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
      paceEl.textContent = describeRhythm(context.rhythm);
    }

    // ─── 感知面板话题连贯性指标 ────────────────────────
    const topicEl = document.getElementById('perception-topic-value');
    if (topicEl) {
      topicEl.textContent = describeCoherence(context.coherence);
    }

    // ─── 感知面板深度指标 ────────────────────────────
    const depthEl = document.getElementById('perception-depth-value');
    if (depthEl) {
      depthEl.textContent = describeDepth(context.depth);
    }

    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateContext(context);
    this.updateNarrative();
  }

  /**
   * 更新模式洞察面板（PatternDetector 检测结果）
   *
   * 由 patternsUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 渲染到感知面板 #perception-patterns-list 容器中，每个 pattern 包含
   * 类型标签（repeat/gap/drift）、置信度徽章和摘要文本。
   * 同时保存状态供叙事摘要合成。
   *
   * @param payload 模式洞察 payload
   */
  updatePatternsDisplay(payload: PatternsPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updatePatterns(payload);

    // 渲染到感知面板模式洞察容器
    const patternsList = document.getElementById('perception-patterns-list');
    const patternsSection = document.getElementById('perception-patterns-section');
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
      if (pattern.suggestion) {
        const suggestion = document.createElement('div');
        suggestion.className = 'perception-pattern-suggestion';
        suggestion.textContent = `建议：${pattern.suggestion}`;
        item.appendChild(suggestion);
      }

      patternsList.appendChild(item);
    }

    this.updateNarrative();
  }

  /**
   * 更新主动提示统计展示
   *
   * 消费 ProactiveEngine.getStats() 返回的统计快照，在感知面板展示：
   *   1. 历史反馈：建议数 / 接受数 / 接受率徽章（高/中/低 三色）
   *   2. 当前生效冷却：连续拒绝数 + 生效冷却时长
   *
   * 空状态处理：suggestCount=0 时隐藏网格，显示友好提示文案。
   *
   * @param stats 主动提示统计快照（null 时静默跳过，保持 DOM 默认值）
   */
  updateProactiveStatsDisplay(stats: ProactiveStats | null): void {
    // 无数据时静默跳过（保持 DOM 默认占位值，不阻塞面板渲染）
    if (!stats) return;

    const gridEl = document.getElementById('perception-proactive-grid');
    const emptyEl = document.getElementById('perception-proactive-empty');

    // 空状态：suggestCount=0 时显示友好提示
    if (stats.suggestCount === 0) {
      if (gridEl) gridEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    // 有数据时显示网格，隐藏空状态
    if (gridEl) gridEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    // ─── 历史反馈：建议数 / 接受数 ──────────────────────
    const suggestEl = document.getElementById('perception-proactive-suggest');
    const acceptEl = document.getElementById('perception-proactive-accept');
    if (suggestEl) suggestEl.textContent = String(stats.suggestCount);
    if (acceptEl) acceptEl.textContent = String(stats.acceptCount);

    // ─── 接受率徽章（高/中/低 三色，与 PatternDetector confidence 徽章一致） ──
    const rateEl = document.getElementById('perception-proactive-rate');
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
      rateEl.title = `接受率 ${Math.round(stats.acceptanceRate * 100)}%（${stats.acceptCount}/${stats.suggestCount}）`;
    }

    // ─── 连续拒绝数（>0 时高亮，提示用户精灵正在延长冷却） ──
    const rejectsEl = document.getElementById('perception-proactive-rejects');
    if (rejectsEl) {
      rejectsEl.textContent = String(stats.consecutiveRejects);
      rejectsEl.classList.toggle('warning', stats.consecutiveRejects > 0);
      rejectsEl.title = stats.consecutiveRejects > 0
        ? `连续拒绝 ${stats.consecutiveRejects} 次，冷却延长 ${Math.round((1 + stats.consecutiveRejects * 0.5) * 100)}%`
        : '无连续拒绝（冷却正常）';
    }

    // ─── 生效冷却时长（与基础冷却对比，体现默契度 + 拒绝惩罚双调节） ──
    const cooldownEl = document.getElementById('perception-proactive-cooldown');
    if (cooldownEl) {
      cooldownEl.textContent = this.formatCooldownMinutes(stats.effectiveCooldownMs);
      // 生效冷却 > 基础冷却时高亮，提示用户当前处于惩罚状态
      cooldownEl.classList.toggle('warning', stats.effectiveCooldownMs > stats.baseCooldownMs);
      cooldownEl.title = `基础 ${this.formatCooldownMinutes(stats.baseCooldownMs)} → 生效 ${this.formatCooldownMinutes(stats.effectiveCooldownMs)}`;
    }
  }

  /**
   * 更新在场状态展示
   *
   * 统一入口：首屏主动查询（PRESENCE_GET）与被动事件（presenceChanged）均通过此方法接入。
   * 将 PresencePayload 转换为内部 lastNarrativePresence 状态（state + awaySince），
   * 供叙事摘要合成时使用（用户离开时叙事应体现"用户不在"）。
   *
   * @param payload 在场状态事件载荷
   */
  updatePresenceDisplay(payload: PresencePayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updatePresence(payload);

    // 更新感知面板在场状态指示器 DOM
    const presenceDot = document.getElementById('perception-presence-dot');
    const presenceText = document.getElementById('perception-presence-text');
    if (presenceDot && presenceText) {
      if (payload.state === 'present') {
        presenceDot.className = 'presence-dot present';
        presenceText.textContent = '用户在场';
      } else {
        presenceDot.className = 'presence-dot away';
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
   * 每次感知数据更新时调用，更新感知面板 #perception-narrative-text。
   * P2-B02a：从仅更新精灵状态条扩展为同时更新感知面板叙事区。
   * 叙事合成委托到 NarrativeGenerator。
   */
  updateNarrative(): void {
    const narrative = this.narrativeGenerator.generateNarrative();

    // ─── 感知面板叙事区（独立面板的核心展示元素） ──────
    const narrativeEl = document.getElementById('perception-narrative-text');
    if (narrativeEl) {
      narrativeEl.textContent = narrative;
    }
  }

  // ─── 私有辅助方法 ──────────────────────────────────────

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
}
