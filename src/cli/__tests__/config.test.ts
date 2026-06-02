/**
 * config 命令测试
 * 覆盖 M-104：show / get / path / 错误场景
 *
 * 不测 edit（需要外部编辑器进程，环境依赖）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configCommand } from '../commands/config.js';

describe('config 命令 · M-104', () => {
  let tmpHome: string;
  let testConfigPath: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'memora-config-cmd-'));
    testConfigPath = join(tmpHome, 'config.json');
    writeFileSync(
      testConfigPath,
      JSON.stringify({
        llm: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          apiKey: 'sk-test123456789abcdef',
          baseUrl: 'https://api.deepseek.com/v1',
        },
        memory: { dataDir: '~/.memora', maxContextTokens: 80000 },
        security: { permission: 'owner', confirmWrites: true },
        allowedPaths: [],
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('show 应该打印配置（敏感字段遮蔽）', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await configCommand('show', [], { config: testConfigPath });
    } finally {
      console.log = orig;
    }
    const out = logs.join('\n');
    expect(out).toContain('当前生效配置');
    expect(out).toContain('llm:');
    expect(out).toContain('provider: "deepseek"');
    // apiKey 遮蔽（mask 函数：前 3 + *** + 后 3 = sk-***def）
    expect(out).toContain('"sk-***');
    // 不应暴露完整 key
    expect(out).not.toContain('sk-test123456789abcdef');
  });

  it('get <key> 应该返回字段值', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await configCommand('get', ['llm.provider'], { config: testConfigPath });
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toContain('"deepseek"');
  });

  it('get 应该遮蔽敏感字段', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await configCommand('get', ['llm.apiKey'], { config: testConfigPath });
    } finally {
      console.log = orig;
    }
    const out = logs.join('\n');
    expect(out).toMatch(/sk-\*\*\*/);
    expect(out).not.toContain('sk-test123456789abcdef');
  });

  it('get 不存在的字段应该抛 MemoraError', async () => {
    await expect(
      configCommand('get', ['nonexistent.field'], { config: testConfigPath }),
    ).rejects.toThrow(/配置项不存在/);
  });

  it('get 缺少 key 参数应该抛 MemoraError', async () => {
    await expect(configCommand('get', [], { config: testConfigPath })).rejects.toThrow(
      /缺少 key 参数/,
    );
  });

  it('path 应该返回配置文件路径', async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => logs.push(String(msg));
    try {
      await configCommand('path', [], { config: testConfigPath });
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toContain(testConfigPath);
  });
});
