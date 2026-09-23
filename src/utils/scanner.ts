/**
 * Markdown 目录扫描工具
 *
 * 从 RolePackManager / SkillManager 提取的公共目录扫描逻辑，
 * 消除跨模块重复的"扫描 *.md → 解析 frontmatter → 提取字段"代码。
 *
 * 使用异步 I/O（与 ToolExecutor 保持一致）。
 */

import { readFile, readdir, access, stat } from 'node:fs/promises';
import { resolve, join, basename, sep } from 'node:path';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import { getLogger } from '@/utils/loggerHolder.js';

/** 排除的文件名（README / CHANGELOG / LICENSE 不纳入扫描） */
const EXCLUDED_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

/** 扫描结果条目（通用 frontmatter 解析产物） */
export interface ScannedMarkdownEntry {
  /** 名称（frontmatter name 字段或文件名去 .md） */
  name: string;
  /** frontmatter 原始键值对 */
  frontmatter: Record<string, string>;
  /** frontmatter 之后的正文 */
  body: string;
  /** 文件绝对路径 */
  filePath: string;
}

/** 技能主文件约定名（文件夹形态的唯一入口，SSOT：scanner 校验 + skillManager/rolePackManager 据此判定 L3 归属） */
export const SKILL_MAIN_FILE = 'SKILL.md';

/**
 * 判定技能是否「文件夹形态」（入口为 SKILL.md）——单一真理源（SSOT）。
 *
 * 主流（Agent Skills 开放标准）：技能 = 文件夹 + 强制 SKILL.md，L3（resources/ scripts/）
 * 仅归属于文件夹形态；顶层裸 .md 是轻量单文件兼容形态（纯 L1/L2），不拥有 L3。
 * skillManager（经 skillLayer3）与 rolePackManager 均复用此判定，杜绝重复硬编码主文件名判定。
 *
 * @param filePath 技能文件绝对路径（SKILL.md 或裸 .md）
 * @returns true 表示文件夹形态（拥有 L3 资源/脚本归属权）
 */
export function isFolderFormSkill(filePath: string): boolean {
  // 大小写不敏感（本函数为唯一判定，skillLayer3 与 rolePackManager 共用）：
  // Windows 文件系统大小写不敏感，技能复制可能落盘为 skill.md / SKILL.MD 等变体；
  // 统一按主文件名判定，避免「skillLayer3 判非文件夹形态、rolePackManager 判文件夹形态」的分裂。
  return basename(filePath).toLowerCase() === SKILL_MAIN_FILE.toLowerCase();
}

/**
 * 扫描目录下的 Markdown 文件，解析 frontmatter
 *
 * 支持两种形式：
 *   1. 单文件形式：直接子项下的 *.md 文件
 *   2. 文件夹形式：子目录中的 SKILL.md（Claude Code 标准）
 *
 * 排除规则（单文件）：
 *   - 文件名以 `.` 开头的隐藏文件
 *   - 文件名以 `_` 前缀的私有文件
 *   - README.md / CHANGELOG.md / LICENSE
 *
 * 排除规则（文件夹）：
 *   - 目录名以 `.` 开头的隐藏目录
 *   - 目录名以 `_` 开头的私有目录
 *   - 子目录内无技能主文件（SKILL.md，大小写不敏感判定）则跳过
 *
 * @param dir 目录路径
 * @returns 解析后的条目列表
 */
