/**
 * 记忆顾问 — sourceHealth()（源健康诊断）+ suggest()（关联推荐）+ detectConflicts()（L3 冲突检测）。
 * 纯只读分析计算，仅依赖 IMemoryStorage 不修改状态；同步返回不调 LLM。
 * L3 冲突检测：异步调 LLM 判断记忆间语义冲突，仅检测不修复（降级哪条由用户决策）。
 */
import type { Memory } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { nowIso, ONE_DAY_MS } from '@/utils/time.js';
import { roundTo } from '@/utils/math.js';
// 召回排除默认值 SSOT 共享（设定记忆已归角色包，默认不排除）
import { DEFAULT_RECALL_EXCLUDE_SOURCES } from '@/utils/recallDefaults.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
// LLM judge 高阶函数（流式累积 + parseLlmJson + configError 封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
import { byScoreDesc } from '@/utils/array.js';
import { truncate } from '@/utils/strings.js';
import { logger } from '@/logging/logger.js';
// 治理常量 SSOT（治理源列表 + 健康度阈值，统一由 governance.ts 维护）
import { GOVERNANCE_SOURCES, SOURCE_HEALTH_THRESHOLDS } from '@/memory/governance.js';

// ─── 常量 ────────────────────────────────────────────────

/** 关联推荐：每个 source 采样 top-N 条 */
const SUGGEST_TOP_PER_SOURCE = 3;
/** 关联推荐：时效性衰减窗口（天），超过此天数归零 */
const SUGGEST_RECENCY_WINDOW_DAYS = 30;
/** 推荐内容预览字符数 */
const ADVISOR_PREVIEW_LEN = 120;
// ─── L3 冲突检测常量 ────────────────────────────────────
/** 单个 source 内参与配对的条数上限（控制 O(n²) 配对规模） */
const CONFLICT_CANDIDATES_PER_SOURCE = 10;
/** 单次 LLM 冲突判断的候选对数上限 */
const CONFLICT_PAIR_LIMIT = 10;
/** LLM 冲突判断超时（ms） */
const CONFLICT_TIMEOUT_MS = 15_000;
/** 候选内容预览长度（送入 LLM 前截断） */
const CONFLICT_CONTENT_PREVIEW_LEN = 200;

// ─── 类型 ────────────────────────────────────────────────

/** 记忆源健康状态 */
export type SourceHealthStatus = 'healthy' | 'warning' | 'critical';

/** 单个 source 的健康指标 */
export interface SourceHealthEntry {
  source: string;
  /** 记忆数量 */
  count: number;
  /** 平均 score（0-1） */
  avgScore: number;
  /** 距上次访问的天数（取该 source 中最近访问的记忆） */
  daysSinceLastAccess: number;
  /** 健康状态：healthy（score≥0.5 且 7 天内有访问）/ warning（score<0.5 或 7-30 天未访问）/ critical（score<0.2 或 30 天以上未访问） */
  status: SourceHealthStatus;
}

/** 记忆源健康诊断报告 */
export interface SourceHealthReport {
  /** 各 source 健康指标 */
  sources: SourceHealthEntry[];
  /** 整体健康状态（取最差 source 的状态） */
  overallStatus: SourceHealthStatus;
  /** 诊断时间（ISO 8601） */
  diagnosedAt: string;
}

/** 关联推荐选项 */
export interface SuggestOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source 标签（默认空数组——设定记忆已归角色包，不再参与召回排除） */
  excludeSources?: string[];
  /** 时效性权重（0-1，默认 0.3）：越高越偏好最近访问的记忆 */
  recencyWeight?: number;
}

/** 关联推荐结果 */
export interface SuggestHit {
  /** 记忆唯一标识（source:name 格式） */
  id: string;
  name: string;
  /** 来源标签 */
  source: string;
  /** 推荐分数（0-1，由 score + recency 综合计算） */
  relevance: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
  /** 推荐理由 */
  reason: string;
}

// ─── L3 冲突检测类型 ────────────────────────────────────

