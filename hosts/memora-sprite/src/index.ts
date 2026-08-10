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
 * CLI 逻辑（setupWizard、命令路由、REPL 循环）已拆分至 src/cli.ts。
 * 本文件仅保留纯库导出，可被 Electron 宿主和 CLI 同时引用，无循环依赖。
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Agent, createLlmProvider, createProviderFromConfig, loadConfig, JsonVectorStore, EmbeddingProvider, FetchWebSearchProvider, logger, toError, SOURCE_LABELS, SOURCE_TO_DIR, parseConfigId } from 'memora';
import type { UIMessages, Config, ITracer, AgentSearchHit, IVectorStore } from 'memora';
import { SqliteStorage } from './storage/sqliteStorage.js';
import { SqliteSessionStore } from './storage/sessionStore.js';
// ADR-014 记忆关系图谱：侧车存储，与 SqliteStorage 共享同一 db 实例
import { SqliteRelationStore } from './storage/sqliteRelationStore.js';
// SQLite 数据库抽象接口 + node:sqlite 适配器（用于 Web/CLI 模式，避免 better-sqlite3 ABI 冲突）
// 注意：better-sqlite3 改为动态 import（见 createBetterSqliteDb），避免 Node.js 环境加载 native 模块
import type { ISqliteDatabase } from './storage/sqliteDatabaseTypes.js';
import { NodeSqliteDatabase } from './storage/nodeSqliteDatabase.js';
import { SpriteConfigStore, DEFAULT_CONFIG_PATH, resolveProviderConfig } from './storage/spriteConfigStore.js';
import { Sprite } from './sprite/sprite.js';
import { SpriteTracer } from './sprite/spriteTracer.js';
import { SpriteError, ErrorCode } from './sprite/errors.js';
import { SPRITE_HOME_DIR_NAME } from './sprite/constants.js';
import { resolveTargetPath } from './sprite/configFileManager.js';
// API Key 脱敏：统一真理源在 shared/apiKeyMask.ts（IPC + CLI/Web 共用）
import { maskApiKey } from './shared/apiKeyMask.js';
// 宿主自定义工具（memory_search + create_persona + create_skill + create_rule）
import {
  MEMORY_SEARCH_TOOL,
  CREATE_PERSONA_TOOL,
  CREATE_SKILL_TOOL,
  CREATE_RULE_TOOL,
  createSpriteHandlers,
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
export { CliInteraction } from './sprite/cli/interaction.js';

/** 中文 UI 消息覆盖 */
const ZH_MESSAGES: UIMessages = {
  abortedByUser: '用户取消了对话',
  maxIterationsReached: '\n\n[已达到最大迭代次数]',
  contextTruncated: (skipped: number, kept: number) =>
    `[上下文窗口截断：跳过 ${skipped} 条消息，保留最近 ${kept} 条]`,
  recentConversationLabel: '[最近对话]',
  userLabel: '用户',
  assistantLabel: '助手',
  inputBlockedByGuard: (rule: string) => `[输入被护栏拦截：${rule}]`,
  guardrailWarningPrefix: '[护栏警告]',
  outputBlockedByGuard: (rule: string) => `[输出被护栏拦截：${rule}]`,
};

/** 默认数据目录（Agent 级共享，~/.memora-sprite/data/） */
export const DEFAULT_DATA_DIR = resolve(homedir(), SPRITE_HOME_DIR_NAME, 'data');

/** 默认配置目录（Agent 级共享，~/.memora-sprite/config/） */
export const DEFAULT_CONFIG_DIR = resolve(homedir(), SPRITE_HOME_DIR_NAME, 'config');

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

/**
 * 获取所有 Provider 配置列表
 *
 * 从 config.json 读取 providers 映射表，转换为 UI 层格式。
 * 配置文件已收敛为 providers+active 单一格式（内核以 providers[active] 为真理源）。
 *
 * @param configPath 配置文件路径
 * @returns Provider 列表 + 当前激活的 alias
 */
export async function getLlmProviders(
  configPath?: string,
): Promise<{ active: string; providers: Array<{ key: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; temperature: number; contextWindow?: number }> }> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  const config = await store.load();
  const providers = config.llm.providers ?? {};

  // 统一展开 providers 映射表（配置文件已收敛为 providers+active 单一格式）
  const providerList = Object.entries(providers).map(([key, p]) => {
    const providerData = p as { provider: string; model: string; baseUrl?: string; apiKey?: string; temperature?: number; contextWindow?: number };
    return {
      key,
      name: key,
      provider: providerData.provider,
      model: providerData.model,
      baseUrl: providerData.baseUrl ?? '',
      apiKey: maskApiKey(providerData.apiKey),
      temperature: providerData.temperature ?? 0.7,
      contextWindow: providerData.contextWindow,
    };
  });
  const active = config.llm.active ?? Object.keys(providers)[0] ?? '';

  return {
    active,
    providers: providerList,
  };
}

