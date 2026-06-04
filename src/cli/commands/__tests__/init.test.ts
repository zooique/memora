/**
 * init 命令测试
 * 覆盖：默认骨架生成 + 领域模板生成（--domain）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initCommand } from '@/cli/commands/init.js';

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

  // ── 默认模式（无 --domain） ───────────────────

  it('应该创建 .memora 目录及子目录', async () => {
    await initCommand({ project: projectPath });

    const memoraDir = join(projectPath, '.memora');
    expect(existsSync(memoraDir)).toBe(true);
    expect(existsSync(join(memoraDir, 'identities'))).toBe(true);
    expect(existsSync(join(memoraDir, 'rules'))).toBe(true);
    expect(existsSync(join(memoraDir, 'skills'))).toBe(true);
    expect(existsSync(join(memoraDir, 'tools'))).toBe(true);
    expect(existsSync(join(memoraDir, 'topics'))).toBe(true);
    expect(existsSync(join(memoraDir, 'archive'))).toBe(true);
    expect(existsSync(join(memoraDir, 'logs'))).toBe(true);
  });

  it('应该写入默认人格记忆（通过 FileStore）', async () => {
    await initCommand({ project: projectPath });

    const personalityPath = join(projectPath, '.memora', 'identities', 'default.md');
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

  // ── 领域模板模式（--domain） ──────────────────

  it('--domain code 应该生成 agent-config/ 目录结构', async () => {
    await initCommand({ project: projectPath, domain: 'code' });

    const configDir = join(projectPath, 'agent-config');
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, 'identities'))).toBe(true);
    expect(existsSync(join(configDir, 'rules'))).toBe(true);
    expect(existsSync(join(configDir, 'skills'))).toBe(true);
    expect(existsSync(join(configDir, 'tools'))).toBe(true);
  });

  it('--domain code 应该生成包含 Memora 人格的 identities/code.md', async () => {
    await initCommand({ project: projectPath, domain: 'code' });

    const personalityPath = join(projectPath, 'agent-config', 'identities', 'code.md');
    expect(existsSync(personalityPath)).toBe(true);
    const content = readFileSync(personalityPath, 'utf-8');
    expect(content).toContain('Memora');
    expect(content).toContain('AI 编程助手');
  });

  it('--domain code 应该生成规则记忆', async () => {
    await initCommand({ project: projectPath, domain: 'code' });

    const rulesDir = join(projectPath, 'agent-config', 'rules');
    const safetyRulePath = join(rulesDir, '安全底线.md');
    const styleRulePath = join(rulesDir, '代码规范.md');
    // 至少有一条规则
    expect(existsSync(safetyRulePath) || existsSync(styleRulePath)).toBe(true);
  });

  it('--domain code 应该生成 agentBridge.js', async () => {
    await initCommand({ project: projectPath, domain: 'code' });

    const bridgePath = join(projectPath, 'src', 'agentBridge.js');
    expect(existsSync(bridgePath)).toBe(true);
    const content = readFileSync(bridgePath, 'utf-8');
    expect(content).toContain('import { Agent }');
    expect(content).toContain("provider: 'deepseek'");
    expect(content).toContain('YOUR_API_KEY_HERE');
  });

  it('--domain code 应该生成 .memora/ 运行时目录', async () => {
    await initCommand({ project: projectPath, domain: 'code' });

    const memoraDir = join(projectPath, '.memora');
    expect(existsSync(memoraDir)).toBe(true);
    expect(existsSync(join(memoraDir, 'config.json'))).toBe(true);
  });

  it('--domain novel 应该生成包含"墨羽"人格的配置', async () => {
    await initCommand({ project: projectPath, domain: 'novel' });

    const personalityPath = join(projectPath, 'agent-config', 'identities', 'novel.md');
    expect(existsSync(personalityPath)).toBe(true);
    const content = readFileSync(personalityPath, 'utf-8');
    expect(content).toContain('墨羽');
    expect(content).toContain('小说创作');
  });

  it('--domain novel 应该生成文风/角色/情节规则', async () => {
    await initCommand({ project: projectPath, domain: 'novel' });

    const rulesDir = join(projectPath, 'agent-config', 'rules');
    // novel 模板有 3 条规则
    const styleRule = join(rulesDir, '文风一致性.md');
    const charRule = join(rulesDir, '角色人设保护.md');
    const plotRule = join(rulesDir, '情节连续性.md');
    expect(existsSync(styleRule)).toBe(true);
    expect(existsSync(charRule)).toBe(true);
    expect(existsSync(plotRule)).toBe(true);
  });

  it('--domain novel 应该生成技能记忆', async () => {
    await initCommand({ project: projectPath, domain: 'novel' });

    const skillsDir = join(projectPath, 'agent-config', 'skills');
    expect(existsSync(join(skillsDir, '创建角色.md'))).toBe(true);
    expect(existsSync(join(skillsDir, '情节回顾.md'))).toBe(true);
  });

  it('--domain unknown 应该抛出错误', async () => {
    await expect(initCommand({ project: projectPath, domain: 'invalid' })).rejects.toThrow(
      '未知领域',
    );
  });

  // ── 默认模式与领域模式隔离 ──────────────────

  it('默认模式不应生成 agent-config/ 目录', async () => {
    await initCommand({ project: projectPath });

    const configDir = join(projectPath, 'agent-config');
    expect(existsSync(configDir)).toBe(false);
  });

  it('默认模式不应生成 agentBridge.js', async () => {
    await initCommand({ project: projectPath });

    const bridgePath = join(projectPath, 'src', 'agentBridge.js');
    expect(existsSync(bridgePath)).toBe(false);
  });
});
