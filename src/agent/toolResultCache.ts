/**
 * 工具结果防重缓存（闭环内有效）
 *
 * 设计意图：LLM 在问答闭环中反复调用 read_file/list_dir/web_search 等信息获取型工具，
 * 同一参数重复调用既浪费 token 又无增量价值（文件未变 / 同 query 网络结果近似）。
 * 本缓存以「闭环内去重」为粒度——闭环结束即清空，跨闭环不复用。
 *
 * 拦截语义与 loop 已有的 web_search MAX_WEB_SEARCH_CALLS / ask_user askLimit 同级：
 * 检测到重复 → blocked=true（不算工具失败）→ 返回 [ALREADY_READ] 拒绝文案。
 *
 * **去重主体是结构化的**（`DedupSubject`），不是预先拼好的字符串 key：
 * 写入（set）/ 命中（check）/ 失效（invalidateFile）三处必须对**同一份主体**判定。
 * 任何一处自行拼 key 都会让三者静默失配——历史缺陷即此形态：key 里加上读取区间后，
 * `invalidateFile` 的 `read_file:${path}` 前缀永远匹配不上 → 文件被改后旧缓存不失效 → 误拦重读。
 *
 * 防重维度：闭环内 + 同 toolName + 同主体语义（路径 + 读取区间 / query）。
 * 不防重：write_file / run_code / run_skill_script 等副作用型工具。
 *
 * 补充导出 `WRITE_PATH_EXTRACTORS`（非防重）：写工具**不防重**，但同一 step 内打在同一路径上的
 * 两次写**必须串行**（并行会因读旧快照而互相覆盖）。二者是同一批「副作用型工具」的两面。
 */
import path from 'node:path';
// PATH_WRITE_TOOL_NAMES：写工具名集真源（builtinTools 各定义行 `diskWrite:'path'` 声明派生）——
// 本模块只借其键集组装提取器表，不自存工具名清单。
import { PATH_WRITE_TOOL_NAMES } from '@/agent/builtinTools.js';
// 正整数解析单一真源（read_file 去重主体 offset/limit 与 builtinToolHandlers 分段预算同规）
import { positiveInt } from '@/utils/math.js';

/**
 * 去重主体：这次请求「要什么」的结构化表达 —— key 生成与失效匹配的唯一依据。
 *
 * `read_file` 的 `offset`/`limit` 与 handler 的区间解析**同语义**（缺省 / 非法 offset ≡ 1；
 * 缺省 / 非法 limit ≡ 读到末尾），故「`{path}`」与「`{path, offset:『1』}`」是**同一份主体** ——
 * 这是刻意的：二者在 handler 里读的确实是同一区间，若当成两个 key，真正的重复调用就会被放过。
 *
 * 证据落盘**不镜像**本字段面：`read_dedup_block` 证据由 loop 侧整体 spread 透传本接口实例
 * （`{ toolName, ...subject }`），roundStore 侧以开放式索引签名承载 —— 本接口增字段随透传自动落盘，
 * 两侧均零同步（`memory → agent` 类型禁向使 roundStore 无法 import 本类型，故不逐字段声明）。
 */
export interface DedupSubject {
  /** 文件 / 目录路径（read_file、list_dir）—— 已经过 `normalizePathKey`；**纯文件语义**，供覆盖度台账分支②按文件回显 */
  path?: string;
  /** 查询目标主定位（web_search.query / web_fetch.url / trace_summary.sessionId）—— query 槽统一承载"查什么" */
  query?: string;
  /** 子定位标识（trace_summary 的 roundId 等）：同一主定位下的细分目标，纳入去重 span，文案渲染为「主定位 · 子定位」 */
  item?: string;
  /** read_file 起始行（1-based；缺省 1） */
  offset?: number;
  /** read_file 行数上限（缺省 = 读到末尾） */
  limit?: number;
}

