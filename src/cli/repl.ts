/**
 * REPL 主循环
 *
 * 阶段一：readline 基础实现
 * 阶段二（M-205）：升级为 ANSI 美化版
 *   - picocolors 颜色（标题/错误/成功/警告/工具调用）
 *   - box-drawing 字符包裹工具结果
 *   - 工具调用开始/结束标记
 *
 * 分层（T-101 修复）：本模块只调 agent 层的 MessageHistory，不直接调 memory 层的 TopicStore
 * 话题持久化（M-002）：
 *   - 用户输入 → MessageHistory.appendUser() → TopicStore
 *   - Agent 回复 → MessageHistory.appendAssistant() → TopicStore
 *   - 切换话题：/topic <name>
 *   - 列出话题：/topics
 */
import { createInterface, type Interface as RLInterface } from 'node:readline';
import { join } from 'node:path';
import type { Config } from '../config/loader.js';
import { createLlmProvider } from '../llm/factory.js';
import { AgentLoop } from '../agent/loop.js';
import { ToolExecutor, BUILTIN_TOOLS } from '../agent/tool-executor.js';
import { MessageHistory } from '../agent/message-history.js';
import { DomainManager } from '../memory/domain-manager.js';
import { toFriendlyError } from '../utils/errors.js';
import type { TopicMessage } from '../memory/types.js';
import type { LlmProvider, Message } from '../llm/provider.js';
import { logger } from '../logging/logger.js';
import {
  formatWelcome,
  formatHelp,
  formatToolsList,
  formatMemoriesList,
  formatTopicsList,
  formatSuccess,
  formatError,
  formatToolResult,
  formatToolStart,
  formatToolEnd,
} from './format.js';

export interface ReplOptions {
  projectPath: string;
  config: Config;
}

