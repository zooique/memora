/**
 * 技能「目录定位 + L3 层」单一真理源
 *
 * 背景：全局技能（SkillManager）与角色包内嵌技能（RolePackManager）是**两套技能载体**——
 * 前者以扁平 name 定位，后者需 packName 作用域。但两者的**目录形态规则与 L3 处理逻辑
 * 完全一致**，且曾各自实现一遍（连注释都是复制粘贴的副本）。本模块是其唯一收口，两侧
 * 同时受益：新增一项技能能力只需改这里。
 *
 * 收口内容：
 * 1. **目录定位**（双形态兼容）：文件夹形态（主流，skills/x/SKILL.md）+ 单文件形态（兼容，
 *    skills/x.md），另兼容 manifest 直接把 file 写成目录的形态——取三者中最全面的处理；
 * 2. **L3 发现**：仅文件夹形态拥有 resources/ scripts/ 归属权（裸 .md 所在目录 = 技能池
 *    共享根，同级扫描会把别的技能的资源误归给自己 → 污染），故裸 .md 恒为纯 L1/L2；
 * 3. **L3 路径解析**：layer3 白名单前置 + resolveSafePath 边界防护（双层，缺一即可绕过）。
 *
 * 边界（勿越界扩大本模块职责）：
 * - 文件读取与 stat / 存在性原语收口于 `utils/fileSafe`（通用文件概念，非技能域）；
 * - 「白名单未命中」与「路径逃逸」必须仍可区分（前者调用方静默返回、后者要告警），
 *   故 `find*` 与 `resolve*` 分开提供，调用方先判存在再取路径。
 */
import { dirname, join } from 'node:path';
import {
  resolveSafePath,
  discoverLayer3,
  isFolderFormSkill,
  DEFAULT_RESOURCE_SUBDIR,
  SCRIPTS_SUBDIR,
  type DiscoveredLayer3,
  type ResourceSubdir,
} from '@/utils/scanner.js';
import { statSyncSafe } from '@/utils/fileSafe.js';

/**
 * 目录名常量转发（真源在 `utils/scanner`——扫描侧与本模块的路径解析侧共用同一事实，
 * 调整目录名约定只改 scanner 一处，两侧同时生效）
 *
 * 引用面现状：生产代码零引用，唯一消费方是模块内测试 `skill/__tests__/skillLayer3.test.ts`
 * （按「模块内测试消费 = 活」判据，导出保留）。
 */
export { DEFAULT_RESOURCE_SUBDIR, SCRIPTS_SUBDIR };

/** L3 资源条目的最小结构契约（全局技能与角色包技能均兼容） */
export interface Layer3ResourceLike {
  readonly path: string;
  /**
   * 来源子目录（resources / references）。
   *
   * 可选是为兼容「未装载 L3 的入参」（`undefined` / `{}`）；**真实生产者
   * `scanner.discoverLayer3` 恒标注该项**，故 `resolveLayer3ResourcePath` 的
   * 缺省回退分支只在非扫描来源（测试构造）下触达。
   */
  readonly subdir?: ResourceSubdir;
}

/** L3 脚本条目的最小结构契约 */
export interface Layer3ScriptLike {
  readonly path: string;
}

/** L3 索引的最小结构契约（两种技能载体均兼容，字段可选以适配未装载 L3 的技能） */
export interface SkillLayer3Like {
  readonly resources?: readonly Layer3ResourceLike[];
  readonly scripts?: readonly Layer3ScriptLike[];
}

/**
 * 解析技能目录（双形态 SSOT）
 *
 * 取「最全面形态」处理，三种输入均正确：
 * - manifest 的 file 直接指向目录 → 目录本身；
 * - 文件夹形态：skills/my-skill/SKILL.md → skills/my-skill/（dirname）；
 * - 单文件形态：skills/write.md → skills/（dirname，此目录即技能池共享根，无 L3 归属）。
 */
export function resolveSkillDir(skillFilePath: string): string {
  const stat = statSyncSafe(skillFilePath);
  if (stat?.isDirectory()) return skillFilePath;
  return dirname(skillFilePath);
}

