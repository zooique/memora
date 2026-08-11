/**
 * 配置加载器单元测试
 *
 * 覆盖 loadConfig / expandEnvVars / mergeWithDefaults
 * 未覆盖分支：expandEnvVars 空值分支、默认配置降级
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '@/config/loader.js';

describe('config/loader · loadConfig', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-config-loader-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 辅助：写入临时配置文件 */
  function writeConfig(dir: string, overrides: Record<string, unknown> = {}) {
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-test123' },
        memory: { dataDir: '~/.memora', maxContextTokens: 80000 },
        security: { permission: 'owner', confirmWrites: true },
        allowedPaths: [],
        ...overrides,
      }),
      'utf-8',
    );
    return configPath;
  }

  it('显式指定 configPath 时应加载该文件', async () => {
    const configPath = writeConfig(tmpHome);
    const config = await loadConfig(configPath);
    expect(config.llm.provider).toBe('deepseek');
    expect(config.llm.model).toBe('deepseek-chat');
  });

  it('显式指定 configPath 时应遮蔽 apiKey', async () => {
    // 注意：expandEnvVars 不遮蔽，遮蔽由 cli/commands/config 的 mask 函数负责
    const configPath = writeConfig(tmpHome);
    const config = await loadConfig(configPath);
    // apiKey 从文件读取，非 ${ENV} 格式 → 保留原值
    expect(config.llm.apiKey).toBe('sk-test123');
  });

  it('apiKey 为 ${ENV_VAR} 格式时应展开为环境变量', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '${MEMORA_TEST_KEY}' },
    });
    process.env.MEMORA_TEST_KEY = 'env-key-123';
    try {
      const config = await loadConfig(configPath);
      expect(config.llm.apiKey).toBe('env-key-123');
    } finally {
      delete process.env.MEMORA_TEST_KEY;
    }
  });

  it('apiKey 为 undefined 时 expandEnvVars 应保留 undefined', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: { provider: 'deepseek', model: 'deepseek-chat' },
    });
    // 不传 apiKey 字段
    const config = await loadConfig(configPath);
    expect(config.llm.apiKey).toBeUndefined();
  });

  it('显式指定不存在的 configPath 时应抛错', async () => {
    // 显式指定不存在的路径 → readFile 抛 ENOENT
    await expect(loadConfig(join(tmpHome, 'nonexistent.json'))).rejects.toThrow();
  });

  it('${ENV_VAR} 环境变量不存在时应替换为空字符串', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: '${NONEXISTENT_ENV_VAR_12345}',
      },
    });
    // 确保环境变量不存在
    delete process.env.NONEXISTENT_ENV_VAR_12345;
    const config = await loadConfig(configPath);
    expect(config.llm.apiKey).toBe('');
  });
});

describe('config/loader · 项目级/用户级配置回退', () => {
  let tmpHome: string;
  let originalCwd: () => string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-fallback-'));
    // 保存原始 cwd
    originalCwd = process.cwd;
  });

  afterEach(() => {
    process.cwd = originalCwd;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('不传显式路径时应加载项目级配置', async () => {
    // 创建项目级配置
    const projectDir = join(tmpHome, 'my-project');
    mkdirSync(join(projectDir, '.memora'), { recursive: true });
    writeFileSync(
      join(projectDir, '.memora', 'config.json'),
      JSON.stringify({
        llm: { provider: 'project-level', model: 'pro-model', apiKey: 'sk-pro' },
      }),
      'utf-8',
    );

    // Mock process.cwd 指向项目目录
    process.cwd = () => projectDir;

    const config = await loadConfig();
    expect(config.llm.provider).toBe('project-level');
    expect(config.llm.model).toBe('pro-model');
  });
});

// ─── K3：多 Provider + background + embedding + schema 校验 + 回退降级 ──

