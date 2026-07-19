/**
 * 感知推导协调器（Phase 2+3+4）
 *
 * 职责：协调 AffectController / RapportController / ContextAwareness / PatternDetector
 * 四个感知控制器，完成"推导 → 缓存 → 发射事件 → 注入 ProactiveEngine → 组合 prompt"链路。
 *
 * sprite.ts 保留 handleTrigger / generateSmartSuggestions / tryUpdateWorkProjection
 * 等触发器响应主流程，感知推导链路统一由本协调器管理。
 *
 * 设计原则：
 *   - 纯协调层，不持有业务状态（lastAffect/lastRapport/recentUserMessages 除外，
 *     这三个是推导结果的缓存，属感知层私有状态）
 *   - 通过构造注入的 emitter 回调发射事件，不直接依赖 SpriteEventMap 类型
 *   - 读路径（getSnapshot）无副作用，写路径（refreshBeforeChat）有副作用
 */
import { logger, toError } from 'memora';
import type { Agent, Memory } from 'memora';
import { AffectController } from './affectController.js';
import type { AffectState } from './affectController.js';
import type { RapportController } from './rapportController.js';
import type { RapportState } from './rapportController.js';
import type { ContextAwareness } from './contextAwareness.js';
import type { ContextState } from './contextAwareness.js';
import type { PatternDetector } from './patternDetector.js';
import type { DetectedPattern } from './patternDetector.js';
import type { ProactiveEngine } from './proactiveEngine.js';
import { DEFAULT_LIST_LIMIT, MS_PER_DAY, MS_PER_HOUR } from '../constants.js';

/**
 * 感知事件发射器回调集合
 *
 * 各事件由 PerceptionCoordinator 在推导完成后发射，由 Sprite 转发给宿主 UI。
 * 采用回调注入而非泛型 emit，避免 PerceptionCoordinator 依赖 SpriteEventMap 类型。
 */
export interface PerceptionEmitter {
  /** 情感基调更新（推导完成后发射） */
  affectUpdated: (payload: AffectState) => void;
  /** 默契度更新（推导完成后发射） */
  rapportUpdated: (payload: RapportState) => void;
  /** 对话上下文更新（推导完成后发射） */
  contextUpdated: (payload: ContextState) => void;
  /** 用户模式更新（PatternDetector 检测到新模式后发射） */
  patternsUpdated: (payload: { patterns: DetectedPattern[] }) => void;
}

/** PerceptionCoordinator 构造选项 */
export interface PerceptionCoordinatorOptions {
  /** Agent 实例（必填，提供 memory/persona/getMetrics/lastInteractionAt/injectAffect 访问） */
  agent: Agent;
  /** 情感基调控制器（Phase 2.1） */
  affectController: AffectController;
  /** 默契度控制器（Phase 3） */
  rapportController: RapportController;
  /** 对话上下文感知器（Phase 4） */
  contextAwareness: ContextAwareness;
  /** 记忆模式检测器（Phase 2+） */
  patternDetector: PatternDetector;
  /** 主动提示引擎（接收感知数据注入，用于智能触发和个性化提示） */
  proactiveEngine: ProactiveEngine;
  /** 事件发射器回调集合 */
  emitter: PerceptionEmitter;
}

/**
 * 感知推导协调器
 *
 * 统一编排四个感知控制器的推导链路，避免在 Sprite 中堆积协调逻辑。
 * 对话前调用 refreshBeforeChat() 完成全量感知刷新 + prompt 注入。
 */
export class PerceptionCoordinator {
  /** 最近一次推导的情感基调（供 ProactiveEngine 个性化提示 + getSnapshot 读路径访问） */
  private lastAffect: AffectState | null = null;
  /** 最近一次推导的默契度状态（供 ProactiveEngine 自适应冷却 + getSnapshot 读路径访问） */
  private lastRapport: RapportState | null = null;
  /** 最近 N 轮用户消息文本（用于对话语气分析，最多保留 5 条） */
  private recentUserMessages: string[] = [];

  constructor(private readonly opts: PerceptionCoordinatorOptions) {}

