/**
 * 记忆治理管理者（从 MemoryInspector 拆分，专责异步 LLM 语义去重）。
 * 职责分离：MemoryInspector 纯存储读写，DedupManager 异步 LLM 治理。
 * 设计原则：未注入 provider 时静默降级返回报告不抛错；不物理删除仅软删重复方保留可恢复性；不阻塞主对话热路径。
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
// LLM judge 高阶函数（流式累积 + parseLlmJson + configError 封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
// LLM 治理共享常量（统一由 governance.ts 维护）
import { GOVERNANCE_SOURCES } from '@/memory/governance.js';
import { levenshtein } from '@/memory/sourceValidation.js';
import { byAccessedDesc } from '@/utils/array.js';
import { nowIso } from '@/utils/time.js';
import { truncate } from '@/utils/strings.js';
import { logger } from '@/logging/logger.js';

// ─── L1 语义去重常量 ────────────────────────────────────
/** 单次去重扫描候选条数上限 */
const DEDUP_CANDIDATE_LIMIT = 50;
/** 单次 LLM 判断候选对数上限（每对约 200 tokens） */
const DEDUP_PAIR_LIMIT = 10;
/** 名称相似度阈值（归一化 Levenshtein 距离 ≤ 此值视为高度相似进入 LLM 判断） */
const DEDUP_NAME_SIMILARITY_THRESHOLD = 0.3;
/** LLM 去重判断超时（ms） */
const DEDUP_TIMEOUT_MS = 15_000;
/** 候选内容预览长度（送入 LLM 前截断，控制 token） */
const DEDUP_CONTENT_PREVIEW_LEN = 200;

// ─── L1 语义去重类型 ────────────────────────────────────

/** 名称高度相似的候选记忆对（待 LLM 判断语义等价性） */
export interface DedupPair {
  /** 记忆 A（保留候选） */
  a: Memory;
  /** 记忆 B（重复方，软删候选） */
  b: Memory;
  /** 名称归一化相似度（0-1，越小越相似） */
  nameSimilarity: number;
}

/** LLM 对单对记忆的语义等价判断结果 */
export interface DedupVerdict {
  /** 是否语义等价（true → 软删重复方） */
  isDuplicate: boolean;
  /** 合并后的内容（isDuplicate=true 时提供，保留更完整信息） */
  mergedContent?: string;
  /** LLM 判断理由（便于审计调试） */
  reason: string;
}

/** 降级记忆审计详情（供 UI 展示"为什么降级" + 合并后内容） */
export interface DedupVerdictSummary {
  /** 被降级记忆 ID（与 demotedIds 一一对应） */
  demotedId: string;
  /** LLM 判断理由（便于审计降级是否合理） */
  reason: string;
  /** 合并后完整内容（便于验证合并质量；缺失时渲染器负责截断展示） */
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
  /** 被降级记忆 ID 列表（未物理删除） */
  demotedIds: string[];
  /** 降级审计详情（与 demotedIds 一一对应） */
  verdicts?: DedupVerdictSummary[];
  /** 跳过原因（LLM 不可用 / 无候选对） */
  skippedReason?: string;
}

// ─── 类 ──────────────────────────────────────────────────

/** 语义去重管理器：扫描名称高度相似的记忆对，LLM 判断语义等价性，降级低分记忆。assembler 组合根创建，由 Agent 透传调用。 */
export class DedupManager {
  /** 后台 LLM Provider（可选，未注入时降级跳过） */
  private readonly backgroundProvider: LlmProvider | null;
  /** 治理源列表（默认 GOVERNANCE_SOURCES；空治理源时去重空转，测试可显式注入） */
  private readonly sources: readonly string[];

  constructor(
    private readonly index: IMemoryStorage,
    backgroundProvider: LlmProvider | null = null,
    /** 去重完成回调（宿主据此发射事件通知用户） */
    private readonly onCompleted?: (report: DedupReport) => void,
    sources: readonly string[] = GOVERNANCE_SOURCES,
  ) {
    this.backgroundProvider = backgroundProvider;
    this.sources = sources;
  }

