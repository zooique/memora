/**
 * 记忆召回 — 简化关键词搜索。
 * 双通道（语义 + 关键词）召回，以 source 开放字符串区分来源、无需独立管理器；
 * 融合排序在 hybridMerge.ts（与 searchHybrid() 共享）。
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { IReranker } from '@/memory/reranker.js';
import { logger } from '@/logging/logger.js';
import { segmentLower, STOPWORDS } from '@/utils/segmenter.js';
import { nowIso } from '@/utils/time.js';
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';
import type { HybridWeights } from '@/memory/hybridMerge.js';
// 召回默认值 SSOT 跨层共享（保底下限 + 排除默认）
import { DEFAULT_MIN_FALLBACK, DEFAULT_RECALL_EXCLUDE_SOURCES } from '@/utils/recallDefaults.js';
// 召回 score 提升/上限/下限：复用治理共享常量（boost/clamp），与宿主存储 incrementScore 同一 clamp 真源
import { BOOST_INCREMENT, SCORE_CEILING } from '@/memory/governance.js';

// ─── 召回常量 ─────────────────────────────────────

/** 语义搜索默认相似度阈值 */
const DEFAULT_MIN_SIMILARITY = 0.3;

/** 召回返回条数上限：100 已远超任何真实召回需求，防止 limit × RECALL_LIMIT_MULTIPLIER 放大底层搜索 */
const MAX_RECALL_LIMIT = 100;

/** 召回各通道超时：超时后降级为已收集的结果，不阻塞 prepare 流程 */
const RECALL_SEARCH_TIMEOUT_MS = 5000;

/**
 * 给异步操作加超时保护：超时后 reject，调用方 catch 降级。
 * 契约边界（2026-08-25 澄清）：仅丢弃本次读结果，不取消底层 Promise——
 * JSON 内存存储下由调用方 fire-and-forget 无碍；宿主若注入阻塞型存储（如大 SQLite 检索），
 * 超时后底层任务仍占用资源，须宿主侧限流（内核不做 Promise 级 abort）。
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
    }),
  ]);
}

/**
 * 从文本提取关键词：segmentText 精确分词 + 停用词过滤 + 英文词补充 + 去重。
 */
export function extractKeywords(input: string): string[] {
  const words = segmentLower(input);

  // 补充英文词（segmentText 可能遗漏连续英文大写缩写，如 APIKey → "apikey" 整词）
  const englishWords = input.match(/[a-z]{2,}/gi) || [];
  words.push(...englishWords.map((w) => w.toLowerCase()));

  // 去重 + 停用词过滤 + 最短长度
  return [...new Set(words)].filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ─── 召回函数 ─────────────────────────────────────────────

/** 召回选项 */
export interface RecallOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source（默认空数组——设定记忆已归角色包，不再参与召回排除） */
  excludeSources?: string[];
  /** 向量存储（可选，提供时启用语义搜索） */
  vectorStore?: IVectorStore;
  /** 语义搜索相似度阈值（默认 0.3） */
  minSimilarity?: number;
  /** 重排序器（可选，hybridMerge 之后二次精排，如 MMR/LLM 评分） */
  reranker?: IReranker;
  /** 双通道融合权重（可选，默认 0.6/0.4），见 hybridMerge.ts */
  weights?: HybridWeights;
  /**
   * 会话窗口标识，用于同会话窗口优先排序。
   * 与 round-summary 写侧 sessionName 顶层字段同值同源（${date}-${session}），即"当前会话窗口摘要排最前"
   */
  sessionId?: string;
  /** 召回保底下限（默认 2）：语义不足时用最近记忆补足（空查询通道），排语义命中后、去 superseded；置 0 关闭 */
  minFallback?: number;
  /** 排除的 roundId 集合（互斥）：在 hybridMerge 取 limit 前过滤，避免正文已加载的当前会话摘要挤占预算；缺省空集合不过滤 */
  excludeRoundIds?: ReadonlySet<string>;
  /**
   * 摘要召回 token 上限（可选）：>0 时启用 cap 内分配（§4.3.1）——L2 preference 轨最多占
   * (cap - semanticFloor)、L2 语义轨保底 semanticFloor（未满余量补位）。缺省（0/undefined）
   * 退化为纯 limit 条数裁剪。由调用方（contextPreparer limited 模式）按 memoryRecallPercent
   * 预算换算为 token 传入。
   */
  capTokens?: number;
  /**
   * cap 内语义轨道保底比例（0~1，默认 0）：preference 挤满 cap 时保证语义轨至少占该比例；
   * 0 = 关闭（最简形态，分配全靠排序自然形成）。属内核召回机制参数，不进角色包 schema（C2）。
   */
  minSemanticShare?: number;
}