export async function startRepl(opts: ReplOptions): Promise<void> {
  const { projectPath, config } = opts;

  // M-208：使用 DomainManager 管理领域切换
  const domainManager = new DomainManager(projectPath, config);
  let ctx = await domainManager.initDefault();

  if (ctx.loadResult.errors.length > 0) {
    logger.warn({ errors: ctx.loadResult.errors }, '部分记忆文件加载失败');
  }

  // 初始化 LLM（先于 history，因为 summarizer 需要 provider 引用）
  const provider = createLlmProvider(config);

  // 根据领域上下文创建可切换的组件
  let history = new MessageHistory(ctx.topicStore, createTopicSummarizer(provider));
  let toolExec = new ToolExecutor(projectPath, ctx.security, ctx.index);
  let loop = new AgentLoop({
    provider,
    bootstrapMemories: ctx.bootstrapMemories,
    toolExecutor: wrapToolExecutor(toolExec),
  });

  // 显示欢迎（M-205 美化版）
  console.log(
    formatWelcome({
      version: '0.1.0',
      projectPath,
      modelName: provider.name,
      dbPath: join(ctx.memoraDir, 'memora.db'),
      loadedCount: ctx.loadResult.loaded,
      bootstrapCount: ctx.bootstrapMemories.length,
      skippedCount: ctx.loadResult.skipped,
      currentTopic: history.currentTopicName,
    }),
  );

  // REPL 循环
  const rl: RLInterface = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      continue;
    }

    if (input === '/exit' || input === '/quit') {
      console.log(formatSuccess('再见 👋'));
      break;
    }

    if (input === '/help') {
      console.log(formatHelp());
      rl.prompt();
      continue;
    }

    if (input === '/tools') {
      console.log(formatToolsList(BUILTIN_TOOLS));
      rl.prompt();
      continue;
    }

    if (input === '/memories') {
      console.log(formatMemoriesList(ctx.bootstrapMemories));
      rl.prompt();
      continue;
    }

    // M-208：领域切换命令
    if (input === '/domain' || input.startsWith('/domain ')) {
      const arg = input.slice('/domain'.length).trim();
      if (!arg) {
        // 无参数：显示当前领域和可用领域列表
        const domains = domainManager.listDomains();
        console.log(`当前领域：${ctx.domainName}`);
        console.log(`可用领域：${domains.join(', ') || '仅默认'}`);
      } else if (arg === ctx.domainName) {
        console.log(formatSuccess(`已在领域 ${arg} 中`));
      } else {
        try {
          ctx = await domainManager.switchDomain(arg);
          // 重建所有依赖领域上下文的组件
          history = new MessageHistory(ctx.topicStore, createTopicSummarizer(provider));
          toolExec = new ToolExecutor(projectPath, ctx.security, ctx.index);
          loop = new AgentLoop({
            provider,
            bootstrapMemories: ctx.bootstrapMemories,
            toolExecutor: wrapToolExecutor(toolExec),
          });
          console.log(
            formatSuccess(
              `已切换到领域：${ctx.domainName}（${ctx.bootstrapMemories.length} 条记忆）`,
            ),
          );
        } catch (err) {
          const friendly = toFriendlyError(err);
          console.error(formatError(friendly.title, friendly.detail));
        }
      }
      rl.prompt();
      continue;
    }

    if (input === '/topic' || input.startsWith('/topic ')) {
      const newName = input.slice('/topic'.length).trim();
      if (!newName) {
        console.log(`当前话题：${history.currentTopicName}`);
      } else {
        const newFullName = history.switchTopic(newName);
        console.log(formatSuccess(`已切换话题：${newFullName}`));
      }
      rl.prompt();
      continue;
    }

    if (input === '/topics') {
      const topics = await history.listAllTopics();
      console.log(formatTopicsList(topics));
      rl.prompt();
      continue;
    }

    // 用户输入 → 通过 MessageHistory 追加到话题文件
    await history.appendUser(input);

    // 用户输入 → Agent Loop
    let assistantContent = '';
    try {
      process.stdout.write('\n');
      for await (const chunk of loop.processUserInput(input)) {
        process.stdout.write(chunk);
        assistantContent += chunk;
      }
      process.stdout.write('\n\n');
    } catch (err) {
      // M-103：所有错误统一包装为友好错误
      const friendly = toFriendlyError(err);
      friendly.log();
      console.error(formatError(friendly.title, friendly.detail));
    }

    // Agent 回复 → 通过 MessageHistory 追加到话题文件
    await history.appendAssistant(assistantContent);

    rl.prompt();
  }

  await ctx.index.close().catch((err) => logger.error({ err }, '关闭数据库失败'));
  rl.close();
}

/**
 * 包装 ToolExecutor，添加 M-205 工具调用可视化
 */
function wrapToolExecutor(toolExec: ToolExecutor) {
  return async (name: string, args: string): Promise<string> => {
    process.stderr.write(formatToolStart(name) + '\n');
    try {
      const result = await toolExec.execute(name, args);
      process.stderr.write(formatToolResult(name, result) + '\n');
      process.stderr.write(formatToolEnd(name, true));
      return result;
    } catch (err) {
      process.stderr.write(formatToolEnd(name, false));
      throw err;
    }
  };
}

/**
 * 创建话题摘要生成器（M-203-改）
 *
 * 设计：回调模式，避免在 MessageHistory 中硬依赖 LlmProvider
 * 策略：收集 user 消息的前 500 字，让 LLM 用 2-3 句中文总结
 * 失败不抛出（fire-and-forget 模式，log 即可）
 *
 * @param provider LLM 提供者
 * @returns TopicSummarizer 回调函数
 */
export function createTopicSummarizer(
  provider: LlmProvider,
): (messages: TopicMessage[]) => Promise<string> {
  return async (messages: TopicMessage[]): Promise<string> => {
    // 只取 user 消息（对话本质是回应 user 的），截断到 500 字以免 prompt 过长
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n')
      .slice(0, 500);

    const promptMessages: Message[] = [
      {
        role: 'system',
        content: '你是对话摘要助手。请用 2-3 句中文总结以下对话的核心内容，不要评价，只陈述事实。',
      },
      { role: 'user', content: userContent },
    ];

    let summary = '';
    for await (const chunk of provider.chat(promptMessages, { maxTokens: 100 })) {
      if (chunk.content) summary += chunk.content;
    }
    return summary.trim();
  };
}
