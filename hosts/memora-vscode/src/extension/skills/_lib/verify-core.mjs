/**
 * 生成器校验共用核心（`_lib/` 私有目录）
 *
 * 为什么目录名以 `_` 开头：内核技能扫描器会跳过 `.` / `_` 前缀目录
 * （真源 `src/utils/scanner.ts`），因此本模块不会被当成一个技能暴露给模型；
 * 宿主构建期 `esbuild.config.mjs` 会把 `skills/` 整目录复制到
 * `dist/extension/skills/_lib`，两条生成器的脚本都能按相对路径 import。
 *
 * 共用边界：这里只放**两条生成器都适用**的确定性判据原语——
 * frontmatter 解析与字段校验、H1 提取、文档引用闭合、名字规则、可见技能枚举、
 * 落点比对、脚本冒烟执行。
 * 角色包专属的 manifest/strategy 校验留在 `role-pack-creator/scripts/verify-pack.mjs`；
 * 技能专属的落点/重名检查留在 `skill-creator/scripts/verify-skill.mjs`。
 *
 * SSOT 指针（改判据前先读这些文件，不要在这里造第二套语义）：
 * - frontmatter 解析：`src/utils/frontmatter.ts`
 * - 技能 frontmatter 校验：`src/skill/skillManager.ts#validateFile`
 * - 技能扫描与 L3 目录：`src/utils/scanner.ts`
 * - 技能落点：`src/agent/assembler.ts` 的 `SKILL_WRITE_LOCATION_PROMPT`
 * - 名称=磁盘名 / 正文 L3 引用存在性：`src/skill/skillManager.ts#validateFile`（运行时真源）
 * - 名称 kebab 字符集 / 跨源重名：`hosts/memora-vscode/src/extension/host/__tests__/globalSkillsConformance.test.ts`
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Agent Skills 规范的 name 字符集：小写字母/数字/连字符，不以连字符开头结尾、无连续连字符 */
export const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 技能 L3 允许的子目录（真源 `src/utils/scanner.ts`；`assets/` 不在其中，出现即判错） */
export const SKILL_SUBDIRS = ['resources', 'references', 'scripts'];

/** 扫描时排除的说明文件（与内核 scanner 的 EXCLUDED_FILES 同口径） */
const EXCLUDED_MD_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE.md']);