/**
 * 发现技能的 L3 层（资源 + 脚本）
 *
 * 仅文件夹形态（入口为 SKILL.md）拥有 L3 归属权；裸 .md 恒返回空索引——
 * 其所在目录是技能池共享根，同级扫描会误并入其他技能的资源/脚本（污染）。
 */
export async function discoverSkillLayer3(skillFilePath: string): Promise<DiscoveredLayer3> {
  if (!isFolderFormSkill(skillFilePath)) return { resources: [], scripts: [] };
  return discoverLayer3(dirname(skillFilePath));
}

/**
 * 「发现结果」投影为可落地的 layer3 结构（两种技能载体兼容）
 *
 * 字段与 `role-pack/types.ts` 的 `RolePackManifestSkill.layer3` 对齐：真实生产者
 * `scanner.discoverLayer3` 恒产出 size，故此处 size 为必填 number（不可写成可选）。
 */
export interface ProjectedLayer3 {
  readonly resources: Array<{
    readonly path: string;
    readonly size: number;
    readonly subdir?: ResourceSubdir;
  }>;
  readonly scripts: Array<{
    readonly path: string;
    readonly runtime: 'node' | 'python' | 'shell';
    readonly size: number;
  }>;
}

/**
 * 把 L3 发现结果投影为 layer3 落地结构（resources 与 scripts 皆空时返回 undefined）
 *
 * 两种技能载体（全局 SkillManager / 角色包 RolePackManager）此前**各写一遍**该投影，
 * 注释却互相宣称已收口——实则只有「发现」收口了，「投影」改一处即静默漂移。
 * 本函数是 discovered → layer3 投影的唯一收口（SSOT）。
 */
export function projectDiscoveredLayer3(discovered: DiscoveredLayer3): ProjectedLayer3 | undefined {
  if (discovered.resources.length === 0 && discovered.scripts.length === 0) return undefined;
  return {
    resources: discovered.resources.map((r) => ({ path: r.path, size: r.size, subdir: r.subdir })),
    scripts: discovered.scripts.map((s) => ({ path: s.path, runtime: s.runtime, size: s.size })),
  };
}

/**
 * 在 layer3 白名单中查找资源条目（未登记返回 null）
 *
 * 白名单前置的意义：未在清单内的路径（含兄弟目录前缀、escape 符）不应进入后续解析。
 */
export function findLayer3Resource(
  layer3: SkillLayer3Like | undefined,
  resourcePath: string,
): Layer3ResourceLike | null {
  return layer3?.resources?.find((r) => r.path === resourcePath) ?? null;
}

/** 在 layer3 白名单中查找脚本条目（未登记返回 null） */
export function findLayer3Script(
  layer3: SkillLayer3Like | undefined,
  scriptPath: string,
): Layer3ScriptLike | null {
  return layer3?.scripts?.find((s) => s.path === scriptPath) ?? null;
}

/**
 * 解析 L3 资源的绝对路径：白名单命中且未逃逸来源子目录时返回路径，否则 null。
 *
 * 基目录按条目来源 subdir 选择（resources/ 或 references/，B1 兼容主流 references/ 目录）。
 */
export function resolveLayer3ResourcePath(
  skillDir: string,
  layer3: SkillLayer3Like | undefined,
  resourcePath: string,
): string | null {
  const meta = findLayer3Resource(layer3, resourcePath);
  if (!meta) return null;
  const baseDir = meta.subdir ?? DEFAULT_RESOURCE_SUBDIR;
  return resolveSafePath(join(skillDir, baseDir), resourcePath);
}

/**
 * 解析 L3 脚本的绝对路径：白名单命中且未逃逸 scripts/ 目录时返回路径，否则 null。
 */
export function resolveLayer3ScriptPath(
  skillDir: string,
  layer3: SkillLayer3Like | undefined,
  scriptPath: string,
): string | null {
  if (!findLayer3Script(layer3, scriptPath)) return null;
  return resolveSafePath(join(skillDir, SCRIPTS_SUBDIR), scriptPath);
}
