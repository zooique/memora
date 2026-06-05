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
}

export class AgentLoop {
  private messages: Message[] = [];
  private readonly maxIterations: number;

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxIterations = opts.maxIterations ?? 20;

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

      // 调用 LLM
      const chatOpts = this.buildChatOptions();
      for await (const chunk of this.opts.provider.chat(this.messages, chatOpts)) {
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
   * 刷新身份 prompt（P-603 · L6 修正）
   *
   * 当身份切换时，更新系统 prompt 前缀的身份部分。
   * 保留 bootstrapMemories 和 toolDefinitions 不变，只替换 prefix。
   *
   * @param newPrefix 新的系统 prompt 前缀（包含新身份 + 用户画像）
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
