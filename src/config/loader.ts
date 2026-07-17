/**
 * 配置加载
 *
 * 优先级（高 → 低）：
 * 1. --config 命令行参数
 * 2. 项目级 .memora/config.json
 * 3. 用户级 ~/.memora/config.json
 * 4. 内置默认值
 *
 * API Key 从环境变量读取（不写入配置文件）
 *
 * 多 Provider 管理（v1.2）：
 *   - providers：命名 Provider 映射表，key 为别名（如 "deepseek"、"openai"）
 *   - active：当前激活的 Provider 别名
 *   - 不配置 providers 时，回退到旧的单 provider 扁平字段（向后兼容）
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/**
 * 默认上下文 token 数（120K）
 *
 * 模块级常量，消除 schema default 与 DEFAULT_CONFIG 的重复硬编码。
 * 注意：与 agent/constants.ts 的 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 保持一致，
 * 但不跨层引用（config/ 不能反向依赖 agent/，详见 backend_layers_rules.md 依赖方向）。
 * 修改时需同步两处。
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 120_000;

// 单个 Provider 配置接口（用于 providers 映射表的值）
interface ProviderConfig {
  /** Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
  /** 该 Provider 的 temperature，未配置时回退到全局 llm.temperature */
  temperature?: number;
  /** 该 Provider 的上下文窗口大小（token 数），未配置时回退到 memory.maxContextTokens */
  contextWindow?: number;
}

/**
 * 后台通道配置接口（多 Provider 路由预留）
 *
 * 不配时所有消费者复用前台（llm）配置——零破坏性，完全向后兼容。
 * 配置后，归档/投影/画像等后台操作使用此通道，降低成本。
 * 详见接入指南 §九
 */
interface BackgroundConfig {
  /** Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
  /** 该通道的 temperature */
  temperature: number;
}

/**
 * LLM 配置接口
 *
 * provider 允许任意字符串：预设（mock/deepseek/doubao/openai）开箱即用，
 * 自定义 provider（如 mimo、自部署模型）只要显式配 baseUrl + model 即可
 * 详见 ADR-003
 */
interface LlmConfig {
  // 旧格式：单一 provider 扁平字段（向后兼容，providers 未配置时生效）
  /** Provider 名称 */
  provider: string;
  /** 模型名称 */
  model: string;
  /** API 基础 URL（可选） */
  baseUrl?: string;
  /** API 密钥（可选，从环境变量读取） */
  apiKey?: string;
  /** 采样温度（0-2） */
  temperature: number;
  /**
   * 多 Provider 映射表
   *
   * key 为 Provider 别名（如 "deepseek"、"openai"），value 为 Provider 配置。
   * 配置后，旧扁平字段（provider/model/baseUrl/apiKey）被忽略。
   * 不配置时回退到旧的单 provider 行为——完全向后兼容。
   */
  providers?: Record<string, ProviderConfig>;
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
   * 不配时所有消费者复用前台（llm）配置——零破坏性，完全向后兼容。
   * 配置后，归档/投影/画像等后台操作使用此通道，降低成本。
   * 详见接入指南 §九
   */
  background?: BackgroundConfig;
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
  /** 默认角色名（对应 personas/*.md） */
  persona?: string;
  /** Embedding 配置（可选） */
  embedding?: EmbeddingConfig;
}

