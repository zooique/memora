/**
 * 记忆衰减调度器（从 agent.ts 拆分）
 *
 * 职责：
 *   1. 定期执行记忆 score 衰减（体现"自然遗忘"）
 *   2. 衰减指标统计（执行次数 / 累计衰减记忆数 / 上次衰减时间）
 *   3. 衰减可观测性（Tracer Span 埋点）
 *   4. 衰减完成事件发射（decayCompleted）
 *   5. L2 时效性评估（可选，backgroundProvider + index 注入后启用）
 *
 * 设计理由：
 *   agent.ts 原承担 15+ 职责，记忆衰减是独立的生命周期职责，
 *   拆分后 Agent 聚焦对话编排，MemoryDecayScheduler 聚焦记忆自然遗忘。
 *
 * 衰减范围：
 *   - insight（洞察记忆）
 *   - profile（用户画像记忆）
 *   - work-projection（作品投影）
 *   不衰减 persona/rule/skill（配置型记忆不应衰减）
 *
 * L2 时效性评估（可选增强）：
 *   - 衰减后扫描低分记忆（score < TIMELINESS_LOW_SCORE_THRESHOLD）
 *   - 调用 LLM 判断是否"已过时"（如过时的技术栈、已变更的偏好）
 *   - 过时则进一步降级（score → TIMELINESS_OUTDATED_SCORE）
 *   - backgroundProvider / index 未注入时静默跳过（向后兼容）
 *
 * 自然生长原则：
 *   - 不持有 storage 引用（start 时注入，stop 时释放）
 *   - 通过回调发射事件（不继承 TypedEventEmitter，避免与 Agent 事件系统耦合）
 *   - 指标统计内聚（getMetrics 返回快照，Agent.getMetrics 直接合并）
 */

import { safeSetInterval, clearSafeInterval } from '@/utils/safeTimer.js';
import { logger } from '@/logging/logger.js';
import { toError } from '@/utils/errors.js';
import { nowIso } from '@/utils/time.js';
import { NOOP_TRACER, TRACE_SPANS, type ITracer } from '@/agent/tracer.js';
// L2 时效性评估：可选注入 backgroundProvider + 完整 IMemoryStorage
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
// LLM judge 三件套高阶函数（流式累积 + parseLlmJson + configError 异常封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
import { truncate } from '@/utils/strings.js';
// LLM 治理源列表（v2 REPEAT-1 闭环，消除 5 处独立维护的 [INSIGHT, PROFILE, WORK_PROJECTION] 列表）
import { GOVERNANCE_SOURCES } from '@/memory/governance.js';

/** 衰减完成的回调类型（Agent 注入 emit('decayCompleted', ...)） */
export type DecayCompletedCallback = (payload: { decayedCount: number }) => void;

/** MemoryDecayScheduler 构造选项 */
export interface MemoryDecaySchedulerOptions {
  /** 可观测性 Tracer（未注入时降级为 NOOP_TRACER） */
  readonly tracer?: ITracer;
  /** 衰减完成事件发射回调（Agent 注入 this.emit.bind(this, 'decayCompleted')） */
  readonly onDecayCompleted: DecayCompletedCallback;
  /** 后台 LLM Provider（可选，用于 L2 时效性评估，未注入时跳过） */
  readonly backgroundProvider?: LlmProvider | null;
  /** 完整记忆存储（可选，用于 L2 读取低分记忆和降级，未注入时跳过） */
  readonly index?: IMemoryStorage | null;
}

// ─── L2 时效性评估常量 ────────────────────────────────────
// 注：TIMELINESS_SOURCES 已统一为 GOVERNANCE_SOURCES（governance.ts），消除 5 处独立维护
/** 低分记忆阈值（score 低于此值的记忆进入 LLM 时效性评估） */
const TIMELINESS_LOW_SCORE_THRESHOLD = 0.3;
/** 单次时效性评估的记忆条数上限（控制 LLM 调用量） */
const TIMELINESS_EVALUATE_LIMIT = 20;
/** LLM 时效性判断超时（ms） */
const TIMELINESS_TIMEOUT_MS = 15_000;
/** 被判定为过时的记忆降级到此 score（接近物理删除阈值，但保留可恢复性） */
const TIMELINESS_OUTDATED_SCORE = 0.05;
/** 候选记忆内容预览长度（截断后送入 LLM） */
const TIMELINESS_CONTENT_PREVIEW_LEN = 200;

