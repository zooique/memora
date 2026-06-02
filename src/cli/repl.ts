/**
 * REPL 主循环
 *
 * 阶段一：readline 基础实现
 * 阶段二：升级到 ink 富交互
 *
 * 话题持久化（M-002）：
 *   - 用户输入 → 追加 user 消息到当前话题文件
 *   - Agent 回复 → 追加 assistant 消息到当前话题文件
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
import { FileStore } from '../memory/store.js';
import { MemoryIndex } from '../memory/index.js';
import { MemoryLoader } from '../memory/loader.js';
import { TopicStore, todayDate, nowTimestamp } from '../memory/topic-store.js';
import { SecurityGuard } from '../security/path-guard.js';
import { logger } from '../logging/logger.js';

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

  // 初始化 LLM
  const provider = createLlmProvider(config);

  // 初始化安全
  const security = new SecurityGuard(projectPath, memoraDir, config.allowedPaths);

  // 初始化工具
  const toolExec = new ToolExecutor(projectPath, security);
  const toolExecutor = (name: string, args: string): Promise<string> =>
    toolExec.execute(name, args);

  // 初始化 Agent Loop
  const loop = new AgentLoop({
    provider,
    bootstrapMemories,
    toolExecutor,
  });

  // 当前话题（默认 = 今天的日期）
  const currentDate = todayDate();
  let currentTopic = 'main';
  const currentTopicName = (): string => `${currentDate}-${currentTopic}`;

  // 显示欢迎
  console.log('\n🌲 Memora Agent v0.1.0');
  console.log(`📁 项目：${projectPath}`);
  console.log(`🤖 模型：${provider.name}`);
  console.log(`💾 数据库：${dbPath}`);
  console.log(`📚 加载记忆：${loadResult.loaded} 条（启动必召：${bootstrapMemories.length} 条）`);
  if (loadResult.skipped > 0) {
    console.log(`⚠️  跳过：${loadResult.skipped} 条（详见日志）`);
  }
  console.log(`💬 当前话题：${currentTopicName()}`);
  console.log('输入 /exit 退出，/help 查看帮助\n');

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
      console.log('👋 再见');
      break;
    }

    if (input === '/help') {
      console.log('命令：');
      console.log('  /exit, /quit         退出');
      console.log('  /help                显示帮助');
      console.log('  /tools               列出可用工具');
      console.log('  /memories            列出已加载记忆');
      console.log('  /topic <name>        切换话题（不填则显示当前）');
      console.log('  /topics              列出所有话题文件');
      rl.prompt();
      continue;
    }

    if (input === '/tools') {
      console.log('可用工具：');
      for (const t of BUILTIN_TOOLS) {
        console.log(`  - ${t.name}: ${t.description}`);
      }
      rl.prompt();
      continue;
    }

    if (input === '/memories') {
      console.log(`已加载 ${bootstrapMemories.length} 条必召记忆：`);
      for (const m of bootstrapMemories) {
        console.log(`  - [${m.permanence}] ${m.type}:${m.name}`);
      }
      rl.prompt();
      continue;
    }

    if (input === '/topic' || input.startsWith('/topic ')) {
      const newName = input.slice('/topic'.length).trim();
      if (!newName) {
        console.log(`当前话题：${currentTopicName()}`);
      } else {
        currentTopic = newName;
        console.log(`✅ 已切换话题：${currentTopicName()}`);
      }
      rl.prompt();
      continue;
    }

    if (input === '/topics') {
      const topics = await topicStore.list();
      if (topics.length === 0) {
        console.log('（暂无话题）');
      } else {
        console.log(`共有 ${topics.length} 个话题文件：`);
        for (const t of topics) {
          console.log(`  - ${t}`);
        }
      }
      rl.prompt();
      continue;
    }

    // 用户输入 → 追加到话题文件
    const userMessage = {
      role: 'user' as const,
      content: input,
      timestamp: nowTimestamp(),
    };
    try {
      await topicStore.append(currentDate, currentTopic, userMessage);
    } catch (err) {
      logger.error({ err, topic: currentTopicName() }, '追加 user 消息到话题文件失败');
      // 不阻塞对话
    }

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
      logger.error({ err }, 'Agent Loop 异常');
      console.error('\n❌ 出错了：', (err as Error).message, '\n');
    }

    // Agent 回复 → 追加到话题文件
    if (assistantContent.trim()) {
      const assistantMessage = {
        role: 'assistant' as const,
        content: assistantContent,
        timestamp: nowTimestamp(),
      };
      try {
        await topicStore.append(currentDate, currentTopic, assistantMessage);
      } catch (err) {
        logger.error({ err, topic: currentTopicName() }, '追加 assistant 消息到话题文件失败');
      }
    }

    rl.prompt();
  }

  await index.close().catch((err) => logger.error({ err }, '关闭数据库失败'));
  rl.close();
}
