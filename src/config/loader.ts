/**
 * 配置加载
 *
 * 查找顺序（高 → 低）：
 * 1. 显式 configPath（由宿主传入，如用户级配置路径）
 * 2. 项目级 .memora/config.json
 * 3. 内置默认值（仅提供机制，不预设厂商/路径策略——ADR-002 + ADR-003）
 *
 * API Key 从环境变量读取（不写入配置文件）
 *
 * 多 Provider 管理（唯一配置格式）：
 *   - providers：命名 Provider 映射表，key 为别名（如 "deepseek"、"openai"）
 *   - active：当前激活的 Provider 别名
 *   - taskRouter：任务类型到 Provider 别名的路由映射（P1-2 多模型路由基础）
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configError } from '@/utils/errors.js';
import { toError } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import type { ProviderEntryConfig, BackgroundConfig } from '@/llm/types.js';
import { expandEnvVars } from '@/config/expandEnvVars.js';

/**
 * 默认上下文 token 数（120K）
 *
 * 模块级常量，消除 schema default 与 DEFAULT_CONFIG 的重复硬编码。
 * 注意：与 agent/constants.ts 的 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 保持一致，
 * 但不跨层引用（config/ 不能反向依赖 agent/，详见 backend_layers_rules.md 依赖方向）。
 * 修改时需同步两处。
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 120_000;

/**
 * LLM 配置接口
 *
 * 多 Provider 映射表（providers + active）是唯一配置格式。
 * 内核仅内置 'mock' 一种机制（用于无 API Key 的测试/降级），
 * 其他厂商 provider（deepseek/openai/doubao 等）需宿主或用户显式配置 baseUrl + model。
 * 详见 ADR-003（内核只提供机制，不预设厂商策略）
 */
interface LlmConfig {
  /**
   * 多 Provider 映射表
   *
   * key 为 Provider 别名（如 "deepseek"、"openai"），value 为 Provider 配置。
   */
  providers?: Record<string, ProviderEntryConfig>;
  /**
   * 当前激活的 Provider 别名
   *
   * 必须与 providers 中的某个 key 一致。
   * 不配置时默认使用 providers 的第一个 key。
   */
  active?: string;
  /**
   * 后台通道配置（多 Provider 路由预留）
   *
   * 不配时所有消费者复用前台（llm）配置——零破坏性。
   * 配置后，归档/投影等后台操作使用此通道，降低成本。
   * 详见接入指南 §九
   */
  background?: BackgroundConfig;
  /**
   * 任务类型到 Provider 的路由映射（P1-2 多模型路由基础）
   *
   * 示例：
   * ```yaml
   * llm:
   *   providers:
   *     fast: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: '...', apiKey: '...' }
   *     smart: { provider: 'openai', model: 'gpt-4o', baseUrl: '...', apiKey: '...' }
   *   taskRouter:
   *     simple: fast
   *     reasoning: smart
   *     code: smart
   *     summary: fast
   * ```
   *
   * key 为任务类型，value 为 providers 映射表中的别名。
   * 不配置时所有任务使用 active Provider。
   */
  taskRouter?: Partial<Record<'simple' | 'reasoning' | 'code' | 'summary', string>>;
}

/** 内存配置接口 */
interface MemoryConfig {
  /** 数据存储目录 */
  dataDir: string;
  /** 最大上下文 token 数 */
  maxContextTokens: number;
}

/** 安全配置接口 */
interface SecurityConfig {
  /** 权限级别：owner（所有者）或 guest（访客） */
  permission: 'owner' | 'guest';
  /** 是否确认写入操作 */
  confirmWrites: boolean;
}

/**
 * Embedding 配置接口（可选，配置后启用向量语义召回）
 *
 * 复用 OpenAI 兼容协议的 /embeddings 端点。
 * 不配置时降级为纯关键词召回（当前行为）。
 */
interface EmbeddingConfig {
  /** Embedding 模型名称 */
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
}

