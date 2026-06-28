/**
 * 情感基调控制器 — 从记忆数据实时推导精灵对话风格
 *
 * 职责：
 *   1. 从现有记忆数据中推导四维情感基调（温暖度/直接度/主动度/调皮度）
 *   2. 生成情感描述文本，注入到 Agent system prompt
 *   3. 纯代码计算，不依赖 LLM，不新增存储
 *
 * 设计原则（迭代规划 Phase 2.1）：
 *   - 不存储 AffectTone——每次从记忆实时推导（"代码负责确定性" B6）
 *   - 不在核心库实现——纯宿主层逻辑（B5）
 *   - 不引入新数据结构——复用现有 Memory 和 Persona.traits（B1）
 *   - 推导频率：每次 wakeup 前推导一次（成本为零，纯代码计算）
 */

import type { Memory } from 'memora';
import type { Persona } from 'memora';
import { logger } from 'memora';

// ─── 类型定义 ────────────────────────────────────────────

/** 四维情感基调（开放字符串键值对，非封闭枚举） */
export interface AffectState {
  /** 温暖度 0-1：基于交互频率和 profile 记忆数量 */
  warmth: number;
  /** 调皮度 0-1：从角色 persona.traits.playfulness 读取 */
  playfulness: number;
  /** 直接度 0-1：从用户画像中推断是否偏好简洁 */
  directness: number;
  /** 主动度 0-1：基于主动提示接受率 */
  initiative: number;
}

/** AffectController 构造选项 */
export interface AffectControllerOptions {
  /** 主动提示接受率（来自 ProactiveEngine.acceptanceRate） */
  acceptanceRate: number;
  /** 当前激活角色（可为 null，表示使用默认角色） */
  currentPersona?: Persona | null;
}

// ─── 常量 ────────────────────────────────────────────────

/** 温暖度计算：profile 记忆数量达到此值时 warmth=1 */
const PROFILE_COUNT_FOR_FULL_WARMTH = 20;

/** 默认四维情感基调（无数据时使用） */
const DEFAULT_AFFECT: AffectState = {
  warmth: 0.5,
  playfulness: 0.3,
  directness: 0.5,
  initiative: 0.5,
};

// ─── AffectController 类 ─────────────────────────────────

/**
 * 情感基调控制器
 *
 * 从记忆数据中实时推导精灵的情感基调，生成自然语言描述注入到 system prompt。
 * 纯宿主层实现，零内核改动，零存储开销。
 */
export class AffectController {
  private options: AffectControllerOptions;

  constructor(options: AffectControllerOptions) {
    this.options = options;
  }

  /**
   * 更新配置（角色切换或接受率变化时调用）
   */
  updateOptions(options: Partial<AffectControllerOptions>): void {
    if (options.acceptanceRate !== undefined) {
      this.options.acceptanceRate = options.acceptanceRate;
    }
    if (options.currentPersona !== undefined) {
      this.options.currentPersona = options.currentPersona;
    }
  }

  /**
   * 从记忆数据推导情感基调
   *
   * 纯计算，不依赖 LLM，不修改任何状态。
   *
   * @param memories 所有记忆列表（用于统计 profile 数量和偏好检测）
   * @returns 四维情感基调
   */
  deriveAffect(memories: Memory[]): AffectState {
    if (memories.length === 0) {
      // 空记忆时使用默认值，但尊重自定义 acceptanceRate 和 persona traits
      const playfulness = this.options.currentPersona?.traits?.playfulness ?? DEFAULT_AFFECT.playfulness;
      return {
        warmth: DEFAULT_AFFECT.warmth,
        playfulness: Math.round(playfulness * 100) / 100,
        directness: DEFAULT_AFFECT.directness,
        initiative: Math.round(this.options.acceptanceRate * 100) / 100,
      };
    }

    // 温暖度：基于 profile 记忆数量（profile 越多说明交互越深入）
    const profileCount = memories.filter((m) => m.source === 'profile').length;
    const warmth = Math.min(1, profileCount / PROFILE_COUNT_FOR_FULL_WARMTH);

    // 直接度：从用户画像中检测"简洁"偏好（开放字符串匹配）
    const prefersDirect = memories.some(
      (m) =>
        m.source === 'profile' &&
        (m.content.includes('简洁') ||
          m.content.includes('直接') ||
          m.content.includes('简短')),
    );
    const directness = prefersDirect ? 0.8 : 0.5;

    // 主动度：来自 ProactiveEngine 的接受率
    const initiative = this.options.acceptanceRate;

    // 调皮度：从角色 persona.traits 读取（默认 0.3）
    const playfulness =
      this.options.currentPersona?.traits?.playfulness ?? 0.3;

    const affect: AffectState = {
      warmth: Math.round(warmth * 100) / 100,
      playfulness: Math.round(playfulness * 100) / 100,
      directness: Math.round(directness * 100) / 100,
      initiative: Math.round(initiative * 100) / 100,
    };

    logger.debug({ ...affect }, 'AffectController: 情感基调已推导');
    return affect;
  }

  /**
   * 将情感基调转换为可执行的行为指导文本，注入 LLM system prompt
   *
   * 输出自然语言行为准则，让 LLM 知道每个情感维度对应的具体说话方式。
   *
   * @param affect 四维情感基调
   * @returns 行为指导文本（自然语言，LLM 可直接遵循）
   */
  buildAffectPrompt(affect: AffectState): string {
    const lines: string[] = ['【互动基调指导】请根据以下状态调整你的表达方式：'];

    // 温暖度 → 语气温度
    if (affect.warmth >= 0.67) {
      lines.push('- 语气：温暖亲切，像熟悉的朋友，可以自然地表达关心和共情');
    } else if (affect.warmth >= 0.33) {
      lines.push('- 语气：友好自然，保持适度热情但不过分亲昵');
    } else {
      lines.push('- 语气：礼貌克制，保持专业距离，简洁回应即可');
    }

    // 直接度 → 表达风格
    if (affect.directness >= 0.67) {
      lines.push('- 风格：直奔主题，先给结论再补充细节，不用寒暄铺垫');
    } else if (affect.directness >= 0.33) {
      lines.push('- 风格：平衡表达，简述背景后给出要点，不啰嗦也不突兀');
    } else {
      lines.push('- 风格：委婉耐心，可以适当铺垫和解释，确保用户充分理解');
    }

    // 主动度 → 主动性边界
    if (affect.initiative >= 0.67) {
      lines.push('- 主动：可以主动追问、主动提供相关建议、预判用户可能的需求');
    } else if (affect.initiative >= 0.33) {
      lines.push('- 主动：适度主动，回答问题后可以简短追问，但不要推销式输出');
    } else {
      lines.push('- 主动：等待用户明确指令，只回答被问到的内容，不主动扩展');
    }

    // 调皮度 → 表达趣味
    if (affect.playfulness >= 0.67) {
      lines.push('- 趣味：可以适度幽默、使用轻松的语气词，但注意不要影响专业性');
    } else if (affect.playfulness >= 0.33) {
      lines.push('- 趣味：自然表达即可，偶尔轻松但不刻意搞笑');
    } else {
      lines.push('- 趣味：保持严谨，不用表情符号和幽默表达，专注内容本身');
    }

    return lines.join('\n');
  }

  /**
   * 将 0-1 数值映射为中文等级描述
   *
   * @param value 0-1 数值
   * @returns 等级描述（低/中/高）
   */
  static describeLevel(value: number): string {
    if (value < 0.33) return '低';
    if (value < 0.67) return '中';
    return '高';
  }
}