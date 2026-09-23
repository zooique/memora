/**
 * 配置加载
 *
 * 查找顺序：显式 configPath → 项目级 .memora/config.json → 内置默认值。
 * 内核只提供机制，不预设厂商/路径策略；API Key 从环境变量读取，不写文件。
 * 多 Provider（唯一格式）：providers 映射表 + active 激活别名。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { configError } from '@/utils/errors.js';
import { toError, isNodeErrorCode } from '@/utils/toError.js';
import { logger } from '@/logging/logger.js';
import type { ProviderEntryConfig } from '@/llm/types.js';
import { expandEnvVars } from '@/config/expandEnvVars.js';

/**
 * 默认上下文 token 数（120K）。与 agent/constants.ts 的 DEFAULT_MAX_CONTEXT_TOKENS 保持一致，
 * 但不跨层引用（config/ 不能反向依赖 agent/），修改需同步两处。
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 120_000;

// ════════════════════════════════════════════════════════════
// 配置边界常量（SSOT：config 层唯一来源，防无条件填写导致资源失控）
// ════════════════════════════════════════════════════════════

/** maxContextTokens 下限：低于此无法承载最小上下文装配 */
const MIN_MAX_CONTEXT_TOKENS = 1000;
/** maxContextTokens 上限：2_000_000 覆盖 2M 上下文窗口（与 MAX_CONTEXT_WINDOW 同量级，对齐 Gemini/MiMo 等旗舰模型） */
const MAX_MAX_CONTEXT_TOKENS = 2_000_000;
/**
 * contextWindow 的**告警参考上界**：2M（当前主流旗舰模型窗口量级）。
 *
 * ⚠️ **这不是裁决上界**：内核**不做区间裁决** —— 超出此值仅 `logger.warn`（观测），
 * 值仍**原样生效**。理由：「模型能吃多大」是只有 provider/API 知道的事实，内核替用户猜会造成
 * 「UI 显示值 ≠ 真实生效值」的静默失真（坑：填 3M → 静默丢弃 → 兜底 120K，全程无提示）；
 * 预算口径定：用户配置的 contextWindow 是预算唯一来源。超模型能力时由 **API 报错**（真实层可见失败）。
 * 若将来必须恢复拦截，**只允许显式报错，不得回到静默**。
 *
 * ⚠️ 与 `src/role-pack/strategyKeys.ts` 的 `MAX_CONTEXT_LIMIT`（角色包 contextLimit 声明上界）**同值对齐，改一处须同步另一处**；
 * 两者语义不同（provider 声明的告警参考 vs 角色包声明上界），故按本仓对 `DEFAULT_MAX_CONTEXT_TOKENS` 的既有做法
 * 「重复 + 双向注释对冲」处理，**不跨层 import**（config 层不依赖 role-pack）。
 * 导出仅供跨模块护栏测试断言同值（constants.test.ts），非 API 承诺。
 */
export const MAX_CONTEXT_WINDOW = 2_000_000;
/** allowedPaths 最大条数：路径白名单防膨胀 */
const MAX_ALLOWED_PATHS = 50;

/**
 * LLM 配置接口。providers + active 是唯一格式；内核仅内置 'mock'（无 API Key 的测试/降级），
 * 其他厂商 provider 需宿主或用户显式配置 baseUrl + model。
 */
interface LlmConfig {
  /** 多 Provider 映射表：key 为别名（"deepseek"、"openai"），value 为配置 */
  providers?: Record<string, ProviderEntryConfig>;
  /** 激活的 Provider 别名，必须与 providers 某 key 一致；不配时取第一个 key */
  active?: string;
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
}

