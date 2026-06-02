/**
 * init 命令测试
 * 覆盖目录创建 + 默认记忆写入 + config 拷贝
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand } from '../init.js';

describe('init 命令 · 项目初始化', () => {
  let tmpDir: string;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-init-'));
    projectPath = join(tmpDir, 'test-project');
    mkdirSync(projectPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该创建 .memora 目录及子目录', async () => {
    await initCommand({ project: projectPath });

    const memoraDir = join(projectPath, '.memora');
    expect(existsSync(memoraDir)).toBe(true);
    expect(existsSync(join(memoraDir, 'personality'))).toBe(true);
    expect(existsSync(join(memoraDir, 'rules'))).toBe(true);
    expect(existsSync(join(memoraDir, 'skills'))).toBe(true);
    expect(existsSync(join(memoraDir, 'tools'))).toBe(true);
    expect(existsSync(join(memoraDir, 'topics'))).toBe(true);
    expect(existsSync(join(memoraDir, 'archive'))).toBe(true);
    expect(existsSync(join(memoraDir, 'logs'))).toBe(true);
  });

  it('应该写入默认人格记忆（通过 FileStore）', async () => {
    await initCommand({ project: projectPath });

    const personalityPath = join(projectPath, '.memora', 'personality', 'default.md');
    expect(existsSync(personalityPath)).toBe(true);
    const content = readFileSync(personalityPath, 'utf-8');
    expect(content).toContain('默认人格');
    expect(content).toContain('友好、严谨');
    // FileStore 应该包含 frontmatter
    expect(content).toContain('---');
  });

  it('应该写入默认规则记忆', async () => {
    await initCommand({ project: projectPath });

    const rulePath = join(projectPath, '.memora', 'rules', 'core.md');
    expect(existsSync(rulePath)).toBe(true);
    const content = readFileSync(rulePath, 'utf-8');
    expect(content).toContain('核心规则');
    expect(content).toContain('诚实优先');
  });

  it('应该拷贝 config.example.json 到 .memora/config.json', async () => {
    await initCommand({ project: projectPath });

    const configPath = join(projectPath, '.memora', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.llm).toBeDefined();
    expect(parsed.llm?.provider).toBeDefined();
  });
});
