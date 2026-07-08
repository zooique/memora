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
 *
 * error 事件：流式过程中发生错误（如 LLM 超时、连接断开），
 * 替代裸 throw 让宿主能优雅展示错误并清理 UI（避免未处理 rejection 静默卡死）。
 */

/** thinking 事件的阶段标识 */
export type ThinkingPhase = 'recalling' | 'processing' | 'archiving';

/**
 * 召回记忆摘要（用于 UI 展示"召回透明度"）
 *
 * 仅暴露 UI 展示所需字段，不包含 content（避免向 UI 层泄露完整记忆内容）。
 * - name：可读名称，点击跳转记忆详情
 * - score：相似度分数（0-1），展示召回质量
 * - source：来源标签，可选展示（如 rule/insight/profile）
 */
export interface RecalledMemorySummary {
  /** 记忆唯一标识（source:name 格式，用于前端精准跳转详情） */
  id: string;
  /** 记忆可读名称（点击跳转记忆详情用） */
  name: string;
  /** 相似度分数（0-1） */
  score: number;
  /** 来源标签（开放字符串，如 'rule'、'insight'、'profile'） */
  source: string;
}

export type AgentChunk =
  | { type: 'recall'; memories: RecalledMemorySummary[] }
  | { type: 'thinking'; phase: ThinkingPhase }
  | {
      type: 'text';
      content: string;
      /**
       * 护栏阻断标志（结构化信号）
       *
       * 当输入/输出被护栏规则阻断时为 true，让 eval 框架和宿主 UI
       * 能通过结构化字段判断护栏触发，而非依赖文案子串匹配。
       * 非护栏场景的普通 text chunk 不携带此字段（undefined 等同 false）。
       */
      guardrailBlocked?: boolean;
    }
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }
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
   * 流式中断标记（默认 "\n\n[已中断]"）
   *
   * 流式输出被用户中断时，已生成的部分文本仍会写入历史，
   * 此标记追加到文本末尾，让下一轮 LLM 上下文和历史归档能识别中断响应。
   * 与 maxIterationsReached 性质相同（对话末尾状态标记）。
   */
  interrupted?: string;
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

// ─── 归档模式（ADR-015） ──────────────────────────────────

/**
 * Agent 归档模式三态控制
 *
 * 详见 ADR-015-archive-mode.md。
 *
 * - `full`（默认）：profile facts + insight + 对话原始内容（会话归档预留）全部自动归档
 * - `insights-only`：profile facts + insight 自动归档，对话原始内容需手动归档
 * - `manual`：所有归档都需手动触发，postProcess 跳过所有自动归档分支
 *
 * 设计原则：profile facts 与 insight 同属"提炼类记忆"（从输入加工得到，非原始对话），
 * 归档行为保持一致——`insights-only` 下都自动，`manual` 下都需手动。
 */
export type ArchiveMode = 'full' | 'insights-only' | 'manual';