/** 完整配置接口 */
export interface Config {
  /** LLM 配置 */
  llm: LlmConfig;
  /** 内存配置 */
  memory: MemoryConfig;
  /** 安全配置 */
  security: SecurityConfig;
  /** 允许的路径白名单（绝对路径） */
  allowedPaths: string[];
  /** 默认角色包名 */
  rolePack?: string;
  /** Embedding 配置（可选） */
  embedding?: EmbeddingConfig;
}

// 单一真理源：所有默认值由 DEFAULT_CONFIG 声明，parseConfig({}) 即可得到完整默认配置。
// 嵌套对象（llm/memory/security）必须有完整默认值，
// 否则会在对象缺失时使用内部字段的默认值。
const DEFAULT_CONFIG: Config = {
  llm: {
    // 无默认 provider（mock 由 factory 在显式配置 provider: 'mock' 时创建）
    providers: undefined,
    active: undefined,
  },
  memory: {
    // dataDir 留空：由宿主显式注入，内核不硬编码具体目录路径（ADR-002 v0.6）
    dataDir: '',
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  },
  security: {
    permission: 'owner',
    confirmWrites: false,
  },
  allowedPaths: [],
};

/**
 * 解析并验证配置
 *
 * 将原始 JSON 解析结果转换为完整的 Config 对象，
 * 验证类型并应用默认值。
 *
 * @param raw 原始 JSON 解析结果（unknown 类型）
 * @returns 完整的 Config 对象
 * @throws 当类型不匹配时抛出错误
 */
export function parseConfig(raw: unknown): Config {
  // 如果 raw 不是对象，使用空对象（MIND-C2：守卫+断言合一为 asRecordIfObject）
  const input = asRecordIfObject(raw);

  // 解析 llm 配置
  const llmInput = asRecordIfObject(input.llm);

  const llm: LlmConfig = {
    providers: parseProviders(llmInput.providers),
    active: typeof llmInput.active === 'string' ? llmInput.active : undefined,
    background: parseBackground(llmInput.background),
    taskRouter: parseTaskRouter(llmInput.taskRouter),
  };

  // 解析 memory 配置
  const memoryInput = asRecordIfObject(input.memory);

  const memory: MemoryConfig = {
    dataDir: typeof memoryInput.dataDir === 'string' ? memoryInput.dataDir : DEFAULT_CONFIG.memory.dataDir,
    maxContextTokens: (typeof memoryInput.maxContextTokens === 'number' && Number.isFinite(memoryInput.maxContextTokens))
      ? memoryInput.maxContextTokens
      : DEFAULT_CONFIG.memory.maxContextTokens,
  };

  // 解析 security 配置
  const securityInput = asRecordIfObject(input.security);

  const security: SecurityConfig = {
    permission: validatePermission(securityInput.permission),
    confirmWrites: typeof securityInput.confirmWrites === 'boolean' ? securityInput.confirmWrites : DEFAULT_CONFIG.security.confirmWrites,
  };

  // 解析 allowedPaths
  const allowedPaths = validateAllowedPaths(input.allowedPaths);

  // 解析默认角色包
  const rolePack = typeof input.rolePack === 'string' ? input.rolePack : undefined;

  // 解析 embedding 配置
  const embedding = parseEmbedding(input.embedding);

  return {
    llm,
    memory,
    security,
    allowedPaths,
    rolePack,
    embedding,
  };
}

/**
 * 类型守卫辅助：非空对象 → Record，否则 → 空对象
 *
 * 收紧 MIND-C2 的 8 处 `as Record<string, unknown>` 隐式断言：
 * 守卫与断言合一，避免守卫变更时编译器不报警的类型安全风险。
 *
 * @param value 待收窄的值
 * @returns 非空对象返回 value as Record；否则返回空对象 {}
 */
function asRecordIfObject(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

/**
 * 断言值为字符串，否则抛出 configError
 *
 * 消除 loader.ts 中重复的"typeof x !== 'string' → throw"模式（ADR-017 枝叶层 2 次提取原则，6 处重复）。
 *
 * @param value 待校验的值
 * @param field 字段名（用于错误信息，如 "providers.openai.model"）
 * @returns 类型收窄后的字符串
 * @throws MemoraError（category: 'config'）当值不是字符串时
 */
function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw configError(
      `配置项 ${field} 必须是字符串`,
      `当前类型: ${typeof value}，当前值: ${JSON.stringify(value)}`,
      [
        `检查配置文件中 ${field} 字段是否被引号包裹`,
        '参考 README 或 default-config.json 中的字段类型约定',
      ],
    );
  }
  return value;
}

