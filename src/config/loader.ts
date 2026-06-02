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
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

// 配置 schema（运行时校验）
const ConfigSchema = z.object({
  llm: z.object({
    provider: z.enum(['deepseek', 'doubao', 'openai', 'mock']).default('mock'),
    model: z.string().default('deepseek-chat'),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    temperature: z.number().min(0).max(2).default(0.7),
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
 */
function expandEnvVars(config: Config): Config {
  const expand = (val: string | undefined): string | undefined => {
    if (!val) return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => process.env[name] ?? '');
  };

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: expand(config.llm.apiKey),
      baseUrl: expand(config.llm.baseUrl),
    },
  };
}
