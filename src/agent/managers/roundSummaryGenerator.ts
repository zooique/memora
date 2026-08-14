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
import { extractKeywords } from '@/memory/recall.js';
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

/** 摘要生成 system prompt */
const SUMMARY_SYSTEM_PROMPT = `你是一个对话摘要生成器。请根据用户输入和助手回复，生成一段简洁的摘要。

摘要应包含：
1. 用户的核心意图或问题
2. 助手的核心回答或结论
3. 任何重要的决策、偏好或事实信息

请以 JSON 格式输出：
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
   * 生成并持久化轮次摘要
   *
   * 异步 fire-and-forget 模式，内部捕获所有异常。
   * 失败时仅记录警告日志，不阻塞主对话流程。
   *
   * @param input - 用户本轮输入
   * @param assistantContent - 助手本轮回复
   * @param roundId - 当前轮次 ID（从 AgentLoop.getCurrentRoundId() 获取）
   * @param sessionName - 当前会话名称（从 MessageHistory.currentSessionName 获取）
   */
  async generate(
    input: string,
    assistantContent: string,
    roundId: string,
    sessionName: string,
  ): Promise<void> {
    // 轮次 ID 为空时跳过（兼容旧版本宿主）
    if (!roundId) return;

    try {
      // 1. 准备 LLM 调用消息
      const userMessage = `用户输入：${truncate(input, USER_INPUT_LIMIT)}\n\n助手回复：${truncate(assistantContent, ASSISTANT_LIMIT)}`;
      const messages: Message[] = [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
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

      // 新摘要关键词（无有效关键词时无法判定主题相关，跳过）
      const newKeywords = extractKeywords(newMemory.content);
      if (newKeywords.length === 0) return;

      const all = this.storage.getBySource(SOURCE_LABELS.ROUND_SUMMARY);
      for (const old of all) {
        // 跳过自身
        if (old.id === newMemory.id) continue;
        // 仅同 session 的轮次摘要
        if (!old.id.startsWith(sessionPrefix)) continue;
        // 已 superseded 的跳过（避免重复标记）
        if (old.supersededBy) continue;

        // 主题相关判定：Jaccard 重叠率（交集 / 并集）
        // 用 Jaccard 而非"交集/较小集合"：避免"用户/偏好"等高频共享词在短摘要中虚高重叠、
        // 导致不同主题被误判为覆盖。Jaccard 被并集稀释，仅在真正同主题时接近 1。
        const oldKeywords = extractKeywords(old.content);
        if (oldKeywords.length === 0) continue;
        const intersection = oldKeywords.filter((k) => newKeywords.includes(k)).length;
        const union = oldKeywords.length + newKeywords.length - intersection;
        if (union === 0) continue;
        const overlap = intersection / union;
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