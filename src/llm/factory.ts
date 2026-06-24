/**
 * LLM Provider 工厂
 * 根据配置选择具体的 LLM 实现
 * 详见 ADR-003
 */
import type { Config } from '@/config/loader.js';
import { LlmProvider } from '@/llm/provider.js';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';

// 预设 Provider 的默认 baseUrl 和 model（开箱即用）
const presets: Record<string, { baseUrl: string; defaultModel: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-pro-32k' },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
};

/**
 * 单个 Provider 配置（用于 createProviderFromConfig）
 */
export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * 从单个 Provider 配置创建 LlmProvider 实例
 *
 * 与 createLlmProvider 逻辑相同，但接收的是单个 Provider 配置而非完整 Config。
 * 用于多 Provider 管理场景：Agent 为 providers 映射表中的每个条目调用此函数。
 *
 * @param name - Provider 别名（如 "deepseek"、"openai"）
 * @param providerConfig - 单个 Provider 的配置
 * @returns LlmProvider 实例
 */
export function createProviderFromConfig(
  name: string,
  providerConfig: ProviderConfig,
): LlmProvider {
  const { provider, apiKey, baseUrl, model } = providerConfig;

  if (provider === 'mock') {
    logger.warn({ provider: 'mock' }, '使用 Mock LLM Provider（仅用于测试）');
    return new MockProvider();
  }

  // 国产模型均走 OpenAI 兼容协议
  const preset = presets[provider];
  const resolvedBaseUrl = (baseUrl ?? preset?.baseUrl)?.replace(/\/chat\/completions\/?$/, '');
  const resolvedModel = model ?? preset?.defaultModel;

  if (!resolvedBaseUrl) {
    throw configError(
      '未知的 LLM provider',
      `provider "${provider}" 未在预设中，且未配置 baseUrl`,
      [
        '在配置文件中显式设置 baseUrl 和 model',
        `或使用预设 provider：${Object.keys(presets).join(', ')}`,
        '详见 ADR-003 扩展点说明',
      ],
    );
  }
  if (!resolvedModel) {
    throw configError('未知的 LLM provider', `provider "${provider}" 未在预设中，且未配置 model`, [
      `在配置文件中显式设置 model，或使用预设 provider：${Object.keys(presets).join(', ')}`,
    ]);
  }

  // apiKey 缺失尽早报错（比等 chat() 失败更友好）
  if (!apiKey) {
    throw configError('LLM API Key 未配置', `provider "${name}" (${provider}) 缺少 apiKey`, [
      `设置环境变量 MEMORA_LLM_API_KEY`,
      '或在配置文件中配置 apiKey（支持 ${ENV_VAR} 占位符）',
      '详见 config.example.md',
    ]);
  }

  logger.info(
    { provider, baseUrl: resolvedBaseUrl, model: resolvedModel },
    `创建 LLM Provider: ${name}`,
  );

  return new OpenAICompatibleProvider(name, {
    baseUrl: resolvedBaseUrl,
    apiKey,
    defaultModel: resolvedModel,
  });
}

/**
 * 创建 LLM Provider（从完整 Config）
 *
 * 兼容两种配置格式：
 *   1. 新格式：llm.providers + llm.active → 使用指定 Provider
 *   2. 旧格式：llm.provider + llm.model + ... → 单 Provider 扁平字段
 *
 * @param config 完整配置
 * @returns 当前激活的 LlmProvider 实例
 */
export function createLlmProvider(config: Config): LlmProvider {
  const { llm } = config;

  // 优先使用新的多 Provider 格式
  if (llm.providers && Object.keys(llm.providers).length > 0) {
    // QC-17 移除非空断言：Object.keys 已检查 length > 0
    const active = llm.active ?? Object.keys(llm.providers)[0] ?? '';
    const providerConfig = llm.providers[active];
    if (!providerConfig) {
      throw configError('无效的 active Provider', `active="${active}" 不在 providers 映射表中`, [
        `可用的 Provider：${Object.keys(llm.providers).join(', ')}`,
        `在配置文件中设置 llm.active 为其中之一`,
        '或使用 `memora config llm use <name>` 切换',
      ]);
    }
    return createProviderFromConfig(active, providerConfig);
  }

  // 旧格式：复用 createProviderFromConfig（DRY，避免重复 preset 解析逻辑）
  return createProviderFromConfig(llm.provider, {
    provider: llm.provider,
    model: llm.model,
    baseUrl: llm.baseUrl,
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
      await new Promise((r) => setTimeout(r, 5));
    }
    yield { finishReason: 'stop' as const };
  }
}
