/**
 * 语义去重管理器 — L1 记忆治理子系统
 *
 * 从 MemoryInspector 拆分出来，专责异步 LLM 语义去重。
 * 与 MemoryInspector 的分工：
 *   - MemoryInspector：同步读写入口（snapshot/search/stats/writeXxx/relations）
 *   - DedupManager：异步 LLM 治理（deduplicateMemories）
 *
 * 拆分理由（SPLIT-3，2026-07-21）：
 *   - 职责分离——同步读写 vs 异步 LLM 治理是两个独立关注点
 *   - 依赖清晰——MemoryInspector 不再依赖 LLM Provider，纯存储读写
 *   - 可测试性——去重逻辑独立测试，无需 mock loop/history/advisor
 *   - 自包含——去重逻辑（配对 + LLM 判断 + 降级 + prompt）形成自闭合子系统
 *
 * 设计原则：
 *   - 静默降级——backgroundProvider 未注入时返回 skippedReason 报告，不抛错
 *   - 不物理删除——仅降级 score（→ 0.1），保留可恢复性
 *   - 异步执行——不阻塞主对话热路径（由宿主定时任务或用户手动触发）
 *
 * @module agent/managers/dedupManager
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
// LLM 语义去重（L1）：backgroundProvider 注入 + 流式累积，参照 TextPolishManager 模式
import type { LlmProvider, Message } from '@/llm/provider.js';
// LLM judge 三件套高阶函数（流式累积 + parseLlmJson + configError 异常封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
// LLM 治理共享常量（v2 REPEAT-1/2 闭环，消除 5 处独立维护的治理源列表 + 2 处 score 常量重复）
import { GOVERNANCE_SOURCES } from '@/memory/governance.js';
// levenshtein 用于名称相似度计算（复用 sourceValidation 中的实现，避免重复造轮子）
import { levenshtein } from '@/memory/sourceValidation.js';
// 按 score 降序排序（与 MemoryInspector 共享，避免重复造轮子）
import { byScoreDesc } from '@/utils/array.js';
// 时间戳生成（降级时更新 accessedAt）
import { nowIso } from '@/utils/time.js';
// 内容截断（送入 LLM 前控制 token 消耗）
import { truncate } from '@/utils/strings.js';
// 日志（治理审计 + 失败降级记录）
import { logger } from '@/logging/logger.js';

// ─── L1 语义去重常量 ────────────────────────────────────
/** 单次去重扫描的候选记忆条数上限（控制内存和 LLM 调用量） */
const DEDUP_CANDIDATE_LIMIT = 50;
/** 单次 LLM 判断的候选对数上限（每对约 200 tokens，10 对 ≈ 2000 tokens） */
const DEDUP_PAIR_LIMIT = 10;
/** 名称相似度阈值（归一化 Levenshtein 距离 ≤ 此值视为名称高度相似，进入 LLM 判断） */
const DEDUP_NAME_SIMILARITY_THRESHOLD = 0.3;
/** LLM 去重判断超时（ms），与 TextPolishManager 一致 */
const DEDUP_TIMEOUT_MS = 15_000;
/** 被判定为重复的记忆降级到此 score（接近 0 但保留可恢复性，不物理删除） */
const DEDUP_LOW_SCORE = 0.1;
/** 候选记忆内容预览长度（截断后送入 LLM，控制 token 消耗） */
const DEDUP_CONTENT_PREVIEW_LEN = 200;

// ─── L1 语义去重类型 ────────────────────────────────────

/** 名称高度相似的候选记忆对（待 LLM 判断语义等价性） */
export interface DedupPair {
  /** 记忆 A（score 较高，作为保留候选） */
  a: Memory;
  /** 记忆 B（score 较低，作为降级候选） */
  b: Memory;
  /** 名称归一化相似度（0-1，越小越相似） */
  nameSimilarity: number;
}

