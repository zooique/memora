/**
 * 记忆衰减调度器（从 agent.ts 拆分）：按 GOVERNANCE_SOURCES 对记忆执行 score 衰减，体现"自然遗忘"。
 * 不衰减 persona/rule/skill（配置型记忆不应衰减）。通过超时回调和 score 判定记忆有效，不引入 type→时间窗口过滤。
 * 可选 L2 时效性评估：衰减后扫描低分记忆（score<阈值），LLM 判断是否已过时，过时降级 score（不物理删除）。
 * 当前治理源为空（作品投影已移出记忆库，记忆库仅剩 round-summary），衰减循环空转但保留机制。
 */

import { safeSetInterval, clearSafeInterval } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/toError.js';
import { nowIso } from '@/utils/time.js';
import { NOOP_TRACER, TRACE_SPANS, type ITracer } from '@/agent/tracer.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
// LLM judge 高阶函数（流式累积 + parseLlmJson + configError 封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
import { truncate } from '@/utils/strings.js';
// LLM 治理源列表（统一由 governance.ts 维护）
import { GOVERNANCE_SOURCES } from '@/memory/governance.js';

/** 衰减完成回调类型（Agent 注入 emit('decayCompleted')） */
export type DecayCompletedCallback = (payload: { decayedCount: number }) => void;

/** MemoryDecayScheduler 构造选项 */
export interface MemoryDecaySchedulerOptions {
  /** 可观测性 Tracer（未注入时降级为 NOOP_TRACER） */
  readonly tracer?: ITracer;
  /** 衰减完成事件发射回调（Agent 注入 emit('decayCompleted')） */
  readonly onDecayCompleted: DecayCompletedCallback;
  /** 后台 LLM Provider（可选，用于 L2 时效性评估，未注入时跳过） */
  readonly backgroundProvider?: LlmProvider | null;
  /** 完整记忆存储（可选，用于 L2 读取低分记忆和降级，未注入时跳过） */
  readonly index?: IMemoryStorage | null;
  /** 治理源列表（默认 GOVERNANCE_SOURCES；空治理源时衰减/评估空转，测试可显式注入） */
  readonly sources?: readonly string[];
}

// ─── L2 时效性评估常量 ────────────────────────────────────
/** 低分记忆阈值（低于此分的记忆进入 LLM 时效性评估） */
const TIMELINESS_LOW_SCORE_THRESHOLD = 0.3;
/** 单次时效性评估条数上限（控制 LLM 调用量） */
const TIMELINESS_EVALUATE_LIMIT = 20;
/** LLM 时效性判断超时（ms） */
const TIMELINESS_TIMEOUT_MS = 15_000;
/** 判定为过时的记忆降级到此 score（接近删除阈值，但保留可恢复性） */
const TIMELINESS_OUTDATED_SCORE = 0.05;
/** 候选记忆内容预览长度（截断后送入 LLM） */
const TIMELINESS_CONTENT_PREVIEW_LEN = 200;

// ─── L2 时效性评估类型 ────────────────────────────────────

/** 单条记忆的时效性判断结果 */
export interface TimelinessVerdict {
  memoryId: string;
  /** 是否已过时（true → 降级到 TIMELINESS_OUTDATED_SCORE） */
  isOutdated: boolean;
  /** LLM 判断理由 */
  reason: string;
}

/** 时效性评估报告（evaluateTimeliness 返回值） */
export interface TimelinessReport {
  /** 扫描的低分记忆总数 */
  scannedCount: number;
  /** LLM 判定为过时并降级的记忆数 */
  outdatedCount: number;
  /** 被降级记忆 ID 列表 */
  demotedIds: string[];
  /** 跳过原因（LLM 不可用 / 无低分记忆） */
  skippedReason?: string;
}

/** 衰减指标快照（供 Agent.getMetrics 合并） */
export interface DecayMetrics {
  /** 衰减执行次数 */
  readonly runCount: number;
  /** 累计衰减记忆数 */
  readonly totalDecayedCount: number;
  /** 上次衰减时间（ISO 8601，null 表示从未执行） */
  readonly lastRunAt: string | null;
}

