/**
 * Memora Sprite — 桌面精灵宿主入口
 *
 * 职责：
 *   1. 加载配置（~/.memora/config.json 或项目级 .memora/config.json）
 *   2. 首次启动时引导用户配置 LLM
 *   3. 打开 SQLite 数据库（memora.db）
 *   4. 创建 SqliteStorage + SqliteSessionStore
 *   5. 创建 LLM Provider
 *   6. 实例化 Agent 并注入存储实现
 *   7. 启动精灵主控循环
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵知道用户在做什么，不知道用户在打什么
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
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

// ─── 首次启动引导 ──────────────────────────────────────

/** 交互式提问 */
function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** LLM 预设配置 */
const PROVIDER_PRESETS: Record<string, { provider: string; model: string; baseUrl: string }> = {
  '1': { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  '2': { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  '3': { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
};

/**
 * 首次启动引导
 *
 * 交互式收集 LLM 配置并保存到 ~/.memora/config.json
 */
async function setupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Memora Sprite 首次启动 ===\n');
  console.log('请选择 LLM 提供商：');
  console.log('  1. DeepSeek（推荐，性价比高）');
  console.log('  2. OpenAI GPT-4o');
  console.log('  3. OpenAI GPT-4o-mini');
  console.log('  4. 自定义（任何 OpenAI 兼容端点）');

  const choice = await ask(rl, '\n请输入选项 [1-4]（默认 1）：') || '1';

  let providerConfig: { provider: string; model: string; baseUrl: string };

  if (choice === '4') {
    const provider = await ask(rl, '提供商名称（如 openai、deepseek、自定义）：');
    const model = await ask(rl, '模型名称（如 deepseek-chat、gpt-4o）：');
    const baseUrl = await ask(rl, 'API 地址（如 https://api.deepseek.com）：');
    providerConfig = { provider, model, baseUrl };
  } else {
    providerConfig = PROVIDER_PRESETS[choice] ?? PROVIDER_PRESETS['1']!;
    console.log(`\n已选择：${providerConfig.provider} / ${providerConfig.model}`);
  }

  const apiKey = await ask(rl, '\n请输入 API Key：');

  if (!apiKey) {
    console.error('\n错误：API Key 不能为空');
    rl.close();
    process.exit(1);
  }

  rl.close();

  // 保存配置
  const configPath = resolve(homedir(), '.memora', 'config.json');
  const configDir = resolve(homedir(), '.memora');
  await mkdir(configDir, { recursive: true });

  const config: Config = {
    llm: {
      provider: providerConfig.provider,
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      apiKey,
      temperature: 0.7,
    },
    memory: { dataDir: '~/.memora', maxContextTokens: 120000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
  };

  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`\n配置已保存到：${configPath}`);
}

// ─── 启动精灵 ──────────────────────────────────────────

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
  // 1. 加载配置文件（首次启动时自动引导）
  let config: Config;
  try {
    config = await loadConfig(opts?.configPath);
    // 检查是否有 API Key
    if (!config.llm.apiKey) {
      throw new Error('API Key 未配置');
    }
  } catch {
    // 首次启动或配置不完整，引导用户配置
    await setupWizard();
    config = await loadConfig(opts?.configPath);
  }

  const configDir = opts?.configDir ?? resolve(homedir(), '.memora-config');
  // 展开 ~ 为实际 home 目录
  const rawDir = config.memory.dataDir.startsWith('~')
    ? resolve(homedir(), config.memory.dataDir.slice(1).replace(/^[/\\]/, ''))
    : config.memory.dataDir;
  const dataDir = opts?.dataDir ?? rawDir;

  // 精灵的工作空间：~/.memora/workspace/（而非源码目录）
  // 桌面精灵不是项目级工具，不应往自己的源码目录写文件
  const workspaceDir = resolve(dataDir, 'workspace');
  const projectPath = opts?.projectPath ?? workspaceDir;
  if (!existsSync(workspaceDir)) {
    await mkdir(workspaceDir, { recursive: true });
  }

  // 2. 打开 SQLite 数据库（确保目录存在）
  const dbPath = resolve(dataDir, 'memora.db');
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // 3. 创建存储实现
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);

  // 4. 创建 LLM Provider
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

  console.log('\nMemora Sprite 已启动（输入 /quit 退出）\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

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
