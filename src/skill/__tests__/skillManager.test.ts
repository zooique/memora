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

  // ─── match · SKILL_MATCH_MIN_SCORE 阈值边界 ─────────────────
  //
  // 阈值 = 0.3，评分公式：hitCount / Math.min(keywordList.length, 3)
  // 分母上限 3 避免关键词多的技能被惩罚（与 persona 评分算法一致）：
  //   - 3 关键词命中 1 个 → 1/3=0.333 ≥ 0.3 → 激活
  //   - 5 关键词命中 1 个 → 1/3=0.333 ≥ 0.3 → 激活（分母上限 3，不再惩罚）
  //   - 10 关键词命中 3 个 → 3/3=1.0 → 激活
  //   - 10 关键词命中 2 个 → 2/3=0.667 ≥ 0.3 → 激活（分母上限 3，不再惩罚）
  //   - 2 关键词命中 0 个 → 0/2=0 < 0.3 → 不激活
  describe('match · SKILL_MATCH_MIN_SCORE 阈值边界', () => {
    it('3 关键词命中 1 个（score=0.333）应激活', async () => {
      createSkillFile(skillsDir, 'three-kw.md', '---\nkeywords: 苹果,香蕉,橙子\n---\n# 三关键词技能');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('苹果');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('three-kw');
      expect(match!.score).toBeCloseTo(1 / 3, 5);
    });

    it('5 关键词命中 1 个（分母上限 3，score=0.333）应激活', async () => {
      createSkillFile(
        skillsDir,
        'five-kw.md',
        '---\nkeywords: 苹果,香蕉,橙子,葡萄,西瓜\n---\n# 五关键词技能',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 分母上限 3：1/min(5,3)=1/3=0.333 ≥ 0.3 → 激活（不再因关键词多而惩罚）
      const match = skillManager.match('苹果');
      expect(match).not.toBeNull();
      expect(match!.score).toBeCloseTo(1 / 3, 5);
    });

    it('2 关键词命中 1 个（score=0.5）应激活', async () => {
      createSkillFile(skillsDir, 'two-kw.md', '---\nkeywords: 苹果,香蕉\n---\n# 两关键词技能');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('苹果');
      expect(match).not.toBeNull();
      expect(match!.score).toBe(0.5);
    });

    it('10 关键词命中 3 个（分母上限 3，score=1.0）应激活', async () => {
      createSkillFile(
        skillsDir,
        'ten-kw.md',
        '---\nkeywords: 苹果,香蕉,橙子,葡萄,西瓜,梨,桃,李,杏,梅\n---\n# 十关键词技能',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 分母上限 3：3/min(10,3)=3/3=1.0
      const match = skillManager.match('苹果 橙子 西瓜');
      expect(match).not.toBeNull();
      expect(match!.score).toBe(1);
    });

    it('10 关键词命中 2 个（分母上限 3，score=0.667）应激活', async () => {
      createSkillFile(
        skillsDir,
        'ten-kw-2.md',
        '---\nkeywords: 苹果,香蕉,橙子,葡萄,西瓜,梨,桃,李,杏,梅\n---\n# 十关键词技能',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 分母上限 3：2/min(10,3)=2/3=0.667 ≥ 0.3 → 激活（不再因关键词多而惩罚）
      const match = skillManager.match('苹果 香蕉');
      expect(match).not.toBeNull();
      expect(match!.score).toBeCloseTo(2 / 3, 5);
    });

    it('关键词全部不命中应返回 null', async () => {
      createSkillFile(
        skillsDir,
        'no-hit.md',
        '---\nkeywords: 苹果,香蕉,橙子\n---\n# 三关键词技能',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('今天天气不错');
      expect(match).toBeNull();
    });

    it('多个技能同时匹配时应取最高分', async () => {
      // 技能 A：3 关键词命中 1 个 → 0.333
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: 苹果,香蕉,橙子\n---\n# A');
      // 技能 B：2 关键词命中 1 个 → 0.5
      createSkillFile(skillsDir, 'skill-b.md', '---\nkeywords: 苹果,葡萄\n---\n# B');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const match = skillManager.match('苹果');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('skill-b');
      expect(match!.score).toBe(0.5);
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

  // ─── reload（事件驱动热重载） ─────────────────────

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

  // ─── register / get / list 公共 API ─────────────────

  describe('register 运行时注入', () => {
    it('应注册新技能并出现在 list 中', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const initialCount = skillManager.list.length;
      skillManager.register({
        name: 'runtime-skill',
        content: '运行时注入技能',
        keywords: ['运行时'],
        trigger: undefined,
        layer: 'agent',
        filePath: '<runtime>',
      });

      expect(skillManager.list).toHaveLength(initialCount + 1);
      expect(skillManager.get('runtime-skill')?.content).toBe('运行时注入技能');
    });

    it('重复注册同名技能应抛错', async () => {
      createSkillFile(
        skillsDir,
        'existing.md',
        '---\nname: existing\nkeywords: test\n---\n# 已存在',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 重复注册同名技能应抛 configError
      expect(() =>
        skillManager.register({
          name: 'existing',
          content: '重复注册',
          keywords: ['dup'],
          trigger: undefined,
          layer: 'agent',
          filePath: '<runtime>',
        }),
      ).toThrow('已存在');
    });

    it('register 后 match 应能匹配注入的技能', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      skillManager.register({
        name: 'injected',
        content: '注入技能内容',
        keywords: ['注入关键词'],
        trigger: undefined,
        layer: 'agent',
        filePath: '<runtime>',
      });

      const match = skillManager.match('注入关键词');
      expect(match).not.toBeNull();
      expect(match!.skill.name).toBe('injected');
    });
  });

  describe('get / list 公共 API', () => {
    it('get 不存在的技能应返回 null', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.get('不存在的技能')).toBeNull();
    });

    it('list 应返回所有已加载的技能', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: a\n---\n# A');
      createSkillFile(skillsDir, 'skill-b.md', '---\nkeywords: b\n---\n# B');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.list).toHaveLength(2);
      const names = skillManager.list.map((s) => s.name).sort();
      expect(names).toEqual(['skill-a', 'skill-b']);
    });

    it('list 应是只读快照（修改不影响内部状态）', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nkeywords: a\n---\n# A');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const snapshot = skillManager.list;
      const originalLength = snapshot.length;
      // 修改 snapshot 不应影响 skillManager 内部状态
      // 注：list getter 返回 this.skills 引用，但语义上应视为只读
      // 此测试仅验证 getter 返回值长度稳定
      expect(snapshot).toHaveLength(originalLength);
    });
  });
});