/**
 * 验证 temperature 值
 *
 * @param value 待验证的值
 * @param defaultValue 默认值
 * @returns 有效的 temperature 值
 * @throws MemoraError 当值超出范围时抛出
 */
function validateTemperature(value: unknown, defaultValue: number): number {
  // Number.isFinite 同时排除 NaN/Infinity（对齐 zod z.number() 行为）
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0 || value > 2) {
      throw configError(
        'temperature 配置项超出范围',
        `当前值: ${value}（合法范围 0-2）`,
        ['将 temperature 调整为 0-2 之间的数字'],
      );
    }
    return value;
  }
  return defaultValue;
}

/**
 * 验证 permission 值
 *
 * @param value 待验证的值
 * @returns 有效的 permission 值
 * @throws MemoraError 当值无效时抛出
 */
function validatePermission(value: unknown): 'owner' | 'guest' {
  if (value === undefined || value === null) {
    return DEFAULT_CONFIG.security.permission;
  }
  if (value === 'owner' || value === 'guest') {
    return value;
  }
  throw configError(
    'security.permission 配置项无效',
    `当前值: ${JSON.stringify(value)}（仅允许 "owner" 或 "guest"）`,
    ['将 security.permission 修改为 "owner" 或 "guest"'],
  );
}

/**
 * 验证 allowedPaths 数组
 *
 * @param value 待验证的值
 * @returns 有效的路径数组
 * @throws MemoraError 当数组元素类型不匹配时抛出
 */
function validateAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CONFIG.allowedPaths;
  }

  // 验证每个元素都是字符串（断言失败抛 configError）
  for (let i = 0; i < value.length; i++) {
    assertString(value[i], `allowedPaths[${i}]`);
  }

  return value as string[];
}

/**
 * 解析 Provider 配置映射表
 *
 * @param value 待解析的值
 * @returns 有效的 Provider 配置映射表或 undefined
 * @throws MemoraError 当 Provider 配置无效时抛出
 */
function parseProviders(value: unknown): Record<string, ProviderEntryConfig> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const providers: Record<string, ProviderEntryConfig> = {};
  const entries = Object.entries(value as Record<string, unknown>);

  for (const [key, providerValue] of entries) {
    if (!providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) {
      throw configError(
        `配置项 providers.${key} 必须是对象`,
        `当前类型: ${providerValue === null ? 'null' : Array.isArray(providerValue) ? 'array' : typeof providerValue}`,
        [`将 providers.${key} 配置为包含 provider/model 等字段的对象`],
      );
    }

    const p = providerValue as Record<string, unknown>;

    // 验证必需字段（断言失败抛 configError，返回值类型收窄为 string）
    const providerName = assertString(p.provider, `providers.${key}.provider`);
    const modelName = assertString(p.model, `providers.${key}.model`);

    providers[key] = {
      provider: providerName,
      model: modelName,
      // 过滤空字符串：与 parseConfig 顶层逻辑保持一致
      baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : undefined,
      apiKey: typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : undefined,
      temperature: p.temperature !== undefined ? validateTemperature(p.temperature, 0) : undefined,
      contextWindow: (typeof p.contextWindow === 'number' && Number.isFinite(p.contextWindow)) ? p.contextWindow : undefined,
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * 解析后台通道配置
 *
 * @param value 待解析的值
 * @returns 有效的后台通道配置或 undefined
 * @throws MemoraError 当配置无效时抛出
 */
function parseBackground(value: unknown): BackgroundConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const bg = value as Record<string, unknown>;

  // 验证必需字段（断言失败抛 configError，返回值类型收窄为 string）
  const bgProvider = assertString(bg.provider, 'background.provider');
  const bgModel = assertString(bg.model, 'background.model');

  return {
    provider: bgProvider,
    model: bgModel,
    baseUrl: typeof bg.baseUrl === 'string' ? bg.baseUrl : undefined,
    apiKey: typeof bg.apiKey === 'string' ? bg.apiKey : undefined,
    temperature: bg.temperature !== undefined ? validateTemperature(bg.temperature, 0.5) : 0.5,
  };
}

/**
 * 解析 taskRouter 配置（P1-2 多模型路由基础）
 *
 * 验证任务类型映射表中的 key 和 value 均为字符串。
 * 不配置时返回 undefined（向后兼容，所有任务使用 active Provider）。
 *
 * @param value 待解析的值
 * @returns 有效的 taskRouter 映射或 undefined
 */
function parseTaskRouter(value: unknown): Partial<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const router: Record<string, string> = {};
  for (const [taskType, providerName] of Object.entries(value as Record<string, unknown>)) {
    // 验证任务类型（key）为字符串且非空
    if (typeof taskType !== 'string' || !taskType) continue;
    // 验证 provider 别名（value）为字符串且非空
    if (typeof providerName !== 'string' || !providerName) continue;
    router[taskType] = providerName;
  }

  return Object.keys(router).length > 0 ? router : undefined;
}

