/**
 * 轮次摘要生成器 — 每轮对话后生成溯源式摘要（记忆即摘要架构）。
 * 在 postProcess 阶段调用，生成 source='round-summary' 的记忆，含 SummaryType，
 * 用 sessionName + roundId 精确溯源；异步 fire-and-forget，不阻塞主对话流程。
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory, SummaryType } from '@/memory/types.js';
import {
  SOURCE_LABELS,
  SUMMARY_TYPES,
  roundSummaryMemoryId,
  roundSummarySessionPrefix,
} from '@/memory/types.js';
import { extractEnhancedKeywords, calculateWeightedJaccard } from '@/utils/segmenter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { logger } from '@/logging/logger.js';
import { parseLlmJson } from '@/utils/json.js';
import { nowIso } from '@/utils/time.js';
import { truncate } from '@/utils/strings.js';
import { roundTo } from '@/utils/math.js';
import { accumulateStream } from '@/agent/managers/streamAccumulator.js';

// ─── 常量 ────────────────────────────────────────────────

/** 用户输入截断上限（字符） */
const USER_INPUT_LIMIT = 500;
/** 助手回复截断上限（字符） */
const ASSISTANT_LIMIT = 2000;
/** 摘要内容截断上限（字符） */
const SUMMARY_CONTENT_LIMIT = 500;
/** 取代检测的关键词重叠率阈值：同 session 新旧摘要关键词 Jaccard 重叠率≥此值则旧摘要被新摘要覆盖（打 supersededBy 标记，非删除） */
const SUPERSEDE_OVERLAP_THRESHOLD = 0.5;

/**
 * 取代检测的候选窗口（条）：每次生成只对「同 session 最近 N 条摘要」做取代判定。
 * 取代语义是「新决策替换旧同主题决策」，时间越近、同 session 越可能是被覆盖对象——
 * 候选构造仍需全量读（getBySource 过滤同 session），窗口收敛的是取代判定（关键词重叠计算）到最近 N 条，避免对全库摘要逐一做重叠计算（O(n) 退化）。
 */
const SUPERSEDE_CANDIDATE_WINDOW = 20;
/** LLM 温度参数（低温度确保摘要格式稳定） */
const LLM_TEMPERATURE = 0.3;

/**
 * 摘要 JSON 输出契约（内核硬契约，角色包不可替换）：输出格式与 SummaryType 分类必须稳定
 * （摘要写路径读取 summaryType 顶层字段且宿主依赖），角色包只可替换「提炼视角」（判断值得记什么）。
 */
const SUMMARY_JSON_CONTRACT = `请以 JSON 格式输出：
{
  "summary": "摘要内容（1-3 句话，不超过 500 字）",
  "type": "摘要类型（preference|fact|decision|intent|general）"
}

类型说明：
- preference: 用户表达的个人偏好或喜好
- fact: 客观事实信息
- decision: 明确的决策或选择
- intent: 用户的意图或计划
- general: 一般性对话，无明确分类`;

/** 默认提炼视角（无角色包声明时通用判断：意图/回答/决策偏好事实）；角色包声明 summaryFocus 时被替换 */
const DEFAULT_SUMMARY_PERSPECTIVE = `你是一个对话摘要生成器。请根据用户输入和助手回复，生成一段简洁的摘要。

摘要应包含：
1. 用户的核心意图或问题
2. 助手的核心回答或结论
3. 任何重要的决策、偏好或事实信息`;

/** 摘要生成 system prompt（默认）= 通用提炼视角 + 硬契约 */
const SUMMARY_SYSTEM_PROMPT = `${DEFAULT_SUMMARY_PERSPECTIVE}

${SUMMARY_JSON_CONTRACT}`;

/**
 * 角色包提炼视角段：激活角色包声明 summaryFocus 时以其视角替换通用视角（判断本轮值得记的信息维度与保留形式，如代码/diff/表格）。
 * 领域无关：内核不预设视角，全文由角色包提供；JSON 硬契约固定保留，SummaryType 分类不受影响。
 */
