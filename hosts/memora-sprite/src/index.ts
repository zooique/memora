/**
 * Memora Sprite — 桌面精灵宿主库入口
 *
 * 职责：
 *   1. 提供库导出（类型、类、工厂函数）
 *   2. 提供 Agent + Sprite 初始化函数（startSprite、reinitAgent）
 *   3. 提供配置管理函数（saveLlmConfig、isLlmConfigured）
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵知道用户在做什么，不知道用户在打什么
 *
 * D-01 修复：CLI 逻辑（setupWizard、命令路由、REPL 循环）已拆分至 src/cli.ts。
 * 本文件仅保留纯库导出，可被 Electron 宿主和 CLI 同时引用，无循环依赖。
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Agent, createLlmProvider, createProviderFromConfig, loadConfig, VectorStore, EmbeddingProvider } from 'memora';
import type { UIMessages, Config, ITracer } from 'memora';
import { SqliteStorage } from './storage/sqliteStorage.js';
import { SqliteSessionStore } from './storage/sessionStore.js';
import { SpriteConfigStore, DEFAULT_CONFIG_PATH } from './storage/spriteConfigStore.js';
import { Sprite } from './sprite/sprite.js';
import { SpriteTracer } from './sprite/spriteTracer.js';
// H4：宿主自定义工具（web_search + memory_search）
import {
  WEB_SEARCH_TOOL,
  MEMORY_SEARCH_TOOL,
  webSearchHandler,
  memorySearchHandler,
  setMemorySearcher,
} from './sprite/tools.js';
export type { DashboardData, SpriteEventMap } from './sprite/sprite.js';
export { Sprite } from './sprite/sprite.js';
export type { SpriteConfig, SpriteConfigKey } from './sprite/spriteConfig.js';
export { DEFAULT_SPRITE_CONFIG, loadSpriteConfig, saveSpriteConfig } from './sprite/spriteConfig.js';
export type { SpriteTrigger, TriggerPayload, TriggerCallback } from './sprite/triggers.js';
export { TimerTrigger, TriggerBus } from './sprite/triggers.js';
export type { FileWatcherConfig } from './sprite/fileWatcherTrigger.js';
export { FileWatcherTrigger } from './sprite/fileWatcherTrigger.js';
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

/** 默认数据目录（Agent 级共享，~/.memora-sprite/data/） */
export const DEFAULT_DATA_DIR = resolve(homedir(), '.memora-sprite', 'data');

/** 默认配置目录（Agent 级共享，~/.memora-sprite/config/） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), '.memora-sprite', 'config');

/** LLM 预设配置（导出供 Electron 设置面板和 CLI 向导使用） */
export const PROVIDER_PRESETS: Record<string, { provider: string; model: string; baseUrl: string }> = {
  '1': { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  '2': { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  '3': { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
};

/**
 * 保存 LLM 配置到 ~/.memora-sprite/config.json
 *
 * 委托到 SpriteConfigStore.save，确保读写路径一致。
 * 供 Electron 设置面板调用——用户在 UI 中配置 LLM 后，
 * 通过此函数持久化到配置文件，随后调用 reinitAgent 重新初始化 Agent。
 *
 * @param llmConfig LLM 配置（provider/model/baseUrl/apiKey）
 * @param embeddingConfig 可选的 Embedding 配置
 * @param configPath 配置文件路径（默认 ~/.memora-sprite/config.json）
 */
export async function saveLlmConfig(
  llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number; background?: { enabled: boolean; provider: string; model: string; baseUrl: string; apiKey: string } },
  embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  configPath?: string,
): Promise<void> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  await store.save(llmConfig, embeddingConfig);
}

/**
 * 检查 LLM 配置是否完整
 *
 * 委托到 SpriteConfigStore.isConfigured，确保读写路径一致。
 * 供 Electron 启动时判断是否需要显示首次启动引导。
 * @param configPath 配置文件路径（默认 ~/.memora-sprite/config.json）
 * @returns true 表示配置完整，false 表示需要引导
 */
export async function isLlmConfigured(configPath?: string): Promise<boolean> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  return store.isConfigured();
}

// ─── 启动精灵 ──────────────────────────────────────────

/**
 * 创建存储层（SQLite DB + SqliteStorage + SqliteSessionStore）
 *
 * 确保 dataDir 目录存在，打开 memora.db（WAL 模式），
 * 创建存储实现和会话存储实例。
 *
 * @param dataDir 数据目录路径
 * @returns 存储层实例
 */