/** 单对记忆的冲突判断结果 */
export interface ConflictVerdict {
  memoryA: Memory;
  memoryB: Memory;
  /** 是否存在语义冲突（true → 需用户决策降级哪条） */
  hasConflict: boolean;
  /** 冲突描述（hasConflict=true 时提供冲突点） */
  conflictDescription?: string;
  /** LLM 建议保留的记忆（'a' / 'b' / 'both'，仅供参考） */
  recommendation?: 'a' | 'b' | 'both';
  /** LLM 判断理由 */
  reason: string;
}

/** 冲突检测报告（detectConflicts 返回值） */
export interface ConflictReport {
  /** 扫描的候选记忆总数 */
  scannedCount: number;
  /** 检测的候选对数 */
  pairCount: number;
  /** LLM 判定为存在冲突的对数 */
  conflictCount: number;
  /** 冲突详情列表（供宿主 UI 展示和用户决策） */
  conflicts: ConflictVerdict[];
  /** 跳过原因（LLM 不可用 / 无候选对） */
  skippedReason?: string;
}

// ─── 类 ──────────────────────────────────────────────────

/** 记忆顾问：与 MemoryInspector 分工（Inspector 直接数据查询，Advisor 分析计算：健康诊断 + 推荐排序 + 冲突检测） */
export class MemoryAdvisor {
  /** 后台 LLM Provider（可选，用于 L3 冲突检测，未注入时跳过） */
  private readonly backgroundProvider: LlmProvider | null;
  /** 治理源列表（默认 GOVERNANCE_SOURCES；空治理源时推荐/冲突检测空转，测试可显式注入） */
  private readonly sources: readonly string[];

  constructor(
    private readonly index: IMemoryStorage,
    backgroundProvider: LlmProvider | null = null,
    sources: readonly string[] = GOVERNANCE_SOURCES,
  ) {
    this.backgroundProvider = backgroundProvider;
    this.sources = sources;
  }

  // ─── 源健康诊断 ─────────────────────────────────────────

  /**
   * 记忆源健康诊断：逐 source 计算数量/平均 score/最近访问天数/状态，助宿主判断是否需要清理或补充。
   * 状态判定：healthy=avgScore≥0.5；warning=avgScore<0.5；critical=avgScore<0.2。
   * 纪律（D7 / ADR-025）：仅按**语义状态**（平均 score）判定，时间不参与——久未访问不构成「过期/沉底」；
   * daysSinceLastAccess 仅作事实展示，不驱动状态（2026-09-09 移除原 7/30 天时间分支）。
   * 纯只读同步不调 LLM，用 getAllSources() 发现所有 source 标签（替代全量 search）。
   */
  sourceHealth(): SourceHealthReport {
    const now = Date.now();

    // 获取所有有数据的 source 标签
    const sourceMap = this.index.getAllSources();
    const sourceSet = new Set<string>();
    for (const [source, count] of sourceMap) {
      if (count > 0) sourceSet.add(source);
    }

    const entries: SourceHealthEntry[] = [];
    for (const source of sourceSet) {
      const memories = this.index.getBySource(source);
      const count = memories.length;

      const avgScore = count > 0
        ? memories.reduce((sum, m) => sum + m.score, 0) / count
        : 0;

      // 最近访问时间（取该 source 中最新 accessedAt）
      const latestAccess = memories
        .map((m) => new Date(m.accessedAt).getTime())
        .filter((t) => !isNaN(t))
        .sort((a, b) => b - a)[0] ?? 0;
      const daysSinceLastAccess = latestAccess > 0
        ? (now - latestAccess) / ONE_DAY_MS
        : Infinity;

      // 健康状态判定
      let status: SourceHealthStatus;
      if (avgScore < SOURCE_HEALTH_THRESHOLDS.CRITICAL_SCORE) {
        status = 'critical';
      } else if (avgScore < SOURCE_HEALTH_THRESHOLDS.WARNING_SCORE) {
        status = 'warning';
      } else {
        status = 'healthy';
      }

      entries.push({
        source,
        count,
        avgScore: roundTo(avgScore, 3),
        daysSinceLastAccess: roundTo(daysSinceLastAccess, 1),
        status,
      });
    }

    // 整体状态取最差 source
    const statusPriority: Record<SourceHealthStatus, number> = { healthy: 0, warning: 1, critical: 2 };
    const overallStatus = entries.reduce<SourceHealthStatus>(
      (worst, e) => statusPriority[e.status] > statusPriority[worst] ? e.status : worst,
      'healthy',
    );

    return {
      sources: entries.sort((a, b) => statusPriority[b.status] - statusPriority[a.status]),
      overallStatus,
      diagnosedAt: nowIso(),
    };
  }