/**
 * 保存 Provider 配置（新增/更新）
 *
 * 合并到 config.json 的 llm.providers 映射表。
 * 首次添加时自动设为 active（如果此前无 active）。
 *
 * **apiKey 为空时保留原值**：
 * 编辑场景下，渲染进程收到的 apiKey 是脱敏值（如 `sk1****abcd`），
 * 若用户未修改 apiKey 字段，渲染进程会传入空字符串。
 * 此时从旧 config 中读取原 apiKey 保留，避免脱敏值覆盖真实 Key 导致 401。
 *
 * @param key Provider 别名
 * @param providerConfig Provider 配置（apiKey 为空时保留原值）
 * @param configPath 配置文件路径
 */
export async function saveLlmProvider(
  key: string,
  providerConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number; contextWindow?: number },
  configPath?: string,
): Promise<void> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  // 用 loadOrDefault 而非 load：首次添加 Provider 时 config.json 可能尚不存在，
  // load() 会抛 ENOENT 导致添加失败；loadOrDefault 在文件缺失时返回默认配置
  const config = await store.loadOrDefault();

  const providers = { ...(config.llm.providers ?? {}) };
  // 编辑场景下 apiKey 为空表示"保持不变"，从旧 Provider 配置读取原 apiKey
  // 新增场景下 apiKey 必须由调用方校验非空（minimalHandlers 已校验）
  const existingProvider = providers[key];
  const resolvedApiKey = providerConfig.apiKey || existingProvider?.apiKey || undefined;

  providers[key] = {
    provider: providerConfig.provider,
    model: providerConfig.model,
    baseUrl: providerConfig.baseUrl || undefined,
    apiKey: resolvedApiKey,
    // 传递 temperature（可选，未传时回退到全局默认值）
    ...(providerConfig.temperature !== undefined ? { temperature: providerConfig.temperature } : {}),
    // 传递 contextWindow（可选，未传时回退到 memory.maxContextTokens）
    ...(providerConfig.contextWindow !== undefined ? { contextWindow: providerConfig.contextWindow } : {}),
  };

  // 首次添加时自动设为 active
  const active = config.llm.active ?? key;

  await store.saveProviders(providers, active, config);
}

/**
 * 删除 Provider
 *
 * 从 providers 映射表中移除指定 key。
 * 如果删除的是当前 active，自动切换到第一个剩余 provider。
 *
 * @param key 要删除的 Provider 别名
 * @param configPath 配置文件路径
 */
export async function deleteLlmProvider(
  key: string,
  configPath?: string,
): Promise<void> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  const config = await store.load();

  const providers = { ...(config.llm.providers ?? {}) };
  delete providers[key];

  // 如果删除的是当前 active，切换到第一个剩余 provider
  let active: string = config.llm.active ?? '';
  if (active === key) {
    active = Object.keys(providers)[0] ?? '';
  }

  await store.saveProviders(providers, active, config);
}

/**
 * 切换激活 Provider
 *
 * 更新 config.json 的 llm.active 字段。
 *
 * @param key 要激活的 Provider 别名
 * @param configPath 配置文件路径
 */
export async function setActiveLlmProvider(
  key: string,
  configPath?: string,
): Promise<void> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  const config = await store.load();

  // 使用统一的向后兼容工具函数解析 Provider 配置
  const provider = resolveProviderConfig(config, key);

  if (!provider) {
    throw new SpriteError(
      ErrorCode.INITIALIZATION_FAILED,
      `Provider "${key}" 不存在`,
      {
        context: {
          configuredProviders: Object.keys(config.llm.providers || {}),
        },
      },
    );
  }

  // 获取当前 providers 映射表（配置文件已统一为 providers+active 单一格式）
  const providers = config.llm.providers ?? {};

  await store.saveProviders(providers, key, config);
}