// 单一真理源：所有默认值只由 DEFAULT_CONFIG 声明，parseConfig({}) 即得完整默认配置。
// 嵌套对象（llm/memory/security）必须有完整默认值，否则对象缺失时无法落到内部字段默认值。
const DEFAULT_CONFIG: Config = {
  llm: {
    // 无默认 provider：mock 由 factory 在显式配置 provider: 'mock' 时创建
    providers: undefined,
    active: undefined,
  },
  memory: {
    // dataDir 由宿主显式注入，内核不硬编码具体目录路径
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
 * 解析并验证配置：将原始 JSON 转为完整 Config，验证类型并应用默认值
 *
 * @throws 当类型不匹配时抛出错误
 */
export function parseConfig(raw: unknown): Config {
  // 若 raw 非对象则视为空对象（守卫+断言合一）
  const input = asRecordIfObject(raw);

  const llmInput = asRecordIfObject(input.llm);

  const llm: LlmConfig = {
    providers: parseProviders(llmInput.providers),
    active: typeof llmInput.active === 'string' ? llmInput.active : undefined,
  };

  const memoryInput = asRecordIfObject(input.memory);

  const memory: MemoryConfig = {
    dataDir: typeof memoryInput.dataDir === 'string' ? memoryInput.dataDir : DEFAULT_CONFIG.memory.dataDir,
    maxContextTokens: validateMaxContextTokens(
      memoryInput.maxContextTokens,
      DEFAULT_CONFIG.memory.maxContextTokens,
    ),
  };

  const securityInput = asRecordIfObject(input.security);

  const security: SecurityConfig = {
    permission: validatePermission(securityInput.permission),
    confirmWrites: typeof securityInput.confirmWrites === 'boolean' ? securityInput.confirmWrites : DEFAULT_CONFIG.security.confirmWrites,
  };

  const allowedPaths = validateAllowedPaths(input.allowedPaths);

  return {
    llm,
    memory,
    security,
    allowedPaths,
  };
}

/**
 * 类型守卫辅助：非空对象 → Record，否则 → 空对象。
 * 守卫与断言合一，避免守卫变更时编译器不报类型安全风险。
 */
function asRecordIfObject(value: unknown): Record<string, unknown> {
  return (value && typeof value === 'object' && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

/**
 * 断言值为字符串，否则抛出 configError
 *
 * 消除 loader 中重复的 "typeof x !== 'string' → throw"（枝叶层 2 次提取，收敛 6 处重复）。
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
 * 验证 temperature（0-2），非法类型取默认值，超出范围抛错
 */
function validateTemperature(value: unknown, defaultValue: number): number {
  // Number.isFinite 同时排除 NaN/Infinity（对齐 zod z.number()）
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
 * 验证 maxContextTokens（上下限内），非法类型取默认值，超出范围抛错。
 * 上下限防配置成 0/负数（上下文预算异常）或超大值（资源失控）。
 */
function validateMaxContextTokens(value: unknown, defaultValue: number): number {
  // Number.isFinite 同时排除 NaN/Infinity
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < MIN_MAX_CONTEXT_TOKENS || value > MAX_MAX_CONTEXT_TOKENS) {
      throw configError(
        'maxContextTokens 配置项超出范围',
        `当前值: ${value}（合法范围 ${MIN_MAX_CONTEXT_TOKENS}-${MAX_MAX_CONTEXT_TOKENS}）`,
        [`将 maxContextTokens 调整为 ${MIN_MAX_CONTEXT_TOKENS}-${MAX_MAX_CONTEXT_TOKENS} 之间的数字`],
      );
    }
    return value;
  }
  return defaultValue;
}

/**
 * 验证 contextWindow（可选，provider 上下文窗口声明）。
 *
 * **只做自身防御**（类型非法 / 非有限数 / 非正数 → undefined = 未声明），**不做区间裁决**：
 * 「模型能吃多大」是只有 provider/API 知道的事实，内核替用户裁决会造成「UI 显示值 ≠ 真实生效值」
 * 的静默失真（填 3M 被静默丢弃、兜底 120K，全程无提示）。值**原样生效**，
 * 超模型能力时由 **API 报错**（真实层可见失败）；超出常规量级仅 `warn` 作**观测**、**不改变行为**。
 */
function validateContextWindow(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  if (value > MAX_CONTEXT_WINDOW) {
    logger.warn(
      { contextWindow: value, warnAbove: MAX_CONTEXT_WINDOW },
      'contextWindow 超出常规模型窗口量级：内核不裁决，按原值生效；若模型不支持将由 API 报错',
    );
  }
  return value;
}

/**
 * 验证 permission（仅 owner/guest），空值取默认，非法抛错
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
 * 验证 allowedPaths 数组，元素非字符串抛错；超过最大条数截断（防白名单膨胀）
 */
function validateAllowedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return DEFAULT_CONFIG.allowedPaths;
  }

  for (let i = 0; i < value.length; i++) {
    assertString(value[i], `allowedPaths[${i}]`);
  }

  // 数量上限：路径白名单防膨胀（超过则截断保留前 MAX_ALLOWED_PATHS 条）
  return value.length > MAX_ALLOWED_PATHS
    ? value.slice(0, MAX_ALLOWED_PATHS) as string[]
    : value as string[];
}

/**
 * 解析 Provider 配置映射表
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

    const providerName = assertString(p.provider, `providers.${key}.provider`);
    const modelName = assertString(p.model, `providers.${key}.model`);

    providers[key] = {
      provider: providerName,
      model: modelName,
      // 过滤空字符串：与 parseConfig 顶层逻辑保持一致
      baseUrl: typeof p.baseUrl === 'string' && p.baseUrl ? p.baseUrl : undefined,
      apiKey: typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : undefined,
      temperature: p.temperature !== undefined ? validateTemperature(p.temperature, 0) : undefined,
      contextWindow: validateContextWindow(p.contextWindow),
      // 能力位（互斥双能力位）：三态保真透传——显式 true/false 如实保留，
      // 仅未配置（undefined）才由下游 Provider 内回落默认（toolCalling 默认 true、structured 默认 false）。
      supportsToolCalling:
        typeof p.supportsToolCalling === 'boolean' ? p.supportsToolCalling : undefined,
      supportsStructuredOutput:
        typeof p.supportsStructuredOutput === 'boolean' ? p.supportsStructuredOutput : undefined,
    };
  }

  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * 加载配置。
 * 单一真理源：所有默认值由 DEFAULT_CONFIG 声明，不维护独立 schema。
 * 查找顺序：显式 configPath → 项目级 .memora/config.json → 内置默认值（apply env 展开）。
 * 默认值合并走 parseConfig（不 spread DEFAULT_CONFIG，避免覆盖 schema 默认）。
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // 1. 显式指定
  if (configPath) {
    const config = await readJsonFile(configPath);
    return expandEnvVars(parseConfig(config));
  }

  // 2. 项目级
  const projectPath = resolve(process.cwd(), '.memora/config.json');
  try {
    const config = await readJsonFile(projectPath);
    return expandEnvVars(parseConfig(config));
  } catch (err) {
    // 项目级不可用（不存在/损坏/权限）时用默认值；排除 ENOENT（正常），其他错误暴露根因
    if (!isNodeErrorCode(err, 'ENOENT')) {
      logger.warn({ path: projectPath, err: toError(err) }, '项目级配置加载失败，使用默认值');
    }
  }

  // 3. 内置默认：parseConfig({}) 让默认值生效
  return expandEnvVars(parseConfig({}));
}

/**
 * 读取并解析 JSON 文件，将 JSON.parse 的 SyntaxError 包装为 configError
 * （防止裸 Error 通过显式 --config 路径传播）
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