/**
 * 记忆衰减调度器。用法：new → start(storage, intervalMs) → runOnce()/stop()/getMetrics()。
 */
export class MemoryDecayScheduler {
  private readonly tracer: ITracer;
  private readonly onDecayCompleted: DecayCompletedCallback;
  private readonly backgroundProvider: LlmProvider | null;
  private readonly index: IMemoryStorage | null;
  /** 治理源列表（默认 GOVERNANCE_SOURCES；构造时固化，空治理源时衰减/评估空转） */
  private readonly sources: readonly string[];

  /** 衰减定时器（null=未启动） */
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 衰减目标存储（start 注入，stop 释放） */
  private storage: IMemoryStorageLike | null = null;
  /** L2 评估 AbortController：stop() abort 使 LLM 调用快速失败，防 close 后 upsert 已关闭 storage */
  private evaluateAbortController: AbortController | null = null;
  /** 进行中的 evaluateTimeliness Promise：awaitInflight() 等待其完成，确保关闭前 upsert 落库 */
  private inflightEvaluate: Promise<TimelinessReport> | null = null;

  // ─── 衰减指标统计字段 ──────────────────────────────────
  private metricDecayRunCount: number = 0;
  private metricTotalDecayedCount: number = 0;
  private metricLastDecayAt: string | null = null;

  constructor(opts: MemoryDecaySchedulerOptions) {
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.onDecayCompleted = opts.onDecayCompleted;
    // L2 可选依赖，未注入时 evaluateTimeliness 静默跳过
    this.backgroundProvider = opts.backgroundProvider ?? null;
    this.index = opts.index ?? null;
    this.sources = opts.sources ?? GOVERNANCE_SOURCES;
  }

  /** 启动定期衰减：立即执行首次衰减，再注册定时衰减 */
  start(storage: IMemoryStorageLike, intervalMs: number): void {
    this.storage = storage;
    // 治理源为空时挂起周期调度：无对象可衰减，不注册 timer（避免空转链——
    // 周期性空跑 decayScores([]) 仍发射事件/记 span/累指标）；保留手动 runOnce
    // 能力（governance.decay() 仍可调用，空源时 runOnce 内短路）。
    if (this.sources.length === 0) {
      logger.debug('治理源为空，衰减调度挂起（不注册周期 timer）');
      return;
    }
    this.runOnce();
    this.decayTimer = safeSetInterval(() => this.runOnce(), intervalMs);
  }

  /**
   * 停止定期衰减：清理定时器 + abort 进行中的 L2 评估 + 释放 storage。
   * 不等待 inflightEvaluate 完成（避免阻塞 close），需等待用 awaitInflight()。
   */
  stop(): void {
    if (this.decayTimer) {
      clearSafeInterval(this.decayTimer);
      this.decayTimer = null;
    }
    // abort 使 L2 LLM 调用快速失败
    if (this.evaluateAbortController) {
      this.evaluateAbortController.abort();
      this.evaluateAbortController = null;
    }
    this.storage = null;
  }

  /** 等待进行中的 L2 评估完成（Agent.close 在 stop 后调用），防 close 后 upsert 已关闭 storage */
  async awaitInflight(): Promise<void> {
    if (this.inflightEvaluate) {
      try {
        await this.inflightEvaluate;
      } catch {
        // abort 导致的 reject 是预期行为
      }
    }
  }