export async function scanMarkdownDir(dir: string): Promise<ScannedMarkdownEntry[]> {
  try {
    await access(dir);
  } catch {
    getLogger().debug({ dir }, '扫描目录不存在，跳过');
    return [];
  }

  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    getLogger().warn({ dir }, '扫描目录失败');
    return [];
  }

  const entries: ScannedMarkdownEntry[] = [];

  // 直接子项下的 .md 文件（兼容单文件形式）
  const mdFiles = items.filter(
    (f) =>
      f.endsWith('.md') &&
      !f.startsWith('.') &&
      !f.startsWith('_') &&
      !EXCLUDED_FILES.has(f),
  );

  for (const file of mdFiles) {
    try {
      const filePath = join(dir, file);
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter: fm, body } = parseFrontmatter(raw);

      entries.push({
        name: fm['name'] ?? basename(file, '.md'),
        frontmatter: fm as Record<string, string>,
        body,
        filePath,
      });
    } catch (err) {
      getLogger().warn({ file, err }, '解析 Markdown 文件失败');
    }
  }

  // 子目录中的 SKILL.md（文件夹形式，Claude Code 标准）
  for (const item of items) {
    // 跳过隐藏目录和私有目录
    if (item.startsWith('.') || item.startsWith('_')) continue;

    const itemPath = join(dir, item);

    // 检查是否为目录
    let isDir: boolean;
    try {
      isDir = (await stat(itemPath)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    // 探测目录内技能主文件：复用 isFolderFormSkill 大小写不敏感判定（SSOT），
    // 兼容 skill.md / SKILL.MD 变体落盘；filePath 取真实落盘文件名。
    let skillMainName: string | undefined;
    try {
      for (const name of await readdir(itemPath)) {
        if (isFolderFormSkill(join(itemPath, name))) {
          skillMainName = name;
          break;
        }
      }
    } catch {
      continue;
    }
    if (!skillMainName) continue;

    const skillPath = join(itemPath, skillMainName);

    try {
      const raw = await readFile(skillPath, 'utf-8');
      const { frontmatter: fm, body } = parseFrontmatter(raw);

      entries.push({
        // 文件夹形式：优先 frontmatter name，回退到目录名
        name: fm['name'] ?? basename(item),
        frontmatter: fm as Record<string, string>,
        body,
        filePath: skillPath,
      });
    } catch (err) {
      getLogger().warn({ dir: item, err }, '解析 SKILL.md 失败');
    }
  }

  return entries;
}

/**
 * 解析目录路径：如果 configDir 存在则 resolve 子目录，否则返回 undefined
 */
export function resolveSubdir(configDir: string | undefined, sub: string): string | undefined {
  if (!configDir) return undefined;
  return resolve(configDir, sub);
}

// ── L3 目录名约定（单一真理源）──
// 扫描侧（本模块）与路径解析侧（`skill/skillLayer3`）需要同一份目录名。
// 此前两侧各写一遍字面量 → 目录名一旦调整，解析侧不会同步，且失配是静默的。

/** 资源主目录（memora 自有约定；条目未标 subdir 时路径解析的回退基目录） */
export const DEFAULT_RESOURCE_SUBDIR = 'resources';
/** 资源兼容目录（TRAE / Agent Skills 主流辅助文档目录，B1 兼容） */
export const REFERENCES_SUBDIR = 'references';
/** 脚本目录 */
export const SCRIPTS_SUBDIR = 'scripts';

/** L3 资源来源子目录（取值从常量派生，防类型与字面量两处各写） */
export type ResourceSubdir = typeof DEFAULT_RESOURCE_SUBDIR | typeof REFERENCES_SUBDIR;

/**
 * 脚本运行时（SSOT 单一来源：值域由 SCRIPT_RUNTIME_MAP 语义派生，本类型单点定义）。
 * role-pack/skill 层的脚本运行时字段经此引用，勿在别处复写字面量联合。
 */
export type ScriptRuntime = 'node' | 'python' | 'shell';

/** L3 资源/脚本发现结果 */
export interface DiscoveredLayer3 {
  /** 资源列表（resources/ 与 references/ 两个目录合并，条目带来源子目录） */
  resources: Array<{ path: string; size: number; subdir: ResourceSubdir }>;
  /** 脚本列表（scripts/ 目录下的文件） */
  scripts: Array<{ path: string; runtime: ScriptRuntime; size: number }>;
}

/**
 * 可执行脚本扩展名 → runtime 映射（SSOT 单一真源，供 rolePackManager / toolExecutor 共用）。
 *
 * '.ts' 语义声明（唯一一处）：node 无法直接解析 TS——映射仅作兜底推断，实际可用性
 * 取决于宿主执行器是否具备转译能力（如 vscode codeExecutor 仅别名 .js/.mjs/.cjs）。
 *
 * '.bat'/'.cmd' 语义声明：Windows 批处理——shell 档在 win32 派发
 * `cmd /c <path>`（skillScriptRunner.resolveCommand），批处理是 cmd 的原生可执行类型
 * （实测 status=0、stdout 正确）。**缺映射时会被 toolExecutor 兜底成 node 而必炸**
 * （拿批处理语法喂 node），故必须显式归入 shell 档。POSIX 下 `sh <path>` 跑批处理无
 * 意义，但**不额外加平台分支**——跨平台同表比按平台分叉简单，且 POSIX 侧不会产出 .bat。
 */
export const SCRIPT_RUNTIME_MAP: Readonly<Record<string, ScriptRuntime>> = {
  '.ts': 'node',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.py': 'python',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.bat': 'shell',
  '.cmd': 'shell',
};

/**
 * 按脚本扩展名推断 runtime（未知扩展名返回 undefined，缺省策略由调用方自定：
 * toolExecutor 兜底 node / rolePackManager 返回 null / 扫描跳过）。
 *
 * @param ext 小写扩展名（含点，如 '.py'）
 */
export function inferRuntimeFromExt(ext: string): ScriptRuntime | undefined {
  return SCRIPT_RUNTIME_MAP[ext];
}

/** 资源文件扩展名（纳入 resources 索引） */
const RESOURCE_EXTENSIONS = new Set([
  '.md', '.markdown', '.json', '.yaml', '.yml', '.txt', '.csv',
  '.xml', '.html', '.sql', '.toml', '.ini', '.env',
]);

/**
 * 发现技能目录下的 L3 资源（resources/ + references/）和脚本（scripts/）
 *
 * 三级渐进披露 L3 层扫描：
 *   - resources/ 目录下的文件 → 资源列表（memora 自有约定）
 *   - references/ 目录下的文件 → 资源列表（TRAE / Agent Skills 主流辅助文档目录，B1 兼容）
 *   - scripts/ 目录下的可执行文件 → 脚本列表（按扩展名推断 runtime）
 * 资源条目统一带 subdir 来源，read_resource 据此选择读取基目录。
 *
 * @param skillDir 技能目录路径（如 configDir/skills/my-skill/）
 * @returns 发现的资源和脚本列表
 */
export async function discoverLayer3(skillDir: string): Promise<DiscoveredLayer3> {
  // resources/ 与 references/ 均纳入资源索引，条目标注来源子目录
  const resources = [
    ...(await scanResourceSubdir(skillDir, DEFAULT_RESOURCE_SUBDIR)),
    ...(await scanResourceSubdir(skillDir, REFERENCES_SUBDIR)),
  ];

  // 扫描 scripts/ 目录
  const scriptsDir = join(skillDir, SCRIPTS_SUBDIR);
  let scripts: DiscoveredLayer3['scripts'] = [];
  try {
    await access(scriptsDir);
    scripts = await readScriptFiles(scriptsDir);
  } catch {
    // scripts/ 目录不存在，跳过
  }

  return { resources, scripts };
}

/**
 * 扫描单个资源子目录（resources/ 或 references/），目录不存在时返回空数组
 *
 * @param skillDir 技能目录路径
 * @param subdir 资源来源子目录
 * @returns 该子目录下的资源列表（条目带来源 subdir）
 */
async function scanResourceSubdir(
  skillDir: string,
  subdir: ResourceSubdir,
): Promise<Array<{ path: string; size: number; subdir: ResourceSubdir }>> {
  const dir = join(skillDir, subdir);
  try {
    await access(dir);
    return await readResourceFiles(dir, '', subdir);
  } catch {
    // 目录不存在，跳过
    return [];
  }
}

/**
 * 递归扫描资源子目录下的资源文件
 *
 * @param dir 资源子目录路径（resources/ 或 references/）
 * @param basePath 相对路径前缀（用于递归）
 * @param subdir 资源来源子目录（透传给条目）
 */
async function readResourceFiles(
  dir: string,
  basePath = '',
  subdir: ResourceSubdir,
): Promise<Array<{ path: string; size: number; subdir: ResourceSubdir }>> {
  const results: Array<{ path: string; size: number; subdir: ResourceSubdir }> = [];
  const entries = await readdir(dir);

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;

    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;
    const statInfo = await stat(fullPath);

    if (statInfo.isDirectory()) {
      const subResults = await readResourceFiles(fullPath, relPath, subdir);
      results.push(...subResults);
    } else if (RESOURCE_EXTENSIONS.has(getExt(entry))) {
      results.push({ path: relPath, size: statInfo.size, subdir });
    }
  }

  return results;
}

