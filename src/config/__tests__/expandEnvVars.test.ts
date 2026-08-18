/**
 * expandEnvVars.test.ts — 环境变量展开测试
 *
 * 覆盖范围：
 *   1. llm 主通道（apiKey / baseUrl）
 *   2. llm.providers 多 Provider 映射表
 *   3. llm.background 后台通道
 *   4. embedding 向量嵌入通道
 *   5. 边界场景：undefined 值、不存在的环境变量、字符串中多个占位符
 *
 * 注：与 loader.test.ts 互补——loader 测试集成路径，本文件测试纯函数
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { expandEnvVars } from '../expandEnvVars.js';
import type { Config } from '@/config/loader.js';

/** 创建最小配置（含所有通道的占位符） */
function createConfigWithPlaceholders(): Config {
  return {
    llm: {
      provider: 'deepseek',
      model: 'test-model',
      temperature: 0.7,
      apiKey: '${TEST_API_KEY}',
      baseUrl: '${TEST_BASE_URL}',
      providers: {
        provider1: {
          provider: 'deepseek',
          apiKey: '${TEST_PROVIDER1_KEY}',
          baseUrl: '${TEST_PROVIDER1_URL}',
          model: 'test-model',
        },
        provider2: {
          provider: 'deepseek',
          apiKey: '${TEST_PROVIDER2_KEY}',
          baseUrl: '${TEST_PROVIDER2_URL}',
          model: 'test-model',
        },
      },
      background: {
        provider: 'deepseek',
        model: 'bg-model',
        apiKey: '${TEST_BG_API_KEY}',
        baseUrl: '${TEST_BG_BASE_URL}',
        temperature: 0.5,
      },
    },
    embedding: {
      model: 'embedding-model',
      apiKey: '${TEST_EMBEDDING_KEY}',
      baseUrl: '${TEST_EMBEDDING_URL}',
    },
    memory: {
      dataDir: '',
      maxContextTokens: 120_000,
    },
    security: {
      permission: 'owner',
      confirmWrites: false,
    },
    allowedPaths: [],
  };
}

// ══════════════════════════════════════════════════════════════
// 1. LLM 主通道展开
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — LLM 主通道', () => {

  beforeEach(() => {
    // 清理测试环境变量
    delete process.env.TEST_API_KEY;
    delete process.env.TEST_BASE_URL;
  });

  it('展开 apiKey 占位符', () => {
    process.env.TEST_API_KEY = 'sk-test-key-123';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: '${TEST_API_KEY}',
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('sk-test-key-123');
  });

  it('展开 baseUrl 占位符', () => {
    process.env.TEST_BASE_URL = 'https://api.example.com';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: undefined,
        baseUrl: '${TEST_BASE_URL}',
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.baseUrl).toBe('https://api.example.com');
  });

  it('同时展开 apiKey 和 baseUrl', () => {
    process.env.TEST_API_KEY = 'sk-key';
    process.env.TEST_BASE_URL = 'https://api.test.com';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: '${TEST_API_KEY}',
        baseUrl: '${TEST_BASE_URL}',
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('sk-key');
    expect(result.llm.baseUrl).toBe('https://api.test.com');
  });
});

