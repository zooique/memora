/**
 * 默契度控制器 — 从行为信号推导用户与精灵的长期关系
 *
 * 职责：
 *   1. 从行为信号推导信任度（trust）和熟悉度（familiarity）
 *   2. 映射到默契度等级（复用现有 RapportLevel 四级体系）
 *   3. 生成自然语言描述，注入到 Agent system prompt
 *   4. 纯代码计算，不依赖 LLM，不新增存储
 *
 * 设计原则：
 *   - 不存储默契度状态——每次从现有数据实时推导
 *   - 不在核心库实现——纯宿主层逻辑
 *   - 与 AffectController 互补：AffectController 是"当前状态"，RapportController 是"长期关系"
 *   - 信任度 = f(接受率, 纠正频率, 覆盖频率)
 *   - 熟悉度 = f(交互天数, 总消息数, 话题多样性)
 *
 * 与现有 memoryController.rapportLevel() 的关系：
 *   - memoryController.rapportLevel() 是纯统计型（计数驱动）
 *   - RapportController 是行为信号型（行为驱动）
 *   - 两者互补：统计型反映"数据量"，行为型反映"关系质量"
 */

import type { Memory } from 'memora';
import { logger } from 'memora';
import type { RapportLevel } from './memoryController.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 默契度状态（信任度 + 熟悉度 + 等级） */
export interface RapportState {
  /** 信任度 0-1：基于行为信号（接受率、纠正频率等） */
  trust: number;
  /** 熟悉度 0-1：基于交互历史（天数、消息数、话题多样性） */
  familiarity: number;
  /** 默契度等级 */
  level: RapportLevel;
  /** 默契度描述（自然语言，用于 UI 展示） */
  description: string;
}

/** RapportController 构造选项 */
export interface RapportControllerOptions {
  /** 主动提示接受率（来自 ProactiveEngine.acceptanceRate） */
  acceptanceRate: number;
  /** 总交互天数（从首次记忆创建时间推算） */
  interactionDays: number;
  /** 总消息数（用户 + 助手） */
  totalMessages: number;
  /** 话题多样性：不同 source 的数量 */
  sourceDiversity: number;
}

// ─── 常量 ────────────────────────────────────────────────

/** 信任度：接受率达到此值时 trust=1 */
const ACCEPTANCE_RATE_FOR_FULL_TRUST = 0.8;

/** 熟悉度：交互天数达到此值时 familiarity=1 */
const DAYS_FOR_FULL_FAMILIARITY = 30;

/** 熟悉度：消息数达到此值时 familiarity=1（与天数取 max） */
const MESSAGES_FOR_FULL_FAMILIARITY = 500;

/** 熟悉度：source 多样性达到此值时 familiarity=1 */
const SOURCES_FOR_FULL_DIVERSITY = 5;

// ─── RapportController 类 ─────────────────────────────────

/**
 * 默契度控制器
 *
 * 从行为信号中实时推导用户与精灵的长期关系质量。
 * 纯宿主层实现，零内核改动，零存储开销。
 */
export class RapportController {
  private options: RapportControllerOptions;

  constructor(options: RapportControllerOptions) {
    this.options = options;
  }

  /**
   * 更新配置（接受率变化或交互数据更新时调用）
   */
  updateOptions(options: Partial<RapportControllerOptions>): void {
    if (options.acceptanceRate !== undefined) {
      this.options.acceptanceRate = options.acceptanceRate;
    }
    if (options.interactionDays !== undefined) {
      this.options.interactionDays = options.interactionDays;
    }
    if (options.totalMessages !== undefined) {
      this.options.totalMessages = options.totalMessages;
    }
    if (options.sourceDiversity !== undefined) {
      this.options.sourceDiversity = options.sourceDiversity;
    }
  }

  /**
   * 从行为信号推导默契度
   *
   * 纯计算，不依赖 LLM，不修改任何状态。
   *
   * @param memories 所有记忆列表（用于推导话题多样性等补充信号）
   * @returns 默契度状态
   */
  deriveRapport(memories: Memory[]): RapportState {
    // 信任度：基于接受率（核心信号）
    const trust = this.calculateTrust();

    // 熟悉度：基于交互历史（天数 + 消息数 + 话题多样性）
    const familiarity = this.calculateFamiliarity(memories);

    // 等级判定：综合信任度和熟悉度
    const level = this.determineLevel(trust, familiarity);

    // 描述文本
    const description = this.buildDescription(level, trust, familiarity);

    const rapport: RapportState = {
      trust: Math.round(trust * 100) / 100,
      familiarity: Math.round(familiarity * 100) / 100,
      level,
      description,
    };

    logger.debug({ ...rapport }, 'RapportController: 默契度已推导');
    return rapport;
  }

  /**
   * 计算信任度
   *
   * 信号：主动提示接受率
   * 公式：trust = min(1, acceptanceRate / ACCEPTANCE_RATE_FOR_FULL_TRUST)
   * 解读：接受率 0.8 以上 → 完全信任；0.4 以下 → 低信任
   */
  private calculateTrust(): number {
    return Math.min(1, this.options.acceptanceRate / ACCEPTANCE_RATE_FOR_FULL_TRUST);
  }

