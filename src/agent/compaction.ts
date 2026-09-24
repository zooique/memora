/**
 * 上下文压缩策略接口与实现
 *
 * 对应大厂"微压缩层"设计（如 Claude Code MicroCompact、LangChain Deep Agents Offloading）：
 * 在每轮对话前静默执行，将旧的 tool_result 替换为占位符/摘要，回收上下文空间。
 *
 * 边界：超大工具结果不在本层卸载——在**入口关**（AgentLoop.appendToolMessage）落盘，
 * 原语见 src/agent/toolResultOffload.ts。
 */

import type { Message } from '@/llm/provider.js';
// 软上限摘要 marker（生成侧与检测侧共用同一文本源）
import { SOFT_LIMIT_SUMMARY_MARKER_ROUND } from '@/agent/contextManager.js';

/**
 * 压缩策略接口（可插拔）
 */
export interface ICompactionStrategy {
  /** 判断是否需要压缩 */
  shouldCompact(messages: readonly Message[]): boolean;

  /** 执行压缩，返回新的消息数组（或原地修改），支持异步（如文件 IO） */
  compact(messages: Message[]): Promise<void> | void;
}

/**
 * 结果替换策略
 *
 * 将旧 tool_result 替换为 "[Previous: used {tool_name}]" 占位符，
 * 仅保留最近 N 次完整结果，兼顾语义与压缩率。
 */
export class ResultReplacementStrategy implements ICompactionStrategy {
  private readonly keepRecent: number;
  /** 摘要替代回调：给定 read_file 的 path，返回应写入占位的台账摘要；无摘要返回 undefined → 回退空占位。
   *  由 loop 装配注入（取 `FileExposureLedger` 的覆盖度摘要），压缩时把 read_file 结果换成它**自己的**摘要，
   *  而非空 `[Previous: used read_file]`（摘要替代，非空占位；摘要只产一次、三处同源）。 */
  private readonly readFileReplacement?: (path: string) => string | undefined;

  /**
   * @param keepRecent 保留最近多少次工具调用的完整结果（默认 3）
   * @param readFileReplacement read_file 结果的替代处理器（可选；返回 vacuous 时回退空占位）
   */
  constructor(keepRecent: number = 3, readFileReplacement?: (path: string) => string | undefined) {
    this.keepRecent = keepRecent;
    this.readFileReplacement = readFileReplacement;
  }

  /** @inheritdoc */
  shouldCompact(messages: readonly Message[]): boolean {
    const toolResultCount = messages.filter((m) => m.role === 'tool').length;
    return toolResultCount > this.keepRecent;
  }

  /**
   * 执行压缩：将旧的 tool_result 替换为占位符
   *
   * 算法：
   * 1. 收集所有 tool 角色的消息（即 tool_result）
   * 2. 构建 tool_use_id -> tool_name 映射（从 assistant 消息中的 toolCalls）
   * 3. 将除最近 N 个外的所有 tool_result 替换为 "[Previous: used {tool_name}]"
   */
  compact(messages: Message[]): void {
    // 1. 收集所有工具结果消息（role === 'tool'）
    const toolResults: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        toolResults.push(msg);
      }
    }

    // 如果工具结果数量 <= 保留阈值，无需压缩
    if (toolResults.length <= this.keepRecent) {
      return;
    }

    // 2. 构建工具调用 ID -> 工具名称 / 参数的映射
    //    从 assistant 消息中的 toolCalls 提取（参数用于定位 read_file 的 path 以取台账摘要）
    const toolNameMap = new Map<string, string>();
    const toolArgsMap = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolNameMap.set(tc.id, tc.function.name);
          toolArgsMap.set(tc.id, tc.function.arguments);
        }
      }
    }

    // 3. 确定需要替换的工具结果（除了最近 N 个）
    const toReplace = toolResults.slice(0, -this.keepRecent);

    // 4. 执行替换
    for (const resultMsg of toReplace) {
      const toolName = toolNameMap.get(resultMsg.toolCallId!) ?? 'unknown';
      // 摘要替代：read_file 且能定位 path 且台账有摘要 → 用摘要（非空占位）；否则回退 [Previous: used x]
      let replacement: string | undefined;
      if (toolName === 'read_file' && this.readFileReplacement) {
        const path = readFilePathFromArgs(toolArgsMap.get(resultMsg.toolCallId!));
        if (path) replacement = this.readFileReplacement(path);
      }
      // 关键：保留工具名以维持语义连贯性，替换完整内容
      resultMsg.content = replacement ?? `[Previous: used ${toolName}]`;
    }
  }
}

/** 从 read_file 工具调用参数里提取 path（供摘要替代定位台账摘要）；非 JSON / 无 path → undefined */
function readFilePathFromArgs(argsJson: string | undefined): string | undefined {
  if (argsJson === undefined) return undefined;
  try {
    const a = JSON.parse(argsJson) as { path?: unknown };
    return typeof a?.path === 'string' && a.path.trim() !== '' ? a.path : undefined;
  } catch {
    return undefined;
  }
}

/** 替换式压缩策略默认保留最近正文轮数（LRU：超出则最早先换） */
export const DEFAULT_REPLACE_KEEP_RECENT_ROUNDS = 5;

