/**
 * 轮次摘要生成器 — 每轮对话后生成溯源式摘要
 *
 * 设计（记忆即摘要架构）：
 *   - 在 postProcess 阶段调用，生成 `source='round-summary'` 的记忆
 *   - 摘要包含类型（SummaryType）和溯源标记（isTraceable）
 *   - 使用 sessionName + roundId 实现精确溯源
 *   - 异步 fire-and-forget，不阻塞主对话流程
 *
 * 关联文档：
 *   - docs/architecture/memory-as-summary.md
 *   - memory/types.ts（Memory 接口 + SummaryType）
 */

import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory, SummaryType } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
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

/** 默认摘要 score */
const DEFAULT_SUMMARY_SCORE = 0.5;

/**
 * 取代检测的关键词重叠率阈值（写路径取代检测，ADR-021）
 *
 * 新摘要与同 session 旧摘要在关键词 **Jaccard 重叠率**（交集/并集）>= 此值时，
 * 判定旧摘要被新摘要覆盖，打 `supersededBy` 标记（非删除）。
 */
const SUPERSEDE_OVERLAP_THRESHOLD = 0.5;

/** LLM 温度参数（低温度确保摘要格式稳定） */
const LLM_TEMPERATURE = 0.3;

/**
 * 摘要 JSON 输出契约（内核硬契约，角色包不可替换）
 *
 * 独立为常量：无论角色包是否声明提炼视角，summary 的输出格式与 SummaryType
 * 分类必须稳定（摘要写路径读取 metadata.summaryType 且宿主依赖），故作为
 * 不可替换的契约固守，角色包只可替换「提炼视角」（判断值得记什么）。
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

/**
 * 默认提炼视角（无角色包声明时的通用判断）
 *
 * 判断「摘要应包含什么」的通用归纳框架：意图 / 回答 / 决策偏好事实。
 * 当角色包声明 prepare.summaryFocus 时，本视角被角色包提炼视角**替换**；
 * 未声明时沿用本通用视角（逐字节不变，零回归）。
 */
const DEFAULT_SUMMARY_PERSPECTIVE = `你是一个对话摘要生成器。请根据用户输入和助手回复，生成一段简洁的摘要。

摘要应包含：
1. 用户的核心意图或问题
2. 助手的核心回答或结论
3. 任何重要的决策、偏好或事实信息`;

/** 摘要生成 system prompt（默认）= 通用提炼视角 + 硬契约（逐字节匹配旧 SUMMARY_SYSTEM_PROMPT） */
const SUMMARY_SYSTEM_PROMPT = `${DEFAULT_SUMMARY_PERSPECTIVE}

${SUMMARY_JSON_CONTRACT}`;

/**
 * 角色包提炼视角段（结构化信息保真 + 提炼侧视角下沉，见 docs/architecture/structured-fidelity.md）
 *
 * 当激活角色包声明 prepare.summaryFocus 时，以角色包视角**替换**通用提炼视角：
 * 角色包据此判断「本轮值得记的信息维度与保留形式」（如编程卡声明保留代码/diff/表格，
 * 覆盖目标/决策等维度）。领域无关机制：内核不预设视角，全文由角色包提供（{{FOCUS}} 占位替换）。
 * JSON 硬契约（SUMMARY_JSON_CONTRACT）固定保留，SummaryType 分类不受影响。
 * 未声明时摘要行为与现状完全一致（零增量成本）。
 */
const SUMMARY_PERSPECTIVE_PROMPT = (focus: string): string =>
  `你是一个对话摘要生成器。请根据用户输入和助手回复，结合角色包提炼视角，生成一段简洁的摘要。

<<角色包提炼视角>>（据此判断本轮值得记录的信息维度与保留形式）：
${focus}

${SUMMARY_JSON_CONTRACT}`;

// ─── 类 ──────────────────────────────────────────────────

/**
 * 轮次摘要生成器
 *
 * 依赖注入：
 *   - LlmProvider：用于调用 LLM 生成摘要
 *   - IMemoryStorage：用于持久化摘要记忆
 *
 * 使用方式（在 Agent.postProcess 中调用）：
 *   await this.roundSummaryGenerator.generate(input, assistantContent, roundId, sessionName);
 */
export class RoundSummaryGenerator {
  constructor(
    private readonly provider: LlmProvider,
    private readonly storage: IMemoryStorage,
  ) {}

  /**
   * 记忆写入回调（memoryAdded 事件出口）
   *
   * 新轮次摘要写入后触发，供 Agent 发射 memoryAdded 事件（宿主「已沉淀」提示）。
   * 替代原洞察层（InsightExtractor）的记忆沉淀通知出口——摘要即记忆，新记忆产生必通知。
   */
  private _onMemoryAdded: ((info: { id: string; source: string; name: string }) => void) | null = null;

  /**
   * 绑定记忆写入回调（由 Agent.init() 调用）
   *
   * @param fn 写入回调（传入 null 可解除绑定）
   */
  setOnMemoryAdded(fn: ((info: { id: string; source: string; name: string }) => void) | null): void {
    this._onMemoryAdded = fn;
  }

