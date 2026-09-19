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
// SSOT：召回排除默认值下沉到 utils/recallDefaults（记忆层与 agent 层共享，避免两处定义），
// 消费方 MemoryAdvisor 直接 import 源头，agent 常量层不 re-export（2026-09-11 删僵尸 re-export）。

/**
 * Agent 门面层常量
 *
 * 用于 agent.ts 中的并发锁、输入限制、召回/上下文配置等。
 */
export const AGENT_CONSTANTS = {
  /**
   * chat() 并发锁超时。锁超时后仅自动释放锁（放行新对话），不中断生成流——
   * LLM 无进展由 provider 层兜底（请求级 120s + SSE 事件停滞 120s），锁不对整次对话时长设上限。
   */
  CHAT_LOCK_TIMEOUT_MS: 180_000,

  /** close() 关闭时等待归档完成的超时（毫秒）。 */
  SHUTDOWN_ARCHIVE_TIMEOUT_MS: 5_000,

  /** chat() 输入最大长度（字节）。128KB。 */
  CHAT_INPUT_MAX_LENGTH: 128 * 1024,

  /**
   * AgentConfig.maxContextTokens 默认值。120K tokens。
   * ⚠️ **本键为真源**；另有两处镜像须同步（分层约束不可 import，故按本仓既有做法「重复 + 注释对冲」）：
   * ① `src/config/loader.ts` 的 `DEFAULT_MAX_CONTEXT_TOKENS`；② `src/role-pack/strategyKeys.ts` 的 `MIN_CONTEXT_LIMIT`。
   */
  DEFAULT_MAX_CONTEXT_TOKENS: 120_000,

  /**
   * systemPrompt 时间注入的默认 locale（对齐"核心库领域无关"原则，可被 AssembleInput.locale 覆盖）。
   * 默认 'zh-CN' 是项目母语，宿主可注入其他 locale 实现国际化。
   */
  DEFAULT_LOCALE: 'zh-CN',

  /** 召回记忆数量上限。5 条记忆兼顾上下文窗口与召回质量。 */
  DEFAULT_RECALL_LIMIT: 5,

  /** 暂停超时阈值（毫秒）。30 分钟内无心跳则视为超时，自动归档清理。 */
  PAUSE_TIMEOUT_MS: 30 * 60 * 1000,

  /**
   * 孤儿 Round 垃圾回收周期（毫秒）。
   * 每天执行一次：清理 refCount=0 且超龄的孤立问答闭环（崩溃残留 pending / 已删会话遗留）。
   */
  GC_INTERVAL_MS: 24 * 60 * 60 * 1000,

  // ─── completedToolCalls FIFO 封顶 ─────────────────
  //
  // 工具执行日志无上限时，检查点序列化开销随会话寿命线性增长。
  // 48 条 ≈ 多回合工具调用上限，远超单回合调用量。
  // 截断策略：优先丢弃幂等工具的最早记录，非幂等永不丢弃。
  COMPLETED_TOOL_CALLS_MAX: 48,

  /**
   * 检查点结构版本（K1 持久化加固，2026-08-23；v2 2026-08-29）。
   *
   * SessionCheckpoint 序列化/反序列化版本标识。版本路由见 sessionManager.normalizeCheckpoint。
   * - v1：初始版本（无迁移映射）。
   * - v2：PlanStep 新增可选 rolePack（会议表层装配角色）——可选字段对旧检查点天然兼容
   *   （缺失即 undefined = 非会议），v1→v2 迁移为无操作（结构保持）。
   */
  CHECKPOINT_SCHEMA_VERSION: 2,
} as const;