/** LLM 对单对记忆的语义等价判断结果 */
export interface DedupVerdict {
  /** 是否语义等价（true → 降级低分记忆） */
  isDuplicate: boolean;
  /** 合并后的内容（isDuplicate=true 时提供，保留更完整的信息） */
  mergedContent?: string;
  /** LLM 判断理由（便于审计和调试） */
  reason: string;
}

/** 降级记忆的审计详情（DedupReport.verdicts 元素，供 UI 展示"为什么降级"） */
export interface DedupVerdictSummary {
  /** 被降级的记忆 ID（与 demotedIds 元素一一对应） */
  demotedId: string;
  /** LLM 判断理由（便于用户审计降级是否合理） */
  reason: string;
  /** 合并后的完整内容（便于用户验证合并质量；未提供 mergedContent 时省略，渲染器负责截断展示） */
  mergedContent?: string;
}

/** 语义去重报告（deduplicateMemories 返回值） */
export interface DedupReport {
  /** 扫描的候选记忆总数 */
  scannedCount: number;
  /** 发现的名称相似对数 */
  pairCount: number;
  /** LLM 判定为语义等价并执行降级的对数 */
  deduplicatedCount: number;
  /** 被降级的记忆 ID 列表（score 降至 DEDUP_LOW_SCORE，未物理删除） */
  demotedIds: string[];
  /** 降级审计详情（与 demotedIds 一一对应，供 UI 展示 reason + mergedContentPreview） */
  verdicts?: DedupVerdictSummary[];
  /** 跳过原因（LLM 不可用 / 无候选对 / LLM 失败降级） */
  skippedReason?: string;
}

// ─── 类 ──────────────────────────────────────────────────

/**
 * 语义去重管理器
 *
 * 扫描名称高度相似的记忆对，调用 LLM 判断语义等价性，降级低分记忆。
 *
 * 装配：由 assembler.ts 在组合根创建，backgroundProvider 可选注入。
 * 调用：Agent.deduplicateMemories() 透传至本类。
 */
export class DedupManager {
  /** 后台 LLM Provider（可选，用于语义去重等异步治理任务，未注入时降级跳过） */
  private readonly backgroundProvider: LlmProvider | null;

  /**
   * @param index - 记忆存储（用于读写候选记忆）
   * @param backgroundProvider - 后台 LLM Provider（可选，用于语义去重，未注入时降级跳过）
   */
  constructor(
    private readonly index: IMemoryStorage,
    backgroundProvider: LlmProvider | null = null,
    /** 去重完成回调（宿主可据此发射事件通知用户） */
    private readonly onCompleted?: (report: DedupReport) => void,
  ) {
    this.backgroundProvider = backgroundProvider;
  }

