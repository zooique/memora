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
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-test123' },
          },
          active: 'deepseek',
        },
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
    expect(config.llm.providers!.deepseek!.model).toBe('deepseek-chat');
  });

  it('显式指定 configPath 时应遮蔽 apiKey', async () => {
    // 注意：expandEnvVars 不遮蔽，遮蔽由 cli/commands/config 的 mask 函数负责
    const configPath = writeConfig(tmpHome);
    const config = await loadConfig(configPath);
    // apiKey 从文件读取，非 ${ENV} 格式 → 保留原值
    expect(config.llm.providers!.deepseek!.apiKey).toBe('sk-test123');
  });

  it('temperature 超出 0-2 范围时应抛错（校验器分支）', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: {
        providers: { deepseek: { provider: 'deepseek', model: 'm', apiKey: 'k', temperature: 3 } },
        active: 'deepseek',
      },
    });
    await expect(loadConfig(configPath)).rejects.toThrow('temperature');
  });

  it('maxContextTokens 超出上下限时应抛错', async () => {
    const configPath = writeConfig(tmpHome, {
      memory: { dataDir: '~/.memora', maxContextTokens: 10 ** 9 },
    });
    await expect(loadConfig(configPath)).rejects.toThrow('maxContextTokens');
  });

  it('security.permission 为非法值时应抛错', async () => {
    const configPath = writeConfig(tmpHome, {
      security: { permission: 'hacker', confirmWrites: true, allowedPaths: [] },
    });
    await expect(loadConfig(configPath)).rejects.toThrow('permission');
  });

  it('apiKey 为 ${ENV_VAR} 格式时应展开为环境变量', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: {
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '${MEMORA_TEST_KEY}' },
        },
        active: 'deepseek',
      },
    });
    process.env.MEMORA_TEST_KEY = 'env-key-123';
    try {
      const config = await loadConfig(configPath);
      expect(config.llm.providers!.deepseek!.apiKey).toBe('env-key-123');
    } finally {
      delete process.env.MEMORA_TEST_KEY;
    }
  });

  it('apiKey 为 undefined 时 expandEnvVars 应保留 undefined', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: {
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
        },
        active: 'deepseek',
      },
    });
    // 不传 apiKey 字段
    const config = await loadConfig(configPath);
    expect(config.llm.providers!.deepseek!.apiKey).toBeUndefined();
  });

  it('显式指定不存在的 configPath 时应抛错', async () => {
    // 显式指定不存在的路径 → readFile 抛 ENOENT
    await expect(loadConfig(join(tmpHome, 'nonexistent.json'))).rejects.toThrow();
  });

  it('${ENV_VAR} 环境变量不存在时应替换为空字符串', async () => {
    const configPath = writeConfig(tmpHome, {
      llm: {
        providers: {
          deepseek: {
            provider: 'deepseek',
            model: 'deepseek-chat',
            apiKey: '${NONEXISTENT_ENV_VAR_12345}',
          },
        },
        active: 'deepseek',
      },
    });
    // 确保环境变量不存在
    delete process.env.NONEXISTENT_ENV_VAR_12345;
    const config = await loadConfig(configPath);
    expect(config.llm.providers!.deepseek!.apiKey).toBe('');
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
        llm: {
          providers: {
            project: { provider: 'project-level', model: 'pro-model', apiKey: 'sk-pro' },
          },
          active: 'project',
        },
      }),
      'utf-8',
    );

    // Mock process.cwd 指向项目目录
    process.cwd = () => projectDir;

    const config = await loadConfig();
    expect(config.llm.providers!.project!.provider).toBe('project-level');
    expect(config.llm.providers!.project!.model).toBe('pro-model');
  });
});

