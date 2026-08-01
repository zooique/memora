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
 * - 自包含状态（NarrativeGenerator 管理感知状态）
 * - 通过 Host 接口与 UIManager 解耦
 * - 数据模型与精灵层控制器（AffectController/RapportController/ContextAwareness）保持一致
 * - DOM 操作委托给 Component 实例（ARCH-COMP-1 阶段 2）
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
import type { ProactiveStats } from '../../../shared/spriteStats.js';
import { NarrativeGenerator } from '../helpers/narrativeGenerator.js';
// 感知标签映射（统一真理源，消除 6 个私有方法的重复实现）
import {
  getAffectLevel,
  getAffectColor,
} from '../helpers/perceptionLabels.js';
// 感知面板 Component（ARCH-COMP-1 阶段 2：封装 DOM 操作，替代直接查询）
import { PerceptionAffectComponent } from '../components/data/perceptionAffectComponent.js';
import { PerceptionRapportComponent } from '../components/data/perceptionRapportComponent.js';
import { PerceptionContextComponent } from '../components/data/perceptionContextComponent.js';
import { PerceptionProactiveComponent } from '../components/data/perceptionProactiveComponent.js';
import { PerceptionPresenceComponent } from '../components/data/perceptionPresenceComponent.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 感知面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface PerceptionPanelHost {
  /** 显示 toast 通知 */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /** 更新精灵状态条文字与脉冲点颜色（跨面板 DOM 写入，由 UIManager 统一管理） */
  updateSpriteStatus(text: string, dotColor?: string): void;
}

// ─── 感知面板管理器类 ─────────────────────────────────────

/**
 * 感知面板管理器
 *
 * 负责独立感知面板的全部渲染与交互逻辑。
 * 由 UIManager 持有，通过外观方法委托调用。
 * DOM 操作委托给 5 个 Component 实例（ARCH-COMP-1 阶段 2）。
 * 数据模型与精灵层控制器一致，DOM 元素 ID 前缀为 perception-*
 * （区别于仪表盘的 dashboard-* 前缀）。
 */
export class PerceptionPanelManager {
  // ─── 叙事摘要生成器（统一管理 5 类感知数据累积 + 叙事合成） ──
  /** 叙事摘要生成器实例，代替 5 个 lastNarrative* 字段 + generateNarrative 方法 */
  private narrativeGenerator = new NarrativeGenerator();

  /** 事件监听器跟踪器（由 UIManager 注入，统一管理动态渲染的关联按钮事件） */
  private events: EventTracker | null = null;

  // ─── 宿主引用 ──────────────────────────────────────────

  /** 宿主能力（跨模块关注点注入：showToast + updateSpriteStatus 精灵状态条写入） */
  private _host: PerceptionPanelHost;

  // ─── Component 实例（ARCH-COMP-1 阶段 2：封装 DOM 操作，替代直接查询） ─
  /** 情感基调组件（四维进度条 + 雷达图） */
  private affectComponent: PerceptionAffectComponent;
  /** 默契度组件（等级徽章 + 双进度条 + 描述） */
  private rapportComponent: PerceptionRapportComponent;
  /** 对话上下文组件（节奏/话题/深度三卡片） */
  private contextComponent: PerceptionContextComponent;
  /** 主动提示统计组件（建议/接受/接受率/拒绝/冷却） */
  private proactiveComponent: PerceptionProactiveComponent;
  /** 在场状态组件（指示器 + 状态文本） */
  private presenceComponent: PerceptionPresenceComponent;

  // ─── 构造 ──────────────────────────────────────────────

  /**
   * 构造感知面板管理器
   *
   * @param host 宿主能力注入（showToast 等跨模块关注点）
   */
  constructor(host: PerceptionPanelHost) {
    this._host = host;

    // 创建 Component 实例并挂载到现有 HTML 模板元素
    this.affectComponent = new PerceptionAffectComponent().mount('');
    this.rapportComponent = new PerceptionRapportComponent().mount('');
    this.contextComponent = new PerceptionContextComponent().mount('');
    this.proactiveComponent = new PerceptionProactiveComponent().mount('');
    this.presenceComponent = new PerceptionPresenceComponent().mount('');
  }

  // ─── 初始化 ────────────────────────────────────────────