  /**
   * 语义去重：扫描名称高度相似的记忆对，调用 LLM 判断语义等价性
   *
   * 流程：
   *   1. 从 profile/work-projection 加载候选记忆（上限 50 条）
   *   2. 按名称归一化 Levenshtein 距离筛选相似对（上限 10 对）
   *   3. 对每对调用 LLM 判断语义等价性（结构化 JSON 输出）
   *   4. 等价则降级低分记忆（score → 0.1，不物理删除，保留可恢复性）
   *   5. 返回去重报告
   *
   * 安全设计：
   *   - 不物理删除——仅降级 score，用户可通过宿主 UI 手动恢复
   *   - LLM 失败降级——返回已处理的报告，不阻塞调用方
   *   - 异步执行——不阻塞主对话热路径（由宿主定时任务或用户手动触发）
   *   - backgroundProvider 未注入时静默跳过（返回 skippedReason）
   *
   * @param signal 可选的 AbortSignal（取消正在进行的 LLM 判断）
   * @returns 去重报告
   */
  async deduplicateMemories(signal?: AbortSignal): Promise<DedupReport> {
    // backgroundProvider 未注入时静默降级（向后兼容）
    if (!this.backgroundProvider) {
      return {
        scannedCount: 0,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: 'backgroundProvider 未注入',
      };
    }

    // ── 步骤 1：加载候选记忆（按 score 降序，取前 50 条） ──
    const candidates: Memory[] = [];
    for (const source of GOVERNANCE_SOURCES) {
      const memories = this.index.getBySource(source);
      candidates.push(...memories);
    }
    // 按 score 降序排列，优先处理高分记忆（更可能产生重复）
    candidates.sort(byScoreDesc);
    const limited = candidates.slice(0, DEDUP_CANDIDATE_LIMIT);

    // ── 步骤 2：筛选名称高度相似的记忆对 ──
    const pairs = this.findNameOverlapPairs(limited);
    if (pairs.length === 0) {
      return {
        scannedCount: limited.length,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: '未发现名称相似的记忆对',
      };
    }

    // ── 步骤 3：逐对调用 LLM 判断语义等价性 ──
    const demotedIds: string[] = [];
    const verdicts: DedupVerdictSummary[] = [];
    let deduplicatedCount = 0;

    for (const pair of pairs) {
      try {
        const verdict = await this.judgeDuplicate(pair, signal);
        if (verdict.isDuplicate) {
          // 先写合并内容再降级 b：确保合并写入失败时不破坏 b 的原始状态（原子性）
          if (verdict.mergedContent) {
            this.keepMerged(pair.a, verdict.mergedContent);
          }
          // 降级低分记忆（b 的 score ≤ a 的 score，因 candidates 已按 score 降序）
          this.demoteMemory(pair.b);
          demotedIds.push(pair.b.id);
          // 收集审计详情（供 UI 展示"为什么降级"和"合并后保留了什么"）
          verdicts.push({
            demotedId: pair.b.id,
            reason: verdict.reason,
            mergedContent: verdict.mergedContent,
          });
          deduplicatedCount++;
          logger.info(
            { demotedId: pair.b.id, keptId: pair.a.id, reason: verdict.reason },
            '语义去重：降级重复记忆并合并内容到保留方',
          );
        }
      } catch (err) {
        // 单对 LLM 判断失败不阻塞后续对，记录警告继续
        logger.warn(
          { err, pairId: `${pair.a.id}↔${pair.b.id}` },
          '语义去重：LLM 判断失败，跳过此对',
        );
      }
    }

    this.onCompleted?.({ scannedCount: limited.length, pairCount: pairs.length, deduplicatedCount, demotedIds });
    return {
      scannedCount: limited.length,
      pairCount: pairs.length,
      deduplicatedCount,
      demotedIds,
      verdicts,
    };
  }

  /**
   * 筛选名称高度相似的候选记忆对
   *
   * 判定规则（满足任一即视为名称相似）：
   *   1. 归一化 Levenshtein 距离 ≤ 0.3（如 "用户偏好" vs "用户偏爱"）
   *   2. 一个名称包含另一个（如 "用户偏好" vs "用户偏好设置"）
   *
   * 去重设计：
   *   - 已配对的记忆不再参与后续配对（避免 A-B-C 三元组产生 A-B + A-C + B-C 三对）
   *   - 候选对按相似度升序排列（越相似越优先），取前 10 对
   *
   * @param candidates 候选记忆列表（已按 score 降序）
   * @returns 名称相似的记忆对列表（a.score ≥ b.score）
   */
  private findNameOverlapPairs(candidates: Memory[]): DedupPair[] {
    const pairs: DedupPair[] = [];
    const usedIds = new Set<string>();

    // 双重循环生成所有可能的对，按相似度排序后贪心选取
    const allPairs: Array<{ a: Memory; b: Memory; nameSimilarity: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!; // i 循环内，score 较高
        const b = candidates[j]!; // j > i，score 较低或相等
        const similarity = DedupManager.computeNameSimilarity(a.name, b.name);
        if (similarity <= DEDUP_NAME_SIMILARITY_THRESHOLD) {
          allPairs.push({ a, b, nameSimilarity: similarity });
        }
      }
    }

