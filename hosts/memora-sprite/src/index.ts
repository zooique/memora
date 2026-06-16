/**
 * Memora Sprite — 桌面精灵宿主入口
 *
 * 职责：
 *   1. 打开 SQLite 数据库（memora.db）
 *   2. 创建 SqliteStorage + SqliteSessionStore
 *   3. 创建 LLM Provider
 *   4. 实例化 Agent 并注入存储实现
 *   5. 启动精灵主控循环
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵知道用户在做什么，不知道用户在打什么
 */
import { resolve, homedir } from 'node:path';
import Database from 'better-sqlite3';
import { Agent, createLlmProvider } from 'memora';
import type { UIMessages } from 'memora';
import { SqliteStorage } from './storage/sqliteStorage.js';
import { SqliteSessionStore } from './storage/sessionStore.js';
import { Sprite } from './sprite/sprite.js';

/** 精灵默认配置 */
const DEFAULT_DATA_DIR = resolve(homedir(), '.memora');
const DEFAULT_DB_NAME = 'memora.db';

/** 中文 UI 消息覆盖 */
const ZH_MESSAGES: UIMessages = {
  abortedByUser: '用户取消了对话',
  maxIterationsReached: '\n\n[已达到最大迭代次数]',
  contextTruncated: (skipped, kept) =>
    `[上下文窗口截断：跳过 ${skipped} 条消息，保留最近 ${kept} 条]`,
  recentConversationLabel: '[最近对话]',
  userLabel: '用户',
  assistantLabel: '助手',
  inputBlockedByGuard: (rule) => `[输入被护栏拦截：${rule}]`,
  guardrailWarningPrefix: '[护栏警告]',
  outputBlockedByGuard: (rule) => `[输出被护栏拦截：${rule}]`,
};

/**
 * 启动精灵
 *
 * @param opts - 启动选项
 * @returns 精灵实例（用于外部控制）
 */
export async function startSprite(opts?: {
  projectPath?: string;
  configDir?: string;
  dataDir?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): Promise<{ agent: Agent; sprite: Sprite; close: () => void }> {
  const projectPath = opts?.projectPath ?? process.cwd();
  const configDir = opts?.configDir ?? resolve(homedir(), '.memora-config');
  const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;

  // 1. 打开 SQLite 数据库
  const dbPath = resolve(dataDir, DEFAULT_DB_NAME);
  const db = new Database(dbPath);
  // WAL 模式：提升并发读性能
  db.pragma('journal_mode = WAL');

  // 2. 创建存储实现
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);

  // 3. 创建 LLM Provider
  const apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
  const baseUrl = opts?.baseUrl ?? process.env.OPENAI_BASE_URL;
  const model = opts?.model ?? process.env.OPENAI_MODEL;

  if (!apiKey) {
    throw new Error(
      '未提供 API Key。请设置 OPENAI_API_KEY 环境变量或传入 apiKey 参数。'
    );
  }

  const provider = createLlmProvider({
    provider: 'openai',
    apiKey,
    baseUrl,
    model,
  });

  // 4. 实例化 Agent
  const agent = new Agent({
    projectPath,
    configDir,
    dataDir,
    provider,
    storage,
    sessionStore,
    messages: ZH_MESSAGES,
    enableContextSummary: true,
    permission: 'owner',
    allowedPaths: [projectPath],
  });

  await agent.init();

  // 5. 启动精灵主控
  const sprite = new Sprite(agent);
  sprite.start();

  const close = async () => {
    sprite.stop();
    await agent.close();
    // storage 和 sessionStore 共享同一个 db 实例（ADR-SP-002 同库存储），
    // 只需关闭一次。agent.close() 不关闭 db（它不持有 db 引用），
    // 所以由 storage.close() 负责关闭共享的 db 连接。
    storage.close();
  };

  return { agent, sprite, close };
}

// ─── CLI 直接运行 ──────────────────────────────────────

/**
 * CLI 交互模式（阶段一：简单 REPL）
 */
async function main(): Promise<void> {
  const { agent, close } = await startSprite();
  void agent; // agent 保留用于后续扩展（事件监听等）

  console.log('Memora Sprite 已启动（输入 /quit 退出）');

  const readline = await import('node:readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return;

    if (input === '/quit') {
      await close();
      rl.close();
      process.exit(0);
    }

    try {
      for await (const chunk of agent.chat(input)) {
        if (chunk.type === 'text') {
          process.stdout.write(chunk.content);
        } else if (chunk.type === 'done') {
          process.stdout.write('\n');
        } else if (chunk.type === 'aborted') {
          console.log(`\n[${chunk.reason}]`);
        }
      }
    } catch (err) {
      console.error('\n对话出错:', err);
    }
  });

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\n正在关闭...');
    await close();
    process.exit(0);
  });
}

// 仅在直接运行时启动 CLI
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
) {
  main().catch(console.error);
}
