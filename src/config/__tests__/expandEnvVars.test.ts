/**
 * expandEnvVars.test.ts — 环境变量展开测试
 *
 * 覆盖范围：
 *   1. llm.providers 多 Provider 映射表
 *   2. 边界场景：undefined 值、不存在的环境变量、字符串中多个占位符
 *
 * 注：apiKey/baseUrl 只存在于 providers 中（主通道扁平字段为唯一 providers 格式）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { expandEnvVars } from '../expandEnvVars.js';
import type { Config } from '@/config/loader.js';

/** 创建最小配置（含所有通道的占位符） */
function createConfigWithPlaceholders(): Config {
  return {
    llm: {
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
// 1. Providers 映射表展开
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
    };
    const result = expandEnvVars(config);
    expect(result.llm.providers).toBeDefined();
    expect(result.llm.providers!['provider1']).toBeDefined();
    expect(result.llm.providers!['provider1']!.apiKey).toBe('sk-p1-key');
    expect(result.llm.providers!['provider1']!.baseUrl!).toBe('https://p1.example.com');
    expect(result.llm.providers!['provider2']!.apiKey!).toBe('sk-p2-key');
    expect(result.llm.providers!['provider2']!.baseUrl!).toBe('https://p2.example.com');
  });

  it('展开 Provider 的 model（model 也支持环境变量）', () => {
    process.env.TEST_PROVIDER1_MODEL = 'mimo-v2.5';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          provider1: {
            provider: 'deepseek',
            apiKey: 'sk-x',
            baseUrl: 'https://x.example.com',
            model: '${TEST_PROVIDER1_MODEL}',
          },
        },
      },
    };
    const result = expandEnvVars(config);
    expect(result.llm.providers!['provider1']!.model).toBe('mimo-v2.5');
    delete process.env.TEST_PROVIDER1_MODEL;
  });

  it('providers 为 undefined 时应保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: undefined,
      },
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
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.onlyKey!.apiKey).toBe('sk-key');
    expect(result.llm.providers!.onlyKey!.baseUrl).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 4. 边界场景
// ══════════════════════════════════════════════════════════════

describe('expandEnvVars — 边界场景', () => {

  it('providers 中环境变量不存在时替换为空字符串', () => {
    delete process.env.NONEXISTENT_VAR_XYZ;
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          only: {
            provider: 'deepseek',
            model: 'test-model',
            apiKey: '${NONEXISTENT_VAR_XYZ}',
            baseUrl: undefined,
          },
        },
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.only!.apiKey).toBe('');
  });

  it('providers 中 apiKey 为 undefined 时保留 undefined', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          only: {
            provider: 'deepseek',
            model: 'test-model',
            apiKey: undefined,
            baseUrl: undefined,
          },
        },
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.only!.apiKey).toBeUndefined();
  });

  it('providers 中字符串包含多个占位符', () => {
    process.env.VAR_A = 'aaa';
    process.env.VAR_B = 'bbb';
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          only: {
            provider: 'deepseek',
            model: 'test-model',
            apiKey: '${VAR_A}:${VAR_B}',
            baseUrl: undefined,
          },
        },
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.only!.apiKey).toBe('aaa:bbb');
    delete process.env.VAR_A;
    delete process.env.VAR_B;
  });

  it('providers 中纯文本（无占位符）不做替换', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          only: {
            provider: 'deepseek',
            model: 'test-model',
            apiKey: 'hardcoded-key-123',
            baseUrl: 'https://fixed.url.com',
          },
        },
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.only!.apiKey).toBe('hardcoded-key-123');
    expect(result.llm.providers!.only!.baseUrl).toBe('https://fixed.url.com');
  });

  it('providers 中空字符串保留为空字符串', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
        providers: {
          only: {
            provider: 'deepseek',
            model: 'test-model',
            apiKey: '',
            baseUrl: '',
          },
        },
      },
      };
    const result = expandEnvVars(config);
    expect(result.llm.providers!.only!.apiKey).toBe('');
    expect(result.llm.providers!.only!.baseUrl).toBe('');
  });

  it('返回的是新对象（不修改原配置）', () => {
    const config: Config = {
      ...createConfigWithPlaceholders(),
      llm: {
        ...createConfigWithPlaceholders().llm,
      },
      };
    const originalApiKey = config.llm.providers!['provider1']!.apiKey;
    expandEnvVars(config);
    // 原对象不应被修改
    expect(config.llm.providers!['provider1']!.apiKey).toBe(originalApiKey);
  });
});
