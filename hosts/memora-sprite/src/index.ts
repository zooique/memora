#!/usr/bin/env node
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
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import Database from 'better-sqlite3';
import { Agent, createLlmProvider, loadConfig, VectorStore, EmbeddingProvider, toError } from 'memora';
import type { UIMessages, Config } from 'memora';
import { SqliteStorage } from './storage/sqliteStorage.js';
import { SqliteSessionStore } from './storage/sessionStore.js';
import { Sprite } from './sprite/sprite.js';
import { CliInteraction } from './sprite/cliInteraction.js';
import type { IInteraction } from './sprite/interaction.js';
import type { SpriteConfigKey } from './sprite/spriteConfig.js';
export type { DashboardData, SpriteEventMap } from './sprite/sprite.js';
export type { SpriteConfig, SpriteConfigKey } from './sprite/spriteConfig.js';
export { DEFAULT_SPRITE_CONFIG, loadSpriteConfig, saveSpriteConfig } from './sprite/spriteConfig.js';
export type { SpriteTrigger, TriggerPayload, TriggerCallback } from './sprite/triggers.js';
export { TimerTrigger, TriggerBus } from './sprite/triggers.js';
export type { FileWatcherConfig } from './sprite/fileWatcherTrigger.js';
export { FileWatcherTrigger } from './sprite/fileWatcherTrigger.js';
// P2-007 修复：移除未使用的 InputEvent 导出。
// InputEvent 仅在 interaction.ts 内部作为 InputHandler 的参数类型使用，
// 宿主项目通过 InputHandler 间接消费，无需直接引用。
export type { IInteraction, InputHandler, CloseHandler } from './sprite/interaction.js';
export { CliInteraction } from './sprite/cliInteraction.js';

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

/** 默认数据目录（Agent 级共享，~/.memora/） */
export const DEFAULT_DATA_DIR = resolve(homedir(), '.memora');