/**
 * 从存储搜索相关记忆：双通道（语义+关键词）合并去重 → hybridMerge 融合排序 → 可选 reranker → 会话窗口/组内排序 + superseded 过滤 → 返回 top N。
 */
export async function recall(
  storage: IMemoryStorage,
  query: string,
  options: RecallOptions = {},
): Promise<Memory[]> {
  const {
    limit: rawLimit = 5,
    excludeSources = [...DEFAULT_RECALL_EXCLUDE_SOURCES],
    vectorStore,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
    reranker,
    weights,
    sessionId,
    excludeRoundIds,
    capTokens,
    minSemanticShare = 0,
  } = options;

  // 数量上限：limit clamp 到 [1, MAX_RECALL_LIMIT]（公共 API 防呆，防超大值 × RECALL_LIMIT_MULTIPLIER 放大底层搜索）
  const limit = Math.max(1, Math.min(MAX_RECALL_LIMIT, Math.floor(rawLimit)));

  const merged = new Map<string, { memory: Memory; vectorScore: number }>();

  // ── 通道 1：语义搜索（VectorStore 可用时） ──
  if (vectorStore && vectorStore.size > 0) {
    try {
      const vectorResults = await withTimeout(
        vectorStore.search(
          query,
          limit * RECALL_LIMIT_MULTIPLIER,
          minSimilarity,
        ),
        RECALL_SEARCH_TIMEOUT_MS,
        '语义搜索',
      );
      for (const vr of vectorResults) {
        const memory = storage.getById(vr.id);
        if (memory && !excludeSources.includes(memory.source)) {
          merged.set(memory.id, { memory, vectorScore: vr.similarity });
        }
      }
    } catch (err) {
      logger.debug({ err }, '语义搜索失败，降级到关键词');
    }
  }

  // ── 通道 2：关键词搜索 ──
  const keywords = extractKeywords(query);
  if (keywords.length > 0) {
    // 失败时降级返回已收集的语义结果，与通道 1 对称
    try {
      // 用提取后的关键词组合搜索，避免 query 中停用词/噪声影响匹配
      const keywordResults = await withTimeout(
        Promise.resolve(storage.search(keywords.join(' '), limit * RECALL_LIMIT_MULTIPLIER)),
        RECALL_SEARCH_TIMEOUT_MS,
        '关键词搜索',
      );
      for (const m of keywordResults) {
        if (!excludeSources.includes(m.source) && !merged.has(m.id)) {
          merged.set(m.id, { memory: m, vectorScore: 0 });
        }
      }
    } catch (err) {
      logger.debug({ err }, '关键词搜索失败，仅返回语义搜索结果');
    }
  }

  // ── v3 分层分轨候选池整理（§4.3 分轨策略） ──
  // L2 意图轨排除（跨会话 intent 无意义）+ L2 偏好轨进池（长期有效，即便未命中检索；仅在有查询意图时补入）。
  // 仅在具备分层上下文（sessionId）且存在查询意图时生效；无 sessionId 走旧路径，避免无分层基础时误伤。
  applyTrackPolicy(merged, storage, {
    sessionId,
    excludeSources,
    hasQueryIntent: keywords.length > 0,
  });

  // 零召回也进入保底：新会话冷启动同样需最近记忆兜底
  let active: Memory[] = [];
  if (merged.size > 0) {
    // 前置排除：在 hybridMerge 取 limit **前**过滤当前会话最近 N 轮摘要，避免挤占 top-limit 预算
    // Map 直接映射 value 数组（避免迭代器 spread 可移植性问题）
    let candidates: { memory: Memory; vectorScore: number }[] = Array.from(
      merged,
      ([, v]) => v,
    );
    if (excludeRoundIds && excludeRoundIds.size > 0) {
      candidates = candidates.filter(
        (e) => !e.memory.roundId || !excludeRoundIds.has(e.memory.roundId),
      );
    }

    // ── 综合排序：委托 hybridMerge 纯函数（支持自定义权重） ──
    // 候选超集裁剪（2026-08-27 修复）：hybridMerge 用 limit × RECALL_LIMIT_MULTIPLIER 保留候选超集，
    // 不在 cap 分配前就裁到最终 limit——否则排序靠前的 L2 preference 会独占 top-limit，
    // 语义轨在 cap 分配（token + 条数双约束）前就被挤出，minSemanticShare 兜底失效。
    // 最终条数由 applyCapAllocation 的 limit 槽位预算兜底（无 cap 时退化 slice(0, limit) 同旧行为）。
    const supersetLimit = limit * RECALL_LIMIT_MULTIPLIER;
    const sorted = hybridMerge(candidates, supersetLimit, weights);

    // ── 重排序：reranker 二次精排（可选） ──
    // 与 hybridMerge 同为超集裁剪：rerank 的 limit 传超集数，避免把候选在 cap 分配前裁回 limit
    let reranked = reranker
      ? await withTimeout(
          reranker.rerank(
            query,
            sorted.map((e) => e.memory),
            { limit: supersetLimit },
          ),
          RECALL_SEARCH_TIMEOUT_MS,
          '重排序',
        ).catch(() => sorted.map((e) => e.memory))
      : sorted.map((e) => e.memory);

    // 记忆有效性由 superseded（写时取代）判定，不在读路径按时间过滤（score 衰减机制已移除）
    // 分层排序（v3 §4.1/4.2）：L1 会话内（createdAt 升序）→ L2 preference（createdAt 升序）→ L2 其余（保持相关性相对序）
    reranked = sortByLayer(reranked, sessionId);

    // 被 supersededBy 取代的摘要不再作为当前事实注入（仍保留可回溯）
    active = reranked.filter((m) => !m.supersededBy);
  }

  // 召回保底：active 少于 minFallback 时用空查询通道按 score 降序补最近记忆，排语义命中后、同过滤（excludeSources+去 superseded），置 0 关闭
  // 数量上限：minFallback 同样 clamp 到 [0, MAX_RECALL_LIMIT]（公共 API 防呆，防空查询通道 shortfall 放大底层搜索）
  const fallbackFloor = Math.max(0, Math.min(MAX_RECALL_LIMIT, options.minFallback ?? DEFAULT_MIN_FALLBACK));
  // 仅"有查询意图"（关键词非空）时保底
  if (fallbackFloor > 0 && keywords.length > 0 && active.length < fallbackFloor) {
    const shortfall = fallbackFloor - active.length;
    // 防御：空查询补足通道失败时静默跳过，不阻塞主流程
    let recent: Memory[] = [];
    try {
      const raw = await withTimeout(
        Promise.resolve(storage.search('', shortfall * RECALL_LIMIT_MULTIPLIER)),
        RECALL_SEARCH_TIMEOUT_MS,
        '召回保底',
      );
      recent = Array.isArray(raw) ? raw : [];
    } catch (err) {
      logger.debug({ err }, '召回保底：空查询补足失败，跳过');
    }
    const existingIds = new Set(active.map((m) => m.id));
    let remaining = shortfall;
    for (const candidate of recent) {
      if (remaining <= 0) break;
      // 与主流程对齐：已命中 / 被取代 / 被排除来源 → 跳过
      if (existingIds.has(candidate.id)) continue;
      if (candidate.supersededBy) continue;
      if (excludeSources.includes(candidate.source)) continue;
      // 互斥排除：避免把正文已加载的当前会话摘要补回造成重复
      const rid = candidate.roundId;
      if (rid && excludeRoundIds?.has(rid)) continue;
      active.push(candidate);
      existingIds.add(candidate.id);
      remaining--;
    }
  }

  // ── cap 内分配（v3 §4.3.1） ──
  // capTokens > 0 时按 token 填充（L2 preference 取余量、语义轨保底 semanticFloor）；缺省退化为 limit 条数截断
  const allocated = applyCapAllocation(active, sessionId, {
    capTokens,
    minSemanticShare,
    limit,
  });

  // 读/写拆分：在副本上 boost 仅影响本轮排序；持久化由调用方 fire-and-forget 调 boostScores，不阻塞读路径
  const now = nowIso();
  const result: Memory[] = allocated.map((memory) => {
    const copy = { ...memory };
    boostScore(copy, now);
    return copy;
  });

  return result;
}

