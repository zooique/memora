/**
 * 宿主技能多源聚合单元测试（SSOT 收紧）
 *
 * 锁住四类不变量，防「内置显示为用户」类来源错标复发：
 *   1. 来源判定：filePath 前缀 → project/project、user/user、configDir/builtin；rolePackManager → rolepack
 *   2. 同名去重（**裁决**）：角色包 > 项目 > 用户 > 内置（与注入面同序；勿回「内置优先」）
 *   3. 展示排序：项目 → 内置 → 角色包 → 用户（SOURCE_ORDER，**不是**裁决表）
 * 以及 `resolveSkill`（正文解析唯一收口：角色包 → 全局，与内核 read_skill 同序）与
 * `skillPromptFor`（composer 注入，格式沿用内核 buildSystemPrompt）。
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '@zooique/memora';
import type { SkillDto } from '../../../shared/protocol.js';
import { join } from 'node:path';
import {
  findUnmatchedDisabled,
  isSkillDisabled,
  listVisibleSkills,
  resolveSkill,
  skillPromptFor,
} from '../skillAggregation.js';

const configDir = 'C:/app/dist/extension';
const userSkillsDir = 'C:/Users/t/.vscode/globalStorage/skills';
const projectSkillsDir = 'C:/work/project/.memora/skills';

/** 构造最小 Agent 桩：skills（全局）+ rolePackManager（角色包技能）两级来源 */
function makeAgent(opts: {
  global: Array<{
    name: string;
    filePath: string;
    description?: string;
    /** 内核 SkillEntry.displayName（正文 H1 派生）；缺省 = 无 H1，展示面回退 name */
    displayName?: string;
    layer?: string;
    /** 内核记录的全局池覆盖来源（只读直通 UI；缺省 = 未覆盖任何同名项） */
    overriddenLayer?: 'builtin' | 'user' | 'project';
  }>;
  roleSkills?: Array<{ name: string; description?: string; displayName?: string }>;
  roleContent?: { [name: string]: string };
  /** 全局技能正文（真实 SkillEntry 恒有 content；缺省给非空值，防「假空」掩盖解析分支） */
  globalContent?: { [name: string]: string };
  /** 内核**实际生效**的禁用集：listVisibleSkills 据此标注 disabled，不自读配置副本 */
  disabledSkills?: string[];
}): Agent {
  return {
    skills: {
      list: opts.global.map((g) => ({
        name: g.name,
        description: g.description,
        displayName: g.displayName,
        filePath: g.filePath,
        layer: (g.layer ?? 'project') as 'agent' | 'project',
        // 覆盖事实直通（内核是唯一产生点，桩不额外推导）
        overriddenLayer: g.overriddenLayer,
      })),
      get: (n: string) => {
        // 与真实 SkillManager.get 同构：禁用名**短路返回 null**。
        // 桩若漏此判据，「禁用 ⇒ 注入落空」这一前提就测不出来（假绿）——
        // isSkillDisabled 测试依赖本短路成立。
        if (opts.disabledSkills?.includes(n)) return null;
        const g = opts.global.find((x) => x.name === n);
        if (!g) return null;
        return { ...g, content: opts.globalContent?.[n] ?? `全局正文:${n}` };
      },
      buildSystemPrompt: (n: string) => `【当前技能】${n}`,
      disabledSkillNames: opts.disabledSkills ?? [],
    },
    rolePackManager: {
      listSkills: () => opts.roleSkills ?? [],
      readSkillContent: async (n: string) => opts.roleContent?.[n] ?? null,
    },
  } as unknown as Agent;
}