  /**
   * 计算熟悉度
   *
   * 信号：交互天数（30%）、总消息数（30%）、话题多样性（40%）
   * 公式：familiarity = 0.3 * daysRatio + 0.3 * msgRatio + 0.4 * sourceRatio
   *
   * @param memories 记忆列表（用于补充话题多样性）
   */
  private calculateFamiliarity(memories: Memory[]): number {
    // 交互天数比率
    const daysRatio = Math.min(1, this.options.interactionDays / DAYS_FOR_FULL_FAMILIARITY);

    // 消息数比率
    const msgRatio = Math.min(1, this.options.totalMessages / MESSAGES_FOR_FULL_FAMILIARITY);

    // 话题多样性：从 memories 中统计不重复 source 数量（与 options.sourceDiversity 取 max）
    const memorySources = new Set(memories.map((m) => m.source));
    const effectiveDiversity = Math.max(this.options.sourceDiversity, memorySources.size);
    const sourceRatio = Math.min(1, effectiveDiversity / SOURCES_FOR_FULL_DIVERSITY);

    return 0.3 * daysRatio + 0.3 * msgRatio + 0.4 * sourceRatio;
  }

  /**
   * 判定默契度等级
   *
   * 规则（综合 trust 和 familiarity）：
   *   - trust < 0.2 或 familiarity < 0.1 → stranger（陌生人）
   *   - familiarity < 0.3 → acquaintance（相识）
   *   - familiarity < 0.6 或 trust < 0.5 → familiar（熟悉）
   *   - 否则 → close（亲密）
   */
  private determineLevel(trust: number, familiarity: number): RapportLevel {
    if (trust < 0.2 || familiarity < 0.1) return 'stranger';
    if (familiarity < 0.3) return 'acquaintance';
    if (familiarity < 0.6 || trust < 0.5) return 'familiar';
    return 'close';
  }

  /**
   * 构建默契度描述文本
   */
  private buildDescription(level: RapportLevel, trust: number, familiarity: number): string {
    const trustLabel = RapportController.describeLevel(trust);
    const familiarityLabel = RapportController.describeLevel(familiarity);

    switch (level) {
      case 'stranger':
        return `初识阶段（信任度${trustLabel}，熟悉度${familiarityLabel}），精灵正在了解你`;
      case 'acquaintance':
        return `相识阶段（信任度${trustLabel}，熟悉度${familiarityLabel}），精灵记住了你的部分偏好`;
      case 'familiar':
        return `熟悉阶段（信任度${trustLabel}，熟悉度${familiarityLabel}），精灵理解了你的习惯`;
      case 'close':
        return `亲密阶段（信任度${trustLabel}，熟悉度${familiarityLabel}），精灵是你得力的伙伴`;
    }
  }

  /**
   * 将默契度转换为互动边界指导（注入 system prompt 用）
   *
   * 不同默契度等级对应不同的互动边界：
   *   - 初识：保持礼貌距离，多确认，不假设用户偏好
   *   - 相识：可以基于已知信息适当调整，但仍需确认
   *   - 熟悉：可以主动利用已记住的偏好，省略重复确认
   *   - 亲密：可以像老朋友一样交流，适当调侃，主动建议
   *
   * @param rapport 默契度状态
   * @returns 互动边界指导文本
   */
  buildRapportPrompt(rapport: RapportState): string {
    const lines: string[] = ['【关系边界指导】我们目前的关系阶段决定了互动方式：'];

    switch (rapport.level) {
      case 'stranger':
        lines.push('- 阶段：初识——我们刚开始认识，彼此还不了解');
        lines.push('- 称呼：使用礼貌用语，不过度热情，不随意使用亲昵称呼');
        lines.push('- 偏好：不要假设我喜欢什么，重要选项需要确认');
        lines.push('- 记忆：可以记住我明确告诉你的信息，但不要过度联想');
        lines.push('- 主动：保持克制，只回答问题，不主动扩展话题');
        break;
      case 'acquaintance':
        lines.push('- 阶段：相识——你已经记住了我的一些偏好和习惯');
        lines.push('- 称呼：可以自然交流，适当友好但保持尊重');
        lines.push('- 偏好：可以基于已有记忆做合理推断，但关键决策仍需确认');
        lines.push('- 记忆：主动关联你记住的相关信息，帮助我回忆上下文');
        lines.push('- 主动：可以在回答后简短追问是否需要更多信息');
        break;
      case 'familiar':
        lines.push('- 阶段：熟悉——你理解了我的工作习惯和沟通风格');
        lines.push('- 称呼：语气可以更轻松自然，像合作已久的搭档');
        lines.push('- 偏好：可以直接利用已知偏好，不必每次重复确认（除非涉及风险操作）');
        lines.push('- 记忆：主动串联跨会话的信息，帮我看到联系和模式');
        lines.push('- 主动：可以主动指出你注意到的问题或机会，给出建设性建议');
        break;
      case 'close':
        lines.push('- 阶段：亲密——你是我信赖的长期伙伴');
        lines.push('- 称呼：可以像老朋友一样交流，适度调侃，不用过度客套');
        lines.push('- 偏好：可以预判我的需求，提前准备好我可能需要的信息');
        lines.push('- 记忆：可以综合长期记忆给出更深入的洞察，甚至指出我自己没意识到的模式');
        lines.push('- 主动：可以主动发起话题、提醒重要事项、直言不讳地给出反馈（包括反对意见）');
        break;
    }

    return lines.join('\n');
  }

  /**
   * 将 0-1 数值映射为中文等级描述
   */
  static describeLevel(value: number): string {
    if (value < 0.33) return '低';
    if (value < 0.67) return '中';
    return '高';
  }
}