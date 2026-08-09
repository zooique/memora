/**
 * AutoConfigRefiner — Agent 智能总结接口（模式 3）
 *
 * 从对话中提取配置建议（规则/角色/技能），通过 ConfigManager.onConfigSuggestion 通知宿主。
 *
 * 设计原则：
 *   - 使用后台 Provider（setBackgroundProvider 注入），不占用前台对话资源
 *   - 无后台 Provider 时降级为启发式规则提取
 *   - 每次对话后异步执行，不阻塞主流程
 *   - 置信度低于阈值时静默跳过
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { ConfigSuggestion } from '@/agent/managers/configManager.js';
import { logger } from '@/logging/logger.js';
import { parseLlmJson } from '@/utils/json.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

/** AutoConfigRefiner 配置 */
export interface AutoConfigRefinerOptions {
  /** 最低置信度阈值（0-1），低于此值的建议被丢弃 */
  minConfidence?: number;
  /** 单次对话最大建议数 */
  maxSuggestions?: number;
  /**
   * 已有同名规则查重回调（T2-3 去重，可选，向后兼容）
   *
   * 返回 true 表示该 name 已存在同名 rule（落库 id=source:name 冲突面），
   * 建议应被过滤——防「血肉结晶为骨骼」路径重复沉淀。
   * 未注入时不做已有规则查重（仅做跨轮重复回调去重）。
   */
  isExistingRule?: (name: string) => boolean;
}

/** LLM 返回的建议结构（type 开放字符串，对齐 ADR-004） */
interface RawSuggestion {
  /** 建议类型（约定值：rule/persona/skill，LLM prompt 引导但不强制） */
  type: string;
  name: string;
  content: string;
  confidence: number;
  reason: string;
}

const DEFAULT_OPTIONS: Required<Omit<AutoConfigRefinerOptions, 'isExistingRule'>> = {
  minConfidence: 0.6,
  maxSuggestions: 3,
};

/** 解析后的选项：默认值 + 可选注入回调（isExistingRule 不属于默认配置） */
type ResolvedOptions = Required<Omit<AutoConfigRefinerOptions, 'isExistingRule'>> & {
  isExistingRule?: (name: string) => boolean;
};

export class AutoConfigRefiner {
  private readonly options: ResolvedOptions;
  private backgroundProvider: LlmProvider | null = null;
  /**
   * 已建议指纹集合（T2-3 去重，`type\0name`）
   *
   * analyze 每轮执行且无状态，同一建议会在多轮被重复提取并重复回调宿主。
   * 记录已回调过的建议指纹，跨轮命中则跳过——防重复打扰用户、防重复沉淀。
   * 指纹对齐落库 id（source:name）冲突面：同 name 重复回调本应幂等覆盖，
   * 无谓地重复 notify 只会增加宿主 UI 噪音。
   */
  private readonly seenSuggestionKeys: Set<string> = new Set();

