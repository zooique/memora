/**
 * SpriteConfigStore 单元测试（P0 LLM 配置持久化真理源）
 *
 * 覆盖范围：
 * - load()：委托 loadConfig，文件缺失时抛错
 * - loadOrDefault()：文件缺失时返回 sprite 专属默认配置
 * - isConfigured()：apiKey + provider 非 mock 判定
 * - save()：合并写入 + 收敛到 providers['default'] + 0600 权限
 * - saveProviders()：多 Provider 映射表（单一格式，不再回填扁平字段）
 * - resolveProviderConfig()：从 providers 映射表按 key 读取
 *
 * Mock 策略：
 * - vi.mock('memora') 拦截 loadConfig + logger + toError
 * - vi.mock('node:fs/promises') 拦截 mkdir + writeFile
 * - vi.mock('node:os') 拦截 homedir
 * - 传入临时路径避免依赖真实文件系统
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

vi.mock('memora', () => ({
  loadConfig: vi.fn(),
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  toError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err;
    return new Error(String(err));
  }),
}));

import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig, logger } from 'memora';
import type { Config } from 'memora';
import {
  SpriteConfigStore,
  resolveProviderConfig,
} from '../../storage/spriteConfigStore.js';
import type { LlmConfigFormData } from '../../storage/spriteConfigStore.js';

// ─── Mock 工厂 ──────────────────────────────────────────

function makeMockConfig(overrides: Partial<Config> = {}): Config {
  return {
    llm: {
      // 配置文件已收敛为 providers+active 单一格式（v1.x 扁平兼容已移除）
      providers: { default: { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test-key', temperature: 0.7 } },
      active: 'default',
    },
    memory: { dataDir: '~/.memora-sprite/data', maxContextTokens: 120000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
    ...overrides,
  };
}

function makeLlmConfig(overrides: Partial<LlmConfigFormData> = {}): LlmConfigFormData {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-new-key',
    temperature: 0.5,
    ...overrides,
  };
}

// ─── SpriteConfigStore ──────────────────────────────────

describe('SpriteConfigStore', () => {
  let store: SpriteConfigStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new SpriteConfigStore('/mock/config.json');
  });

  // ─── getPath() ─────────────────────────────────────────

  describe('getPath', () => {
    it('应返回构造时传入的路径', () => {
      expect(store.getPath()).toBe('/mock/config.json');
    });
  });

  // ─── load() ────────────────────────────────────────────

  describe('load', () => {
    it('应委托 loadConfig 并返回配置', async () => {
      const mockConfig = makeMockConfig();
      vi.mocked(loadConfig).mockResolvedValue(mockConfig);

      const result = await store.load();
      expect(result).toBe(mockConfig);
      expect(loadConfig).toHaveBeenCalledWith('/mock/config.json');
    });

    it('loadConfig 抛错时应向上传播', async () => {
      vi.mocked(loadConfig).mockRejectedValue(new Error('ENOENT'));

      await expect(store.load()).rejects.toThrow('ENOENT');
    });
  });

  // ─── loadOrDefault() ───────────────────────────────────

  describe('loadOrDefault', () => {
    it('配置存在时应返回实际配置', async () => {
      const mockConfig = makeMockConfig();
      vi.mocked(loadConfig).mockResolvedValue(mockConfig);

      const result = await store.loadOrDefault();
      expect(result).toBe(mockConfig);
    });

    it('配置文件缺失时应返回 sprite 专属默认配置', async () => {
      vi.mocked(loadConfig).mockRejectedValue(new Error('ENOENT'));

      const result = await store.loadOrDefault();
      expect(result.llm.provider).toBe('mock');
      expect(result.llm.model).toBe('mock-model');
      expect(result.llm.temperature).toBe(0.7);
      expect(result.memory.dataDir).toBe('~/.memora-sprite/data');
      expect(result.security.permission).toBe('owner');
      expect(result.allowedPaths).toEqual([]);
    });

    it('配置加载失败时应记录 warn 日志', async () => {
      vi.mocked(loadConfig).mockRejectedValue(new Error('parse error'));

      await store.loadOrDefault();
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ─── isConfigured() ────────────────────────────────────

  describe('isConfigured', () => {
    it('apiKey 存在且 provider 非 mock 应返回 true', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      expect(await store.isConfigured()).toBe(true);
    });

    it('provider 为 mock 应返回 false', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig({
        llm: { provider: 'mock', model: 'mock-model', apiKey: 'sk-test', temperature: 0.7 },
      }));

      expect(await store.isConfigured()).toBe(false);
    });

    it('apiKey 为空应返回 false', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig({
        llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '', temperature: 0.7 },
      }));

      expect(await store.isConfigured()).toBe(false);
    });

    it('配置文件缺失应返回 false（不抛错）', async () => {
      vi.mocked(loadConfig).mockRejectedValue(new Error('ENOENT'));

      expect(await store.isConfigured()).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });

  // ─── save() ────────────────────────────────────────────

  describe('save', () => {
    it('应合并写入并创建目录', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig());

      // 使用 resolve 计算期望路径，兼容 Windows（resolve('/mock/config.json', '..') → 'E:\mock'）与 POSIX
      expect(mkdir).toHaveBeenCalledWith(resolve('/mock/config.json', '..'), { recursive: true });
      expect(writeFile).toHaveBeenCalledTimes(1);
      const [path, content] = vi.mocked(writeFile).mock.calls[0];
      expect(path).toBe('/mock/config.json');
      const parsed = JSON.parse(content as string);
      // 单配置表单收敛到 providers['default'] 单一格式
      expect(parsed.llm.providers.default.provider).toBe('openai');
      expect(parsed.llm.providers.default.apiKey).toBe('sk-new-key');
      expect(parsed.llm.active).toBe('default');
    });

    it('应以 0600 权限写入（保护 apiKey）', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig());

      const [, , options] = vi.mocked(writeFile).mock.calls[0];
      expect(options).toMatchObject({ encoding: 'utf-8', mode: 0o600 });
    });

    it('应保留现有的 memory/security/allowedPaths 字段', async () => {
      const existing = makeMockConfig({
        memory: { dataDir: '/custom/data', maxContextTokens: 200000 },
        security: { permission: 'guest', confirmWrites: true },
        allowedPaths: ['/custom/path'],
      });
      vi.mocked(loadConfig).mockResolvedValue(existing);

      await store.save(makeLlmConfig());

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.memory.dataDir).toBe('/custom/data');
      expect(parsed.security.permission).toBe('guest');
      expect(parsed.allowedPaths).toEqual(['/custom/path']);
    });

    it('应保留现有的 providers/active 字段（多 Provider 管理）', async () => {
      const existing = makeMockConfig({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'sk-old',
          temperature: 0.7,
          providers: { deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-1' } },
          active: 'deepseek',
        },
      });
      vi.mocked(loadConfig).mockResolvedValue(existing);

      await store.save(makeLlmConfig());

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.providers).toBeDefined();
      expect(parsed.llm.providers.deepseek.apiKey).toBe('sk-1');
      expect(parsed.llm.active).toBe('deepseek');
    });

    it('background.enabled=true 时应写入 background 配置', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig({
        background: {
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-bg-key',
        },
      }));

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.background).toBeDefined();
      expect(parsed.llm.background.provider).toBe('openai');
      expect(parsed.llm.background.temperature).toBe(0.5);
    });

    it('background.enabled=false 时不应写入 background 配置', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig({
        background: {
          enabled: false,
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: '',
          apiKey: '',
        },
      }));

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.background).toBeUndefined();
    });

    it('temperature 缺失时应使用现有值', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig({ temperature: undefined }));

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.providers.default.temperature).toBe(0.7);
    });

    it('temperature 缺失且现有值也缺失时应默认 0.7', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig({
        llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-test', temperature: undefined },
      }));

      await store.save(makeLlmConfig({ temperature: undefined }));

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.providers.default.temperature).toBe(0.7);
    });

    it('传入 embeddingConfig 时应写入 embedding 字段', async () => {
      vi.mocked(loadConfig).mockResolvedValue(makeMockConfig());

      await store.save(makeLlmConfig(), { model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1' });

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.embedding).toBeDefined();
      expect(parsed.embedding.model).toBe('text-embedding-3-small');
    });
  });

  // ─── saveProviders() ───────────────────────────────────

  describe('saveProviders', () => {
    it('应写入 providers 映射表和 active 别名', async () => {
      const existing = makeMockConfig();
      const providers = {
        deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-1', temperature: 0.7 },
        openai: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-2', temperature: 0.5 },
      };

      await store.saveProviders(providers, 'openai', existing);

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.providers).toEqual(providers);
      expect(parsed.llm.active).toBe('openai');
    });

    it('active 不在 providers 中时仍应写入给定的 providers 映射与 active（不写扁平字段）', async () => {
      const existing = makeMockConfig();
      const providers = {
        openai: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-2' },
      };

      await store.saveProviders(providers, 'nonexistent', existing);

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      expect(parsed.llm.providers).toEqual(providers);
      expect(parsed.llm.active).toBe('nonexistent');
      // 配置文件已收敛为 providers+active 单一格式，不再写扁平 llm.provider 等字段
      expect(parsed.llm.provider).toBeUndefined();
    });

    it('Provider 缺失 temperature 时应回退到 existing 同 key 值', async () => {
      const existing = makeMockConfig(); // providers.default.temperature = 0.7
      const providers = {
        default: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-2' }, // 同 key 'default'，缺 temperature
      };

      await store.saveProviders(providers, 'default', existing);

      const parsed = JSON.parse(vi.mocked(writeFile).mock.calls[0][1] as string);
      // 新 providers.default 缺失 temperature，应回退到 existing.default.temperature
      expect(parsed.llm.providers.default.temperature).toBe(0.7);
    });
  });
});

// ─── resolveProviderConfig() ────────────────────────────

describe('resolveProviderConfig', () => {
  it('新格式：应从 providers 映射表读取', () => {
    const config = makeMockConfig({
      llm: {
        provider: 'mock',
        model: '',
        apiKey: '',
        temperature: 0.7,
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-1', temperature: 0.7 },
        },
      },
    });

    const result = resolveProviderConfig(config, 'deepseek');
    expect(result?.provider).toBe('deepseek');
    expect(result?.apiKey).toBe('sk-1');
  });

  it('新格式：key 不存在时应返回 undefined', () => {
    const config = makeMockConfig({
      llm: {
        provider: 'mock',
        model: '',
        apiKey: '',
        temperature: 0.7,
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-1' },
        },
      },
    });

    expect(resolveProviderConfig(config, 'nonexistent')).toBeUndefined();
  });

  it('旧格式：key 非 default 时不应回退', () => {
    const config = makeMockConfig({
      llm: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'sk-old',
        temperature: 0.7,
      },
    });

    expect(resolveProviderConfig(config, 'custom')).toBeUndefined();
  });

  it('新格式优先于旧格式', () => {
    const config = makeMockConfig({
      llm: {
        provider: 'old-provider',
        model: 'old-model',
        apiKey: 'sk-old',
        temperature: 0.7,
        providers: {
          new: { provider: 'new-provider', model: 'new-model', apiKey: 'sk-new' },
        },
      },
    });

    const result = resolveProviderConfig(config, 'new');
    expect(result?.provider).toBe('new-provider');
    expect(result?.apiKey).toBe('sk-new');
  });
});
