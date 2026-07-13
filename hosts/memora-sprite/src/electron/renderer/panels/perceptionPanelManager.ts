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
 * - 数据模型与精灵层控制器（AffectController/RapportController/ContextAwareness）保持一致
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
  /** 更新精灵状态条文字与脉冲点颜色（跨面板 DOM 写入，由 UIManager 统一管理） */
  updateSpriteStatus(text: string, dotColor?: string): void;
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
 * 数据模型与精灵层控制器一致，DOM 元素 ID 前缀为 perception-*
 * （区别于仪表盘的 dashboard-* 前缀）。
 */
export class PerceptionPanelManager {
  // ─── 叙事摘要生成器（统一管理 5 类感知数据累积 + 叙事合成） ──
  /** 叙事摘要生成器实例，代替 5 个 lastNarrative* 字段 + generateNarrative 方法 */
  private narrativeGenerator = new NarrativeGenerator();

  // ─── 宿主引用 ──────────────────────────────────────────

  /** 宿主能力（跨模块关注点注入：showToast + updateSpriteStatus 精灵状态条写入） */
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
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源（满足 PanelManager 生命周期契约）
   *
   * 清理记忆跳转回调引用，避免内存泄漏。
   */
  cleanup(): void {
    this.onMemoryClickCallback = null;
    // 重置叙事生成器缓存，避免下次初始化时残留上个会话的感知数据
    this.narrativeGenerator.reset();
  }

  // ─── 记忆跳转回调（从原仪表盘感知区迁移） ─────────

  /** 记忆跳转回调：点击模式洞察的"关联记忆"按钮时触发 */
  private onMemoryClickCallback: ((memoryId: string) => void) | null = null;