/**
 * 递归扫描 scripts/ 目录下的可执行脚本
 *
 * @param dir scripts 目录路径
 * @param basePath 相对路径前缀（用于递归）
 */
async function readScriptFiles(
  dir: string,
  basePath = '',
): Promise<Array<{ path: string; runtime: ScriptRuntime; size: number }>> {
  const results: Array<{ path: string; runtime: ScriptRuntime; size: number }> = [];
  const entries = await readdir(dir);

  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;

    const fullPath = join(dir, entry);
    const relPath = basePath ? `${basePath}/${entry}` : entry;
    const statInfo = await stat(fullPath);

    if (statInfo.isDirectory()) {
      const subResults = await readScriptFiles(fullPath, relPath);
      results.push(...subResults);
    } else {
      const ext = getExt(entry);
      const runtime = inferRuntimeFromExt(ext);
      if (runtime) {
        results.push({ path: relPath, runtime, size: statInfo.size });
      }
    }
  }

  return results;
}

/**
 * 获取文件扩展名（小写）
 */
function getExt(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : '';
}

/**
 * 路径穿越防护：检查子路径是否在基目录内
 *
 * 将 base + sub 拼接后 resolve 为绝对路径，检查其是否以 base 为边界前缀。
 * 防止 LLM 通过 `../` 等手段读取/执行技能目录外的文件。
 *
 * 边界前缀（追加 sep）：防兄弟目录绕过——`base=/x/skills/myskill`，
 * 若不追加 `sep`，`/x/skills/myskill-evil/f` 会以 `myskill` 为前缀误放行。
 * 与 SecurityGuard.assertPathAllowed 的 `allowedRoot + sep` 同标准（防前缀绕过统一事实）。
 *
 * @param base 基目录绝对路径
 * @param sub 相对子路径（可能含 `../`）
 * @returns 安全的完整路径（已 resolve），穿越时返回 null
 */
export function resolveSafePath(base: string, sub: string): string | null {
  const resolvedBase = resolve(base);
  const fullPath = resolve(base, sub);
  // 基目录自身或其边界前缀（追加 sep）；resolve 会消去 ../ 并规范化路径
  if (fullPath === resolvedBase || fullPath.startsWith(resolvedBase + sep)) {
    return fullPath;
  }
  return null;
}