const SUMMARY_PERSPECTIVE_PROMPT = (focus: string): string =>
  `你是一个对话摘要生成器。请根据用户输入和助手回复，结合角色包提炼视角，生成一段简洁的摘要。

<<角色包提炼视角>>（据此判断本轮值得记录的信息维度与保留形式）：
${focus}

${SUMMARY_JSON_CONTRACT}`;

// ─── 类 ──────────────────────────────────────────────────

/** 轮次摘要生成器：在 Agent.postProcess 中调用，LlmProvider 生成摘要 + IMemoryStorage 持久化。 */
export class RoundSummaryGenerator {
  /** 当前使用的 Provider（后台优先，降级到默认） */
  private provider: LlmProvider;
  /** 构造时的默认 Provider（backgroundProvider 为 null 时回退使用） */
  private readonly defaultProvider: LlmProvider;

  constructor(
    provider: LlmProvider,
    private readonly storage: IMemoryStorage,
  ) {
    this.provider = provider;
    this.defaultProvider = provider;
  }

  /** 注入后台 Provider（Agent.setBackgroundProvider 调用）；null 表示回退到默认 Provider */
  setBackgroundProvider(provider: LlmProvider | null): void {
    this.provider = provider ?? this.defaultProvider;
  }

  /** 记忆写入回调（memoryAdded 事件出口）：摘要即记忆，新摘要写入后通知宿主「已沉淀」 */
  private _onMemoryAdded: ((info: { id: string; source: string; name: string }) => void) | null =
    null;

  /** 绑定记忆写入回调（Agent.init 调用）；传 null 解除绑定 */
  setOnMemoryAdded(
    fn: ((info: { id: string; source: string; name: string }) => void) | null,
  ): void {
    this._onMemoryAdded = fn;
  }

