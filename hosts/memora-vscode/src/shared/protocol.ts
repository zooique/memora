/**
 * 消息协议 — extension host ↔ Webview 通信契约
 *
 * 单一真理源：所有 postMessage 载荷类型在此定义，extension 侧与 webview 侧共用，
 * 避免两侧手写消息类型漂移（对齐 memora-sprite 的 shared/ 跨进程契约思路）。
 *
 * 方向：
 *   - Webview → extension：用户动作（send 发送消息）
 *   - extension → Webview：Agent 流式输出（user/chunk/done/error）
 */

/**
 * LLM Provider 配置（大模型配置面板的数据模型）
 *
 * 对齐 memora-sprite 的 LlmProviderConfig 模式 + 内核 ProviderConfig：
 * - name 为唯一别名（持久化 key，编辑时禁用）
 * - apiKey 存 SecretStorage（不落盘 settings.json），模型/baseUrl 存用户级 configuration
 *   （ConfigurationTarget.Global，2026-08-17 由 Workspace 迁至 Global——Provider 是用户级偏好）
 * - provider 标识（'cloud'|'local'），仅用于日志/模式展示
 */
export interface LlmProviderConfig {
  /** 唯一别名（持久化 key，仅允许英文数字.-_） */
  name: string;
  /** 显示名称 */
  displayName: string;
  /** 模型标识（如 deepseek-chat） */
  model: string;
  /** OpenAI 兼容 API Base URL */
  baseUrl: string;
  /** API Key（SecretStorage 存储；传输给 webview 时不回传真实值） */
  apiKey: string;
  /** 脱敏后的 API Key（仅 Host→Webview 传输时填充，如 `sk-••••1234`，供编辑回显） */
  maskedKey?: string;
  /** Provider 标识（'cloud' | 'local'） */
  provider?: string;
}

