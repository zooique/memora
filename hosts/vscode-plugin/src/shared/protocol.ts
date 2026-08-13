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
  /** API Key（SecretStorage 存储；传输给 webview 时为脱敏值或空） */
  apiKey: string;
  /** Provider 标识（'cloud' | 'local'） */
  provider?: string;
}

/** Webview → extension 消息 */
export type WebviewToExtensionMessage =
  | { type: 'send'; text: string }
  /** 用户对 Agent 主动提问（need_clarify）的回答，触发 resumeExecution 续跑 */
  | { type: 'clarify_answer'; text: string }
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
  | { type: 'user'; text: string }
  /** 历史/流式 assistant 消息（流式输出经 chunk 拼接，历史回放用 text 完整段） */
  | { type: 'assistant'; text: string }
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /**
   * LLM 运行状态（P0-2 状态可视化）
   *
   * 让用户看见 Agent 正在做什么，而非静默等待：
   *   - 'thinking'：Agent 正在生成（展示加载动画，输入框禁用）
   *   - 'done'：本轮结束（恢复输入框）
   * 与 done/error 配合，构成完整的「进行中 → 结束」状态机。
   */
  | { type: 'status'; state: 'thinking' | 'done' }
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
  | { type: 'memory'; action: 'recalled' | 'added'; count: number }
  // ─── 大模型配置面板消息 ───
  /** Provider 列表加载完成（apiKey 为脱敏值，供展示） */
  | { type: 'cfg_loaded'; providers: LlmProviderConfig[]; activeName: string | undefined }
  /** 配置操作结果（保存/删除/设当前/测试） */
  | { type: 'cfg_result'; ok: boolean; message?: string; action: 'save' | 'delete' | 'set_active' | 'test' };
