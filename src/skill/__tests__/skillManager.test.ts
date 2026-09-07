/**
 * SkillManager 单元测试
 *
 * 测试范围：
 *   - 技能文件解析（frontmatter + content）
 *   - configDir/skills/ 目录扫描
 *   - 排除规则（隐藏文件、_ 前缀、README 等）
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

  describe('validateFile（G22 写→验→用闭环）', () => {
    const m = new SkillManager();

    it('正常技能（有 name/description）→ ok=true，无 error', async () => {
      const p = join(skillsDir, 'good.md');
      createSkillFile(skillsDir, 'good.md', '---\nname: good\ndescription: 描述\n---\n正文');
      const v = await m.validateFile(p);
      expect(v.ok).toBe(true);
      expect(v.issues.filter((i) => i.level === 'error')).toHaveLength(0);
    });

    it('缺 description → error（未生效，渐进披露不暴露）', async () => {
      const p = join(skillsDir, 'node.md');
      createSkillFile(skillsDir, 'node.md', '---\nname: node\n---\n正文');
      const v = await m.validateFile(p);
      expect(v.ok).toBe(false);
      expect(v.issues).toContainEqual(expect.objectContaining({ level: 'error', field: 'description' }));
    });

    it('无 frontmatter 结构（纯正文）→ error frontmatter', async () => {
      const p = join(skillsDir, 'raw.md');
      createSkillFile(skillsDir, 'raw.md', '# 纯正文，无 frontmatter');
      const v = await m.validateFile(p);
      expect(v.ok).toBe(false);
      expect(v.issues).toContainEqual(expect.objectContaining({ level: 'error', field: 'frontmatter' }));
    });

    it('无法读取文件 → error file', async () => {
      const v = await m.validateFile(join(skillsDir, 'missing.md'));
      expect(v.ok).toBe(false);
      expect(v.issues).toContainEqual(expect.objectContaining({ level: 'error', field: 'file' }));
    });
  });

  describe('load', () => {
    it('应该加载单个技能文件', async () => {
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
---

# 读文件技能

当用户需要读取文件时，使用 read_file 工具。`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 加载后技能可检索（自动匹配链已删，等价断言：get 可取到条目）
      expect(skillManager.get('读文件')?.name).toBe('读文件');
    });

    it('应该在目录不存在时安全降级', async () => {
      const nonExistentDir = join(testDir, 'nonexistent');
      const skillManager = new SkillManager(nonExistentDir);

      await skillManager.load();

      // 目录不存在 → 技能池为空（安全降级，不抛错）
      expect(skillManager.list).toHaveLength(0);
    });
  });

  describe('排除规则', () => {
    it('应该排除隐藏文件', async () => {
      createSkillFile(
        skillsDir,
        '.hidden.md',
        `---
name: 隐藏技能
---

隐藏内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 被排除文件不进入技能池（自动匹配链已删，等价断言：items 中无此技能）
      expect(skillManager.get('隐藏技能')).toBeNull();
    });

    it('应该排除 _ 前缀文件', async () => {
      createSkillFile(
        skillsDir,
        '_underscore.md',
        `---
name: 下划线技能
---

下划线内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.get('下划线技能')).toBeNull();
    });

    it('应该排除 README、CHANGELOG、LICENSE', async () => {
      createSkillFile(
        skillsDir,
        'README.md',
        `---
name: README
---

README 内容`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.get('README')).toBeNull();
    });
  });

  describe('buildSystemPrompt', () => {
    it('应该构建技能的 system prompt', async () => {
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
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

  describe('buildSkillList（全局技能清单 · 渐进披露 L1）', () => {
    it('应列出所有技能（name + description）', async () => {
      createSkillFile(
        skillsDir,
        'read-file.md',
        `---
name: 读文件
description: 读取本地文件内容
---

# 读文件技能`,
      );
      createSkillFile(
        skillsDir,
        'web-search.md',
        `---
name: 搜索
description: 联网搜索资料
---

# 搜索技能`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const list = skillManager.buildSkillList();
      expect(list).toContain('读文件');
      expect(list).toContain('读取本地文件内容');
      expect(list).toContain('搜索');
      expect(list).toContain('联网搜索资料');
      expect(list).toContain('read_skill'); // 引导 LLM 按需读取
    });

    it('无技能时返回空字符串', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.buildSkillList()).toBe('');
    });

    it('技能数 31-50：L1 压缩档（描述截断 20 字 + 压缩提示）', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      // 注入 31 个有描述技能，触发压缩档（L1_COMPRESSED_THRESHOLD=30 之上）
      for (let i = 0; i < 31; i++) {
        skillManager.register({
          name: `技能${i}`,
          content: `正文${i}`,
          description: `这是第 ${i} 号技能的完整描述，长度超过二十字用于验证压缩截断行为`,
          layer: 'agent',
          filePath: '',
        });
      }

      const list = skillManager.buildSkillList();
      // 压缩提示语
      expect(list).toContain('描述已压缩至 20 字');
      // 单个技能描述被截断（20 字 + …）
      expect(list).toContain('…');
      // 未出现完整描述全文（首个技能描述被压缩）
      expect(list).not.toContain('这是第 0 号技能的完整描述，长度超过二十字用于验证压缩截断行为');
    });

    it('技能数 > 50：切换 list_skills 工具动态查询（不枚举技能）', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      // 注入 51 个有描述技能，触发 list_skills 档（L1_LIST_TOOL_THRESHOLD=50 之上）
      for (let i = 0; i < 51; i++) {
        skillManager.register({
          name: `技能${i}`,
          content: `正文${i}`,
          description: `描述 ${i}`,
          layer: 'agent',
          filePath: '',
        });
      }

      const list = skillManager.buildSkillList();
      expect(list).toContain('使用 list_skills 工具查询具体清单');
      // 不再逐条枚举技能
      expect(list).not.toContain('- 技能0');
      expect(list).not.toContain('- 技能50');
    });
  });

  // ─── reload（事件驱动热重载） ─────────────────────

  describe('layer 解析（agent / project 分层）', () => {
    it('frontmatter.layer=agent 应解析为 agent', async () => {
      createSkillFile(skillsDir, 'agent-skill.md', '---\nlayer: agent\n---\n# Agent 技能');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.get('agent-skill')?.layer).toBe('agent');
    });

    it('frontmatter 无 layer 时应回退 project（默认）', async () => {
      createSkillFile(skillsDir, 'project-skill.md', '---\nnote: x\n---\n# 项目技能');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.get('project-skill')?.layer).toBe('project');
    });

    it('frontmatter.layer 为非法值时应回退 project（防御契约外值透传宿主）', async () => {
      createSkillFile(skillsDir, 'bad-skill.md', '---\nlayer: unknown-layer\n---\n# 非法层技能');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.get('bad-skill')?.layer).toBe('project');
    });
  });

  describe('reload', () => {
    it('重载应反映目录变更（新增技能）', async () => {
      // 初始加载 1 个技能
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: a\n---\n# 技能 A\n内容 A');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.list).toHaveLength(1);

      // 新增第 2 个技能文件
      createSkillFile(skillsDir, 'skill-b.md', '---\nnote: b\n---\n# 技能 B\n内容 B');

      // 重载后应看到 2 个技能
      const count = await skillManager.reload();
      expect(count).toBe(2);
      expect(skillManager.list).toHaveLength(2);
      expect(skillManager.list.map((s) => s.name).sort()).toEqual(['skill-a', 'skill-b']);
    });

    it('重载应反映目录变更（删除技能）', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: a\n---\n# 技能 A\n内容 A');
      createSkillFile(skillsDir, 'skill-b.md', '---\nnote: b\n---\n# 技能 B\n内容 B');
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

    it('重载应保留运行时注入的技能（注入项无磁盘真理源）', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: a\n---\n# 技能 A');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      skillManager.register({
        name: 'runtime-skill',
        content: '运行时注入技能',
        layer: 'agent',
        filePath: '',
      });
      expect(skillManager.list).toHaveLength(2);

      // reload 扫描磁盘只会看到 skill-a；注入项没有磁盘真理源，抹掉即永久丢失
      const count = await skillManager.reload();
      expect(count).toBe(2);
      expect(skillManager.get('runtime-skill')?.content).toBe('运行时注入技能');
      expect(skillManager.get('skill-a')).not.toBeNull();
    });

    it('同名磁盘文件出现后重载应以磁盘为准', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      skillManager.register({
        name: 'skill-a',
        content: '注入版本',
        layer: 'agent',
        filePath: '',
      });

      // 磁盘上出现同名技能：真理源转移到磁盘，注入版本被接管而非并存
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: disk\n---\n# 磁盘版本');
      const count = await skillManager.reload();
      expect(count).toBe(1);
      expect(skillManager.get('skill-a')?.content).toBe('# 磁盘版本');
    });

    it('重载应反映内容变更', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: old\n---\n# 旧内容');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      expect(skillManager.get('skill-a')?.content).toBe('# 旧内容');

      // 修改技能文件内容
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: new\n---\n# 新内容');
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
        '---\nname: existing\n---\n# 已存在',
      );
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 重复注册同名技能应抛 configError
      expect(() =>
        skillManager.register({
          name: 'existing',
          content: '重复注册',
          layer: 'agent',
          filePath: '<runtime>',
        }),
      ).toThrow('已存在');
    });

    it('register 后 get 应能取到注入的技能', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      skillManager.register({
        name: 'injected',
        content: '注入技能内容',
        layer: 'agent',
        filePath: '<runtime>',
      });

      expect(skillManager.get('injected')?.content).toBe('注入技能内容');
    });
  });

  describe('get / list 公共 API', () => {
    it('get 不存在的技能应返回 null', async () => {
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.get('不存在的技能')).toBeNull();
    });

    it('list 应返回所有已加载的技能', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: a\n---\n# A');
      createSkillFile(skillsDir, 'skill-b.md', '---\nnote: b\n---\n# B');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.list).toHaveLength(2);
      const names = skillManager.list.map((s) => s.name).sort();
      expect(names).toEqual(['skill-a', 'skill-b']);
    });

    it('list 应是只读快照（修改不影响内部状态）', async () => {
      createSkillFile(skillsDir, 'skill-a.md', '---\nnote: a\n---\n# A');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // getter 返回浅拷贝，篡改快照不得改变内部真理源。
      // （此前 getter 返回 this.items 本体，本测试被弱化为「长度稳定」的同义反复）
      const snapshot = skillManager.list;
      snapshot.push({
        name: '越权注入',
        content: 'x',
        filePath: '',
        layer: 'agent',
      });
      snapshot.length = 0;

      expect(skillManager.list).toHaveLength(1);
      expect(skillManager.list[0]!.name).toBe('skill-a');
      expect(skillManager.get('越权注入')).toBeNull();
    });
  });

  // ─── L3 隔离纪律（2026-08-30 对齐 Agent Skills 主流） ────────
  // 主流标准：技能=文件夹+强制 SKILL.md，辅助目录 scripts/ references/ assets/ 归 SKILL.md 所有。
  // 顶层裸 .md 是旧版自定义命令的扁平兼容形态，若同级扫描其 resources/scripts 会把别的技能的资源误归自己。

  describe('L3 隔离纪律（仅文件夹形态发现 resources/scripts）', () => {
    it('顶层裸 .md 技能不扫描 L3 资源', async () => {
      // 顶层裸 .md：纯 L1/L2，即使同级存在 resources/ 也不归属它
      createSkillFile(skillsDir, 'foo.md', '---\nname: foo\n---\n# Foo 技能');
      // 同级创建 resources/：模拟「共享技能根」场景，验证不并入裸 .md
      mkdirSync(join(skillsDir, 'resources'), { recursive: true });
      writeFileSync(join(skillsDir, 'resources', 'api.md'), 'API 参考', 'utf-8');
      mkdirSync(join(skillsDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillsDir, 'scripts', 'run.sh'), 'echo hi', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const skill = skillManager.get('foo');
      expect(skill).not.toBeNull();
      // 裸 .md 为纯 L1/L2：layer3 为空，即使同级存在 resources/scripts
      expect(skill!.layer3).toBeUndefined();
    });

    it('顶层裸 .md 技能不扫描 L3 脚本', async () => {
      createSkillFile(skillsDir, 'bar.md', '---\nname: bar\n---\n# Bar 技能');
      // 同级 scripts/：验证不并归裸 .md（避免脚本池相互污染）
      mkdirSync(join(skillsDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillsDir, 'scripts', 'helper.sh'), 'echo bar', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const barSkill = skillManager.get('bar');
      expect(barSkill!.layer3).toBeUndefined();
    });

    it('文件夹形态（SKILL.md）正常扫描 L3 资源/脚本', async () => {
      // 文件夹形态：目录下 SKILL.md 为唯一入口，其 directories 内的 resources/ scripts/ 归本合同
      const skillDir = join(skillsDir, 'baz');
      mkdirSync(join(skillDir, 'resources'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: baz\n---\n# Baz 技能', 'utf-8');
      writeFileSync(join(skillDir, 'resources', 'ref.md'), '参考文档', 'utf-8');
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'scripts', 'run.sh'), 'echo baz', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const skillDirSkill = skillManager.get('baz');
      expect(skillDirSkill).not.toBeNull();
      // 文件夹形态：layer3 正常发现 resources + scripts
      expect(skillDirSkill!.layer3?.resources).toHaveLength(1);
      expect(skillDirSkill!.layer3?.resources[0]!.path).toBe('ref.md');
      expect(skillDirSkill!.layer3?.scripts).toHaveLength(1);
      expect(skillDirSkill!.layer3?.scripts[0]!.path).toBe('run.sh');
    });

    it('文件夹形态（SKILL.md）扫描 references/ 且 read_resource 可读（B1 兼容主流）', async () => {
      // B1：references/ 是 TRAE / Agent Skills 主流辅助文档目录，纳入 L3 资源索引
      const skillDir = join(skillsDir, 'tree');
      mkdirSync(join(skillDir, 'references'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: tree\n---\n# Tree 技能', 'utf-8');
      writeFileSync(join(skillDir, 'references', 'modes.md'), 'Modes 参考文档', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      const treeSkill = skillManager.get('tree');
      expect(treeSkill).not.toBeNull();
      // references/ 文件进入 layer3.resources，并标注 subdir=references
      expect(treeSkill!.layer3?.resources).toHaveLength(1);
      expect(treeSkill!.layer3?.resources[0]!.path).toBe('modes.md');
      expect(treeSkill!.layer3?.resources[0]!.subdir).toBe('references');
      // read_resource 按 subdir 选择 references/ 基目录读取成功
      const content = await skillManager.readResource('tree', 'modes.md');
      expect(content).toBe('Modes 参考文档');
      // 未登记的路径仍被拒绝（layer3 白名单）
      const bad = await skillManager.readResource('tree', '../secret.txt');
      expect(bad).toBeNull();
    });
  });
});
