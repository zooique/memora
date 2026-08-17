/**
 * RolePackManager 端到端测试（2026-08-14：单一 manifest.json 文件夹形态）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolePackManager } from '@/role-pack/rolePackManager.js';

/** 单技能角色包（persona + rules + 单技能） */
const MANIFEST_TECH = {
  name: '技术文档工程师',
  formatVersion: '1.0.0',
  description: '技术文档写作',
  keywords: ['文档', 'API'],
  author: 'memora',
  interactionType: 'tool_assistant',
  strategy: {
    prepare: { contextAssembly: 'fixed' },
    reflect: { handoff: 'wait' },
  },
  persona: 'persona.md',
  rules: 'rules.md',
  skills: [
    { file: 'skills/summarize.md', name: 'summarize', capability: 'llm:summarize' },
  ],
};

/** 多技能 + 无 persona（persona 允许缺省） */
const MANIFEST_MULTI_SKILL_NO_PERSONA = {
  name: '全能写手',
  formatVersion: '1.0.0',
  keywords: ['写作'],
  strategy: { act: { toolMode: 'block' } },
  rules: 'rules.md',
  skills: [
    { file: 'skills/write.md', name: 'write', capability: 'file:write' },
    { file: 'skills/search.md', name: 'search', capability: 'web:search' },
    { file: 'skills/read.md', name: 'read' },
  ],
};

/** 纯能力声明包（skills 无 file，仅 capability，§4 雷-3a） */
const MANIFEST_PURE_CAPABILITY = {
  name: '项目总监',
  formatVersion: '1.0.0',
  keywords: ['项目管理'],
  strategy: { act: { toolMode: 'allow' } },
  persona: 'persona.md',
  rules: 'rules.md',
  skills: [
    { capability: 'file:read', description: '读取项目文件' },
    { capability: 'web:search', description: '查询行业资料' },
  ],
};

/** 交接声明包（handoffs 宿主侧键，对齐 VS Code custom agents） */
const MANIFEST_HANDOFFS = {
  name: '写作助手',
  formatVersion: '1.0.0',
  keywords: ['写作'],
  persona: 'persona.md',
  handoffs: [
    { label: '交给技术文档工程师', target: 'tech-writer', prompt: '初稿已完成，请检查格式', send: false },
    { label: '转代码审查', target: 'code-reviewer' },
    { target: '缺 label 的项应被过滤' },
  ],
};

/** 互斥角色包对（翻译助手 ↔ 代码助手） */
const MANIFEST_TRANSLATOR = {
  name: '翻译助手',
  formatVersion: '1.0.0',
  keywords: ['翻译', '英译中'],
  exclusiveWith: ['代码助手'],
  persona: 'persona.md',
};
const MANIFEST_CODER = {
  name: '代码助手',
  formatVersion: '1.0.0',
  keywords: ['编程', '写代码'],
  exclusiveWith: ['翻译助手'],
  persona: 'persona.md',
};

