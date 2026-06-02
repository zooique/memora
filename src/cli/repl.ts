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
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config/loader.js';
import { createLlmProvider } from '../llm/factory.js';
import { AgentLoop } from '../agent/loop.js';
import { ToolExecutor, BUILTIN_TOOLS } from '../agent/tool-executor.js';
import { MessageHistory } from '../agent/message-history.js';
import { FileStore } from '../memory/store.js';
import { MemoryIndex } from '../memory/index.js';
import { MemoryLoader } from '../memory/loader.js';
import { TopicStore } from '../memory/topic-store.js';
import { SecurityGuard } from '../security/path-guard.js';
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

  // 解析数据目录（~ 展开为用户目录）
  const memoraDir = resolve(config.memory.dataDir.replace(/^~/, homedir()));

  // 初始化文件存储 + SQLite 索引
  const fileStore = new FileStore(memoraDir);
  const dbPath = join(memoraDir, 'memora.db');
  const index = new MemoryIndex(dbPath);

  // 启动时加载：扫描文件 → 写入索引 → 读 always+domain
  const loader = new MemoryLoader(fileStore, index);
  const { memories: bootstrapMemories, loadResult } = await loader.bootstrap();
  logger.info(
    {
      loaded: loadResult.loaded,
      skipped: loadResult.skipped,
      bootstrapCount: bootstrapMemories.length,
    },
    '启动加载完成',
  );

  if (loadResult.errors.length > 0) {
    logger.warn({ errors: loadResult.errors }, '部分记忆文件加载失败');
  }

  // 初始化话题存储
  const topicStore = new TopicStore(memoraDir);

  // 初始化 LLM（先于 history，因为 summarizer 需要 provider 引用）
  const provider = createLlmProvider(config);

  // 初始化消息历史（M-203-改：注入话题摘要生成器，事件驱动归档）
  const history = new MessageHistory(topicStore, createTopicSummarizer(provider));

  // 初始化安全
  const security = new SecurityGuard(
    projectPath,
    memoraDir,
    config.allowedPaths,
    config.security.confirmWrites,
    config.security.permission,
  );

  // 初始化工具（M-204：注入 MemoryIndex 让 search_memories 工具可用）
  const toolExec = new ToolExecutor(projectPath, security, index);
  // M-205：包装 toolExecutor 显示工具调用可视化
  const toolExecutor = async (name: string, args: string): Promise<string> => {
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

  // 初始化 Agent Loop
  const loop = new AgentLoop({
    provider,
    bootstrapMemories,
    toolExecutor,
  });

  // 显示欢迎（M-205 美化版）
  console.log(
    formatWelcome({
      version: '0.1.0',
      projectPath,
      modelName: provider.name,
      dbPath,
      loadedCount: loadResult.loaded,
      bootstrapCount: bootstrapMemories.length,
      skippedCount: loadResult.skipped,
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
      console.log(formatMemoriesList(bootstrapMemories));
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

  await index.close().catch((err) => logger.error({ err }, '关闭数据库失败'));
  rl.close();
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