  constructor(
    private readonly onConfigSuggestion: (suggestion: ConfigSuggestion) => void,
    options?: AutoConfigRefinerOptions,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 注入后台 Provider（由 Agent.setBackgroundProvider 调用） */
  setBackgroundProvider(provider: LlmProvider | null): void {
    this.backgroundProvider = provider;
  }

  /**
   * 分析对话，提取配置建议
   *
   * 在 Agent.postProcess 中异步调用，不阻塞主流程。
   */
  async analyze(userInput: string, assistantContent: string): Promise<void> {
    // 短对话跳过（信息量不足）
    if (userInput.length < 20 || assistantContent.length < 20) {
      return;
    }

    let suggestions: RawSuggestion[];

    if (this.backgroundProvider) {
      suggestions = await this.analyzeWithLlm(userInput, assistantContent);
    } else {
      suggestions = this.analyzeWithHeuristics(userInput);
    }

    // 过滤低置信度 + 查重（已有同名 rule / 跨轮重复回调）+ 限制数量
    // 注意：去重过滤在 slice 之前——已存在/已建议的不占 maxSuggestions 名额
    const filtered = suggestions
      .filter((s) => s.confidence >= this.options.minConfidence)
      .filter((s) => !this.isDuplicateSuggestion(s))
      .slice(0, this.options.maxSuggestions);

    for (const raw of filtered) {
      const suggestion: ConfigSuggestion = {
        type: raw.type,
        name: raw.name,
        content: raw.content,
        confidence: raw.confidence,
        source: 'auto-config-refiner',
      };

      logger.info(
        { type: raw.type, name: raw.name, confidence: raw.confidence, reason: raw.reason },
        'AutoConfigRefiner: 提取到配置建议',
      );

      // 单条建议回调失败时记日志并继续处理下一条，避免一条失败导致后续全部丢失
      try {
        this.onConfigSuggestion(suggestion);
      } catch (err) {
        logger.warn(
          { err, suggestionName: raw.name, suggestionType: raw.type },
          'AutoConfigRefiner: 单条建议回调失败，跳过该条继续处理',
        );
      }
    }
  }

  /**
   * 去重判据（T2-3）：建议是否应被过滤
   *
   * 两层去重：
   * 1. 已有同名 rule（options.isExistingRule）——落库 id=source:name 冲突面，
   *    同内容重复沉淀成多个 rule 文件是长期数据污染，生成阶段直接拦截。
   * 2. 跨轮重复回调（seenSuggestionKeys，`type\0name` 指纹）——analyze 每轮执行，
   *    同一建议会被反复提取，只通知宿主一次。
   *
   * 副作用说明：命中第二层时立即记录指纹（幂等语义——只要提取过就算「已建议」，
   * 宿主是否成功接收由回调 try/catch 兜底；下轮 LLM 若以不同 name 重新提取，
   * 指纹不同，仍会重新建议）。
   */
  private isDuplicateSuggestion(raw: RawSuggestion): boolean {
    if (this.options.isExistingRule?.(raw.name)) {
      return true;
    }
    const key = `${raw.type}\u0000${raw.name}`;
    if (this.seenSuggestionKeys.has(key)) {
      return true;
    }
    this.seenSuggestionKeys.add(key);
    return false;
  }

  /** 使用后台 LLM 分析对话 */
  private async analyzeWithLlm(userInput: string, assistantContent: string): Promise<RawSuggestion[]> {
    if (!this.backgroundProvider) return [];

    const systemPrompt = `你是一个配置分析助手。分析用户和助手的对话，提取可能的配置建议。

规则（rule）：用户反复提到的偏好、约束或工作方式
角色（persona）：用户的工作角色或专业领域
技能（skill）：用户经常需要的能力或工具

返回 JSON 数组，每个元素包含：
- type: "rule" | "persona" | "skill"
- name: 简短名称（2-6字）
- content: Markdown 格式的详细内容
- confidence: 0-1 置信度
- reason: 为什么提出此建议

如果没有有价值的建议，返回空数组 []。
只返回 JSON，不要其他内容。`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `用户输入：${userInput.slice(0, 500)}\n\n助手回复：${assistantContent.slice(0, 500)}`,
      },
    ];

    try {
      // 收集流式输出（复用 accumulateStream 工具函数）
      const fullContent = await accumulateStream(this.backgroundProvider, messages, {
        temperature: 0.3,
      });

      const parsed = parseLlmJson<RawSuggestion[] | { suggestions: RawSuggestion[] }>(
        fullContent || '[]',
      );
      const items = Array.isArray(parsed) ? parsed : parsed?.suggestions ?? [];

      return items.filter(
        (s: RawSuggestion) =>
          s.type && s.name && s.content && typeof s.confidence === 'number',
      );
    } catch (err) {
      logger.warn({ err }, 'AutoConfigRefiner: LLM 分析失败，跳过');
      return [];
    }
  }

  /** 启发式规则提取（无 LLM 时的降级方案） */
  private analyzeWithHeuristics(userInput: string): RawSuggestion[] {
    const suggestions: RawSuggestion[] = [];
    const input = userInput.toLowerCase();

    // 检测明确的偏好声明（"我喜欢..."、"我习惯..."、"我偏好..."）
    const preferencePatterns = [
      /我(?:喜欢|偏好|习惯|常用|一般用)\s*(.{2,20})/gu,
      /(?:always|prefer|usually|typically)\s+(?:use|work with)\s+(.{2,20})/giu,
    ];

    for (const pattern of preferencePatterns) {
      const matches = input.matchAll(pattern);
      for (const match of matches) {
        const captured = match[1]?.trim() ?? '';
        const original = match[0] ?? '';
        if (!captured) continue;
        suggestions.push({
          type: 'rule',
          name: `偏好-${captured.slice(0, 10)}`,
          content: `用户偏好：${captured}`,
          confidence: 0.65,
          reason: `检测到明确的偏好声明：${original}`,
        });
      }
    }

    // 检测专业领域关键词
    const domainKeywords: Record<string, string> = {
      '代码|编程|bug|debug|重构|函数|接口': '程序员助手',
      '设计|UI|UX|原型|交互|视觉': '设计师助手',
      '写作|文案|编辑|文章|内容': '写作助手',
      '数据|分析|报表|统计|指标': '数据分析师',
    };

    for (const [keywordPattern, personaName] of Object.entries(domainKeywords)) {
      const regex = new RegExp(keywordPattern, 'iu');
      if (regex.test(input)) {
        suggestions.push({
          type: 'persona',
          name: personaName,
          content: `专业领域：${personaName}。用户对话中频繁出现相关术语。`,
          confidence: 0.6,
          reason: `检测到${personaName}领域关键词`,
        });
      }
    }

    return suggestions;
  }
}
