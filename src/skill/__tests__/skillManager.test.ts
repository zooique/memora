/**
 * SkillManager 单元测试
 *
 * 测试范围：
 *   - 技能文件解析（frontmatter + content）
 *   - 关键词匹配与 TF-IDF 排序
 *   - 两层目录扫描（Agent 级 + 项目级）
 *   - 排除规则（隐藏文件、_ 前缀、README 等）
 *   - trigger 正则匹配
 *   - buildSystemPrompt 返回值
 *
 * 注意：SkillManager(configDir, globalDir)
 *   - configDir = 项目根目录（扫描 configDir/skills/）
 *   - globalDir = Agent 级技能目录（直接扫描该目录）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillManager } from '../skillManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * 辅助函数：创建技能文件
 */
const createSkillFile = (dir: string, filename: string, content: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf-8');
};

describe('SkillManager', () => {
  let testDir: string;
  /** 技能文件放在 testDir/skills/ 下 */
  let skillsDir: string;
  /** 不存在的 Agent 级目录，防止扫描真实 ~/.memora/global/skills/ */
  let fakeAgentDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `memora-test-skill-${Date.now()}`);
    skillsDir = join(testDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    fakeAgentDir = join(testDir, 'fake-agent-skills');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('应该加载单个技能文件', () => {
      // Given - 文件放在 testDir/skills/ 下
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
trigger: /读取|打开|查看.*文件/i
keywords: 文件,读取,打开
---

# 读文件技能

当用户需要读取文件时，使用 read_file 工具。`,
      );

      // configDir=testDir → 扫描 testDir/skills/
      // globalDir=fakeAgentDir → 不存在，跳过
      const skillManager = new SkillManager(testDir, fakeAgentDir);

      // When
      skillManager.load();

      // Then
      const match = skillManager.match('读取文件');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该在目录不存在时安全降级', () => {
      // Given
      const nonExistentDir = join(testDir, 'nonexistent');
      const skillManager = new SkillManager(nonExistentDir, fakeAgentDir);

      // When
      skillManager.load();

      // Then
      const match = skillManager.match('任意输入');
      expect(match).toBeNull();
    });
  });

  describe('match', () => {
    beforeEach(() => {
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
trigger: /读取|打开|查看.*文件/i
keywords: 文件,读取,打开
---

# 读文件技能

当用户需要读取文件时，使用 read_file 工具。`,
      );
    });

    it('应该通过 trigger 正则匹配', () => {
      // Given
      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('帮我读取这个文件');

      // Then
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该通过关键词匹配', () => {
      // Given
      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('查看文件内容');

      // Then
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该在无匹配时返回 null', () => {
      // Given
      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('今天天气怎么样');

      // Then
      expect(match).toBeNull();
    });
  });

  describe('两层目录覆盖', () => {
    it('项目级技能应覆盖 Agent 级同名技能', () => {
      // Given
      const agentDir = join(testDir, 'agent-skills');
      const projectSkillsDir = join(testDir, 'project-skills');

      // Agent 级技能
      createSkillFile(
        agentDir,
        'read-file.md',
        `---
name: 读文件
keywords: 文件,读取
---

# Agent 级读文件

基础读文件技能。`,
      );

      // 项目级技能（覆盖 Agent 级）
      createSkillFile(
        projectSkillsDir,
        'read-file.md',
        `---
name: 读文件
keywords: 文件,读取,章节
---

# 项目级读文件

章节读文件技能（带 frontmatter 元信息）。`,
      );

      // globalDir=agentDir（Agent 级直接扫描该目录）
      // configDir 的父目录，让 scanDir 扫描 projectSkillsDir
      // 但 configDir 拼接的是 configDir/skills/
      // 所以需要把 projectSkillsDir 放在 testDir2/skills/ 下
      const testDir2 = join(testDir, 'project-root');
      const testDir2Skills = join(testDir2, 'skills');
      mkdirSync(testDir2Skills, { recursive: true });
      writeFileSync(
        join(testDir2Skills, 'read-file.md'),
        `---
name: 读文件
keywords: 文件,读取,章节
---

# 项目级读文件

章节读文件技能（带 frontmatter 元信息）。`,
        'utf-8',
      );

      const skillManager = new SkillManager(testDir2, agentDir);

      // When
      skillManager.load();

      // Then - 项目级应覆盖 Agent 级
      const match = skillManager.match('读取文件');
      expect(match).not.toBeNull();
      expect(match!.skill.content).toContain('项目级读文件');
    });
  });

  describe('排除规则', () => {
    it('应该排除隐藏文件', () => {
      // Given
      createSkillFile(
        skillsDir,
        '.hidden.md',
        `---
name: 隐藏技能
keywords: 隐藏
---

隐藏内容`,
      );

      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('隐藏');

      // Then
      expect(match).toBeNull();
    });

    it('应该排除 _ 前缀文件', () => {
      // Given
      createSkillFile(
        skillsDir,
        '_underscore.md',
        `---
name: 下划线技能
keywords: 下划线
---

下划线内容`,
      );

      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('下划线');

      // Then
      expect(match).toBeNull();
    });

    it('应该排除 README、CHANGELOG、LICENSE', () => {
      // Given
      createSkillFile(
        skillsDir,
        'README.md',
        `---
name: README
keywords: readme
---

README 内容`,
      );

      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const match = skillManager.match('readme');

      // Then
      expect(match).toBeNull();
    });
  });

  describe('buildSystemPrompt', () => {
    it('应该构建技能的 system prompt', () => {
      // Given
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
keywords: 文件,读取
---

# 读文件技能

当用户需要读取文件时，使用 read_file 工具。`,
      );

      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const prompt = skillManager.buildSystemPrompt('读文件');

      // Then
      expect(prompt).toContain('读文件技能');
      expect(prompt).toContain('read_file');
    });

    it('应该在技能不存在时返回空字符串', () => {
      // Given
      const skillManager = new SkillManager(testDir, fakeAgentDir);
      skillManager.load();

      // When
      const prompt = skillManager.buildSystemPrompt('不存在的技能');

      // Then
      expect(prompt).toBeFalsy();
    });
  });
});
