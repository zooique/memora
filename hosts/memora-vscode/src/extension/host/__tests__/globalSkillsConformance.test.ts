/**
 * 全局技能池合规守卫（Agent Skills 规范对齐）
 *
 * 规范契约：内置全局技能（`src/extension/skills/`）的 `name` 必须符合 Agent Skills 规范
 * （agentskills.io：`name` 仅允许 `[a-z0-9-]`，且**必须与父目录名一致**），
 * 且与角色包技能（kebab）对齐——同一「技能名」概念在两类载体上规则不同，
 * 会令引用校验（内核 `builtinPackCoverage` 双向守卫只认 kebab）与 UI 显示相互打架（坑）。
 *
 * 该池**不在内核守卫覆盖范围内**（内核 `ROLE_PACKS_DIR` 只指仓库根 `role-packs/`），
 * 故在此补齐三项：kebab 字符集 / name 与文件名（目录名）一致 / description 非空。
 *
 * 自锚（防守卫失明）：首条用例断言扫到的技能数达标 + 含已知锚点，
 * 防「路径解析失败 → 空集合 → 循环不执行 → 假绿」。
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@zooique/memora';

/** 全局技能池源目录（dist 侧由宿主 esbuild `copyAssetsRecursive` 构建期同步，故守源即足够） */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/**
 * 仓库根 `role-packs/`（内核内置角色包单一真理源；宿主 dist 侧由
 * `esbuild.config.mjs#copyRolePacks` 构建期全量复制）。
 *
 * 宿主是**唯一能同时看到两侧技能名的地方**——内核守卫的 `ROLE_PACKS_DIR` 看不到全局池，
 * 故「跨源重名」这条不变量只能在此守。
 */
const ROLE_PACKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'role-packs',
);

/** Agent Skills 规范 name 字符集：小写字母 / 数字 / 连字符；不以连字符开头结尾、无连续连字符 */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface GlobalSkill {
  /** 磁盘命名（文件夹形态取目录名，裸 .md 取文件名去扩展名） */
  diskName: string;
  declaredName: string;
  description: string;
}

/** 枚举全局技能池（形态约定与内核 scanner 一致：文件夹 `x/SKILL.md` 与裸 `.md` 并存） */
function scanGlobalSkills(): GlobalSkill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: GlobalSkill[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;
    const full = join(SKILLS_DIR, entry);
    const isDir = statSync(full).isDirectory();
    if (!isDir && !entry.toLowerCase().endsWith('.md')) continue;
    const skillFile = isDir ? join(full, 'SKILL.md') : full;
    if (!existsSync(skillFile)) continue;
    const { frontmatter } = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    out.push({
      diskName: isDir ? entry : basename(entry, '.md'),
      declaredName: frontmatter['name'] ?? '',
      description: frontmatter['description'] ?? '',
    });
  }
  return out;
}

/**
 * 枚举全部内置角色包技能名（磁盘命名口径，与内核 `builtinPackCoverage` 的 `skillNameOf` 同构：
 * 文件夹形态取目录名、裸 `.md` 取文件名去扩展名；排除 `.`/`_` 前缀与 README/CHANGELOG/LICENSE）。
 */
function scanRolePackSkillNames(): string[] {
  if (!existsSync(ROLE_PACKS_DIR)) return [];
  const names: string[] = [];
  for (const pack of readdirSync(ROLE_PACKS_DIR)) {
    const skillsDir = join(ROLE_PACKS_DIR, pack, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const entry of readdirSync(skillsDir)) {
      if (entry.startsWith('.') || entry.startsWith('_')) continue;
      if (/^(README|CHANGELOG|LICENSE)\.md$/i.test(entry)) continue;
      const full = join(skillsDir, entry);
      if (statSync(full).isDirectory()) {
        if (existsSync(join(full, 'SKILL.md'))) names.push(entry);
      } else if (entry.toLowerCase().endsWith('.md')) {
        names.push(basename(entry, '.md'));
      }
    }
  }
  return names;
}

describe('全局技能池合规守卫（Agent Skills 规范）', () => {
  it('守卫自身不失明：须扫到内置全局技能且含已知锚点', () => {
    const skills = scanGlobalSkills();
    // 防路径解析失败 → 空集合 → 其余用例空转通过
    expect(skills.length).toBeGreaterThanOrEqual(4);
    const names = skills.map((s) => s.diskName);
    expect(names).toContain('code-review');
    expect(names).toContain('role-pack-creator');
  });

  it('name 须符合 kebab 字符集（规范：仅小写字母 / 数字 / 连字符）', () => {
    const bad = scanGlobalSkills()
      .filter((s) => !KEBAB_RE.test(s.declaredName))
      .map((s) => `${s.diskName} → name: ${s.declaredName || '(缺失)'}`);
    expect(bad).toEqual([]);
  });

  it('name 须与文件名 / 目录名一致（规范：Must match the parent directory name）', () => {
    const mismatched = scanGlobalSkills()
      .filter((s) => s.declaredName !== s.diskName)
      .map((s) => `${s.diskName} → name: ${s.declaredName}（应为 ${s.diskName}）`);
    expect(mismatched).toEqual([]);
  });

  it('每个技能须声明非空 description（L1 清单靠它驱动模型调用决策）', () => {
    const missing = scanGlobalSkills()
      .filter((s) => !s.description.trim())
      .map((s) => s.diskName);
    expect(missing).toEqual([]);
  });

  it('全局技能名不得与角色包技能名重名（跨源唯一性，防 UI 侧同名被去重吃掉）', () => {
    // 为何必须守（2026-09-22 新增）：全局池 `name` 原为中文、角色包全为 kebab ⇒ 重名
    // **结构上不可能**。name 对齐 kebab 后两侧同字母表 ⇒ 重名变可能，且后果不是报错而是
    // **静默吞并**：`listVisibleSkills` 按名去重且角色包优先（`DEDUP_PRIORITY`）⇒ 全局那份
    // 在 UI 里不可见/不可选；而 L1 清单仍会把两行同名技能都列给模型 ⇒ 「看得见、点不到」。
    const globals = scanGlobalSkills().map((s) => s.diskName);
    const packSkills = scanRolePackSkillNames();
    // 自锚：两侧都须真的扫到东西，否则交集恒空 → 假绿（本类守卫最高频失效模式）
    expect(globals.length).toBeGreaterThanOrEqual(4);
    expect(packSkills.length).toBeGreaterThanOrEqual(20);
    const collisions = globals.filter((n) => packSkills.includes(n));
    expect(collisions).toEqual([]);
  });
});
