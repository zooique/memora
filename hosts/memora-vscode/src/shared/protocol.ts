import type { InteractiveInputKind, ProcessEvent } from '@zooique/memora';

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
 * - provider 标识（'cloud'|'local'）——阶段1 起升格为**行为锚点**（非纯展示标签）：
 *   驱动「支持原生工具调用」能力位落值——cloud → supportsToolCalling=undefined（内核回落 true，
 *   存量云行为零回归）；local → 用户在配置面板显式声明（默认 true）。见下方 supportsToolCalling 字段。
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
  /**
   * 是否支持原生工具调用（OpenAI Function Calling tools 协议）。
   * 本地运行时（Ollama/LM Studio 等）是否支持原生 FC 无法从 baseUrl 推断，由用户在配置面板显式声明；
   * 未填（undefined）→ 内核回落 true（保留存量云 LLM 工具行为，2026-09-14 阶段0·互斥双能力位）。
   */
  supportsToolCalling?: boolean;
  /** 是否支持结构化输出（response_format / JSON mode），与 supportsToolCalling 互斥（OpenAI 协议限制）；未填 → 回落 false */
  supportsStructuredOutput?: boolean;
  /**
   * 上下文窗口上限（token）—— 该 LLM 唯一真理源
   *
   * 每个用户添加的 LLM 独立配置自己的上下文上限（如 deepseek-chat 64K、gpt-4o 128K、
   * 本地模型 8K）。宿主无「模型真上限」权威（用户可能添加任意 OpenAI 兼容 endpoint，
   * 宿主不预置静态表、不动态探测），故本字段即窗口真相源，由用户在配置面板填写。
   * 未填（undefined）→ 装配时经内核 resolveContextWindow 回落默认 120K（默认非真理源）。
   * 仅护栏 = 宿主 save 校验正整数 + 合理范围（防 0 / 防天文数字撑爆预算），不构成第二真理源。
   */
  contextWindow?: number;
}

/** Webview → extension 消息 */
/**
 * 内部网页搜索引擎设置值（方案 A 2026-09-02，与内核 SearchEngineName + auto 对齐）
 * auto = 默认降级链（Bing→DuckDuckGo）。
 */
export type SearchEngineSetting = 'auto' | 'bing' | 'baidu' | 'sogou';