// ─── K3：多 Provider + schema 校验 + 回退降级 ──

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
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
          },
          active: 'deepseek',
        },
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

    it('providers 未配置时 providers 为 undefined', async () => {
      // providers 是唯一配置格式，未配置时 llm.providers 为 undefined（无回退）
      const configPath = writeConfigFile({ llm: {} });

      const config = await loadConfig(configPath);

      expect(config.llm.providers).toBeUndefined();
    });
  });

  describe('schema 校验', () => {
    it('providers 内 temperature=0 应通过（边界值）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', temperature: 0 },
          },
          active: 'deepseek',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers!.deepseek!.temperature).toBe(0);
    });

    it('providers 内 temperature=2 应通过（边界值）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', temperature: 2 },
          },
          active: 'deepseek',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers!.deepseek!.temperature).toBe(2);
    });

    it('providers 内 temperature>2 时应抛错（校验失败）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', temperature: 3 },
          },
          active: 'deepseek',
        },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('providers 内 temperature<0 时应抛错（校验失败）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat', temperature: -0.5 },
          },
          active: 'deepseek',
        },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('permission 非 owner/guest 时应抛错', async () => {
      const configPath = writeConfigFile({
        security: { permission: 'admin' },
      });

      await expect(loadConfig(configPath)).rejects.toThrow();
    });

    it('providers 内未配置 temperature 时应为 undefined（无全局默认）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
          },
          active: 'deepseek',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers!.deepseek!.temperature).toBeUndefined();
    });

    it('默认 maxContextTokens 应为 120000', async () => {
      const configPath = writeConfigFile();

      const config = await loadConfig(configPath);

      expect(config.memory.maxContextTokens).toBe(120_000);
    });

    // ─── 能力位三态保真：仅未配置回落默认，显式 true/false 如实透传 ──
    it('supportsToolCalling 显式 false 应保真透传（本地 LLM 关工具通道）', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            local: {
              provider: 'ollama',
              model: 'qwen2.5-coder',
              supportsToolCalling: false,
              supportsStructuredOutput: false,
            },
          },
          active: 'local',
        },
      });

      const config = await loadConfig(configPath);

      // 显式 false 必须如实保留，不得被下游 `?? true` 静默回滚为 true
      expect(config.llm.providers!.local!.supportsToolCalling).toBe(false);
      expect(config.llm.providers!.local!.supportsStructuredOutput).toBe(false);
    });

    it('supportsToolCalling 显式 true 应保真透传', async () => {
      const configPath = writeConfigFile({
        llm: {
          providers: {
            cloud: {
              provider: 'deepseek',
              model: 'deepseek-chat',
              supportsToolCalling: true,
              supportsStructuredOutput: true,
            },
          },
          active: 'cloud',
        },
      });

      const config = await loadConfig(configPath);

      expect(config.llm.providers!.cloud!.supportsToolCalling).toBe(true);
      expect(config.llm.providers!.cloud!.supportsStructuredOutput).toBe(true);
    });

    it('能力位未配置时应为 undefined（交给下游 Provider 回落默认）', async () => {
      const configPath = writeConfigFile();

      const config = await loadConfig(configPath);

      const provider = config.llm.providers!.deepseek!;
      expect(provider.supportsToolCalling).toBeUndefined();
      expect(provider.supportsStructuredOutput).toBeUndefined();
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
    // 内核只提供机制，不预设厂商/路径策略
    const config = await loadConfig();
    // providers 未预设：由宿主显式配置（mock 通过 providers 显式声明）
    expect(config.llm.providers).toBeUndefined();
    expect(config.llm.active).toBeUndefined();
    // dataDir 留空：由宿主通过 configPath 或显式注入，内核不硬编码路径
    expect(config.memory.dataDir).toBe('');
    expect(config.memory.maxContextTokens).toBe(120_000);
    expect(config.security.permission).toBe('owner');
    expect(config.security.confirmWrites).toBe(false);
    expect(config.allowedPaths).toEqual([]);
  });
});

// ─── 错误路径覆盖（7 条内部校验分支） ───────────────────────────────