    // 按相似度升序排列（越相似越优先处理）
    allPairs.sort((x, y) => x.nameSimilarity - y.nameSimilarity);

    // 贪心选取：已配对的记忆不再参与后续配对
    for (const { a, b, nameSimilarity } of allPairs) {
      if (usedIds.has(a.id) || usedIds.has(b.id)) continue;
      pairs.push({ a, b, nameSimilarity });
      usedIds.add(a.id);
      usedIds.add(b.id);
      if (pairs.length >= DEDUP_PAIR_LIMIT) break;
    }

    return pairs;
  }

  /**
   * 计算两个名称的归一化相似度（0-1，越小越相似）
   *
   * 综合两种规则取较小值：
   *   1. 归一化 Levenshtein 距离 = distance / max(len_a, len_b)
   *   2. 包含关系：若一个名称包含另一个，相似度 = 0（完全相似）
   *
   * @param nameA 名称 A
   * @param nameB 名称 B
   * @returns 相似度（0=完全相似，1=完全不同）
   */
  private static computeNameSimilarity(nameA: string, nameB: string): number {
    // 边界条件：空字符串防御
    // 空名称会导致 includes("") 恒为 true 返回 0（完全相似），
    // 让空名称记忆与所有记忆被判高度相似，浪费 LLM 调用并可能误降级。
    // 此处前置拒绝，空名称与任何名称都视为完全不同（1.0）。
    if (!nameA || !nameB) {
      return 1;
    }

    // 规则 2：包含关系（如 "用户偏好" vs "用户偏好设置"）
    if (nameA.includes(nameB) || nameB.includes(nameA)) {
      return 0;
    }

    // 规则 1：归一化 Levenshtein 距离
    const maxLen = Math.max(nameA.length, nameB.length);
    if (maxLen === 0) return 0; // 两个空字符串视为完全相似（已被上面拦截，此处防御）
    const distance = levenshtein(nameA, nameB);
    return distance / maxLen;
  }

  /**
   * 调用 LLM 判断单对记忆的语义等价性
   *
   * 使用结构化 JSON 输出（isDuplicate + mergedContent + reason），
   * 流式累积 + parseLlmJson + 异常封装委托给 llmJudgeHelper.judgeWithLlm。
   *
   * LLM 失败时抛出 MemoraError（由 deduplicateMemories 捕获并降级跳过此对）。
   *
   * @param pair 候选记忆对
   * @param signal 可选的 AbortSignal
   * @returns LLM 判断结果
   */
  private async judgeDuplicate(pair: DedupPair, signal?: AbortSignal): Promise<DedupVerdict> {
    const messages = buildDedupMessages(pair);
    const parsed = await judgeWithLlm<{
      isDuplicate?: boolean;
      mergedContent?: string;
      reason?: string;
    }>(
      this.backgroundProvider!,
      messages,
      { maxTokens: 300, timeoutMs: DEDUP_TIMEOUT_MS, signal },
      'LLM 去重判断返回非法 JSON',
    );

    return {
      isDuplicate: parsed.isDuplicate === true,
      mergedContent: typeof parsed.mergedContent === 'string' ? parsed.mergedContent : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '(LLM 未提供理由)',
    };
  }

  /**
   * 降级重复记忆（score → DEDUP_LOW_SCORE）
   *
   * 安全设计：
   *   - 不物理删除，仅降低 score，保留可恢复性
   *   - 合并内容由 keepMerged() 单独写回保留方 a（职责清晰：本方法只降级低分方）
   *
   * @param memory 待降级的记忆（低分方）
   */
  private demoteMemory(memory: Memory): void {
    // MIND2-L3：改用 setScore 原子操作，消除 spread 旧快照覆盖其他字段的隐性 bug
    // 原模式用 candidates 旧快照 spread 后整条 upsert，会覆盖期间被 boost/decay 改的 content 等字段
    this.index.setScore(memory.id, DEDUP_LOW_SCORE, nowIso());
  }

  /**
   * 将合并内容写回保留方（高分记忆 a）
   *
   * 保持 a 的 id/source/name/score/createdAt 不变，仅更新 content 为合并后内容并刷新
   * accessedAt，使"两条重复记忆合并为一条更完整记忆"的语义真正落库（M6 修复）。
   *
   * @param memory 保留方记忆（高分方）
   * @param mergedContent LLM 生成的合并后完整内容
   */
  private keepMerged(memory: Memory, mergedContent: string): void {
    const updated: Memory = {
      ...memory,
      content: mergedContent,
      accessedAt: nowIso(),
    };
    this.index.upsert(updated);
    logger.info({ keptId: memory.id }, '语义去重：保留方已合并对方内容');
  }
}

