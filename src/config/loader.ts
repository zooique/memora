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
import { z } from 'zod';

// 单个 Provider 配置 schema（用于 providers 映射表的值）
const ProviderConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

// 配置 schema（运行时校验）
// provider 允许任意字符串：预设（mock/deepseek/doubao/openai）开箱即用，
// 自定义 provider（如 mimo、自部署模型）只要显式配 baseUrl + model 即可
// 详见 ADR-003
const ConfigSchema = z.object({
  llm: z.object({
    // 旧格式：单一 provider 扁平字段（向后兼容，providers 未配置时生效）
    provider: z.string().default('mock'),
    model: z.string().default('deepseek-chat'),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    temperature: z.number().min(0).max(2).default(0.7),
    /**
     * 多 Provider 映射表（v1.2）
     *
     * key 为 Provider 别名（如 "deepseek"、"openai"），value 为 Provider 配置。
     * 配置后，旧扁平字段（provider/model/baseUrl/apiKey）被忽略。
     * 不配置时回退到旧的单 provider 行为——完全向后兼容。
     */
    providers: z.record(z.string(), ProviderConfigSchema).optional(),
    /**
     * 当前激活的 Provider 别名（v1.2）
     *
     * 必须与 providers 中的某个 key 一致。
     * 不配置时默认使用 providers 的第一个 key。
     */
    active: z.string().optional(),
    /**
     * 后台通道配置（多 Provider 路由预留）
     *
     * 不配时所有消费者复用前台（llm）配置——零破坏性，完全向后兼容。
     * 配置后，归档/投影/画像等后台操作使用此通道，降低成本。
     * 详见接入指南 §九
     */
    background: z
      .object({
        provider: z.string(),
        model: z.string(),
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        temperature: z.number().min(0).max(2).default(0.5),
      })
      .optional(),
  }),
  memory: z.object({
    dataDir: z.string().default('~/.memora'),
    maxContextTokens: z.number().default(120000),
  }),
  security: z.object({
    permission: z.enum(['owner', 'guest']).default('owner'),
    confirmWrites: z.boolean().default(false),
  }),
  // 允许的路径白名单（绝对路径）
  allowedPaths: z.array(z.string()).default([]),
  // v4.0：默认角色名（对应 personas/*.md）
  persona: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG: Config = {
  llm: {
    provider: 'mock',
    model: 'mock-model',
    temperature: 0.7,
  },
  memory: {
    dataDir: '~/.memora',
    maxContextTokens: 120000,
  },
  security: {
    permission: 'owner',
    confirmWrites: false,
  },
  allowedPaths: [],
  persona: undefined,
};

/**
 * 加载配置
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
    // 用户级不存在，使用默认值
  }

  // 4. 内置默认
  return expandEnvVars(DEFAULT_CONFIG);
}

/**
 * 找到实际加载的配置文件路径
 * 按优先级查找，文件不存在返回 null
 */
export async function findConfigPath(configPath?: string): Promise<string | null> {
  // 1. 显式指定
  if (configPath) {
    return configPath;
  }

  // 2. 项目级
  const projectPath = resolve(process.cwd(), '.memora/config.json');
  try {
    const { stat } = await import('node:fs/promises');
    await stat(projectPath);
    return projectPath;
  } catch {
    // 不存在
  }

  // 3. 用户级
  const userPath = resolve(homedir(), '.memora/config.json');
  try {
    const { stat } = await import('node:fs/promises');
    await stat(userPath);
    return userPath;
  } catch {
    return null;
  }
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
 */
function mergeWithDefaults(userConfig: unknown): Config {
  return ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    ...(userConfig as object),
  });
}

/**
 * 展开 ${ENV_VAR} 占位符
 * 配置文件可写 "apiKey": "${MEMORA_LLM_API_KEY}"
 * 实际读取时展开为环境变量值
 *
 * v1.2：同时展开 providers 映射表中每个 Provider 的 apiKey/baseUrl
 */
function expandEnvVars(config: Config): Config {
  const expand = (val: string | undefined): string | undefined => {
    if (!val) return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  };

  // 展开 providers 映射表中的环境变量
  const expandedProviders: Record<string, z.infer<typeof ProviderConfigSchema>> | undefined = config
    .llm.providers
    ? Object.fromEntries(
        Object.entries(config.llm.providers).map(([key, p]) => [
          key,
          { ...p, apiKey: expand(p.apiKey), baseUrl: expand(p.baseUrl) },
        ]),
      )
    : undefined;

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: expand(config.llm.apiKey),
      baseUrl: expand(config.llm.baseUrl),
      providers: expandedProviders,
    },
  };
}