  // ─── 关联推荐 ─────────────────────────────────────────

  /**
   * 关联推荐：不调 LLM 纯计算，综合 score（权重）+ accessedAt（时效）+ source 多样性，
   * 返回"相关但尚未直接搜索到"的记忆。query 提供时结合搜索命中推荐，省略时基于全局热度。
   */
  suggest(query?: string, options: SuggestOptions = {}): SuggestHit[] {
    const {
      limit = 5,
      excludeSources = [...DEFAULT_RECALL_EXCLUDE_SOURCES],
      recencyWeight = 0.3,
    } = options;

    const scoreWeight = 1 - recencyWeight;
    const now = Date.now();

    // 收集候选记忆
    const candidates = new Map<string, { memory: Memory; searchHit: boolean }>();

    // 有 query 时先搜直接命中（标记 searchHit）
    if (query && query.trim()) {
      const directHits = this.index.search(query, limit * 3);
      for (const m of directHits) {
        if (!excludeSources.includes(m.source)) {
          candidates.set(m.id, { memory: m, searchHit: true });
        }
      }
    }

    // 按 source 分组采样，确保来源多样性
    for (const source of this.sources) {
      const count = this.index.countBySource(source);
      if (count > 0 && !excludeSources.includes(source)) {
        const memories = this.index.getBySource(source);
        // 取 score 最高的前 N 条
        const top = memories.sort(byScoreDesc).slice(0, SUGGEST_TOP_PER_SOURCE);
        for (const m of top) {
          if (!candidates.has(m.id)) {
            candidates.set(m.id, { memory: m, searchHit: false });
          }
        }
      }
    }

    if (candidates.size === 0) return [];

    const scored: Array<{ memory: Memory; searchHit: boolean; relevance: number; reason: string }> = [];

    for (const { memory, searchHit } of candidates.values()) {
      // 时效性分：窗口内线性衰减，超过窗口归零
      const accessedAt = new Date(memory.accessedAt);
      const daysSinceAccess = isNaN(accessedAt.getTime())
        ? SUGGEST_RECENCY_WINDOW_DAYS
        : (now - accessedAt.getTime()) / ONE_DAY_MS;
      const recency = Math.max(0, 1 - daysSinceAccess / SUGGEST_RECENCY_WINDOW_DAYS);

      const relevance = memory.score * scoreWeight + recency * recencyWeight;

      // 生成推荐理由
      let reason: string;
      if (searchHit) {
        reason = '与搜索相关';
      } else if (daysSinceAccess < 1) {
        reason = '最近访问';
      } else if (memory.score >= 0.8) {
        reason = '高频记忆';
      } else {
        reason = `${memory.source} 推荐`;
      }

      scored.push({ memory, searchHit, relevance, reason });
    }

    // 排序：搜索命中优先，然后按 relevance 降序
    scored.sort((a, b) => {
      if (a.searchHit !== b.searchHit) return a.searchHit ? -1 : 1;
      return b.relevance - a.relevance;
    });

    return scored.slice(0, limit).map(({ memory, relevance, reason }) => ({
      id: memory.id,
      name: memory.name,
      source: memory.source,
      relevance: roundTo(relevance, 2),
      contentPreview: truncate(memory.content, ADVISOR_PREVIEW_LEN),
      reason,
    }));
  }