/**
 * v3 分层分轨候选池整理（§4.3 分轨策略）
 *
 * 进池开关（不决定配额，配额由 cap 内分配决定）：
 *   1. L2 意图轨排除——跨会话 intent 摘要不进候选池（意图是临时的，跨会话无意义）；
 *   2. L2 偏好轨进池——preference 长期有效，即便语义/关键词未命中也补入候选池（必经检索筛选）；
 *      仅在有查询意图（hasQueryIntent）时补入，无查询意图（空/噪声输入）不注入，防御偏好强塞无关查询。
 * 仅在具备分层上下文（sessionId）且存在查询意图（hasQueryIntent）时生效；无 sessionId 走旧路径。
 *
 * @param merged 双通道已收集的候选池（id → 记忆+向量分），本函数就地增删
 * @param storage 记忆存储（用于按 source 枚举 round-summary 以筛出 L2 preference）
 * @param ctx 分层上下文：sessionId 会话窗口 / excludeSources 排除来源 / hasQueryIntent 是否有查询意图
 */
function applyTrackPolicy(
  merged: Map<string, { memory: Memory; vectorScore: number }>,
  storage: IMemoryStorage,
  ctx: { sessionId?: string; excludeSources: string[]; hasQueryIntent: boolean },
): void {
  const { sessionId, excludeSources, hasQueryIntent } = ctx;
  // 无分层上下文时不整理（无会话内/外之分，保持旧路径，避免误伤）
  if (sessionId === undefined) return;

  // 1) L2 意图轨排除：仅移除跨会话（非当前窗口）的 intent 摘要；L1 意图走语义召回（4.3 表）
  for (const [id, entry] of merged) {
    const m = entry.memory;
    if (m.summaryType === 'intent' && m.sessionName !== sessionId) {
      merged.delete(id);
    }
  }

  // 2) L2 偏好轨进池：仅当存在查询意图时补入（无查询意图时 preference 不单独注入）
  //    无意图时保持"纯噪声输入返回空"的防御行为，避免偏好摘要强塞入无关查询。
  if (!hasQueryIntent) return;
  let summaries: Memory[] = [];
  try {
    // 宿主实现 getBySource('round-summary') 可能失败（如未实现/返回异常），降级为不补池
    const raw = storage.getBySource(SOURCE_LABELS.ROUND_SUMMARY);
    summaries = Array.isArray(raw) ? raw : [];
  } catch (err) {
    logger.debug({ err }, '分轨：preference 进池枚举失败，跳过');
    return;
  }
  for (const m of summaries) {
    // 仅补 L2 preference：L1 preference 走语义召回进池（4.3 表），此处只补跨会话偏好
    if (m.summaryType !== 'preference') continue;
    if (m.sessionName === sessionId) continue;
    if (merged.has(m.id)) continue;
    if (m.supersededBy) continue; // 被取代的偏好不再注入（写时取代纪律）
    if (excludeSources.includes(m.source)) continue;
    merged.set(m.id, { memory: m, vectorScore: 0 });
  }
}

