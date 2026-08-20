/**
 * LLM Provider 工厂测试
 * 覆盖 Mock Provider / 错误场景 / 多 Provider 映射表（providers + active）
 *
 * 内核不提供 preset 表：baseUrl + model 必须由调用方显式提供，
 * apiKey 由下游 LLM 服务决定是否必需，内核不校验。
 */
import { describe, it, expect } from 'vitest';
import { createLlmProvider, createProviderFromConfig, createProviderRouter } from '@/llm/factory.js';
import type { Config } from '@/config/loader.js';


function makeConfig(overrides: Partial<Config['llm']> = {}): Config {
  return {
    llm: {
      providers: {
        deepseek: {
          provider: 'deepseek',
          apiKey: 'sk-test-key',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
      },
      active: 'deepseek',
      ...overrides,
    },
    memory: { dataDir: '~/.memora', maxContextTokens: 80000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
  };
}

/**
 * 辅助：构造多 Provider 格式配置（providers + active）
 *
 * providers 参数类型与 loader.ts 的 ProviderEntryConfig 接口对齐：
 * provider 必填（仅日志标识，宿主 UI 用其存储 cloud/local 模式）
 */
function makeMultiProviderConfig(
  providers: Record<string, { provider: string; model: string; apiKey?: string; baseUrl: string }>,
  active?: string,
): Config {
  return {
    llm: {
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
    const config = makeConfig({
      providers: {
        mock: { provider: 'mock', model: 'mock-model', baseUrl: 'https://mock.local' },
      },
      active: 'mock',
    });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('MockProvider 应该能处理空消息列表', async () => {
    const config = makeConfig({
      providers: {
        mock: { provider: 'mock', model: 'mock-model', baseUrl: 'https://mock.local' },
      },
      active: 'mock',
    });
    const provider = createLlmProvider(config);
    const chunks: string[] = [];
    for await (const chunk of provider.chat([])) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join('')).toContain('Mock 响应');
  });

  it('MockProvider 应该返回 finishReason stop', async () => {
    const config = makeConfig({
      providers: {
        mock: { provider: 'mock', model: 'mock-model', baseUrl: 'https://mock.local' },
      },
      active: 'mock',
    });
    const provider = createLlmProvider(config);
    let finishReason = '';
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    expect(finishReason).toBe('stop');
  });
});

describe('createLlmProvider · 基本创建', () => {
  it('显式指定 baseUrl 和 model 应正确创建', () => {
    const config = makeConfig();
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('deepseek');
  });

  it('自定义 baseUrl 和 model 覆盖默认', () => {
    const config = makeConfig({
      providers: {
        custom: { provider: 'deepseek', model: 'custom-model', baseUrl: 'https://custom.api/v1' },
      },
      active: 'custom',
    });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('custom');
  });
});

describe('createLlmProvider · 错误场景', () => {
  it('缺失 baseUrl 应该抛出 configError', () => {
    const config = makeConfig({
      providers: {
        bad: { provider: 'deepseek', model: 'deepseek-chat' as string, baseUrl: '' },
      },
      active: 'bad',
    });
    expect(() => createLlmProvider(config)).toThrow('baseUrl 未配置');
  });

  it('缺失 model 应该抛出 configError', () => {
    const config = makeConfig({
      providers: {
        bad: { provider: 'deepseek', model: '' as string, baseUrl: 'https://api.deepseek.com/v1' },
      },
      active: 'bad',
    });
    expect(() => createLlmProvider(config)).toThrow('model 未配置');
  });

  it('apiKey 为空时仍可创建（内核不校验——本地 LLM / Ollama 等场景）', () => {
    const config = makeConfig({
      providers: {
        local: { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: '' },
      },
      active: 'local',
    });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('local');
  });

  it('providers 未配置时应抛出 configError', () => {
    const config = makeConfig({ providers: undefined, active: undefined });
    expect(() => createLlmProvider(config)).toThrow('providers 未配置');
  });
});

describe('createLlmProvider · 多 Provider 映射表（providers + active）', () => {
  it('配置 providers + active 时应创建指定 active 的 Provider', () => {
    const config = makeMultiProviderConfig(
      {
        ds: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1' },
        oai: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-oai', baseUrl: 'https://api.openai.com/v1' },
      },
      'oai',
    );
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('oai');
  });

  it('active 缺失时应默认使用 providers 的第一个 key', () => {
    const config = makeMultiProviderConfig({
      primeiro: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1' },
      segundo: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-oai', baseUrl: 'https://api.openai.com/v1' },
    });
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('primeiro');
  });

  it('active 不在 providers 中时应抛出 configError', () => {
    const config = makeMultiProviderConfig(
      {
        ds: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com/v1' },
      },
      'nonexistent',
    );
    expect(() => createLlmProvider(config)).toThrow('无效的 active Provider');
  });

  it('providers 为空对象时应抛出 configError', () => {
    const config = makeMultiProviderConfig({}, 'deepseek');
    expect(() => createLlmProvider(config)).toThrow('providers 未配置');
  });

  it('多 Provider 中 mock provider 应正确创建', () => {
    const config = makeMultiProviderConfig(
      {
        mock1: { provider: 'mock', model: 'mock-model', baseUrl: 'https://mock.local' },
        real: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-real', baseUrl: 'https://api.deepseek.com/v1' },
      },
      'mock1',
    );
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('mock');
  });

  it('多 Provider 中 apiKey 为空仍可创建（不校验——本地 LLM 场景）', () => {
    const config = makeMultiProviderConfig(
      {
        local: { provider: 'local', model: 'llama3', baseUrl: 'http://localhost:11434/v1' },
      },
      'local',
    );
    const provider = createLlmProvider(config);
    expect(provider.name).toBe('local');
  });
});

describe('createProviderFromConfig · 单 Provider 独立创建', () => {
  it('应正确创建 Provider 实例', () => {
    const provider = createProviderFromConfig('my-alias', {
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    });
    expect(provider.name).toBe('my-alias');
  });

  it('应支持自定义 baseUrl', () => {
    const provider = createProviderFromConfig('custom', {
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
      baseUrl: 'https://mock.local',
    });
    expect(provider.name).toBe('mock');
  });

  it('缺失 baseUrl 应抛出 configError', () => {
    expect(() =>
      createProviderFromConfig('bad', {
        model: 'some-model',
        apiKey: 'sk-test',
        baseUrl: '',
      }),
    ).toThrow('baseUrl 未配置');
  });

  it('缺失 model 应抛出 configError', () => {
    expect(() =>
      createProviderFromConfig('bad', {
        model: '',
        baseUrl: 'https://some.api/v1',
        apiKey: 'sk-test',
      }),
    ).toThrow('model 未配置');
  });

  it('apiKey 为空时仍可创建（内核不校验）', () => {
    const provider = createProviderFromConfig('local-provider', {
      model: 'llama3',
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(provider.name).toBe('local-provider');
  });
});

describe('createProviderRouter · 多模型路由', () => {
  it('无 providers 配置时应抛出 configError', () => {
    const config = makeConfig({ providers: undefined, active: undefined });
    expect(() => createProviderRouter(config)).toThrow('providers 未配置');
  });

  it('有 providers 但无 taskRouter 时应返回统一 active Provider', () => {
    const config = makeMultiProviderConfig(
      {
        fast: { provider: 'mock', model: 'fast-model', baseUrl: 'https://fast.api/v1' },
        smart: { provider: 'mock', model: 'smart-model', baseUrl: 'https://smart.api/v1' },
      },
      'fast',
    );
    const router = createProviderRouter(config);
    const p = router('simple');
    expect(p.name).toBe('mock');
    // 所有任务类型返回同一个 Provider（active = fast）
    expect(router('reasoning')).toBe(p);
    expect(router('code')).toBe(p);
  });

  it('有 providers + taskRouter 时应按任务类型路由到对应 Provider', () => {
    const config = makeMultiProviderConfig(
      {
        fast: { provider: 'mock', model: 'fast-model', baseUrl: 'https://fast.api/v1' },
        smart: { provider: 'mock', model: 'smart-model', baseUrl: 'https://smart.api/v1' },
      },
      'fast',
    );
    // 手动注入 taskRouter（makeMultiProviderConfig 不传 taskRouter）
    config.llm.taskRouter = {
      simple: 'fast',
      reasoning: 'smart',
      code: 'smart',
      summary: 'fast',
    };

    const router = createProviderRouter(config);
    const simpleP = router('simple');
    const reasoningP = router('reasoning');
    const codeP = router('code');
    const summaryP = router('summary');

    // simple 和 summary 走 fast
    expect(simpleP).toBe(summaryP);
    // reasoning 和 code 走 smart
    expect(reasoningP).toBe(codeP);
    // fast 和 smart 是不同的实例
    expect(simpleP).not.toBe(reasoningP);
  });

  it('taskRouter 引用不存在的 provider 名时应回退到兜底 Provider', () => {
    const config = makeMultiProviderConfig(
      {
        fast: { provider: 'mock', model: 'fast-model', baseUrl: 'https://fast.api/v1' },
      },
      'fast',
    );
    config.llm.taskRouter = {
      simple: 'fast',
      reasoning: 'nonexistent', // 不存在的 provider
    };

    const router = createProviderRouter(config);
    const simpleP = router('simple');
    const reasoningP = router('reasoning');

    // simple 走 fast
    expect(simpleP.name).toBe('mock');
    // reasoning 走兜底（fallbackProvider）
    expect(reasoningP.name).toBe('mock');
    // 兜底和 fast 不是同一个实例
    expect(simpleP).not.toBe(reasoningP);
  });

  it('taskRouter 中未配置的任务类型应回退到兜底 Provider', () => {
    const config = makeMultiProviderConfig(
      {
        fast: { provider: 'mock', model: 'fast-model', baseUrl: 'https://fast.api/v1' },
      },
      'fast',
    );
    // 只配置部分任务类型
    config.llm.taskRouter = { simple: 'fast' };

    const router = createProviderRouter(config);
    // reasoning 未在 taskRouter 中 → 回退到兜底
    const reasoningP = router('reasoning');
    expect(reasoningP.name).toBe('mock');
    // 兜底和 fast 不是同一个实例
    expect(router('simple')).not.toBe(reasoningP);
  });
});