// ─── L2 时效性评估类型 ────────────────────────────────────

/** 单条记忆的时效性判断结果 */
export interface TimelinessVerdict {
  /** 记忆 ID */
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
  /** LLM 判定为过时并执行降级的记忆数 */
  outdatedCount: number;
  /** 被降级的记忆 ID 列表 */
  demotedIds: string[];
  /** 跳过原因（LLM 不可用 / 无低分记忆 / LLM 失败降级） */
  skippedReason?: string;
}

/** 衰减指标快照（供 Agent.getMetrics 合并） */
export interface DecayMetrics {
  /** 衰减执行次数（每次 runOnce 实际执行 +1） */
  readonly runCount: number;
  /** 累计衰减记忆数（score 被调低的记忆条数总和） */
  readonly totalDecayedCount: number;
  /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
  readonly lastRunAt: string | null;
}

/**
 * 记忆衰减调度器
 *
 * 使用方式：
 *   const scheduler = new MemoryDecayScheduler({ tracer, onDecayCompleted });
 *   scheduler.start(storage, intervalMs);  // 启动定时衰减
 *   scheduler.runOnce();                    // 立即执行一次衰减
 *   scheduler.stop();                       // 停止定时衰减
 *   scheduler.getMetrics();                 // 获取衰减指标快照
 */
export class MemoryDecayScheduler {
  /** 可观测性 Tracer（默认 NOOP，零开销） */
  private readonly tracer: ITracer;
  /** 衰减完成事件发射回调 */
  private readonly onDecayCompleted: DecayCompletedCallback;
  /** 后台 LLM Provider（可选，用于 L2 时效性评估，未注入时跳过） */
  private readonly backgroundProvider: LlmProvider | null;
  /** 完整记忆存储（可选，用于 L2 读取低分记忆和降级，未注入时跳过） */
  private readonly index: IMemoryStorage | null;

  /** 衰减定时器（null 表示未启动） */
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  /** 衰减目标存储（start 时注入，stop 时释放） */
  private storage: IMemoryStorageLike | null = null;
  /**
   * L2 时效性评估的 AbortController
   *
   * FIX-P0-1：stop() 时 abort，让正在进行的 evaluateTimeliness 尽快结束，
   * 防止 close 后 LLM 回调 upsert 已关闭的 storage。
   * 每次 evaluateTimeliness 启动时重置为新的 controller。
   */
  private evaluateAbortController: AbortController | null = null;
  /**
   * 当前正在进行的 evaluateTimeliness Promise（null 表示无）
   *
   * FIX-P0-1：close() 通过 awaitInflight() 等待此 Promise 完成，
   * 确保关闭时所有 L2 评估的 upsert 都落在 storage 关闭前。
   */
  private inflightEvaluate: Promise<TimelinessReport> | null = null;

  // ─── 衰减指标统计字段 ──────────────────────────────────
  /** 衰减执行次数（每次 runOnce 实际执行 +1） */
  private metricDecayRunCount: number = 0;
  /** 累计衰减记忆数（score 被调低的记忆条数总和） */
  private metricTotalDecayedCount: number = 0;
  /** 上次衰减时间（ISO 8601，null 表示从未执行过） */
  private metricLastDecayAt: string | null = null;

  constructor(opts: MemoryDecaySchedulerOptions) {
    this.tracer = opts.tracer ?? NOOP_TRACER;
    this.onDecayCompleted = opts.onDecayCompleted;
    // L2 可选依赖：未注入时 evaluateTimeliness 静默跳过
    this.backgroundProvider = opts.backgroundProvider ?? null;
    this.index = opts.index ?? null;
  }

  /**
   * 启动定期衰减
   *
   * @param storage 衰减目标存储（IMemoryStorage.decayScores）
   * @param intervalMs 衰减间隔（毫秒，通常为 1 小时）
   */
  start(storage: IMemoryStorageLike, intervalMs: number): void {
    this.storage = storage;
    // 立即执行一次首次衰减
    this.runOnce();
    // 注册定期衰减
    this.decayTimer = safeSetInterval(() => this.runOnce(), intervalMs);
  }