/** Webview → extension 消息 */
export type WebviewToExtensionMessage =
  /** Webview 脚本已就绪（监听器已注册），extension 可安全回放会话/推送数据 */
  | { type: 'ready' }
  | { type: 'send'; text: string }
  /** 用户对 Agent 主动提问（need_clarify）的回答，触发 resumeExecution 续跑 */
  | { type: 'clarify_answer'; text: string }
  /**
   * 新建会话（标题条「＋」按钮触发，2026-08-17 会话管理重构）
   *
   * 由标题条新建按钮触发，host 调 newSessionFromCommand 生成唯一会话名并切入空会话；
   * 旧会话随之归档进历史记录（可经 session_list 弹窗加载回来或删除）。
   */
  | { type: 'new_session' }
  /**
   * 请求历史会话列表（标题条「历史」按钮触发，2026-08-17 会话管理重构）
   *
   * host 返回 session_list_data（非当前会话，按 updatedAt 降序），webview 渲染模态浮层。
   */
  | { type: 'session_list' }
  /**
   * 加载指定历史会话（历史浮层点击条目触发）：host 调 switchToSession 切入并回放
   */
  | { type: 'switch_session'; sessionId: string }
  /**
   * 删除指定历史会话（历史浮层条目垃圾桶触发）：host 侧确认不可恢复后删除该会话记录
   *
   * 当前会话不进历史记录（设计收敛 2026-08-17），故正常不会删除到当前会话；
   * host 侧对目标是当前会话做保护（拒绝 + 提示）。
   */
  | { type: 'delete_session'; sessionId: string }
  /**
   * 重命名当前会话（标题条改名笔触发）：host 弹 InputBox 输入新标题写入元数据
   */
  | { type: 'rename_request' }
  /**
   * 删除单个问答闭环（truncate-from-turn，2026-08-16 对话闭环管理）
   *
   * 由 AI 消息的「删除」按钮触发，携带该条 AI 消息的 timestamp 作锚点。host 调宿主
   * sessionStore.truncateFrom 删除【该问答及其之后所有】消息，随后 replayCurrentSession
   * 重放会话（保证剩余上下文自洽）。需 host 侧确认不可恢复后执行。
   */
  | { type: 'delete_turn'; ts: string }
  /** Chat Panel 切换激活 Provider（底部模型下拉框） */
  | { type: 'chat_set_provider'; name: string }
  /**
   * Chat Panel 切换激活角色包（历史遗留协议，2026-08-17 起无 webview 发送方）
   *
   * 输入区角色选择器已独立为「角色」管理视图（roles_set_active），本消息保留仅作
   * 旧版 webview 实例的兼容兜底；新前端不再发送。
   */
  | { type: 'chat_set_role_pack'; name: string }
  /**
   * 角色管理面板切换激活角色包（2026-08-17 独立视图）
   *
   * 由角色管理视图的「设为当前」触发，host 调 agent.rolePackManager.activate(name) 切换；
   * 成功后持久化用户级激活态并重推 roles_loaded（与 chat 面板的 personaSwitched 转发同源）。
   */
  | { type: 'roles_set_active'; name: string }
  /**
   * 角色 handoff：将指定角色包带入对话（2026-08-17 后续）
   *
   * 由角色管理视图的「带入对话」触发：host 复用 activateRole 切换激活角色包（与
   * roles_set_active 同路径），随后聚焦对话视图（memora.chat.focus）。单 Agent 模型下
   * 上下文由共享记忆（round-summary）承载，角色切换即完成"上下文传递"，无需额外搬运。
   */
  | { type: 'roles_handoff'; name: string }
  /**
   * 停止生成：用户主动中断当前流式输出（mvp-scope 打断能力）
   *
   * 由 webview 停止按钮触发，host 调用 AbortController.abort() 中断进行中的
   * chat() / resumeExecution() 流；流中断后 host 发送 interrupted 通知 webview。
   * 可安全重复发送（无进行中流时 no-op）。
   */
  | { type: 'stop' }
  // ─── 大模型配置面板消息 ───
  /** 请求加载 Provider 列表 */
  | { type: 'cfg_load' }
  /** 保存（新增/编辑）一个 Provider */
  | { type: 'cfg_save'; config: LlmProviderConfig; isEditing: boolean }
  /** 删除一个 Provider */
  | { type: 'cfg_delete'; name: string }
  /** 设为当前激活 Provider */
  | { type: 'cfg_set_active'; name: string }
  /** 测试 Provider 连接 */
  | { type: 'cfg_test'; config: LlmProviderConfig }
  // ─── 记忆管理面板消息（2026-08-17 独立视图） ───
  /**
   * 请求加载记忆列表（记忆视图打开/刷新时触发）
   *
   * host 调 MemoryInspector.list() + stats() 返回：记忆按 score 降序（越常用越重要），
   * 附带按 source 分布统计；agent.memory 未就绪时返回空列表（webview 渲染空态）。
   */
  | { type: 'memory_load' }
  /**
   * 请求搜索记忆（记忆视图搜索框触发，query 非空才发送）
   *
   * host 调 MemoryInspector.searchHybrid(query, limit)（语义+关键词混合检索），
   * 返回带 score/similarity 的命中列表。空 query 不应发送本消息（走 memory_load）。
   */
  | { type: 'memory_search'; query: string; limit?: number };

