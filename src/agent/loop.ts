/**
 * Agent Loop — Agent 的核心执行引擎
 *
 * 模型自主决定何时推理、何时调用工具，循环直到输出纯文本
 * 详见 agent设计.md §2.1 运行闭环
 *
 * 上下文组装公式（agent上下文组装协议.md §1）：
 *   上下文 = 用户主动输入 + Agent 记忆召回结果 + Agent Loop 工作记忆
 * 其中"Agent 记忆召回结果"由 TopicMount 提供，通过 processUserInput 的
 * topicMemories 参数注入。
 */
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';

export interface AgentLoopOptions {
  provider: LlmProvider;
  bootstrapMemories: Memory[]; // 永驻 + 领域记忆
  toolExecutor: (name: string, args: string) => Promise<string>;
  maxIterations?: number;
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxIterations = opts.maxIterations ?? 20;

    // 初始化 system prompt（基于永驻记忆）
    this.messages.push({
      role: 'system',
      content: this.buildSystemPrompt(opts.bootstrapMemories),
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
  ): AsyncGenerator<string, void, unknown> {
    // 注入话题记忆召回结果（agent上下文组装协议 §1：Agent 记忆召回结果层）
    const enhancedInput = topicMemories?.length
      ? this.wrapWithTopicContext(userInput, topicMemories)
      : userInput;

    this.messages.push({ role: 'user', content: enhancedInput });

    let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration++;
      logger.debug({ iteration, messageCount: this.messages.length }, 'Agent Loop 迭代');

      let fullContent = '';
      let toolCalls: Message['toolCalls'] = undefined;

      // 调用 LLM
      for await (const chunk of this.opts.provider.chat(this.messages)) {
        if (chunk.content) {
          fullContent += chunk.content;
          yield chunk.content; // 流式输出给用户
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
          const result = await this.opts.toolExecutor(tc.function.name, tc.function.arguments);
          this.messages.push({
            role: 'tool',
            content: result,
            toolCallId: tc.id,
          });
        }
        // 继续循环：把工具结果回填给 LLM
        continue;
      }

      // 纯文本结束
      if (fullContent) {
        this.messages.push({ role: 'assistant', content: fullContent });
      }
      return;
    }

    logger.warn({ iterations: iteration }, '达到最大迭代次数');
    yield '\n\n[已达到最大迭代次数]';
  }

  /**
   * 构建 system prompt（注入人格 + 规则 + 领域）
   */
  private buildSystemPrompt(memories: Memory[]): string {
    const sections = memories.map((m) => `## ${m.name}\n\n${m.content}`).join('\n\n---\n\n');
    return `# Memora Agent\n\n${sections}\n\n---\n\n你是 Memora Agent。基于以上人格、规则和领域知识，回应用户的问题。`;
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

    // 保持第一条消息是 system prompt
    const systemPrompt = this.messages[0]!;
    this.messages = [systemPrompt, ...nonSystemMessages];

    logger.info({ messageCount: nonSystemMessages.length }, '恢复历史对话消息');
  }
}
