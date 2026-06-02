/**
 * LLM Provider 工厂测试
 * 覆盖 Mock Provider / 预设表 / 错误场景
 */
import { describe, it, expect } from 'vitest';
import { createLlmProvider } from '../factory.js';
import type { Config } from '../../config/loader.js';

function makeConfig(overrides: Partial<Config['llm']> = {}): Config {
  return {
    llm: {
      provider: 'deepseek',
      apiKey: 'sk-test-key',
      baseUrl: undefined,
      model: 'deepseek-chat',
      temperature: 0.7,
      ...overrides,
    },
    memory: { dataDir: '~/.memora', maxContextTokens: 80000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
  };
}

describe('createLlmProvider · mock provider', () => {
  it('provider 为 mock 时应该返回 MockProvider', () => {
    const config = makeConfig({ provider: 'mock' });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('MockProvider 应该能处理空消息列表', async () => {
    const config = makeConfig({ provider: 'mock' });
    const provider = createLlmProvider(config);
    const chunks: string[] = [];
    for await (const chunk of provider.chat([])) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join('')).toContain('Mock 响应');
  });

  it('MockProvider 应该返回 finishReason stop', async () => {
    const config = makeConfig({ provider: 'mock' });
    const provider = createLlmProvider(config);
    let finishReason = '';
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    expect(finishReason).toBe('stop');
  });
});

describe('createLlmProvider · 预设表（deepseek / openai）', () => {
  it('deepseek 应该使用预设的 baseUrl 和 model', () => {
    const config = makeConfig({ provider: 'deepseek' });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('deepseek');
  });

  it('openai 应该使用预设的 baseUrl 和 model', () => {
    const config = makeConfig({ provider: 'openai', apiKey: 'sk-test' });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('openai');
  });

  it('用户指定的 baseUrl/model 应该覆盖预设', () => {
    const config = makeConfig({
      provider: 'deepseek',
      baseUrl: 'https://custom.api/v1',
      model: 'custom-model',
    });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('deepseek');
  });
});

describe('createLlmProvider · 错误场景', () => {
  it('未知 provider 且缺失 baseUrl 应该抛出 configError', () => {
    const config = makeConfig({ provider: 'unknown', apiKey: 'sk-key' });
    expect(() => createLlmProvider(config)).toThrow('未知的 LLM provider');
  });

  it('未知 provider 且缺失 model 应该抛出 configError', () => {
    const config = makeConfig({
      provider: 'unknown',
      apiKey: 'sk-key',
      baseUrl: 'https://some.api/v1',
      model: undefined as unknown as string,
    });
    expect(() => createLlmProvider(config)).toThrow('未知的 LLM provider');
  });

  it('缺少 apiKey 应该抛出 configError', () => {
    const config = makeConfig({ provider: 'deepseek', apiKey: '' });
    expect(() => createLlmProvider(config)).toThrow('API Key 未配置');
  });
});