/**
 * 分层排序（v3 §4.1/4.2）：L1 会话内（createdAt 升序）→ L2 preference（createdAt 升序）→
 * L2 其余轨（保持 hybridMerge/reranker 相关性相对序，不再二次覆盖）。
 * 无 sessionId 时回退为全局 createdAt 升序（旧行为，无分层基础）。
 *
 * @param memories 待排序记忆（hybridMerge/reranker 已按相关性排过）
 * @param sessionId 会话窗口标识（缺省走旧路径）
 * @returns 分层排序后的新数组（不修改入参）
 */
function sortByLayer(memories: Memory[], sessionId?: string): Memory[] {
  if (sessionId === undefined) {
    return [...memories].sort(byCreatedAt);
  }
  const l1: Memory[] = [];
  const l2Pref: Memory[] = [];
  const l2Other: Memory[] = [];
  for (const m of memories) {
    if (m.sessionName === sessionId) l1.push(m);
    else if (m.summaryType === 'preference') l2Pref.push(m);
    else l2Other.push(m);
  }
  l1.sort(byCreatedAt);
  l2Pref.sort(byCreatedAt);
  // l2Other 保持入参相对序（相关性），不重排
  return [...l1, ...l2Pref, ...l2Other];
}

/**
 * createdAt 升序比较器（稳定：时间不可解析/相等时返回 0，保持原相对序）
 */
