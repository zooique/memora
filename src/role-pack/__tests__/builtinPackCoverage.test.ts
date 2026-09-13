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
 * 首条用例断言扫描到的包数 / 技能数达标 + 已知锚点技能存在，
 * 防「路径解析失败 → 空集合 → 循环不执行 → 假绿」。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@/utils/frontmatter.js';

/** 仓库根 role-packs/（内置角色包唯一内容源，随内核发布并供宿主构建期同步） */
const ROLE_PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'role-packs');

const SKILL_EXT = '.md';

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

function scanBuiltinPacks(): PackScan[] {
  const packs: PackScan[] = [];
  for (const entry of readdirSync(ROLE_PACKS_DIR)) {
    const packDir = join(ROLE_PACKS_DIR, entry);
    if (!statSync(packDir).isDirectory()) continue;
    const skillsDir = join(packDir, 'skills');
    if (!existsSync(skillsDir)) continue;

    const skillNames: string[] = [];
    const declaredNames: Record<string, string> = {};
    for (const file of readdirSync(skillsDir)) {
      if (!file.endsWith(SKILL_EXT)) continue;
      const skillName = file.slice(0, -SKILL_EXT.length);
      skillNames.push(skillName);
      const { frontmatter } = parseFrontmatter(readFileSync(join(skillsDir, file), 'utf8'));
      declaredNames[skillName] = frontmatter.name ?? '';
    }

    const settingText = ['persona.md', 'rules.md']
      .map((f) => (existsSync(join(packDir, f)) ? readFileSync(join(packDir, f), 'utf8') : ''))
      .join('\n');

    packs.push({ name: entry, skillNames, declaredNames, settingText });
  }
  return packs;
}

describe('内置角色包技能可发现性守卫', () => {
  it('守卫自身不失明：须扫到真实内置包与技能，且含已知锚点', () => {
    const packs = scanBuiltinPacks();
    // 防路径解析失败 → 空集合 → 后续用例循环不执行 → 全绿假象
    expect(packs.length).toBeGreaterThanOrEqual(2);
    const total = packs.reduce((n, p) => n + p.skillNames.length, 0);
    expect(total).toBeGreaterThanOrEqual(21);
    // 已知锚点：craft-review（self-review 更名产物）——改名须同步此处，防守卫静默失焦
    expect(packs.some((p) => p.skillNames.includes('craft-review'))).toBe(true);
  });

  it('每个内置技能须在所属包 persona/rules 至少一处被引用（防僵尸技能）', () => {
    const missing: string[] = [];
    for (const pack of scanBuiltinPacks()) {
      for (const skill of pack.skillNames) {
        if (!pack.settingText.includes(skill)) missing.push(`${pack.name}/${skill}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('技能 frontmatter name 与文件名一致（防 L1 清单名与设定文本引用名失配）', () => {
    const mismatched: string[] = [];
    for (const pack of scanBuiltinPacks()) {
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
});
