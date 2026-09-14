/**
 * 内置角色包「技能可发现性」守卫（2026-09-14）
 *
 * 背景（双锚点结论，见 docs/architecture/role-pack-authoring-guide.md §2.5）：
 * 技能可发现性有两个来源——**L1 清单**（内核扫描 skills/ 目录自动注入 system prompt，
 * 兜底「存在即可见」）与**设定文本引导**（persona/rules 标注「何时用」，驱动调用决策）。
 * 本守卫守的是后者：每个内置技能必须在所属包的 persona.md / rules.md 至少出现一次，
 * 否则退化为「存在但永不调用」的僵尸技能（共鸣小说家最初 5 个技能零引用即此缺口）。
 *
 * 自守（防守卫失明，本类守卫最高频失效模式）：
 * 首条用例断言扫描到的包数 / 技能数达标 + 无空包 + 已知锚点技能存在，
 * 防「路径解析失败 → 空集合 → 循环不执行 → 假绿」。
 *
 * 枚举口径（2026-09-14 收口）：技能清单**不由本文件手写目录遍历**，而走内核
 * `scanner.scanMarkdownDir`——与内核真实装载共用同一份枚举规则（覆盖文件夹形态
 * `skills/x/SKILL.md` 与 README/`.`/`_` 排除规则），避免「守卫看到的技能」与
 * 「内核实际装载的技能」分叉。技能名仍取磁盘命名（见 skillNameOf）。
 *
 * 引用口径（2026-09-14 收口，SSOT：docs/architecture/role-pack-authoring-guide.md §2.6）：
 * 设定文本引用技能的唯一合法形式 = **反引号包裹 kebab-case 技能名**。正向（每个技能至少
 * 被引用一次）与反向（每条引用都指向真实存在的技能）**共用同一份提取器**
 * `extractSkillReferences`——禁用两侧各写一份正则，否则「守卫看到的引用」与「真实引用」
 * 会分叉（同源才可能同真同假）。反向守卫专堵「改名后残留的悬空引用」。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFolderFormSkill, scanMarkdownDir } from '@/utils/scanner.js';
import { validateManifestText } from '@/role-pack/validator.js';
import { RolePackManager } from '@/role-pack/rolePackManager.js';

/** 仓库根 role-packs/（内置角色包唯一内容源，随内核发布并供宿主构建期同步） */
const ROLE_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'role-packs');

/** 内置包目录名列表（含无 skills/ 的兜底契约包） */
function listPackDirs(): string[] {
  return readdirSync(ROLE_PACKS_DIR).filter((e) => statSync(join(ROLE_PACKS_DIR, e)).isDirectory());
}

const SKILL_EXT = '.md';

/**
 * 技能名 = 磁盘命名（文件夹形态取所在目录名；单文件形态取文件名去扩展名）。
 *
 * 刻意**不用** `scanMarkdownDir` 返回的 `name`——它优先取 `frontmatter.name`，
 * 若守卫用它，「frontmatter name 与文件名一致」这条用例会退化为恒真。
 */
function skillNameOf(filePath: string): string {
  return isFolderFormSkill(filePath) ? basename(dirname(filePath)) : basename(filePath, SKILL_EXT);
}

/**
 * 技能引用提取器（SSOT：§2.6）。正/反两个方向的守卫共用它。
 *
 * 只提取 **kebab 形态**（小写字母 / 数字 / 连字符）的反引号内容——非 kebab 的反引号内容
 * （如 `file:write` / `manifest.json`）本就不是技能引用，不参与判定（否则反向守卫必然误报）。
 * 裸词（无反引号）不是引用：这正是「引用必须有确定性形式」的理由，也是本正则不会误判的原因。
 */
const SKILL_REFERENCE_RE = /`([a-z0-9]+(?:-[a-z0-9]+)*)`/g;

/** 提取设定文本中的全部技能引用（保留出现顺序与重复，调用方自行去重） */
function extractSkillReferences(text: string): string[] {
  const refs: string[] = [];
  for (const m of text.matchAll(SKILL_REFERENCE_RE)) {
    const name = m[1];
    if (name !== undefined) refs.push(name);
  }
  return refs;
}

interface PackScan {
  /** 角色包目录名 */
  name: string;
  /** skills/ 下的技能名（文件名去扩展名） */
  skillNames: string[];
  /** 技能文件 frontmatter 声明的 name（未声明则为空串） */
  declaredNames: Record<string, string>;
  /** persona.md + rules.md 全文（设定文本，使用时机引导载体） */
  settingText: string;
}

async function scanBuiltinPacks(): Promise<PackScan[]> {
  const packs: PackScan[] = [];
  for (const entry of readdirSync(ROLE_PACKS_DIR)) {
    const packDir = join(ROLE_PACKS_DIR, entry);
    if (!statSync(packDir).isDirectory()) continue;
    const skillsDir = join(packDir, 'skills');
    if (!existsSync(skillsDir)) continue;

    // 技能枚举收口于内核 scanner（SSOT）：同时覆盖「裸 .md」与「文件夹形态 skills/x/SKILL.md」，
    // 并继承其排除规则（README/CHANGELOG/LICENSE、`.`/`_` 前缀）。
    // 手写 readdirSync + endsWith('.md') 会静默跳过文件夹形态技能——而内核 L3 特性
    // （resources/ scripts/ 归属权）只授予文件夹形态，故该形态必然会在内置包中出现。
    const scanned = await scanMarkdownDir(skillsDir);

    const skillNames: string[] = [];
    const declaredNames: Record<string, string> = {};
    for (const skill of scanned) {
      const skillName = skillNameOf(skill.filePath);
      skillNames.push(skillName);
      declaredNames[skillName] = skill.frontmatter['name'] ?? '';
    }

    const settingText = ['persona.md', 'rules.md']
      .map((f) => (existsSync(join(packDir, f)) ? readFileSync(join(packDir, f), 'utf8') : ''))
      .join('\n');

    packs.push({ name: entry, skillNames, declaredNames, settingText });
  }
  return packs;
}

