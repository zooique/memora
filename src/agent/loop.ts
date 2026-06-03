/**
 * Agent Loop — Agent 的核心执行引擎
 *
 * 模型自主决定何时推理、何时调用工具，循环直到输出纯文本
 * 详见 agent设计.md §2.1 运行闭环
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
   */
  async *processUserInput(userInput: string): AsyncGenerator<string, void, unknown> {
    this.messages.push({ role: 'user', content: userInput });

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
   * 获取消息历史（用于持久化）
   */
  getMessages(): readonly Message[] {
    return this.messages;
  }
}