// ─── L1 语义去重 Prompt 模板（模块级函数，与 TextPolishManager.buildPolishMessages 同模式） ───

/**
 * 构建语义去重判断的 LLM 消息
 *
 * 设计要点：
 *   - system 消息定义判断规则（语义等价 = 表达同一事实/偏好/洞察）
 *   - user 消息携带候选对的内容预览（截断到 200 字符）
 *   - 要求输出结构化 JSON（isDuplicate + mergedContent + reason）
 *   - few-shot 示例降低 LLM 误判率
 *
 * @param pair 候选记忆对
 * @returns system + user 消息数组
 */
function buildDedupMessages(pair: DedupPair): Message[] {
  const contentA = pair.a.content.length > DEDUP_CONTENT_PREVIEW_LEN
    ? truncate(pair.a.content, DEDUP_CONTENT_PREVIEW_LEN, '…[截断]')
    : pair.a.content;
  const contentB = pair.b.content.length > DEDUP_CONTENT_PREVIEW_LEN
    ? truncate(pair.b.content, DEDUP_CONTENT_PREVIEW_LEN, '…[截断]')
    : pair.b.content;

  return [
    {
      role: 'system',
      content: `你是记忆去重助手。判断给定的两条记忆是否语义等价（表达同一事实/偏好/洞察）。

判断规则：
- 语义等价 = 核心信息相同，仅措辞/格式/细节程度不同
- 语义不等价 = 核心信息不同，或一条是另一条的补充/细化（非等价）
- 忽略时间戳、ID 等元数据差异
- 忽略措辞风格差异（如"喜欢"vs"偏爱"）

输出 JSON 格式：
{
  "isDuplicate": true/false,
  "mergedContent": "合并后的内容（仅 isDuplicate=true 时提供，保留两条记忆的完整信息）",
  "reason": "判断理由（简短说明）"
}

示例：
输入 A: "用户偏好简洁的 UI 设计"
输入 B: "用户喜欢简洁的界面风格"
输出: {"isDuplicate": true, "mergedContent": "用户偏好简洁的 UI/界面设计风格", "reason": "核心偏好相同，仅措辞差异"}

输入 A: "用户是 TypeScript 开发者"
输入 B: "用户偏好使用 TypeScript 进行后端开发"
输出: {"isDuplicate": false, "reason": "B 是 A 的细化（限定后端），非语义等价"}`,
    },
    {
      role: 'user',
      content: `请判断以下两条记忆是否语义等价：

记忆 A（score: ${pair.a.score}，保留候选）：
- 名称：${pair.a.name}
- 来源：${pair.a.source}
- 内容：${contentA}

记忆 B（score: ${pair.b.score}，降级候选）：
- 名称：${pair.b.name}
- 来源：${pair.b.source}
- 内容：${contentB}

名称相似度：${pair.nameSimilarity.toFixed(2)}（0=完全相同，1=完全不同）

请输出 JSON 判断结果。`,
    },
  ];
}