  /** 注册记忆跳转回调（由 UIManager 委托注入） */
  onMemoryClick(cb: (memoryId: string) => void): void {
    this.onMemoryClickCallback = cb;
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
   * 更新情感基调展示（四维进度条 + 等级 + 精灵状态条）
   *
   * 将 0-1 数值映射为进度条宽度百分比 + 颜色 + 中文等级。
   * 渲染到感知面板 (#perception-{dim}-fill / #perception-{dim}-level)。
   * 同时通过 Host 接口更新精灵状态条（文字 + 脉冲点颜色），
   * 让用户在对话面板也能一眼看到当前主导情感维度。
   * 同时保存状态供叙事摘要合成。
   *
   * @param affect 四维情感基调数值
   */
  updateAffectDisplay(affect: AffectPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateAffect(affect);

    // 定义四维映射：id 前缀 → 数值 + 中文标签
    const dimensions: Array<{ id: string; value: number; label: string }> = [
      { id: 'warmth', value: affect.warmth, label: '温暖' },
      { id: 'directness', value: affect.directness, label: '直接' },
      { id: 'initiative', value: affect.initiative, label: '主动' },
      { id: 'playfulness', value: affect.playfulness, label: '活泼' },
    ];

    // ─── 感知面板情感进度条 ──────────────────────────
    for (const dim of dimensions) {
      const fillEl = document.getElementById(`perception-${dim.id}-fill`);
      const levelEl = document.getElementById(`perception-${dim.id}-level`);
      if (fillEl) {
        const percent = Math.round(dim.value * 100);
        // 低值时保证最小可见宽度（6%），避免 warmth=0.05 等低值时进度条视觉不可见
        // 用户会误以为"未加载数据"，实际是数据值很低（如 profile 记忆不足导致 warmth 偏低）
        const displayWidth = Math.max(6, percent);
        fillEl.style.width = `${displayWidth}%`;
        fillEl.style.background = getAffectColor(dim.value);
        // title 显示精确百分比，避免最小宽度误导用户对实际数值的判断
        fillEl.title = `${dim.label}：${percent}%`;
      }
      if (levelEl) {
        // 等级文案追加精确百分比，让用户明确区分"未加载"与"值很低"
        levelEl.textContent = `${getAffectLevel(dim.value)} · ${Math.round(dim.value * 100)}%`;
      }
    }

    // ─── 情感雷达图（SVG 四维可视化） ──────────────────────
    // 中心 (60,60)，最大半径 40，四方向：上(温暖)/右(直接)/下(主动)/左(活泼)
    const RADAR_CENTER = 60;
    const RADAR_RADIUS = 40;
    const radarPoints: Array<[number, number]> = [
      [RADAR_CENTER, RADAR_CENTER - affect.warmth * RADAR_RADIUS],
      [RADAR_CENTER + affect.directness * RADAR_RADIUS, RADAR_CENTER],
      [RADAR_CENTER, RADAR_CENTER + affect.initiative * RADAR_RADIUS],
      [RADAR_CENTER - affect.playfulness * RADAR_RADIUS, RADAR_CENTER],
    ];
    const radarPolygon = document.getElementById('perception-affect-radar');
    if (radarPolygon) {
      radarPolygon.setAttribute('points', radarPoints.map(p => p.join(',')).join(' '));
    }
    // 更新四个顶点圆点位置
    const dotIds = ['warmth', 'directness', 'initiative', 'playfulness'] as const;
    for (let i = 0; i < dotIds.length; i++) {
      const dot = document.getElementById(`radar-dot-${dotIds[i]}`);
      const point = radarPoints[i];
      if (dot && point) {
        dot.setAttribute('cx', String(point[0]));
        dot.setAttribute('cy', String(point[1]));
      }
    }

    // ─── 精灵状态条（文字 + 脉冲点，通过 Host 接口委托到 UIManager 统一写入） ────
    const dominant = dimensions.reduce((a, b) => (a.value > b.value ? a : b));
    this._host.updateSpriteStatus(
      `基调：${dominant.label}（${getAffectLevel(dominant.value)}）`,
      getAffectColor(dominant.value),
    );

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
    const trustPercent = Math.round(rapport.trust * 100);
    const trustFill = document.getElementById('perception-trust-fill');
    if (trustFill) {
      trustFill.style.width = `${Math.max(6, trustPercent)}%`;
      trustFill.style.background = getAffectColor(rapport.trust);
      trustFill.title = `信任度 ${trustPercent}%`;
    }

    // ─── 感知面板熟悉度进度条 ──────────────────────────
    const familiarityPercent = Math.round(rapport.familiarity * 100);
    const familiarityFill = document.getElementById('perception-familiarity-fill');
    if (familiarityFill) {
      familiarityFill.style.width = `${Math.max(6, familiarityPercent)}%`;
      familiarityFill.style.background = getAffectColor(rapport.familiarity);
      familiarityFill.title = `熟悉度 ${familiarityPercent}%`;
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
      patternsList.replaceChildren();
      patternsSection?.classList.add('hidden');
      this.updateNarrative();
      return;
    }

    // 有数据时显示 section（可能之前被隐藏）
    patternsSection?.classList.remove('hidden');

    // 清空并重建列表（replaceChildren 单次 API，避免逐个 removeChild 阻塞）
    patternsList.replaceChildren();

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

      // 关联记忆跳转按钮（仅当 PatternDetector 检测到 relatedMemoryIds 时渲染）
      const relatedIds = (pattern as { relatedMemoryIds?: string[] }).relatedMemoryIds;
      if (relatedIds && relatedIds.length > 0) {
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
   * 每次感知数据更新时调用，同时更新两个目标：
   * 1. 感知面板叙事区 #perception-narrative-text（独立面板的核心展示元素）
   * 2. 精灵状态条文字（通过 Host 接口委托到 UIManager，对话面板的实时状态指示）
   *
   * 精灵状态条仅在非 idle 状态时更新（idle 时保持 affectDisplay 设置的基调文字）。
   * 叙事合成委托到 NarrativeGenerator。
   */
  updateNarrative(): void {
    const narrative = this.narrativeGenerator.generateNarrative();

    // ─── 感知面板叙事区（独立面板的核心展示元素） ──────
    const narrativeEl = document.getElementById('perception-narrative-text');
    if (narrativeEl) {
      narrativeEl.textContent = narrative;
    }

    // ─── 精灵状态条文字（非 idle 状态时用叙事摘要覆盖基调文字，仅文字无颜色） ────
    if (!this.narrativeGenerator.isIdle()) {
      this._host.updateSpriteStatus(narrative);
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
