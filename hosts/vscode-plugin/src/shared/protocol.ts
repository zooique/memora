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
  /** 历史/流式 assistant 消息（流式输出经 chunk 拼接，历史回放用 text 完整段） */
  | { type: 'assistant'; text: string; ts?: string }
  | { type: 'chunk'; content: string; ts?: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /**
   * 工具调用开始（Agent 循环的步骤，手动具象化）
   *
   * 由 extension host 转发内核 tool_start chunk，webview 渲染「执行中」工具卡片。
   * 卡片默认折叠，减少视觉干扰；toolCallId 用于和 tool_result 匹配更新。
   */
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  /** 工具调用结束（成功/失败 + 结果摘要），更新对应卡片状态 */
  | {
      type: 'tool_result';
      toolCallId: string;
      name: string;
      ok: boolean;
      summary?: string;
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
   * Chat Panel 当前激活 Skill（toolbar 技能徽章数据）
   *
   * 面板定位「文档打磨」，装配 doc-review skill。host 在就绪回放时推送，
   * webview 据此在标题旁渲染技能徽章——主动可见：用户始终知道当前用哪个技能
   * （不依赖 skillMatched 事件，避免普通对话不匹配技能时徽章永远不显示）。
   */
  | { type: 'chat_skill'; skill: string }
  // ─── 大模型配置面板消息 ───
  /** Provider 列表加载完成（apiKey 为脱敏值，供展示） */
  | { type: 'cfg_loaded'; providers: LlmProviderConfig[]; activeName: string | undefined }
  /** 配置操作结果（保存/删除/设当前/测试） */
  | { type: 'cfg_result'; ok: boolean; message?: string; action: 'save' | 'delete' | 'set_active' | 'test' };
