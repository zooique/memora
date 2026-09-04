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
 * 防重维度：闭环内 + 同 toolName + 同去重 key。
 * 不防重：write_file / run_code / run_skill_script 等副作用型工具。
 */

/** 缓存条目 */
interface CacheEntry {
  /** 首次缓存的迭代序号（用于日志/提示文案） */
  cachedAtIteration: number;
  /** 文件/目录 mtime（read_file/list_dir 有；web_search 等无） */
  fileMtime?: number;
}

/** 防重工具的"去重 key"生成器：从 toolCall 的 args 里提取稳定标识 */
export type DedupKeyExtractor = (argsJson: string) => string | undefined;

/** 内置去重 key 生成器集合（SSOT：loop 注册防重拦截时引用） */
export const DEDUP_KEY_EXTRACTORS: Readonly<Record<string, DedupKeyExtractor>> = {
  /** read_file 去重 key = 规范化后的绝对路径（内置：同 path 即同文件） */
  read_file: (argsJson) => {
    try {
      const a = JSON.parse(argsJson) as { path?: string };
      return a.path ? a.path : undefined;
    } catch {
      return undefined;
    }
  },
  /** list_dir 去重 key = 规范化后的绝对路径 */
  list_dir: (argsJson) => {
    try {
      const a = JSON.parse(argsJson) as { path?: string };
      return a.path ? a.path : undefined;
    } catch {
      return undefined;
    }
  },
  /** web_search 去重 key = query（短时间内同 query 结果近似） */
  web_search: (argsJson) => {
    try {
      const a = JSON.parse(argsJson) as { query?: string };
      return a.query ? a.query : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * 闭环内工具结果防重缓存
 *
 * 只负责"同 tool + 同去重 key"的重复检测。mtime 放行不需要——
 * 文件被 write_file 修改后，loop 结果处理循环会主动 invalidate 同 path 的 read_file 缓存。
 * 比 statSync 更准确（同一 cwd/path 解析链路）、不依赖 projectPath 传递。
 */
export class ToolResultCache {
  /** Map<`toolName:dedupKey`, CacheEntry> */
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * 检查指定工具调用是否重复
   *
   * @param toolName 工具名（如 'read_file'）
   * @param dedupKey 去重 key（如 path 或 query）
   * @returns 已重复则返回首次缓存的条目；否则 undefined
   */
  check(toolName: string, dedupKey: string): CacheEntry | undefined {
    return this.cache.get(`${toolName}:${dedupKey}`);
  }

  /**
   * 失效指定 path 关联的缓存条目（副作用型工具成功后调用，放行后续合法重读）
   *
   * @param path 被修改/删除的文件路径
   */
  invalidateFile(path: string): void {
    // write_file/delete_file 成功 → 失效同 path 的 read_file 和 list_dir 缓存
    this.cache.delete(`read_file:${path}`);
    // list_dir 缓存 key 是目录路径，文件修改不影响目录结构 → 不失效
  }

  /**
   * 记录一次已执行的工具调用
   *
   * @param toolName        工具名
   * @param dedupKey        去重 key
   * @param iteration       当前迭代序号（用于日志/提示文案）
   * @param fileMtime       文件/目录 mtime（可选；read_file/list_dir 传入，web_search 不传）
   */
  set(toolName: string, dedupKey: string, iteration: number, fileMtime?: number): void {
    this.cache.set(`${toolName}:${dedupKey}`, { cachedAtIteration: iteration, fileMtime });
  }

  /** 闭环结束清空（跨闭环不复用） */
  clear(): void {
    this.cache.clear();
  }

  /** 当前缓存条目数（调试/监控用） */
  get size(): number {
    return this.cache.size;
  }
}