// ══════════════════════════════════════════════════════════════
// 2. Providers 映射表展开
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — Providers 映射表', () => {

  beforeEach(() => {
    delete process.env.TEST_PROVIDER1_KEY;
    delete process.env.TEST_PROVIDER1_URL;
    delete process.env.TEST_PROVIDER2_KEY;
    delete process.env.TEST_PROVIDER2_URL;
  });

  it('展开多个 Provider 的 apiKey 和 baseUrl', () => {
    process.env.TEST_PROVIDER1_KEY = 'sk-p1-key';
    process.env.TEST_PROVIDER1_URL = 'https://p1.example.com';
    process.env.TEST_PROVIDER2_KEY = 'sk-p2-key';
    process.env.TEST_PROVIDER2_URL = 'https://p2.example.com';

    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: undefined,
        baseUrl: undefined,
        background: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.llm.providers).toBeDefined();
    expect(result.llm.providers!['provider1']).toBeDefined();
    expect(result.llm.providers!['provider1']!.apiKey).toBe('sk-p1-key');
    expect(result.llm.providers!['provider1']!.baseUrl!).toBe('https://p1.example.com');
    expect(result.llm.providers!['provider2']!.apiKey!).toBe('sk-p2-key');
    expect(result.llm.providers!['provider2']!.baseUrl!).toBe('https://p2.example.com');
  });

  it('providers 为 undefined 时应保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: undefined,
        background: undefined,
        apiKey: undefined,
        baseUrl: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.llm.providers).toBeUndefined();
  });

  it('providers 中单个 Provider 的字段为 undefined 时保留', () => {
    process.env.TEST_PROVIDER1_KEY = 'sk-key';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          onlyKey: {
            provider: 'deepseek',
            apiKey: '${TEST_PROVIDER1_KEY}',
            baseUrl: undefined,
            model: 'test-model',
          },
        },
        background: undefined,
        apiKey: undefined,
        baseUrl: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.onlyKey!.apiKey).toBe('sk-key');
    expect(result.llm.providers!.onlyKey!.baseUrl).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 3. Background 后台通道展开
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — Background 后台通道', () => {

  beforeEach(() => {
    delete process.env.TEST_BG_API_KEY;
    delete process.env.TEST_BG_BASE_URL;
  });

  it('展开 background 的 apiKey 和 baseUrl', () => {
    process.env.TEST_BG_API_KEY = 'sk-bg-key';
    process.env.TEST_BG_BASE_URL = 'https://bg.example.com';

    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: undefined,
        baseUrl: undefined,
        providers: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.llm.background).toBeDefined();
    expect(result.llm.background!.apiKey).toBe('sk-bg-key');
    expect(result.llm.background!.baseUrl).toBe('https://bg.example.com');
    // 验证 background 保留了其他字段
    expect(result.llm.background!.provider).toBe('deepseek');
    expect(result.llm.background!.model).toBe('bg-model');
  });

  it('background 为 undefined 时保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        background: undefined,
        providers: undefined,
        apiKey: undefined,
        baseUrl: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.llm.background).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Embedding 向量嵌入通道展开
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — Embedding 向量嵌入通道', () => {

  beforeEach(() => {
    delete process.env.TEST_EMBEDDING_KEY;
    delete process.env.TEST_EMBEDDING_URL;
  });

  it('展开 embedding 的 apiKey 和 baseUrl', () => {
    process.env.TEST_EMBEDDING_KEY = 'sk-embed-key';
    process.env.TEST_EMBEDDING_URL = 'https://embed.example.com';

    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: undefined,
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.embedding).toBeDefined();
    expect(result.embedding!.apiKey).toBe('sk-embed-key');
    expect(result.embedding!.baseUrl).toBe('https://embed.example.com');
    // 验证 embedding 保留了其他字段
    expect(result.embedding!.model).toBe('embedding-model');
  });

  it('embedding 为 undefined 时保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        apiKey: undefined,
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
      embedding: undefined,
    };
    const result = expandEnvVars(config);
    expect(result.embedding).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 5. 边界场景
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — 边界场景', () => {

  it('环境变量不存在时替换为空字符串', () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: '${NONEXISTENT_VAR_XYZ}',
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('');
  });

  it('apiKey 为 undefined 时保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: undefined,
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBeUndefined();
  });

  it('字符串中包含多个占位符', () => {
    process.env.VAR_A = 'aaa';
    process.env.VAR_B = 'bbb';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: '${VAR_A}:${VAR_B}',
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('aaa:bbb');
    delete process.env.VAR_A;
    delete process.env.VAR_B;
  });

  it('纯文本（无占位符）不做替换', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: 'hardcoded-key-123',
        baseUrl: 'https://fixed.url.com',
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('hardcoded-key-123');
    expect(result.llm.baseUrl).toBe('https://fixed.url.com');
  });

  it('空字符串保留为空字符串', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: '',
        baseUrl: '',
        providers: undefined,
        background: undefined,
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.apiKey).toBe('');
    expect(result.llm.baseUrl).toBe('');
  });

  it('返回的是新对象（不修改原配置）', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        provider: 'deepseek',
        model: 'test-model',
        temperature: 0.7,
        apiKey: '${SOME_VAR}',
        baseUrl: undefined,
        providers: undefined,
        background: undefined,
      },
    };
    const originalApiKey = config.llm.apiKey;
    expandEnvVars(config);
    // 原对象不应被修改
    expect(config.llm.apiKey).toBe(originalApiKey);
  });
});