/** 去重主体生成器：从 toolCall 的 args 里提取稳定主体 */
export type DedupSubjectExtractor = (argsJson: string) => DedupSubject | undefined;

/** 缓存条目 */
export interface CacheEntry {
  /** 所属工具名（失效匹配用） */
  toolName: string;
  /** 本次请求主体（失效匹配 + 文案渲染用） */
  subject: DedupSubject;
  /** 首次缓存的迭代序号（用于日志 / 提示文案） */
  cachedAtIteration: number;
  /** 文件 / 目录 mtime（read_file/list_dir 有；web_search 等无） */
  fileMtime?: number;
  /** 首次执行产出该结果的那次工具调用 id（判定「结果是否仍在上下文」用） */
  toolCallId?: string;
  /** 进入上下文的最终内容指纹（同上比对；与 `wrapToolResult` 同口径计算） */
  fingerprint?: string;
}

/** `set` 的可选元信息 */
export interface CacheEntryMeta {
  fileMtime?: number;
  toolCallId?: string;
  fingerprint?: string;
}

/**
 * 路径去重规范化（纯字符串，不触磁盘）：统一分隔符 → 消除 `./`、`a//b`、`a/../b` → 去尾部 `/`。
 *
 * 只做「同一写法的等价归并」，**不解析绝对路径**（loop 不认文件系统，项目根属宿主）。
 * 因此 `a.md` 与 `/abs/a.md` 仍是不同主体 —— 这不是「残余漏洞」而是**保守语义**：
 * 无法确定二者是同一文件时就不该判为重复，判错方向的代价是死锁（见 loop 的拦截前提）。
 */