function byCreatedAt(a: Memory, b: Memory): number {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
  return 0;
}

/**
 * 召回侧 token 估算（chars/4 启发式）
 *
 * 与 agent/compaction.ts estimateTokens 同公式（避免宿主注入 token 口径不一致）；
 * 未来若内核下沉公共 token 工具，此函数应收敛到同一真源。
 *
 * @param text 记忆内容
 * @returns 估算 token 数
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * cap 内分配（v3 §4.3.1）：capTokens > 0 时按 token + 条数双约束填充——
 * L1 会话内全量注入（createdAt 升序，上下文连续性硬需求）→ L2 preference 最多占
 * (cap - semanticFloor) token 且让出语义保底条数 → L2 语义轨保底（相关性序，
 * preference 未用满的余量让给语义轨）。缺省（capTokens 缺省/≤0）退化为纯 limit 条数截断。
 *
 * 条数约束参与分配（2026-08-27 修正）：limit 是分配内的条数预算，而非分配后纯截断——
 * 修复「cap 分配后 slice(0,limit) 按分层顺序截断，preference 排前总被保留、语义保底失效」。
 * 当 limit 远小于 cap 允许条数（contextPreparer limited 模式 limit=5 << cap token）时，
 * minSemanticShare 在条数层面生效：语义轨至少占剩余条数的该比例。
 *
 * minSemanticShare 语义（默认 0 = 关闭）：0 时 preference 可占满 cap（最简形态，分配全靠
 * 排序自然形成）；>0 时保证语义轨至少占 cap 该比例（token 层面 semanticFloor + 条数层面
 * semanticSlots 双保底），防 preference 完全挤占。
 *
 * @param ordered 已分层排序的记忆（active，superseded 已过滤）
 * @param sessionId 会话窗口标识（用于区分 L1/L2）
 * @param opts capTokens token 上限 / minSemanticShare 语义保底比例 / limit 条数上限
 * @returns cap 分配后的记忆数组（条数 ≤ limit）
 */