  // ─── L3 语义冲突检测（可选，backgroundProvider 注入后启用） ───

  /**
   * 语义冲突检测：加载候选（每 source top 10）→ 同 source 两两配对（前 10 对）→ LLM 判断冲突。
   * 仅检测不修复（不自动降级，冲突需用户决策）；LLM 失败不阻塞；provider 未注入静默跳过。
   */
  async detectConflicts(signal?: AbortSignal): Promise<ConflictReport> {
    // provider 未注入时静默降级
    if (!this.backgroundProvider) {
      return {
        scannedCount: 0,
        pairCount: 0,
        conflictCount: 0,
        conflicts: [],
        skippedReason: 'backgroundProvider 未注入',
      };
    }

    const candidates: Memory[] = [];
    for (const source of this.sources) {
      const memories = this.index.getBySource(source);
      // 按 score 降序取 top N
      const top = memories.sort(byScoreDesc).slice(0, CONFLICT_CANDIDATES_PER_SOURCE);
      candidates.push(...top);
    }

    if (candidates.length < 2) {
      return {
        scannedCount: candidates.length,
        pairCount: 0,
        conflictCount: 0,
        conflicts: [],
        skippedReason: '候选记忆不足（少于 2 条）',
      };
    }

    // 同 source 内两两配对
    const pairs = this.findConflictCandidates(candidates);
    if (pairs.length === 0) {
      return {
        scannedCount: candidates.length,
        pairCount: 0,
        conflictCount: 0,
        conflicts: [],
        skippedReason: '无同 source 候选对',
      };
    }

    // 逐对调用 LLM 判断冲突
    const conflicts: ConflictVerdict[] = [];

    for (const pair of pairs) {
      try {
        const verdict = await this.judgeConflict(pair[0], pair[1], signal);
        if (verdict.hasConflict) {
          conflicts.push(verdict);
          logger.info(
            { memoryA: verdict.memoryA.id, memoryB: verdict.memoryB.id, reason: verdict.reason },
            '冲突检测：发现语义冲突',
          );
        }
      } catch (err) {
        // 单对 LLM 判断失败不阻塞后续检测
        logger.warn(
          { err, pairId: `${pair[0].id}↔${pair[1].id}` },
          '冲突检测：LLM 判断失败，跳过此对',
        );
      }
    }

    return {
      scannedCount: candidates.length,
      pairCount: pairs.length,
      conflictCount: conflicts.length,
      conflicts,
    };
  }

  /** 筛选同 source 内候选冲突对：按 source 分组两两配对，限制每 source 配对数避免 O(n²) 爆炸，总上限 10 对 */
  private findConflictCandidates(candidates: Memory[]): Array<[Memory, Memory]> {
    // 按 source 分组
    const bySource = new Map<string, Memory[]>();
    for (const m of candidates) {
      const list = bySource.get(m.source) ?? [];
      list.push(m);
      bySource.set(m.source, list);
    }

    // 同 source 内两两配对，均匀分配配对数
    const pairs: Array<[Memory, Memory]> = [];
    const sources = [...bySource.keys()];
    // 每个 source 分配的配对数配额（总上限 / source 数，至少 1 对/source）
    const quotaPerSource = Math.max(1, Math.ceil(CONFLICT_PAIR_LIMIT / sources.length));

    for (const source of sources) {
      const list = bySource.get(source);
      if (!list || list.length < 2) continue;
      let count = 0;
      for (let i = 0; i < list.length && count < quotaPerSource; i++) {
        for (let j = i + 1; j < list.length && count < quotaPerSource; j++) {
          pairs.push([list[i]!, list[j]!]);
          count++;
        }
      }
      if (pairs.length >= CONFLICT_PAIR_LIMIT) break;
    }

    return pairs.slice(0, CONFLICT_PAIR_LIMIT);
  }

