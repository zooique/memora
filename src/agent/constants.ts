/**
 * Agent 模块常量集合
 *
 * 集中管理 agent.ts 与 loop.ts 中的 magic numbers，便于统一调整与审查。
 * 按模块分两个命名空间，不创建全局 constants（避免垃圾桶反模式）。
 *
 * 10 个 magic number 分布在 2 文件，已达提取阈值，故集中提取。
 */

// 上下文预算装配后，最近对话注入轮数由预算动态派生（见 budget.ts / contextPreparer.ts），
// agent 常量层不再持有固定轮数默认。
// SSOT：召回排除默认值下沉到 utils/recallDefaults（记忆层与 agent 层共享，避免两处定义）
import { DEFAULT_RECALL_EXCLUDE_SOURCES } from '@/utils/recallDefaults.js';

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

  /** recallExcludeSources 默认值——设定记忆已归角色包，不再参与召回排除（常量下沉 utils 共享）。 */
  DEFAULT_RECALL_EXCLUDE_SOURCES,

  /**
   * systemPrompt 时间注入的默认 locale（对齐"核心库领域无关"原则，可被 AssembleInput.locale 覆盖）。
   * 默认 'zh-CN' 是项目母语，宿主可注入其他 locale 实现国际化。
   */
  DEFAULT_LOCALE: 'zh-CN',

  /** 召回记忆数量上限。5 条记忆兼顾上下文窗口与召回质量。 */
  DEFAULT_RECALL_LIMIT: 5,

  /** 暂停超时阈值（毫秒）。30 分钟内无心跳则视为超时，自动归档清理。 */
  PAUSE_TIMEOUT_MS: 30 * 60 * 1000,

  // ─── 热记忆截断策略 ─────────────────────────────

  /**
   * 热记忆最大对话轮数。20 轮 ≈ 40 条消息 ≈ 8K-12K tokens。
   * 超过此窗口的早期上下文走温记忆召回。
   */
  HOT_MEMORY_MAX_ROUNDS: 20,

  /**
   * 热记忆单条消息内容截断长度。防止超长消息（如大段代码）撑爆检查点。
   * 500 字符 ≈ 200-350 tokens，覆盖大多数正常对话消息。
   */
  HOT_MEMORY_CONTENT_SLICE: 500,

  // ─── completedToolCalls FIFO 封顶 ─────────────────
  //
  // 工具执行日志无上限时，检查点序列化开销随会话寿命线性增长。
  // 48 条 ≈ 多回合工具调用上限，远超单回合调用量。
  // 截断策略：优先丢弃幂等工具的最早记录，非幂等永不丢弃。
  COMPLETED_TOOL_CALLS_MAX: 48,

  /**
   * 检查点结构版本（K1 持久化加固，2026-08-23）。
   *
   * SessionCheckpoint 序列化/反序列化版本标识：当前 v1 为初始版本（无迁移映射，
   * 未来结构演进升 v2 时补迁移函数）。版本路由见 sessionManager.parseCheckpoint。
   */
  CHECKPOINT_SCHEMA_VERSION: 1,
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

  /**
   * Token 预算耗尽占位文本（SSOT）：会话/汇报在上下文预算触顶时的兜底输出。
   * orchestrator 需以此判定"无实质收尾"（走回退摘要而非当作真实内容），故集中于此。
   */
  TOKEN_BUDGET_REACHED_PLACEHOLDER: '[Token budget reached]',

  /**
   * 流式中断的默认追加标记（SSOT）：含断点摘要，让 LLM 明确"以上已输出，请继续不重复"。
   * loop（流式响应中断）与 orchestrator（历史写入中断标记）必须用同一份默认文案，
   * 避免宿主未注入 messages 时两条路径降级出不同文案（此前 orchestrator 回退为短" [已中断]"）。
   */
  DEFAULT_INTERRUPTED_MARK:
    '\n\n[已中断]\n\n[断点摘要：以上内容已输出到 LLM，请在此基础上继续回答，不要重复已输出的内容]',

  /** 上下文摘要：参与摘要的最近消息条数。 */
  SUMMARY_MSG_COUNT: 6,

  /** 上下文摘要：单条消息内容截断长度（字符）。 */
  SUMMARY_CONTENT_SLICE: 200,

  /** 上下文摘要：LLM 调用 maxTokens 参数。 */
  SUMMARY_MAX_TOKENS: 150,

  /**
   * 任务分类启发式：用户消息超过此长度（字符）判定为 'reasoning'。
   *
   * 原 loop.determineTaskType 内的魔法数 500 归入内核常数。
   * 注意这是内核启发式阈值，不属于角色包可影响的 L2 策略维度——任务类型分类是
   * Provider 路由（影响成本）的内部决策，不开放给角色包配置（避免"策略全景物化"）。
   */
  REASONING_INPUT_CHARS: 500,

  /**
   * 任务分类检测窗口：determineTaskType 从后向前取最近 N 条 user 消息做代码块检测，
   * 避免多轮对话中"含代码的请求不在最后一条"被误判为 simple（错配 Provider 成本失真）。
   * 长文本（reasoning）判定仍以最近一条 user 消息为准（反映当前轮意图）。
   */
  TASK_TYPE_WINDOW: 3,
} as const;
