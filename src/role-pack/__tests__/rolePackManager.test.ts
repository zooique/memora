/**
 * RolePackManager 端到端测试（单一 manifest.json 文件夹形态）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RolePackManager } from '@/role-pack/rolePackManager.js';

/** 单技能角色包（persona + rules + 单技能） */
const MANIFEST_TECH = {
  name: '技术文档工程师',
  formatVersion: '1.0.0',
  description: '技术文档写作',
  author: 'memora',
  interactionType: 'tool_assistant',
  strategy: {},
  skills: [{ file: 'skills/summarize.md', name: 'summarize' }],
  capabilities: [{ capability: 'llm:summarize', description: '提炼要点辅助文档结构规划' }],
};

/** 多技能 + 无 persona（persona 允许缺省） */
const MANIFEST_MULTI_SKILL_NO_PERSONA = {
  name: '全能写手',
  formatVersion: '1.0.0',
  strategy: { act: { toolMode: 'block' } },
  skills: [
    { file: 'skills/write.md', name: 'write' },
    { file: 'skills/search.md', name: 'search' },
    { file: 'skills/read.md', name: 'read' },
  ],
  capabilities: [
    { capability: 'file:write', description: '写入文件' },
    { capability: 'web:search', description: '联网搜索' },
  ],
};

/** 纯能力声明包（顶层 capabilities，能力面独立于技能文件） */
const MANIFEST_PURE_CAPABILITY = {
  name: '项目总监',
  formatVersion: '1.0.0',
  strategy: { act: { toolMode: 'allow' } },
  capabilities: [
    { capability: 'file:read', description: '读取项目文件' },
    { capability: 'web:search', description: '查询行业资料' },
  ],
};

/** 接手衔接提示词包（handoffPrompt 自洽声明，角色包独立） */
const MANIFEST_HANDOFF_PROMPT = {
  name: '写作助手',
  formatVersion: '1.0.0',
  handoffPrompt: '我已准备好开始写作任务，请告诉我主题与要求；若承接上文，请先概述当前进度。',
};

/** 角色包对（翻译助手 / 代码助手，非互斥——v0.13 已移除 exclusiveWith 机制） */
const MANIFEST_TRANSLATOR = {
  name: '翻译助手',
  formatVersion: '1.0.0',
};
const MANIFEST_CODER = {
  name: '代码助手',
  formatVersion: '1.0.0',
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
  await writeFile(join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  if (content.persona !== undefined) {
    // 内容文件约定俗成：身份文件固定为 persona.md（不随 manifest 声明）
    await writeFile(join(packDir, 'persona.md'), content.persona, 'utf-8');
  }
  if (content.rules !== undefined) {
    // 内容文件约定俗成：规则文件固定为 rules.md（不随 manifest 声明）
    await writeFile(join(packDir, 'rules.md'), content.rules, 'utf-8');
  }
  if (content.skills) {
    for (const [relPath, body] of Object.entries(content.skills)) {
      const full = join(packDir, relPath);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, body, 'utf-8');
    }
  }
}