  /**
   * 停止定期衰减，释放资源
   *
   * FIX-P0-1：清理定时器 + abort 正在进行的 L2 时效性评估 + 释放 storage 引用，
   * 防止 close 后回调触发 upsert 已关闭的 storage。
   *
   * 注意：stop() 不等待 inflightEvaluate 完成（避免阻塞 close 流程），
   * 调用方如需等待应使用 awaitInflight()。abort 后 LLM 调用会快速失败，
   * evaluateTimeliness 内部的 try/catch 会捕获并降级返回。
   */
  stop(): void {
    if (this.decayTimer) {
      clearSafeInterval(this.decayTimer);
      this.decayTimer = null;
    }
    // FIX-P0-1：abort 正在进行的 L2 评估，让 LLM 调用快速失败
    if (this.evaluateAbortController) {
      this.evaluateAbortController.abort();
      this.evaluateAbortController = null;
    }
    this.storage = null;
  }

  /**
   * 等待正在进行的 L2 时效性评估完成
   *
   * FIX-P0-1：Agent.close() 在 stop() 后调用此方法，确保所有 inflight 的
   * evaluateTimeliness Promise 完成（要么正常返回，要么因 abort 快速 reject），
   * 防止 close 后 LLM 回调 upsert 已关闭的 storage。
   *
   * @returns 完成 Promise，无 inflight 时立即 resolve
   */
  async awaitInflight(): Promise<void> {
    if (this.inflightEvaluate) {
      try {
        await this.inflightEvaluate;
      } catch {
        // abort 导致的 reject 是预期行为，吞掉即可
      }
    }
  }