describe('listVisibleSkills · 多源技能聚合', () => {
  it('来源判定：configDir → builtin，userSkillsDir → user，projectSkillsDir → project，角色包 → rolepack，并按展示序排列', () => {
    const agent = makeAgent({
      global: [
        { name: '内置A', filePath: join(configDir, 'skills', 'a.md') },
        { name: '用户B', filePath: join(userSkillsDir, 'b.md') },
        { name: '项目D', filePath: join(projectSkillsDir, 'd.md') },
      ],
      roleSkills: [{ name: '角色C' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir, projectSkillsDir });
    // 展示序 = SOURCE_ORDER（project → builtin → rolepack → user），与同名裁决无关
    expect(out.map((s) => `${s.layer}:${s.name}`)).toEqual([
      'project:项目D',
      'builtin:内置A',
      'rolepack:角色C',
      'user:用户B',
    ]);
  });

  it('displayName 直通：内核 displayName 随聚合结果到 UI，缺失保持 undefined（展示面回退 name）', () => {
    const agent = makeAgent({
      global: [
        { name: 'run', filePath: join(configDir, 'skills', 'run.md'), displayName: '运行脚本' },
        { name: 'plain', filePath: join(configDir, 'skills', 'plain.md') },
      ],
      roleSkills: [{ name: 'summarize', displayName: '要点提炼' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.find((s) => s.name === 'run')?.displayName).toBe('运行脚本');
    expect(out.find((s) => s.name === 'plain')?.displayName).toBeUndefined();
    expect(out.find((s) => s.name === 'summarize')?.displayName).toBe('要点提炼');
  });

  it('同名去重：用户优先于内置（S5 反转，2026-09-22，对齐内核装载层「用户覆盖内置」）', () => {
    const agent = makeAgent({
      global: [
        { name: '同名', filePath: join(configDir, 'skills', 'dup.md') },
        { name: '同名', filePath: join(userSkillsDir, 'dup.md') },
      ],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out).toHaveLength(1);
    expect(out[0].layer).toBe('user');
  });

  it('守卫变异锁：三方同名时角色包 > 用户 > 内置（反转后胜者链，回退即失败）', () => {
    const agent = makeAgent({
      global: [
        { name: '三方', filePath: join(configDir, 'skills', 'a.md') },
        { name: '三方', filePath: join(userSkillsDir, 'b.md') },
      ],
      roleSkills: [{ name: '三方' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.filter((s) => s.name === '三方')).toHaveLength(1);
    // 胜者链：rolepack(0) > user(1) > builtin(2)；任一方向回退（如内置 > 用户）即红
    expect(out.find((s) => s.name === '三方')?.layer).toBe('rolepack');
  });

  it('守卫变异锁：四段同名（项目/用户/内置/角色包）→ 角色包居首、全局池内项目 > 用户 > 内置', () => {
    const agent = makeAgent({
      global: [
        { name: '四段', filePath: join(configDir, 'skills', 'a.md') },
        { name: '四段', filePath: join(userSkillsDir, 'b.md') },
        { name: '四段', filePath: join(projectSkillsDir, 'c.md') },
      ],
      roleSkills: [{ name: '四段' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir, projectSkillsDir });
    // 注入面解析顺序「角色包 → 全局池」⇒ 角色包仍居首；全局池内按内核加载顺序 project > user > builtin
    expect(out.filter((s) => s.name === '四段')).toHaveLength(1);
    expect(out.find((s) => s.name === '四段')?.layer).toBe('rolepack');

    // 去掉角色包 → 项目覆盖用户与内置（DEDUP_PRIORITY project=1）
    const noRole = makeAgent({
      global: [
        { name: '四段', filePath: join(configDir, 'skills', 'a.md') },
        { name: '四段', filePath: join(userSkillsDir, 'b.md') },
        { name: '四段', filePath: join(projectSkillsDir, 'c.md') },
      ],
    });
    const noRoleOut = listVisibleSkills({
      agent: noRole,
      configDir,
      userSkillsDir,
      projectSkillsDir,
    });
    expect(noRoleOut.filter((s) => s.name === '四段')).toHaveLength(1);
    expect(noRoleOut.find((s) => s.name === '四段')?.layer).toBe('project');
  });

  it('守卫变异锁：角色包未参与时，用户胜于内置（DEDUP_PRIORITY 的 user/builtin 位序）', () => {
    const agent = makeAgent({
      global: [
        { name: '同名', filePath: join(userSkillsDir, 'dup.md') },
        { name: '同名', filePath: join(configDir, 'skills', 'dup.md') },
      ],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out).toHaveLength(1);
    expect(out[0].layer).toBe('user');
  });

  it('同名覆盖可见事实：胜者携带被覆盖来源（角色包现场记录 / 内核全局池事实直通）', () => {
    // ① 跨源（角色包 vs 全局池）：宿主去重现场记录被淘汰一方，胜者携带 user
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(userSkillsDir, 'dup.md') }],
      roleSkills: [{ name: '同名' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out).toHaveLength(1);
    expect(out[0].layer).toBe('rolepack');
    expect(out[0].overriddenLayer).toBe('user');

    // ② 全局池内（builtin → user）：内核已判定，宿主只直通，不得再推导第二份来源
    const agent2 = makeAgent({
      global: [
        { name: '同源', filePath: join(userSkillsDir, 'same.md'), overriddenLayer: 'builtin' },
      ],
    });
    const out2 = listVisibleSkills({ agent: agent2, configDir, userSkillsDir });
    expect(out2).toHaveLength(1);
    expect(out2[0].layer).toBe('user');
    expect(out2[0].overriddenLayer).toBe('builtin');
  });

  it('禁用标注：命中内核禁用集 → disabled=true，且条目**保留不隐藏**（供用户对照确认启停）', () => {
    const agent = makeAgent({
      global: [
        { name: '启用中', filePath: join(configDir, 'skills', 'on.md') },
        { name: '已禁用', filePath: join(configDir, 'skills', 'off.md') },
      ],
      disabledSkills: ['已禁用'],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    // 条目保留：静默消失会让用户误判「启停根本没做」
    expect(out).toHaveLength(2);
    expect(out.filter((s) => s.disabled).map((s) => s.name)).toEqual(['已禁用']);
    expect(out.find((s) => s.name === '启用中')?.disabled).toBeUndefined();
  });

  it('禁用标注作用域守卫：只标全局池，角色包层同名**不得**打标（防 UI 谎报「已禁用」）', () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      roleSkills: [{ name: '同名' }],
      disabledSkills: ['同名'],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    // 去重后胜出者是角色包（DEDUP_PRIORITY 角色包优先），而禁用只作用于全局池
    // （角色包技能走 rolePackManager、不经 SkillManager.get）⇒ 打标即 UI 谎报，回退此判断即红
    const winner = out.find((s) => s.name === '同名');
    expect(winner?.layer).toBe('rolepack');
    expect(winner?.disabled).toBeUndefined();
  });

  it('无路径回退：内核 layer=project 视作用户、agent 视作内置', () => {
    const agent = makeAgent({
      global: [
        { name: '无路径用户', filePath: '', layer: 'project' },
        { name: '无路径内置', filePath: '', layer: 'agent' },
      ],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.find((s) => s.name === '无路径用户')?.layer).toBe('user');
    expect(out.find((s) => s.name === '无路径内置')?.layer).toBe('builtin');
  });
});

describe('skillPromptFor · 两级回退（与内核 read_skill 同序：角色包优先）', () => {
  it('角色包未命中回退全局 SkillManager（buildSystemPrompt，SSOT 格式）', async () => {
    const agent = makeAgent({
      global: [{ name: 'g', filePath: join(configDir, 'skills', 'g.md') }],
    });
    expect(await skillPromptFor(agent, 'g')).toBe('【当前技能】g');
  });

  it('先查激活角色包内嵌技能：命中即返回角色包正文（不再看全局）', async () => {
    const agent = makeAgent({
      global: [],
      roleContent: { r: '角色包正文' },
    });
    expect(await skillPromptFor(agent, 'r')).toBe('【当前技能】r\n角色包正文');
  });

  it('同名双存：角色包优先于全局（与内核 read_skill 同序——当前人格专属覆盖生效）', async () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      roleContent: { 同名: '角色包覆盖正文' },
    });
    // 正本防回归：全局优先级须与内核一致，否则同名时 composer 注入全局版、read_skill 取角色包版 → 内容分叉
    expect(await skillPromptFor(agent, '同名')).toBe('【当前技能】同名\n角色包覆盖正文');
  });

  it('两级均未命中返回空串（host 不注入）', async () => {
    const agent = makeAgent({ global: [] });
    expect(await skillPromptFor(agent, '不存在')).toBe('');
  });
});

describe('resolveSkill · 正文解析唯一收口（角色包 → 全局）', () => {
  it('同名双存：角色包胜出，source 标注 rolepack', async () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      globalContent: { 同名: '全局正文' },
      roleContent: { 同名: '角色包正文' },
    });
    expect(await resolveSkill(agent, '同名')).toEqual({
      content: '角色包正文',
      source: 'rolepack',
    });
  });

  it('角色包未命中 → 回退全局池，source 标注 global', async () => {
    const agent = makeAgent({
      global: [{ name: 'g', filePath: join(configDir, 'skills', 'g.md') }],
      globalContent: { g: '全局正文' },
    });
    expect(await resolveSkill(agent, 'g')).toEqual({ content: '全局正文', source: 'global' });
  });

  it('两源均无此名 → null（空态由调用方决定）', async () => {
    const agent = makeAgent({ global: [] });
    expect(await resolveSkill(agent, '不存在')).toBeNull();
  });
});

describe('三面同源：列表保留 / 预览正文 / composer 注入 必须指向同一来源', () => {
  it('同名双存时三面一致取角色包（防「UI 列出的」与「实际生效的」不是同一个）', async () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      globalContent: { 同名: '全局正文' },
      roleSkills: [{ name: '同名' }],
      roleContent: { 同名: '角色包正文' },
    });
    // ① 列表（settingsPanel 数据源）：同名只留一条，且是角色包来源
    const listed = listVisibleSkills({ agent, configDir, userSkillsDir }).filter(
      (s) => s.name === '同名',
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].layer).toBe('rolepack');
    // ② 预览（settingsPanel L2 展开）+ ③ 注入（composer）——同一解析单点，同取角色包正文
    expect((await resolveSkill(agent, '同名'))?.content).toBe('角色包正文');
    expect(await skillPromptFor(agent, '同名')).toBe('【当前技能】同名\n角色包正文');
  });

  it('列表去重方向：角色包优先于内置（与注入面同向）', () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      roleSkills: [{ name: '同名' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.filter((s) => s.name === '同名')).toHaveLength(1);
    expect(out.find((s) => s.name === '同名')?.layer).toBe('rolepack');
  });
});

// ═══════════════════════════════════════════════════════════
// isSkillDisabled · 用户通道「响亮失败」的判据
// ═══════════════════════════════════════════════════════════
// 用途：composer 按名指定技能时，注入落空需给用户可见反馈、不允许静默。判据必须与
// `resolveSkill` **同序**，否则「角色包有同名技能」的场景会**假报错**（实际注入成功却报已禁用）。
describe('isSkillDisabled · 与 resolveSkill 判据同源', () => {
  it('全局池命中禁用集 → true；未命中 → false', () => {
    const agent = makeAgent({
      global: [
        { name: '启用中', filePath: join(configDir, 'skills', 'on.md') },
        { name: '已禁用', filePath: join(configDir, 'skills', 'off.md') },
      ],
      disabledSkills: ['已禁用'],
    });
    expect(isSkillDisabled(agent, '已禁用')).toBe(true);
    expect(isSkillDisabled(agent, '启用中')).toBe(false);
  });

  it('判据同源守卫：角色包存在同名技能 → false（禁用集对角色包无管辖权，报「已禁用」即假报）', () => {
    const agent = makeAgent({
      global: [{ name: '同名', filePath: join(configDir, 'skills', 'dup.md') }],
      roleSkills: [{ name: '同名' }],
      roleContent: { 同名: '角色包正文' },
      disabledSkills: ['同名'],
    });
    // 与 resolveSkill 同序（角色包先）：命中角色包即注入成功 ⇒ 不得报「已禁用」。
    // 若把本函数改成「只查 disabledSkillNames」（反序/漏角色包）→ 本用例红。
    expect(isSkillDisabled(agent, '同名')).toBe(false);
  });

  it('名字不存在 → false（「不存在」与「已禁用」是两种落空，提示语义须分流）', () => {
    const agent = makeAgent({
      global: [{ name: '存在', filePath: join(configDir, 'skills', 'a.md') }],
      // 误配场景：禁用清单里写了根本不存在的技能名
      disabledSkills: ['幽灵技能'],
    });
    expect(isSkillDisabled(agent, '幽灵技能')).toBe(false);
    expect(isSkillDisabled(agent, '存在')).toBe(false);
  });

  it('无 skills 子系统（未装配）→ false，不抛', () => {
    const agent = { skills: undefined } as unknown as Agent;
    expect(isSkillDisabled(agent, '任意')).toBe(false);
  });

  it('链路一致性（变异锁）：skillPromptFor 落空 ⟺ isSkillDisabled 为真', async () => {
    const agent = makeAgent({
      global: [
        { name: '启用中', filePath: join(configDir, 'skills', 'on.md') },
        { name: '已禁用', filePath: join(configDir, 'skills', 'off.md') },
      ],
      disabledSkills: ['已禁用'],
    });
    // 正向：禁用 ⇒ 注入落空 + 判定为真（宿主据此发 notice）
    expect(await skillPromptFor(agent, '已禁用')).toBe('');
    expect(isSkillDisabled(agent, '已禁用')).toBe(true);
    // 反向：启用 ⇒ 注入成功 + 判定为假（不得误报，防「无条件报错」）
    expect(await skillPromptFor(agent, '启用中')).not.toBe('');
    expect(isSkillDisabled(agent, '启用中')).toBe(false);
  });
});

describe('findUnmatchedDisabled · 禁用集「未找到需要禁用的技能」判据（D，2026-09-22）', () => {
  /**
   * SSOT 判定点：`findUnmatchedDisabled` 消费的是 `listVisibleSkills` 的**同一次聚合结果**，
   * 差集 = 禁用名 ∖ 三源清单名集（内置/角色包/用户）。角色包同名命中 → 不算未匹配
   * （与 `isSkillDisabled` 作用域语义一致：禁用集对角色包无管辖权）。
   */
  const skill = (name: string): SkillDto =>
    ({ name, description: '', layer: 'builtin' }) as SkillDto;

  it('禁用名在三源清单中不存在才判为未匹配', () => {
    const disabled = ['typo-skill', 'code-review', 'ghost'];
    // 三源清单：内置 + 用户 + 角色包同名（code-review 命中角色包 → 不算未匹配）
    const visible = [skill('code-review'), skill('builtin-a'), skill('user-b')];
    expect(findUnmatchedDisabled(disabled, visible)).toEqual(['typo-skill', 'ghost']);
  });

  it('禁用集为空 → 空结果（不渲染提示）', () => {
    expect(findUnmatchedDisabled([], [skill('a')])).toEqual([]);
  });

  it('全命中 → 空结果', () => {
    expect(findUnmatchedDisabled(['a', 'b'], [skill('a'), skill('b')])).toEqual([]);
  });

  it('保持配置填写顺序（未匹配名按用户填序输出）', () => {
    // 只有 y 存在，x/z 未匹配 → 按填序输出
    expect(findUnmatchedDisabled(['x', 'y', 'z'], [skill('y')])).toEqual(['x', 'z']);
  });
});
