/**
 * Agent 模块常量集合
 *
 * 集中管理 agent.ts 与 loop.ts 中的 magic numbers，便于统一调整与审查。
 * 按模块分两个命名空间，不创建全局 constants（避免垃圾桶反模式）。
 *
 * 10 个 magic number 分布在 2 文件，已达提取阈值，故集中提取。
 */

// SSOT：最近固定加载轮数默认值下沉到 role-pack/types（策略层级默认真理源），
// agent 层引用而非重新定义，避免同一维度出现两套平行默认值（见 resolveRecentRounds）。
import { DEFAULT_RECENT_HISTORY_ROUNDS } from '@/role-pack/types.js';

/**
 * Agent 门面层常量
 *
 * 用于 agent.ts 中的并发锁、输入限制、记忆衰减周期等。
 */
export const AGENT_CONSTANTS = {
  /**
   * chat() 并发锁超时。180s = LLM 120s + 60s 缓冲，作为所有超时后的最后兜底。
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

  /** recallExcludeSources 默认值——设定记忆已归角色包，不再参与召回排除。 */
  DEFAULT_RECALL_EXCLUDE_SOURCES: [] as const,

  /**
   * systemPrompt 时间注入的默认 locale（对齐"核心库领域无关"原则，可被 AssembleInput.locale 覆盖）。
   * 默认 'zh-CN' 是项目母语，宿主可注入其他 locale 实现国际化。
   */
  DEFAULT_LOCALE: 'zh-CN',

  /** 召回记忆数量上限。5 条记忆兼顾上下文窗口与召回质量。 */
  DEFAULT_RECALL_LIMIT: 5,

  /**
   * 最近对话历史注入轮数（SSOT）：引用 role-pack 内核默认（单一默认真理源）。
   * 角色包可经 prepare.recentRounds 覆盖；互斥窗口与最近对话注入由
   * resolveRecentRounds(strategy) 统一解析，本常量仅作未配置/非法时的兜底。
   */
  DEFAULT_RECENT_HISTORY_ROUNDS,

  /** 暂停超时阈值（毫秒）。30 分钟内无心跳则视为超时，自动归档清理。 */
  PAUSE_TIMEOUT_MS: 30 * 60 * 1000,

  // ─── P2.2：热记忆截断策略 ─────────────────────────────

  /**
   * 热记忆最大对话轮数。20 轮 ≈ 40 条消息 ≈ 8K-12K tokens。
   * 超过此窗口的早期上下文走温记忆召回（P2.1 恢复协议）。
   */
  HOT_MEMORY_MAX_ROUNDS: 20,

  /**
   * 热记忆单条消息内容截断长度。防止超长消息（如大段代码）撑爆检查点。
   * 500 字符 ≈ 200-350 tokens，覆盖大多数正常对话消息。
   */
  HOT_MEMORY_CONTENT_SLICE: 500,

  // ─── T2：completedToolCalls FIFO 封顶 ─────────────────
  //
  // 工具执行日志无上限时，检查点序列化开销随会话寿命线性增长。
  // 48 条 ≈ 多回合工具调用上限，远超单回合调用量。
  // 截断策略：优先丢弃幂等工具的最早记录，非幂等永不丢弃（P1-1 补偿降级后不再检查 compensatedAt）。
  COMPLETED_TOOL_CALLS_MAX: 48,

  // ─── P1-4：检查点 schema 版本（未来兼容公共前提）───
  //
  // 检查点以 SQLite 单 TEXT 列全量覆盖存储，无版本号时字段重命名/跨版本升级
  // 必然爆（F2-1 的字段缺失场景会在下一次重命名爆发）。本常量标记当前内核的
  // 检查点结构版本，`createCheckpoint` 写入、`parseCheckpoint` 比对。
  //
  // 迁移规则首版仅占位：高于当前版本的旧检查点按当前版本尽力恢复并 warn，
  // 不做阻断（避免丢弃用户工作）；真正的版本化迁移逻辑未来按版本分支在此展开。
  CURRENT_SCHEMA_VERSION: 1,
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

  /**
   * 任务分类启发式：用户消息超过此长度（字符）判定为 'reasoning'。
   *
   * T3 收敛（2026-08-19）：原 loop.determineTaskType 内的魔法数 500 归入内核常数。
   * 注意这是内核启发式阈值，不属于角色包可影响的 L2 策略维度——任务类型分类是
   * Provider 路由（影响成本）的内部决策，不开放给角色包配置（避免"策略全景物化"，
   * 见 memora-polish-roadmap T3）。
   */
  REASONING_INPUT_CHARS: 500,
} as const;