function applyCapAllocation(
  ordered: Memory[],
  sessionId: string | undefined,
  opts: { capTokens?: number; minSemanticShare: number; limit: number },
): Memory[] {
  const { capTokens, minSemanticShare, limit } = opts;
  // 缺省 cap 时退化为纯条数截断（兼容旧调用方：full 模式 / 未接 C1 的宿主）
  if (!capTokens || capTokens <= 0) return ordered.slice(0, limit);

  const cap = capTokens;
  // 语义轨 token 保底下限：至少占 cap 的 minSemanticShare 比例（clamp 到 cap 内）
  const semanticFloor = Math.min(cap, Math.floor(cap * minSemanticShare));
  // preference 轨最多占的 token 余量（cap 减去语义保底）
  const prefAllowance = cap - semanticFloor;

  // 分组（保持 sortByLayer 的相对序）：L1 会话内 → L2 preference → L2 语义轨
  const l1: Memory[] = [];
  const l2Pref: Memory[] = [];
  const l2Sem: Memory[] = [];
  for (const m of ordered) {
    if (sessionId !== undefined && m.sessionName === sessionId) l1.push(m);
    else if (m.summaryType === 'preference') l2Pref.push(m);
    else l2Sem.push(m);
  }

  // L1 全量注入（createdAt 升序已由 sortByLayer 保证，不计 token、仅占条数）
  const result = [...l1];
  // 剩余条数预算：limit 减去 L1 占用，L2 分轨共用
  let remainingLimit = Math.max(0, limit - l1.length);
  // 语义轨条数保底：在剩余条数内至少占 minSemanticShare 比例（share>0 时生效），
  // 保证 limit 条数主导时语义保底不被 preference 条数挤掉（token 层面 semanticFloor 仍兜底）
  const semanticSlots =
    minSemanticShare > 0
      ? Math.min(l2Sem.length, Math.ceil(remainingLimit * Math.min(1, minSemanticShare)))
      : 0;
  // preference 最多占的条数：剩余条数减去语义保底条数
  const prefSlots = Math.max(0, remainingLimit - semanticSlots);

  // L2 preference：最多 prefSlots 条 且 ≤ prefAllowance token（createdAt 升序，sortByLayer 已排）
  let prefTokens = 0; // L2 preference 已用 token
  let prefCount = 0;
  for (const m of l2Pref) {
    if (prefCount >= prefSlots) break;
    const t = estimateTokens(m.content);
    if (prefTokens + t > prefAllowance) break;
    prefTokens += t;
    result.push(m);
    prefCount++;
  }
  // preference 未取用的条数预算归还给语义轨（自然补位）
  remainingLimit -= prefCount;

  // L2 语义轨：≤ remainingLimit 条 且 ≤ (cap - prefTokens) token；相关性序（l2Sem 保持相对序）
  let semanticTokens = 0; // L2 语义轨已用 token
  const semanticAllowance = cap - prefTokens;
  let semanticCount = 0;
  for (const m of l2Sem) {
    if (semanticCount >= remainingLimit) break;
    const t = estimateTokens(m.content);
    if (semanticTokens + t > semanticAllowance) break;
    semanticTokens += t;
    result.push(m);
    semanticCount++;
  }

  return result;
}

/**
 * 批量持久化 touch（召回后 fire-and-forget 调用）：只刷新 accessedAt，不改 score。
 *
 * 承接「只 touch 不 +score」定案（§5.2）：accessedAt 是「使用轨迹」唯一事实源
 * （被想起即刷新），不叠加 +score 以免与「最近使用优先」时间规则形成双轨、引回自强化。
 * 用 incrementScore(id, 0)：delta=0 → clamp 后 score 不变，仅 accessedAt 更新，
 * 天然原子（无 read-modify-write 并发冲突）。失败仅 log 不抛错，不阻塞读路径。
 */
export async function touchScores(
  storage: IMemoryStorage,
  ids: string[],
  now: string = nowIso(),
): Promise<void> {
  for (const id of ids) {
    storage.incrementScore(id, 0, now);
  }
}

// ─── Score 提升机制 ─────────────────────────────────────

/** 召回时提升 score（上限 1.0）：越常用越重要 */
// 模块私有（0 外部消费者，仅 recall.ts 内部调用，与 tokenizeKeywords 同模式）
function boostScore(memory: Memory, now?: string): void {
  memory.score = Math.min(SCORE_CEILING, memory.score + BOOST_INCREMENT);
  memory.accessedAt = now ?? nowIso();
}