describe('RolePackManager（manifest 文件夹形态）', () => {
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
    // §4.1 单链第一层：显式激活 activePack 参数指定包
    const count = await manager.load('技术文档工程师');
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
    // L1 内容：persona + rules 从独立文件装载
    expect(active!.personaPrompt).toContain('技术文档工程师');
    expect(active!.personaPrompt).toContain('术语保持一致');
    // 技能注册（对象数组，skills 仅文件引用）
    expect(active!.skills).toHaveLength(1);
    expect(active!.skills[0]!.file).toBe('skills/summarize.md');
    // 能力声明由顶层 capabilities 派生
    expect(active!.capabilities).toEqual([
      { capability: 'llm:summarize', description: '提炼要点辅助文档结构规划' },
    ]);
    // 合法包 validationIssues 为空数组（健康，宿主不渲染徽章）
    expect(active!.validationIssues).toEqual([]);
  });

  it('校验透出：带未知键 manifest 的 warning issues 经装配对外可见（不阻塞装载）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 未知键 keywords 走「unknown 键 warning + 忽略」宽容通道（键级渐进设计）
    const manifest = { ...MANIFEST_TECH, name: 'legacy-key', keywords: ['旧'] };
    await writePack(packsDir, 'legacy-key', manifest, {
      persona: '旧键包',
      rules: '',
    });

    const manager = new RolePackManager(dir);
    const count = await manager.load('legacy-key');
    expect(count).toBe(1);
    const active = manager.getActive();
    expect(active).not.toBeNull();
    // warning 透出且不阻塞装载（宽容语义保持）
    const issues = active!.validationIssues ?? [];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.severity === 'warning' && /keywords/i.test(i.message))).toBe(true);
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

  it('内容文件按约定文件名装载（persona.md / rules.md，随目录自动发现）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
      persona: '你是一位技术文档工程师。',
      rules: '- 术语保持一致\n- 不编造 API',
    });

    const manager = new RolePackManager(dir);
    const count = await manager.load('技术文档工程师');
    expect(count).toBe(1);

    const active = manager.getActive();
    expect(active).not.toBeNull();
    // 约定 persona.md 与 rules.md 均被装载并注入 personaPrompt
    expect(active!.personaPrompt).toContain('技术文档工程师');
    expect(active!.personaPrompt).toContain('术语保持一致');
  });

  it('persona frontmatter traits 扁平点路径解析（traits.xxx = 0-1，clamp，缺省 undefined）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 官方示例包写法：扁平点路径键（对齐 parseFrontmatter 按行解析，非嵌套 YAML）
    await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
      persona:
        '---\n' +
        'traits.precision: 0.95\n' +
        'traits.creativity: 0.6\n' +
        'traits.rigor: 1.5\n' + // 越界 → clamp 到 1
        'traits.empathy: -0.2\n' + // 越界 → clamp 到 0
        '---\n\n' +
        '你是一位技术文档工程师。',
    });

    const manager = new RolePackManager(dir);
    await manager.load('技术文档工程师');
    const active = manager.getActive();
    expect(active).not.toBeNull();
    // 扁平 traits.* 键被解析为数值（供宿主情感计算 / UI 徽章）
    expect(active!.traits).toEqual({
      precision: 0.95,
      creativity: 0.6,
      rigor: 1, // clamp 上限
      empathy: 0, // clamp 下限
    });
    // frontmatter 不注入 personaPrompt（仅正文进 system prompt）
    expect(active!.personaPrompt).not.toContain('traits.');
    expect(active!.personaPrompt).toContain('技术文档工程师');
  });

  it('persona 无 traits frontmatter → traits 为 undefined（非空对象）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, {
      persona: '你是翻译。',
    });

    const manager = new RolePackManager(dir);
    await manager.load('翻译助手');
    const active = manager.getActive();
    expect(active).not.toBeNull();
    expect(active!.traits).toBeUndefined();
  });

  it('规则解析支持多格式（列表/段落/引用/标题/代码块/注释）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 混合 markdown 写法：列表（历史格式）+ 段落合并 + 引用块去 > + 标题/代码块/注释/表格排除
    const rulesContent = [
      '# 安全规则', // 标题：不产出规则
      '',
      '- 不泄露用户密钥', // 无序列表：逐条
      '- 不编造 API',
      '',
      '## 质量要求', // 标题：不产出规则
      '',
      '所有输出必须基于文档事实，不得虚构引用。', // 段落开头
      '引用列表须标注来源。', // 连续段落行 → 合并为一条规则
      '',
      '> 重要：修改文件前先询问用户。', // 引用块 → 去 > 并入段落
      '',
      '<!-- 这是注释，不应成为规则 -->', // 注释：排除
      '',
      '| 列A | 列B |', // 表格行：排除
      '| --- | --- |',
      '| x | y |',
      '',
      '```', // 代码块：排除围栏内容
      'const fake = 123;',
      '```',
    ].join('\n');
    await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
      persona: '你是一位技术文档工程师。',
      rules: rulesContent,
    });

    const manager = new RolePackManager(dir);
    await manager.load('技术文档工程师');
    const active = manager.getActive();
    expect(active).not.toBeNull();
    const prompt = active!.personaPrompt;

    // 列表逐条解析（历史行为保留）
    expect(prompt).toContain('不泄露用户密钥');
    expect(prompt).toContain('不编造 API');
    // 连续段落合并为一条规则（多行以空格拼接；中文句子间存在拼接空格，分两段断言）
    expect(prompt).toContain('所有输出必须基于文档事实，不得虚构引用。');
    expect(prompt).toContain('引用列表须标注来源。');
    expect(prompt).toMatch(/所有输出必须基于文档事实，不得虚构引用。\s*引用列表须标注来源。/);
    // 引用块去 > 作为独立规则
    expect(prompt).toContain('重要：修改文件前先询问用户。');
    // 标题/注释/表格/代码块不作为规则注入
    expect(prompt).not.toContain('# 安全规则');
    expect(prompt).not.toContain('质量要求');
    expect(prompt).not.toContain('这是注释');
    expect(prompt).not.toContain('const fake');
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
    expect(await manager.load('全能写手')).toBe(1);

    const active = manager.getActive();
    expect(active!.meta.name).toBe('全能写手');
    // 三个技能全部注册（目录扫描，顺序为文件系统序——断言排序无关）
    expect(active!.skills.map((s) => s.name).sort()).toEqual(['read', 'search', 'write']);
    // persona 缺省 → personaPrompt 不含身份设定，仅规则注入
    expect(active!.personaPrompt).toContain('不生成违法内容');
    // 能力声明聚合（仅声明了 capability 的项）
    expect(active!.capabilities.map((c) => c.capability).sort()).toEqual([
      'file:write',
      'web:search',
    ]);
  });

  it('纯能力声明包：顶层 capabilities 独立装载（能力面与技能文件分离）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '项目总监', MANIFEST_PURE_CAPABILITY, {
      persona: '你是一位项目总监。',
      rules: '- 风险前置识别',
    });

    const manager = new RolePackManager(dir);
    expect(await manager.load('项目总监')).toBe(1);

    const active = manager.getActive();
    expect(active!.meta.name).toBe('项目总监');
    // 纯能力声明在顶层 capabilities，skills 为空（无技能文件引用）
    expect(active!.skills).toHaveLength(0);
    // capabilities 独立派生
    expect(active!.capabilities.map((c) => c.capability).sort()).toEqual([
      'file:read',
      'web:search',
    ]);
  });

  it('skills 目录动态扫描：未声明 manifest.skills 时全量扫描 + frontmatter 元数据', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 不含 skills 字段的 manifest——技能靠目录扫描注册
    const { skills: _omit, ...manifestNoSkills } = MANIFEST_TECH;
    void _omit;
    await writePack(packsDir, '技术文档工程师', manifestNoSkills, {
      persona: '你是一位技术文档工程师。',
      skills: {
        'skills/summarize.md':
          '---\nname: summarize\ndescription: 提炼要点\n---\n\n# summarize\n内容',
        'skills/template.md': '---\nname: template\ndescription: 文档模板\n---\n\n# template\n内容',
      },
    });

    const manager = new RolePackManager(dir);
    expect(await manager.load('技术文档工程师')).toBe(1);

    const active = manager.getActive();
    expect(active).not.toBeNull();
    // 目录扫描注册两个技能（顺序为文件系统序，排序无关断言）
    expect(active!.skills.map((s) => s.name).sort()).toEqual(['summarize', 'template']);
    // frontmatter description 暴露给 LLM（渐进披露 L1）
    const summarize = active!.skills.find((s) => s.name === 'summarize');
    expect(summarize?.description).toBe('提炼要点');
  });

  it('manifest.skills.file 路径穿越被拒绝（resolveSafePath 边界防护）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    // 恶意 manifest：file 指向包外（../ 逃逸）
    const manifestEvil = {
      ...MANIFEST_TECH,
      skills: [
        { file: '../outside.md', name: 'escape' },
        { file: '../skills-外/secret.md', name: 'prefix-bypass' },
      ],
    };
    // 在包外放一个会被扫描到的兄弟目录（若是前缀检查缺失，../skills-外 会被误当包内技能）
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });
    const packDir = join(packsDir, '技术文档工程师');
    await mkdir(packDir, { recursive: true });
    await writeFile(join(packDir, 'manifest.json'), JSON.stringify(manifestEvil, null, 2), 'utf-8');

    const manager = new RolePackManager(dir);
    // 两个包：翻译助手 + 技术文档工程师（恶意 manifest）
    expect(await manager.load('技术文档工程师')).toBe(2);

    const active = manager.getActive();
    // 穿越项被忽略：白名单为空 → skills 退回目录扫描（包内无 skills 目录 → 空）
    expect(active!.meta.name).toBe('技术文档工程师');
    expect(active!.skills).toHaveLength(0);
  });

  it('handoffPrompt 自洽声明透传（角色包只描述自己，无跨包引用）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '写作助手', MANIFEST_HANDOFF_PROMPT, {
      persona: '你是一位写作助手。',
    });

    const manager = new RolePackManager(dir);
    expect(await manager.load('写作助手')).toBe(1);

    const meta = manager.getActive()!.meta;
    expect(meta.handoffPrompt).toBe(
      '我已准备好开始写作任务，请告诉我主题与要求；若承接上文，请先概述当前进度。',
    );
  });

  it('未声明 handoffPrompt → meta.handoffPrompt 为 undefined', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });

    const manager = new RolePackManager(dir);
    expect(await manager.load('翻译助手')).toBe(1);
    expect(manager.getActive()!.meta.handoffPrompt).toBeUndefined();
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
    await manager.load('翻译助手');
    manager.activate('代码助手');
    expect(manager.activeName).toBe('代码助手');

    await manager.reload();
    expect(manager.activeName).toBe('代码助手');
    expect(manager.getActive()!.meta.name).toBe('代码助手');
  });

  it('getActiveRules：返回激活角色包的规则列表（无激活返回空数组）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '技术文档工程师', MANIFEST_TECH, {
      persona: '你是一位技术文档工程师。',
      rules: '- 术语保持一致\n- 不编造 API',
    });

    const manager = new RolePackManager(dir);
    await manager.load('技术文档工程师');
    // 设定记忆归角色包后，规则以角色包为准
    expect(manager.getActiveRules()).toEqual(['术语保持一致', '不编造 API']);

    // 无激活时返回空数组（§7 降级优先：不装配失败）
    const emptyManager = new RolePackManager(join(dir, 'empty'));
    expect(emptyManager.getActiveRules()).toEqual([]);
  });

  it('reload 保留 loadExtraDir 注入的用户角色包（运行时注入项无磁盘真理源）', async () => {
    // 内置角色包目录（configDir/role-packs/，扫描真理源）
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });

    // 用户角色包目录（独立目录，宿主经 loadExtraDir 运行态注入）
    const userPacksDir = join(dir, 'user-role-packs');
    await writePack(
      userPacksDir,
      '用户打磨',
      {
        name: '用户打磨',
        formatVersion: '1.0.0',
      },
      { persona: '你是用户自建角色。' },
    );

    const manager = new RolePackManager(dir);
    await manager.load('翻译助手');
    // 用户包注入（与宿主 assemble.ts loadExtraDir(userRolePacksDir) 同路径）
    const injected = await manager.loadExtraDir(userPacksDir);
    expect(injected).toBe(1);
    expect(
      manager
        .listMeta()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['用户打磨', '翻译助手']);

    // reload 后用户包必须保留（与 SkillManager 行为一致：注入项不随磁盘重扫抹除）
    await manager.reload();
    const names = manager
      .listMeta()
      .map((m) => m.name)
      .sort();
    expect(names).toEqual(['用户打磨', '翻译助手']);
    // 激活态保持
    expect(manager.activeName).toBe('翻译助手');
  });

  it('reload 后内置包保持磁盘真理源（磁盘包不被用户包覆盖）', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '内置翻译。' });

    const userPacksDir = join(dir, 'user-role-packs');
    // 用户包与内置同名——loadExtraDir 重名跳过（内置优先），确认设备磁盘真理源不被稀释
    await writePack(
      userPacksDir,
      '翻译助手',
      { name: '翻译助手', formatVersion: '1.0.0' },
      {
        persona: '用户版本翻译。',
      },
    );

    const manager = new RolePackManager(dir);
    await manager.load('翻译助手');
    expect(manager.activeName).toBe('翻译助手');
    // loadExtraDir 重名跳过（内置优先）
    expect(await manager.loadExtraDir(userPacksDir)).toBe(0);

    // reload 后磁盘包仍为真理源（内置版本 persona 生效）
    await manager.reload();
    expect(manager.activeName).toBe('翻译助手');
    expect(manager.listMeta()).toHaveLength(1);
    const active = manager.getActive();
    expect(active!.meta.name).toBe('翻译助手');
    expect(active!.personaPrompt).toContain('内置翻译');
  });

  it('companion 角色包触发内容红线 → 拒绝装载', async () => {
    const packsDir = join(dir, 'role-packs');
    await mkdir(packsDir, { recursive: true });
    await writePack(
      packsDir,
      '红伴',
      {
        name: '红伴',
        formatVersion: '1.0.0',
        interactionType: 'companion',
        aiIdentityDisclosure: true,
        minorProtection: 'required',
      },
      { persona: '你是用户的虚拟伴侣。' },
    );

    const manager = new RolePackManager(dir);
    expect(await manager.load()).toBe(0);
  });

  describe('§4.1 选择解析单链（activeRolePack → 兜底包）', () => {
    /** 写一组角色包 + 兜底契约包（模拟内核分发形态） */
    async function writePacksWithFallback(): Promise<string> {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });
      await writePack(packsDir, '代码助手', MANIFEST_CODER, { persona: '你是程序员。' });
      await writePack(
        packsDir,
        'memora助手',
        { name: 'memora助手', formatVersion: '1.0.0' },
        {
          persona: '你是通用助手。',
        },
      );
      return packsDir;
    }

    it('无 activePack → 落兜底包（默认激活 memora助手，不再回退 items[0]）', async () => {
      await writePacksWithFallback();
      const manager = new RolePackManager(dir);
      await manager.load();
      expect(manager.activeName).toBe('memora助手');
    });

    it('activePack 有效 → 激活该包（解析链第一层）', async () => {
      await writePacksWithFallback();
      const manager = new RolePackManager(dir);
      await manager.load('代码助手');
      expect(manager.activeName).toBe('代码助手');
    });

    it('activePack 不存在 → 落兜底包（warning 不抛错）', async () => {
      await writePacksWithFallback();
      const manager = new RolePackManager(dir);
      await manager.load('不存在的包');
      expect(manager.activeName).toBe('memora助手');
    });

    it('builtinFallbackRole 覆盖存在 → 用覆盖包；覆盖不存在 → 回退内核常量', async () => {
      const packsDir = await writePacksWithFallback();
      const manager = new RolePackManager(dir);
      // 覆盖存在 → 用覆盖
      manager.setBuiltinFallbackRole('翻译助手');
      await manager.load();
      expect(manager.activeName).toBe('翻译助手');
      // 覆盖不存在 → 回退内核常量（memora助手）：删除当前激活包触发单链兜底
      manager.setBuiltinFallbackRole('幻影助手');
      await rm(join(packsDir, '翻译助手'), { recursive: true, force: true });
      await manager.reload();
      expect(manager.activeName).toBe('memora助手');
    });

    it('兜底包运行时缺失 → 无 persona 继续运行（activeName=null + warning，不装配失败）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      // 只有翻译/代码，无兜底契约包（模拟用户手动删了兜底文件）
      await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR, { persona: '你是翻译。' });
      const manager = new RolePackManager(dir);
      await manager.load();
      expect(manager.activeName).toBeNull();
    });

    it('reload 激活包被删 → 落兜底包（不再回退 items[0]）', async () => {
      const packsDir = await writePacksWithFallback();
      const manager = new RolePackManager(dir);
      await manager.load('代码助手');
      await rm(join(packsDir, '代码助手'), { recursive: true, force: true });
      await manager.reload();
      expect(manager.activeName).toBe('memora助手');
    });
  });

  describe('组数据校验（S4，装载后）', () => {
    it('组长身份唯一 / 名单非空 / 引用悬空 → warning（不阻塞装载）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '组长A', { name: '组长A', formatVersion: '1.0.0' }, {});
      await writePack(packsDir, '组长B', { name: '组长B', formatVersion: '1.0.0' }, {});
      await writePack(packsDir, '组员1', { name: '组员1', formatVersion: '1.0.0' }, {});

      const manager = new RolePackManager(dir);
      // 组长A 两处任组长（不唯一）+ 组长B 名单为空 + 组员引用悬空（幻影组员）
      manager.setRolePackTeams([
        { leader: '组长A', members: ['组员1'] },
        { leader: '组长A', members: ['组员1'] },
        { leader: '组长B', members: [] },
        { leader: '组长B', members: ['幻影组员'] },
      ]);
      // warning 不阻塞装载
      expect(await manager.load('组长A')).toBe(3);
      expect(manager.activeName).toBe('组长A');
    });

    it('组长与组员身份互斥：成员名单含组长 → warning（不阻塞装载）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '组长A', { name: '组长A', formatVersion: '1.0.0' }, {});
      await writePack(packsDir, '组员1', { name: '组员1', formatVersion: '1.0.0' }, {});

      const manager = new RolePackManager(dir);
      // 组长A 同时出现在自己的成员名单里（身份互斥被破坏）
      manager.setRolePackTeams([{ leader: '组长A', members: ['组长A', '组员1'] }]);
      // warning 不阻塞装载
      expect(await manager.load('组长A')).toBe(2);
      expect(manager.activeName).toBe('组长A');
      // 会议解析时：组长自身按组员处理 → 落入组长视角（键恒为 activePack）
      expect(manager.resolveRoundAssemblyRole('组长A')).toBe('组长A');
    });

    it('组员数量超上限（队长 1 + 组员 > 4）→ warning（不阻塞装载）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '组长A', { name: '组长A', formatVersion: '1.0.0' }, {});
      // 5 个组员（超上限 4）
      for (let i = 1; i <= 5; i++) {
        await writePack(packsDir, `组员${i}`, { name: `组员${i}`, formatVersion: '1.0.0' }, {});
      }
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([
        { leader: '组长A', members: ['组员1', '组员2', '组员3', '组员4', '组员5'] },
      ]);
      // warning 不阻塞装载（超限数据不裁切存储，仅会议消费端截断，见下方截断用例）
      expect(await manager.load('组长A')).toBe(6);
      expect(manager.activeName).toBe('组长A');
    });
  });

  describe('会议机制：resolveRoundAssemblyRole 范围校验 + 表层装配视角（S5）', () => {
    /** 组长 = 组长A，组员 = 组员1 */
    async function writeTeamPacks(): Promise<void> {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '组长A', { name: '组长A', formatVersion: '1.0.0' }, {});
      await writePack(packsDir, '组员1', { name: '组员1', formatVersion: '1.0.0' }, {});
    }

    it('组长（activePack）恒有效；组员在名单内且存在 → 有效', async () => {
      await writeTeamPacks();
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
      await manager.load('组长A');
      expect(manager.resolveRoundAssemblyRole('组长A')).toBe('组长A');
      expect(manager.resolveRoundAssemblyRole('组员1')).toBe('组员1');
    });

    it('越界 rolePack（非组长/组员）→ 忽略覆盖返回 null（防 LLM 幻觉角色名）', async () => {
      await writeTeamPacks();
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
      await manager.load('组长A');
      expect(manager.resolveRoundAssemblyRole('幻觉角色')).toBeNull();
    });

    it('组员角色包不存在（缺员）→ 跳过返回 null', async () => {
      await writeTeamPacks();
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1', '缺员'] }]);
      await manager.load('组长A');
      expect(manager.resolveRoundAssemblyRole('缺员')).toBeNull();
      expect(manager.resolveRoundAssemblyRole('组员1')).toBe('组员1');
    });

    it('无声明 → 非会议（null）；会议视角设置后 skills 加载跟随装配视角', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(
        packsDir,
        '组长A',
        { name: '组长A', formatVersion: '1.0.0' },
        {
          skills: { 'skills/lead.md': '## 组长技能\n' },
        },
      );
      await writePack(
        packsDir,
        '组员1',
        { name: '组员1', formatVersion: '1.0.0' },
        {
          skills: { 'skills/member.md': '## 组员技能\n' },
        },
      );
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
      await manager.load('组长A');
      expect(manager.resolveRoundAssemblyRole(undefined)).toBeNull();
      // 日常态（无会议视角）：读组长技能
      expect(await manager.readSkillContent('lead')).toContain('组长技能');
      expect(await manager.readSkillContent('member')).toBeNull();
      // 会议视角 = 组员1 → skills 加载跟随装配视角（键仍恒为 activePack）
      manager.setRoundAssemblyRole('组员1');
      expect(await manager.readSkillContent('member')).toContain('组员技能');
      // 回到日常态 → 回落组长
      manager.setRoundAssemblyRole(null);
      expect(await manager.readSkillContent('member')).toBeNull();
    });

    it('buildTeamContextBlock：activePack 是组长时产出组/成员清单，否则空串', async () => {
      await writeTeamPacks();
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
      await manager.load('组长A');
      const block = manager.buildTeamContextBlock();
      expect(block).toContain('组长A');
      expect(block).toContain('组员1');
      expect(block).toContain('task_table_write');
      expect(block).toContain('task_table_update');
      // 显式禁止 write_file 模拟任务表（触发样本实证 LLM 曾绕过 PlanItem 通道）
      expect(block).toContain('禁止用 write_file');
      // 切到非组长 → 空串（不注入）
      manager.activate('组员1');
      expect(manager.buildTeamContextBlock()).toBe('');
    });

    it('buildTeamContextBlock：告知骨架预置 + rolePack 切换纪律 + 禁止 write_file 伪建表', async () => {
      await writeTeamPacks();
      const manager = new RolePackManager(dir);
      manager.setRolePackTeams([{ leader: '组长A', members: ['组员1', '组员2'] }]);
      await manager.load('组长A');
      const block = manager.buildTeamContextBlock();
      // 确定性骨架已由 tryBuildMeetingPlan 预置（「最小受控起点」半反转），文案告知 LLM 骨架存在
      expect(block).toContain('小组会议');
      expect(block).toContain('骨架');
      expect(block).toContain('rolePack=对应组员');
      expect(block).toContain('task_table_update');
      // 伪建表禁令（触发样本：LLM 曾用 write_file 写 .memora/task-table.md 绕过 PlanItem 通道）
      expect(block).toContain('禁止用 write_file');
    });

    describe('tryBuildMeetingPlan：骨架预置（最小受控起点半反转）', () => {
      it('组长 + 「小组会议」→ 组长开场项 + 组员各一项(带 rolePack) + 汇总项(无 rolePack)', async () => {
        await writeTeamPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([{ leader: '组长A', members: ['组员1', '组员2'] }]);
        await manager.load('组长A');
        const items = manager.tryBuildMeetingPlan('小组会议：讨论叙事平台');
        expect(items).not.toBeNull();
        // 组长开场项：无 rolePack = 默认组长视角（主持引入议题）
        expect(items![0]).toEqual({ description: '组长A 主持开场：讨论叙事平台' });
        // 组员各一项，rolePack = 成员（触发表层装配硬切换）
        expect(items![1]).toEqual({ description: '组员1 发言：讨论叙事平台', rolePack: '组员1' });
        expect(items![2]).toEqual({ description: '组员2 发言：讨论叙事平台', rolePack: '组员2' });
        // 末项汇总，无 rolePack（组长视角收尾）
        expect(items![3]).toEqual({ description: '汇总各方观点：讨论叙事平台' });
        expect(items).toHaveLength(4);
      });

      it('无「小组会议」keyword → null（回落普通闭环）', async () => {
        await writeTeamPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
        await manager.load('组长A');
        expect(manager.tryBuildMeetingPlan('请评审这份文档')).toBeNull();
      });

      it('activePack 非组长 → null', async () => {
        await writeTeamPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
        await manager.load('组员1'); // 激活的是组员，非组长
        expect(manager.tryBuildMeetingPlan('小组会议：讨论xxx')).toBeNull();
      });

      it('主题可缺省（仅「小组会议」）→ 任务项不带主题后缀', async () => {
        await writeTeamPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([{ leader: '组长A', members: ['组员1'] }]);
        await manager.load('组长A');
        const items = manager.tryBuildMeetingPlan('小组会议');
        expect(items![0]).toEqual({ description: '组长A 主持开场' });
        expect(items![1]).toEqual({ description: '组员1 发言', rolePack: '组员1' });
        expect(items![2]).toEqual({ description: '汇总各方观点' });
      });
    });

    describe('组员数量上限：超限部分不参与会议（截断收口，② 组队规格）', () => {
      /** 组长 = 组长A，组员 = 组员1~5（超上限 4） */
      async function writeOverLimitPacks(): Promise<void> {
        const packsDir = join(dir, 'role-packs');
        await mkdir(packsDir, { recursive: true });
        await writePack(packsDir, '组长A', { name: '组长A', formatVersion: '1.0.0' }, {});
        for (let i = 1; i <= 5; i++) {
          await writePack(packsDir, `组员${i}`, { name: `组员${i}`, formatVersion: '1.0.0' }, {});
        }
      }

      it('resolveRoundAssemblyRole：第 5 名组员声明 → 越界返回 null（不参与会议）', async () => {
        await writeOverLimitPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([
          { leader: '组长A', members: ['组员1', '组员2', '组员3', '组员4', '组员5'] },
        ]);
        await manager.load('组长A');
        // 前 4 名有效
        expect(manager.resolveRoundAssemblyRole('组员4')).toBe('组员4');
        // 第 5 名被截断 → 视作越界
        expect(manager.resolveRoundAssemblyRole('组员5')).toBeNull();
      });

      it('buildTeamContextBlock：只暴露前 4 名组员，不含超限的第 5 名', async () => {
        await writeOverLimitPacks();
        const manager = new RolePackManager(dir);
        manager.setRolePackTeams([
          { leader: '组长A', members: ['组员1', '组员2', '组员3', '组员4', '组员5'] },
        ]);
        await manager.load('组长A');
        const block = manager.buildTeamContextBlock();
        expect(block).toContain('组员4');
        expect(block).not.toContain('组员5');
      });
    });
  });

  describe('激活变更回调 onRolePackActivated', () => {
    it('activate 切换时触发 (from, to) 回调', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH);
      await writePack(packsDir, '全能写手', MANIFEST_MULTI_SKILL_NO_PERSONA);

      const manager = new RolePackManager(dir);
      const calls: Array<[string | null, string | null]> = [];
      manager.onRolePackActivated((from, to) => calls.push([from, to]));

      await manager.load('技术文档工程师');
      manager.activate('全能写手');
      expect(calls).toEqual([
        [null, '技术文档工程师'], // load 时注册回调后经 activePack 参数触发
        ['技术文档工程师', '全能写手'],
      ]);
    });

    it('同名激活不触发回调', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH);

      const manager = new RolePackManager(dir);
      await manager.load('技术文档工程师');
      // load 默认激活 activePack 参数指定包（未注册回调故不记录），后再注册回调验证同名幂等
      const calls: Array<[string | null, string | null]> = [];
      manager.onRolePackActivated((from, to) => calls.push([from, to]));
      manager.activate('技术文档工程师');
      expect(calls).toEqual([]);
    });

    it('同名重复激活不消耗切换配额（幂等短路，SSOT）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH);
      await writePack(packsDir, '全能写手', MANIFEST_MULTI_SKILL_NO_PERSONA);

      const manager = new RolePackManager(dir);
      await manager.load('技术文档工程师');

      // 远超市限阈值地重复激活同一已激活包——幂等短路使每次都是 no-op，不累计切换配额
      const MAX = 100;
      for (let i = 0; i < MAX; i++) {
        expect(manager.activate('技术文档工程师')).toBe(true);
      }
      // 未触发限流锁：后续真切换仍可进行（若同包激活消耗配额，早该锁定）
      expect(manager.getSwitchLockStatus().locked).toBe(false);
      expect(manager.activate('全能写手')).toBe(true);
      expect(manager.activeName).toBe('全能写手');
    });

    it('reload 激活包被删除时回退触发回调（落兜底包）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH);
      await writePack(packsDir, '全能写手', MANIFEST_MULTI_SKILL_NO_PERSONA);
      await writePack(packsDir, 'memora助手', { name: 'memora助手', formatVersion: '1.0.0' });

      const manager = new RolePackManager(dir);
      const calls: Array<[string | null, string | null]> = [];
      manager.onRolePackActivated((from, to) => calls.push([from, to]));

      await manager.load('技术文档工程师');
      manager.activate('全能写手');
      calls.length = 0; // 清掉前置回调，聚焦 reload 回退

      // 删除当前激活的角色包后 reload → §4.1 单链落兜底包（非 items[0]）
      await rm(join(packsDir, '全能写手'), { recursive: true, force: true });
      await manager.reload();
      expect(manager.activeName).toBe('memora助手');
      expect(calls.at(-1)).toEqual(['全能写手', 'memora助手']);
    });
  });

  describe('切换限流锁定 onRolePackSwitchLocked（30s 内 >5 次切换 → 锁 120s）', () => {
    // 限流依赖真实时钟窗口（SWITCH_WINDOW_MS=30s），用 fake timers 精确控制窗口与自动解锁
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function loadSixPacks(manager: RolePackManager): Promise<void> {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      // 复用在册 6 个 manifest 常量做切换对象（load 首个不消耗配额，其余供 activate 轮换）
      await writePack(packsDir, '技术文档工程师', MANIFEST_TECH);
      await writePack(packsDir, '全能写手', MANIFEST_MULTI_SKILL_NO_PERSONA);
      await writePack(packsDir, '项目总监', MANIFEST_PURE_CAPABILITY);
      await writePack(packsDir, '写作助手', MANIFEST_HANDOFF_PROMPT);
      await writePack(packsDir, '翻译助手', MANIFEST_TRANSLATOR);
      await writePack(packsDir, '代码助手', MANIFEST_CODER);
      await manager.load('技术文档工程师');
    }

    it('第 5 次窗口内真切换 → 锁定 + 回调通知 + 状态可查；锁定中 activate 拒绝', async () => {
      const manager = new RolePackManager(dir);
      await loadSixPacks(manager);

      // 幂等短路不消耗配额：重复激活当前包验证「未提前锁定」
      expect(manager.activate('技术文档工程师')).toBe(true);
      expect(manager.getSwitchLockStatus().locked).toBe(false);

      const lockCalls: Array<{ reason: string; lockedSeconds: number }> = [];
      manager.onRolePackSwitchLocked((reason, lockedSeconds) =>
        lockCalls.push({ reason, lockedSeconds }),
      );

      // 连续真切换（窗口内 5 次）→ 触发锁定（846-861：长度达阈值即锁 + 回调）
      expect(manager.activate('全能写手')).toBe(true);
      expect(manager.activate('项目总监')).toBe(true);
      expect(manager.activate('写作助手')).toBe(true);
      expect(manager.activate('翻译助手')).toBe(true);
      expect(manager.activate('代码助手')).toBe(true);

      const status = manager.getSwitchLockStatus();
      expect(status.locked).toBe(true);
      expect(status.unlockAt).not.toBeNull();
      // 锁定回调：reason 描述限流 + lockedSeconds = 120s（AUTO_UNLOCK_MS）
      expect(lockCalls).toHaveLength(1);
      expect(lockCalls[0]!.lockedSeconds).toBe(120);
      expect(lockCalls[0]!.reason).toContain('限流锁定');

      // 锁定中任何激活被拒绝（保持当前，返回 false）
      expect(manager.activate('技术文档工程师')).toBe(false);
      expect(manager.activeName).toBe('代码助手');
    });

    it('AUTO_UNLOCK_MS 自动恢复：锁解除后激活恢复可用', async () => {
      const manager = new RolePackManager(dir);
      await loadSixPacks(manager);

      // 触发锁定（同 5 次真切换）
      manager.activate('全能写手');
      manager.activate('项目总监');
      manager.activate('写作助手');
      manager.activate('翻译助手');
      manager.activate('代码助手');
      expect(manager.getSwitchLockStatus().locked).toBe(true);

      // 前进 120s → unlockTimer 触发自动解锁（851-857：清锁 + 清时间戳）
      vi.advanceTimersByTime(120_000);
      expect(manager.getSwitchLockStatus().locked).toBe(false);
      expect(manager.getSwitchLockStatus().unlockAt).toBeNull();
      // 解锁后新激活正常；且时间戳已清空，窗口重新计
      expect(manager.activate('技术文档工程师')).toBe(true);
      expect(manager.activeName).toBe('技术文档工程师');
    });

    it('close() 清理锁定计时器：锁态复位，不再自动恢复回调', async () => {
      const manager = new RolePackManager(dir);
      await loadSixPacks(manager);

      manager.activate('全能写手');
      manager.activate('项目总监');
      manager.activate('写作助手');
      manager.activate('翻译助手');
      manager.activate('代码助手');
      expect(manager.getSwitchLockStatus().locked).toBe(true);

      // close 清 timer + 锁态复位（SSOT：生命周期归属管理器自身，防关闭后回调触发）
      manager.close();
      expect(manager.getSwitchLockStatus().locked).toBe(false);
      expect(manager.getSwitchLockStatus().unlockAt).toBeNull();
      // 已 clearTimeout：时钟前进不会再触发自动恢复副作用（close 后状态恒复位）
      vi.advanceTimersByTime(120_000);
      expect(manager.getSwitchLockStatus().locked).toBe(false);
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
      await manager.load('技术文档工程师');

      // 按 name（manifest.skills[].name）读取激活角色包技能正文
      const content = await manager.readSkillContent('summarize');
      expect(content).toContain('识别核心');
      expect(content).toContain('精简表达');
    });

    it('readSkillContent 按文件名去扩展名匹配（无 name 时）', async () => {
      const packsDir = join(dir, 'role-packs');
      await mkdir(packsDir, { recursive: true });
      // 纯能力声明包 skills 无 name 只有 file
      await writePack(
        packsDir,
        '项目总监',
        {
          name: '项目总监',
          formatVersion: '1.0.0',
          skills: [{ file: 'skills/review.md', capability: 'task:plan', description: '审查计划' }],
        },
        { persona: '你是项目总监。', skills: { 'skills/review.md': '## 审查流程\n' } },
      );

      const manager = new RolePackManager(dir);
      await manager.load('项目总监');

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
      await manager.load('技术文档工程师');

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
      await manager.load('技术文档工程师');

      const prompt = manager.buildSystemPrompt();
      // L1 元数据：技能名 + 描述常驻
      expect(prompt).toContain('可用技能');
      expect(prompt).toContain('summarize');
      expect(prompt).toContain('read_skill');
    });

    it('readSkillResource：L3 layer3 白名单拦截（未登记/兄弟目录路径被拒）', async () => {
      const packsDir = join(dir, 'role-packs');
      const skillPack = join(packsDir, '文档专家', 'skills', 'doc-gen');
      // 构造文件夹式技能：SKILL.md + resources/api.md（使 scanPackSkills 发现 layer3.resources）
      await mkdir(join(skillPack, 'resources'), { recursive: true });
      await writeFile(
        join(skillPack, 'SKILL.md'),
        '---\nname: 文档生成\n---\n# 文档生成\n',
        'utf-8',
      );
      await writeFile(join(skillPack, 'resources', 'api.md'), 'API 参考文档内容', 'utf-8');
      // 兄弟目录：模拟攻击者想越权读取的 resources-evil/
      await mkdir(join(packsDir, '文档专家', 'skills', 'doc-gen-evil'), { recursive: true });
      await writeFile(
        join(packsDir, '文档专家', 'skills', 'doc-gen-evil', 'secret.txt'),
        '越权内容',
        'utf-8',
      );
      await writeFile(
        join(packsDir, '文档专家', 'manifest.json'),
        // 不声明 skills → 走目录全量扫描（声明须为对象数组 [{ file }]，否则 validator 判 error 并拒绝装载）
        JSON.stringify({ name: '文档专家' }),
        'utf-8',
      );

      const manager = new RolePackManager(dir);
      await manager.load('文档专家');

      // 已登记的资源可读（layer3 内）
      const ok = await manager.readSkillResource('文档生成', 'api.md');
      expect(ok).toBe('API 参考文档内容');

      // 未登记的路径拒绝：兄弟目录穿越（resolveSafePath 边界前缀拦截）
      const bad = await manager.readSkillResource('文档生成', '../doc-gen-evil/secret.txt');
      expect(bad).toBeNull();
    });

    it('readSkillResource：references/ 目录资源可读（B1 兼容主流辅助文档目录）', async () => {
      const packsDir = join(dir, 'role-packs');
      const skillPack = join(packsDir, '文档专家2', 'skills', 'doc-gen');
      // 构造文件夹式技能：SKILL.md + references/modes.md（references/ 纳入 layer3）
      await mkdir(join(skillPack, 'references'), { recursive: true });
      await writeFile(
        join(skillPack, 'SKILL.md'),
        '---\nname: 文档生成2\n---\n# 文档生成2\n',
        'utf-8',
      );
      await writeFile(join(skillPack, 'references', 'modes.md'), 'Modes 参考文档内容', 'utf-8');
      await writeFile(
        join(packsDir, '文档专家2', 'manifest.json'),
        JSON.stringify({ name: '文档专家2' }),
        'utf-8',
      );

      const manager = new RolePackManager(dir);
      await manager.load('文档专家2');

      // references/ 下资源进入 layer3 并可读（subdir=references）
      const ref = await manager.readSkillResource('文档生成2', 'modes.md');
      expect(ref).toBe('Modes 参考文档内容');
      // 未登记的穿越路径仍被拒绝
      const bad = await manager.readSkillResource('文档生成2', '../secret.txt');
      expect(bad).toBeNull();
    });

    it('getSkillScriptPath：已登记脚本返回安全路径；未登记/越界被拒（L3 白名单双层防护）', async () => {
      const packsDir = join(dir, 'role-packs');
      const skillPack = join(packsDir, '脚本包', 'skills', 'script-tool');
      // 文件夹式技能：SKILL.md + scripts/run.sh（scanPackSkills 发现 layer3.scripts）
      await mkdir(join(skillPack, 'scripts'), { recursive: true });
      await writeFile(
        join(skillPack, 'SKILL.md'),
        '---\nname: 脚本工具\n---\n# 脚本工具\n',
        'utf-8',
      );
      await writeFile(join(skillPack, 'scripts', 'run.sh'), 'echo hi', 'utf-8');
      await writeFile(
        join(packsDir, '脚本包', 'manifest.json'),
        JSON.stringify({ name: '脚本包' }),
        'utf-8',
      );

      const manager = new RolePackManager(dir);
      await manager.load('脚本包');

      // 已登记的脚本定位到实际路径（resolveSafePath 收敛在技能 scripts/ 目录内）
      const path = manager.getSkillScriptPath('脚本工具', 'run.sh');
      expect(path).not.toBeNull();
      expect(path!.toLowerCase()).toContain(join('scripts', 'run.sh').toLowerCase());
      // 未登记的脚本 → null（layer3 白名单前置检查，不落 resolveSafePath）
      expect(manager.getSkillScriptPath('脚本工具', 'not-exist.sh')).toBeNull();
      // 越界脚本 → null（白名单 none-match 即拒；即使登记也过不了 resolveSafePath 前缀）
      expect(manager.getSkillScriptPath('脚本工具', '../evil.sh')).toBeNull();
      // 技能不存在 → null
      expect(manager.getSkillScriptPath('不存在的技能', 'run.sh')).toBeNull();
    });

    it('getSkillScriptInfo：扫描 runtime 优先；未登记脚本按扩展名回退推断 runtime', async () => {
      const packsDir = join(dir, 'role-packs');
      const skillPack = join(packsDir, '脚本包', 'skills', 'script-tool');
      await mkdir(join(skillPack, 'scripts'), { recursive: true });
      await writeFile(
        join(skillPack, 'SKILL.md'),
        '---\nname: 脚本工具\n---\n# 脚本工具\n',
        'utf-8',
      );
      await writeFile(join(skillPack, 'scripts', 'run.sh'), 'echo hi', 'utf-8');
      // 未登记脚本：仅作扩展名推断样例（运行.py 不入 layer3，应走回退分支）
      await writeFile(join(skillPack, 'scripts', '运行.py'), 'print(1)', 'utf-8');
      await writeFile(
        join(packsDir, '脚本包', 'manifest.json'),
        JSON.stringify({ name: '脚本包' }),
        'utf-8',
      );

      const manager = new RolePackManager(dir);
      await manager.load('脚本包');

      // 已登记脚本：runtime 从 scanPackSkills 的 layer3 扫描结果获取（shell）
      expect(manager.getSkillScriptInfo('脚本工具', 'run.sh')).toEqual({ runtime: 'shell' });
      // 未登记但扩展名可推断：回退共享 runtime 映射（scanner.inferRuntimeFromExt）分支
      expect(manager.getSkillScriptInfo('脚本工具', '运行.py')).toEqual({ runtime: 'python' });
      // 无法识别的扩展名 → null
      expect(manager.getSkillScriptInfo('脚本工具', 'data.bin')).toBeNull();
    });

    it('listSkillResources / listSkills：L3 资源清单与 L1 技能清单投影（SSOT 展示数据源）', async () => {
      const packsDir = join(dir, 'role-packs');
      const skillPack = join(packsDir, '资源包', 'skills', 'res-tool');
      // 文件夹式技能同时带 resources/ 与 scripts/，验证两者各自投影
      await mkdir(join(skillPack, 'resources'), { recursive: true });
      await mkdir(join(skillPack, 'scripts'), { recursive: true });
      await writeFile(
        join(skillPack, 'SKILL.md'),
        '---\nname: 资源工具\n---\n# 资源工具\n',
        'utf-8',
      );
      await writeFile(join(skillPack, 'resources', 'api.md'), 'API', 'utf-8');
      await writeFile(join(skillPack, 'scripts', 'run.sh'), 'echo hi', 'utf-8');
      await writeFile(
        join(packsDir, '资源包', 'manifest.json'),
        JSON.stringify({ name: '资源包' }),
        'utf-8',
      );

      const manager = new RolePackManager(dir);
      await manager.load('资源包');

      // L3 资源清单投影（path + size）
      const resources = manager.listSkillResources('资源工具');
      expect(resources).toHaveLength(1);
      expect(resources[0]!.path).toBe('api.md');
      expect(resources[0]!.size).toBeGreaterThan(0);
      // 无资源技能 → 空数组
      expect(manager.listSkillResources('不存在的技能')).toEqual([]);
      // L1 技能清单（listSkills）：激活角色包内嵌技能（name 去重空名过滤）
      const listed = manager.listSkills();
      expect(listed).toHaveLength(1);
      expect(listed[0]!.name).toBe('资源工具');
    });
  });
});