export function normalizePathKey(raw: string): string {
  const unified = raw.trim().replace(/\\/g, '/');
  const normalized = path.posix.normalize(unified);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** 安全解析 args JSON（非法 / 非对象 → undefined） */
function parseArgs(argsJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 取非空字符串字段（非字符串 / 空串 → undefined） */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** 内置去重主体生成器集合（SSOT：loop 注册防重拦截时引用） */
export const DEDUP_SUBJECT_EXTRACTORS: Readonly<Record<string, DedupSubjectExtractor>> = {
  /** read_file 主体 = 规范化路径 + 读取区间（区间语义与 handler 一致） */
  read_file: (argsJson) => {
    const a = parseArgs(argsJson);
    const rawPath = a ? nonEmptyString(a.path) : undefined;
    if (!rawPath) return undefined;
    return {
      path: normalizePathKey(rawPath),
      offset: positiveInt(a?.offset) ?? 1,
      limit: positiveInt(a?.limit),
    };
  },
  /** list_dir 主体 = 规范化路径 */
  list_dir: (argsJson) => {
    const a = parseArgs(argsJson);
    const rawPath = a ? nonEmptyString(a.path) : undefined;
    return rawPath ? { path: normalizePathKey(rawPath) } : undefined;
  },
  /** web_search 主体 = query（短时间内同 query 结果近似） */
  web_search: (argsJson) => {
    const a = parseArgs(argsJson);
    const query = a ? nonEmptyString(a.query) : undefined;
    return query ? { query } : undefined;
  },
  /** web_fetch 主体 = 规范化 URL（搜索→抓取闭环第二段；同 URL 抓取两次正文无增量） */
  web_fetch: (argsJson) => {
    const a = parseArgs(argsJson);
    const url = a ? nonEmptyString(a.url) : undefined;
    // URL 只做 trim 归一并滤空 —— 不做路径 normalize（避免 `..`/尾部斜杠误并不同 target）
    return url ? { query: url.trim() } : undefined;
  },
  /** trace_summary 主体 = sessionId（主定位，query 槽）+ roundId（可选子定位，item 槽）—— 同会话不同轮仍是合法增量读取 */
  trace_summary: (argsJson) => {
    const a = parseArgs(argsJson);
    const sessionId = a ? nonEmptyString(a.sessionId) : undefined;
    if (!sessionId) return undefined;
    const roundId = a ? nonEmptyString(a.roundId) : undefined;
    return { query: sessionId.trim(), item: roundId?.trim() };
  },
  /** search_memories 主体 = query（与 web_search 同构：只按检索词判重；追更多候选应换 query 或改用 trace_summary 精取） */
  search_memories: (argsJson) => {
    const a = parseArgs(argsJson);
    const query = a ? nonEmptyString(a.query) : undefined;
    return query ? { query } : undefined;
  },
};

/** 取「写路径」原始值（写工具的定位参数固定叫 `path`，与 read_file / list_dir 同名字段） */
function rawPathOf(argsJson: string): string | undefined {
  const a = parseArgs(argsJson);
  return a ? nonEmptyString(a.path) : undefined;
}

/**
 * 写路径提取器：**仅**覆盖「按 `args.path` 定位、会改盘」的工具。
 *
 * 用途单一：loop 判定「同一 step 内两次写是否打在同一文件上」，从而只对**同路径**串行。
 * 为何必须串行——`write_file` 是「读盘 → 改 → 写盘」，同 step 内并行发起时两次都基于同一份
 * 旧快照，后落地者覆盖先落地者 ⇒ **静默丢内容**（真机实证：`insert` + `append` 同 step 并行，
 * 插入的行被 append 覆盖）。
 *
 * 为何**单独**一份、不并入 `DEDUP_SUBJECT_EXTRACTORS`：那份是**防重**判据（命中即拦截），
 * 而写工具正是被防重**刻意排除**的对象（见文件头「不防重：write_file …」）——并入会让
 * 「同一文件分次追加」被误判为重复调用而拦掉，属语义反转。
 *
 * 键集 = **派生自** `builtinTools` 各定义行的 `diskWrite: 'path'` 声明（构造级单源，禁再
 * 独立枚举工具名）；值 = 共用的 `args.path` 提取语义（'path' 模式的定义即「目标 = args.path」）。
 * 路径规范化与去重同源（`normalizePathKey`）：路径等价语义只有这一套，不另造。
 */
export const WRITE_PATH_EXTRACTORS: Readonly<
  Record<string, (argsJson: string) => string | undefined>
> = Object.fromEntries(PATH_WRITE_TOOL_NAMES.map((name) => [name, extractArgsPathTarget]));

/** `'path'` 模式写工具的目标提取：`args.path` → 规范化路径（提取失败返回 undefined，调用方降级屏障） */
function extractArgsPathTarget(argsJson: string): string | undefined {
  const raw = rawPathOf(argsJson);
  return raw ? normalizePathKey(raw) : undefined;
}

/** 主体 → 缓存 key（本模块唯一的 key 构造点；用不可打印分隔符，避免与路径 / query / item 内容冲突） */
function keyOf(toolName: string, subject: DedupSubject): string {
  return [
    toolName,
    subject.path ?? '',
    subject.query ?? '',
    subject.item ?? '',
    subject.offset ?? '',
    subject.limit ?? '',
  ].join('\u0001');
}

/**
 * 主体 → 人类可读描述（拦截文案出口）。
 *
 * 文案面向 LLM，**不暴露内部 key 格式**：它需要知道的是「哪个文件的哪一段已经在你手上」。
 */
export function formatDedupSubject(toolName: string, subject: DedupSubject): string {
  // 查询/会话类主体（web_search / web_fetch / trace_summary）：主定位 + 可选子定位（session·round）
  if (subject.query !== undefined) {
    return subject.item !== undefined ? `${subject.query} · ${subject.item}` : subject.query;
  }
  // 文件类主体（read_file 渲染区间；list_dir 仅路径）
  if (subject.path !== undefined) {
    if (toolName !== 'read_file') return subject.path;
    const range =
      subject.limit !== undefined
        ? `第 ${subject.offset} 行起的 ${subject.limit} 行`
        : `第 ${subject.offset} 行起`;
    return `${subject.path} · ${range}`;
  }
  return '';
}

/**
 * 同主体聚合键（工具名 + 规范化 path/query/item），粒度 = 同参。
 *
 * **两个消费语境共用本函数**（SSOT）：① `read_failed` 的连续失败计数；
 * ② `read_dedup` 的撞墙升级计数。二者要的都是「工具 + 请求主体」这一个标识，
 * 故共用同一口径——各自另拼 key 会让两套计数对「同一主体」的理解悄悄分叉。
 *
 * 原子分隔符 `\u0002`：不可打印，避免与 path/query/item 的合法内容（文件路径、URL、会话 id）冲突。
 *
 * @param toolName 工具名
 * @param subject  请求主体（由 `DEDUP_SUBJECT_EXTRACTORS` 产出）
 */
export function failureSubjectKey(toolName: string, subject: DedupSubject): string {
  // item 纳入：trace_summary 同 sessionId 不同 roundId 计为不同主体，不把「任一 round 失败」误并到整个会话
  return `${toolName}\u0002${subject.path ?? ''}\u0002${subject.query ?? ''}\u0002${subject.item ?? ''}`;
}

/**
 * 闭环内工具结果防重缓存
 *
 * 只负责「同 tool + 同主体」的重复检测。mtime 放行不需要——
 * 文件被 write_file 修改后，loop 结果处理循环会主动 invalidate 同 path 的 read_file 缓存。
 * 比 statSync 更准确（同一 cwd/path 解析链路）、不依赖 projectPath 传递。
 */
export class ToolResultCache {
  /** Map<key, CacheEntry> */
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * 检查指定工具调用是否重复
   *
   * @param toolName 工具名（如 'read_file'）
   * @param subject  请求主体（由 `DEDUP_SUBJECT_EXTRACTORS` 产出）
   * @returns 已重复则返回首次缓存的条目；否则 undefined
   */
  check(toolName: string, subject: DedupSubject): CacheEntry | undefined {
    return this.cache.get(keyOf(toolName, subject));
  }

  /**
   * 失效指定 path 关联的 read_file 缓存（副作用型工具成功后调用，放行后续合法重读）
   *
   * 按 `subject.path` 匹配 —— **该文件所有读取区间一起失效**（文件内容变了，任何区间的旧结果都作废）。
   * `list_dir` 不失效：文件修改不改目录结构。
   *
   * @param rawPath 被修改 / 删除的文件路径
   */
  invalidateFile(rawPath: string): void {
    const target = normalizePathKey(rawPath);
    for (const [k, entry] of this.cache) {
      if (entry.toolName === 'read_file' && entry.subject.path === target) {
        this.cache.delete(k);
      }
    }
  }

  /**
   * 记录一次已执行的工具调用
   *
   * @param toolName  工具名
   * @param subject   请求主体
   * @param iteration 当前迭代序号（用于日志 / 提示文案）
   * @param meta      可选元信息（mtime / toolCallId / 内容指纹）
   */
  set(toolName: string, subject: DedupSubject, iteration: number, meta?: CacheEntryMeta): void {
    this.cache.set(keyOf(toolName, subject), {
      toolName,
      subject,
      cachedAtIteration: iteration,
      ...(meta?.fileMtime !== undefined ? { fileMtime: meta.fileMtime } : {}),
      ...(meta?.toolCallId !== undefined ? { toolCallId: meta.toolCallId } : {}),
      ...(meta?.fingerprint !== undefined ? { fingerprint: meta.fingerprint } : {}),
    });
  }

  /** 闭环结束清空（跨闭环不复用） */
  clear(): void {
    this.cache.clear();
  }

  /** 当前缓存条目数（调试 / 监控用） */
  get size(): number {
    return this.cache.size;
  }
}
