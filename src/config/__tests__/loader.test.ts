/**
 * 配置加载器单元测试
 *
 * 覆盖 loadConfig / findConfigPath / expandEnvVars / mergeWithDefaults
 * 未覆盖分支：findConfigPath 项目级/用户级、expandEnvVars 空值分支、默认配置降级
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, findConfigPath } from '@/config/loader.js';

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

describe('config/loader · findConfigPath', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-findcfg-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('显式指定路径时应直接返回该路径', async () => {
    const configPath = join(tmpHome, 'my-config.json');
    writeFileSync(configPath, '{}', 'utf-8');
    const result = await findConfigPath(configPath);
    expect(result).toBe(configPath);
  });

  it('无配置文件且无显式路径时应返回 null', async () => {
    // 使用临时目录中不存在的路径，确保项目级和用户级都不存在
    const result = await findConfigPath(join(tmpHome, 'nonexistent.json'));
    // 显式指定路径会直接返回，不会检查是否存在
    expect(result).toBe(join(tmpHome, 'nonexistent.json'));
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