describe('config/loader · 错误路径覆盖', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-loader-errors-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 辅助：写入配置文件并返回路径 */
  function writeConfigFile(content: string): string {
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, content, 'utf-8');
    return configPath;
  }

  // ── #1: 畸形 JSON ─────────────────────────────────────────────

  it('畸形 JSON 文件应抛 configError', async () => {
    const configPath = writeConfigFile('{ this is not valid json }');
    await expect(loadConfig(configPath)).rejects.toThrow('配置文件 JSON 格式错误');
  });

  // ── #2: providers 为数组 → 静默降级为 undefined ──

  it('providers 为数组时应静默降级为 undefined', async () => {
    const configPath = writeConfigFile(JSON.stringify({
      llm: { providers: ['not', 'an', 'object'] },
    }));
    const config = await loadConfig(configPath);
    // 数组类型触发早返回，providers 被忽略
    expect(config.llm.providers).toBeUndefined();
  });

  it('providers.<key> 值为数组时应抛 configError', async () => {
    const configPath = writeConfigFile(JSON.stringify({
      llm: {
        providers: {
          bad: ['array', 'value'], // 单个 provider 条目是数组
        },
      },
    }));
    await expect(loadConfig(configPath)).rejects.toThrow('必须是对象');
  });

  // ── #3: providers.<key> 缺 provider 字段 ─────────────────────

  it('providers.<key> 缺 provider 字段时应抛 configError', async () => {
    const configPath = writeConfigFile(JSON.stringify({
      llm: {
        providers: {
          bad: { model: 'some-model' }, // 缺 provider 字段
        },
      },
    }));
    await expect(loadConfig(configPath)).rejects.toThrow('providers.bad.provider');
  });

  // ── #4: providers.<key> 缺 model 字段 ────────────────────────

  it('providers.<key> 缺 model 字段时应抛 configError', async () => {
    const configPath = writeConfigFile(JSON.stringify({
      llm: {
        providers: {
          bad: { provider: 'deepseek' }, // 缺 model 字段
        },
      },
    }));
    await expect(loadConfig(configPath)).rejects.toThrow('providers.bad.model');
  });

  // ── #6（B0 收编后空位保留）─────────────────────────────
  // 原 #6 为 embedding 缺 model 校验，已随 embedding 段整体移除（2026-09-18 B0 收编），编号不再回填。

  // ── #7: allowedPaths 含非字符串元素 ─────────────────────────

  it('allowedPaths 含非字符串元素时应抛 configError', async () => {
    const configPath = writeConfigFile(JSON.stringify({
      llm: {
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
        },
        active: 'deepseek',
      },
      allowedPaths: ['/valid/path', 123, '/another'], // 第 2 个元素是数字
    }));
    await expect(loadConfig(configPath)).rejects.toThrow('allowedPaths[1]');
  });
});

// ─── 配置边界（防无条件填写导致资源失控） ─────────────────────────────

describe('config/loader · 配置边界校验', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-loader-bounds-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  /** 辅助：写入含 llm.providers 的配置文件 */
  function writeConfig(content: Record<string, unknown>): string {
    const configPath = join(tmpHome, 'config.json');
    writeFileSync(configPath, JSON.stringify(content), 'utf-8');
    return configPath;
  }

  /** 基础 LLM 配置（避免其他字段缺失干扰边界校验） */
  function withProviders(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      llm: {
        providers: {
          deepseek: { provider: 'deepseek', model: 'deepseek-chat' },
        },
        active: 'deepseek',
      },
      ...overrides,
    };
  }

  it('maxContextTokens 低于下限（< 1000）应抛错', async () => {
    const configPath = writeConfig(withProviders({ memory: { maxContextTokens: 500 } }));
    await expect(loadConfig(configPath)).rejects.toThrow('maxContextTokens');
  });

  it('maxContextTokens 超过上限（> 2000000）应抛错', async () => {
    const configPath = writeConfig(withProviders({ memory: { maxContextTokens: 2000001 } }));
    await expect(loadConfig(configPath)).rejects.toThrow('maxContextTokens');
  });

  it('maxContextTokens 合法值应保留', async () => {
    const configPath = writeConfig(withProviders({ memory: { maxContextTokens: 100_000 } }));
    const config = await loadConfig(configPath);
    expect(config.memory.maxContextTokens).toBe(100_000);
  });

  it('allowedPaths 超过 50 条应截断（防白名单膨胀）', async () => {
    const paths = Array.from({ length: 60 }, (_, i) => `/path/${i}`);
    const configPath = writeConfig(withProviders({ allowedPaths: paths }));
    const config = await loadConfig(configPath);
    expect(config.allowedPaths).toHaveLength(50);
  });

  it('contextWindow 只做自身防御（非正数→undefined），正数原样生效（内核不做区间裁决）', async () => {
    // ① 非正数 → undefined（纯自身防御）
    const cfgZero = writeConfig({
      llm: {
        providers: { deepseek: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 0 } },
        active: 'deepseek',
      },
    });
    expect((await loadConfig(cfgZero)).llm.providers!.deepseek!.contextWindow).toBeUndefined();

    // ② 小正数原样生效 —— 旧实现把 <1000 视作越界静默丢弃，该裁决已于 2026-09-18 拍板删除
    //    （内核不替用户裁决「模型能吃多大」；静默替换会造成「UI 显示值 ≠ 真实生效值」）
    const cfgSmall = writeConfig({
      llm: {
        providers: { deepseek: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 100 } },
        active: 'deepseek',
      },
    });
    expect((await loadConfig(cfgSmall)).llm.providers!.deepseek!.contextWindow).toBe(100);
  });
});