export type WebviewToExtensionMessage =
  /** Webview 脚本已就绪（监听器已注册），extension 可安全回放会话/推送数据 */
  | { type: 'ready' }
  | { type: 'send'; text: string; skillName?: string }
  /**
   * 打开大模型配置视图（UX-1 空态引导按钮触发，2026-09-01）
   *
   * 由对话面板空态「去配置模型」引导按钮触发：host 打开大模型配置面板并切到「大模型」选项卡。
   */
  | { type: 'open_config' }
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
   * 分叉当前会话（AI 回答底部「分叉」按钮触发，B3 会话生命周期补齐，2026-08-22）
   *
   * webview 从目标消息 dataset.roundId 携带本轮 id；host 调 agent.forkSession() 将当前对话
   * 复制为新分支会话并切入，UI 回放新分支；无 roundId 时回退当前会话最后一个 round（兜底）。
   * 当前会话为空或对话繁忙时内核会拒绝并通知（host 兜底提示）。记忆索引全局共享，
   * fork 仅分叉对话历史不隔离记忆空间。
   */
  | { type: 'fork_session'; roundId?: string }
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
   * 角色管理面板切换激活角色包（2026-08-17 独立视图）
   *
   * 由角色管理视图的「设为当前」触发，host 调 agent.switchRolePack(name) 切换（内核
   * 单一切换入口：activate + emit rolePackSwitched + 刷新 loop 前缀）；成功后持久化
   * 用户级激活态。各视图刷新统一由 rolePackSwitched 事件驱动（设置→loadRoles，对话→
   * chat_role_pack），无并行推送路径。
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
   * 保存角色包组（会议名单，v0.13 S7）：组长 + 组员名单。
   *
   * 由角色管理视图的小组管理触发。host 校验后（组长唯一 / 名单非空 / 引用存在）持久化
   * 用户级 globalState（ROLE_PACK_TEAMS_KEY）+ 热更新 agent.rolePackManager.setRolePackTeams。
   * 组 = 组长角色包的会议名单（非选择对象）；组员仅作小组会议参与者，不用于日常。
   */
  | { type: 'roles_team_save'; leader: string; members: string[] }
  /** 删除角色包组（会议名单）：host 持久化移除 + 热更新内核组数据。 */
  | { type: 'roles_team_delete'; leader: string }
  /**
   * 打开用户角色包目录（2026-08-30 对齐技能系统）：host 调用 VS Code 命令在系统文件
   * 管理器中显示用户角色包目录（globalStorageUri/role-packs/），便于用户放置自定义角色包。
   */
  | { type: 'roles_open_dir' }
  /**
   * 停止生成：用户主动中断当前流式输出（mvp-scope 打断能力）
   *
   * 由 webview 停止按钮触发，host 调用 AbortController.abort() 中断进行中的
   * chat() / resumeExecution() 流；流中断后 host 发送 interrupted 通知 webview。
   * 可安全重复发送（无进行中流时 no-op）。
   */
  | { type: 'stop' }
  /**
   * 暂停生成：用户暂停当前 Agent 执行（Phase 4 暂停/恢复）
   *
   * 由 webview 暂停按钮触发，host 调 agent.requestPause()（step 边界软暂停），
   * 发送 status:'paused' 通知 webview。
   */
  | { type: 'pause' }
  /**
   * 恢复生成：用户恢复已暂停的 Agent 执行（Phase 4 暂停/恢复）
   *
   * 由 webview 继续按钮触发，host 调 agent.resumeExecution() 续跑。
   */
  | { type: 'resume' }
  /**
   * Phase 4：清空 interject 队列（thinking 态待发送补充区的清空按钮）
   *
   * 由 webview 待发送区触发，宿主调 agent.clearPendingInterjections() 清内核队列并 post 空 pending_queue_update。
   */
  | { type: 'clear_pending_queue' }
  /**
   * Phase 4：删除单条 interject（待发送区每条的独立删除按钮）
   *
   * 由 webview 待发送区某条补充的 × 按钮触发，宿主调 agent.removePendingInterject(index) 从内核队列删除，然后 post 更新后的 pending_queue_update。
   */
  | { type: 'remove_pending_item'; index: number }
  // ─── 大模型配置面板消息 ───
  /** 请求加载 Provider 列表 */
  | { type: 'cfg_load' }
  /** 保存（新增/编辑）一个 Provider */
  | { type: 'cfg_save'; config: LlmProviderConfig; isEditing: boolean }
  /** 删除一个 Provider */
  | { type: 'cfg_delete'; name: string }
  /** 设为当前激活 Provider */
  | { type: 'cfg_set_active'; name: string }
  /**
   * 设置后台模型 Provider（G5 多 Provider 路由，2026-08-23）
   *
   * 由大模型面板「后台模型」下拉触发：host 持久化后台 Provider 选择（空串 = 与实时对话
   * 相同，不清除后台任务通道），并热更新 agent.setBackgroundProvider。
   */
  | { type: 'cfg_set_background'; name: string }
  /** 测试 Provider 连接 */
  | { type: 'cfg_test'; config: LlmProviderConfig }
  // ─── 记忆管理面板消息（2026-08-17 独立视图） ───
  /**
   * 请求加载记忆列表（记忆视图打开/刷新时触发）
   *
   * host 调 MemoryInspector.list() + stats() 返回：记忆按 accessedAt 降序（最近使用优先），
   * 附带按 source 分布统计；agent.memory 未就绪时返回空列表（webview 渲染空态）。
   */
  | { type: 'memory_load' }
  /**
   * 请求搜索记忆（记忆视图搜索框触发，query 非空才发送）
   *
   * host 调 MemoryInspector.searchHybrid(query, limit)（纯关键词检索，B0 收编后无向量通道），
   * 返回带 accessedAt 的命中列表。空 query 不应发送本消息（走 memory_load）。
   */
  | { type: 'memory_search'; query: string; limit?: number }
  /**
   * 请求记忆列表翻页（记忆视图分页组件「上一页/下一页」，2026-09-08）
   *
   * host 调 MemoryInspector.list(page*pageSize) 取前 N 条后按页切片返回（accessedAt 降序稳定），
   * 应答 memory_page_result。首屏不发送本消息（memory_loaded 已带第 1 页数据）。
   */
  | { type: 'memory_page'; page: number; pageSize: number }
  // ─── 记忆治理：单条删除 / 恢复 / 回收站（G19，2026-08-25 新增） ───
  /**
   * 删除单条记忆（记忆列表「删除」按钮）
   *
   * host 弹确认框后调 agent.memory.delete(id) 软删除（进入回收站，可恢复），
   * 完成后推送 memory_deleted + 刷新记忆列表与治理统计。
   */
  | { type: 'memory_delete'; id: string }
  /**
   * 恢复单条记忆（回收站「恢复」按钮）
   *
   * host 调 agent.memory.restore(id) 从回收站恢复，完成后推送 memory_restored + 刷新。
   */
  | { type: 'memory_restore'; id: string }
  /** 加载回收站列表（回收站展开时触发） */
  | { type: 'memory_recycle_load' }
  /**
   * 永久删除回收站单条记忆（回收站条目「永久删除」按钮，2026-08-26）
   *
   * host 弹确认框后调 agent.memory.writePurge(id) 物理删除（不可恢复），
   * 完成后推送 memory_purged + 刷新回收站/列表/治理统计。
   */
  | { type: 'memory_purge'; id: string }
  /**
   * 清空回收站（回收站「清空回收站」按钮，2026-08-26）
   *
   * host 弹确认框后遍历 listDeleted() 逐个 writePurge 物理删除全部软删记忆（不可恢复），
   * 完成后推送 memory_recycle_cleared + 刷新回收站/列表/治理统计。
   */
  | { type: 'memory_recycle_clear' }
  /**
   * 编辑记忆内容（记忆列表「编辑」按钮，G19 内联 edit 收尾，2026-08-25 新增）
   *
   * host 经 agent.memory.getById(id) 取真实 Memory 做 read-modify-write，仅改 content
   * 并标记 isModified（人工修改），再 writeUpsert 落盘，推送 memory_edited + 刷新列表/治理。
   * 零内核改动：复用既有 writeUpsert。
   */
  | { type: 'memory_edit'; id: string; content: string }
  // ─── 记忆治理面板消息（G4，2026-08-23 新增） ───
  /**
   * 请求加载记忆治理数据（记忆视图挂载/治理操作后触发）
   *
   * host 返回 GovernanceStatsDto：活跃数 + 回收站（软删除）数 + 来源分布 +
   * 活跃数 + 回收站（软删除）数 + 来源分布。agent.memory 未就绪时返回全零统计。
   */
  | { type: 'governance_load' }
  /**
   * 清理过期软删除记忆（治理区「清理过期」按钮）
   *
   * host 弹确认框后调 agent.memory.writePurgeExpired(30 天前) 永久删除软删除记忆，
   * 完成后推送 governance_result + 刷新治理数据与记忆列表（复刻 memora.cleanupMemories 语义）。
   */
  | { type: 'governance_cleanup' }
  // ─── 技能管理面板消息（2026-08-22 新增） ───
  /**
   * 请求加载全局技能列表（技能视图打开/刷新时触发）
   *
   * host 调 SkillManager.list() 返回：全局技能列表。
   */
  | { type: 'skills_load' }
  /**
   * 请求打开用户技能目录（技能视图的「打开目录」按钮触发）
   *
   * host 调用 VS Code 命令在系统文件管理器中打开用户技能目录。
   */
  | { type: 'skills_open_dir' }
  /**
   * L2 渐进披露：请求读取技能正文（技能视图的「查看正文」按钮触发）
   *
   * host 调 SkillManager.get(name).content 或 RolePackManager.readSkillContent()
   * 读取技能 markdown 正文，返回 skill_content 消息。
   */
  | { type: 'skills_read_content'; skillName: string }
  /** 文本润色请求（H5 文本润色入口，2026-08-23）
   *
   * 由用户消息气泡「润色」按钮触发：host 调 agent.polish(text) 调用内核 TextPolishManager
   * 润色文本，限制 2000 字上限和 15s 超时。润色完成后返回 polish_result 消息。
   */
  | { type: 'polish_text'; text: string; msgId: string }
  /** 输入框文本润色请求（输入框旁「润色」按钮触发，2026-08-27）
   *
   * 由输入框旁的「润色」按钮触发：对当前输入框内容进行润色，润色完成后返回 polish_input_result 消息。
   */
  | { type: 'polish_input'; text: string }
  // ─── 安全/写入审批消息（H0：W→E 方向） ───
  /**
   * 切换写入二次确认开关（设置面板「安全」选项卡的 toggle 开关）
   *
   * 由设置面板「写入二次确认」开关触发：host 持久化到 globalState + 热更新
   * agent.security.setConfirmWrites()。无需重启 Agent。
   */
  | { type: 'security_toggle'; enabled: boolean }
  /**
   * 切换脚本/代码执行确认开关（设置面板「安全」选项卡的 toggle 开关，2026-09-08）
   *
   * 由设置面板「脚本执行二次确认」开关触发：host 持久化到 globalState + 热更新
   * agent.security.setConfirmScripts()。无需重启 Agent。
   * 语义：开 = run_code/run_project_script 执行前弹窗询问；关（默认）= 自动批准。
   */
  | { type: 'security_scripts_toggle'; enabled: boolean }
  /**
   * 写入审批应答（对 write_confirm_request 的应答）
   *
   * 用户在审批卡点击「确认写入」或「拒绝」后，webview 发送此消息。
   * host 根据 approved 结果回调内核 confirmationHandler。
   */
  | { type: 'write_confirm_answer'; approved: boolean; requestId: string }
  /**
   * 设置白名单额外允许路径（allowed_paths_set 消息处理）
   *
   * 由设置面板「允许路径白名单」增删后整体下发：host 持久化到**用户级**设置
   * （memora.allowedPaths，ConfigurationTarget.Global——目录信任是机器级，个人路径不进项目 settings）
   * + 热更新 agent.security.setAllowedPaths()。无需重启 Agent。
   * paths = 完整用户额外数组（不含 projectPath 基准根），host 为真理源。
   */
  | { type: 'allowed_paths_set'; paths: string[] }
  /**
   * 设置内部网页搜索引擎（search_engine_set 消息处理，2026-09-02 方案 A）
   *
   * 由设置面板「网页搜索引擎」下拉触发：host 持久化到**用户级**设置
   * （memora.searchEngine，ConfigurationTarget.Global——用户偏好不进项目 settings）。
   * 装配期一次性注入，修改需重载窗口（或重建会话）后生效。
   */
  | { type: 'search_engine_set'; engine: SearchEngineSetting };