// 单一真理源：所有默认值由 DEFAULT_CONFIG 声明，parseConfig({}) 即可得到完整默认配置。
// 嵌套对象（llm/memory/security）必须有完整默认值，
// 否则会在对象缺失时使用内部字段的默认值。
const DEFAULT_CONFIG: Config = {
  llm: {
    provider: 'mock',
    model: 'deepseek-chat',
    temperature: 0.7,
  },
  memory: {
    dataDir: '~/.memora',
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
function parseConfig(raw: unknown): Config {
  // 如果 raw 不是对象，使用空对象
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};

  // 解析 llm 配置
  const llmInput = (input.llm && typeof input.llm === 'object' && !Array.isArray(input.llm))
    ? input.llm as Record<string, unknown>
    : {};

  const llm: LlmConfig = {
    provider: typeof llmInput.provider === 'string' ? llmInput.provider : DEFAULT_CONFIG.llm.provider,
    model: typeof llmInput.model === 'string' ? llmInput.model : DEFAULT_CONFIG.llm.model,
    baseUrl: typeof llmInput.baseUrl === 'string' ? llmInput.baseUrl : undefined,
    apiKey: typeof llmInput.apiKey === 'string' ? llmInput.apiKey : undefined,
    temperature: validateTemperature(llmInput.temperature, DEFAULT_CONFIG.llm.temperature),
    providers: parseProviders(llmInput.providers),
    active: typeof llmInput.active === 'string' ? llmInput.active : undefined,
    background: parseBackground(llmInput.background),
  };

  // 解析 memory 配置
  const memoryInput = (input.memory && typeof input.memory === 'object' && !Array.isArray(input.memory))
    ? input.memory as Record<string, unknown>
    : {};

  const memory: MemoryConfig = {
    dataDir: typeof memoryInput.dataDir === 'string' ? memoryInput.dataDir : DEFAULT_CONFIG.memory.dataDir,
    maxContextTokens: typeof memoryInput.maxContextTokens === 'number' ? memoryInput.maxContextTokens : DEFAULT_CONFIG.memory.maxContextTokens,
  };

  // 解析 security 配置
  const securityInput = (input.security && typeof input.security === 'object' && !Array.isArray(input.security))
    ? input.security as Record<string, unknown>
    : {};

  const security: SecurityConfig = {
    permission: validatePermission(securityInput.permission),
    confirmWrites: typeof securityInput.confirmWrites === 'boolean' ? securityInput.confirmWrites : DEFAULT_CONFIG.security.confirmWrites,
  };

  // 解析 allowedPaths
  const allowedPaths = validateAllowedPaths(input.allowedPaths);

  // 解析 persona
  const persona = typeof input.persona === 'string' ? input.persona : undefined;

  // 解析 embedding 配置
  const embedding = parseEmbedding(input.embedding);

  return {
    llm,
    memory,
    security,
    allowedPaths,
    persona,
    embedding,
  };
}

/**
 * 验证 temperature 值
 *
 * @param value 待验证的值
 * @param defaultValue 默认值
 * @returns 有效的 temperature 值
 * @throws 当值超出范围时抛出错误
 */
function validateTemperature(value: unknown, defaultValue: number): number {
  if (typeof value === 'number') {
    if (value < 0 || value > 2) {
      throw new Error(`temperature 必须在 0-2 之间，当前值: ${value}`);
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
 * @throws 当值无效时抛出错误
 */
function validatePermission(value: unknown): 'owner' | 'guest' {
  if (value === undefined || value === null) {
    return DEFAULT_CONFIG.security.permission;
  }
  if (value === 'owner' || value === 'guest') {
    return value;
  }
  throw new Error(`security.permission 必须为 "owner" 或 "guest"，收到: ${JSON.stringify(value)}`);
}

/**
 * 验证 allowedPaths 数组
 *
 * @param value 待验证的值
 * @returns 有效的路径数组
 * @throws 当数组元素类型不匹配时抛出错误
 */
function validateAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CONFIG.allowedPaths;
  }

  // 验证每个元素都是字符串
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new Error(`allowedPaths[${i}] 必须是字符串，当前类型: ${typeof value[i]}`);
    }
  }

  return value as string[];
}

/**
 * 解析 Provider 配置映射表
 *
 * @param value 待解析的值
 * @returns 有效的 Provider 配置映射表或 undefined
 * @throws 当 Provider 配置无效时抛出错误
 */
