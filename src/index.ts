/**
 * Memora — 通用 Agent 纯逻辑库（Node.js，零 native 依赖）
 * 公共导出面：宿主项目通过本入口 import 接入；持久化/搜索/会话等宿主能力均经接口注入。
 * 导出面口径（2026-10-06 收敛定案）：只收「宿主生产/测试消费」或「README / docs/memora-api-reference.md §十六
 * 明文承诺」的符号；其余一律为内部实现，不挂公共面（新增导出前先过这两条判据）。
 * 类型依赖方向单向（agent → memory → utils；agent → llm；agent → security），详见 module-inventory.md。
 */

// ─── 库导出：供宿主项目 import 接入 ──────────────────────
export { Agent } from '@/agent/agent.js';
export type {
  AgentChunk,
  ThinkingPhase,
  LlmErrorCategory,
  UIMessages,
  ArchiveMode,
  AgentOptions,
  AgentContext,
} from '@/agent/types.js';
export { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@/agent/constants.js';
// 上下文窗口解析（单一真理源公式）：宿主在构造 Agent 前将 provider.contextWindow 与
// 用户全局上限解析为单一 maxContextTokens 数字，避免跨宿主镜像 min 逻辑
export { resolveContextWindow } from '@/agent/budget.js';
// 上下文占用快照组装（SSOT 单点）：宿主历史会话重算占用时与内核 prepare 共用同一收敛口径
export { estimateOccupancy } from '@/agent/budget.js';
// token 估算（CJK 感知，零状态纯函数）：消息序列口径（先累计后取整，与运行时 prepare 同源），
// 宿主历史会话重算占用用它；单段文本估算 estimateTokensText 为内部实现，不挂公共面
export { estimateTokensMessages } from '@/agent/contextManager.js';
export { type AgentForkResult } from '@/agent/managers/sessionManager.js';
// 第二级压缩的中文标签（宿主 notice 文案真源）：
// 宿主**不得**自己写 target→文案映射——三元/else 在枚举增补时会把新值静默落到旧标签上
// （对用户说谎），而 `Record<CompressTarget, string>` 穷尽键在增补时编译期报错。
export { COMPRESS_TARGET_LABELS, type CompressTarget } from '@/agent/loop.js';
export type { SessionManager } from '@/agent/managers/sessionManager.js';
export type {
  ToolDefinition,
  ToolHandler,
  ToolContext,
  WriteExtensions,
} from '@/agent/toolExecutor.js';
// WRITE_PATH_EXTRACTORS：「按 args.path 改盘的工具」清单的**单一真理源**（loop 同路径写串行闸的判据）。
// 宿主改动追踪（fileChangeTracker）据其 keys 派生触发集合，禁并列维护第二份清单——
// 内核新增按 path 的写工具时宿主自动跟随，防「内核进串行闸、宿主不知情」的静默少报。
export { WRITE_PATH_EXTRACTORS } from '@/agent/toolResultCache.js';
// OPAQUE_WRITE_TOOL_NAMES：目标不可静态定位的写工具（脚本/内部索引类，diskWrite:'opaque'）。
// 宿主改动可视化对其做「执行前后目录快照 diff」收口（见 fileChangeTracker.noteExternalMutations），
// 禁并列维护第二份清单（两份必漂移 = 脚本类改动静默不追踪）。
export { OPAQUE_WRITE_TOOL_NAMES } from '@/agent/builtinTools.js';
// 角色包（Role Pack）：文件夹形态（manifest.json 核心控制 + 独立内容文件）。
// 只挂宿主/文档消费的两个装配结果类型；策略/团队/能力等子类型随签名推断可用，为内部实现
export type { RolePackMeta, RolePackAssembly } from '@/role-pack/types.js';
export { BUILTIN_FALLBACK_PACK, MAX_TEAM_MEMBERS } from '@/role-pack/constants.js';
export { RolePackManager } from '@/role-pack/rolePackManager.js';
// UI 键面唯一来源：宿主角色编辑 UI 从这里取键名/控件形态/值域，禁自维护键清单副本
export { describeStrategyKeys } from '@/role-pack/strategyKeys.js';
export type { StrategyKeyFace } from '@/role-pack/strategyKeys.js';
// 角色包格式校验器：manifest.json 唯一核心控制文件 + companion 内容红线检测
// （宿主保存前校验入口，宿主不重写判据——方案-角色包编辑UI / role-pack-validation-flow 承诺面）
export { validateManifest, validateManifestText } from '@/role-pack/validator.js';
export type {
  MemoryInspector,
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
} from '@/agent/managers/memoryInspector.js';
export { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
export { WorkProjectionManager } from '@/agent/managers/workProjection.js';
export type { WorkProjectionEntry } from '@/agent/managers/workProjection.js';
// accumulateStream: 宿主可复用的 LLM 流式响应累积工具（用于生成标题、描述等短文本）
export { accumulateStream } from '@/agent/managers/streamAccumulator.js';
// agent.polish getter 返回值类型，消费者可独立标注变量类型
export type { PolishResult } from '@/agent/managers/textPolishManager.js';
// 记忆即摘要架构：轮次摘要生成器为内核内部组件（Agent init 装配），不挂公共面
export { loadConfig } from '@/config/loader.js';
// LLM Provider 构造（边界：provider 选择/默认值归宿主，内核只做实例构造与校验）：
//   createProviderFromConfig —— 【规范入口】宿主传入 baseUrl+model+apiKey，校验后创建；
//   createLlmProvider —— 【配置驱动便利】从完整 Config 读 llm.active 解析激活 provider
//     （选择策略在内核侧），仅当你把整份 Config 托管给内核时使用，边界守法的宿主应自建 provider 后调前者。
export { createLlmProvider, createProviderFromConfig } from '@/llm/factory.js';
export type { ProviderConfig } from '@/llm/factory.js';
export type { LlmProvider, ChatOptions } from '@/llm/provider.js';
export type { LlmChunk, ProviderRouter } from '@/llm/types.js';
// OpenAICompatibleProvider 为内部实现类：构造函数不做 baseUrl/model 校验，须经 createProviderFromConfig
// 工厂校验后创建。不对外暴露，外部宿主一律走 createProviderFromConfig。
export type { Config } from '@/config/loader.js';
// 事件系统（事件名常量表 AGENT_EVENTS 为内核内部实现，订阅用字符串字面量或 AgentEventName 类型）
export { TypedEventEmitter } from '@/utils/eventEmitter.js';
export type { AgentEventMap, AgentEventName, AgentEventHandler } from '@/utils/eventEmitter.js';
// 会话标识格式契约（SSOT 单点）：date/session 双向转换唯一真理源，宿主导入后不再手写 slice/split
export { buildSessionId, splitSessionId } from '@/utils/time.js';

// ─── 可观测性导出 ────────────────────────────────────────
export type { ITracer, ISpan, AgentMetrics } from '@/agent/tracer.js';
export { NOOP_TRACER, TRACE_SPANS } from '@/agent/tracer.js';

// ─── 记忆层导出 ──────────────────────────────────────────
export { SOURCE_LABELS, SUMMARY_TYPES } from '@/memory/types.js';
// 冲突检测基于 supersededBy 判定，无需记忆关系图谱
export type { Memory } from '@/memory/types.js';
/**
 * 记忆解析器（宿主读档复用内核校验，避免宿主另写一份字段白名单）
 * 白名单构造：剥离未知字段（旧档 score 等），见 src/memory/types.ts
 */
export { parseMemory } from '@/memory/types.js';
export { escapeLike, escapeLikeSnippet, validateSource } from '@/memory/sourceValidation.js';
export type { SourceValidationSeverity } from '@/memory/sourceValidation.js';
// 存储层抽象：宿主项目可实现 IMemoryStorage 接口注入 Agent
export type { IMemoryStorage } from '@/memory/storageInterface.js';
export { InMemoryStorage } from '@/memory/inMemoryStorage.js';

// ─── 网络搜索导出 ──────────────────────────────────────────
// IWebSearchProvider 接口：宿主项目可实现此接口注入自定义搜索引擎
export type {
  IWebSearchProvider,
  SearchResult,
  WebSearchOptions,
  SearchEndpoint,
} from '@/web-search/types.js';
// FetchWebSearchProvider：默认搜索实现（零依赖开箱即用）；safeSearch 包装为内部实现，不挂公共面
export { FetchWebSearchProvider } from '@/web-search/fetchWebSearchProvider.js';
// buildSearchEndpoints：构建搜索端点降级链。入参为「内核预设名 | 宿主自定义 SearchEndpoint」混排；
//   主推宿主接入——生产环境宿主自建 SearchEndpoint[]（自带 URL+解析）注入，内核预设仅作零配置保底。
export {
  buildSearchEndpoints,
  type SearchEngineName,
} from '@/web-search/fetchWebSearchProvider.js';

// ─── 网页抓取导出（搜索→抓取闭环第二段） ──────────────────────
// IFetchProvider 接口：宿主项目可实现此接口注入自定义抓取实现
export type { IFetchProvider, FetchedPage, FetchOptions } from '@/web-fetch/types.js';
// FetchWebFetchProvider：默认抓取实现（零依赖开箱即用）；safeFetch：带超时保护的抓取包装（宿主可复用）
export { FetchWebFetchProvider } from '@/web-fetch/fetchWebFetchProvider.js';
export { safeFetch } from '@/web-fetch/webFetchProvider.js';

// ─── 代码执行导出（通用计算底座） ────────────────────────────
// ICodeExecutionProvider 接口：宿主项目可实现此接口注入沙箱执行器（内核不内置执行器，保持零依赖）
export type {
  ICodeExecutionProvider,
  CodeExecutionResult,
  CodeExecutionOptions,
} from '@/code-exec/types.js';
// safeExecuteCode：带超时保护的执行包装（宿主可复用）
export { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';

// ─── 宿主环境导出（运行环境事实上报） ───────────────────────────
// IEnvironmentProvider 接口 + HostEnvironmentInfo 载荷：宿主上报 OS/shell/可用运行时，
// 内核注入 system prompt（方案 §10.4-②）；内核零解释转发，环境事实不升级为内核判据
export type { IEnvironmentProvider, HostEnvironmentInfo } from '@/agent/types.js';

// ─── 项目搜索导出（等价 IDE 全局搜索） ─────────────────────────
// IProjectSearchProvider 接口：宿主项目可实现此接口注入项目内搜索（VS Code 用 workspace.findFiles/findTextInFiles）
export type {
  IProjectSearchProvider,
  ProjectFileMatch,
  ProjectFileSearchOptions,
  ProjectFileSearchResult,
  ProjectTextMatch,
  ProjectTextSearchOptions,
  ProjectTextSearchResult,
} from '@/project-search/types.js';
// safeSearchProjectFiles/safeSearchProjectText：带超时保护的项目搜索包装（宿主可复用）
export {
  safeSearchProjectFiles,
  safeSearchProjectText,
} from '@/project-search/projectSearchProvider.js';
// PROJECT_SEARCH_RESULT_MAX_LEN / IGNORED_DIR_NAMES：search_project 调用面与宿主实现方共享的单一真理源
// （宿主 projectSearchProvider import 对齐，避免结果上限 / 忽略目录数值漂移）
export { PROJECT_SEARCH_RESULT_MAX_LEN } from '@/agent/toolExecutor.js';
export { IGNORED_DIR_NAMES } from '@/agent/builtinToolHandlers.js';
// 项目注册表 + 锁文件管理：宿主可直接使用或通过 ProjectManager 间接委托
export { ProjectRegistry } from '@/memory/projectRegistry.js';
export type { ProjectEntry } from '@/memory/projectRegistry.js';
export { LockManager } from '@/memory/lockManager.js';
// 会话存储抽象：宿主项目可实现 ISessionStore 接口注入 Agent
export type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';
// 会话显示名回退单一真理源（displayName→autoName），宿主从内核取，避免重复实现
export { getSessionDisplayName } from '@/memory/sessionStore.js';

// ─── 问答闭环（Round）存储导出 ─────────────────────────────
// Round 数据结构和存储接口
export type { Round, RoundMessage, RoundStatus, IRoundStore } from '@/memory/roundStore.js';
// 问答闭环内交互输入：主动提问回答/补充输入的类型与归属语义
export type { InteractiveInputKind } from '@/memory/roundStore.js';
// 过程事件（每轮 UI 状态重建真相源，v1.5 单文件内聚，见 process-event-log-replay-design）
export type {
  ProcessEvent,
  ProcessThinkingPhase,
  ProcessMetaPayload,
} from '@/memory/roundStore.js';
// Round 辅助函数：仅 isRoundSettled 挂公共面（「轮是否已收场」判据单一收口点：宿主与内核共用，
// 禁止各端自写 status === 'complete'，否则中断轮会被静默排除出会话视图与 LLM 历史）；
// ID 生成/轮创建/收场流转为内核内部实现
export { isRoundSettled } from '@/memory/roundStore.js';

// ─── 会话视图加载器导出 ─────────────────────────────────────
// SessionViewLoader：将 Round ID 列表展开为完整对话视图
// 注：flattenRoundsToMessages / truncateRoundsUpTo / countMessagesInRounds 为加载器内部实现，
// 宿主持有 InMemorySessionViewLoader 即获全部能力，无需直接 import 这三个内部工具（收回误暴露的公共面）。
export type {
  ISessionViewLoader,
  SessionView,
  SessionSummary,
} from '@/memory/sessionViewLoader.js';
// 通用会话视图加载器实现（宿主注入存储后直接委托；非仅测试/开发用）
export { InMemorySessionViewLoader } from '@/memory/inMemorySessionViewLoader.js';

// 内存版实现：InMemorySessionStore 承诺面（README「ISessionStore → InMemorySessionStore」+ API 参考）；
// InMemoryRoundStore 为内核内部测试实现，不挂公共面
export { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
// 会话占位标题单一真理源，避免宿主重复实现
export { defaultTitle as defaultSessionTitle } from '@/agent/managers/sessionNamer.js';
// 不中断工作模型类型（API 参考 §6.3 createCheckpoint/getCheckpoint 的返回值契约）
export type { SessionCheckpoint } from '@/agent/types.js';
// 后台任务只读投影（宿主 UI 列表出口：`agent.listBackgroundTasks()` / `killBackgroundTask()`
// 的载荷类型）。只出类型不出注册表类——注册表是 Agent 实例级，出类会让宿主跨会话 kill。
export type { BackgroundTask } from '@/agent/backgroundTasks.js';
// 后台任务状态中文词表（宿主 UI 直接消费，禁自建第二套；Record 穷尽键 = 加状态忘补文案编译期红）
export { BACKGROUND_TASK_STATUS_LABELS } from '@/agent/backgroundTasks.js';
// MessageHistory.forkSession() 返回值（Agent.forkSession() 返回 AgentForkResult）
export type { ForkResult } from '@/agent/messageHistory.js';
// 注：extractKeywords 为 keywordsTouch 导出的内核分词 SSOT（project-search/terms.ts 同源消费，不另造分词器），
// 宿主生产代码零直接消费，故不再挂公共面（收回误暴露）。

// ─── 日志抽象 ────────────────────────────────────────────
export type { ILogger } from '@/logging/loggerInterface.js';
export { setLogger, logger } from '@/logging/logger.js';

// ─── 工具导出 ────────────────────────────────────────────
// 以下工具供宿主复用（分词/类型守卫/Frontmatter/安全定时器）；宿主按需接入，非强依赖
export { segmentText, segmentLower } from '@/utils/segmenter.js';
export { isPlainObject } from '@/utils/objects.js';
export { parseFrontmatter, serializeFrontmatter } from '@/utils/frontmatter.js';
// 安全定时器工具：供宿主主进程复用，统一跟踪清理定时器（防原生 setTimeout/setInterval 泄漏）
export {
  safeSetTimeout,
  safeSetInterval,
  clearSafeTimeout,
  clearSafeInterval,
} from '@/utils/safeTimer.js';
export type { SkillEntry } from '@/skill/types.js';

// ─── 安全层导出 ────────────────────────────────────────────
// 审计日志类型（SecurityGuard.onAudit 回调的 event 参数）
export type {
  AuditEvent,
  AuditListener,
  Permission,
  WriteDecision,
  WriteConfirmationInfo,
  WriteConfirmationRequest,
} from '@/security/pathGuard.js';
// MAX_DIFF_CONTENT_LENGTH：diff 内容上限的**单一真理源**，宿主 UI 展示阈值 import 对齐（防数值漂移）。
// ⚠️ 两侧超限行为不同：内核 = 截断后追加「已截断」标记照常展示；宿主 = 跳过对比只提示——只统一数值，不统一行为
export { MAX_DIFF_CONTENT_LENGTH } from '@/security/pathGuard.js';

// ─── 错误类型导出 ────────────────────────────────────────
export { MemoraError, ToolErrorCode, isRetryableErrorCode } from '@/utils/errors.js';
// toError 独立导出：浏览器端可直接 import 而不引入 logging/ 模块
export { toError } from '@/utils/toError.js';
export type { ToolErrorCodeValue } from '@/utils/errors.js';

// ─── 通用工具导出 ────────────────────────────────────────
// 通用工具供宿主复用：主进程可直接 import 本入口（渲染进程因浏览器环境保留 shared 副本）；
// isValidConfigName / parseConfigId / MAX_CONFIG_NAME_LENGTH 为配置名内部校验，不挂公共面
export { truncate } from '@/utils/strings.js';
export { formatDateKey, todayDate } from '@/utils/time.js';