  // ─── 用户消息记录 ────────────────────────────────────────

  /**
   * 记录用户消息（对话前调用）
   *
   * 维护最近 5 条用户消息缓存，供 AffectController.deriveAffectFromMessages
   * 做对话语气实时分析。由 Sprite.prepareForChat() 调用。
   *
   * @param input 用户输入文本（null/undefined 时跳过）
   */
  pushUserMessage(input: string | null | undefined): void {
    if (!input) return;
    this.recentUserMessages.push(input);
    // 只保留最近 5 条，超出则移除最旧的
    if (this.recentUserMessages.length > 5) {
      this.recentUserMessages.shift();
    }
  }

  // ─── 写路径：对话前全量感知刷新 ──────────────────────────

  /**
   * 对话前刷新全量感知，确保 LLM 拿到最新状态
   *
   * 每次 wakeup() 对话前由 Sprite.prepareForChat() 调用，重新推导并一次性
   * 注入所有感知提示到 Agent.injectAffect()。各感知方法独立调用 injectAffect 会
   * 相互覆盖（仅最后生效），因此累积所有 prompt 统一注入。
   *
   * 注入内容：
   *   1. 情感基调（AffectController）
   *   2. 默契度（RapportController）
   *   3. 对话上下文（ContextAwareness）
   *   4. 用户模式（PatternDetector）
   *   5. 里程碑信号（ProactiveEngine）
   *   6. 跨会话上下文（新）
   */
  refreshBeforeChat(): void {
    // 收集所有感知提示文本
    const prompts: string[] = [];

    // 1-4. 情感基调 + 默契度 + 对话上下文 + 用户模式（链式推导）
    // 每个推导步骤独立 try/catch，单点抛错不阻塞其他推导
    try {
      const perceptionPrompt = this.deriveAndInjectAffect();
      if (perceptionPrompt) {
        prompts.push(perceptionPrompt);
      }
    } catch (err) {
      // 情感/默契/上下文推导失败不阻塞里程碑和跨会话上下文注入
      logger.warn(
        { error: toError(err).message },
        'perceptionCoordinator.deriveAndInjectAffect 失败，跳过感知提示注入',
      );
    }

    // 5. 里程碑信号（若有待处理的里程碑事件）
    try {
      const milestonePrompt = this.getMilestonePrompt();
      if (milestonePrompt) {
        prompts.push(milestonePrompt);
      }
    } catch (err) {
      // 里程碑读取失败不阻塞其他注入
      logger.warn(
        { error: toError(err).message },
        'perceptionCoordinator.getMilestonePrompt 失败，跳过里程碑提示注入',
      );
    }

    // 6. 跨会话上下文（检测到长时间间隔时注入上次对话摘要）
    try {
      const crossSessionPrompt = this.getCrossSessionContext();
      if (crossSessionPrompt) {
        prompts.push(crossSessionPrompt);
      }
    } catch (err) {
      // 跨会话上下文读取失败不阻塞其他注入
      logger.warn(
        { error: toError(err).message },
        'perceptionCoordinator.getCrossSessionContext 失败，跳过跨会话上下文注入',
      );
    }

    // 一次性注入所有提示，避免相互覆盖
    if (prompts.length > 0) {
      this.opts.agent.injectAffect(prompts.join('\n\n'));
    }
  }

  // ─── 读路径：感知快照 ──────────────────────────────────

