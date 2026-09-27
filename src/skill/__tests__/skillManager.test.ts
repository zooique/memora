/**
 * SkillManager 单元测试
 *
 * 测试范围：
 *   - 技能文件解析（frontmatter + content）
 *   - configDir/skills/ 目录扫描
 *   - 排除规则（隐藏文件、_ 前缀；README/CHANGELOG/LICENSE 的真源在 utils/__tests__/scanner.test.ts）
 *   - buildSystemPrompt / buildSkillList 返回值（含 L1 阈值常量锚定）
 *   - L3 资源/脚本访问边界（白名单前置 + 路径穿越防护 + 存在性/读取失败）
 *
 * 注意：SkillManager(configDir) 只扫描 configDir/skills/ 一个目录
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SkillManager,
  L1_COMPRESSED_THRESHOLD,
  L1_LIST_TOOL_THRESHOLD,
} from '@/skill/skillManager.js';
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

  describe('validateFile（写→验→用闭环）', () => {
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
      expect(v.issues).toContainEqual(
        expect.objectContaining({ level: 'error', field: 'description' }),
      );
    });

    it('无 frontmatter 结构（纯正文）→ error frontmatter', async () => {
      const p = join(skillsDir, 'raw.md');
      createSkillFile(skillsDir, 'raw.md', '# 纯正文，无 frontmatter');
      const v = await m.validateFile(p);
      expect(v.ok).toBe(false);
      expect(v.issues).toContainEqual(
        expect.objectContaining({ level: 'error', field: 'frontmatter' }),
      );
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
      // 对照技能：文件名排序在前（a-other.md < read-file.md），用于验证 get 是「按名命中」
      // 而非「取首个条目」——只断言 name 时，误实现 items.find(() => true) 也会绿。
      createSkillFile(
        skillsDir,
        'a-other.md',
        `---
name: 其它技能
---

# 其它技能

当用户需要写入文件时，使用 write_file 工具。`,
      );

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.list).toHaveLength(2);
      const skill = skillManager.get('读文件');
      expect(skill?.name).toBe('读文件');
      expect(skill?.content).toContain('read_file');
      expect(skill?.content).not.toContain('write_file');
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

    it('L1 阈值常量锚定（SSOT：与 rolePackManager 共用同一渐进披露阈值）', () => {
      // 现网其他用例只挡「阈值变大」不挡「变小」，故此处锚定取值本身：改值必须同步本测试
      expect(L1_COMPRESSED_THRESHOLD).toBe(30);
      expect(L1_LIST_TOOL_THRESHOLD).toBe(50);
      // 档位次序：先压缩枚举，再整体切换 list_skills 工具
      expect(L1_COMPRESSED_THRESHOLD).toBeLessThan(L1_LIST_TOOL_THRESHOLD);
    });

    it('可用性过滤：description 为空串/纯空白的技能不进 L1 清单', async () => {
      // 有描述 → 进清单
      createSkillFile(
        skillsDir,
        'has-desc.md',
        '---\nname: 有描述\ndescription: 有描述内容\n---\n正文',
      );
      // 无 description 字段（undefined）→ 不进清单
      createSkillFile(skillsDir, 'no-desc.md', '---\nname: 无描述\n---\n正文');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();
      // 空串 / 纯空白两类：frontmatter 解析会把空值键丢弃（无法从磁盘产出），故用注入补齐
      skillManager.register({
        name: '空描述',
        content: '正文',
        description: '',
        layer: 'agent',
        filePath: '',
      });
      skillManager.register({
        name: '空白描述',
        content: '正文',
        description: '   ',
        layer: 'agent',
        filePath: '',
      });
      expect(skillManager.list).toHaveLength(4);

      const list = skillManager.buildSkillList();
      const listed = list.split('\n').filter((line) => line.startsWith('- '));
      // 清单里只剩有描述者，且条数正确
      expect(listed).toHaveLength(1);
      expect(listed[0]).toBe('- 有描述：有描述内容');
      expect(list).not.toContain('无描述');
      expect(list).not.toContain('空描述');
      expect(list).not.toContain('空白描述');
    });

    it('全部技能无 description → 空串（清单整体不可用）', async () => {
      createSkillFile(skillsDir, 'no-desc.md', '---\nname: 无描述\n---\n正文');
      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 加载成功但全被可用性过滤挡下 → 与「无技能」同返回空串（不输出 name 空壳）
      expect(skillManager.list).toHaveLength(1);
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
      createSkillFile(skillsDir, 'existing.md', '---\nname: existing\n---\n# 已存在');
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
      // （若 getter 返回 this.items 本体 → 本测试弱化为「长度稳定」的同义反复）
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

  // ─── L3 隔离纪律（对齐 Agent Skills 主流） ────────
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
      // references/ 是 TRAE / Agent Skills 主流辅助文档目录，纳入 L3 资源索引
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

    it('getScriptPath：已登记脚本定位安全路径；未登记/技能不存在/已登记但路径逃逸 → null（L3 双层防护）', async () => {
      const skillDir = join(skillsDir, 'tool');
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: tool\n---\n# Tool 技能', 'utf-8');
      writeFileSync(join(skillDir, 'scripts', 'run.sh'), 'echo tool', 'utf-8');

      // 逃逸现场：技能目录根（scripts/ 之外）确实存在 evil.sh —— 证明下方 null 来自
      // resolveSafePath 逃逸防护，而非「文件不存在」（后者由存在性校验分支覆盖）
      const escapeDir = join(skillsDir, 'escape');
      mkdirSync(escapeDir, { recursive: true });
      writeFileSync(join(escapeDir, 'SKILL.md'), '---\nname: escape\n---\n# Escape 技能', 'utf-8');
      writeFileSync(join(escapeDir, 'evil.sh'), 'echo evil', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 已登记脚本 → resolveSafePath 收敛的绝对路径（隔离在技能 scripts/ 内）
      const p = skillManager.getScriptPath('tool', 'run.sh');
      expect(p).not.toBeNull();
      expect(p!.toLowerCase()).toContain(join('scripts', 'run.sh').toLowerCase());
      // 未登记脚本 → null（layer3 白名单前置检查）
      expect(skillManager.getScriptPath('tool', 'not-exist.sh')).toBeNull();
      // 技能不存在 → null
      expect(skillManager.getScriptPath('nope', 'run.sh')).toBeNull();

      // 已登记但路径逃逸 → null：注入 layer3 中登记了 '../evil.sh' 的技能，
      // 白名单这层会被命中，只能靠第二层（路径穿越防护）拦下
      skillManager.register({
        name: 'escape-probe',
        content: '逃逸探针',
        layer: 'agent',
        filePath: join(escapeDir, 'SKILL.md'),
        layer3: { resources: [], scripts: [{ path: '../evil.sh', runtime: 'shell' }] },
      });
      expect(skillManager.getScriptPath('escape-probe', '../evil.sh')).toBeNull();
    });

    it('getScriptPath：已登记且路径合法但磁盘文件缺失 → null（存在性校验分支）', async () => {
      const skillDir = join(skillsDir, 'gone');
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: gone\n---\n# Gone 技能', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 白名单登记了 missing.sh（区别于「未登记」输入类），但磁盘上没有该文件
      skillManager.register({
        name: 'gone-probe',
        content: '缺失脚本探针',
        layer: 'agent',
        filePath: join(skillDir, 'SKILL.md'),
        layer3: { resources: [], scripts: [{ path: 'missing.sh', runtime: 'shell' }] },
      });
      expect(skillManager.getScriptPath('gone-probe', 'missing.sh')).toBeNull();

      // 落盘后同一调用返回绝对路径：反证上面的 null 来自存在性校验，而非白名单未命中
      writeFileSync(join(skillDir, 'scripts', 'missing.sh'), 'echo gone', 'utf-8');
      const after = skillManager.getScriptPath('gone-probe', 'missing.sh');
      expect(after).not.toBeNull();
      expect(after!.toLowerCase()).toContain(join('scripts', 'missing.sh').toLowerCase());
    });

    it('readResource：已登记资源但磁盘文件缺失 → null（读取失败分支）', async () => {
      const skillDir = join(skillsDir, 'lost');
      mkdirSync(join(skillDir, 'resources'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: lost\n---\n# Lost 技能', 'utf-8');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      // 白名单登记了 ref.md，但资源文件未在磁盘上落盘
      skillManager.register({
        name: 'lost-probe',
        content: '缺失资源探针',
        layer: 'agent',
        filePath: join(skillDir, 'SKILL.md'),
        layer3: { resources: [{ path: 'ref.md', subdir: 'resources' }], scripts: [] },
      });
      expect(await skillManager.readResource('lost-probe', 'ref.md')).toBeNull();

      // 落盘后可读：反证上面的 null 来自读取失败，而非白名单未命中 / 路径穿越
      writeFileSync(join(skillDir, 'resources', 'ref.md'), '参考文档', 'utf-8');
      expect(await skillManager.readResource('lost-probe', 'ref.md')).toBe('参考文档');
    });

    it('listResources / listScripts：L3 资源与脚本清单投影（skillTool 数据源）；无 layer3 技能返回空数组', async () => {
      const skillDir = join(skillsDir, 'full');
      mkdirSync(join(skillDir, 'resources'), { recursive: true });
      mkdirSync(join(skillDir, 'scripts'), { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: full\n---\n# Full 技能', 'utf-8');
      writeFileSync(join(skillDir, 'resources', 'ref.md'), '参考', 'utf-8');
      writeFileSync(join(skillDir, 'scripts', 'run.sh'), 'echo full', 'utf-8');
      // 顶层裸 .md：纯 L1/L2 对照组（listResources/listScripts 均空）
      createSkillFile(skillsDir, 'plain.md', '---\nname: plain\n---\n# Plain 技能');

      const skillManager = new SkillManager(testDir);
      await skillManager.load();

      expect(skillManager.listResources('full')).toHaveLength(1);
      expect(skillManager.listResources('full')[0]!.path).toBe('ref.md');
      expect(skillManager.listScripts('full')).toHaveLength(1);
      expect(skillManager.listScripts('full')[0]!.path).toBe('run.sh');
      // 无 layer3 / 技能不存在 → 空数组
      expect(skillManager.listResources('plain')).toEqual([]);
      expect(skillManager.listScripts('plain')).toEqual([]);
      expect(skillManager.listResources('nope')).toEqual([]);
    });
  });
});

describe('SkillManager · 补充分支路径', () => {
  let testDir: string;
  let skillsDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `memora-skill-comp-${Date.now()}`);
    skillsDir = join(testDir, 'skills');
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('formatSkillForPrompt（静态格式化 SSOT）', () => {
    it('无技能名且无 fallbackName：返回空串', () => {
      expect(SkillManager.formatSkillForPrompt(undefined)).toBe('');
      expect(SkillManager.formatSkillForPrompt({})).toBe('');
    });

    it('fallbackName：无 name 时用回退名标注（rolePackManager / assembler 真实调用形态）', () => {
      // 真实调用方：rolePackManager 内嵌技能（无 name 字段）与 assembler 技能清单
      expect(SkillManager.formatSkillForPrompt({ description: 'x' }, '回退名')).toBe('- 回退名：x');
      // name 存在时优先于 fallbackName（回退只兜底，不抢位）
      expect(SkillManager.formatSkillForPrompt({ name: '真名', description: 'x' }, '回退名')).toBe(
        '- 真名：x',
      );
      // 无 name 且无 fallbackName → 空串；description 非空也不得输出（判据在 label 门之后）
      expect(SkillManager.formatSkillForPrompt({ description: 'x' })).toBe('');
    });

    it('有 layer3（含资源/脚本）时追加标记', () => {
      const out = SkillManager.formatSkillForPrompt({
        name: 'run',
        description: '执行脚本',
        layer3: { resources: [{ path: 'a' } as never], scripts: [] },
      });
      expect(out).toContain('（含资源/脚本）');
    });

    it('compress=true 且描述超 20 字：截断为 20 字 + …', () => {
      const out = SkillManager.formatSkillForPrompt(
        { name: 'compress', description: '这是一个超过二十个字符很长的描述文本用于验证压缩截断' },
        undefined,
        true,
      );
      expect(out).toContain('…');
      // 20 字原文被截断，不应包含完整描述
      expect(out).not.toContain('用于验证压缩截断');
    });

    it('compress=false 保留完整描述', () => {
      const longDesc = '这是一个超过二十个字符很长的描述文本用于验证不压缩';
      const out = SkillManager.formatSkillForPrompt({ name: 'full', description: longDesc });
      expect(out).toContain(longDesc);
    });
  });

  describe('buildSystemPrompt 边界', () => {
    it('name 提供但技能不存在：返回空串', async () => {
      const manager = new SkillManager(testDir);
      await manager.load();
      expect(manager.buildSystemPrompt('不存在的技能')).toBe('');
    });
  });

  describe('validateFile 余下分支', () => {
    const m = new SkillManager();
    it('正文为空 → error body', async () => {
      const p = join(skillsDir, 'empty-body.md');
      createSkillFile(skillsDir, 'empty-body.md', '---\nname: x\ndescription: d\n---\n  ');
      const v = await m.validateFile(p);
      expect(v.ok).toBe(false);
      expect(v.issues).toContainEqual(expect.objectContaining({ level: 'error', field: 'body' }));
    });

    it('layer 非法值 → warning（回退 project）', async () => {
      const p = join(skillsDir, 'bad-layer.md');
      createSkillFile(
        skillsDir,
        'bad-layer.md',
        '---\nname: x\ndescription: d\nlayer: invalid\n---\n正文',
      );
      const v = await m.validateFile(p);
      expect(v.ok).toBe(true); // warning 不引发 error
      expect(v.issues).toContainEqual(
        expect.objectContaining({ level: 'warning', field: 'layer' }),
      );
    });
  });

  describe('readResource 边界', () => {
    it('技能不存在：返回 null', async () => {
      const manager = new SkillManager(testDir);
      await manager.load();
      expect(await manager.readResource('不存在的技能', 'a.md')).toBeNull();
    });
  });

  describe('loadExtraDir（用户技能目录注入）', () => {
    it('加载用户技能 + 同名覆盖内置（S5，2026-09-22 反转：用户 > 内置，对齐主流）', async () => {
      // 内置技能：同名 dup
      createSkillFile(skillsDir, 'dup.md', '---\nname: dup\ndescription: d\n---\n内置版本');
      const manager = new SkillManager(testDir);
      await manager.load();

      // 用户目录：dup（重名，应覆盖内置）+ 一个新的 extra
      const extraDir = join(testDir, 'user-skills');
      mkdirSync(extraDir, { recursive: true });
      createSkillFile(extraDir, 'dup.md', '---\nname: dup\ndescription: d2\n---\n用户版本');
      createSkillFile(extraDir, 'extra.md', '---\nname: extra\ndescription: e\n---\n用户额外技能');

      const count = await manager.loadExtraDir(extraDir);
      // dup + extra 均注入（dup 覆盖内置而非跳过）
      expect(count).toBe(2);
      expect(manager.get('dup')?.content).toBe('用户版本'); // 用户覆盖内置
      expect(manager.get('extra')?.content).toBe('用户额外技能');
    });

    it('受覆盖的内置技能 reload 后仍以用户版为准（reload 扫描回内置版不反超）', async () => {
      // 内置技能：同名 dup
      createSkillFile(skillsDir, 'dup.md', '---\nname: dup\ndescription: d\n---\n内置版本');
      // 用户目录：dup 覆盖版
      const extraDir = join(testDir, 'user-skills');
      mkdirSync(extraDir, { recursive: true });
      createSkillFile(extraDir, 'dup.md', '---\nname: dup\ndescription: d2\n---\n用户版本');
      const manager = new SkillManager(testDir);
      await manager.load();
      await manager.loadExtraDir(extraDir);

      // reload：磁盘（内置）重扫 → 用户覆盖版须保留、内置版不得反超
      await manager.reload();
      expect(manager.get('dup')?.content).toBe('用户版本');

      // 二次 reload 仍稳定（覆盖记账保留）
      await manager.reload();
      expect(manager.get('dup')?.content).toBe('用户版本');
      // 无同名双存：同名技能仅一个条目
      expect(manager.list.filter((s) => s.name === 'dup')).toHaveLength(1);
    });
  });

  describe('禁用技能（S4 配置形态启停）', () => {
    it('禁用技能：get=null（L2 read_skill 短路）+ L1 清单剔除 + L3 不可用', async () => {
      createSkillFile(skillsDir, 'a.md', '---\nname: a\ndescription: 技能A\n---\n正文A');
      createSkillFile(skillsDir, 'b.md', '---\nname: b\ndescription: 技能B\n---\n正文B');
      const manager = new SkillManager(testDir);
      await manager.load();
      manager.setDisabledSkills(['a']);

      // get：禁用返回 null（read_skill 语义 = 不存在），未禁用不受影响
      expect(manager.get('a')).toBeNull();
      expect(manager.get('b')?.name).toBe('b');
      // L1 清单：禁用技能不枚举（用独立单词匹配，避免 "read_skill" 中的 'a' 误匹配）
      expect(manager.buildSkillList()).not.toMatch(/\ba\b/);
      expect(manager.buildSkillList()).toContain('- b：');
      // 非禁用技能仍不可见风险：未设置禁用集则全部可见（向后兼容）
      const manager2 = new SkillManager(testDir);
      await manager2.load();
      expect(manager2.buildSkillList()).toContain('a');
    });

    it('listAvailable：可用性 + 禁用两判据单点（LLM 可见集唯一真理源）', async () => {
      createSkillFile(skillsDir, 'a.md', '---\nname: a\ndescription: 技能A\n---\n正文A');
      createSkillFile(skillsDir, 'b.md', '---\nname: b\ndescription: 技能B\n---\n正文B');
      // 缺 description：渐进披露层面不可用，不入 LLM 可见集
      createSkillFile(skillsDir, 'nodesc.md', '---\nname: nodesc\n---\n正文');
      const manager = new SkillManager(testDir);
      await manager.load();
      manager.setDisabledSkills(['b']);

      // 两判据同时生效：禁用 b 剔除 + 缺 description 的 nodesc 剔除
      expect(manager.listAvailable().map((s) => s.name)).toEqual(['a']);
      // 同源断言：L1 枚举与 listAvailable 看到同一集合。
      // `list_skills` 工具侧（assembler 注入回调）亦调用本方法 ⇒ 两通道判据不分叉
      //（若工具侧只过滤 description、漏掉禁用过滤——注释却自称「必须一致」）
      const l1 = manager.buildSkillList();
      expect(l1).toContain('- a：');
      expect(l1).not.toMatch(/\bb\b/);
      expect(l1).not.toContain('nodesc');
    });

    it('disabledSkillNames：只读快照供宿主 UI 徽章（真源 = 内核，宿主不自读配置副本）', async () => {
      const manager = new SkillManager(testDir);
      await manager.load();
      expect(manager.disabledSkillNames).toEqual([]);

      manager.setDisabledSkills(['x', 'y']);
      expect(manager.disabledSkillNames).toEqual(['x', 'y']);
      // 返回的是副本：外部改动不得旁路内核判据集（否则 get()/buildSkillList 与 UI 标注分叉）
      manager.disabledSkillNames.push('z');
      expect(manager.disabledSkillNames).toEqual(['x', 'y']);
      // 全量替换语义（非累加）：重设即覆盖，供 reloadConfig 路径复用
      manager.setDisabledSkills(['only']);
      expect(manager.disabledSkillNames).toEqual(['only']);
    });
  });
});