/** extension → Webview 消息 */
export type ExtensionToWebviewMessage =
  /**
   * 用户消息（TS-9）：kind 存在 = 问答闭环内交互输入（折叠块渲染，不分裂新轮）——
   * question-answer=对 LLM 主动提问的回答；supplement=补充（插话/暂停续跑输入）。
   * 普通新闭环输入不携带 kind。
   * question/options（G26）：question-answer 重放时携带该回答所对的 ask_user 提问原文与
   * 候选选项（随轮落盘，roundStore RoundInteractiveInput 透出），供 webview 还原问答对；
   * supplement / 普通输入 / 旧数据不携带。
   */
  | {
      type: 'user';
      text: string;
      ts?: string;
      roundId?: string;
      kind?: InteractiveInputKind;
      question?: string;
      options?: string[];
    }
  /** 历史/流式 assistant 消息（历史回放用 text 完整段） */
  | { type: 'assistant'; text: string; ts?: string; roundId?: string }
  /**
   * 流式 assistant 消息（流式输出经 chunk 拼接，仅承载主回答正文）
   *
   * 注（v1.5）：自审查文本不再走本通道（host 已按 text_self_review 过程事件转发，
   * 渲染进 round-block § 自审查输出）——chunk 只负责最终答案正文。
   * guardrailBlocked：对齐内核 text chunk 的护栏阻断标记（§7.2.1 结构化信号）。
   * 仅护栏阻断的那一条 chunk 携带 true；webview 据此渲染「护栏阻断」提示条。
   */
  | {
      type: 'chunk';
      content: string;
      ts?: string;
      guardrailBlocked?: boolean;
      /**
       * turn roundId（D3 单轨，2026-09-03）：宿主从内核 chunk.roundId 透传，
       * webview 端「同环续接」判定统一走 roundId 相等（运行时与重放共用单一判定源，
       * 不再依赖独立时序标志）。持久化落盘归属已由宿主用同源 roundId 完成，此处仅供展示判定。
       */
      roundId?: string;
    }
  | {
      type: 'done';
      /**
       * 本轮问答闭环的 roundId（round-based 会话消息底部分叉按钮回填用）：
       * webview 据此启用刚完成回答的分叉按钮；无 roundId（异常/空会话）时可缺省。
       */
      roundId?: string;
    }
  | { type: 'error'; message: string; category?: 'connection' | 'timeout' | 'unknown' }
  /**
   * 流被用户中断（stop 的应答）
   *
   * host 在 AbortController.abort() 后发送：告知 webview 本轮输出已中止，
   * 用于：(1) 恢复输入框/停止按钮状态；(2) 渲染「已停止」提示；
   * (3) 区分「正常结束(done)」与「用户主动打断(interrupted)」。同时携带本轮
   * roundId（与 done 同语义）：打断也可能产生部分回答，允许从该轮分叉。
   */
  | { type: 'interrupted'; roundId?: string }
  /**
   * 回抽正文（A1，2026-09-12）
   *
   * 成因：首轮（无工具史）消息级分类前无法预判是否工具轮，为保 TTFT 零损失叙述文本已逐字
   * 流式进正文区；内核收到 toolCalls 确认工具轮后，随 narrate chunk 下发 withdrawn 原文，
   * 宿主透传本消息让 webview 把该段从正文移除（正文全量重渲染自 streamingRaw，去后缀即可），
   * 该段随后由 narrate 过程事件渲染进过程叙述折叠行——运行时与后续轮同构。
   *
   * 运行时瞬态：不入 processEvents、不落盘。重放的一致由 Round.assistantMessage 已在
   * 持久化侧（内核 consumeExecutionStream）扣除该段保证，不依赖本消息。
   */
  | { type: 'narrate_withdraw'; text: string }
  /**
   * 工具意图预告（2026-09-17）：内核在 LLM 流式生成 tool_call 参数期间（name 一成形即触发）
   * 上报的瞬态消息——工具**尚未执行**。webview 据此提前渲染「准备中」工具行，消除大参数工具
   * （如 write_file 全量写入）数十秒参数生成段的 UI 真空。属展示轨：**不入 processEvents、不落盘**；
   * 后续 tool_start（process_event）按 toolCallId 与前置 pending 行配对升级为执行态。
   */
  | { type: 'tool_pending'; toolCallId?: string; name: string; roundId?: string }
  /**
   * 过程事件（运行时单形态渲染投影，v1.5 协议纯化）
   *
   * 由 extension host 在 consumeFlow 旁路将 AgentChunk / 主机事件归一为 ProcessEvent 后逐条推送；
   * webview 一律 append 到当前轮 events[] 由 renderRoundBlock 统一渲染（与 replay_events 同路径）。
   * 取代原 thinking / tool_start / tool_result / self_review / memory 渲染类消息。
   */
  | { type: 'process_event'; event: ProcessEvent }
  /**
   * 重放批次（对 loadRoundBasedHistory 的 processEvents 整批投递，v1.5）
   *
   * 与 process_event 同路径：webview 把 events 一次性塞入当前轮 events[] 渲染。
   * 按 round 交织发送（meta 先于该轮 assistant 正文写入 currentRoundMeta）。
   * `interrupted`（2026-09-15）：中断轮（Round.status==='interrupted'）标志——webview 据此把
   * 过程独立平铺可见、不挂 assistant 折叠块。
   */
  | { type: 'replay_events'; roundId: string; events: ProcessEvent[]; interrupted?: boolean }
  /**
   * 任务看板更新（H4 任务驱动多步闭环 · 最小可视化，2026-08-23）
   *
   * 由 extension host 在监听到 LLM 调用 task_table_write / task_table_update 工具时推送：
   * 从 agent.getCheckpoint().plan 提取当前计划快照，webview 据此渲染/刷新任务进度看板。
   * 仅当 plan 非空时推送（空计划不产生看板）。状态任一（pending/active/done/blocked）
   * 映射由 webview 转为中文标签 + 配色。只读展示，不参与 LLM 执行（薄壳装配铁律）。
   * 任务看板归 checkpoint 执行态，不参与 processEvents 复原（见设计文档 §四）。
   */
  | { type: 'plan_update'; steps: PlanStepDto[] }
  /**
   * LLM 调用重试（对齐内核 retry chunk，P1 事件流全量对齐）
   *
   * 内核在 LLM 失败重试时产出；webview 渲染低扰提示条「LLM 重试 n/m…」。
   */
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
  /**
   * Agent 暂停（对齐内核 paused chunk，P1 事件流全量对齐）
   *
   * 内核在输入待定/step 边界软暂停时产出；webview 渲染提示条「Agent 已暂停」。
   */
  | { type: 'paused' }
  /**
   * 活动指标快照（P2：§13.x 透明面板 + §5.2.1 指纹可见）
   *
   * 每轮流式结束后由 extension host 推送：本轮指纹（系统提示 hash 前 12 位，只记 hash
   * 不记内容）+ 累计指标（LLM 调用 / 工具失败 / 截断）。
   * webview 渲染为默认折叠的「活动指标」区。
   * 注：原 attachedMemoryCount / recallHitRate 已于 2026-09-11 删除——自动记忆注入退役后
   * 两者恒零（假指标），字段的存在本身即在宣称一件已不存在的事。
   */
  | {
      type: 'metrics';
      fingerprints: {
        systemPromptHash?: string;
      };
      metrics: {
        llmCallCount: number;
        toolFailureCount: number;
        /**
         * 未解析文本工具意图累计数（2026-09-14 静默失败修复，诊断面板透出）。
         * 与过程轨增量 unparsedToolIntentCount 同源（AgentMetrics.tools），累计口径。
         */
        unparsedToolIntentCount?: number;
        truncationCount: number;
        /** D（alignment-iteration.md）：LLM token 用量（输入/输出） */
        llmTokenIn?: number;
        llmTokenOut?: number;
        /** ④（2026-08-29）：最近一次输入装配的上下文预算构成（可选：内核 AgentMetrics.context.budget 透传，缺省不显示） */
        budget?: {
          availableTokens: number;
          anchorTokens: number;
          remainingTokens: number;
          dialogueBudgetTokens: number;
        };
      };
      /**
       * 最近操作流（B9 可观测补齐）：透明面板渲染的操作序列 span 标签（新→旧）。
       * 由 host 从 vscodeTracer 提取，只含中文展现标签不含量化属性；缺省为无。
       */
      trace?: { label: string }[];
      /**
       * 路径守卫审计概要（G6 安全/装配透明，2026-08-23）
       *
       * 累计安全审计次数 + 拒绝次数 + 最近若干条（只含 basename 路径，防折叠区冗长）。
       * 数据源 = 内核 SecurityGuard.onAudit（路径守卫读/写/审计事件；guardrail 已从内核
       * 移除，路径守卫是当前唯一真实安全信号）。
       */
      securityAudit?: {
        total: number;
        denied: number;
        recent: { type: string; path: string; tool?: string; reason?: string }[];
      };
    }
  /**
   * 上下文占用快照（④ 预算可视化 · 输入区常驻指示器数据源）
   *
   * 每轮流式结束后由 extension host 推送（脱离 memora.showMetrics 独立常驻）：内核
   * AgentMetrics.context.occupancy 透传，各段为 prepare 期**真实用量** token，互斥分段拼满
   * 窗口总容量 totalTokens。webview 在输入区渲染比例条 + hover 明细。
   */
  | {
      type: 'context_occupancy';
      occupancy: {
        /** 窗口总容量（token）= maxContextTokens */
        totalTokens: number;
        /** 角色包/系统基础设定占用（system prompt） */
        rolePackBaseTokens: number;
        /** 完整对话层实际占用（最近轮次注入正文） */
        dialogueTokens: number;
        /** 完整对话层注入的对话条数（user+assistant 消息总数，与 dialogueTokens 同源） */
        dialogueCount: number;
        /** 当前输入锚点（本轮用户输入独立划块） */
        inputAnchorTokens: number;
        /** 输出预留（窗口 × 输出预留比例，留作模型回答容量） */
        outputReserveTokens: number;
        /** 剩余可用（total − 各段，≥ 0） */
        freeTokens: number;
      };
    }
  /**
   * 角色能力徽章（Phase 4 工具权限 UI，E2 工具白名单可见性）
   *
   * 角色包激活时由 host 推送：工具模式（allow/block）+ 能力标签列表 + 策略指示器。
   * webview 据此在输入区角色徽章旁追加工具权限徽章，让用户直观感知「当前角色能做什么」：
   *   - block：纯 LLM 模式，无工具暴露
   *   - allow + capabilities：按能力白名单暴露工具（如只读/可读写+联网）
   *   - allow + 空 capabilities：全工具暴露
   * 新增 strategyHint 提供策略级提示（只读模式/审批模式/温度），让用户感知角色行为偏好。
   */
  | {
      type: 'capability_badge';
      toolMode: 'allow' | 'block';
      capabilities: { capability: string; label: string }[];
      /** 关键策略指示器（新增，供渲染只读/审批/温度等策略徽章） */
      strategyHint?: RoleStrategyIndicatorDto;
    }
  /**
   * Agent 运行状态（P0-2 状态可视化 + Phase 4 暂停/恢复）
   *
   * 让用户看见 Agent 正在做什么，而非静默等待：
   *   - 'thinking'：Agent 正在生成（展示加载动画，输入框禁用）
   *   - 'done'：本轮结束（恢复输入框）
   *   - 'paused'：Agent 已暂停（用户可点击「继续」恢复执行）
   * 与 done/error 配合，构成完整的「进行中 → 结束」状态机。
   */
  | { type: 'status'; state: 'thinking' | 'done' | 'paused' }
  /** 清空会话完成（webview 收到后清空消息区） */
  | { type: 'clear_ok' }
  /**
   * 历史消息加载完成（宿主回放会话历史后推送，2026-08-24 新增）
   *
   * 宿主在 replaySession() 中发送完所有历史消息后推送此信号，
   * webview 收到后强制滚到底部（不走吸底逻辑），确保打开会话时
   * 默认显示最新消息而非历史顶部。
   */
  | { type: 'history_loaded' }
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
   * limitTokens = 该 Provider 的上下文窗口上限（宿主经内核 resolveContextWindow 解析：
   * 用户 per-LLM 配置的 contextWindow，未配置回落内核默认 120K）——webview 据此在
   * 首轮对话前实时渲染输入区上下文占用条的容量上限，不重复引入内核默认值。
   */
  | {
      type: 'chat_providers';
      providers: { name: string; displayName: string; contextWindow?: number; limitTokens: number }[];
      activeName?: string;
    }
  /**
   * Agent 主动提问（mvp-scope §三：ambiguity/decision/missing_info）
   *
   * 实际来源：extension host 监听内核 questionPending 事件（LLM 调 ask_user 工具路径）
   * 后转发，触发 Agent 暂停（pause），等待用户在提问
   * 输入框回答；收到 clarify_answer 后 host 调 agent.answerQuestion() 回填 + resumeExecution 续跑。
   *
   * 注：内核 needClarify 事件（P4 任务槽位补全/composer 路径）已于 2026-09-03 整链剪枝，
   * ask_user 为唯一提问通道——本消息类型由 questionPending 事件（主）+ question_pending
   * chunk（幂等兜底，TS-O3/TS-O5）归一驱动渲染。
   */
  | {
      type: 'need_clarify';
      questions: { slot: string; question: string; options?: string[]; allowCustom?: boolean }[];
    }
  /**
   * 目标漂移检测提示（H2 事件：goalDriftDetected）
   *
   * 由 extension host 监听内核 goalDriftDetected 事件后转发，
   * 当会话当前目标与初始目标相似度低于阈值时触发，webview 展示确认/忽略交互。
   * level: 'confirm' 需用户确认目标变更；'drift' 提示可能已严重偏离。
   */
  | {
      type: 'goal_drift_detected';
      mainGoal: string;
      newGoal: string;
      similarity: number;
      level: 'same' | 'confirm' | 'drift';
      constraints: string[];
    }
  /**
   * 通用提示条（低扰 info / 错误级 error）
   *
   * 由 extension host 转发的非消息区通知，webview 用同一提示条分级呈现：
   *   - info：记忆召回/沉淀、上下文截断、记忆冲突等低扰信息（短暂显示）
   *   - error：会话异常/恢复失败/guardrail 失败等错误级反馈（醒目、停留更久）
   * 统一走提示条而不插入消息区，避免污染对话历史（功能→UI 对齐排雷的雷-4 修正）。
   * 注（v1.5）：运行时的「已召回 N 条 / 已沉淀：xx」提示由 webview 解析 process_event 本地派生，
   * 不经本消息通道（记忆活动已收口到 ProcessEvent 单源）。
   */
  | { type: 'notice'; level: 'info' | 'error'; message: string }
  /**
   * 待发送区队列更新（Phase 4 暂停/恢复）
   *
   * thinking 态 interject 排队时 host 从内核 loop.pendingInterjections 读快照，立即 post 给 webview
   * 渲染待发送区预览。sessionResumed 事件后 queue 清空，webview 同步隐藏待发送区。
   */
  | { type: 'pending_queue_update'; items: readonly string[] }
  /**
   * 暂停申请在途状态（2026-09-07 新增，Gap 修复 1）
   *
   * 内核 requestPause 成功入队（step 边界未到）→ host 推 pending:true；
   * 取消申请（cancelPauseRequest）/ 申请作废（空闲守卫）→ 推 pending:false。
   * webview 借此把暂停键在「申请窗口期」即时切为「继续（可反悔）」形态——
   * 用户心智只有 暂停/继续 两态：申请在了就是"在暂停"（站台等车，车没到也是暂停）。
   */
  | { type: 'pause_pending'; pending: boolean }
  /**
   * Chat Panel 当前激活角色包（消息区顶部角色徽章数据）
   *
   * 面板为通用对话宿主，定位由内置角色包承载。host 在就绪回放时推送，
   * webview 据此在消息区顶部渲染角色徽章——主动可见：用户始终知道当前用哪个角色
   * （不依赖角色匹配事件，避免普通对话不匹配时徽章永远不显示）。
   */
  | {
      type: 'chat_role_pack';
      rolePack: string;
      /** 角色性格特征简要，用于徽章/顶栏展示（可选，无 trait 时不展示） */
      traits?: Record<string, number>;
      /** 当前 activePack 作为组长的队伍（可选；无队伍或非组长时 undefined）
       *  team.members 已由内核走 activeTeamMembers 截断（超限不参与），
       *  保证宿主 UI 看到的参与名单与内核会议实际消费一致（SSOT）。 */
      team?: { leader: string; members: readonly string[] };
    }
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
        /** 来源层（2026-08-30）：builtin=内置（configDir/role-packs），user=用户（globalStorageUri/role-packs） */
        source?: 'builtin' | 'user';
        capabilities: { capability: string; label: string }[];
        /** 角色性格特征（从 persona.md frontmatter traits 解析，0-1 数值） */
        traits?: Record<string, number>;
        /** 接手衔接提示词（带入对话时预填的特色话术） */
        handoffPrompt?: string;
        /** 关键策略指示器（从内核完整策略提取的 UI 友好摘要） */
        strategyHint?: RoleStrategyIndicatorDto;
        /** 拟人化类型（tool_assistant=工具型 / companion=陪伴型） */
        interactionType?: 'tool_assistant' | 'companion';
        /** 版本号 */
        version?: string;
        /** 该角色包作为组员被哪些组引用（v0.13 S7：仅小组会议用，标注展示） */
        teamMembers?: readonly string[];
        /** 兜底契约包标记（BUILTIN_FALLBACK_PACK，宿主 UI 禁删） */
        isFallback?: boolean;
        /** manifest 校验问题（G29 健康徽章数据源，镜像 skills_loaded 的 SkillIssueDto 结构） */
        issues?: readonly RoleIssueDto[];
      }[];
      /** 组（会议名单）：组长 + 组员（v0.13 S7，宿主用户级数据） */
      teams: { leader: string; members: string[] }[];
      activeName: string;
      /**
       * 小组会议组员数量上限（SSOT 下发，② 组队规格）：由宿主从内核常量
       * `MAX_TEAM_MEMBERS` 透传——webview 运行在浏览器沙箱，不可直连内核包，
       * 故经本字段下发，UI 侧禁止另写字面量。
       */
      maxTeamMembers: number;
    }
  // ─── 大模型配置面板消息 ───
  /** Provider 列表加载完成（apiKey 为脱敏值，供展示） */
  | {
      type: 'cfg_loaded';
      providers: LlmProviderConfig[];
      activeName: string | undefined;
      backgroundName?: string;
    }
  /** 配置操作结果（保存/删除/设当前/测试） */
  | { type: 'cfg_result'; ok: boolean; message?: string; action: 'save' | 'delete' | 'set_active' | 'test' }
  // ─── 记忆管理面板消息（2026-08-17 独立视图） ───
  /**
   * 记忆列表加载完成（对 memory_load 的应答）
   *
   * host 返回按 accessedAt 降序的记忆列表 + source 分布统计；agent.memory 未就绪时
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
   * hits 为 searchHybrid 命中（带 accessedAt），content 为截断预览
   * （与列表的全文 content 区分——搜索场景看相关性即可）。
   */
  | { type: 'memory_search_result'; query: string; hits: MemoryItemDto[] }
  /**
   * 记忆列表翻页结果（对 memory_page 的应答，2026-09-08）
   *
   * page 与请求页一致（webview 据 pager.getPage() 竞态校验，防滞后响应覆盖新页）。
   */
  | { type: 'memory_page_result'; page: number; items: MemoryItemDto[] }
  // ─── 记忆治理：删除/恢复结果 + 回收站列表（G19，2026-08-25 新增） ───
  /**
   * 删除记忆结果（对 memory_delete 的应答）
   *
   * ok=true 时 host 已删除并刷新记忆列表 + 治理统计；webview 据此刷新回收站（若展开）。
   */
  | { type: 'memory_deleted'; ok: boolean; id: string; message?: string }
  /**
   * 恢复记忆结果（对 memory_restore 的应答）
   *
   * ok=true 时 host 已恢复并刷新；webview 据此重新拉取回收站列表（若展开）。
   */
  | { type: 'memory_restored'; ok: boolean; id: string; message?: string }
  /** 回收站列表加载完成（对 memory_recycle_load 的应答） */
  | { type: 'memory_recycle_loaded'; items: MemoryItemDto[] }
  /**
   * 永久删除回收站单条记忆结果（对 memory_purge 的应答，2026-08-26）
   *
   * ok=true 时 host 已 writePurge（不可恢复）并刷新回收站/列表/治理；ok=false 显示错误。
   */
  | { type: 'memory_purged'; ok: boolean; id: string; message?: string }
  /**
   * 清空回收站结果（对 memory_recycle_clear 的应答，2026-08-26）
   *
   * ok=true 时 host 已物理删除全部软删记忆（不可恢复）；count 为清除数量。
   */
  | { type: 'memory_recycle_cleared'; ok: boolean; count: number; message?: string }
  /**
   * 编辑记忆结果（对 memory_edit 的应答，G19 内联 edit 收尾，2026-08-25 新增）
   *
   * ok=true 时 host 已 writeUpsert 并刷新记忆列表 + 治理统计（webview 收到后编辑态随
   * 卡片重建自然消失）；ok=false 时 webview 显示 message 错误提示。
   */
  | { type: 'memory_edited'; ok: boolean; id: string; message?: string }
  // ─── 记忆治理面板消息（G4，2026-08-23 新增） ───
  /**
   * 记忆治理数据加载完成（对 governance_load 的应答）
   *
   * 含活跃数 / 回收站（软删除）数 / 来源分布。agent.memory 未就绪时
   * active/deleted 为 0、bySource 为空，webview 渲染全零统计。
   */
  | { type: 'governance_loaded'; stats: GovernanceStatsDto }
  /**
   * 记忆治理操作结果（对 governance_cleanup 的应答）
   *
   * ok=false 时 message 为失败原因；成功时 message 为操作摘要。
   * webview 据此在治理区展示结果提示，并重新拉取治理数据与记忆列表。
   */
  | { type: 'governance_result'; ok: boolean; message?: string; action: 'cleanup' }

  // ─── 设置视图消息（2026-08-17 选项卡合并） ───
  /** 切换设置视图的子选项卡（host → webview 指令） */
  | { type: 'settings_switch_tab'; tab: 'roles' | 'config' | 'memory' | 'skills' }

  // ─── 技能管理面板消息（2026-08-22 新增） ───
  /** 全局技能列表加载完成（对 skills_load 的应答） */
  | { type: 'skills_loaded'; skills: SkillDto[] }
  /** L2 渐进披露：请求读取技能正文（按需加载，不预装载到 L1 列表） */
  | { type: 'skills_read_content'; skillName: string }
  /** L2 渐进披露：技能正文响应（对 skills_read_content 的应答） */
  | { type: 'skill_content'; skillName: string; content: string }
  // ─── Follow-up 建议消息（2026-08-17 回复后关联推荐） ───
  /**
   * 回复完成后的 Follow-up 建议（对 governance.suggest() 的结果推送）
   *
   * host 在本轮流式正常结束后调 agent.governance.suggest()（零 LLM、纯计算，
   * 基于记忆库 accessedAt 时效 + 多样性推荐），映射为「下一步可探索」chips 推给 webview；
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
  | { type: 'prefill_input'; text: string }
  /**
   * 文本润色结果（对 polish_text 的应答，H5 文本润色入口）
   *
   * ok=true 时 text 为润色后文本，webview 替换原消息内容；
   * ok=false 时 message 为失败原因（如超时、润色服务不可用）。
   * msgId 对应原 polish_text 请求的 msgId，确保结果能正确回写到对应消息。
   */
  | { type: 'polish_result'; ok: boolean; msgId: string; text?: string; message?: string }
  /**
   * 输入框文本润色结果（对 polish_input 的应答，2026-08-27）
   *
   * ok=true 时 text 为润色后文本，webview 替换输入框内容；
   * ok=false 时 message 为失败原因（如超时、润色服务不可用）。
   */
  | { type: 'polish_input_result'; ok: boolean; text?: string; message?: string }
  // ─── 安全/写入审批消息（H0：E→W 方向） ───
  /**
   * 写入审批请求（E→W：内核触发写入确认时，由 host 推送到 chat webview）
   *
   * 当 confirmWrites=true 且发生文件写入操作时，host 生成审批请求推送给 webview。
   * webview 渲染审批卡（显示目标文件、工具名、diff 预览），用户点击确认/拒绝后
   * 发送 write_confirm_answer 回传结果。
   */
  | {
      type: 'write_confirm_request';
      requestId: string;
      targetPath: string;
      tool: string;
      description?: string;
      permission: string;
      beforeContent?: string | null;
      afterContent?: string;
    }
  /**
   * 安全设置状态推送（设置面板加载时推送当前开关状态）
   *
   * 由 host 在 settings 视图 ready 时推送，webview 据此渲染 toggle 初始状态。
   * enabled=true 时开关高亮开启。
   */
  | { type: 'security_status'; confirmWrites: boolean; confirmScripts: boolean }
  /**
   * 白名单额外允许路径状态推送（设置面板加载时推送当前列表）
   *
   * 由 host 在 settings 视图 ready / 增删后推送，webview 据此渲染列表。
   * projectPath 用于渲染只读基准行；paths 为用户额外目录数组（不含基准根）。
   */
  | { type: 'allowed_paths_status'; projectPath: string; paths: string[] }
  /**
   * 网页搜索引擎状态推送（设置面板加载时推送当前选择）
   *
   * 由 host 在 settings 视图 ready / 用户修改后推送，webview 据此渲染下拉选中项。
   */
  | { type: 'search_engine_status'; engine: SearchEngineSetting };

