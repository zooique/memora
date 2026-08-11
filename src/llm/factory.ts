/**
 * LLM Provider 工厂
 * 根据配置创建 LLM Provider 实例
 * 详见 ADR-003
 *
 * 内核职责（明确定界）：
 * - 接收 baseUrl + model + apiKey 三板斧，创建 OpenAICompatibleProvider
 * - 不负责 provider 名称 → URL/模型 的映射（预设是宿主层职责）
 * - 不验证 apiKey（是否必需是下游 LLM 服务的决���，内核只是透传管道）
 */
import type { Config } from '@/config/loader.js';
import { LlmProvider } from '@/llm/provider.js';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { safeSetTimeout } from '@/utils/safeTimer.js';
import type { ProviderRouter, TaskType } from '@/llm/types.js';

/**
 * 单个 Provider 配置（用于 createProviderFromConfig）
 *
 * baseUrl 为可选：内核在 createProviderFromConfig 内部会做空值检查，
 * 缺失时抛出 configError。这样 BackgroundConfig.baseUrl?: string 可以直接传入。
 */
export interface ProviderConfig {
  /** API 基础 URL（可选——内核在 createProviderFromConfig 内部做空值检查并报错） */
  baseUrl?: string;
  /** 默认模型名称（必填） */
  model: string;
  /** API 密钥（本地 LLM 如 Ollama 可为空字符串；宿主负责决定） */
  apiKey?: string;
  /** Provider 标识（仅用于日志，不影响路由） */
  provider?: string;
}

/**
 * 从单个 Provider 配置创建 LlmProvider 实例
 *
 * 与 createLlmProvider 逻辑相同，但接收的是单个 Provider 配置而非完整 Config。
 * 用于多 Provider 管理场景：Agent 为 providers 映射表中的每个条目调用此函数。
 *
 * @param name - Provider 别名（仅用于日志标识）
 * @param providerConfig - 单个 Provider 的配置（baseUrl + model 必填）
 * @returns LlmProvider 实例
 */
export function createProviderFromConfig(
  name: string,
  providerConfig: ProviderConfig,
): LlmProvider {
  const { baseUrl, model, apiKey, provider } = providerConfig;

  if (provider === 'mock') {
    logger.warn({ provider: 'mock' }, '使用 Mock LLM Provider（仅用于测试）');
    return new MockProvider();
  }

  // baseUrl 和 model 是内核的直接需求，不做过多的回退逻辑
  const resolvedBaseUrl = (baseUrl || '').replace(/\/chat\/completions\/?$/, '');
  if (!resolvedBaseUrl) {
    throw configError(
      'LLM baseUrl 未配置',
      `provider "${name}" 缺少 baseUrl`,
      ['在宿主层填充 baseUrl（如 "https://api.deepseek.com/v1"）'],
    );
  }
  if (!model) {
    throw configError(
      'LLM model 未配置',
      `provider "${name}" 缺少 model`,
      ['在宿主层填充 model（如 "deepseek-chat"）'],
    );
  }

  logger.info(
    { provider: provider ?? name, baseUrl: resolvedBaseUrl, model },
    `创建 LLM Provider: ${name}`,
  );

  return new OpenAICompatibleProvider(name, {
    baseUrl: resolvedBaseUrl,
    apiKey: apiKey ?? '',
    defaultModel: model,
  });
}

/**
 * 创建 LLM Provider（从完整 Config）
 *
 * 兼容两种配置格式：
 *   1. 新格式：llm.providers + llm.active → 使用指定 Provider
 *   2. 旧格式：llm.provider + llm.model + ... → 单 Provider 扁平字段
 *
 * 调用方（宿主）应确保 baseUrl + model 已在配置中显式设置。
 *
 * @param config 完整配置
 * @returns 当前激活的 LlmProvider 实例
 */
export function createLlmProvider(config: Config): LlmProvider {
  const { llm } = config;

  // 优先使用新的多 Provider 格式
  if (llm.providers && Object.keys(llm.providers).length > 0) {
    const active = llm.active ?? Object.keys(llm.providers)[0] ?? '';
    const providerConfig = llm.providers[active];
    if (!providerConfig) {
      throw configError('无效的 active Provider', `active="${active}" 不在 providers 映射表中`, [
        `可用的 Provider：${Object.keys(llm.providers).join(', ')}`,
        `在配置文件中设置 llm.active 为其中之一`,
        '或使用 `memora config llm use <name>` 切换',
      ]);
    }
    return createProviderFromConfig(active, {
      ...providerConfig,
      baseUrl: providerConfig.baseUrl ?? '',
    });
  }

  // 旧格式：复用 createProviderFromConfig
  return createProviderFromConfig(llm.provider, {
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl ?? '',
    apiKey: llm.apiKey,
  });
}

/**
 * Mock LLM Provider
 * 用于测试和开发
 */
class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(messages: Array<{ role: string; content: string }>) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;

    for (const char of reply) {
      yield { content: char };
      await new Promise<void>((r) => safeSetTimeout(r, 5));
    }
    yield { finishReason: 'stop' as const };
  }
}

/**
 * 创建 Provider 路由选择器（P1-2 多模型路由基础）
 *
 * 基于配置中的 providers 映射表 + taskRouter 映射，构建路由函数。
 * 不配置 taskRouter 时回退到统一的 active Provider（向后兼容）。
 *
 * 路由策略：
 * 1. 无多 Provider 配置 → 所有任务类型使用同一个 Provider（旧格式）
 * 2. 有 providers 但无 taskRouter → 所有任务类型使用 active Provider
 * 3. 有 providers + taskRouter → 按任务类型路由到对应 Provider
 *
 * @param config 完整配置
 * @returns Provider 路由函数
 */
export function createProviderRouter(config: Config): ProviderRouter {
  const { llm } = config;

  // 无多 Provider 配置 → 回退到旧格式，返回统一 Provider
  if (!llm.providers || Object.keys(llm.providers).length === 0) {
    const singleProvider = createLlmProvider(config);
    return () => singleProvider;
  }

  // 解析 taskRouter 配置
  const taskRouter = llm.taskRouter;
  if (!taskRouter || Object.keys(taskRouter).length === 0) {
    // 无 taskRouter 配置 → 所有任务类型使用 active Provider
    const activeProvider = createLlmProvider(config);
    return () => activeProvider;
  }

  // 预创建所有引用的 Provider 实例
  const providerCache = new Map<string, LlmProvider>();
  for (const providerName of new Set(Object.values(taskRouter))) {
    const providerConfig = llm.providers[providerName as string] as Record<string, unknown> | undefined;
    if (providerConfig) {
      providerCache.set(
        providerName as string,
        createProviderFromConfig(providerName as string, {
          provider: (providerConfig as { provider?: string }).provider ?? providerName as string,
          model: (providerConfig as { model: string }).model,
          baseUrl: (providerConfig as { baseUrl?: string }).baseUrl ?? '',
          apiKey: (providerConfig as { apiKey?: string }).apiKey,
        }),
      );
    }
  }

  // 兜底 Provider（taskRouter 中引用了不存在的 provider 名时使用）
  const fallbackProvider = createLlmProvider(config);

  return (taskType: TaskType): LlmProvider => {
    const providerName = taskRouter[taskType];
    if (!providerName) return fallbackProvider;
    return providerCache.get(providerName) ?? fallbackProvider;
  };
}
