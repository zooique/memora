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
 * - 'recalling'：正在召回话题记忆（topicMount.focus）
 * - 'processing'：正在写入历史/注入技能 prompt
 * - 'archiving'：正在归档用户画像/匹配身份/匹配技能
 */

/** thinking 事件的阶段标识 */
export type ThinkingPhase = 'recalling' | 'processing' | 'archiving';

export type AgentChunk =
  | { type: 'recall'; count: number }
  | { type: 'thinking'; phase: ThinkingPhase }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'done' };