/** 角色策略指示器（从内核 BehaviorStrategy 提取的关键策略摘要，供 UI 渲染图标/徽章） */
export interface RoleStrategyIndicatorDto {
  /** 工具只读模式（readonly=仅只读操作 / full=完整权限） */
  toolReadonly?: 'readonly' | 'full';
  /** 生成温度分组（high=0.8+ / low=0.4- / mid=之间） */
  tempGroup?: 'high' | 'mid' | 'low';
  /** 多步推理模式 */
  reasoningMode?: 'auto' | 'manual';
  /** 摘要聚焦方向（如 'code' / 'creative' / 'general'） */
  summaryFocus?: string;
  /** 单轮输出上限（token，0=不限制） */
  outputLimit?: number;
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

/** 记忆治理统计（治理区，G4 2026-08-23：对齐 memory.stats + listDeleted） */
export interface GovernanceStatsDto {
  /** 活跃记忆数（未软删除） */
  active: number;
  /** 回收站记忆数（软删除） */
  deleted: number;
  /** 按来源标签分组的活跃记忆数量（供治理区展示分布） */
  bySource: Record<string, number>;
  /** 已被取代的记忆数（supersededBy 非空的活跃记忆，对齐内核 supersede 治理模型） */
  superseded: number;
}

/** 记忆条目（记忆视图列表/搜索结果，host 从内核 Memory/AgentSearchHit 归一化） */
export interface MemoryItemDto {
  /** 记忆唯一标识（${source}:${name} 格式） */
  id: string;
  /** 记忆名称 */
  name: string;
  /** 来源标签（round-summary / profile / work-projection 等） */
  source: string;
  /** 内容（列表=全文；搜索结果=截断预览，供详情展开展示） */
  content: string;
  /** 创建时间（ISO 8601，可选） */
  createdAt?: string;
  /** 最近访问时间（ISO 8601，可选；排序依据 accessedAt 降序，工具命中即 touch 刷新） */
  accessedAt?: string;
  /** 软删除时间（ISO 8601，仅回收站条目携带，可选） */
  deletedAt?: string;
  /** round-summary 摘要类型（preference/fact/decision/intent/general），仅 round-summary 有意义；对齐内核 SummaryType */
  summaryType?: 'preference' | 'fact' | 'decision' | 'intent' | 'general';
  /** round-summary 归属会话标识（${date}-${session}），供会话内/外分层召回 */
  sessionName?: string;
  /** round-summary 归属轮次标识，供互斥轮次排除与回溯 */
  roundId?: string;
  /** 摘要是否已被人工修改（可能与原始对话不一致）；仅 round-summary 有意义 */
  isModified?: boolean;
  /** 写路径取代标记：非 undefined 表示已被更新的摘要覆盖（值为取代它的新摘要 id） */
  supersededBy?: string;
}

/** 全局技能条目（技能视图列表，2026-08-22 新增） */
export interface SkillIssueDto {
  /** 级别：error=不可生效 / warning=可加载但变弱 */
  level: 'error' | 'warning';
  /** 问题描述（含影响说明，供 UI 错误定位） */
  message: string;
}

/** 角色包校验问题（G29 健康徽章数据源，2026-09-08 镜像 SkillIssueDto；映射内核 RolePackValidationIssue） */
export interface RoleIssueDto {
  /** 级别：error=拒绝装载语义 / warning=可装载但提示 */
  level: 'error' | 'warning';
  /** 问题描述（映射内核 issue.message） */
  message: string;
}
export interface SkillDto {
  /** 技能名称 */
  name: string;
  /** 技能描述 */
  description: string;
  /** 技能文件路径（用于定位来源） */
  filePath?: string;
  /** 技能来源三分类（SSOT 收紧，2026-08-25）：'builtin'（系统内置）/ 'rolepack'（启用角色包内置）/ 'user'（用户本地目录自定义） */
  layer?: 'builtin' | 'rolepack' | 'user';
  /** 健康状态（G22 写→验→用，2026-08-25）：error=未生效（不进 LLM 清单）/ warn=可加载但可优化 / 缺省=角色包等未校验项按可用处理 */
  health?: 'ok' | 'warn' | 'error';
  /** 校验问题清单（health!=='ok' 时携带，供列表/展开区错误定位） */
  issues?: SkillIssueDto[];
}

/** 任务看板步骤条目（对齐内核 PlanStep 扁平化） */
export interface PlanStepDto {
  /** 步骤唯一标识 */
  id: string;
  /** 步骤描述 */
  description: string;
  /** 步骤状态（pending/active/done/blocked，由 webview 映射为中文标签） */
  status: 'pending' | 'active' | 'done' | 'blocked';
  /** 执行顺序（从 0 开始） */
  order: number;
  /** 该步骤已关联的 step 推进记录（来自 checkpoint.stepLog 的 planStepId 关联，可为空数组） */
  stepLog: { planStepId: string; summary: string; completedAt?: number }[];
}

/**
 * 协议消息类型常量表（运行时验证用）
 *
 * 与 WebviewToExtensionMessage / ExtensionToWebviewMessage 联合类型保持同步，
 * 用于宿主和 webview 两侧的消息类型校验与测试。
 */
export const MESSAGE_TYPES = {
  // ─── E→W（Extension → Webview） ───
  // 对话输出
  CHUNK: 'chunk',
  RESPONSE_COMPLETE: 'response_complete',
  // 状态/事件
  SESSION_CREATED: 'session_created',
  SESSION_UPDATED: 'session_updated',
  SESSION_DELETED: 'session_deleted',
  ROLE_SWITCHED: 'role_switched',
  MEMORIES_UPDATED: 'memories_updated',
  SKILLS_UPDATED: 'skills_updated',
  GOVERNANCE_UPDATED: 'governance_updated',
  PLAN_UPDATED: 'plan_updated',
  STATUS_CHANGED: 'status_changed',
  // 输入框
  PREFILL_INPUT: 'prefill_input',
  // 文本润色
  POLISH_RESULT: 'polish_result',
  // 安全/写入审批
  WRITE_CONFIRM_REQUEST: 'write_confirm_request',
  WRITE_CONFIRM_ANSWER: 'write_confirm_answer',
  SECURITY_STATUS: 'security_status',
  ALLOWED_PATHS_STATUS: 'allowed_paths_status',
  SEARCH_ENGINE_STATUS: 'search_engine_status',
  // 观察性数据
  TRACE_UPDATE: 'trace_update',
  METRICS_UPDATE: 'metrics_update',
  ERROR: 'error',
  // ─── W→E（Webview → Extension） ───
  CHAT: 'chat',
  CHAT_SYNC: 'chat_sync',
  INTERRUPT: 'interrupt',
  PAUSE: 'pause',
  RESUME: 'resume',
  FORCE_RELEASE: 'force_release',
  // 设置/持久化
  SET_CONFIG: 'set_config',
  GET_CONFIG: 'get_config',
  SET_SECURITY_TOGGLE: 'security_toggle',
  SET_ALLOWED_PATHS: 'allowed_paths_set',
  SET_SEARCH_ENGINE: 'search_engine_set',
  // 会话管理
  CREATE_SESSION: 'create_session',
  SWITCH_SESSION: 'switch_session',
  DELETE_SESSION: 'delete_session',
  RENAME_SESSION: 'rename_session',
  LIST_SESSIONS: 'list_sessions',
  GET_SESSION: 'get_session',
  // 记忆操作
  SEARCH_MEMORIES: 'search_memories',
  ADD_MEMORY: 'add_memory',
  DELETE_MEMORY: 'delete_memory',
  RESTORE_MEMORY: 'restore_memory',
  PERMANENTLY_DELETE_MEMORY: 'permanently_delete_memory',
  CLEAN_MEMORY: 'clean_memory',
  GET_MEMORY_STATS: 'get_memory_stats',
  GET_GOVERNANCE_STATS: 'get_governance_stats',
  // 角色包
  LIST_ROLE_PACKS: 'list_role_packs',
  SET_ACTIVE_ROLE_PACK: 'set_active_role_pack',
  GET_ACTIVE_ROLE_PACK: 'get_active_role_pack',
  // 技能
  LIST_SKILLS: 'list_skills',
  EXECUTE_SKILL: 'execute_skill',
  // 命令
  EXECUTE_COMMAND: 'execute_command',
  // 文本润色
  POLISH_TEXT: 'polish_text',
  // 任务
  GET_PLAN: 'get_plan',
  CREATE_PLAN: 'create_plan',
  UPDATE_PLAN_STEP: 'update_plan_step',
  // 其他
  GET_STATUS: 'get_status',
  GET_ROLE_PACK: 'get_role_pack',
  SET_WORKSPACE: 'set_workspace',
  OPEN_FILE: 'open_file',
} as const;

// ─── 诊断 DTO 类型已移除（2026-08-24 第一性原理复盘） ───
// 复杂治理细节（取代/加权）超越终端用户需要（ChatGPT 仅暴露「记住了什么+删改」），
// 且记忆明文存于 .memora/memories.json 用户可直接读；内核治理机制强制自动跑，无终端用户场景。
// 相关消息类型（governance_source_health / governance_detect_conflicts / governance_deduplicate /
// governance_evaluate_timeliness / source_health_loaded / conflict_detection_loaded /
// dedup_result / timeliness_result）及 DTO 一并删除，避免 orphaned 协议类型与死代码。
