/**
 * Agent Loop — Agent 的核心执行引擎
 *
 * 模型自主决定何时推理、何时调用工具，循环直到输出纯文本
 * 详见 01-主架构-v4.0.md §2.1 运行闭环
 *
 * 上下文组装公式（02-上下文组装-v4.0.md §1）：
 *   上下文 = 用户主动输入 + Agent 记忆召回结果 + Agent Loop 工作记忆
 * 其中"Agent 记忆召回结果"由 TopicMount 提供，通过 processUserInput 的
 * topicMemories 参数注入。
 */
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import type { ToolDefinition } from './tool-executor.js';
import type { AgentChunk } from './types.js';
import { logger } from '@/logging/logger.js';

export interface AgentLoopOptions {
  provider: LlmProvider;
  bootstrapMemories: Memory[]; // 永驻 + 领域记忆
  toolExecutor: (name: string, args: string) => Promise<string>;
  maxIterations?: number;
  /** v4.0：系统 prompt 前缀（角色 + 用户画像 + 技能），注入到 bootstrap 记忆之前 */
  systemPromptPrefix?: string;
  /** v4.0：工具定义列表（内置 + 自定义），用于 system prompt 追加工具描述 */
  toolDefinitions?: ToolDefinition[];
  /**
   * 上下文窗口 token 上限（默认 8000）
   *
   * 桌面精灵等长运行场景下，messages 数组随对话轮次无限增长会爆 LLM 上下文窗口。
   * 当估算 token 数超过此阈值时，保留 system prompt + 最近 N 条消息，
   * 裁剪中间段，确保 LLM 请求不因上下文溢出而失败。
   *
   * 保守默认值 8000 token 对多数模型安全（DeepSeek 128K / GPT-4o 128K / 豆包 8K），
   * 宿主可通过 AgentLoopOptions 覆盖。
   */
  maxContextTokens?: number;
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;
  /** 上下文窗口 token 上限（默认 8000，约 32K 中文字符） */
  private readonly maxContextTokens: number;
  /** 字符到 token 的粗略换算比（中英文混合平均 ~2.5 chars/token，保守取 3） */
  private static readonly CHARS_PER_TOKEN = 3;

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxIterations = opts.maxIterations ?? 20;
    this.maxContextTokens = opts.maxContextTokens ?? 8000;