/**
 * 解析 Embedding 配置
 *
 * @param value 待解析的值
 * @returns 有效的 Embedding 配置或 undefined
 * @throws MemoraError 当配置无效时抛出
 */
function parseEmbedding(value: unknown): EmbeddingConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const emb = value as Record<string, unknown>;

  // 验证必需字段（断言失败抛 configError，返回值类型收窄为 string）
  const embModel = assertString(emb.model, 'embedding.model');

  return {
    model: embModel,
    baseUrl: typeof emb.baseUrl === 'string' ? emb.baseUrl : undefined,
    apiKey: typeof emb.apiKey === 'string' ? emb.apiKey : undefined,
  };
}

/**
 * 加载配置
 *
 * 单一真理源：所有默认值由 DEFAULT_CONFIG 声明，
 * 不再维护独立的 schema（避免两处真理源打架）。
 *
 * 查找顺序：显式 configPath → 项目级 .memora/config.json → 内置默认值。
 * 用户级配置路径由宿主通过 configPath 显式传入。
 *
 * @param configPath 显式指定的配置文件路径
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // 1. 显式指定
  if (configPath) {
    const config = await readJsonFile(configPath);
    return expandEnvVars(mergeWithDefaults(config));
  }

  // 2. 项目级
  const projectPath = resolve(process.cwd(), '.memora/config.json');
  try {
    const config = await readJsonFile(projectPath);
    return expandEnvVars(mergeWithDefaults(config));
  } catch (err) {
    // 项目级不可用（不存在/损坏/权限），使用内置默认值
    // 排除 ENOENT（正常情况），其他错误应暴露根因供诊断
    if (!isEnoent(err)) {
      logger.warn({ path: projectPath, err: toError(err) }, '项目级配置加载失败，使用默认值');
    }
  }

  // 3. 内置默认：parseConfig({}) 让默认值生效
  return expandEnvVars(parseConfig({}));
}

/**
 * 读取并解析 JSON 文件
 *
 * 将 JSON.parse 的 SyntaxError 包装为 configError，
 * 防止裸 Error 通过显式 --config 路径传播。
 */
async function readJsonFile(path: string): Promise<unknown> {
  const content = await readFile(path, 'utf-8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw configError(
      `配置文件 JSON 格式错误: ${path}`,
      toError(err).message,
      ['检查配置文件语法（逗号、引号配对、尾随逗号）'],
    );
  }
}

/**
 * 判断错误是否为 ENOENT（文件不存在）
 */
function isEnoent(err: unknown): boolean {
  return err instanceof Object && 'code' in err && (err as Record<string, unknown>).code === 'ENOENT';
}

/**
 * 合并用户配置与默认值
 *
 * 直接用 parseConfig(userConfig)，让默认值填充缺失字段。
 * 不再 spread DEFAULT_CONFIG，避免覆盖 schema default。
 */
function mergeWithDefaults(userConfig: unknown): Config {
  return parseConfig(userConfig);
}