/**
 * 替换式压缩策略（第一级 · 内核自动 LRU）
 *
 * 空间不足时，把完整对话层中越界轮次的正文**替换成它自己的已存记忆摘要**（从库取现成，
 * 零生成成本）。按 LRU（最早先换）；被替换轮 roundId 计入装配 exclude（装配时间线互斥，
 * 绝不双写）。替换是机械搬移，无需 LLM，**不暴露为 LLM 工具**。
 *
 * 作用对象：已沉淀记忆摘要的问答闭环；无摘要的轮次由第二级压缩（LLM 触发）兜底。
 */
export class ReplaceRoundsStrategy implements ICompactionStrategy {
  private readonly keepRecentRounds: number;
  /** 取该轮 roundId 对应的已存 round-summary（无摘要返回 null，该轮不替换） */
  private readonly getSummary: (roundId: string) => string | null;
  /** 上下文是否刚被截断重排（截断会提取 key messages 重插中间，此处跳过替换，交截断机制兜底） */
  private readonly isContextTruncated: () => boolean;

  /**
   * @param options keepRecentRounds 保留最近正文轮数 / getSummary 按 roundId 取摘要 /
   *   onReplaced 被替换轮的 roundId 回调（供装配 exclude 记账，防二次召回）/
   *   isContextTruncated 上下文是否被截断重排（截断会提取 key messages 重插中间，跳过替换）
   *
   * 轮次 roundId 不再依赖外部序列的「尾部对齐」——各消息在 loop 写入时已自带 roundId
   * （见 Message.roundId），groupRounds 直接从每轮 user 消息读取，单一真理源、无错位风险。
   */
  constructor(options: {
    keepRecentRounds: number;
    getSummary: (roundId: string) => string | null;
    onReplaced?: (roundId: string) => void;
    isContextTruncated?: () => boolean;
  }) {
    this.keepRecentRounds = options.keepRecentRounds;
    this.getSummary = options.getSummary;
    this.onReplaced = options.onReplaced;
    this.isContextTruncated = options.isContextTruncated ?? (() => false);
  }

  /** 被替换轮 roundId 回调（装配时间线互斥：该轮摘要已随替换注入上下文，下次装配须 exclude 防双写） */
  private readonly onReplaced?: (roundId: string) => void;

  /** 按 user 消息边界分组为轮次；直接从每轮 user 消息读取自带 roundId（无外部序列、无尾部对齐） */
  private groupRounds(
    messages: readonly Message[],
  ): Array<{ start: number; end: number; roundId?: string }> {
    const rounds: Array<{ start: number; end: number; roundId?: string }> = [];
    let start = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user') {
        if (start !== -1) {
          rounds.push({ start, end: i - 1, roundId: messages[start]?.roundId });
        }
        start = i;
      }
    }
    if (start !== -1) {
      rounds.push({ start, end: messages.length - 1, roundId: messages[start]?.roundId });
    }
    return rounds;
  }

  /** @inheritdoc 上下文未被截断重排且存在越界轮次（超出保留轮数）时需替换 */
  shouldCompact(messages: readonly Message[]): boolean {
    // 截断会提取 key messages 重插中间，作用于裁剪后视图风险较高——
    // 此时跳过替换（错位替换正文比不替换危害更大），空间维护交回截断机制的摘要注入
    if (this.isContextTruncated()) return false;
    return this.groupRounds(messages).length > this.keepRecentRounds;
  }

  /**
   * 执行替换：最早先换（LRU），把越界轮次正文替换成它自己的已存记忆摘要。
   * 轮次 roundId 直接取自该轮 user 消息自带字段（Message.roundId），不再依赖尾部对齐序列；
   * 从后往前替换，避免索引位移。无摘要 / 无 roundId 的轮次保持不动（交第二级压缩）。
   */
  compact(messages: Message[]): void {
    // 双保险：截断重排后视图不稳定 → 即使被直接调用也不替换（空间维护交回截断机制）
    if (this.isContextTruncated()) return;
    const rounds = this.groupRounds(messages);
    // 越界轮次：保留最近 keepRecentRounds 轮，其余为可替换区（LRU 最早先换）
    const replaceableCount = Math.max(0, rounds.length - this.keepRecentRounds);
    if (replaceableCount === 0) return;

    const replaceable = rounds.slice(0, replaceableCount);

    // 从后往前替换，保证早于它的轮次索引不受位移影响
    for (let k = replaceable.length - 1; k >= 0; k--) {
      const round = replaceable[k]!;
      const roundId = round.roundId;
      if (!roundId) continue; // 该轮消息未携带 roundId（异常态）→ 跳过，交第二级压缩
      const summary = this.getSummary(roundId);
      if (!summary) continue; // 无已存摘要 → 该轮不替换（交第二级压缩）

      // 整轮正文替换为一条摘要 system 消息（roundId 经 onReplaced 上报供 trace_summary 回溯）
      const replacement: Message = {
        role: 'system',
        content:
          `[${SOFT_LIMIT_SUMMARY_MARKER_ROUND} ${roundId}]\n${summary}\n` +
          `（该轮正文已替换为记忆摘要，细节可经 trace_summary 回溯原始对话）`,
      };
      messages.splice(round.start, round.end - round.start + 1, replacement);
      // 记账被替换轮 roundId（装配时间线互斥：下次装配 exclude 防其摘要被二次召回）
      this.onReplaced?.(roundId);
    }
  }
}
