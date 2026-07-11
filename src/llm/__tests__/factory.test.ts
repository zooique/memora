/**
 * LLM Provider 工厂测试
 * 覆盖 Mock Provider / 预设表 / 错误场景 / 多 Provider 映射表（providers + active）
 */
import { describe, it, expect } from 'vitest';
import { createLlmProvider, createProviderFromConfig } from '@/llm/factory.js';
import type { Config } from '@/config/loader.js';

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

/**
 * 辅助：构造多 Provider 格式配置（providers + active）
 */
function makeMultiProviderConfig(
  providers: Record<string, { provider: string; model: string; apiKey?: string; baseUrl?: string }>,
  active?: string,
): Config {
  return {
    llm: {
      provider: 'deepseek',
      apiKey: 'sk-test-key',
      model: 'deepseek-chat',
      temperature: 0.7,
      providers,
      active,
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

describe('createLlmProvider · 多 Provider 映射表（providers + active）', () => {
  it('配置 providers + active 时应创建指定 active 的 Provider', () => {
    const config = makeMultiProviderConfig(
      {
        deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds' },
        openai: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-oai' },
      },
      'openai',
    );
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('openai');
  });

  it('active 缺失时应默认使用 providers 的第一个 key', () => {
    const config = makeMultiProviderConfig({
      deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds' },
      openai: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-oai' },
    });
    const provider = createLlmProvider(config);
    // Object.keys 顺序第一个是 'deepseek'
    expect(provider.name).toBe('deepseek');
  });

  it('active 不在 providers 中时应抛出 configError', () => {
    const config = makeMultiProviderConfig(
      {
        deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds' },
      },
      'nonexistent',
    );
    expect(() => createLlmProvider(config)).toThrow('无效的 active Provider');
  });

  it('providers 为空对象时应回退到旧扁平字段（向后兼容）', () => {
    const config = makeMultiProviderConfig({}, 'deepseek');
    // 空 providers → 回退到旧格式 llm.provider = 'deepseek'
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('deepseek');
  });

  it('多 Provider 中 mock provider 应正确创建', () => {
    const config = makeMultiProviderConfig(
      {
        mock1: { provider: 'mock', model: 'mock-model' },
        real: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-real' },
      },
      'mock1',
    );
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('多 Provider 中 apiKey 缺失应抛出 configError（含别名提示）', () => {
    const config = makeMultiProviderConfig(
      {
        nokey: { provider: 'deepseek', model: 'deepseek-chat' },
      },
      'nokey',
    );
    expect(() => createLlmProvider(config)).toThrow('API Key 未配置');
  });
});

describe('createProviderFromConfig · 单 Provider 独立创建', () => {
  it('应正确创建预设 Provider 实例', () => {
    const provider = createProviderFromConfig('my-alias', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    expect(provider.name).toBe('my-alias');
  });

  it('应支持自定义 baseUrl 覆盖预设', () => {
    const provider = createProviderFromConfig('custom', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://custom.api/v1',
      apiKey: 'sk-test',
    });
    expect(provider.name).toBe('custom');
  });

  it('mock provider 应返回 MockProvider', () => {
    const provider = createProviderFromConfig('test-mock', {
      provider: 'mock',
      model: 'any',
    });
    expect(provider.name).toBe('mock');
  });

  it('未知 provider 缺失 baseUrl 应抛出 configError', () => {
    expect(() =>
      createProviderFromConfig('bad', {
        provider: 'unknown',
        model: 'some-model',
        apiKey: 'sk-test',
      }),
    ).toThrow('未知的 LLM provider');
  });

  it('缺失 apiKey 应抛出 configError', () => {
    expect(() =>
      createProviderFromConfig('nokey-alias', {
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
    ).toThrow('API Key 未配置');
  });
});