function createStorage(dataDir: string): {
  storage: SqliteStorage;
  sessionStore: SqliteSessionStore;
  db: Database.Database;
} {
  const dbPath = resolve(dataDir, 'memora.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);
  return { storage, sessionStore, db };
}

/**
 * 创建 VectorStore（可选，配置了 embedding 时启用语义召回）
 *
 * @param config 应用配置
 * @param dataDir 数据目录路径
 * @returns VectorStore 实例，未配置 embedding 时返回 undefined
 */
async function createVectorStoreIfNeeded(
  config: Config,
  dataDir: string,
): Promise<VectorStore | undefined> {
  if (!config.embedding?.model) return undefined;

  const embeddingProvider = new EmbeddingProvider({
    baseUrl: config.embedding.baseUrl ?? config.llm.baseUrl ?? '',
    apiKey: config.embedding.apiKey ?? config.llm.apiKey ?? '',
    model: config.embedding.model,
  });
  const vectorStore = new VectorStore(
    resolve(dataDir, 'vectors.json'),
    embeddingProvider,
  );
  await vectorStore.load();
  return vectorStore;
}

/**
 * 创建并初始化 Agent 实例
 *
 * 职责：存储层 + Provider + Agent 构造 + init。
 * 不负责 post-init 扩展（关键词/后台 Provider/会话恢复/工具注册/作品投影）。
 *
 * @param config 应用配置
 * @param opts 路径选项
 * @returns Agent 实例 + 存储层引用 + 数据目录
 */
async function createAgentInstance(
  config: Config,
  opts?: { configDir?: string; dataDir?: string; projectPath?: string },
): Promise<{
  agent: Agent;
  sessionStore: SqliteSessionStore;
  storage: SqliteStorage;
  vectorStore: VectorStore | undefined;
  tracer: ITracer;
  dataDir: string;
  projectPath: string;
}> {
  const configDir = opts?.configDir ?? DEFAULT_CONFIG_DIR;
  // 默认强制使用 DEFAULT_DATA_DIR，避免 loadConfig 默认值创建错误目录
  const dataDir = opts?.dataDir ?? DEFAULT_DATA_DIR;

  // 精灵的工作空间：~/.memora-sprite/data/workspace/
  const workspaceDir = resolve(dataDir, 'workspace');
  const projectPath = opts?.projectPath ?? workspaceDir;
  if (!existsSync(workspaceDir)) {
    await mkdir(workspaceDir, { recursive: true });
  }

  // 确保 dataDir 存在
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }

  // 创建存储层
  const { storage, sessionStore } = createStorage(dataDir);

  // 创建 LLM Provider
  const provider = createLlmProvider(config);

  // 创建 VectorStore（可选，配置了 embedding 时启用语义召回）
  const vectorStore = await createVectorStoreIfNeeded(config, dataDir);

  // 实例化可观测性 Tracer
  const tracer: ITracer = new SpriteTracer(dataDir);

  // 实例化 Agent
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
    tracer,
  });

  await agent.init();

  return { agent, sessionStore, storage, vectorStore, tracer, dataDir, projectPath };
}

/**
 * Agent post-init 扩展设置
 *
 * 职责：关键词设置 + 后台 Provider + 会话恢复 + 作品投影 + 工具注册。
 * 这些操作依赖 Agent 已 init 完成，但与存储层无关。
 *
 * @param agent 已初始化的 Agent 实例
 * @param config 应用配置
 * @param projectPath 项目路径
 */
async function setupAgentPostInit(
  agent: Agent,
  config: Config,
  projectPath: string,
): Promise<void> {
  // 设置宿主记忆关键词，帮助 InsightExtractor 区分领域相关和个人相关输入
  agent.insight?.setKeywords({
    domain: ['代码', '编程', '开发', '项目', '文档', '写作', '设计', '调试', '部署', '测试'],
    personal: [],
  });

  // 后台 Provider：用于 Insight 提取、配置分析等后台 LLM 任务
  if (config.llm.background) {
    const bgProvider = createProviderFromConfig('background', config.llm.background);
    agent.setBackgroundProvider(bgProvider);
  }

  // 恢复上次会话（连续演化任务的核心体验）
  const restored = await agent.sessionManager!.restoreMostRecentSession('main');
  if (restored > 0) {
    console.log(`已恢复上次会话（${restored} 条消息）\n`);
  }

  // H3：最小作品投影生成 — 启动时读取项目关键文件
  if (agent.works) {
    const keyFiles = ['README.md', 'package.json'];
    for (const filename of keyFiles) {
      try {
        const fullPath = resolve(projectPath, filename);
        if (existsSync(fullPath)) {
          const content = await readFile(fullPath, 'utf-8');
          await agent.works.ensureProjection(fullPath, content, filename);
        }
      } catch {
        console.warn(`[H3] 作品投影生成失败: ${filename}`);
      }
    }
  }

  // H4：注册宿主自定义工具（web_search + memory_search）
  if (agent.tools) {
    setMemorySearcher(async (query, limit) => {
      const hits = await agent.memory!.search(query, limit);
      return hits.map((h) => ({
        name: h.name,
        contentPreview: h.contentPreview ?? '',
        score: h.score,
      }));
    });
    agent.tools.registerTool(WEB_SEARCH_TOOL, webSearchHandler);
    agent.tools.registerTool(MEMORY_SEARCH_TOOL, memorySearchHandler);
  }
}