  /**
   * 获取感知快照（不修改 Coordinator 自身状态，但会刷新子控制器配置）
   *
   * 与 refreshBeforeChat 的区别：
   *   - refreshBeforeChat：写路径，有副作用（更新 lastAffect/lastRapport 缓存 + 发射事件 + 注入 prompt）
   *   - getSnapshot：读路径，不修改 PerceptionCoordinator 自身状态，不发射事件，不注入 prompt
   *
   * @returns 感知快照，Agent 未就绪或无记忆时返回 null
   */
  getSnapshot(): {
    affect: AffectState;
    rapport: RapportState;
    context: ContextState;
    patterns: DetectedPattern[];
  } | null {
    const agent = this.opts.agent;
    // Agent 未就绪时返回 null（UI 显示占位文案）
    if (!agent.memory) return null;

    // 获取所有记忆用于推导（上限 DEFAULT_LIST_LIMIT，与 refreshBeforeChat 一致）
    const memories = agent.memory.list(DEFAULT_LIST_LIMIT);
    if (memories.length === 0) return null;

    // 1. 情感基调推导（复用 AffectController 配置，不修改 PerceptionCoordinator 状态）
    this.opts.affectController.updateOptions({
      acceptanceRate: this.opts.proactiveEngine.acceptanceRate,
      currentPersona: agent.persona?.getActive() ?? null,
    });
    let affect = this.opts.affectController.deriveAffect(memories);
    // 对话语气实时修正（与 deriveAndInjectAffect 逻辑一致）
    if (this.recentUserMessages.length > 0) {
      const delta = AffectController.deriveAffectFromMessages(this.recentUserMessages);
      // 冷启动时（无记忆数据）不做 blend 平滑，让首条消息关键词直接影响 affect
      affect = memories.length === 0
        ? AffectController.applyDelta(affect, delta)
        : AffectController.blendAffect(affect, delta);
    }

    // 2. 默契度推导（先更新配置参数）
    const interactionDays = this.calculateInteractionDays(memories);
    this.opts.rapportController.updateOptions({
      acceptanceRate: this.opts.proactiveEngine.acceptanceRate,
      interactionDays,
      totalMessages: agent.getMetrics().llm.callCount,
      sourceDiversity: new Set(memories.map((m) => m.source)).size,
    });
    const rapport = this.opts.rapportController.deriveRapport(memories);

    // 3. 对话上下文推导
    const context = this.opts.contextAwareness.deriveContext(memories);

    // 4. 模式洞察检测
    const patterns = this.opts.patternDetector.detectPatterns(memories);

    return { affect, rapport, context, patterns };
  }

  // ─── 私有推导链路 ────────────────────────────────────────

  /**
   * 推导情感基调，返回 prompt 文本（不再直接注入，由 refreshBeforeChat 统一注入）
   *
   * 副作用：更新 lastAffect 缓存、发射 affectUpdated 事件、推导默契度+上下文
   */
  private deriveAndInjectAffect(): string {
    // 更新 AffectController 配置（角色 + 接受率）
    this.opts.affectController.updateOptions({
      acceptanceRate: this.opts.proactiveEngine.acceptanceRate,
      currentPersona: this.opts.agent.persona?.getActive() ?? null,
    });

    // 获取所有记忆用于推导（上限 1000 条，一次查询供后续所有推导复用）
    const memories = this.opts.agent.memory?.list(1000) ?? [];
    let affect = this.opts.affectController.deriveAffect(memories);

    // Phase 2.2：对话语气实时分析——从最近用户消息推导语气修正值
    // 冷启动时（无记忆数据）不做 blend 平滑，让首条消息关键词直接影响 affect
    if (this.recentUserMessages.length > 0) {
      const delta = AffectController.deriveAffectFromMessages(this.recentUserMessages);
      affect = memories.length === 0
        ? AffectController.applyDelta(affect, delta)
        : AffectController.blendAffect(affect, delta);
    }

    this.lastAffect = affect; // Phase 1+2：缓存供 ProactiveEngine 注入

    // 发射情感基调更新事件（供 UI 仪表盘展示）
    this.opts.emitter.affectUpdated(affect);

    // 生成情感描述文本（不再直接注入，由调用方统一注入）
    const affectPrompt = this.opts.affectController.buildAffectPrompt(affect);

    // Phase 3：同时推导默契度（复用同一批 memories，避免重复 DB 查询）
    const rapportPrompt = this.deriveAndInjectRapport(memories);

    // Phase 4：同时推导对话上下文（复用同一批 memories）
    const contextPrompt = this.deriveAndInjectContext(memories);

    // 累积所有提示文本，用空行分隔
    return [affectPrompt, rapportPrompt, contextPrompt].filter(Boolean).join('\n\n');
  }

