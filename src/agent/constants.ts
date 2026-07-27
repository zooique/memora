/**
 * Agent 模块常量集合
 *
 * 集中管理 agent.ts 与 loop.ts 中的 magic numbers，便于统一调整与审查。
 * 按模块分两个命名空间，不创建全局 constants（避免垃圾桶反模式）。
 *
 * 10 个 magic number 分布在 2 文件，已达提取阈值，故集中提取。
 */

/**
 * Agent 门面层常量
 *
 * 用于 agent.ts 中的并发锁、输入限制、记忆衰减周期等。
 */
export const AGENT_CONSTANTS = {
  /**
   * chat() 并发锁超时（毫秒）。超时后中断 generator 并释放锁。
   *
   * 取 180s（LLM 120s + 60s 缓冲），与超时体系匹配，作为所有超时失败后的最后兜底：
   * - chunk 级读超时 30s（openaiCompatible parseSseStream）
   * - LLM 请求超时 120s（LLM_TIMEOUT_MS）
   * - 宿主层无进展兜底 60s（chatHandlers STREAM_NO_PROGRESS_TIMEOUT_MS）
   */
  CHAT_LOCK_TIMEOUT_MS: 180_000,

  /** close() 关闭时等待归档完成的超时（毫秒）。 */
  SHUTDOWN_ARCHIVE_TIMEOUT_MS: 5_000,

  /** chat() 输入最大长度（字节）。128KB。 */
  CHAT_INPUT_MAX_LENGTH: 128 * 1024,

  /** 记忆衰减执行间隔（毫秒）。1 小时。 */
  DECAY_INTERVAL_MS: 3_600_000,

  /** AgentConfig.maxContextTokens 默认值。120K tokens。 */
  DEFAULT_MAX_CONTEXT_TOKENS: 120_000,

  /** recallExcludeSources 默认值——永久记忆不参与增量召回。 */
  DEFAULT_RECALL_EXCLUDE_SOURCES: ['persona', 'rule', 'skill'] as const,

  /**
   * systemPrompt 时间注入的默认 locale（对齐"核心库领域无关"原则，可被 AssembleInput.locale 覆盖）。
   * 默认 'zh-CN' 是项目母语，宿主可注入其他 locale 实现国际化。
   */
  DEFAULT_LOCALE: 'zh-CN',

  /** 召回记忆数量上限。5 条记忆兼顾上下文窗口与召回质量。 */
  DEFAULT_RECALL_LIMIT: 5,

  /** 最近对话历史注入轮数。3 轮（3 条 user + 3 条 assistant）。 */
  DEFAULT_RECENT_HISTORY_ROUNDS: 3,

  /** 默认数据目录（未通过 AgentOptions.dataDir 指定时使用）。 */
  DEFAULT_DATA_DIR: '~/.memora',
} as const;

/**
 * AgentLoop 引擎层常量
 *
 * 用于 loop.ts 中的 token 估算、召回上下文长度、LLM 重试、循环限制等。
 *
 * 注意：AgentLoop 构造选项中的默认值（maxIterations ?? 20 等）保留在 loop.ts 原地，
 * 因为它们是 API 契约的一部分——调用方期望"未传入时使用默认值"。
 * 这里只提取与 UI/重试/估算相关的纯常量。
 */
export const LOOP_CONSTANTS = {
  /**
   * 粗略 token 估算：每 token 约 3 字符（非精确 tokenizer）。
   *
   * 用于非 CJK 字符（英文/数字/符号）的 token 估算。
   * CJK 字符（中文/日文/韩文）使用 CJK_CHARS_PER_TOKEN 单独估算。
   */
  CHARS_PER_TOKEN: 3,

  /**
   * CJK 字符 token 估算密度（中文适配）
   *
   * CJK 字符在主流 LLM tokenizer 中约 1 字符 ≈ 1-2 tokens，
   * 取 1.5 作为保守中间值（偏高估算，避免上下文溢出）。
   *
   * 中文 4 字符 ≈ 2.7 token（接近真实值 4-8 token），
   * 统一用 CHARS_PER_TOKEN=3 估算会严重低估（4 字符 ≈ 1.3 token）。
   *
   * CJK 范围：U+3400-U+9FFF（统一表意文字 + 扩展A）+ U+3040-U+30FF（日文）+ U+AC00-U+D7AF（韩文）
   */
  CJK_CHARS_PER_TOKEN: 1.5,

  /** LLM 调用最大重试次数（不含首次调用）。 */
  MAX_LLM_RETRIES: 2,

  /** LLM 重试基础延迟（毫秒），指数退避 base。 */
  RETRY_BASE_DELAY_MS: 1000,

  /** 单次 LLM 请求超时（毫秒）。120 秒。超时后可重试。 */
  LLM_TIMEOUT_MS: 120_000,

  /** 上下文截断时给 LLM 响应预留的缓冲比例。0.9 = 留 10% 给响应。 */
  CONTEXT_TOKENS_BUFFER_RATIO: 0.9,

  /** 摘要缓存 TTL：消息数增长超过此值时缓存过期，需重新生成摘要。 */
  SUMMARY_CACHE_TTL_MSGS: 10,

  /** 召回记忆内容注入上下文时的截断长度（字符）。 */
  RECALL_CONTENT_SLICE: 200,

  /** 上下文摘要：参与摘要的最近消息条数。 */
  SUMMARY_MSG_COUNT: 6,

  /** 上下文摘要：单条消息内容截断长度（字符）。 */
  SUMMARY_CONTENT_SLICE: 200,

  /** 上下文摘要：LLM 调用 maxTokens 参数。 */
  SUMMARY_MAX_TOKENS: 150,
} as const;