/**
 * 创建 Sprite 实例 + 关闭清理函数
 *
 * 职责：Sprite 构造 + start + 关闭时资源清理（agent.close → vectorStore.save → storage.close）。
 * 每个清理步骤独立 try/catch，确保 storage.close() 必执行。
 *
 * @param agent 已初始化的 Agent 实例
 * @param dataDir 数据目录
 * @param projectPath 项目路径
 * @param vectorStore 向量存储（可选）
 * @param config 应用配置
 * @param tracer 可观测性 tracer
 * @param storage 存储实例（用于 close 清理）
 */
function createSpriteAndClose(
  agent: Agent,
  dataDir: string,
  projectPath: string,
  vectorStore: VectorStore | undefined,
  config: Config,
  tracer: ITracer,
  storage: SqliteStorage,
): { sprite: Sprite; close: () => Promise<void> } {
  const sprite = new Sprite({ agent, dataDir, projectPath, vectorStore, allowedPaths: config.allowedPaths, tracer });
  sprite.start();

  const close = async () => {
    sprite.stop();
    // P2-S1 修复：每个清理步骤独立 try/catch，确保 storage.close() 必执行
    try {
      await agent.close();
    } catch (err) {
      console.warn('[close] agent.close() 失败:', err);
    }
    try {
      if (vectorStore) await vectorStore.save();
    } catch (err) {
      console.warn('[close] vectorStore.save() 失败:', err);
    }
    storage.close();
  };

  return { sprite, close };
}

/**
 * 从配置初始化 Agent + Sprite（内部函数）
 *
 * 不负责配置加载和 CLI 引导，仅根据传入的 Config 实例化 Agent + Sprite。
 * 供 startSprite 和 reinitAgent 复用。
 *
 * 第二季重构：拆分为 3 个子函数——createAgentInstance / setupAgentPostInit / createSpriteAndClose。
 */
async function initAgentFromConfig(
  config: Config,
  opts?: { configDir?: string; dataDir?: string; projectPath?: string },
): Promise<{ agent: Agent; sprite: Sprite; sessionStore: SqliteSessionStore; dataDir: string; close: () => Promise<void> }> {
  // 1. 创建 Agent 实例（存储层 + Provider + VectorStore + Tracer）
  const { agent, sessionStore, storage, vectorStore, tracer, dataDir, projectPath } =
    await createAgentInstance(config, opts);

  // 2. post-init 扩展（关键词 + 后台 Provider + 会话恢复 + 工具 + 作品投影）
  await setupAgentPostInit(agent, config, projectPath);

  // 3. 创建 Sprite + 关闭清理函数
  const { sprite, close } = createSpriteAndClose(agent, dataDir, projectPath, vectorStore, config, tracer, storage);

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
    } catch (err) {
      // P2-S2 修复：旧实例清理失败不阻塞重新初始化，但需记录日志辅助排查资源泄漏
      console.warn('[reinitAgent] 旧实例清理失败:', err);
    }
  }

  // 2. 重新加载配置（默认从 sprite 专属路径读取，确保与 saveLlmConfig 写入路径一致）
  const config = await loadConfig(opts?.configPath ?? DEFAULT_CONFIG_PATH);

  // 3. 用新配置初始化
  return initAgentFromConfig(config, opts);
}

/**
 * 启动精灵
 *
 * 配置优先级（高 → 低）：
 *   1. opts 参数（编程调用时传入）
 *   2. ~/.memora-sprite/config.json（用户级配置）
 *   3. .memora/config.json（项目级配置）
 *   4. 内置默认值
 *
 * D-01 修复：不再内部调用 setupWizard（已移至 CLI）。
 * 配置缺失时直接抛出错误，由调用方（CLI / Electron）自行处理引导流程。
 *
 * @param opts - 启动选项（可选，覆盖配置文件）
 * @returns 精灵实例 + 会话存储 + 关闭函数（用于外部控制）
 */
export async function startSprite(opts?: {
  projectPath?: string;
  configDir?: string;
  dataDir?: string;
  configPath?: string;
}): Promise<{ agent: Agent; sprite: Sprite; sessionStore: SqliteSessionStore; dataDir: string; close: () => Promise<void> }> {
  // 1. 加载配置文件
  let config: Config;
  try {
    config = await loadConfig(opts?.configPath ?? DEFAULT_CONFIG_PATH);
    if (!config.llm.apiKey) {
      throw new Error('API Key 未配置');
    }
  } catch {
    throw new Error('配置不完整，请在设置面板中配置 LLM 提供商和 API Key');
  }

  // 2. 用配置初始化 Agent + Sprite
  return initAgentFromConfig(config, opts);
}