  /**
   * 推导默契度，返回 prompt 文本（不再直接注入，由 refreshBeforeChat 统一注入）
   *
   * @param memories 由调用方一次性获取的记忆列表（避免重复 DB 查询）
   * 副作用：更新 lastRapport 缓存、发射 rapportUpdated 事件
   */
  private deriveAndInjectRapport(memories: Memory[]): string {
    // 计算交互天数（从最早记忆的创建时间推算）
    const interactionDays = this.calculateInteractionDays(memories);

    // 更新 RapportController 配置
    this.opts.rapportController.updateOptions({
      acceptanceRate: this.opts.proactiveEngine.acceptanceRate,
      interactionDays,
      totalMessages: this.opts.agent.getMetrics().llm.callCount,
      sourceDiversity: new Set(memories.map((m) => m.source)).size,
    });

    const rapport = this.opts.rapportController.deriveRapport(memories);
    this.lastRapport = rapport; // Phase 1+2：缓存供 ProactiveEngine 注入

    // 发射默契度更新事件（供 UI 仪表盘展示）
    this.opts.emitter.rapportUpdated(rapport);

    // 生成默契度描述文本（不再直接注入，由调用方统一注入）
    return this.opts.rapportController.buildRapportPrompt(rapport);
  }

  /**
   * 计算交互天数（从最早记忆的创建时间推算）
   *
   * @param memories 记忆列表
   * @returns 交互天数（最早记忆距今的天数）
   */
  calculateInteractionDays(memories: Memory[]): number {
    if (memories.length === 0) return 0;
    const oldestTimestamp = memories.reduce((min, m) => {
      const ts = new Date(m.createdAt).getTime();
      return ts < min ? ts : min;
    }, Date.now());
    return Math.floor((Date.now() - oldestTimestamp) / MS_PER_DAY);
  }

  /**
   * 推导对话上下文，返回 prompt 文本（不再直接注入，由 refreshBeforeChat 统一注入）
   *
   * @param memories 由调用方一次性获取的记忆列表（避免重复 DB 查询）
   * 副作用：发射 contextUpdated 事件、注入 ProactiveEngine、检测模式
   */
  private deriveAndInjectContext(memories: Memory[]): string {
    const context = this.opts.contextAwareness.deriveContext(memories);

    // 发射对话上下文更新事件（供 UI 仪表盘展示）
    this.opts.emitter.contextUpdated(context);

    // Phase 1+2：将感知数据注入 ProactiveEngine，实现智能触发和个性化提示
    this.injectPerceptionToProactiveEngine(context);

    // Phase 2+：检测记忆模式并返回 pattern prompt
    const patternPrompt = this.detectAndInjectPatterns(memories);

    // 生成上下文感知描述文本（不再直接注入，由调用方统一注入）
    const contextPrompt = this.opts.contextAwareness.buildContextPrompt(context);

    return [contextPrompt, patternPrompt].filter(Boolean).join('\n\n');
  }

  /**
   * 将感知系统推导结果注入 ProactiveEngine（Phase 1+2）
   *
   * 使 ProactiveEngine 能够根据：
   *   - 情感基调（affect）调整提示语气
   *   - 默契度（rapport）自适应冷却时长
   *   - 对话上下文（context）调整触发频率
   * 做出更智能的主动提示决策。
   */
  private injectPerceptionToProactiveEngine(context: ContextState): void {
    this.opts.proactiveEngine.setContextState(context);
    if (this.lastRapport) {
      this.opts.proactiveEngine.setRapportLevel(this.lastRapport.trust);
    }
    if (this.lastAffect) {
      this.opts.proactiveEngine.setAffectState(this.lastAffect);
    }
  }