  /**
   * 生成并持久化轮次摘要。异步 fire-and-forget，内部捕获异常，仅记警告不阻塞主对话流程。
   * @param focus 角色包提炼视角（prepare.summaryFocus，undefined=通用浓缩）；存在时以其视角替换「值得记什么」判断主体，JSON 契约固定保留。
   */
  async generate(
    input: string,
    assistantContent: string,
    roundId: string,
    sessionName: string,
    focus?: string,
  ): Promise<void> {
    try {
      // 有关注点则以角色包提炼视角替换通用视角，JSON 契约固定保留
      const userMessage = `用户输入：${truncate(input, USER_INPUT_LIMIT)}\n\n助手回复：${truncate(assistantContent, ASSISTANT_LIMIT)}`;
      const systemContent = focus ? SUMMARY_PERSPECTIVE_PROMPT(focus) : SUMMARY_SYSTEM_PROMPT;
      const messages: Message[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userMessage },
      ];

      const raw = await accumulateStream(this.provider, messages, { temperature: LLM_TEMPERATURE });
      const result = parseLlmJson<{ summary: string; type: string }>(raw);

      if (!result || !result.summary) {
        logger.warn({ roundId }, '轮次摘要生成失败：LLM 返回无效 JSON');
        return;
      }

      // 验证摘要类型（LLM 输出可能不合法，兜底为 'general'）；取值集合单源：SUMMARY_TYPES（memory/types）
      const summaryType: SummaryType = SUMMARY_TYPES.includes(result.type as SummaryType)
        ? (result.type as SummaryType)
        : 'general';

      // 构建带溯源标记的记忆条目（round-summary + sessionName + roundId）
      // 溯源/分类字段走顶层持久化字段（summaryType/sessionName/roundId），不塞 metadata：
      // metadata 不在存储契约的保证范围内，而分轨召回/会话优先须跨会话可靠读取（边界定案，见 types.ts）
      const memoryId = roundSummaryMemoryId(sessionName, roundId);
      const now = nowIso();
      const memory: Memory = {
        id: memoryId,
        content: truncate(result.summary, SUMMARY_CONTENT_LIMIT),
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: `轮次摘要 ${sessionName} ${roundId}`,
        createdAt: now,
        accessedAt: now,
        summaryType,
        sessionName,
        roundId,
      };

      this.storage.upsert(memory);
      // memoryAdded 事件出口：宿主「已沉淀」提示的可观测通道
      this._onMemoryAdded?.({ id: memory.id, source: memory.source, name: memory.name });
      // 写路径取代检测：仅对「同 session 最近 N 条」摘要做取代判定（收敛重叠计算面，避免对全库摘要逐一计算）
      this.supersedeSimilar(memory, this.getSessionCandidates(memory));
      logger.debug({ memoryId, summaryType, sessionName, roundId }, '轮次摘要已生成');
    } catch (err) {
      logger.warn({ err, roundId }, '轮次摘要生成失败');
    }
  }

  /**
   * 构造取代检测候选：同 session 且未被取代的摘要，按时间倒序取最近 N 条（SUPERSEDE_CANDIDATE_WINDOW）。
   * 取代语义是"本 session 内新决策替换旧同主题决策"——收敛到同 session 近期摘要，
   * 候选经 getBySource 全量读后过滤，取代判定的重叠计算只跑最近 N 条（跨 session 长期历史不参与取代判定，无跨 session 覆盖语义）。
   *
   * @param newMemory 新生成的摘要（以 id 的 session 前缀定位本 session）
   * @returns 候选摘要列表（倒序取最近 N 条，供 supersedeSimilar 逐一判定）
   */
  private getSessionCandidates(newMemory: Memory): Memory[] {
    const sessionName = newMemory.sessionName;
    if (!sessionName) return [];
    const sessionPrefix = roundSummarySessionPrefix(sessionName);

    const all = this.storage.getBySource(SOURCE_LABELS.ROUND_SUMMARY);
    // 同 session + 未取代（排除自身）：按 createdAt 降序，取最近 N 条作候选
    return all
      .filter(
        (old) => old.id.startsWith(sessionPrefix) && !old.supersededBy && old.id !== newMemory.id,
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, SUPERSEDE_CANDIDATE_WINDOW);
  }

  /**
   * 写路径取代检测：记忆冲突消解从"读时猜"移到"写时定"。
   * 对给定的同 session 近窗口候选（candidates）逐一判定主题重叠——重叠率≥阈值则给旧摘要打 supersededBy 指向本摘要（非删除，可回溯）。
   *
   * 设计取舍：
   * - 不依赖 summaryType 做前置过滤：sessionName 已提升为顶层持久化字段（跨宿主可用），但 type 过滤
   *   属"进一步收紧取代面"的行为增强（同一主题不同类型如 preference 覆盖 decision 是否算取代，需语义定夺）。
   *   type 是纯语义标签，旁路 == "同一主题不同类可能被取代" 的已知取舍（见 memory-as-summary §5.4 说明）。
   * - 升级条件：若实测出现"跨类型误取代"困扰，可加"type 相同"前置过滤——当前不预埋（符合验证后固化纪律）。
   * - 确定性启发式代替额外 LLM 判断（零成本可测，符合"写一次定、读时确定性过滤" SSOT 纪律）；仅同 session 内判定避免误取代。
   *
   * @param newMemory 新生成的摘要
   * @param candidates 取代检测候选（由 getSessionCandidates 收敛，调用方传入而非内部全库扫描）
   */
  private supersedeSimilar(newMemory: Memory, candidates: Memory[]): void {
    try {
      const newWeightedKeywords = extractEnhancedKeywords(newMemory.content);
      if (newWeightedKeywords.length === 0) return;

      for (const old of candidates) {
        // 已 superseded 的跳过（避免重复标记；getSessionCandidates 已过滤，此处幂等兜底）
        if (old.supersededBy) continue;

        // 加权 Jaccard 让动作词/实体词贡献更大，更准识别"多轮逐步细化"的主题延续
        const oldWeightedKeywords = extractEnhancedKeywords(old.content);
        if (oldWeightedKeywords.length === 0) continue;
        const overlap = calculateWeightedJaccard(newWeightedKeywords, oldWeightedKeywords);
        if (overlap >= SUPERSEDE_OVERLAP_THRESHOLD) {
          // 写时取代：标记旧摘要被新摘要覆盖（非删除，保留可回溯）
          this.storage.upsert({ ...old, supersededBy: newMemory.id });
          logger.debug(
            { oldId: old.id, newId: newMemory.id, overlap: roundTo(overlap, 3) },
            '轮次摘要被取代（superseded）',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'supersede 取代检测失败');
    }
  }
}