  /**
   * 语义去重：加载候选（上限 50）→ 名称相似度筛选对（上限 10）→ LLM 判断语义等价 → 等价则软删重复方。
   * 安全设计：不物理删除仅软删（可恢复）；LLM 失败降级不阻塞；provider 未注入静默返回 skippedReason。
   */
  async deduplicateMemories(signal?: AbortSignal): Promise<DedupReport> {
    // provider 未注入时静默降级
    if (!this.backgroundProvider) {
      return {
        scannedCount: 0,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: 'backgroundProvider 未注入',
      };
    }

    const candidates: Memory[] = [];
    for (const source of this.sources) {
      const memories = this.index.getBySource(source);
      candidates.push(...memories);
    }
    // 按 accessedAt 降序（最近使用优先，score 退役后无分可排序）
    candidates.sort(byAccessedDesc);
    const limited = candidates.slice(0, DEDUP_CANDIDATE_LIMIT);

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

    const demotedIds: string[] = [];
    const verdicts: DedupVerdictSummary[] = [];
    let deduplicatedCount = 0;

    for (const pair of pairs) {
      try {
        const verdict = await this.judgeDuplicate(pair, signal);
        if (verdict.isDuplicate) {
          // 先写合并内容再降级 b：合并写入失败时不破坏 b 原始状态（原子性）
          if (verdict.mergedContent) {
            this.keepMerged(pair.a, verdict.mergedContent);
          }
          // 重复方软删（score 退役后无降级语义，soft-delete 保留可恢复）
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
        // 单对失败不阻塞后续对
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
   * 筛选名称高度相似的候选记忆对。判定：归一化 Levenshtein ≤0.3 或一方包含另一方。
   * 已配对的记忆不再参与后续配对（避免三元组产生多对）；按相似度升序（越相似越优先）取前 10 对。
   */
  private findNameOverlapPairs(candidates: Memory[]): DedupPair[] {
    const pairs: DedupPair[] = [];
    const usedIds = new Set<string>();

    // 双重循环生成所有可能对，按相似度排序后贪心选取
    const allPairs: Array<{ a: Memory; b: Memory; nameSimilarity: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!; // i 循环内 score 较高
        const b = candidates[j]!; // j>i score 较低或相等
        const similarity = DedupManager.computeNameSimilarity(a.name, b.name);
        if (similarity <= DEDUP_NAME_SIMILARITY_THRESHOLD) {
          allPairs.push({ a, b, nameSimilarity: similarity });
        }
      }
    }

    // 按相似度升序，越相似越优先处理
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

  /** 名称归一化相似度（0-1，越小越相似）。规则：包含关系=0；否则 Levenshtein 距离 / max(len)。 */
  private static computeNameSimilarity(nameA: string, nameB: string): number {
    // 空名称防御：includes("") 恒真会误判所有记忆高度相似，故空名与任何名称视为完全不同
    if (!nameA || !nameB) {
      return 1;
    }

    // 规则 2：包含关系（如"用户偏好" vs "用户偏好设置"）
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
   * 调用 LLM 判断单对记忆语义等价：结构化 JSON 输出（isDuplicate+mergedContent+reason）。
   * 流式累积/解析/异常封装委托 llmJudgeHelper.judgeWithLlm；失败抛 MemoraError 由调用方捕获跳过。
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

  /** 软删重复记忆（不物理删除保留可恢复；合并内容由 keepMerged 单独写回 a）。score 退役后弃用降级，代之以 delete 进入回收站。 */
  private demoteMemory(memory: Memory): void {
    this.index.delete(memory.id);
  }

  /** 将合并内容写回保留方 a：保持 id/source/name/createdAt 不变，仅刷新 content + accessedAt */
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

// ─── L1 语义去重 Prompt 模板（模块级函数） ───

/** 构建语义去重判断的 LLM 消息：system 定义语义等价规则 + user 携带候选对内容预览，few-shot 降误判率 */
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

记忆 A（保留候选）：
- 名称：${pair.a.name}
- 来源：${pair.a.source}
- 内容：${contentA}

记忆 B（重复候选）：
- 名称：${pair.b.name}
- 来源：${pair.b.source}
- 内容：${contentB}

名称相似度：${pair.nameSimilarity.toFixed(2)}（0=完全相同，1=完全不同）

请输出 JSON 判断结果。`,
    },
  ];
}
