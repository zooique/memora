/**
 * Agent 流式输出事件类型
 *
 * 核心库向上层 emit 结构化事件，让 CLI/Web/TUI 等宿主项目
 * 能区分"思考中"、"输出文本"、"调用工具"等阶段，给用户实时反馈。
 *
 * 自然生长原则：这是核心库的"机制"——所有宿主项目都需要进度反馈，
 * 不是 demo 的"策略"。
 *
 * thinking 事件的 phase 取值：
 * - 'recalling'：正在召回会话记忆（recall 双通道：语义 + 关键词）
 * - 'processing'：正在写入历史/注入技能 prompt
 * - 'archiving'：正在归档用户画像/匹配角色/匹配技能
 */

/** thinking 事件的阶段标识 */
export type ThinkingPhase = 'recalling' | 'processing' | 'archiving';

export type AgentChunk =
  | { type: 'recall'; count: number }
  | { type: 'thinking'; phase: ThinkingPhase }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }
  | { type: 'done' };

// ─── 宿主可覆盖的 UI 文本 ────────────────────────────────

/**
 * 宿主可覆盖的 UI 消息文本
 *
 * 核心库内置英文默认值，宿主可通过 AgentOptions.messages
 * 覆盖为任意语言（中文/日文/自定义）。
 *
 * 遵循领域无关原则：核心库不耦合特定语言。
 */
export interface UIMessages {
  /** 对话取消提示（默认 "User cancelled the conversation"） */
  abortedByUser?: string;
  /** 达到最大迭代次数提示（默认 "\n\n[Max iterations reached]"） */
  maxIterationsReached?: string;
  /**
   * 上下文窗口截断提示生成函数
   * @param skipped 被裁剪的消息数
   * @param kept 保留的消息数
   * @returns 系统消息内容
   */
  contextTruncated?: (skipped: number, kept: number) => string;
  /** 最近对话标签（默认 "[Recent conversation]"） */
  recentConversationLabel?: string;
  /** 用户角色标签（默认 "User"） */
  userLabel?: string;
  /** 助手角色标签（默认 "Assistant"） */
  assistantLabel?: string;
  /** 护栏阻断提示模板（{rule} 会被替换为规则名） */
  inputBlockedByGuard?: (rule: string) => string;
  /** 护栏警告前缀（默认 "[Guardrail Warning]"） */
  guardrailWarningPrefix?: string;
  /** 输出被护栏阻断提示模板 */
  outputBlockedByGuard?: (rule: string) => string;
}
