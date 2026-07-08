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

/**
 * 默认上下文 token 数（120K）
 *
 * 模块级常量，消除 schema default 与 DEFAULT_CONFIG 的重复硬编码。
 * 注意：与 agent/constants.ts 的 AGENT_CONSTANTS.DEFAULT_MAX_CONTEXT_TOKENS 保持一致，
 * 但不跨层引用（config/ 不能反向依赖 agent/，详见 backend_layers_rules.md 依赖方向）。
 * 修改时需同步两处。
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 120_000;

// 单个 Provider 配置 schema（用于 providers 映射表的值）
const ProviderConfigSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  /** 该 Provider 的 temperature，未配置时回退到全局 llm.temperature */
  temperature: z.number().min(0).max(2).optional(),
  /** 该 Provider 的上下文窗口大小（token 数），未配置时回退到 memory.maxContextTokens */
  contextWindow: z.number().optional(),
});

// 配置 schema（运行时校验）
// provider 允许任意字符串：预设（mock/deepseek/doubao/openai）开箱即用，
// 自定义 provider（如 mimo、自部署模型）只要显式配 baseUrl + model 即可
// 详见 ADR-003
//
// 单一真理源：所有默认值由 .default() 声明，ConfigSchema.parse({}) 即可得到完整默认配置。
// 嵌套对象（llm/memory/security）必须用 .default({}) 声明整体默认值，
// 否则 zod 会在对象缺失时报 "Required" 而非使用内部字段的 default。
const ConfigSchema = z.object({
  llm: z
    .object({
      // 旧格式：单一 provider 扁平字段（向后兼容，providers 未配置时生效）
      provider: z.string().default('mock'),
      model: z.string().default('deepseek-chat'),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      temperature: z.number().min(0).max(2).default(0.7),
      /**
       * 多 Provider 映射表
       *
       * key 为 Provider 别名（如 "deepseek"、"openai"），value 为 Provider 配置。
       * 配置后，旧扁平字段（provider/model/baseUrl/apiKey）被忽略。
       * 不配置时回退到旧的单 provider 行为——完全向后兼容。
       */
      providers: z.record(z.string(), ProviderConfigSchema).optional(),
      /**
       * 当前激活的 Provider 别名
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
    })
    .default({}),
  memory: z
    .object({
      dataDir: z.string().default('~/.memora'),
      maxContextTokens: z.number().default(DEFAULT_MAX_CONTEXT_TOKENS),
    })
    .default({}),
  security: z
    .object({
      permission: z.enum(['owner', 'guest']).default('owner'),
      confirmWrites: z.boolean().default(false),
    })
    .default({}),
  // 允许的路径白名单（绝对路径）
  allowedPaths: z.array(z.string()).default([]),
  // 默认角色名（对应 personas/*.md）
  persona: z.string().optional(),
  /**
   * Embedding 配置（可选，配置后启用向量语义召回）
   *
   * 复用 OpenAI 兼容协议的 /embeddings 端点。
   * 不配置时降级为纯关键词召回（当前行为）。
   */
  embedding: z
    .object({
      model: z.string(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * 加载配置
 *
 * 单一真理源：所有默认值由 ConfigSchema 的 .default() 声明，
 * 不再维护独立的 DEFAULT_CONFIG 常量（避免两处真理源打架）。
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
    // 用户级不存在，使用 schema 默认值（单一真理源）
  }

  // 4. 内置默认：ConfigSchema.parse({}) 让 zod 的 .default() 生效
  return expandEnvVars(ConfigSchema.parse({}));
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
 * 直接用 ConfigSchema.parse(userConfig)，让 zod 的 .default() 填充缺失字段。
 * 不再 spread DEFAULT_CONFIG，避免覆盖 schema default。
 */
function mergeWithDefaults(userConfig: unknown): Config {
  return ConfigSchema.parse(userConfig);
}

/**
 * 展开 ${ENV_VAR} 占位符
 * 配置文件可写 "apiKey": "${MEMORA_LLM_API_KEY}"
 * 实际读取时展开为环境变量值
 *
 * 同时展开 providers 映射表中每个 Provider 的 apiKey/baseUrl
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
