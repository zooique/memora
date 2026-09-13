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
 */
import path from 'node:path';

/**
 * 去重主体：这次请求「要什么」的结构化表达 —— key 生成与失效匹配的唯一依据。
 *
 * `read_file` 的 `offset`/`limit` 与 handler 的区间解析**同语义**（缺省 / 非法 offset ≡ 1；
 * 缺省 / 非法 limit ≡ 读到末尾），故「`{path}`」与「`{path, offset:『1』}`」是**同一份主体** ——
 * 这是刻意的：二者在 handler 里读的确实是同一区间，若当成两个 key，真正的重复调用就会被放过。
 */
export interface DedupSubject {
  /** 文件 / 目录路径（read_file、list_dir）—— 已经过 `normalizePathKey` */
  path?: string;
  /** 检索词（web_search） */
  query?: string;
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

/** 正整数解析（缺省 / 非法 / <1 → undefined）—— 与 `builtinToolHandlers.parsePositiveInt` 同规则 */
function positiveInt(raw: unknown): number | undefined {
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const n = Number.parseInt(String(raw), 10);
  return Number.isNaN(n) || n < 1 ? undefined : n;
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
};

/** 主体 → 缓存 key（本模块唯一的 key 构造点；用不可打印分隔符，避免与路径 / query 内容冲突） */
function keyOf(toolName: string, subject: DedupSubject): string {
  return [
    toolName,
    subject.path ?? '',
    subject.query ?? '',
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
  if (subject.path !== undefined) {
    if (toolName !== 'read_file') return subject.path;
    const range =
      subject.limit !== undefined
        ? `第 ${subject.offset} 行起的 ${subject.limit} 行`
        : `第 ${subject.offset} 行起`;
    return `${subject.path} · ${range}`;
  }
  return subject.query ?? '';
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