/** 正文里引用的 L3 相对路径：`references/x.md` / `resources/y.json` / `scripts/z.mjs` */
const DOC_REF_RE = /(?<![\w./-])(references|resources|scripts)\/([^\s`'"()<>]+)/g;

/** 不存在的 L3 目录：出现即判错（内核不会索引它，引用等于断链） */
const ASSET_REF_RE = /(?<![\w./-])assets\//;

/**
 * 逐行解析 frontmatter（严格镜像 `src/utils/frontmatter.ts`，含 CRLF 规整与末尾换行处理）。
 *
 * 关键语义（与内核一致）：
 * - 只按**每行第一个冒号**切分；
 * - 值**不剥引号、不做多行 YAML**；
 * - 结构不匹配时整体落回 body。
 *
 * @param {string} raw 完整 Markdown 文本
 * @returns {{frontmatter: Record<string, string>, body: string}}
 */
export function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  const frontmatter = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key && value) frontmatter[key] = value;
  }
  return { frontmatter, body: match[2] ?? '' };
}

/**
 * 取正文首个 H1 文本（忽略代码围栏内的 `#` 行）
 * @param {string} body 技能正文
 * @returns {string} H1 文本；缺失返回空串
 */
export function extractFirstH1(body) {
  let inFence = false;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = trimmed.match(/^#\s+(.+)$/);
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * 检查 description 文本是否符合生成约束
 *
 * 约束来源：内核 frontmatter 解析器不剥引号（`src/utils/frontmatter.ts`）；
 * `: ` 会诱导作者写成多行 YAML，而解析器只认单行；`<`/`>` 在 YAML/HTML 语境有歧义。
 *
 * @param {string} desc description 原值
 * @returns {{errors: string[], warnings: string[]}}
 */
export function inspectDescription(desc) {
  const errors = [];
  const warnings = [];
  if (!desc || !desc.trim()) {
    errors.push('description 为空');
    return { errors, warnings };
  }
  if (/^["'].*["']$/.test(desc)) {
    errors.push('description 首尾不得带引号（内核逐行解析不剥引号，引号会成为值的一部分）');
  }
  if (desc.includes(': ')) {
    errors.push('description 不得包含 ": "（逐行解析只支持单行 key: value，避免被误读成多行）');
  }
  if (/[<>]/.test(desc)) {
    errors.push('description 不得包含 "<" 或 ">"');
  }
  if (desc.length > 200) {
    warnings.push(`description 长度 ${desc.length}，建议 ≤200 字符（L1 清单只暴露这一句）`);
  }
  if (!desc.trim()) errors.push('description 为空白');
  return { errors, warnings };
}

/**
 * 创建带分级的校验报告
 * @returns {{
 *   items: Array<{level: 'pass'|'warning'|'error'|'skip', check: string, message: string}>,
 *   pass: (check: string, message: string) => void,
 *   warning: (check: string, message: string) => void,
 *   error: (check: string, message: string) => void,
 *   skip: (check: string, message: string) => void,
 *   ok: () => boolean,
 * }}
 */
export function createReport() {
  /** @type {Array<{level: 'pass'|'warning'|'error'|'skip', check: string, message: string}>} */
  const items = [];
  const push = (level, check, message) => items.push({ level, check, message });
  return {
    items,
    pass: (check, message) => push('pass', check, message),
    warning: (check, message) => push('warning', check, message),
    error: (check, message) => push('error', check, message),
    skip: (check, message) => push('skip', check, message),
    ok: () => items.every((item) => item.level !== 'error'),
  };
}

/**
 * 输出报告（人读或 JSON）
 * @param {ReturnType<typeof createReport>} report 校验报告
 * @param {{json?: boolean}} [options] 输出选项
 */
export function emitReport(report, options = {}) {
  if (options.json) {
    console.log(JSON.stringify({ ok: report.ok(), items: report.items }, null, 2));
    return;
  }
  const icons = { pass: '✅', warning: '⚠️', error: '❌', skip: '⏭️' };
  for (const item of report.items) {
    console.log(`${icons[item.level]} [${item.check}] ${item.message}`);
  }
  console.log(report.ok() ? '结果：全部硬判据通过' : '结果：存在硬判据失败，不得交付');
}

/**
 * 判断候选路径是否仍在基准目录内（防 `../` 逃逸）
 * @param {string} baseDir 基准目录
 * @param {string} candidate 候选绝对路径
 * @returns {boolean} true = 未逃逸
 */
export function isInsideDir(baseDir, candidate) {
  const rel = relative(resolve(baseDir), resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 从正文提取 L3 引用并检查落盘存在性（同时拦截 `assets/`）
 *
 * @param {{text: string, baseDir: string, report: ReturnType<typeof createReport>}} input
 * @returns {{refs: Array<{subdir: string, rel: string, text: string, filePath: string}>, scripts: string[]}}
 */
export function checkDocRefs({ text, baseDir, report }) {
  const refs = [];
  for (const match of text.matchAll(DOC_REF_RE)) {
    const subdir = match[1];
    // 去掉锚点与句末标点，避免把 `references/x.md。` 当成文件名
    const rel = match[2]
      .replace(/[#?].*$/, '')
      .replace(/[.,;:!?、，。；：！？)）\]】」』'"]+$/g, '');
    if (!rel || rel.endsWith('/')) continue;
    const filePath = resolve(baseDir, subdir, rel);
    const textRef = `${subdir}/${rel}`;
    refs.push({ subdir, rel, text: textRef, filePath });
    if (!isInsideDir(baseDir, filePath)) {
      report.error('doc-refs', `${textRef} 指向技能目录之外（禁止 ../ 逃逸）`);
      continue;
    }
    if (!existsSync(filePath)) {
      report.error('doc-refs', `${textRef} 不存在（正文引用了未落盘的 L3 文件）`);
    }
  }
  if (ASSET_REF_RE.test(text)) {
    report.error(
      'assets',
      '正文引用了 assets/ 目录——内核 L3 只索引 resources/references/scripts，assets/ 不会被 read_resource 读取',
    );
  }
  const scripts = refs
    .filter((ref) => ref.subdir === 'scripts' && existsSync(ref.filePath))
    .map((ref) => ref.filePath);
  return { refs, scripts };
}

/**
 * 校验一份技能文档（standalone 技能与角色包内嵌技能共用）
 *
 * 覆盖判据（内核 `SkillManager.validateFile` 是**运行时真源**；本文件是**生成期预检镜像**，
 * 并补充内核刻意不管的生成期专属规则）：
 * 1. frontmatter 可解析、description 非空且合规、正文非空、layer 合法（镜像内核）；
 * 2. `name` 等于磁盘名（镜像内核），另加 kebab 字符集（生成期专属，内核不强制）；
 * 3. 正文首个 H1 存在且不等于英文 id（生成期专属）；
 * 4. 正文 L3 引用逐个存在（镜像内核），另禁 `assets/`（生成期专属）。
 *
 * 镜像点（刻意为之）：内核不能反向依赖宿主 `_lib`，生成期脚本也无法在无内核环境替代运行时判定，
 * 故同一判据存在两份实现——内核为运行时真源，本文件为预检镜像，**改判据必须两边同步**。
 *
 * @param {{
 *   filePath: string,
 *   report: ReturnType<typeof createReport>,
 *   requireHeading?: boolean,
 *   allowedLayers?: string[],
 * }} input
 * @returns {{
 *   frontmatter: Record<string, string>,
 *   body: string,
 *   name: string,
 *   heading: string,
 *   scripts: string[],
 * }}
 */
export function verifySkillDocument({
  filePath,
  report,
  requireHeading = true,
  allowedLayers = ['agent', 'project'],
}) {
  const empty = { frontmatter: {}, body: '', name: '', heading: '', scripts: [] };
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    report.error('frontmatter', `无法读取技能文件：${filePath}`);
    return empty;
  }

  const { frontmatter, body } = parseFrontmatter(raw);

  // 与内核 validateFile 一致：结构不匹配时整体落回 body，视为缺少 frontmatter
  if (Object.keys(frontmatter).length === 0 && body === raw) {
    report.error('frontmatter', '缺少 frontmatter（文件需以 --- 开头声明 name/description）');
  }

  const description = frontmatter['description'] ?? '';
  const descCheck = inspectDescription(description);
  for (const message of descCheck.errors) report.error('description', message);
  for (const message of descCheck.warnings) report.warning('description', message);

  if (!body.trim()) {
    report.error('body', '技能正文为空，无可执行指令');
  }

  const layer = frontmatter['layer'];
  if (layer && !allowedLayers.includes(layer)) {
    // 内核把非法 layer 降级为 warning 并回退 project；生成器闸门从严，避免静默漂移
    report.error('layer', `layer 值「${layer}」非法，只允许 ${allowedLayers.join(' / ')}`);
  }

  // 磁盘名：文件夹形态取目录名，裸 .md 形态取文件名（与内核 scanner 的口径一致）
  const isFolderForm = basename(filePath).toLowerCase() === 'skill.md';
  const diskName = isFolderForm ? basename(dirname(filePath)) : basename(filePath, '.md');
  const name = frontmatter['name'] ?? '';
  if (!name) {
    report.error('name', 'frontmatter 缺少 name（生成器要求显式声明，不依赖内核回退磁盘名）');
  } else {
    if (!KEBAB_RE.test(name)) {
      report.error('name', `name「${name}」不是 kebab-case（只允许小写字母/数字/连字符）`);
    }
    if (name !== diskName) {
      report.error(
        'name',
        `name「${name}」与磁盘名「${diskName}」不一致（内核按 name 查找，错位会读不到）`,
      );
    }
  }

  const heading = extractFirstH1(body);
  if (requireHeading) {
    if (!heading) {
      report.error('heading', '正文缺少 H1 展示名（宿主选择器/卡片会回退英文 id）');
    } else {
      if (heading === name) {
        report.error('heading', 'H1 不得重复 frontmatter 的英文 id，应写给人看的中文展示名');
      }
      if (!/[\u4e00-\u9fa5]/.test(heading)) {
        report.warning('heading', `H1「${heading}」不含中文，建议写中文展示名`);
      }
    }
  }

  const { scripts } = checkDocRefs({ text: body, baseDir: dirname(filePath), report });
  return { frontmatter, body, name, heading, scripts };
}

/**
 * 枚举一个 skills 目录下的技能名（文件夹 `x/SKILL.md` 与裸 `x.md` 并存）
 * @param {string} skillsDir skills 根目录
 * @returns {Array<{name: string, path: string}>} 磁盘名 + 技能文件/目录路径
 */
export function scanSkillNames(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  const entries = readdirSync(skillsDir);
  const found = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_') || EXCLUDED_MD_FILES.has(entry)) continue;
    const fullPath = join(skillsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const skillFile = join(fullPath, 'SKILL.md');
      if (existsSync(skillFile)) found.push({ name: entry, path: fullPath });
    } else if (entry.toLowerCase().endsWith('.md')) {
      found.push({ name: basename(entry, '.md'), path: fullPath });
    }
  }
  return found;
}

/**
 * 枚举多个角色包目录下的内嵌技能名
 * @param {string} packsRoot 角色包根目录（其下每个子目录含 `skills/`）
 * @returns {string[]} 技能磁盘名
 */
export function scanPackSkillNames(packsRoot) {
  if (!existsSync(packsRoot)) return [];
  const names = [];
  for (const pack of readdirSync(packsRoot)) {
    if (pack.startsWith('.') || pack.startsWith('_')) continue;
    const skillsDir = join(packsRoot, pack, 'skills');
    for (const entry of scanSkillNames(skillsDir)) names.push(entry.name);
  }
  return names;
}

/**
 * 收集「当前可见技能名」，用于跨源重名检查
 *
 * 可见范围（能检测到多少算多少，检测不到的显式 SKIP，不静默放行）：
 * - 项目级 `<workspace>/.memora/skills`
 * - 项目级角色包内嵌技能 `<workspace>/.memora/role-packs/<pack>/skills`
 * - 仓库内置池（当 workspace 是 memora 仓库或其宿主目录时）
 * - 随插件分发的内置池（`extraSkillsDirs`，由调用脚本按自身所在 `skills/` 推导，任意项目都能查）
 * - 用户级（仅当传入 `--user-skills-dir`）
 * - 额外名单（`--visible-name`，供 `list_skills` 结果补齐）
 *
 * @param {{
 *   workspace: string,
 *   targetPath: string,
 *   userSkillsDir?: string,
 *   extraNames?: string[],
 *   extraSkillsDirs?: string[],
 *   report: ReturnType<typeof createReport>,
 * }} input
 * @returns {string[]} 去重后的可见技能名（不含目标自身）
 */
export function collectVisibleSkillNames({
  workspace,
  targetPath,
  userSkillsDir,
  extraNames = [],
  extraSkillsDirs = [],
  report,
}) {
  const targetResolved = resolve(targetPath);
  const targetDirResolved = resolve(dirname(targetResolved));
  const names = new Set();
  const addEntries = (entries) => {
    for (const entry of entries) {
      // 更新模式下排除目标自身；**别的同名技能仍保留**，用于撞名判定
      if (resolve(entry.path) === targetResolved || resolve(entry.path) === targetDirResolved) {
        continue;
      }
      names.add(entry.name);
    }
  };

  addEntries(scanSkillNames(join(workspace, '.memora', 'skills')));
  for (const name of scanPackSkillNames(join(workspace, '.memora', 'role-packs'))) names.add(name);

  // 仓库内置池：workspace 可能是仓库根，也可能是 hosts/memora-vscode
  for (const candidate of [
    join(workspace, 'hosts', 'memora-vscode', 'src', 'extension', 'skills'),
    join(workspace, 'src', 'extension', 'skills'),
  ]) {
    addEntries(scanSkillNames(candidate));
  }
  for (const candidate of [join(workspace, 'role-packs')]) {
    for (const name of scanPackSkillNames(candidate)) names.add(name);
  }
  // 随插件分发的内置池：调用脚本按自身 `skills/` 目录传入，保证任意用户项目都能查到真实重名
  for (const dir of extraSkillsDirs) addEntries(scanSkillNames(dir));

  if (userSkillsDir) {
    addEntries(scanSkillNames(userSkillsDir));
  } else {
    report.skip('collision-user', '未检查用户级技能重名（如需覆盖请传入 --user-skills-dir）');
  }
  for (const name of extraNames) names.add(name);
  return [...names].sort();
}

/**
 * 校验技能落点必须为 `<workspace>/.memora/skills/<name>/SKILL.md`
 * @param {{
 *   filePath: string,
 *   workspace: string,
 *   name: string,
 *   report: ReturnType<typeof createReport>,
 * }} input
 */
export function checkLandingPath({ filePath, workspace, name, report }) {
  const expected = resolve(join(workspace, '.memora', 'skills', name, 'SKILL.md'));
  const actual = resolve(filePath);
  // Windows 路径大小写不敏感，比较时统一小写；其余平台保持原样
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (normalize(expected) !== normalize(actual)) {
    report.error('landing', `落点不符：期望 ${expected}，实际 ${actual}`);
    return;
  }
  report.pass('landing', `落点正确：${actual}`);
}

/**
 * 冒烟执行一个正文引用的脚本（跑一次）
 *
 * 安全边界：在系统临时目录里执行，`cwd` 不落在用户项目内；脚本仍可自行读写自己的
 * 目录，故生成器约定脚本需识别 `MEMORA_VERIFY_SMOKE=1`（冒烟模式只做语法/依赖自检）。
 *
 * @param {string} scriptPath 脚本绝对路径
 * @param {{timeoutMs?: number}} [options] 超时设置
 * @returns {{ok: boolean, reason: string}} 执行结果
 */
export function runScriptOnce(scriptPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!/\.(mjs|cjs|js)$/.test(scriptPath)) {
    return {
      ok: false,
      reason: `无法自动执行 ${basename(scriptPath)}：只支持 Node 脚本（.mjs/.cjs/.js）`,
    };
  }
  const sandbox = mkdtempSync(join(tmpdir(), 'memora-verify-'));
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: sandbox,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, MEMORA_VERIFY_SMOKE: '1' },
    });
    if (result.error) return { ok: false, reason: `执行失败：${result.error.message}` };
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '')
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ');
      return { ok: false, reason: `退出码 ${result.status}${detail ? `：${detail}` : ''}` };
    }
    return { ok: true, reason: '冒烟执行通过' };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
