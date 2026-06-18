/**
 * Agent 模块常量集合
 *
 * 集中管理 agent.ts 与 loop.ts 中的 magic numbers，便于统一调整与审查。
 * 按模块分两个命名空间，不创建全局 constants（避免垃圾桶反模式）。
 *
 * 触发提取的决策记录：A-006（原"暂缓"判断已失效——10 个 magic number 分布在 2 文件，已达提取阈值）。
 */

/**
 * Agent 门面层常量
 *
 * 用于 agent.ts 中的并发锁、输入限制、记忆衰减周期等。
 */
export const AGENT_CONSTANTS = {
  /** chat() 并发锁超时（毫秒）。超时后中断 generator 并释放锁。 */
  CHAT_LOCK_TIMEOUT_MS: 300_000,

  /** chat() 输入最大长度（字节）。128KB。 */
  CHAT_INPUT_MAX_LENGTH: 128 * 1024,

  /** 记忆衰减执行间隔（毫秒）。1 小时。 */
  DECAY_INTERVAL_MS: 3_600_000,

  /** AgentConfig.maxContextTokens 默认值。120K tokens。 */
  DEFAULT_MAX_CONTEXT_TOKENS: 120_000,

  /** recallExcludeSources 默认值——永久记忆不参与增量召回。 */
  DEFAULT_RECALL_EXCLUDE_SOURCES: ['persona', 'rule', 'skill'] as const,
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
  /** 粗略 token 估算：每 token 约 3 字符（非精确 tokenizer）。 */
  CHARS_PER_TOKEN: 3,

  /** 召回记忆注入到上下文的最大字符数。超出会截断。 */
  RECALL_CONTEXT_MAX_CHARS: 2000,

  /** LLM 调用最大重试次数（不含首次调用）。 */
  MAX_LLM_RETRIES: 2,

  /** LLM 重试基础延迟（毫秒），指数退避 base。 */
  RETRY_BASE_DELAY_MS: 1000,

  /** 上下文截断时给 LLM 响应预留的缓冲比例。0.9 = 留 10% 给响应。 */
  CONTEXT_TOKENS_BUFFER_RATIO: 0.9,
} as const;