/**
 * AgentLoop 引擎层常量
 *
 * 用于 loop.ts 中的 token 估算、召回上下文长度、LLM 重试、循环限制等。
 *
 * 注意：AgentLoop 构造选项中的默认值（maxIterations 兜底 DEFAULT_MAX_ITERATIONS 等）定义在
 * role-pack/strategyKeys.ts——这是角色包策略边界层的常量，agent→role-pack 单向依赖引用。
 * loop.ts runIterationLoop 入口动态计算 effectiveMax：角色包 stepBudget > 0 则覆盖，
 * 否则用 maxIterations 兜底。角色包配多少给多少，内核不 clamp。
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

  /**
   * 上下文截断时保留的窗口比例（**保留系数**：乘 `maxContextTokens` 得目标上限）。0.9 = 留 10% 缓冲。
   *
   * ⚠️ 与 `budget.ts` 的 `DEFAULT_OUTPUT_RESERVE_RATIO = 0.15` **不可直接比较**——两者基准不同、
   * 语法相反（同属「给模型回答的预留」，但阶段与依据均不同）：
   *   · 本常量（**截断线**）：`ContextManager.truncateMessages` 触发于 `token > maxContextTokens`，
   *     把 payload 压到 `maxContextTokens × 0.9`。基准 = **窗口总量**；语义 = **保留 90%**（乘法）。
   *   · `DEFAULT_OUTPUT_RESERVE_RATIO`（**装配线**）：`computeContextBudget` 的
   *     `可用 = 窗口 × (1 − 0.15) − 固定开销`。基准 = **窗口总量**；语义 = **预留 15%**（减法）。
   * 二者恰好互余（0.9 保留 ↔ 0.15 预留）纯属巧合，勿据此推导关联或试图统一。
   */
  CONTEXT_TOKENS_BUFFER_RATIO: 0.9,

  /**
   * 软上限检测：摘要层 token 占容量阈值比例。
   *
   * 当摘要层（含 Round summary / Compressed context 标记的消息）token 占用
   * 超过 maxContextTokens × SUMMARY_LAYER_TOKEN_RATIO 时，判定为"摘要层达容量上限"，
   * 触发软上限收尾信号让 LLM 收敛。
   *
   * 0.3 = 摘要层占 30% 容量即触发，配合 CONTEXT_TOKENS_BUFFER_RATIO=0.9
   * 使用：总上下文逼近上限 + 摘要层占比过高 → 注入软上限。
   */
  SUMMARY_LAYER_TOKEN_RATIO: 0.3,

  /**
   * 单条工具结果进入上下文的最大 token 数（≈ 上下文窗口的 5%）。6,000。
   *
   * **同源红线（一个键，三处引用，且只按 token 判定）**：
   *   · **不变量**：任何进入上下文的单条 tool 消息（**含 `wrapToolResult` 包裹**）≤ 本键；
   *   · `read_file` 分段预算 = 本键 − `TOOL_RESULT_WRAP_OVERHEAD_TOKENS`（生产者侧扣包裹开销）；
   *   · 入口关落盘判据 = `estimateTokensText(content) > 本键`（`loop.appendToolMessage`，
   *     content 即 wrapped 后待入上下文的内容）。
   * 判据是**严格大于**，而 `read_file` 产出（含包裹）恒 ≤ 本键 → `read_file` **结构性不落盘**，
   * 回取 offload 产物时不会再次落盘 → **无限嵌套不可能**。若本键被调到低于 read_file 产出口径、
   * 或 read_file 预算不再扣包裹余量，读回产物即再次超阈 → 再落盘 → 拿到新路径 → 循环；
   * `ToolResultCache` 拦不住这种嵌套（产物文件名含时间戳与随机串，每次去重 key 都不同）。
   *
   * ⚠️ 故本键**不可**改写成「24,000 字符」这类字符数限额 —— 同一字符数在中英文下 token 数
   * 相差近 2 倍（CJK `CJK_CHARS_PER_TOKEN=1.5` vs 其他 `CHARS_PER_TOKEN=3`），按字符限额必然
   * 让其中一侧实际越界。字符只是 token 的估算输入，不是限额本身。
   */
  SINGLE_TOOL_RESULT_MAX_TOKENS: 6_000,

  /**
   * `wrapToolResult` 包裹模板的 token 开销预留（含工具名）。
   *
   * `read_file` 的分段预算 = `SINGLE_TOOL_RESULT_MAX_TOKENS` − 本键，使**含包裹**的输出仍 ≤ 单条上限
   * （不变量在生产者侧成立）。实测模板固定开销 ≈30 tokens（两行 ASCII 标签 + 一句 26 字中文提示）
   * + 工具名（≤ 十余字符），100 已宽裕覆盖超长自定义工具名。
   *
   * ⚠️ 扣除方向不可反：若 `read_file` 直接以 `SINGLE_TOOL_RESULT_MAX_TOKENS` 作预算，其 wrapped 输出
   * 会超出单条上限 → 被入口关落盘 → LLM 每次读文件只看得到路径（荒谬行为，且无测试会红）。
   */
  TOOL_RESULT_WRAP_OVERHEAD_TOKENS: 100,

  /**
   * `search_memories` 工具响应性护栏：整次关键词搜索的上限。
   *
   * 背景：搜索服务为网络调用（web/project search）时以 30s 超时为先例（webSearchProvider.ts），
   * 本地记忆搜索更快，故收窄为 5s——超时降级为提示文案而非挂死工具。
   */
  MEMORY_SEARCH_TIMEOUT_MS: 5_000,

  /**
   * 情报区（LLM 私有工作笔记，大文本统一通道 Step 2）字符数上限。
   *
   * LLM 经 `remember_intel` 自写的私有笔记累积；超限裁最旧（保留最新）。这是**数据上限**
   * （防单 turn 内多次写入把笔记撑爆），**不是预算维度** —— 情报区仍作为尾部 system 消息
   * 参与现有 `truncateMessages` 窗口淘汰（锚点 C：不新增第 5 个预算维度）。
   */
  MAX_INTEL_PREFIX_LEN: 4_000,

  /** 摘要缓存 TTL：消息数增长超过此值时缓存过期，需重新生成摘要。 */
  SUMMARY_CACHE_TTL_MSGS: 10,

  /** 流式中断的默认追加标记（SSOT）：含断点摘要，让 LLM 明确"以上已输出，请继续不重复"。
   * loop（流式响应中断）与 orchestrator（历史写入中断标记）必须用同一份默认文案，
   * 避免宿主未注入 messages 时两条路径降级出不同文案（此前 orchestrator 回退为短" [已中断]"）。
   */
  DEFAULT_INTERRUPTED_MARK:
    '\n\n[已中断]\n\n[断点摘要：以上内容已输出到 LLM，请在此基础上继续回答，不要重复已输出的内容]',

  /** 达到最大迭代/步数预算的默认追加标记（SSOT）：loop 的撞线收尾文案默认值，
   *  宿主可经 messages.maxIterationsReached 覆盖（与 DEFAULT_INTERRUPTED_MARK 同族文案）。 */
  DEFAULT_MAX_ITERATIONS_REACHED_MARK: '\n\n[Max iterations reached]',

  /**
   * 上下文预算预警提示（T3 2026-09-01）：容量逼近警戒线但摘要层未饱和时注入的温和提示，
   * 引导 LLM 主动压缩 / 收敛——软上限（收尾信号）的前一级。低压通用文案不走 UIMessages 覆盖层，
   * 如需宿主定制可后续升级（与 softLimitWrapup 同族，但非高频行为文案）。
   */
  CONTEXT_PRESSURE_HINT:
    '## 上下文空间提示\n' +
    '当前上下文已接近容量上限。若后续步骤需要更多空间，可调用 compress_context 压缩较早 turn' +
    '或超大工具结果；同时注意收敛回答篇幅，避免无谓展开。',

  /**
   * TS-7 搜索收敛护栏（2026-09-02 实测：LLM 连续成功联网搜索 10+ 次不收敛，Bing 结果泛泛仍反复搜）
   * 单 turn（问答闭环）内成功 web_search 次数达到此阈值后，注入收敛提示引导 LLM 停止搜索直接作答。
   * 计入成功（ok=true）与连续轮次无关——一次工具步内并行多个搜索按多次计。
   */
  SEARCH_CONVERGENCE_THRESHOLD: 2,

  /** TS-7 搜索收敛提示（executionTemp 幂等：一轮内仅注入一次，下一闭环入口即弃） */
  SEARCH_CONVERGENCE_HINT:
    '## 搜索收敛提示\n' +
    '你已成功执行多次联网搜索并获取了可用信息。若现有信息已足够支撑回答，请停止继续搜索，' +
    '直接基于已有信息作答；仅当存在明确信息缺口（如用户指定查询的最新数据确实缺失）时才继续搜索。',

  /**
   * TS-7 搜索硬上限（2026-09-02 升级：实测软提示未能阻止 LLM 持续重搜，改用确定性拒绝）
   * 单 turn（问答闭环）内 web_search 调用次数超过此数后，后续搜索执行时直接拒绝并回填拒绝文案，
   * 不依赖 LLM 听从软提示——软提示引导收敛（< 上限时），硬限兜底（达到上限强制停）。
   */
  MAX_WEB_SEARCH_CALLS: 6,

  /**
   * 工具调用导语纪律（2026-09-02，分区式 UI 配套）：正文只承载最终交付，工具步的过程叙述
   * 由内核 narrate 事件投影进过程区。约束模型在调用工具前不输出长段规划——长导语若发生在
   * 首轮工具步（消息级分类前）会逐字混入正文，压到一句话可把残余影响降至可忽略。
   * 随「可用工具」节一起注入，无工具定义时（纯对话角色）不出现。
   */
  TOOL_NARRATION_DISCIPLINE:
    '## 协作规范\n' +
    '- 调用工具前若要说明意图，最多一句话（例如「先检索相关资料」）；不要在调用工具前输出长篇规划或过程叙述。\n' +
    '- 工具执行完毕后，基于全部结果输出最终回答；完整的分析、解释与结论只在最终回答中展开。',

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