  /**
   * 初始化感知面板事件监听
   *
   * 注入事件跟踪器，供动态渲染的"关联记忆"按钮（模式洞察区）绑定点击事件。
   * 详见 updatePatternsDisplay 中 perception-pattern-related 按钮的点击委托。
   *
   * @param _events 事件跟踪器（绑定关联记忆按钮的 click 监听）
   */
  init(_events: EventTracker): void {
    // 存储事件跟踪器，供动态渲染的"关联记忆"按钮使用
    this.events = _events;
  }

  // ─── 资源清理 ──────────────────────────────────────────

  /**
   * 清理资源（满足 PanelManager 生命周期契约）
   *
   * 清理记忆跳转回调引用，避免内存泄漏。
   */
  cleanup(): void {
    this.onMemoryClickCallback = null;
    // 清理事件监听器（动态渲染的关联按钮事件）
    if (this.events) {
      this.events.cleanup();
    }
    // 销毁 Component 实例（nullify 引用）
    this.affectComponent.destroy();
    this.rapportComponent.destroy();
    this.contextComponent.destroy();
    this.proactiveComponent.destroy();
    this.presenceComponent.destroy();
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
   * DOM 操作委托给 PerceptionAffectComponent。
   * 精灵状态条更新（通过 Host 接口）和叙事摘要合成保留在 Manager。
   *
   * @param affect 四维情感基调数值
   */
  updateAffectDisplay(affect: AffectPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateAffect(affect);

    // 委托 DOM 操作到 Component
    this.affectComponent.update(affect);

    // ─── 精灵状态条（文字 + 脉冲点，通过 Host 接口委托到 UIManager 统一写入） ────
    const dimensions: Array<{ id: string; value: number; label: string }> = [
      { id: 'warmth', value: affect.warmth, label: '温暖' },
      { id: 'directness', value: affect.directness, label: '直接' },
      { id: 'initiative', value: affect.initiative, label: '主动' },
      { id: 'playfulness', value: affect.playfulness, label: '活泼' },
    ];
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
   * DOM 操作委托给 PerceptionRapportComponent。
   *
   * @param rapport 默契度数据
   */
  updateRapportDisplay(rapport: RapportPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateRapport(rapport);

    // 委托 DOM 操作到 Component
    this.rapportComponent.update(rapport);

    this.updateNarrative();
  }

  /**
   * 更新对话上下文展示（三卡片指标）
   *
   * DOM 操作委托给 PerceptionContextComponent。
   *
   * @param context 对话上下文数据
   */
  updateContextDisplay(context: ContextPayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updateContext(context);

    // 委托 DOM 操作到 Component
    this.contextComponent.update(context);

    this.updateNarrative();
  }

  /**
   * 更新模式洞察面板（PatternDetector 检测结果）
   *
   * 由 patternsUpdated 事件驱动，纯 DOM 操作，不触发 IPC。
   * 模式洞察涉及动态 DOM 创建和 EventTracker 事件绑定，保留在 Manager 中。
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
      typeSpan.className = 'perception-pattern-type flex-shrink-0';
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
      confidenceSpan.className = 'perception-pattern-confidence flex-shrink-0';
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
        // 使用 EventTracker 统一管理事件监听器，避免动态 DOM 内存泄漏
        if (this.events) {
          this.events.addEventListener(relatedBtn, 'click', () => {
            this.onMemoryClickCallback?.(firstId);
          });
        }
        item.appendChild(relatedBtn);
      }

      patternsList.appendChild(item);
    }

    this.updateNarrative();
  }

  /**
   * 更新主动提示统计展示
   *
   * DOM 操作委托给 PerceptionProactiveComponent。
   *
   * @param stats 主动提示统计快照（null 时静默跳过，保持 DOM 默认值）
   */
  updateProactiveStatsDisplay(stats: ProactiveStats | null): void {
    // 委托 DOM 操作到 Component
    this.proactiveComponent.update(stats);
  }

  /**
   * 更新在场状态展示
   *
   * DOM 操作委托给 PerceptionPresenceComponent。
   *
   * @param payload 在场状态事件载荷
   */
  updatePresenceDisplay(payload: PresencePayload): void {
    // 保存状态供叙事摘要合成（委托到 NarrativeGenerator）
    this.narrativeGenerator.updatePresence(payload);

    // 委托 DOM 操作到 Component
    this.presenceComponent.update(payload);

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
}