/** 默认配置目录（Agent 级共享，~/.memora-config/） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), '.memora-config');

// ─── 首次启动引导 ──────────────────────────────────────

/** 交互式提问 */
function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/** LLM 预设配置（导出供 Electron 设置面板使用） */
export const PROVIDER_PRESETS: Record<string, { provider: string; model: string; baseUrl: string }> = {
  '1': { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  '2': { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  '3': { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
};

/**
 * 保存 LLM 配置到 ~/.memora/config.json
 *
 * 供 Electron 设置面板调用——用户在 UI 中配置 LLM 后，
 * 通过此函数持久化到配置文件，随后调用 reinitAgent 重新初始化 Agent。
 *
 * @param llmConfig LLM 配置（provider/model/baseUrl/apiKey）
 * @param embeddingConfig 可选的 Embedding 配置
 * @param configPath 配置文件路径（默认 ~/.memora/config.json）
 */
export async function saveLlmConfig(
  llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
  embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  configPath?: string,
): Promise<void> {
  const configDir = DEFAULT_DATA_DIR;
  const targetPath = configPath ?? resolve(configDir, 'config.json');
  await mkdir(configDir, { recursive: true });

  // 读取现有配置（保留其他字段），不存在则用默认值
  let existing: Config;
  try {
    existing = await loadConfig(targetPath);
  } catch {
    existing = {
      llm: { provider: 'mock', model: 'mock-model', temperature: 0.7 },
      memory: { dataDir: '~/.memora', maxContextTokens: 120000 },
      security: { permission: 'owner', confirmWrites: false },
      allowedPaths: [],
    };
  }

  // 合并新配置
  const config: Config = {
    ...existing,
    llm: {
      ...existing.llm,
      provider: llmConfig.provider,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
      apiKey: llmConfig.apiKey,
      temperature: llmConfig.temperature ?? existing.llm.temperature ?? 0.7,
    },
    ...(embeddingConfig ? { embedding: embeddingConfig } : {}),
  };

  // 设置 0600 权限：仅文件所有者可读写（防止 apiKey 泄露给同机其他用户）
  await writeFile(targetPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * 检查 LLM 配置是否完整
 *
 * 供 Electron 启动时判断是否需要显示首次启动引导。
 * @param configPath 配置文件路径（默认 ~/.memora/config.json）
 * @returns true 表示配置完整，false 表示需要引导
 */
export async function isLlmConfigured(configPath?: string): Promise<boolean> {
  try {
    const config = await loadConfig(configPath);
    return Boolean(config.llm.apiKey && config.llm.provider !== 'mock');
  } catch {
    return false;
  }
}

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

  // ── 可选：Embedding 配置（启用语义召回） ──
  console.log('\n── Embedding 配置（可选） ──');
  console.log('配置后启用语义搜索（向量召回），让记忆搜索更智能。');
  console.log('Embedding API 与 Chat API 独立，可使用不同提供商。');
  console.log('常见选项：');
  console.log('  - OpenAI text-embedding-3-small（$0.02/1M tokens）');
  console.log('  - 硅基流动 BAAI/bge-large-zh-v1.5（免费）');
  console.log('  - Ollama 本地 bge-m3（完全免费，需安装 Ollama）');
  console.log('  - 与 Chat 相同的提供商（如果支持 /embeddings 端点）');

  let embedding: Config['embedding'];
  const wantEmbedding = await ask(rl, '\n是否配置 Embedding？[y/N]：');
  if (wantEmbedding.toLowerCase() === 'y' || wantEmbedding.toLowerCase() === 'yes') {
    const useSameAsChat = await ask(rl, '复用 Chat 的 baseUrl 和 apiKey？[Y/n]：');
    let embBaseUrl: string;
    let embApiKey: string;
    if (useSameAsChat.toLowerCase() === 'n' || useSameAsChat.toLowerCase() === 'no') {
      embBaseUrl = await ask(rl, 'Embedding API 地址（如 https://api.siliconflow.cn/v1）：');
      embApiKey = await ask(rl, 'Embedding API Key：');
      if (!embApiKey) {
        console.error('错误：Embedding API Key 不能为空');
        rl.close();
        process.exit(1);
      }
    } else {
      embBaseUrl = providerConfig.baseUrl;
      embApiKey = apiKey;
    }
    const embModel = await ask(rl, 'Embedding 模型名称（如 text-embedding-3-small、BAAI/bge-large-zh-v1.5）：');
    if (!embModel) {
      console.error('错误：Embedding 模型名称不能为空');
      rl.close();
      process.exit(1);
    }
    embedding = { baseUrl: embBaseUrl, apiKey: embApiKey, model: embModel };
  }

  rl.close();

  // 保存配置
  const configPath = resolve(DEFAULT_DATA_DIR, 'config.json');
  await mkdir(DEFAULT_DATA_DIR, { recursive: true });

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
    ...(embedding ? { embedding } : {}),
  };

  // 设置 0600 权限：仅文件所有者可读写（防止 apiKey 泄露给同机其他用户）
  await writeFile(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  console.log(`\n配置已保存到：${configPath}`);
  if (embedding) {
    console.log('✅ 已启用语义搜索（向量召回）');
  } else {
    console.log('ℹ️  未配置 Embedding，使用纯关键词召回（后续可手动配置）');
  }
}

// ─── 启动精灵 ──────────────────────────────────────────

/**
 * 从配置初始化 Agent + Sprite（内部函数）
 *
 * 不负责配置加载和 CLI 引导，仅根据传入的 Config 实例化 Agent + Sprite。
 * 供 startSprite 和 reinitAgent 复用。
 */
async function initAgentFromConfig(
  config: Config,
  opts?: { configDir?: string; dataDir?: string; projectPath?: string },
): Promise<{ agent: Agent; sprite: Sprite; sessionStore: SqliteSessionStore; dataDir: string; close: () => Promise<void> }> {
  const configDir = opts?.configDir ?? DEFAULT_CONFIG_DIR;
  // 展开 ~ 为实际 home 目录
  const rawDir = config.memory.dataDir.startsWith('~')
    ? resolve(homedir(), config.memory.dataDir.slice(1).replace(/^[/\\]/, ''))
    : config.memory.dataDir;
  const dataDir = opts?.dataDir ?? rawDir;

  // 精灵的工作空间：~/.memora/workspace/（而非源码目录）
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

  // 4.5 创建 VectorStore（可选，配置了 embedding 时启用语义召回）
  let vectorStore: VectorStore | undefined;
  if (config.embedding?.model) {
    const embeddingProvider = new EmbeddingProvider({
      baseUrl: config.embedding.baseUrl ?? config.llm.baseUrl ?? '',
      apiKey: config.embedding.apiKey ?? config.llm.apiKey ?? '',
      model: config.embedding.model,
    });
    vectorStore = new VectorStore(
      resolve(dataDir, 'vectors.json'),
      embeddingProvider,
    );
    await vectorStore.load();
  }

  // 5. 实例化 Agent
  const agent = new Agent({
    projectPath,
    configDir,
    dataDir,
    provider,
    storage,
    sessionStore,
    vectorStore,
    messages: ZH_MESSAGES,
    enableContextSummary: true,
    permission: config.security.permission,
    allowedPaths: config.allowedPaths,
  });

  await agent.init();

  // 恢复上次会话（连续演化任务的核心体验）
  const restored = await agent.restoreMostRecentSession('main');
  if (restored > 0) {
    console.log(`已恢复上次会话（${restored} 条消息）\n`);
  }

  // 6. 启动精灵主控
  const sprite = new Sprite(agent, dataDir, projectPath, vectorStore, undefined, config.allowedPaths);
  sprite.start();

  const close = async () => {
    sprite.stop();
    await agent.close();
    if (vectorStore) await vectorStore.save();
    storage.close();
  };

  return { agent, sprite, sessionStore, dataDir, close };
}

/**
 * 重新初始化 Agent + Sprite
 *
 * 供 Electron 设置面板调用——用户在 UI 中修改 LLM 配置后，
 * 先调用 saveLlmConfig 持久化，再调用此函数重新初始化 Agent。
 *
 * @param prevClose 上一次 startSprite/reinitAgent 返回的 close 函数（用于清理旧实例）
 * @param opts 配置选项
 * @returns 新的 Agent + Sprite + close 函数
 */
export async function reinitAgent(
  prevClose: (() => Promise<void>) | null,
  opts?: { configDir?: string; dataDir?: string; projectPath?: string; configPath?: string },
): Promise<{ agent: Agent; sprite: Sprite; sessionStore: SqliteSessionStore; dataDir: string; close: () => Promise<void> }> {
  // 1. 清理旧实例
  if (prevClose) {
    try {
      await prevClose();
    } catch {
      // 旧实例清理失败不阻塞重新初始化
    }
  }

  // 2. 重新加载配置
  const config = await loadConfig(opts?.configPath);

  // 3. 用新配置初始化
  return initAgentFromConfig(config, opts);
}

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
 * @returns 精灵实例 + 会话存储 + 关闭函数（用于外部控制）
 */
export async function startSprite(opts?: {
  projectPath?: string;
  configDir?: string;
  dataDir?: string;
  configPath?: string;
  /** Electron 模式：跳过 CLI 交互式引导，配置缺失时抛错由前端处理 */
  skipWizard?: boolean;
}): Promise<{ agent: Agent; sprite: Sprite; sessionStore: SqliteSessionStore; dataDir: string; close: () => Promise<void> }> {
  // 1. 加载配置文件（首次启动时自动引导）
  let config: Config;
  try {
    config = await loadConfig(opts?.configPath);
    // 检查是否有 API Key
    if (!config.llm.apiKey) {
      throw new Error('API Key 未配置');
    }
  } catch {
    if (opts?.skipWizard) {
      // Electron 模式：不阻塞，抛出配置错误由前端设置面板处理
      throw new Error('配置不完整，请在设置面板中配置 LLM 提供商和 API Key');
    }
    // CLI 模式：交互式引导用户配置
    await setupWizard();
    config = await loadConfig(opts?.configPath);
  }

  // 2. 用配置初始化 Agent + Sprite
  return initAgentFromConfig(config, opts);
}

// ─── 配置命令辅助 ──────────────────────────────────────

/** CLI /config 命令可配置的键名集合（与帮助文本保持一致） */
const CLI_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'triggerIntervalMs',
  'defaultPersona',
  'silentMode',
  'proactiveThreshold',
  'proactiveCooldownMs',
  'fileWatcherEnabled',
  'fileWatcherPaths',
  'fileWatcherIgnore',
  'fileWatcherDebounceMs',
]);

/**
 * 类型守卫：校验字符串是否为 CLI 可配置的 SpriteConfigKey
 *
 * 替代 `key as never` 类型断言，通过运行时校验 + 类型窄化确保类型安全。
 * 仅允许 CLI 帮助文本中列出的 8 个键名通过，其他键名（如 floatIconPosition、windowState 等）
 * 不通过 CLI /config 命令配置，由各自专属的 UI 操作管理。
 */
function isCliConfigKey(key: string): key is SpriteConfigKey {
  return CLI_CONFIG_KEYS.has(key);
}

// ─── 记忆管理命令 ──────────────────────────────────────

/** 处理 /memories 命令 */
async function handleMemories(args: string, sprite: Sprite): Promise<void> {
  const parts = args.split(/\s+/);
  const sub = parts[0] ?? '';

  if (!sub || sub === 'list') {
    // /memories [source]
    const source = parts[1] || undefined;
    const memories = sprite.listMemories(source);
    if (memories.length === 0) {
      console.log(source ? `没有来源为 "${source}" 的记忆` : '记忆库为空');
      return;
    }
    console.log(`\n记忆列表（${memories.length} 条）${source ? ` · source: ${source}` : ''}:`);
    console.log('─'.repeat(70));
    for (const m of memories) {
      console.log(`[${m.id}]`);
      console.log(`  ${m.name}  ·  ${m.source}  ·  score: ${m.score}`);
      console.log(`  ${m.contentPreview}`);
      console.log('');
    }
    console.log('用法：/memories add <source> <name> <内容> | /memories show <id> | /memories delete <id> | /memories search <关键词>');
    return;
  }

  if (sub === 'show') {
    const id = parts[1];
    if (!id) { console.log('用法：/memories show <id>'); return; }
    const m = sprite.showMemory(id);
    if (!m) { console.log(`记忆 ${id} 不存在`); return; }
    console.log(`\n记忆详情：${m.id}`);
    console.log('─'.repeat(60));
    console.log(`名称：${m.name}`);
    console.log(`来源：${m.source}`);
    console.log(`权重：${m.score}`);
    console.log(`创建时间：${m.createdAt}`);
    console.log(`最近访问：${m.accessedAt}`);
    console.log(`内容：`);
    console.log(m.content);
    console.log('─'.repeat(60));
    return;
  }

  if (sub === 'delete') {
    const id = parts[1];
    if (!id) { console.log('用法：/memories delete <id>'); return; }
    const ok = sprite.deleteMemory(id);
    console.log(ok ? `已删除记忆：${id}` : `记忆 ${id} 不存在`);
    return;
  }

  if (sub === 'search') {
    const query = parts.slice(1).join(' ');
    if (!query) { console.log('用法：/memories search <关键词>'); return; }
    const hits = await sprite.searchMemories(query);
    if (hits.length === 0) { console.log(`未找到与 "${query}" 相关的记忆`); return; }
    console.log(`\n搜索 "${query}" — ${hits.length} 条结果:`);
    console.log('─'.repeat(70));
    for (const h of hits) {
      const simTag = h.similarity !== undefined ? `  ·  相似度: ${(h.similarity * 100).toFixed(0)}%` : '';
      console.log(`[${h.name}]  ·  ${h.source}  ·  score: ${h.score}${simTag}`);
      console.log(`  ${h.contentPreview}`);
      console.log('');
    }
    return;
  }

  if (sub === 'add') {
    const source = parts[1];
    const name = parts[2];
    const content = parts.slice(3).join(' ');
    if (!source || !name || !content) {
      console.log('用法：/memories add <source> <name> <内容>');
      console.log('示例：/memories add insight "React 经验" 用户有 3 年 React 经验');
      return;
    }
    try {
      const id = sprite.upsertMemory(source, name, content);
      console.log(`已添加记忆：${id}`);
    } catch (error) {
      console.log(`添加失败：${toError(error).message}`);
    }
    return;
  }

  console.log(`未知子命令：${sub}`);
  console.log('用法：/memories [list [source]] | add <source> <name> <内容> | show <id> | delete <id> | search <关键词>');
}

// ─── CLI 直接运行 ──────────────────────────────────────

/**
 * 启动 CLI 交互循环
 *
 * 使用 CliInteraction（readline）作为交互层，
 * 未来可替换为 Electron IPC 实现。
 */
async function main(): Promise<void> {
  const { agent, sprite, close } = await startSprite();

  const interaction: IInteraction = new CliInteraction();
  sprite.setInteraction(interaction);

  console.log('\nMemora Sprite 已启动（/quit 退出 | /dashboard 仪表盘 | /persona 角色列表 | /switch <名称> 切换角色 | /mode auto|manual 匹配模式 | /web <关键词> 浏览器搜索 | /memories 记忆管理 | /config 配置）\n');

  interaction.onClose(async () => {
    console.log('\n正在关闭...');
    await close();
    process.exit(0);
  });

  interaction.start(async ({ text }) => {
    // 命令路由
    if (text === '/quit') {
      close().then(() => {
        interaction.stop();
        process.exit(0);
      });
      return;
    }

    if (text === '/dashboard') {
      console.log(sprite.formatDashboard());
      return;
    }

    if (text === '/persona') {
      console.log(sprite.formatPersonas());
      return;
    }

    if (text.startsWith('/switch ')) {
      const name = text.slice(8).trim();
      if (!name) {
        console.log('用法：/switch <角色名称>');
        return;
      }
      const result = sprite.switchPersona(name);
      if (result) {
        console.log(`已切换到角色：${result}`);
      } else {
        console.log(`角色 "${name}" 不存在或角色管理不可用`);
      }
      return;
    }

    if (text.startsWith('/mode')) {
      const modeArg = text.slice(5).trim();
      if (modeArg === 'auto' || modeArg === 'manual') {
        sprite.setPersonaMode(modeArg);
        console.log(`角色匹配模式已切换为：${modeArg}`);
      } else {
        console.log(`当前模式：${sprite.personaMode}`);
        console.log('用法：/mode auto（自动匹配）| /mode manual（手动固定）');
      }
      return;
    }

    if (text.startsWith('/web ')) {
      const query = text.slice(5).trim();
      if (!query) {
        console.log('用法：/web <搜索关键词>');
        return;
      }
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      // 使用 execFile 而非 exec：直接调用可执行文件，不经过 shell，消除命令注入风险
      // Windows: start 是 cmd 内建命令，需通过 cmd /c 调用；macOS/Linux: 直接调用 open/xdg-open
      const platform = process.platform;
      const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
      const args = platform === 'win32' ? ['/c', 'start', '', searchUrl] : [searchUrl];
      execFile(cmd, args, (err) => {
        if (err) {
          console.log(`无法打开浏览器：${err.message}`);
        } else {
          console.log(`已在浏览器中搜索：${query}`);
        }
      });
      return;
    }

    if (text.startsWith('/memories')) {
      const args = text.slice(9).trim();
      await handleMemories(args, sprite);
      return;
    }

    if (text === '/config') {
      console.log(sprite.formatConfig());
      return;
    }

    if (text.startsWith('/config ')) {
      const parts = text.slice(8).trim().split(/\s+/);
      if (parts.length < 2) {
        console.log('用法：/config <键名> <值>');
        console.log(`可用键名：${[...CLI_CONFIG_KEYS].join(', ')}`);
        return;
      }
      const [key = '', ...valueParts] = parts;
      const rawValue = valueParts.join(' ');

      // 键名校验：用类型守卫替代 `as never`，无效键名直接报错
      if (!isCliConfigKey(key)) {
        console.log(`错误：未知配置键名 "${key}"`);
        console.log(`可用键名：${[...CLI_CONFIG_KEYS].join(', ')}`);
        return;
      }

      // 类型转换（key 已窄化为 SpriteConfigKey，分支判断类型安全）
      let value: unknown;
      if (key === 'silentMode' || key === 'fileWatcherEnabled') {
        value = rawValue === 'true' || rawValue === 'on' || rawValue === '1';
      } else if (key === 'triggerIntervalMs' || key === 'proactiveThreshold' || key === 'proactiveCooldownMs' || key === 'fileWatcherDebounceMs') {
        value = Number(rawValue);
        if (Number.isNaN(value)) {
          console.log(`错误：${key} 需要数字值`);
          return;
        }
      } else if (key === 'fileWatcherPaths' || key === 'fileWatcherIgnore') {
        value = rawValue.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        value = rawValue;
      }

      sprite.updateConfig(key, value);
      console.log(`已更新：${key} = ${JSON.stringify(value)}`);
      return;
    }

    // 对话
    (async () => {
      try {
        for await (const chunk of agent.chat(text)) {
          if (chunk.type === 'text') {
            interaction.output(chunk.content);
          } else if (chunk.type === 'done') {
            interaction.output('\n');
          } else if (chunk.type === 'aborted') {
            console.log(`\n[${chunk.reason}]`);
          }
        }
      } catch (error) {
        console.error('\n对话出错:', error);
      }
    })();
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
) {
  main().catch(console.error);
}
