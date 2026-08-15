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
 * - apiKey 存 SecretStorage（不落盘 settings.json），模型/baseUrl 存 configuration
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
  /** 清空当前会话对话（P1-体验：清空对话按钮） */
  | { type: 'clear' }
  /** Chat Panel 切换激活 Provider（底部模型下拉框） */
  | { type: 'chat_set_provider'; name: string }
  /**
   * Chat Panel 切换激活角色包（身份条角色下拉，alignment-iteration.md A3）
   *
   * 由身份条角色选择器触发，host 调 agent.rolePackManager.activate(name) 切换角色；
   * 切换后内核 emit personaSwitched → host 转发 chat_role_pack 刷新身份条（A1 已绑定）。
   */
  | { type: 'chat_set_role_pack'; name: string }
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
  | { type: 'cfg_test'; config: LlmProviderConfig };

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
   * Chat Panel Provider 列表同步（底部模型下拉框的数据）
   *
   * 扩展侧在渲染/切换时推送最新 Provider 列表及激活状态，
   * webview 下拉框据此刷新选项。
   */
  | { type: 'chat_providers'; providers: { name: string; displayName: string }[]; activeName?: string }
  /**
   * Agent 主动提问（mvp-scope §三：ambiguity/decision/missing_info）
   *
   * 由 extension host 监听内核 needClarify 事件后转发，触发 Agent 暂停（pause），
   * 等待用户在提问输入框回答；收到 clarify_answer 后调 resumeExecution 续跑。
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
  | { type: 'chat_role_pack'; rolePack: string; webSearch?: boolean }
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
  // ─── 大模型配置面板消息 ───
  /** Provider 列表加载完成（apiKey 为脱敏值，供展示） */
  | { type: 'cfg_loaded'; providers: LlmProviderConfig[]; activeName: string | undefined }
  /** 配置操作结果（保存/删除/设当前/测试） */
  | { type: 'cfg_result'; ok: boolean; message?: string; action: 'save' | 'delete' | 'set_active' | 'test' };