  /**
   * 执行一次记忆衰减
   *
   * 对 insight/profile/work-projection 记忆执行 score 衰减，
   * 长期未访问的记忆 score 逐渐降低，体现"自然遗忘"。
   * 不影响 persona/rule/skill（这些是配置型记忆，不应衰减）。
   *
   * 衰减逻辑委派给 IMemoryStorage.decayScores()，
   * 宿主（SqliteStorage）可用一条 SQL UPDATE 批量完成，避免 O(n) 全量加载。
   */
  runOnce(): void {
    if (!this.storage) return;
    // 衰减 Span：记录衰减执行过程，补全衰减可观测性缺口
    const decaySpan = this.tracer.startSpan(TRACE_SPANS.DECAY);
    try {
      // 治理源列表统一来自 governance.ts（v2 REPEAT-1 闭环）
      const decayedCount = this.storage.decayScores([...GOVERNANCE_SOURCES], new Date());
      logger.debug({ decayedCount }, '记忆衰减完成');

      // 衰减指标统计：累计执行次数和衰减记忆数
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

  /**
   * 获取衰减指标快照
   *
   * 供 Agent.getMetrics() 合并到完整 AgentMetrics 中。
   */
  getMetrics(): DecayMetrics {
    return {
      runCount: this.metricDecayRunCount,
      totalDecayedCount: this.metricTotalDecayedCount,
      lastRunAt: this.metricLastDecayAt,
    };
  }

  // ─── L2 时效性评估（可选，backgroundProvider + index 注入后启用） ───

  /**
   * 时效性评估：扫描低分记忆，调用 LLM 判断是否已过时
   *
   * 流程：
   *   1. 从 insight/profile/work-projection 加载低分记忆（score < 0.3）
   *   2. 对每条低分记忆（上限 20 条），调用 LLM 判断是否"已过时"
   *   3. 过时则进一步降级（score → 0.05，接近物理删除阈值但保留可恢复性）
   *   4. 返回评估报告
   *
   * 使用场景：
   *   - 衰减后调用（onDecayCompleted 回调中），对低分记忆做 LLM 二次评估
   *   - 宿主定时任务定期调用（如每天一次）
   *   - 用户手动触发（记忆管理面板的"清理过时记忆"按钮）
   *
   * 安全设计：
   *   - 不物理删除——仅降级 score，保留可恢复性
   *   - LLM 失败降级——返回已处理的报告，不阻塞调用方
   *   - 单条 LLM 失败不阻塞后续评估
   *   - backgroundProvider / index 未注入时静默跳过（向后兼容）
   *
   * FIX-P0-1：每次启动评估创建新的 AbortController，注册到 inflightEvaluate。
   * stop() 时 abort 让 LLM 调用快速失败，awaitInflight() 等待 Promise 完成。
   * 外部 signal 仍可与内部 abort 信号同时使用（任一触发即取消）。
   *
   * @param signal 可选的外部 AbortSignal（与内部 abort 信号叠加，任一触发即取消）
   * @returns 评估报告
   */
  async evaluateTimeliness(signal?: AbortSignal): Promise<TimelinessReport> {
    // 可选依赖未注入时静默降级（向后兼容）
    if (!this.backgroundProvider || !this.index) {
      return {
        scannedCount: 0,
        outdatedCount: 0,
        demotedIds: [],
        skippedReason: 'backgroundProvider 或 index 未注入',
      };
    }

    // FIX-P0-1：每次评估创建新的 AbortController，stop() 可主动 abort
    this.evaluateAbortController = new AbortController();
    const internalSignal = this.evaluateAbortController.signal;
    // 外部 signal 与内部 signal 叠加：任一 abort 即触发
    // 使用 AbortSignal.any 需 Node 18+，兼容方案是手动转发
    const combinedSignal = signal
      ? AbortSignal.any([internalSignal, signal])
      : internalSignal;

    // 注册到 inflightEvaluate，让 awaitInflight() 可等待
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

  /**
   * 实际执行 L2 时效性评估的核心逻辑
   *
   * 从 evaluateTimeliness 拆出，便于 inflightEvaluate Promise 注册和清理。
   *
   * @param combinedSignal 已叠加内部 + 外部的 AbortSignal
   */
  private async doEvaluateTimeliness(signal: AbortSignal): Promise<TimelinessReport> {
    // ── 步骤 1：加载低分记忆 ──
    const lowScoreMemories: Memory[] = [];
    for (const source of GOVERNANCE_SOURCES) {
      const memories = this.index!.getBySource(source);
      // 筛选低分记忆（score 低于阈值）
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

    // 按 score 升序排列（最低分优先评估），取前 20 条
    lowScoreMemories.sort((a, b) => a.score - b.score);
    const limited = lowScoreMemories.slice(0, TIMELINESS_EVALUATE_LIMIT);

    // ── 步骤 2：逐条调用 LLM 判断时效性 ──
    const demotedIds: string[] = [];
    let outdatedCount = 0;

    for (const memory of limited) {
      // abort 后提前退出循环，避免无谓的 LLM 调用
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
        // 单条 LLM 判断失败不阻塞后续评估（abort 导致的失败也走此分支）
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
   * 调用 LLM 判断单条记忆的时效性
   *
   * 使用结构化 JSON 输出（isOutdated + reason），
   * 流式累积 + parseLlmJson + 异常封装委托给 llmJudgeHelper.judgeWithLlm。
   *
   * LLM 失败时抛出 MemoraError（由 evaluateTimeliness 捕获并降级跳过此条）。
   *
   * @param memory 待评估的记忆
   * @param signal 可选的 AbortSignal
   * @returns LLM 判断结果
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
   * 降级过时记忆（score → TIMELINESS_OUTDATED_SCORE）
   *
   * 安全设计：
   *   - 不物理删除，仅降低 score，保留可恢复性
   *   - 更新 accessedAt，标记最近被处理过
   *
   * @param memory 待降级的过时记忆
   */
  private demoteOutdatedMemory(memory: Memory): void {
    // MIND2-L3：改用 setScore 原子操作，消除 spread 旧快照覆盖其他字段
    // 原模式 spread 旧快照后整条 upsert，会覆盖期间被 boost/decay 改的 content 等字段
    this.index!.setScore(memory.id, TIMELINESS_OUTDATED_SCORE, nowIso());
  }
}

// ─── L2 时效性评估 Prompt 模板（模块级函数，与 buildDedupMessages 同模式） ───

/**
 * 构建时效性判断的 LLM 消息
 *
 * 设计要点：
 *   - system 消息定义判断规则（过时 = 信息已失效/不再适用）
 *   - user 消息携带记忆内容和元数据（source/score/createdAt）
 *   - 要求输出结构化 JSON（isOutdated + reason）
 *   - few-shot 示例降低 LLM 误判率
 *
 * @param memory 待评估的记忆
 * @returns system + user 消息数组
 */
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

/**
 * IMemoryStorage 的衰减子接口（接口隔离原则）
 *
 * MemoryDecayScheduler 只需要 decayScores 方法，不需要完整 IMemoryStorage。
 * 使用结构子接口便于测试 mock，同时避免对完整接口的过度耦合。
 */
export interface IMemoryStorageLike {
  /** 对指定 source 的记忆执行 score 衰减，返回被衰减的记忆条数 */
  decayScores(sources: readonly string[], now: Date): number;
}