/** extension → Webview 消息 */
export type ExtensionToWebviewMessage =
  | { type: 'user'; text: string; ts?: string }
  /** 历史/流式 assistant 消息（历史回放用 text 完整段） */
  | { type: 'assistant'; text: string; ts?: string }
  /**
   * 流式 assistant 消息（流式输出经 chunk 拼接）
   *
   * guardrailBlocked：对齐内核 text chunk 的护栏阻断标记（§7.2.1 结构化信号）。
   * 仅护栏阻断的那一条 chunk 携带 true；webview 据此渲染「护栏阻断」提示条。
   */
  | { type: 'chunk'; content: string; ts?: string; guardrailBlocked?: boolean }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /**
   * 流被用户中断（stop 的应答）
   *
   * host 在 AbortController.abort() 后发送：告知 webview 本轮输出已中止，
   * 用于：(1) 恢复输入框/停止按钮状态；(2) 渲染「已停止」提示；
   * (3) 区分「正常结束(done)」与「用户主动打断(interrupted)」。
   */
  | { type: 'interrupted' }
  /**
   * 工具调用开始（Agent 循环的步骤，手动具象化）
   *
   * 由 extension host 转发内核 tool_start chunk，webview 渲染「执行中」工具卡片。
   * 卡片默认折叠，减少视觉干扰；toolCallId 用于和 tool_result 匹配更新。
   */
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  /**
   * 工具调用结束（成功/失败 + 结果摘要），更新对应卡片状态 */
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      ok: boolean;
      summary?: string;
    }
  /**
   * Agent 自审查轮开始（活动透明，交叉审核观察 A）
   *
   * 内核在自审查轮开始前 emit `selfReview` chunk（round 从 1 起），宿主原样转发。
   * webview 渲染一条过程性提示，让用户看见 Agent 正在复核本轮产出（真实信号校验，
   * 对齐 agent-design-philosophy §13.x 可观察契约）。仅运行时显示，不持久化、不重放，
   * 与 tool 卡片同一"过程性反馈"语义。
   */
  | { type: 'self_review'; round: number }
  /**
   * Agent 思考阶段（对齐内核 thinking chunk，alignment-iteration.md B）
   *
   * 内核在回答前/后阶段产出 thinking{phase}（recalling/processing/archiving），
   * 标识 Agent 正在做什么。webview 据此更新思考折叠块文案（"召回记忆中/处理中/归档记忆中"），
   * 是对 status"进行中"的细化——status 管状态机，thinking 管阶段，二者职责分离。
   */
  | { type: 'thinking'; phase: 'recalling' | 'processing' | 'archiving' }
  /**
   * Agent 衔接决策（对齐内核 handoff chunk，P1 事件流全量对齐）
   *
   * 内核回答后阶段基于 L2 策略产出 handoff（decision: wait/loop/end）。
   * webview 仅对 decision='loop' 渲染「自动续跑」提示条（活动透明，雷-4 低频）；
   * wait/end 为默认/终止语义，静默不渲染。
   */
  | { type: 'handoff'; decision: 'wait' | 'loop' | 'end'; reason?: string }
  /**
   * LLM 调用重试（对齐内核 retry chunk，P1 事件流全量对齐）
   *
   * 内核在 LLM 失败重试时产出；webview 渲染低扰提示条「LLM 重试 n/m…」。
   */
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  /**
   * Agent 暂停（对齐内核 paused chunk，P1 事件流全量对齐）
   *
   * 内核在输入待定/迭代边界软暂停时产出；webview 渲染提示条「Agent 已暂停」。
   */
  | { type: 'paused' }
  /**
   * 活动指标快照（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 每轮流式结束后由 extension host 推送：本轮指纹（系统提示 hash 前 12 位 + 附着记忆条数，
   * 只记 hash 不记内容）+ 累计指标（LLM 调用 / 召回命中率 / 工具失败 / 截断）。
   * webview 渲染为默认折叠的「活动指标」区。
   */
  | {
      type: 'metrics';
      fingerprints: {
        systemPromptHash?: string;
        attachedMemoryCount?: number;
      };
      metrics: {
        llmCallCount: number;
        recallHitRate: number;
        toolFailureCount: number;
        truncationCount: number;
        /** D（alignment-iteration.md）：LLM token 用量（输入/输出） */
        llmTokenIn?: number;
        llmTokenOut?: number;
        /** D（alignment-iteration.md）：记忆衰减运行次数 */
        decayRunCount?: number;
      };
    }
  /**
   * LLM 运行状态（P0-2 状态可视化）
   *
   * 让用户看见 Agent 正在做什么，而非静默等待：
   *   - 'thinking'：Agent 正在生成（展示加载动画，输入框禁用）
   *   - 'done'：本轮结束（恢复输入框）
   * 与 done/error 配合，构成完整的「进行中 → 结束」状态机。
   */
  | { type: 'status'; state: 'thinking' | 'done' }
  /** 清空会话完成（webview 收到后清空消息区） */
  | { type: 'clear_ok' }
  /**
   * 当前会话标题（ADR-024 会话标题层）
   *
   * host 在会话回放/新建/切换/改名时推送当前会话标题，webview 顶部展示，
   * 让用户识别当前在哪个会话（主动可见）。title 为未命名会话时占位。
   */
  | { type: 'session_title'; title: string }
  /**
   * 历史会话列表（对 session_list 的应答，2026-08-17 会话管理重构）
   *
   * host 返回非当前会话的历史列表（按 updatedAt 降序），webview 据此渲染历史模态浮层。
   * 当前会话不进历史记录（设计收敛），故 sessions 不含当前会话——天然规避「删除当前会话」边界。
   */
  | {
      type: 'session_list_data';
      sessions: { sessionId: string; title: string; updatedAt: string }[];
    }
  /**
   * Chat Panel Provider 列表同步（底部模型下拉框的数据）
   *
   * 扩展侧在渲染/切换时推送最新 Provider 列表及激活状态，
   * webview 下拉框据此刷新选项。
   */
  | { type: 'chat_providers'; providers: { name: string; displayName: string }[]; activeName?: string }
  /**
   * Agent 主动提问（mvp-scope §三：ambiguity/decision/missing_info）
   *
   * 实际来源：extension host 监听内核 questionPending 事件（LLM 回答中 `[ASK]` 结构化输出路径）
   * 后转发，触发 Agent 暂停（pause），等待用户在提问输入框回答；收到 clarify_answer 后调
   * resumeExecution 续跑。
   *
   * 注：内核另有 needClarify 事件（P4 任务槽位补全，processEvent/composer 路径），插件当前
   * 仅用 chat()/resumeExecution 不触达该路径，故不监听；如未来接入该路径需在此补监听。
   */
  | { type: 'need_clarify'; questions: { slot: string; question: string; options?: string[] }[] }
  /**
   * 记忆活动提示（任务 D 可观测出口）
   *
   * 由 extension host 监听 Agent 的 memoryRecalled / memoryAdded 事件后转发，
   * 让开发者「看见」跨会话记忆在工作（主动可见，非黑盒）。
   * action: 'recalled' 表示本轮召回 N 条记忆；'added' 表示本轮沉淀记忆。
   */
  | { type: 'memory'; action: 'recalled'; count: number }
  /** 召回明细（recall chunk 转发）：补充 recalled 的即时反馈，展示本轮召回的具体记忆来源 */
  | { type: 'memory'; action: 'recalled_items'; items: MemoryRecallItemDto[] }
  | { type: 'memory'; action: 'added'; count: number; detail?: { id: string; source: string; name: string } }
  /**
   * 通用提示条（低扰 info / 错误级 error）
   *
   * 由 extension host 转发的非消息区通知，webview 用同一提示条分级呈现：
   *   - info：记忆召回/沉淀、上下文截断、记忆冲突等低扰信息（短暂显示）
   *   - error：会话异常/恢复失败/guardrail 失败等错误级反馈（醒目、停留更久）
   * 统一走提示条而不插入消息区，避免污染对话历史（功能→UI 对齐排雷的雷-4 修正）。
   */
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  /**
   * Chat Panel 当前激活角色包（消息区顶部角色徽章数据）
   *
   * 面板为通用对话宿主，定位由内置角色包承载。host 在就绪回放时推送，
   * webview 据此在消息区顶部渲染角色徽章——主动可见：用户始终知道当前用哪个角色
   * （不依赖角色匹配事件，避免普通对话不匹配时徽章永远不显示）。
   */
  | { type: 'chat_role_pack'; rolePack: string }
  /**
   * Chat Panel 角色包列表（身份条角色切换下拉的数据，alignment-iteration.md A3）
   *
   * 由 host 在就绪回放时推送：全部角色包（displayName 供下拉展示）+ 当前激活名。
   * description 为角色包定位描述（manifest.description，可选）——供下拉列表展示副标题，
   * 让用户"查看内置角色包"时能读懂每个包的定位再决定切换（2026-08-15 UI 查看能力）。
   * webview 据此渲染身份条角色选择器选项；activeName 变化时高亮当前项。
   */
  | {
      type: 'chat_role_packs';
      packs: { name: string; displayName: string; description?: string }[];
      activeName: string;
    }
  // ─── 角色管理面板消息（2026-08-17 独立视图） ───
  /** 角色能力项（capability 为中立能力名「域:动作」，label 为中文可读文案，由 host 生成） */
  | {
      type: 'roles_loaded';
      packs: {
        name: string;
        displayName: string;
        description?: string;
        capabilities: { capability: string; label: string }[];
      }[];
      activeName: string;
    }
  // ─── 大模型配置面板消息 ───
  /** Provider 列表加载完成（apiKey 为脱敏值，供展示） */
  | { type: 'cfg_loaded'; providers: LlmProviderConfig[]; activeName: string | undefined }
  /** 配置操作结果（保存/删除/设当前/测试） */
  | { type: 'cfg_result'; ok: boolean; message?: string; action: 'save' | 'delete' | 'set_active' | 'test' }
  // ─── 记忆管理面板消息（2026-08-17 独立视图） ───
  /**
   * 记忆列表加载完成（对 memory_load 的应答）
   *
   * host 返回按 score 降序的记忆列表 + source 分布统计；agent.memory 未就绪时
   * memories 为空、stats.total 为 0，webview 渲染空态引导。
   */
  | {
      type: 'memory_loaded';
      stats: MemoryStatsDto;
      memories: MemoryItemDto[];
    }
  /**
   * 记忆搜索结果（对 memory_search 的应答）
   *
   * hits 为 searchHybrid 命中（带 score/similarity），content 为截断预览
   * （与列表的全文 content 区分——搜索场景看相关性即可）。
   */
  | { type: 'memory_search_result'; query: string; hits: MemoryItemDto[] }
  // ─── 设置视图消息（2026-08-17 选项卡合并） ───
  /**
   * 切换设置视图的子选项卡（host → webview 指令）
   *
   * 由「配置大模型」命令触发：聚焦设置视图后切换到「大模型」子选项卡，
   * 让命令落点与用户意图一致（而非停在默认的「角色」选项卡）。
   */
  | { type: 'settings_switch_tab'; tab: 'roles' | 'config' | 'memory' }
  // ─── Follow-up 建议消息（2026-08-17 回复后关联推荐） ───
  /**
   * 回复完成后的 Follow-up 建议（对 governance.suggest() 的结果推送）
   *
   * host 在本轮流式正常结束后调 agent.governance.suggest()（零 LLM、纯计算，
   * 基于记忆库 score+时效+多样性推荐），映射为「下一步可探索」chips 推给 webview；
   * 用户打断/异常时不推送（避免给不完整回复挂建议）。
   */
  | { type: 'suggestions'; items: FollowupSuggestionDto[] }
  /**
   * 预填输入框（角色 handoff 上下文传递，2026-08-17 后续）
   *
   * host 在 roles_handoff 切换激活角色包并聚焦对话视图后，推送一句"以新角色视角继续"的
   * 提示文案填入对话输入框（不自动发送，用户可编辑后回车）。复用 chat 面板 post 通道；
   * 对话视图未就绪时由 chatPanel 缓冲，待 webview ready 后补发（消除时序竞态）。
   */
  | { type: 'prefill_input'; text: string };