/**
 * 保存后台 Provider 选择
 *
 * 持久化后台 Provider 的 key 到 config.json（llm.background 字段）。
 * bgProvider 注入由 IPC handler 调用本函数后通过 callbacks.getCurrentAgent() 完成。
 *
 * key 为空字符串时清除 background 配置（回退到"与实时对话相同"）。
 *
 * 消费点：providerManagement UI 下拉框 change 事件 → IPC → 此函数
 *
 * @param key Provider 别名（空字符串表示清除）
 * @param configPath 配置文件路径
 */
export async function saveBackgroundProvider(
  key: string,
  configPath?: string,
): Promise<void> {
  const store = new SpriteConfigStore(configPath ?? DEFAULT_CONFIG_PATH);
  await store.saveBackgroundProvider(key || null);
}

// ─── 启动精灵 ──────────────────────────────────────────

/**
 * 检测当前是否运行在 Electron 环境中
 *
 * Electron 运行时会在 process.versions 上挂载 electron 字段。
 * 用于 createStorage 选择 SQLite 实现：
 *   - Electron 环境：用 better-sqlite3（已为 Electron ABI 编译）
 *   - Node.js 环境：用 node:sqlite（Node 内置，零 native 依赖，避免 ABI 冲突）
 *
 * @returns true 表示当前运行在 Electron 进程中
 */
function isElectronRuntime(): boolean {
  return typeof process.versions.electron === 'string';
}

/**
 * 创建存储层（SQLite DB + SqliteStorage + SqliteSessionStore + SqliteRelationStore）
 *
 * 确保 dataDir 目录存在，打开 memora.db（WAL 模式），
 * 创建存储实现、会话存储和关系存储实例。
 * 四者共享同一 db 实例，db.close() 时统一释放。
 *
 * 运行时自适应 SQLite 实现（解决 better-sqlite3 双 ABI 冲突）：
 *   - Electron 模式：动态 import better-sqlite3（postinstall 已 electron-rebuild 为 Electron ABI）
 *   - Web/CLI 模式：使用 node:sqlite（Node.js 22+ 内置，零 native 依赖）
 *   两者均实现 ISqliteDatabase 接口，存储类无感知。
 *
 * 注意：better-sqlite3 必须动态 import，否则在 Node.js 环境下静态 import
 * 会被打包器/转译器提前加载 native 模块，触发 ABI 错误。
 *
 * @param dataDir 数据目录路径
 * @returns 存储层实例（含 ISqliteDatabase 接口实例）
 */
async function createStorage(dataDir: string): Promise<{
  storage: SqliteStorage;
  sessionStore: SqliteSessionStore;
  relationStore: SqliteRelationStore;
  db: ISqliteDatabase;
}> {
  const dbPath = resolve(dataDir, 'memora.db');
  // 运行时分支：Electron 用 better-sqlite3，Node.js 用 node:sqlite
  // 两条路径均返回 ISqliteDatabase 接口实现，下游存储类无感知
  const db: ISqliteDatabase = isElectronRuntime()
    ? await createBetterSqliteDb(dbPath)
    : new NodeSqliteDatabase(dbPath);
  // WAL 模式提升并发读写性能（两种实现均支持 PRAGMA 语句）
  // 统一用 exec('PRAGMA ...')，避免在 ISqliteDatabase 接口上加 pragma() 方法
  // （ISqliteDatabase 文档原则：仅包含存储类实际使用的方法）
  db.exec('PRAGMA journal_mode = WAL');
  const storage = new SqliteStorage(db);
  const sessionStore = new SqliteSessionStore(db);
  // ADR-014 侧车模型：关系存储独立建表，不侵入 memories 表
  const relationStore = new SqliteRelationStore(db);
  return { storage, sessionStore, relationStore, db };
}