  /**
   * 检测记忆模式，返回 prompt 文本（不再直接注入，由 refreshBeforeChat 统一注入）
   *
   * 副作用：注入 ProactiveEngine、发射 patternsUpdated 事件
   *
   * @param memories 所有记忆列表
   * @returns 模式洞察 prompt 文本，无模式时返回空字符串
   */
  private detectAndInjectPatterns(memories: Memory[]): string {
    const patterns = this.opts.patternDetector.detectPatterns(memories);
    this.opts.proactiveEngine.setPatterns(patterns);

    // 发射模式更新事件（供 UI 洞察面板展示）
    // 无条件发射：模式消失时 UI 需收到空 patterns 才能清空陈旧显示，
    // 渲染层 perceptionPanelManager 已处理空 patterns 的清空逻辑
    this.opts.emitter.patternsUpdated({ patterns });

    // 将模式洞察返回（不再直接注入，由调用方统一注入）
    return this.opts.patternDetector.buildPatternPrompt(patterns);
  }

  /**
   * 获取里程碑提示文本（不再直接注入，由 refreshBeforeChat 统一注入）
   *
   * 当 ProactiveEngine 中有待处理的里程碑事件时，
   * 告知 LLM 这是一个值得庆祝/提及的特殊时刻。
   * 里程碑是一次性信号：对话时注入，UI banner 独立展示，互不干扰。
   *
   * @returns 里程碑 prompt 文本，无里程碑时返回空字符串
   */
  private getMilestonePrompt(): string {
    const milestones = this.opts.proactiveEngine.peekPendingMilestones();
    if (milestones.length === 0) return '';

    const lines: string[] = ['【里程碑时刻】我们刚刚达成了一个值得注意的里程碑：'];
    for (const m of milestones) {
      lines.push(`- ${m}`);
    }
    lines.push('→ 这是我们关系中的一个小节点，可以自然地提及或庆祝，但不要刻意生硬');
    return lines.join('\n');
  }

  /**
   * 获取跨会话上下文提示（A1 新功能）
   *
   * 当用户距离上次交互超过 1 小时时，从记忆系统中提取最近的关键记忆，
   * 生成"上次聊到..."上下文，让 LLM 能够自然地接续对话。
   *
   * 纯代码计算，不依赖 LLM。不直接注入，由 refreshBeforeChat 统一注入。
   *
   * @returns 跨会话上下文 prompt 文本，间隔不足 1 小时或无历史时返回空字符串
   */
  private getCrossSessionContext(): string {
    const lastInteraction = this.opts.agent.lastInteractionAt;
    if (!lastInteraction) return ''; // 首次交互，无历史

    const gapMs = Date.now() - lastInteraction.getTime();

    if (gapMs < MS_PER_HOUR) return ''; // 间隔太短，不需要跨会话上下文

    // 获取最近的记忆（按创建时间排序，最新的在前）
    const memories = this.opts.agent.memory?.list(50) ?? [];
    if (memories.length === 0) return '';

    // 提取上次交互以来的记忆
    const recentMemories = memories.filter((m) => {
      const createdMs = new Date(m.createdAt).getTime();
      return (Date.now() - createdMs) < gapMs + MS_PER_HOUR * 2;
    });

    // 取最近 5 条关键记忆作为上下文
    const keyMemories = recentMemories.slice(0, 5);
    if (keyMemories.length === 0) return '';

    // 生成时间间隔描述
    // 时长格式化：与 sprite.welcomeBackRecall 语义不同（此处是"对话间隔"，彼处是"离开时长"），保持独立
    const gapHours = Math.round(gapMs / MS_PER_HOUR);
    const gapText = gapMs < MS_PER_DAY
      ? `${gapHours} 小时`
      : `${Math.round(gapMs / MS_PER_DAY)} 天`;

    const lines: string[] = [
      `【跨会话上下文】距离上次对话已经过了 ${gapText}。以下是上次对话中涉及的关键信息，你可能想自然地提及或追问：`,
    ];

    for (const mem of keyMemories) {
      const label = mem.source === 'profile' ? '用户信息'
        : mem.source === 'insight' ? '洞察'
        : '记忆';
      // 取 content 前 80 字作为摘要
      const preview = mem.content.substring(0, 80);
      lines.push(`- [${label}] ${mem.name}: ${preview}`);
    }

    lines.push('→ 如果合适，可以自然地提及或追问这些内容，让对话有连续感。但不要生硬地列举。');
    return lines.join('\n');
  }
}
