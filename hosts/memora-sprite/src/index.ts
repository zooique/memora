/**
 * Memora Sprite — 桌面精灵宿主入口
 *
 * 职责：
 *   1. 加载配置（~/.memora/config.json 或项目级 .memora/config.json）
 *   2. 打开 SQLite 数据库（memora.db）
 *   3. 创建 SqliteStorage + SqliteSessionStore
 *   4. 创建 LLM Provider
 *   5. 实例化 Agent 并注入存储实现
 *   6. 启动精灵主控循环
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵知道用户在做什么，不知道用户在打什么
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { Agent, createLlmProvider, loadConfig } from 'memora';
import type { UIMessages, Config } from 'memora';
import { SqliteStorage } from './storage/sqliteStorage.js';
import { SqliteSessionStore } from './storage/sessionStore.js';
import { Sprite } from './sprite/sprite.js';

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
 * 配置优先级（高 → 低）：
 *   1. opts 参数（编程调用时传入）
 *   2. ~/.memora/config.json（用户级配置）
 *   3. .memora/config.json（项目级配置）
 *   4. 内置默认值
 *
 * @param opts - 启动选项（可选，覆盖配置文件）
 * @returns 精灵实例（用于外部控制）
 */
export async function startSprite(opts?: {
  projectPath?: string;
  configDir?: string;
  dataDir?: string;
  configPath?: string;
}): Promise<{ agent: Agent; sprite: Sprite; close: () => void }> {
  // 1. 加载配置文件
  const config: Config = await loadConfig(opts?.configPath);

  const projectPath = opts?.projectPath ?? process.cwd();
  const configDir = opts?.configDir ?? resolve(homedir(), '.memora-config');
  const dataDir = opts?.dataDir ?? resolve(homedir(), config.memory.dataDir);

  // 2. 打开 SQLite 数据库
  const dbPath = resolve(dataDir, 'memora.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 3. 创建存储实现
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);

  // 4. 创建 LLM Provider（复用内核配置系统）
  if (!config.llm.apiKey) {
    throw new Error(
      '未提供 API Key。请在 ~/.memora/config.json 中配置 llm.apiKey，' +
      '或使用 ${ENV_VAR} 引用环境变量（如 "${DEEPSEEK_API_KEY}"）。'
    );
  }

  const provider = createLlmProvider(config);

  // 5. 实例化 Agent
  const agent = new Agent({
    projectPath,
    configDir,
    dataDir,
    provider,
    storage,
    sessionStore,
    messages: ZH_MESSAGES,
    enableContextSummary: true,
    permission: config.security.permission,
    allowedPaths: config.allowedPaths,
  });

  await agent.init();

  // 6. 启动精灵主控
  const sprite = new Sprite(agent);
  sprite.start();

  const close = async () => {
    sprite.stop();
    await agent.close();
    storage.close();
  };

  return { agent, sprite, close };
}

// ─── CLI 直接运行 ──────────────────────────────────────

async function main(): Promise<void> {
  const { agent, close } = await startSprite();

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

  process.on('SIGINT', async () => {
    console.log('\n正在关闭...');
    await close();
    process.exit(0);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
) {
  main().catch(console.error);
}
