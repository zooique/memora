/**
 * LLM Provider 工厂
 * 根据配置选择具体的 LLM 实现
 * 详见 ADR-003
 */
import type { Config } from '@/config/loader.js';
import { LlmProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';

/**
 * 创建 LLM Provider
 * @param config 完整配置（必须有 llm.apiKey 或环境变量）
 */
export function createLlmProvider(config: Config): LlmProvider {
  const { provider, apiKey, baseUrl, model } = config.llm;

  if (provider === 'mock') {
    logger.warn('使用 Mock LLM Provider（仅用于测试）');
    return new MockProvider();
  }

  // 国产模型均走 OpenAI 兼容协议
  // presets：仅提供"开箱即用"的默认值；未列出的 provider 只要给了 baseUrl/model 也可工作
  const presets: Record<string, { baseUrl: string; defaultModel: string }> = {
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
    doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-pro-32k' },
    openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  };

  // 决定 baseUrl/model：preset > 用户显式
  const preset = presets[provider];
  const resolvedBaseUrl = (baseUrl ?? preset?.baseUrl)?.replace(/\/chat\/completions\/?$/, '');
  const resolvedModel = model ?? preset?.defaultModel;

  if (!resolvedBaseUrl) {
    throw configError(
      '未知的 LLM provider',
      `provider "${provider}" 未在预设中，且未配置 baseUrl`,
      [
        '在配置文件中显式设置 llm.baseUrl 和 llm.model',
        `或使用预设 provider：${Object.keys(presets).join(', ')}`,
        '详见 ADR-003 扩展点说明',
      ],
    );
  }
  if (!resolvedModel) {
    throw configError('未知的 LLM provider', `provider "${provider}" 未在预设中，且未配置 model`, [
      `在配置文件中显式设置 llm.model，或使用预设 provider：${Object.keys(presets).join(', ')}`,
    ]);
  }

  // apiKey 缺失尽早报错（比等 chat() 失败更友好）
  if (!apiKey) {
    throw configError('LLM API Key 未配置', `provider "${provider}" 缺少 apiKey`, [
      '设置环境变量 MEMORA_LLM_API_KEY',
      '或在配置文件中配置 llm.apiKey（支持 ${ENV_VAR} 占位符）',
      '详见 config.example.md',
    ]);
  }

  logger.info({ provider, baseUrl: resolvedBaseUrl, model: resolvedModel }, '创建 LLM Provider');

  return new OpenAICompatibleProvider(provider, {
    baseUrl: resolvedBaseUrl,
    apiKey,
    defaultModel: resolvedModel,
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
