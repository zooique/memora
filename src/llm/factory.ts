/**
 * LLM Provider 工厂
 * 根据配置选择具体的 LLM 实现
 * 详见 ADR-003
 */
import type { Config } from '../config/loader.js';
import { LlmProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { logger } from '../logging/logger.js';

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

  if (!apiKey) {
    throw new Error(
      `LLM provider "${provider}" 需要 API Key。请设置环境变量 MEMORA_LLM_API_KEY 或在配置文件中配置 llm.apiKey`,
    );
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
    throw new Error(
      `未知的 LLM provider: "${provider}"，且未配置 baseUrl。可选：${Object.keys(presets).join(', ')} 或自定义 baseUrl。`,
    );
  }
  if (!resolvedModel) {
    throw new Error(`未知的 LLM provider: "${provider}"，且未配置 model。`);
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