function parseProviders(value: unknown): Record<string, ProviderConfig> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const providers: Record<string, ProviderConfig> = {};
  const entries = Object.entries(value as Record<string, unknown>);

  for (const [key, providerValue] of entries) {
    if (!providerValue || typeof providerValue !== 'object' || Array.isArray(providerValue)) {
      throw new Error(`providers.${key} 必须是对象`);
    }

    const p = providerValue as Record<string, unknown>;

    // 验证必需字段
    if (typeof p.provider !== 'string') {
      throw new Error(`providers.${key}.provider 必须是字符串`);
    }
    if (typeof p.model !== 'string') {
      throw new Error(`providers.${key}.model 必须是字符串`);
    }

    providers[key] = {
      provider: p.provider,
      model: p.model,
      baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : undefined,
      apiKey: typeof p.apiKey === 'string' ? p.apiKey : undefined,
      temperature: p.temperature !== undefined ? validateTemperature(p.temperature, 0) : undefined,
      contextWindow: typeof p.contextWindow === 'number' ? p.contextWindow : undefined,
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * 解析后台通道配置
 *
 * @param value 待解析的值
 * @returns 有效的后台通道配置或 undefined
 * @throws 当配置无效时抛出错误
 */
function parseBackground(value: unknown): BackgroundConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const bg = value as Record<string, unknown>;

  // 验证必需字段
  if (typeof bg.provider !== 'string') {
    throw new Error('background.provider 必须是字符串');
  }
  if (typeof bg.model !== 'string') {
    throw new Error('background.model 必须是字符串');
  }

  return {
    provider: bg.provider,
    model: bg.model,
    baseUrl: typeof bg.baseUrl === 'string' ? bg.baseUrl : undefined,
    apiKey: typeof bg.apiKey === 'string' ? bg.apiKey : undefined,
    temperature: bg.temperature !== undefined ? validateTemperature(bg.temperature, 0.5) : 0.5,
  };
}

/**
 * 解析 Embedding 配置
 *
 * @param value 待解析的值
 * @returns 有效的 Embedding 配置或 undefined
 * @throws 当配置无效时抛出错误
 */
function parseEmbedding(value: unknown): EmbeddingConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const emb = value as Record<string, unknown>;

  // 验证必需字段
  if (typeof emb.model !== 'string') {
    throw new Error('embedding.model 必须是字符串');
  }

  return {
    model: emb.model,
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
  } catch {
    // 项目级不存在，继续尝试用户级
  }

  // 3. 用户级
  const userPath = resolve(homedir(), '.memora/config.json');
  try {
    const config = await readJsonFile(userPath);
    return expandEnvVars(mergeWithDefaults(config));
  } catch {
    // 用户级不存在，使用默认值（单一真理源）
  }

  // 4. 内置默认：parseConfig({}) 让默认值生效
  return expandEnvVars(parseConfig({}));
}

/**
 * 读取并解析 JSON 文件
 */
async function readJsonFile(path: string): Promise<unknown> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
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

/**
 * 展开 ${ENV_VAR} 占位符
 * 配置文件可写 "apiKey": "${MEMORA_LLM_API_KEY}"
 * 实际读取时展开为环境变量值
 *
 * 展开范围覆盖所有可能包含敏感信息的通道：
 *   - llm（前台主通道）：apiKey / baseUrl
 *   - llm.providers（多 Provider 映射表）：每个 Provider 的 apiKey / baseUrl
 *   - llm.background（后台通道）：apiKey / baseUrl
 *   - embedding（向量嵌入通道）：apiKey / baseUrl
 */
function expandEnvVars(config: Config): Config {
  const expand = (val: string | undefined): string | undefined => {
    if (!val) return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  };

  // 展开 providers 映射表中的环境变量
  const expandedProviders: Record<string, ProviderConfig> | undefined = config.llm.providers
    ? Object.fromEntries(
        Object.entries(config.llm.providers).map(([key, p]) => [
          key,
          { ...p, apiKey: expand(p.apiKey), baseUrl: expand(p.baseUrl) },
        ]),
      )
    : undefined;

  // 展开 background 后台通道的环境变量（与前台 llm 通道同模式）
  const expandedBackground = config.llm.background
    ? {
        ...config.llm.background,
        apiKey: expand(config.llm.background.apiKey),
        baseUrl: expand(config.llm.background.baseUrl),
      }
    : undefined;

  // 展开 embedding 向量嵌入通道的环境变量
  const expandedEmbedding = config.embedding
    ? {
        ...config.embedding,
        apiKey: expand(config.embedding.apiKey),
        baseUrl: expand(config.embedding.baseUrl),
      }
    : undefined;

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: expand(config.llm.apiKey),
      baseUrl: expand(config.llm.baseUrl),
      providers: expandedProviders,
      background: expandedBackground,
    },
    embedding: expandedEmbedding,
  };
}