/**
 * 创建 better-sqlite3 数据库实例（Electron 模式专用）
 *
 * 封装 better-sqlite3 的动态 import + 实例化逻辑，与 NodeSqliteDatabase 平行。
 * 仅在 Electron 运行时调用，避免在 Node.js 环境加载 native 模块触发 ABI 错误。
 *
 * 为什么用动态 import：
 *   - 静态 import 在文件加载时即触发 better-sqlite3 的 JS 入口执行
 *   - 部分打包器（webpack）会预加载 native 模块，Node.js 环境下立即报 ABI 错误
 *   - 动态 import 延迟到 Electron 环境实际调用时才加载，确保 Node.js 环境零 native 依赖
 *
 * 错误处理友好化：包裹 try/catch，抛出带上下文的 SpriteError
 *   - 原始错误信息不含 dbPath、运行时类型，难以定位 ABI 冲突 vs 文件权限 vs 路径无效
 *   - 错误信息包含：dbPath / electron 版本 / node 版本 / 原始错误 message
 *   - ErrorCode.STORAGE_ERROR 与其他存储层错误一致，便于 ErrorHandler 统一分类
 *
 * @param dbPath 数据库文件路径
 * @returns 实现 ISqliteDatabase 接口的 better-sqlite3 实例
 * @throws SpriteError(ErrorCode.STORAGE_ERROR) 当动态 import 或实例化失败时
 */
async function createBetterSqliteDb(dbPath: string): Promise<ISqliteDatabase> {
  try {
    // 动态 import：仅在 Electron 运行时执行，避免 Node.js 环境加载 native 模块
    const Database = (await import('better-sqlite3')).default;
    // better-sqlite3 的 Database 天然满足 ISqliteDatabase 接口（结构兼容）
    // 使用类型断言将 Database.Database 映射到 ISqliteDatabase 接口
    return new Database(dbPath) as unknown as ISqliteDatabase;
  } catch (err) {
    // 包裹结构化上下文，区分 ABI 冲突 / 文件权限 / 路径无效等场景
    // - err.code === 'NODE_MODULE_VERSION' 或类似 → ABI 不匹配（Electron electron-rebuild 失败）
    // - err.code === 'EACCES' / 'EPERM' → 文件权限问题
    // - err.code === 'ENOENT' → 父目录不存在
    // - err.message 含 'could not open database' → dbPath 被占用或损坏
    throw new SpriteError(
      ErrorCode.STORAGE_ERROR,
      `better-sqlite3 初始化失败: ${toError(err).message}`,
      {
        cause: err,
        context: {
          dbPath,
          electronVersion: process.versions.electron ?? 'N/A',
          nodeVersion: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          hint: '若为 ABI 冲突（NODE_MODULE_VERSION），请运行 npm run rebuild:electron 重新编译 better-sqlite3',
        },
      },
    );
  }
}

/**
 * 创建向量存储（可选，配置了 embedding 时启用语义召回）
 *
 * 返回 IVectorStore 接口实例（具体实现为 JsonVectorStore），供 Agent 注入启用语义搜索。
 *
 * @param config 应用配置
 * @param dataDir 数据目录路径
 * @returns 向量存储实例，未配置 embedding 时返回 undefined
 */