/** 召回记忆条目（Phase 1，2026-08-17：召回可展开，对齐内核 RecalledMemorySummary） */
export interface MemoryRecallItemDto {
  /** 记忆唯一标识（source:name 格式） */
  id: string;
  /** 记忆可读名称 */
  name: string;
  /** 来源标签（如 'round-summary'、'profile'、'rule'） */
  source: string;
  /** 相似度分数（0-1） */
  score: number;
}

/** Follow-up 建议条目（T2，2026-08-17：回复后关联推荐）
 *
 * 由 host 对 governance.suggest() 的 SuggestHit 归一化：label 为 chip 展示文案（记忆名），
 * prompt 为点击后填入输入框的完整下一步提问（「继续深入：{记忆名}」）。
 */
export interface FollowupSuggestionDto {
  /** 填入输入框的完整提问 */
  prompt: string;
  /** chip 展示文案 */
  label: string;
}

/** 记忆库统计（记忆视图顶栏，对齐内核 AgentStats 扁平化） */
export interface MemoryStatsDto {
  /** 按来源标签分组的记忆数量 */
  bySource: Record<string, number>;
  /** 记忆总数 */
  total: number;
}

/** 记忆条目（记忆视图列表/搜索结果，host 从内核 Memory/AgentSearchHit 归一化） */
export interface MemoryItemDto {
  /** 记忆唯一标识（${source}:${name} 格式） */
  id: string;
  /** 记忆名称 */
  name: string;
  /** 来源标签（round-summary / profile / work-projection 等） */
  source: string;
  /** 权重（0-1） */
  score: number;
  /** 内容（列表=全文；搜索结果=截断预览，供详情展开展示） */
  content: string;
  /** 创建时间（ISO 8601，可选） */
  createdAt?: string;
}