/** 便捷构造：写一个 folder 形态角色包（manifest.json + 可选内容文件） */
async function writePack(
  packsDir: string,
  dirName: string,
  manifest: Record<string, unknown>,
  content: { persona?: string; rules?: string; skills?: Record<string, string> } = {},
): Promise<void> {
  const packDir = join(packsDir, dirName);
  await mkdir(packDir, { recursive: true });
  await writeFile(
    join(packDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
  if (content.persona !== undefined) {
    await writeFile(join(packDir, manifest['persona'] as string), content.persona, 'utf-8');
  }
  if (content.rules !== undefined) {
    await writeFile(join(packDir, manifest['rules'] as string), content.rules, 'utf-8');
  }
  if (content.skills) {
    for (const [relPath, body] of Object.entries(content.skills)) {
      const full = join(packDir, relPath);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, body, 'utf-8');
    }
  }
}

describe('RolePackManager（2026-08-14 manifest 文件夹形态）', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rolepack-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('扫描 manifest 文件夹包：解析 meta + strategy + 内容文件 + 技能注册', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
      persona: '你是一位技术文档工程师。',
      rules: '- 术语保持一致\n- 不编造 API',
      skills: { 'skills/summarize.md': '## 提炼要点\n' },
    });

    const manager = new RolePackManager(dir);
    const count = await manager.load();
    expect(count).toBe(1);

    const active = manager.getActive();
    expect(active).not.toBeNull();
    expect(active!.meta.name).toBe('技术文档工程师');
    // displayName 缺省时回退 name（SSOT：显示名单一来源 = displayName ?? name）
    expect(active!.meta.displayName).toBeUndefined();
    expect(active!.meta.formatVersion).toBe('1.0.0');
    // 合规字段默认值
    expect(active!.meta.interactionType).toBe('tool_assistant');
    expect(active!.meta.aiIdentityDisclosure).toBe(true);
    // 嵌套 strategy
    const prepare = active!.strategy.prepare as Record<string, unknown>;
    expect(prepare['contextAssembly']).toBe('fixed');
    // L1 内容：persona + rules 从独立文件装载
    expect(active!.personaPrompt).toContain('技术文档工程师');
    expect(active!.personaPrompt).toContain('术语保持一致');
    // 技能注册（对象数组）
    expect(active!.skills).toHaveLength(1);
    expect(active!.skills[0]!.file).toBe('skills/summarize.md');
    // 能力声明由 skills.capability 派生
    expect(active!.capabilities).toEqual([
      { capability: 'llm:summarize', description: undefined },
    ]);
  });

  it('displayName 显式声明时解析为 UI 展示名（与 name 职责分离，SSOT）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // name 为内部唯一标识（英文），displayName 为面向用户的本地化展示名
    const manifest = { ...MANIFEST_TECH, name: 'doc-review', displayName: '文档打磨' };
    await writePack(packsDir, 'doc-review', manifest, {
      persona: '文档打磨定位',
      rules: '- 保持文档自洽',
    });

    const manager = new RolePackManager(dir);
    const count = await manager.load('doc-review');
    expect(count).toBe(1);
    const active = manager.getActive();
    expect(active).not.toBeNull();
    expect(active!.meta.name).toBe('doc-review');
    expect(active!.meta.displayName).toBe('文档打磨');
  });

  it('多技能注册 + persona 缺省（无 persona.md）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '全能写手', MANIFEST_MULTI_SKILL_NO_PERSONA, {
      rules: '- 不生成违法内容',
      skills: {
        'skills/write.md': '## 写作\n',
        'skills/search.md': '## 搜索\n',
        'skills/read.md': '## 阅读\n',
      },
    });

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(1);

    const active = manager.getActive();
    expect(active!.meta.name).toBe('全能写手');
    // 三个技能全部注册
    expect(active!.skills.map((s) => s.name)).toEqual(['write', 'search', 'read']);
    // persona 缺省 → personaPrompt 不含身份设定，仅规则注入
    expect(active!.personaPrompt).toContain('不生成违法内容');
    // 能力声明聚合（仅声明了 capability 的项）
    expect(active!.capabilities.map((c) => c.capability).sort()).toEqual([
      'file:write',
      'web:search',
    ]);
  });

  it('纯 capability 声明（skills 无 file）装载并派生能力（雷-3a）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '项目总监', MANIFEST_PURE_CAPABILITY, {
      persona: '你是一位项目总监。',
      rules: '- 风险前置识别',
    });

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(1);

    const active = manager.getActive();
    expect(active!.meta.name).toBe('项目总监');
    // 纯能力声明项保留（不因缺 file 被丢弃）
    expect(active!.skills).toHaveLength(2);
    expect(active!.skills[0]!.file).toBeUndefined();
    // capability 正常派生为能力声明
    expect(active!.capabilities.map((c) => c.capability).sort()).toEqual([
      'file:read',
      'web:search',
    ]);
  });

  it('handoffs 声明透传：合法项保留，缺 label/target 项过滤（宿主侧键）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '写作助手', MANIFEST_HANDOFFS, { persona: '你是一位写作助手。' });

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(1);

    const handoffs = manager.getActive()!.meta.handoffs;
    expect(handoffs).toHaveLength(2); // 缺 label 的项被过滤
    expect(handoffs![0]).toEqual({
      label: '交给技术文档工程师',
      target: 'tech-writer',
      prompt: '初稿已完成，请检查格式',
      send: false,
    });
    expect(handoffs![1]).toEqual({ label: '转代码审查', target: 'code-reviewer' });
  });

  it('未声明 handoffs → meta.handoffs 为 undefined', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(1);
    expect(manager.getActive()!.meta.handoffs).toBeUndefined();
  });

  it('无 manifest.json 的文件夹不计入角色包', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(join(packsDir, 'not-a-pack'), { recursive: true });
    await writeFile(join(packsDir, 'not-a-pack', 'notes.md'), '# 无 manifest\n', 'utf-8');

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(0);
  });

  it('manifest.json 非法 JSON 时跳过该角色包', async () => {
    const packsDir = join(dir, 'role-packs');
    const packDir = join(packsDir, '坏包');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'manifest.json'), '{ not json', 'utf-8');

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(0);
  });

  it('reload 保持激活态', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });
    await writePack(packsDir, '代码助手', MANIFEST_CODER, { persona: '你是程序员。' });

    const manager = new RolePackManager(dir);
    await manager.load();
    manager.activate('代码助手');
    expect(manager.activeName).toBe('代码助手');

    await manager.reload();
    expect(manager.activeName).toBe('代码助手');
    expect(manager.getActive()!.meta.name).toBe('代码助手');
  });

  it('companion 角色包触发内容红线 → 拒绝装载', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '红伴', {
      name: '红伴',
      formatVersion: '1.0.0',
      interactionType: 'companion',
      aiIdentityDisclosure: true,
      minorProtection: 'required',
      persona: 'persona.md',
    }, { persona: '你是用户的虚拟伴侣。' });

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(0);
  });

  describe('粘性匹配 · agent-design-philosophy §6.2', () => {
    async function writeExclusivePacks(): Promise<void> {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });
      await writePack(packsDir, '代码助手', MANIFEST_CODER, { persona: '你是程序员。' });
    }

    it('exclusiveWith 解析进 meta', async () => {
      await writeExclusivePacks();
      const manager = new RolePackManager(dir);
      await manager.load();
      expect(manager.get('翻译助手')!.meta.exclusiveWith).toEqual(['代码助手']);
      expect(manager.get('代码助手')!.meta.exclusiveWith).toEqual(['翻译助手']);
    });

    it('首次 autoMatch 命中即锁定当前会话，命中已激活包不重复切换', async () => {
      await writeExclusivePacks();
      const manager = new RolePackManager(dir);
      await manager.load();
      manager.activate('翻译助手');

      expect(manager.autoMatch('写代码')).toBe('代码助手');
      manager.activate('代码助手');
      expect(manager.activeName).toBe('代码助手');

      expect(manager.autoMatch('我有个编程需求')).toBeNull();
    });

    it('已锁定后仅互斥包命中才切换，非互斥命中不切换', async () => {
      await writeExclusivePacks();
      const packsDir = join(dir, 'role-packs');
      await writePack(packsDir, '通用助手', {
        name: '通用助手',
        formatVersion: '1.0.0',
        keywords: ['通用', '闲聊'],
        persona: 'persona.md',
      }, { persona: '你是通用助手。' });

      const manager = new RolePackManager(dir);
      await manager.load();
      manager.activate('代码助手');

      // 已锁定（代码助手）：命中互斥的翻译助手 → 切换
      expect(manager.autoMatch('翻译一些内容')).toBe('翻译助手');
      manager.activate('翻译助手');

      // 已锁定（翻译助手）：命中非互斥的通用助手 → 不切换
      expect(manager.autoMatch('来闲聊两句')).toBeNull();
      expect(manager.activeName).toBe('翻译助手');
    });

    it('resetSticky 复位后重新全量匹配（粘性不跨会话）', async () => {
      await writeExclusivePacks();
      const manager = new RolePackManager(dir);
      await manager.load();
      manager.activate('翻译助手');

      expect(manager.autoMatch('写代码')).toBe('代码助手');
      manager.activate('代码助手');

      manager.resetSticky();
      expect(manager.autoMatch('翻译')).toBe('翻译助手');
    });

    it('互斥声明非对称/悬空不阻塞装载，仍可正常激活', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      // 翻译助手声明互斥代码助手，但代码助手未反向声明（非对称）
      await writePack(packsDir, '翻译助手', {
        name: '翻译助手',
        formatVersion: '1.0.0',
        keywords: ['翻译'],
        exclusiveWith: ['代码助手'],
        persona: 'persona.md',
      }, { persona: '你是翻译。' });
      // 代码助手声明互斥不存在的"幻影助手"（悬空引用）
      await writePack(packsDir, '代码助手', {
        name: '代码助手',
        formatVersion: '1.0.0',
        keywords: ['编程'],
        exclusiveWith: ['幻影助手'],
        persona: 'persona.md',
      }, { persona: '你是程序员。' });

      const manager = new RolePackManager(dir);
      // 对称性检查仅告警，不拒绝装载
      expect(await manager.load()).toBe(2);
      manager.activate('代码助手');
      expect(manager.activeName).toBe('代码助手');
      // 单边声明仍视为互斥（isExclusiveBetween 单边命中即互斥）
      expect(manager.autoMatch('翻译内容')).toBe('翻译助手');
    });

    it('未命中任何角色包时返回 null 且不锁定', async () => {
      await writeExclusivePacks();
      const manager = new RolePackManager(dir);
      await manager.load();
      manager.activate('翻译助手');

      expect(manager.autoMatch('今天天气不错')).toBeNull();
      expect(manager.autoMatch('写代码')).toBe('代码助手');
    });
  });

  describe('渐进披露 · read_skill + buildSystemPrompt 技能清单', () => {
    it('readSkillContent 按技能名读取内嵌技能正文（渐进披露 L2）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
        persona: '你是一位技术文档工程师。',
        rules: '- 术语保持一致',
        skills: { 'skills/summarize.md': '## 提炼要点\n1. 识别核心\n2. 精简表达\n' },
      });

      const manager = new RolePackManager(dir);
      await manager.load();

      // 按 name（manifest.skills[].name）读取激活角色包技能正文
      const content = await manager.readSkillContent('summarize');
      expect(content).toContain('识别核心');
      expect(content).toContain('精简表达');
    });

    it('readSkillContent 按文件名去扩展名匹配（无 name 时）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      // 纯能力声明包 skills 无 name 只有 file
      await writePack(packsDir, '项目总监', {
        name: '项目总监',
        formatVersion: '1.0.0',
        keywords: ['项目管理'],
        persona: 'persona.md',
        skills: [
          { file: 'skills/review.md', capability: 'task:plan', description: '审查计划' },
        ],
      }, { persona: '你是项目总监。', skills: { 'skills/review.md': '## 审查流程\n' } });

      const manager = new RolePackManager(dir);
      await manager.load();

      const content = await manager.readSkillContent('review');
      expect(content).toContain('审查流程');
    });

    it('readSkillContent 技能不存在时返回 null', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
        skills: { 'skills/summarize.md': '## 提炼要点\n' },
      });

      const manager = new RolePackManager(dir);
      await manager.load();

      expect(await manager.readSkillContent('不存在的技能')).toBeNull();
    });

    it('buildSystemPrompt 注入 L1 技能清单（渐进披露 L1）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
        persona: '你是一位技术文档工程师。',
        skills: { 'skills/summarize.md': '## 提炼要点\n' },
      });

      const manager = new RolePackManager(dir);
      await manager.load();

      const prompt = manager.buildSystemPrompt();
      // L1 元数据：技能名 + 描述常驻
      expect(prompt).toContain('可用技能');
      expect(prompt).toContain('summarize');
      expect(prompt).toContain('read_skill');
    });
  });
});