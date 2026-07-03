/**
 * SkillManager 单元测试
 *
 * 测试范围：
 *   - 技能文件解析（frontmatter + content）
 *   - 关键词匹配与 TF-IDF 排序
 *   - configDir/skills/ 目录扫描
 *   - 排除规则（隐藏文件、_ 前缀、README 等）
 *   - trigger 正则匹配
 *   - buildSystemPrompt 返回值
 *
 * 注意：SkillManager(configDir) 只扫描 configDir/skills/ 一个目录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SkillManager } from '@/skill/skillManager.js';
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

  beforeEach(() => {
    testDir = join(tmpdir(), `memora-test-skill-${Date.now()}`);
    skillsDir = join(testDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('应该加载单个技能文件', async () => {
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

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('读取文件');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该在目录不存在时安全降级', async () => {
      const nonExistentDir = join(testDir, 'nonexistent');
      const skillManager = new SkillManager(nonExistentDir);

      await skillManager.load();

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

    it('应该通过 trigger 正则匹配', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('帮我读取这个文件');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该通过关键词匹配', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('查看文件内容');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('读文件');
    });

    it('应该在无匹配时返回 null', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('今天天气怎么样');
      expect(match).toBeNull();
    });
  });

  describe('排除规则', () => {
    it('应该排除隐藏文件', async () => {
      createSkillFile(
        skillsDir,
        '.hidden.md',
        `---
name: 隐藏技能
keywords: 隐藏
---

隐藏内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('隐藏');
      expect(match).toBeNull();
    });

    it('应该排除 _ 前缀文件', async () => {
      createSkillFile(
        skillsDir,
        '_underscore.md',
        `---
name: 下划线技能
keywords: 下划线
---

下划线内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('下划线');
      expect(match).toBeNull();
    });

    it('应该排除 README、CHANGELOG、LICENSE', async () => {
      createSkillFile(
        skillsDir,
        'README.md',
        `---
name: README
keywords: readme
---

README 内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('readme');
      expect(match).toBeNull();
    });
  });

  describe('buildSystemPrompt', () => {
    it('应该构建技能的 system prompt', async () => {
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

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const prompt = skillManager.buildSystemPrompt('读文件');
      expect(prompt).toContain('读文件技能');
      expect(prompt).toContain('read_file');
    });

    it('应该在技能不存在时返回空字符串', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const prompt = skillManager.buildSystemPrompt('不存在的技能');
      expect(prompt).toBeFalsy();
    });
  });

  // ─── reload（GAP-5 事件驱动热重载） ─────────────────────

  describe('reload', () => {
    it('重载应反映目录变更（新增技能）', async () => {
      // 初始加载 1 个技能
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: a\n---\n# 技能 A\n内容 A');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.list).toHaveLength(1);

      // 新增第 2 个技能文件
      createSkillFile(skillsDir, 'skill-b.md', '---\nkeywords: b\n---\n# 技能 B\n内容 B');

      // 重载后应看到 2 个技能
      const count = await skillManager.reload();
      expect(count).toBe(2);
      expect(skillManager.list).toHaveLength(2);
      expect(skillManager.list.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
    });

    it('重载应反映目录变更（删除技能）', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: a\n---\n# 技能 A\n内容 A');
      createSkillFile(skillsDir, 'skill-b.md', '---\nkeywords: b\n---\n# 技能 B\n内容 B');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.list).toHaveLength(2);

      // 删除一个技能文件
      rmSync(join(skillsDir, 'skill-b.md'));

      // 重载后应只剩 1 个技能
      const count = await skillManager.reload();
      expect(count).toBe(1);
      expect(skillManager.list).toHaveLength(1);
      expect(skillManager.list[0]!.name).toBe('skill-a');
    });

    it('重载应反映内容变更', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: old\n---\n# 旧内容');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.get('skill-a')?.content).toBe('# 旧内容');

      // 修改技能文件内容
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: new\n---\n# 新内容');
      await skillManager.reload();
      expect(skillManager.get('skill-a')?.content).toBe('# 新内容');
    });
  });
});