async function createVectorStoreIfNeeded(
  config: Config,
  dataDir: string,
): Promise<IVectorStore | undefined> {
  if (!config.embedding?.model) return undefined;

  const activeProvider = resolveProviderConfig(config, config.llm.active ?? Object.keys(config.llm.providers ?? {})[0] ?? '')
    ?? resolveProviderConfig(config, 'default');
  const embeddingProvider = new EmbeddingProvider({
    baseUrl: config.embedding.baseUrl ?? activeProvider?.baseUrl ?? '',
    apiKey: config.embedding.apiKey ?? activeProvider?.apiKey ?? '',
    model: config.embedding.model,
  });
  // 内核内置 JsonVectorStore（文件系统 JSON 实现），宿主也可替换为自定义 IVectorStore
  const vectorStore = new JsonVectorStore(
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
  relationStore: SqliteRelationStore;
  vectorStore: IVectorStore | undefined;
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

  // 确保所有必要的目录都存在（包括 config 下的子目录）
  // 会话记录存储在 memora.db 中，不需要独立的 sessions 目录
  const requiredDirs = [
    dataDir,
    workspaceDir,
    configDir,
    // 子目录名来自内核 SOURCE_TO_DIR（单一真理源，T-A1），与 configFileManager 共享同一映射；
    // 三类 key 在映射内必存在（noUncheckedIndexedAccess 下用非空断言）
    resolve(configDir, SOURCE_TO_DIR[SOURCE_LABELS.PERSONA]!),
    resolve(configDir, SOURCE_TO_DIR[SOURCE_LABELS.SKILL]!),
    resolve(configDir, SOURCE_TO_DIR[SOURCE_LABELS.RULE]!),
  ];
  for (const dir of requiredDirs) {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  // 创建存储层（含关系存储侧车）
  // createStorage 是 async 函数（Electron 模式需动态 import better-sqlite3）
  const { storage, sessionStore, relationStore } = await createStorage(dataDir);

  // 创建 LLM Provider
  const provider = createLlmProvider(config);

  // 创建 VectorStore（可选，配置了 embedding 时启用语义召回）
  const vectorStore = await createVectorStoreIfNeeded(config, dataDir);

  // 实例化可观测性 Tracer
  const tracer: ITracer = new SpriteTracer(dataDir);

  // 创建 FetchWebSearchProvider 实例，让 memora 内核管理 web_search 工具
  // 使用 DuckDuckGo 的 HTML 搜索接口（无需 API Key），作为默认网络搜索实现
  const webSearchProvider = new FetchWebSearchProvider();

  // 文件层前置条件断言回调——T5 两段式契约
  // 宿主先完成文件操作（真理源），再同步内核索引；此回调校验文件操作是否已完成
  // 路径解析统一复用 configFileManager.resolveTargetPath，消除 SSOT 违反
  // id 解析统一复用内核 parseConfigId（T-D，消除手工 indexOf 与内核构造逻辑的镜像对齐）
  const fileConsistencyCheck = (id: string, expected: 'exists' | 'absent'): boolean => {
    const parsed = parseConfigId(id);
    // 无法解析的 id 不拦截（向后兼容，非预期格式直接放行）
    if (!parsed) return true;
    const { source: type, name } = parsed;
    // 只处理 rule/skill 类型，其他类型放行
    if (type !== 'rule' && type !== 'skill') return true;
    // 复用 configFileManager 的统一路径解析，获得路径穿越防护
    const filePath = resolveTargetPath(type, name, configDir);
    // 路径穿越时放行（不阻挡正常流程，由 configFileManager 的写路径拦截）
    if (!filePath) return true;
    const fileExists = existsSync(filePath);
    return expected === 'exists' ? fileExists : !fileExists;
  };

  // 实例化 Agent（注入 webSearchProvider 启用内置 web_search 工具）
  const agent = new Agent({
    projectPath,
    configDir,
    dataDir,
    provider,
    storage,
    sessionStore,
    relationStore,
    vectorStore,
    webSearchProvider,
    fileConsistencyCheck,
    messages: ZH_MESSAGES,
    enableContextSummary: true,
    permission: config.security.permission,
    allowedPaths: config.allowedPaths,
    tracer,
  });

  await agent.init();

  return { agent, sessionStore, storage, relationStore, vectorStore, tracer, dataDir, projectPath };
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
    const bgProvider = createProviderFromConfig('background', { ...config.llm.background, baseUrl: config.llm.background.baseUrl ?? '' });
    agent.setBackgroundProvider(bgProvider);
  }

  // 恢复上次会话（连续演化任务的核心体验）
  // 添加 sessionManager null 检查
  if (!agent.sessionManager) {
    logger.warn('SessionManager 未初始化，跳过会话恢复');
  } else {
    const restored = await agent.sessionManager.restoreMostRecentSession('main');
    if (restored > 0) {
      logger.info(`已恢复上次会话（${restored} 条消息）`);
    }
  }

  // 最小作品投影生成 — 启动时读取项目关键文件
  if (agent.works) {
    const keyFiles = ['README.md', 'package.json'];
    for (const filename of keyFiles) {
      try {
        const fullPath = resolve(projectPath, filename);
        if (existsSync(fullPath)) {
          const content = await readFile(fullPath, 'utf-8');
          await agent.works.ensureProjection(fullPath, content, filename);
        }
      } catch (err) {
        logger.warn({ err: toError(err).message, filename }, '作品投影生成失败');
      }
    }
  }

  // 注册宿主自定义工具（memory_search + create_persona/skill/rule）
  // web_search 已由 memora 内核通过 FetchWebSearchProvider 注入管理
  // 显式依赖注入（ADR-SP-019，原 HEAL-8）：通过 createSpriteHandlers 工厂构造
  // 有状态 handler 闭包，消除模块级 agentRef / memorySearcher 全局状态
  if (agent.tools) {
    // memory_search + create_persona/skill/rule 需要完整 deps（agent.config + agent.memory）
    if (agent.config) {
      // memory_search 依赖：封装 agent.memory.search + 字段映射
      const memorySearcher = async (query: string, limit: number) => {
        // 添加 memory null 检查
        if (!agent.memory) return [];
        const hits = await agent.memory.search(query, limit);
        return hits.map((h: AgentSearchHit) => ({
          name: h.name,
          contentPreview: h.contentPreview ?? '',
          score: h.score,
        }));
      };
      // create_persona/skill/rule 依赖：最小 Agent 接口（config + reloadConfig）
      const { memorySearchHandler, createPersonaHandler, createSkillHandler, createRuleHandler } =
        createSpriteHandlers({
          agent: {
            config: agent.config,
            reloadConfig: (source?: string) => agent.reloadConfig(source),
          },
          memorySearcher,
        });

      agent.tools.registerTool(MEMORY_SEARCH_TOOL, memorySearchHandler);
      agent.tools.registerTool(CREATE_PERSONA_TOOL, createPersonaHandler);
      agent.tools.registerTool(CREATE_SKILL_TOOL, createSkillHandler);
      agent.tools.registerTool(CREATE_RULE_TOOL, createRuleHandler);
    }
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
 * @param configDir Agent 级配置目录（传入后启用 personas 目录热重载）
 * @param vectorStore 向量存储（可选）
 * @param config 应用配置
 * @param tracer 可观测性 tracer
 * @param storage 存储实例（用于 close 清理）
 */
function createSpriteAndClose(
  agent: Agent,
  dataDir: string,
  projectPath: string,
  configDir: string,
  vectorStore: IVectorStore | undefined,
  config: Config,
  tracer: ITracer,
  storage: SqliteStorage,
): { sprite: Sprite; close: () => Promise<void> } {
  const sprite = new Sprite({ agent, dataDir, projectPath, configDir, vectorStore, allowedPaths: config.allowedPaths, tracer });
  sprite.start();

  const close = async () => {
    sprite.stop();
    // 每个清理步骤独立 try/catch，确保 storage.close() 必执行
    try {
      await agent.close();
    } catch (err) {
      logger.warn({ err: toError(err).message }, '[close] agent.close() 失败');
    }
    try {
      if (vectorStore) await vectorStore.save();
    } catch (err) {
      logger.warn({ err: toError(err).message }, '[close] vectorStore.save() 失败');
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
  // configDir 传入以启用 personas 目录热重载（用户编辑 .md 后自动 reloadConfig）
  const configDir = opts?.configDir ?? DEFAULT_CONFIG_DIR;
  const { sprite, close } = createSpriteAndClose(agent, dataDir, projectPath, configDir, vectorStore, config, tracer, storage);

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
      // 旧实例清理失败不阻塞重新初始化，但需记录日志辅助排查资源泄漏
      logger.warn({ err: toError(err).message }, '[reinitAgent] 旧实例清理失败');
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
 * 不再内部调用 setupWizard（已移至 CLI）。
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
    const startupProvider = resolveProviderConfig(config, config.llm.active ?? Object.keys(config.llm.providers ?? {})[0] ?? 'default')
      ?? resolveProviderConfig(config, 'default');
    if (!startupProvider?.apiKey) {
      throw new SpriteError(ErrorCode.CONFIG_LOAD_FAILED, 'API Key 未配置');
    }
  } catch (err) {
    throw new SpriteError(
      ErrorCode.CONFIG_LOAD_FAILED,
      `配置不完整，请在设置面板中配置 LLM 提供商和 API Key（${toError(err).message}）`,
      { cause: err },
    );
  }

  // 2. 用配置初始化 Agent + Sprite
  return initAgentFromConfig(config, opts);
}