describe('内置角色包技能可发现性守卫', () => {
  it('守卫自身不失明：须扫到真实内置包与技能，且含已知锚点', async () => {
    const packs = await scanBuiltinPacks();
    // 防路径解析失败 → 空集合 → 后续用例循环不执行 → 全绿假象
    expect(packs.length).toBeGreaterThanOrEqual(2);
    const total = packs.reduce((n, p) => n + p.skillNames.length, 0);
    expect(total).toBeGreaterThanOrEqual(21);
    // 每个带 skills/ 的包都必须扫到技能——防「整包形态变更后枚举静默为空」时其余用例空转通过
    expect(packs.filter((p) => p.skillNames.length === 0).map((p) => p.name)).toEqual([]);
    // 已知锚点：craft-review（self-review 更名产物）——改名须同步此处，防守卫静默失焦
    expect(packs.some((p) => p.skillNames.includes('craft-review'))).toBe(true);

    // 引用提取器自守（防守卫正则失明 → 正 / 反两个方向**同时**假绿）：
    // ① 必须真提取出引用；② 总量不少于技能数（每技能至少一处引用）；
    // ③ 锚点 craft-review 只在 persona.md；④ 锚点 foreshadow **只在 rules.md**
    //    ——若 settingText 漏扫 rules.md，仅凭 ③ 抓不到，故必须 persona / rules 两侧各锚一个。
    const refs = packs.flatMap((p) => extractSkillReferences(p.settingText));
    expect(refs).toContain('craft-review');
    expect(refs).toContain('foreshadow');
    expect(refs.length).toBeGreaterThanOrEqual(total);
  });

  it('每个内置技能须在所属包 persona/rules 至少被引用一次（反引号形式，防僵尸技能）', async () => {
    const missing: string[] = [];
    for (const pack of await scanBuiltinPacks()) {
      const refs = new Set(extractSkillReferences(pack.settingText));
      for (const skill of pack.skillNames) {
        if (!refs.has(skill)) missing.push(`${pack.name}/${skill}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('设定文本引用的技能必须真实存在（防改名后残留的悬空引用）', async () => {
    // 场景溯源：技能改名（如 self-review → craft-review）后若漏改设定文本，旧名成为
    // 「指向已不存在技能」的悬空引用。旧守卫只做正向包含检查（新名已被引用 → 不会红），
    // 故此类残留长期无人发现。反向检查即堵此缺口。
    const dangling: string[] = [];
    for (const pack of await scanBuiltinPacks()) {
      const known = new Set(pack.skillNames);
      for (const ref of extractSkillReferences(pack.settingText)) {
        if (!known.has(ref)) dangling.push(`${pack.name} → \`${ref}\``);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('技能 frontmatter name 与文件名一致（防 L1 清单名与设定文本引用名失配）', async () => {
    const mismatched: string[] = [];
    for (const pack of await scanBuiltinPacks()) {
      for (const skill of pack.skillNames) {
        const declared = pack.declaredNames[skill];
        // 未声明 name 的由内核回退为文件名，不构成失配，跳过
        if (declared !== '' && declared !== skill) {
          mismatched.push(`${pack.name}/${skill} → ${declared}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('每个内置包 manifest 须通过格式校验（error 级会被拒绝装载）', () => {
    const invalid: string[] = [];
    for (const name of listPackDirs()) {
      const manifestPath = join(ROLE_PACKS_DIR, name, 'manifest.json');
      if (!existsSync(manifestPath)) {
        invalid.push(`${name}: 缺 manifest.json`);
        continue;
      }
      const result = validateManifestText(readFileSync(manifestPath, 'utf8'));
      const errors = result.issues.filter((i) => i.severity === 'error');
      if (errors.length > 0) {
        invalid.push(`${name}: ${errors.map((e) => `${e.code}@${e.path}`).join(', ')}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it('目录内每个内置包都须实际装载成功（防校验 error 导致静默跳过）', async () => {
    // 场景溯源：共鸣小说家曾把 capabilities 写成字符串数组（契约要求对象数组），
    // validator 报 error → RolePackManager 跳过装载且仅打一条 warn，包在运行时
    // 彻底消失、UI 无人察觉。此用例即从装载结果侧堵住该类静默失效。
    const expected = listPackDirs().length;
    expect(expected).toBeGreaterThanOrEqual(3);
    const manager = new RolePackManager(join(ROLE_PACKS_DIR, '..'));
    const loaded = await manager.load();
    expect(loaded).toBe(expected);
  });
});

describe('技能引用提取器（正则自锚，SSOT §2.6）', () => {
  it('提取反引号包裹的 kebab 技能名，拒绝非 kebab 反引号内容与裸词', () => {
    expect(extractSkillReferences('用 `dialogue-craft` 与 `foreshadow` 各一次')).toEqual([
      'dialogue-craft',
      'foreshadow',
    ]);
    // 非 kebab 的反引号内容不是技能引用（工具名 / 带点文件名）——否则反向守卫必然误报
    expect(extractSkillReferences('非技能标识 `manifest.json` / `file:write` 不参与判定')).toEqual([]);
    // 裸词（无反引号）不是引用——这正是「引用必须有确定性形式」的理由
    expect(extractSkillReferences('用 dialogue-craft 裸写')).toEqual([]);
  });
});