    // 初始化 system prompt（基于永驻记忆，v4.0 加前缀）
    const prefix = opts.systemPromptPrefix ?? '';
    this.messages.push({
      role: 'system',
      content: prefix + this.buildSystemPrompt(opts.bootstrapMemories),
    });
  }

  /**
   * 处理一轮用户输入
   *
   * @param userInput - 用户原始输入
   * @param topicMemories - 话题记忆挂载结果（TopicMount.focus() 产出），
   *   可选。传入时自动注入到上下文，实现"Agent 记忆召回结果"层
   */
  async *processUserInput(
    userInput: string,
    topicMemories?: readonly Memory[],
  ): AsyncGenerator<AgentChunk, void, unknown> {
    // 注入话题记忆召回结果（agent上下文组装协议 §1：Agent 记忆召回结果层）
    const enhancedInput = topicMemories?.length
      ? this.wrapWithTopicContext(userInput, topicMemories)
      : userInput;

    // 有话题记忆召回时，通知上层（用于 UI 展示"召回 X 条记忆"）
    if (topicMemories?.length) {
      yield { type: 'recall', count: topicMemories.length };
    }

    this.messages.push({ role: 'user', content: enhancedInput });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration++;
      logger.debug({ iteration, messageCount: this.messages.length }, 'Agent Loop 迭代');

      let fullContent = '';
      let toolCalls: Message['toolCalls'] = undefined;

      // 调用 LLM（先截断确保不爆上下文窗口）
      const chatOpts = this.buildChatOptions();
      const safeMessages = this.truncateMessages(this.messages);
      for await (const chunk of this.opts.provider.chat(safeMessages as Message[], chatOpts)) {
        if (chunk.content) {
          fullContent += chunk.content;
          yield { type: 'text', content: chunk.content }; // 结构化流式输出
        }
        if (chunk.toolCalls) {
          toolCalls = (toolCalls ?? []).concat(chunk.toolCalls as never);
        }
      }

      // 工具调用分支
      if (toolCalls && toolCalls.length > 0) {
        this.messages.push({
          role: 'assistant',
          content: fullContent,
          toolCalls,
        });

        // 执行工具
        for (const tc of toolCalls) {
          yield { type: 'tool_start', name: tc.function.name, args: tc.function.arguments };
          const result = await this.opts.toolExecutor(tc.function.name, tc.function.arguments);
          this.messages.push({
            role: 'tool',
            content: result,
            toolCallId: tc.id,
          });
          yield {
            type: 'tool_result',
            name: tc.function.name,
            ok: !result.startsWith('错误'),
            summary: result.slice(0, 100),
          };
        }
        // 继续循环：把工具结果回填给 LLM
        continue;
      }

      // 纯文本结束
      if (fullContent) {
        this.messages.push({ role: 'assistant', content: fullContent });
      }
      yield { type: 'done' };
      return;
    }

    logger.warn({ iterations: iteration }, '达到最大迭代次数');
    yield { type: 'text', content: '\n\n[已达到最大迭代次数]' };
    yield { type: 'done' };
  }

  /**
   * 构建 system prompt（注入人格 + 规则 + 领域 + 工具描述）
   */
  private buildSystemPrompt(memories: Memory[]): string {
    const sections = memories.map((m) => `## ${m.name}\n\n${m.content}`).join('\n\n---\n\n');
    let prompt = `# Memora Agent\n\n${sections}\n\n---\n\n你是 Memora Agent。基于以上人格、规则和领域知识，回应用户的问题。`;

    // 追加工具描述（让 LLM 知道可用工具及其参数）
    const tools = this.opts.toolDefinitions;
    if (tools && tools.length > 0) {
      const toolDescs = tools
        .map((t) => {
          const params = Object.entries(t.parameters.properties)
            .map(([name, schema]) => `    - ${name} (${schema.type}): ${schema.description}`)
            .join('\n');
          const required =
            t.parameters.required.length > 0 ? `（必填：${t.parameters.required.join(', ')}）` : '';
          return `  - ${t.name}${required}: ${t.description}\n${params}`;
        })
        .join('\n');
      prompt += `\n\n## 可用工具\n\n你可以通过 tool_call 调用以下工具：\n${toolDescs}`;
    }

    return prompt;
  }

  /**
   * 将话题记忆召回结果包裹到用户输入中
   *
   * 格式：先呈现系统召回的相关记忆（按时间顺序），再呈现用户原始输入。
   * 与"应无所住而生其心"的专注模式一致：agent 看到的是与当前话题最相关的记忆，
   * 而非全量历史 —— 减少杂念，保持专注。
   */
  private wrapWithTopicContext(userInput: string, memories: readonly Memory[]): string {
    const memoryBlock = memories
      .map((m) => `- [${m.createdAt.slice(0, 10)}] ${m.name}: ${m.content.slice(0, 200)}`)
      .join('\n');

    return ['[系统召回的相关记忆]', memoryBlock, '', '[用户输入]', userInput].join('\n');
  }

  /**
   * 估算消息数组的 token 数量
   *
   * 使用字符数 / CHARS_PER_TOKEN 的粗略估算（非精确 tokenizer）。
   * 对于中英文混合文本，保守取 3 chars/token（实际 ~2-2.5），
   * 确保估算值 ≥ 实际值，不会误判"安全"导致 API 报错。
   *
   * @param messages 消息数组
   * @returns 估算的 token 数量
   */
  private estimateTokens(messages: readonly Message[]): number {
    let totalChars = 0;
    for (const m of messages) {
      // 消息本身的内容字符数
      totalChars += m.content.length;
      // toolCalls 的 JSON 序列化字符数
      if (m.toolCalls) {
        totalChars += JSON.stringify(m.toolCalls).length;
      }
    }
    return Math.ceil(totalChars / AgentLoop.CHARS_PER_TOKEN);
  }

  /**
   * 截断消息数组以适配上下文窗口
   *
   * 策略：保留下方、裁中间。
   * - messages[0]（system prompt）始终保留（这是 Agent 的"灵魂"）
   * - 从尾部向前取最近的消息对（user + assistant + tool），直到估算 token 接近上限
   * - 头部被裁剪的消息替换为一条摘要占位消息
   *
   * 如果 system prompt 本身就超过 maxContextTokens，不做截断（让 LLM API 报错，
   * 开发者需要缩减 bootstrapMemories 或 toolDefinitions）。
   *
   * @param messages 完整消息数组
   * @returns 截断后的消息数组（可能是原数组引用，无修改时）
   */
  private truncateMessages(messages: readonly Message[]): readonly Message[] {
    const estimated = this.estimateTokens(messages);
    if (estimated <= this.maxContextTokens || messages.length <= 3) {
      return messages; // 未超阈值，无需截断
    }

    // system prompt 单独保留
    const systemMsg = messages[0];
    if (!systemMsg || systemMsg.role !== 'system') {
      return messages; // 异常：没有 system prompt，不截断
    }

    const systemTokens = this.estimateTokens([systemMsg]);
    if (systemTokens >= this.maxContextTokens) {
      // system prompt 本身就超了——这是配置问题，不应该截断
      logger.warn(
        { systemTokens, maxContextTokens: this.maxContextTokens },
        'system prompt 已超过上下文窗口上限，请缩减 bootstrapMemories 或 toolDefinitions',
      );
      return messages;
    }

    // 剩余可用 token 数（留 10% 缓冲给 LLM 响应）
    const availableTokens = Math.floor(this.maxContextTokens * 0.9) - systemTokens;

    // 从尾部向前收集消息（最近的最重要）
    const tail: Message[] = [];
    let tailTokens = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
      const msg = messages[i]!; // 边界已由 messages.length 保证，i >= 1 且 i < messages.length
      const msgTokens = this.estimateTokens([msg]);
      if (tailTokens + msgTokens > availableTokens) {
        break; // 再加这条就超了
      }
      tail.unshift(msg); // 保持顺序：从尾部取，但插入时保持时间顺序
      tailTokens += msgTokens;
    }

    // 计算被裁剪的消息数
    const skipped = messages.length - 1 - tail.length; // -1 是 system prompt
    if (skipped <= 0) {
      return messages; // 全部保留
    }

    // 构造一条占位消息，让 LLM 知道有历史被裁剪了
    const placeholder: Message = {
      role: 'system',
      content: `[上下文窗口管理] 为保持对话流畅，已自动裁剪 ${skipped} 条较早的历史消息。当前保留最近 ${tail.length} 条消息 + 完整系统提示。如需回顾早期内容，可向用户询问。`,
    };

    const truncated = [systemMsg, placeholder, ...tail];
    const newEstimated = this.estimateTokens(truncated);

    logger.info(
      {
        originalCount: messages.length,
        truncatedCount: truncated.length,
        skipped,
        originalTokens: estimated,
        newTokens: newEstimated,
      },
      '上下文窗口截断完成',
    );

    return truncated;
  }

  /**
   * 注入系统消息到消息数组（技能注入、角色切换等场景）
   *
   * 用于在对话进行中动态注入上下文——如技能匹配后，
   * 下一轮将技能 prompt 注入为 system 消息。
   *
   * @param content 系统消息内容
   */
  injectSystemMessage(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  /**
   * 构建 LLM 调用选项（包含工具定义）
   *
   * 将 toolDefinitions 转换为 OpenAI Function Calling 格式，
   * 让 LLM 能通过标准协议发起 tool_call，而非文本模拟。
   */
  private buildChatOptions(): ChatOptions {
    const tools = this.opts.toolDefinitions;
    if (!tools || tools.length === 0) return {};

    return {
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        },
      })),
    };
  }

  /**
   * 刷新工具定义（registerTool 后调用）
   *
   * 当宿主项目通过 agent.registerTool() 注册新工具后，
   * 需要更新 system prompt 中的工具描述，让 LLM 能看到新工具。
   * 重建 messages[0] 的 system prompt 内容。
   *
   * @param toolDefinitions 最新的工具定义列表（内置 + 自定义）
   */
  refreshToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    // 注意：修改 opts.toolDefinitions 是有意为之的副作用——
    // 后续 buildSystemPrompt() 需要读取最新的工具列表
    this.opts.toolDefinitions = toolDefinitions;
    // 重建 messages[0] 的 system prompt
    this.rebuildSystemMessage();
  }

  /**
   * v1.2：运行时切换 LLM Provider
   *
   * 用于多 Provider 路由场景：用户切换 API 时，
   * Agent 调用此方法更新 AgentLoop 的 provider 引用。
   * 后续 chat() 调用使用新 Provider。
   *
   * @param provider 新的 LlmProvider 实例
   */
  setProvider(provider: LlmProvider): void {
    this.opts.provider = provider;
  }

  /**
   * 刷新角色 prompt（P-603 · L6 修正）
   *
   * 当角色切换时，更新系统 prompt 前缀的角色部分。
   * 保留 bootstrapMemories 和 toolDefinitions 不变，只替换 prefix。
   *
   * @param newPrefix 新的系统 prompt 前缀（包含新角色 + 用户画像）
   */
  refreshPersonaPrefix(newPrefix: string): void {
    this.opts.systemPromptPrefix = newPrefix;
    this.rebuildSystemMessage();
  }

  /**
   * 重建 messages[0] 的 system prompt
   */
  private rebuildSystemMessage(): void {
    const sysMsg = this.messages[0];
    if (sysMsg && sysMsg.role === 'system') {
      const prefix = this.opts.systemPromptPrefix ?? '';
      this.messages[0] = {
        role: 'system',
        content: prefix + this.buildSystemPrompt(this.opts.bootstrapMemories),
      };
    }
  }

  /**
   * 获取消息历史（用于持久化）
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * 恢复历史消息（用于重启后恢复对话）
   * 会跳过 system 消息，只恢复 user/assistant/tool 消息
   *
   * @param historyMessages - 要恢复的历史消息列表
   */
  restoreHistory(historyMessages: readonly Message[]): void {
    // 过滤掉 system 消息（我们已经有初始化的 system prompt 了）
    const nonSystemMessages = historyMessages.filter((m) => m.role !== 'system');

    if (nonSystemMessages.length === 0) {
      logger.debug('没有需要恢复的历史消息');
      return;
    }

    // 保持第一条消息是 system prompt（构造函数保证 messages[0] 存在）
    const systemPrompt = this.messages[0];
    if (!systemPrompt) {
      logger.warn('restoreHistory: 没有 system prompt，跳过恢复');
      return;
    }
    this.messages = [systemPrompt, ...nonSystemMessages];

    logger.info({ messageCount: nonSystemMessages.length }, '恢复历史对话消息');
  }
}