  /**
   * 执行一次记忆衰减：对 GOVERANCE_SOURCES 执行 score 衰减，委派 storage.decayScores()。
   * 长期未访问的记忆 score 逐渐降低，体现"自然遗忘"；不影响 persona/rule/skill。
   */
  runOnce(): void {
    if (!this.storage) return;
    // 治理源为空时短路：无对象可衰减，不发射事件/不记录 span/不累加指标（防空转链）
    if (this.sources.length === 0) {
      logger.debug('治理源为空，记忆衰减跳过');
      return;
    }
    const decaySpan = this.tracer.startSpan(TRACE_SPANS.DECAY);
    try {
      const decayedCount = this.storage.decayScores([...this.sources], new Date());
      logger.debug({ decayedCount }, '记忆衰减完成');

      this.metricDecayRunCount++;
      this.metricTotalDecayedCount += decayedCount;
      this.metricLastDecayAt = nowIso();
      decaySpan.setAttribute('decayedCount', decayedCount);
      decaySpan.setAttribute('totalRuns', this.metricDecayRunCount);

      this.onDecayCompleted({ decayedCount });
    } catch (err) {
      logger.warn({ err }, '记忆衰减异常，跳过本轮');
      decaySpan.recordException(toError(err));
    } finally {
      decaySpan.end();
    }
  }

  /** 获取衰减指标快照（供 Agent.getMetrics 合并） */
  getMetrics(): DecayMetrics {
    return {
      runCount: this.metricDecayRunCount,
      totalDecayedCount: this.metricTotalDecayedCount,
      lastRunAt: this.metricLastDecayAt,
    };
  }

  // ─── L2 时效性评估（可选，backgroundProvider + index 注入后启用） ───

  /**
   * 时效性评估：扫描低分记忆（score<0.3，上限 20 条），LLM 判断是否已过时，过时降级 score→0.05。
   * 安全设计：不物理删除（保留可恢复性，可读可恢复）；LLM 失败降级返回不阻塞；依赖未注入静默跳过。
   * 外部 signal 与内部 abort 叠加（AbortSignal.any），任一触发即取消；完成/abort 后清理引用。
   */
  async evaluateTimeliness(signal?: AbortSignal): Promise<TimelinessReport> {
    // 可选依赖未注入时静默降级
    if (!this.backgroundProvider || !this.index) {
      return {
        scannedCount: 0,
        outdatedCount: 0,
        demotedIds: [],
        skippedReason: 'backgroundProvider 或 index 未注入',
      };
    }

    // 每次评估创建新的 AbortController，stop() 可主动 abort
    this.evaluateAbortController = new AbortController();
    const internalSignal = this.evaluateAbortController.signal;
    // 外部与内部 signal 叠加，任一 abort 即触发
    const combinedSignal = signal
      ? AbortSignal.any([internalSignal, signal])
      : internalSignal;

    // 注册到 inflightEvaluate，供 awaitInflight() 等待
    const promise = this.doEvaluateTimeliness(combinedSignal);
    this.inflightEvaluate = promise;
    try {
      return await promise;
    } finally {
      // 评估完成（成功/失败/abort）后清理引用
      if (this.inflightEvaluate === promise) {
        this.inflightEvaluate = null;
      }
      if (this.evaluateAbortController?.signal === internalSignal) {
        this.evaluateAbortController = null;
      }
    }
  }

  /** 实际执行 L2 时效性评估：加载低分记忆 → 逐条 LLM 判断 → 过期者降级 */
  private async doEvaluateTimeliness(signal: AbortSignal): Promise<TimelinessReport> {
    // 加载低分记忆（score<阈值）
    const lowScoreMemories: Memory[] = [];
    for (const source of this.sources) {
      const memories = this.index!.getBySource(source);
      lowScoreMemories.push(...memories.filter((m) => m.score < TIMELINESS_LOW_SCORE_THRESHOLD));
    }

    if (lowScoreMemories.length === 0) {
      return {
        scannedCount: 0,
        outdatedCount: 0,
        demotedIds: [],
        skippedReason: '无低分记忆需评估',
      };
    }

    // 按 score 升序，最低分优先评估，取上限
    lowScoreMemories.sort((a, b) => a.score - b.score);
    const limited = lowScoreMemories.slice(0, TIMELINESS_EVALUATE_LIMIT);

    const demotedIds: string[] = [];
    let outdatedCount = 0;

    for (const memory of limited) {
      // abort 后提前退出，避免无谓 LLM 调用
      if (signal.aborted) break;
      try {
        const verdict = await this.judgeTimeliness(memory, signal);
        if (verdict.isOutdated) {
          this.demoteOutdatedMemory(memory);
          demotedIds.push(memory.id);
          outdatedCount++;
          logger.info(
            { memoryId: memory.id, reason: verdict.reason },
            '时效性评估：降级过时记忆',
          );
        }
      } catch (err) {
        // 单条 LLM 失败不阻塞后续（abort 失败也走此分支）
        logger.warn(
          { err, memoryId: memory.id },
          '时效性评估：LLM 判断失败，跳过此条',
        );
      }
    }

    return {
      scannedCount: limited.length,
      outdatedCount,
      demotedIds,
    };
  }