  /**
   * 生成并持久化轮次摘要
   *
   * 异步 fire-and-forget 模式，内部捕获所有异常。
   * 失败时仅记录警告日志，不阻塞主对话流程。
   *
   * @param input - 用户本轮输入
   * @param assistantContent - 助手本轮回复
   * @param roundId - 当前轮次 ID（从 AgentLoop.getCurrentRoundId() 获取）
   * @param sessionName - 当前会话名称（从 MessageHistory.currentSessionName 获取）
   * @param focus - 角色包提炼视角（可选，结构化保真 + 提炼侧视角下沉）：来自激活角色包
   *   prepare.summaryFocus，undefined=通用浓缩；存在时以其视角替换「值得记什么」的判断主体，
   *   JSON 硬契约（SummaryType 分类）固定保留
   */
  async generate(
    input: string,
    assistantContent: string,
    roundId: string,
    sessionName: string,
    focus?: string,
  ): Promise<void> {
    // 轮次 ID 为空时跳过（兼容旧版本宿主）
    if (!roundId) return;

    try {
      // 1. 准备 LLM 调用消息（有关注点则以角色包提炼视角替换通用视角，JSON 契约固定保留）
      const userMessage = `用户输入：${truncate(input, USER_INPUT_LIMIT)}\n\n助手回复：${truncate(assistantContent, ASSISTANT_LIMIT)}`;
      const systemContent = focus ? SUMMARY_PERSPECTIVE_PROMPT(focus) : SUMMARY_SYSTEM_PROMPT;
      const messages: Message[] = [
        { role: 'system', content: systemContent },
        { role: 'user', content: userMessage },
      ];

      // 2. 调用 LLM 生成摘要（流式累积模式）
      const raw = await accumulateStream(this.provider, messages, { temperature: LLM_TEMPERATURE });
      const result = parseLlmJson<{ summary: string; type: string }>(raw);

      if (!result || !result.summary) {
        logger.warn({ roundId }, '轮次摘要生成失败：LLM 返回无效 JSON');
        return;
      }

      // 3. 验证摘要类型（LLM 输出可能不合法，兜底为 'general'）
      const validTypes: SummaryType[] = ['preference', 'fact', 'decision', 'intent', 'general'];
      const summaryType: SummaryType = validTypes.includes(result.type as SummaryType)
        ? (result.type as SummaryType)
        : 'general';

      // 4. 构建记忆条目
      const memoryId = `round-summary:${sessionName}:${roundId}`;
      const now = nowIso();
      const memory: Memory = {
        id: memoryId,
        content: truncate(result.summary, SUMMARY_CONTENT_LIMIT),
        source: SOURCE_LABELS.ROUND_SUMMARY,
        name: `轮次摘要 ${sessionName} ${roundId}`,
        createdAt: now,
        accessedAt: now,
        score: DEFAULT_SUMMARY_SCORE,
        isTraceable: true,
        metadata: {
          summaryType,
          sessionName,
          roundId,
        },
      };

      // 5. 写入存储
      this.storage.upsert(memory);
      // 5.1 触发记忆写入回调（memoryAdded 事件出口）：宿主「已沉淀」提示的可观测出口
      this._onMemoryAdded?.({ id: memory.id, source: memory.source, name: memory.name });
      // 6. 写路径取代检测（ADR-021）：检测同 session 近期同主题摘要是否被本摘要覆盖
      this.supersedeSimilar(memory);
      logger.debug({ memoryId, summaryType, sessionName, roundId }, '轮次摘要已生成');
    } catch (err) {
      logger.warn({ err, roundId }, '轮次摘要生成失败');
    }
  }

  /**
   * 写路径取代检测（ADR-021）——记忆冲突消解从"读时猜"移到"写时定"
   *
   * 新摘要生成后，扫描同 session 的既有 round-summary，若存在**主题高度重叠**的旧摘要
   * （关键词重叠率 >= 阈值），判定旧摘要被本摘要覆盖，给旧摘要打 `supersededBy` 标记
   * 并指向本摘要（**非删除**，保留可经 traceSummary 回溯）。
   *
   * 设计取舍：
   * - **不依赖 metadata.type**：宿主 SqliteStorage 不持久化 metadata，故用可从 id 解析的
   *   session 前缀 + 关键词重叠判定，跨宿主可用（id 是持久化字段）。
   * - **确定性启发式**：用关键词重叠代替额外 LLM 判断，零额外成本、行为可测，符合
   *   "写一次定、读时确定性过滤"的 SSOT 纪律（ADR-021 §方案 C）。
   * - 仅同 session 内判定，避免跨会话误取代。
   *
   * @param newMemory 刚写入的新轮次摘要
   */
  private supersedeSimilar(newMemory: Memory): void {
    try {
      // 从新摘要 id 推导同 session 前缀（id 格式：round-summary:<sessionName>:<roundId>）
      const sessionName = newMemory.metadata?.sessionName;
      if (!sessionName) return;
      const sessionPrefix = `round-summary:${sessionName}:`;

      // 使用增强关键词提取（带权重），提升核心动作和实体在相似度计算中的区分度
      const newWeightedKeywords = extractEnhancedKeywords(newMemory.content);
      if (newWeightedKeywords.length === 0) return;

      const all = this.storage.getBySource(SOURCE_LABELS.ROUND_SUMMARY);
      for (const old of all) {
        // 跳过自身
        if (old.id === newMemory.id) continue;
        // 仅同 session 的轮次摘要
        if (!old.id.startsWith(sessionPrefix)) continue;
        // 已 superseded 的跳过（避免重复标记）
        if (old.supersededBy) continue;

        // 使用加权 Jaccard 计算主题相似度
        // 相比标准 Jaccard，加权版本让动作词（权重 2.0）和实体词（权重 1.5）
        // 在相似度计算中贡献更大，更准确地识别"多轮逐步细化"场景下的主题延续
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