  /**
   * 调用 LLM 判断两条记忆是否冲突：结构化 JSON 输出（hasConflict+conflictDescription+recommendation+reason）。
   * 流式累积/解析/异常封装委托 llmJudgeHelper.judgeWithLlm；失败抛 MemoraError 由调用方捕获跳过。
   */
  private async judgeConflict(memoryA: Memory, memoryB: Memory, signal?: AbortSignal): Promise<ConflictVerdict> {
    const messages = buildConflictMessages(memoryA, memoryB);
    const parsed = await judgeWithLlm<{
      hasConflict?: boolean;
      conflictDescription?: string;
      recommendation?: string;
      reason?: string;
    }>(
      this.backgroundProvider!,
      messages,
      { maxTokens: 300, timeoutMs: CONFLICT_TIMEOUT_MS, signal },
      'LLM 冲突判断返回非法 JSON',
    );

    // 校验 recommendation 字段（允许 'a' / 'b' / 'both'，其他值忽略）
    const recRaw = parsed.recommendation;
    const recommendation: 'a' | 'b' | 'both' | undefined =
      recRaw === 'a' || recRaw === 'b' || recRaw === 'both' ? recRaw : undefined;

    return {
      memoryA,
      memoryB,
      hasConflict: parsed.hasConflict === true,
      conflictDescription: typeof parsed.conflictDescription === 'string' ? parsed.conflictDescription : undefined,
      recommendation,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '(LLM 未提供理由)',
    };
  }
}

// ─── L3 冲突检测 Prompt 模板（模块级函数） ───

/** 构建冲突判断的 LLM 消息：system 定义冲突规则 + user 携带两条记忆内容预览，few-shot 降误判率 */
function buildConflictMessages(memoryA: Memory, memoryB: Memory): Message[] {
  const contentA = memoryA.content.length > CONFLICT_CONTENT_PREVIEW_LEN
    ? truncate(memoryA.content, CONFLICT_CONTENT_PREVIEW_LEN, '…[截断]')
    : memoryA.content;
  const contentB = memoryB.content.length > CONFLICT_CONTENT_PREVIEW_LEN
    ? truncate(memoryB.content, CONFLICT_CONTENT_PREVIEW_LEN, '…[截断]')
    : memoryB.content;

  return [
    {
      role: 'system',
      content: `你是记忆冲突检测助手。判断给定的两条记忆是否存在语义冲突（表达互相矛盾的信息）。

判断规则：
- 存在冲突 = 两条记忆表达的信息互相矛盾，不能同时为真（如"喜欢 X" vs "讨厌 X"）
- 无冲突 = 两条记忆信息互补、独立或不相关
- 不同维度不构成冲突（如"擅长后端" vs "偏好前端"是不同维度，非冲突）
- 时间演化不构成冲突（如"用 React 16" vs "用 React 18"是版本升级，非冲突）

输出 JSON 格式：
{
  "hasConflict": true/false,
  "conflictDescription": "冲突点描述（仅 hasConflict=true 时提供）",
  "recommendation": "a/b/both（建议保留哪条：a=保留A，b=保留B，both=都保留需用户裁决）",
  "reason": "判断理由（简短说明）"
}

示例：
输入 A: "用户喜欢使用 JavaScript"
输入 B: "用户讨厌 JavaScript"
输出: {"hasConflict": true, "conflictDescription": "对 JavaScript 的态度矛盾", "recommendation": "both", "reason": "需用户裁决当前偏好"}

输入 A: "用户擅长后端开发"
输入 B: "用户偏好前端开发"
输出: {"hasConflict": false, "reason": "擅长领域与偏好领域是不同维度，非冲突"}`,
    },
    {
      role: 'user',
      content: `请判断以下两条记忆是否存在语义冲突：

记忆 A（score: ${memoryA.score}）：
- 名称：${memoryA.name}
- 来源：${memoryA.source}
- 创建时间：${memoryA.createdAt}
- 内容：${contentA}

记忆 B（score: ${memoryB.score}）：
- 名称：${memoryB.name}
- 来源：${memoryB.source}
- 创建时间：${memoryB.createdAt}
- 内容：${contentB}

请输出 JSON 判断结果。`,
    },
  ];
}