  /**
   * 调用 LLM 判断单条记忆时效性：结构化 JSON 输出（isOutdated+reason）。
   * 流式累积/解析/异常封装委托 llmJudgeHelper.judgeWithLlm；失败抛 MemoraError 由调用方捕获跳过。
   */
  private async judgeTimeliness(memory: Memory, signal?: AbortSignal): Promise<TimelinessVerdict> {
    const messages = buildTimelinessMessages(memory);
    const parsed = await judgeWithLlm<{ isOutdated?: boolean; reason?: string }>(
      this.backgroundProvider!,
      messages,
      { maxTokens: 200, timeoutMs: TIMELINESS_TIMEOUT_MS, signal },
      'LLM 时效性判断返回非法 JSON',
    );

    return {
      memoryId: memory.id,
      isOutdated: parsed.isOutdated === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '(LLM 未提供理由)',
    };
  }

  /**
   * 降级过时记忆（score → TIMELINESS_OUTDATED_SCORE）。不物理删除，仅降 score 保留可恢复性。
   * 用 setScore 原子操作而非整条 upsert，避免覆盖期间被 boost/decay 改动的字段。
   */
  private demoteOutdatedMemory(memory: Memory): void {
    this.index!.setScore(memory.id, TIMELINESS_OUTDATED_SCORE, nowIso());
  }
}

// ─── L2 时效性评估 Prompt 模板（模块级函数，与 buildDedupMessages 同模式） ───

/** 构建时效性判断的 LLM 消息：system 定义判断规则 + user 携带记忆内容/元数据，few-shot 降误判率 */
function buildTimelinessMessages(memory: Memory): Message[] {
  const content = memory.content.length > TIMELINESS_CONTENT_PREVIEW_LEN
    ? truncate(memory.content, TIMELINESS_CONTENT_PREVIEW_LEN, '…[截断]')
    : memory.content;

  return [
    {
      role: 'system',
      content: `你是记忆时效性评估助手。判断给定的记忆是否已过时（信息已失效或不再适用）。

判断规则：
- 已过时 = 信息明确失效（如旧版本号、已废弃的 API、已变更的偏好）
- 未过时 = 信息仍然有效（如通用编程原则、长期偏好、历史事件记录）
- 不确定时倾向"未过时"（避免误删有效记忆）

输出 JSON 格式：
{
  "isOutdated": true/false,
  "reason": "判断理由（简短说明）"
}

示例：
输入: "用户使用 React 16 进行开发"（createdAt: 2020-01-01）
输出: {"isOutdated": true, "reason": "React 16 已是旧版本，当前普遍使用 React 18+"}

输入: "用户偏好函数式编程风格"
输出: {"isOutdated": false, "reason": "编程风格偏好通常是长期的"}`,
    },
    {
      role: 'user',
      content: `请判断以下记忆是否已过时：

记忆详情：
- 名称：${memory.name}
- 来源：${memory.source}
- 当前 score：${memory.score}（低分，可能因长期未访问而衰减）
- 创建时间：${memory.createdAt}
- 内容：${content}

请输出 JSON 判断结果。`,
    },
  ];
}

/** decayScores 子接口（接口隔离）：本调度器只需衰减操作，便于测试 mock */
export interface IMemoryStorageLike {
  /** 对指定 source 的记忆执行 score 衰减，返回被衰减的条数 */
  decayScores(sources: readonly string[], now: Date): number;
}