describe('config/loader · K3 多 Provider 与高级配置', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-config-k3-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 辅助：写入配置文件并返回路径 */
  function writeConfigFile(overrides: Record<string, unknown> = {}): string {
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        llm: { provider: 'deepseek', model: 'deepseek-chat' },
        ...overrides,
      }),
      'utf-8',
    );
    return configPath;
  }

  describe('多 Provider 映射表', () => {
    it('配置 providers + active 时应正确解析', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-ds' },
            openai: { provider: 'openai', model: 'gpt-4', apiKey: 'sk-oai' },
          },
          active: 'openai',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers).toBeDefined();
      expect(config.llm.providers!.deepseek!.model).toBe('deepseek-chat');
      expect(config.llm.providers!.openai!.model).toBe('gpt-4');
      expect(config.llm.active).toBe('openai');
    });

    it('providers 中 apiKey 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: {
              provider: 'deepseek',
              model: 'deepseek-chat',
              apiKey: '${K3_PROVIDER_API_KEY}',
            },
          },
        },
      });
      process.env.K3_PROVIDER_API_KEY = 'env-provider-key';
      try {
        const config = await loadConfig(configPath);
        expect(config.llm.providers!.deepseek!.apiKey).toBe('env-provider-key');
      } finally {
        delete process.env.K3_PROVIDER_API_KEY;
      }
    });

    it('providers 中 baseUrl 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            custom: {
              provider: 'custom',
              model: 'mimo',
              baseUrl: '${K3_BASE_URL}',
            },
          },
        },
      });
      process.env.K3_BASE_URL = 'https://api.custom.com/v1';
      try {
        const config = await loadConfig(configPath);
        expect(config.llm.providers!.custom!.baseUrl).toBe('https://api.custom.com/v1');
      } finally {
        delete process.env.K3_BASE_URL;
      }
    });

    it('不配置 providers 时应回退到旧扁平字段（向后兼容）', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-flat' },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers).toBeUndefined();
      expect(config.llm.provider).toBe('deepseek');
      expect(config.llm.apiKey).toBe('sk-flat');
    });
  });

  describe('taskRouter 多模型路由（P1-2）', () => {
    it('配置 taskRouter 时应正确解析', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            fast: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-fast' },
            smart: { provider: 'deepseek', model: 'deepseek-reasoner', apiKey: 'sk-smart' },
          },
          active: 'fast',
          taskRouter: {
            simple: 'fast',
            reasoning: 'smart',
            code: 'smart',
            summary: 'fast',
          },
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.taskRouter).toBeDefined();
      expect(config.llm.taskRouter!.simple).toBe('fast');
      expect(config.llm.taskRouter!.reasoning).toBe('smart');
      expect(config.llm.taskRouter!.code).toBe('smart');
      expect(config.llm.taskRouter!.summary).toBe('fast');
    });

    it('不配置 taskRouter 时应为 undefined（向后兼容）', async () => {
      const configPath = writeConfigFile({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'sk-test',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.taskRouter).toBeUndefined();
    });

    it('taskRouter 为无效类型时应为 undefined', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: { fast: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-fast' } },
          active: 'fast',
          taskRouter: 'invalid', // 字符串类型，非对象
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.taskRouter).toBeUndefined();
    });

    it('taskRouter 中有无效项时应跳过', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: { fast: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-fast' } },
          active: 'fast',
          taskRouter: {
            simple: 'fast',
            reasoning: '', // 空字符串，应跳过
            code: 123,     // 非字符串，应跳过
          },
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.taskRouter).toBeDefined();
      // simple 应保留（有效）
      expect(config.llm.taskRouter!.simple).toBe('fast');
      // reasoning 和 code 应被跳过
      expect(config.llm.taskRouter!.reasoning).toBeUndefined();
      expect(config.llm.taskRouter!.code).toBeUndefined();
    });
  });

  describe('background 后台通道配置', () => {
    it('配置 background 时应正确解析', async () => {
      const configPath = writeConfigFile({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          background: {
            provider: 'doubao',
            model: 'doubao-pro',
            apiKey: 'sk-bg',
            temperature: 0.3,
          },
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.background).toBeDefined();
      expect(config.llm.background!.provider).toBe('doubao');
      expect(config.llm.background!.model).toBe('doubao-pro');
      expect(config.llm.background!.temperature).toBe(0.3);
    });

    it('不配置 background 时应为 undefined（向后兼容）', async () => {
      const configPath = writeConfigFile();

      const config = await loadConfig(configPath);

      expect(config.llm.background).toBeUndefined();
    });

    it('background.temperature 默认值应为 0.5', async () => {
      const configPath = writeConfigFile({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          background: { provider: 'doubao', model: 'doubao-pro' },
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.background!.temperature).toBe(0.5);
    });

    // background 通道环境变量展开
    it('background.apiKey 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          background: {
            provider: 'doubao',
            model: 'doubao-pro',
            apiKey: '${MEMORA_BG_API_KEY}',
          },
        },
      });
      process.env.MEMORA_BG_API_KEY = 'env-bg-key';
      try {
        const config = await loadConfig(configPath);
        expect(config.llm.background!.apiKey).toBe('env-bg-key');
      } finally {
        delete process.env.MEMORA_BG_API_KEY;
      }
    });

    it('background.baseUrl 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          background: {
            provider: 'custom',
            model: 'bg-model',
            baseUrl: '${MEMORA_BG_BASE_URL}',
          },
        },
      });
      process.env.MEMORA_BG_BASE_URL = 'https://bg.api.custom.com/v1';
      try {
        const config = await loadConfig(configPath);
        expect(config.llm.background!.baseUrl).toBe('https://bg.api.custom.com/v1');
      } finally {
        delete process.env.MEMORA_BG_BASE_URL;
      }
    });
  });

  describe('embedding 配置', () => {
    it('配置 embedding 时应正确解析', async () => {
      const configPath = writeConfigFile({
        embedding: { model: 'text-embedding-3-small', apiKey: 'sk-emb' },
      });

      const config = await loadConfig(configPath);

      expect(config.embedding).toBeDefined();
      expect(config.embedding!.model).toBe('text-embedding-3-small');
    });

    it('不配置 embedding 时应为 undefined（降级为关键词召回）', async () => {
      const configPath = writeConfigFile();

      const config = await loadConfig(configPath);

      expect(config.embedding).toBeUndefined();
    });

    // embedding 通道环境变量展开（与 background 同类）
    it('embedding.apiKey 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        embedding: { model: 'text-embedding-3-small', apiKey: '${MEMORA_EMB_API_KEY}' },
      });
      process.env.MEMORA_EMB_API_KEY = 'env-emb-key';
      try {
        const config = await loadConfig(configPath);
        expect(config.embedding!.apiKey).toBe('env-emb-key');
      } finally {
        delete process.env.MEMORA_EMB_API_KEY;
      }
    });

    it('embedding.baseUrl 为 ${ENV} 格式时应展开', async () => {
      const configPath = writeConfigFile({
        embedding: {
          model: 'text-embedding-3-small',
          baseUrl: '${MEMORA_EMB_BASE_URL}',
        },
      });
      process.env.MEMORA_EMB_BASE_URL = 'https://emb.api.custom.com/v1';
      try {
        const config = await loadConfig(configPath);
        expect(config.embedding!.baseUrl).toBe('https://emb.api.custom.com/v1');
      } finally {
        delete process.env.MEMORA_EMB_BASE_URL;
      }
    });
  });

  describe('schema 校验', () => {
    it('temperature=0 应通过（边界值）', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0 },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.temperature).toBe(0);
    });

    it('temperature=2 应通过（边界值）', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat', temperature: 2 },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.temperature).toBe(2);
    });

    it('temperature>2 时应抛错（校验失败）', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat', temperature: 3 },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('temperature<0 时应抛错（校验失败）', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat', temperature: -0.5 },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('permission 非 owner/guest 时应抛错', async () => {
      const configPath = writeConfigFile({
        security: { permission: 'admin' },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('默认 temperature 应为 0.7', async () => {
      const configPath = writeConfigFile({
        llm: { provider: 'deepseek', model: 'deepseek-chat' },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.temperature).toBe(0.7);
    });

    it('默认 maxContextTokens 应为 120000', async () => {
      const configPath = writeConfigFile();

      const config = await loadConfig(configPath);

      expect(config.memory.maxContextTokens).toBe(120_000);
    });
  });
});

describe('config/loader · 默认配置降级', () => {
  let tmpHome: string;
  let originalCwd: () => string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-fallback-k3-'));
    originalCwd = process.cwd;
    // Mock process.cwd 让项目级配置查找失败（指向空目录）
    process.cwd = () => join(tmpHome, 'empty-project');
  });

  afterEach(() => {
    process.cwd = originalCwd;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('项目级不存在时应返回内置默认值（机制不预设策略）', async () => {
    // 内核只提供机制，不预设厂商/路径策略（ADR-002 + ADR-003）
    // model/dataDir 留空：由宿主显式注入，factory.ts 会校验 model 非空
    const config = await loadConfig();
    // provider='mock'：唯一内置机制，无 API Key 时不调用真实 API
    expect(config.llm.provider).toBe('mock');
    // model 留空：内核不预设厂商模型，由宿主显式填充
    expect(config.llm.model).toBe('');
    expect(config.llm.temperature).toBe(0.7);
    // dataDir 留空：由宿主通过 configPath 或显式注入，内核不硬编码路径（ADR-002）
    expect(config.memory.dataDir).toBe('');
    expect(config.memory.maxContextTokens).toBe(120_000);
    expect(config.security.permission).toBe('owner');
    expect(config.security.confirmWrites).toBe(false);
    expect(config.allowedPaths).toEqual([]);
  });
});
