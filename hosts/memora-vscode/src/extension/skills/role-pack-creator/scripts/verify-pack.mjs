#!/usr/bin/env node
/**
 * 角色包生成物确定性校验闸（verify-pack）
 *
 * 与 `skill-creator/scripts/verify-skill.mjs` 共用 `_lib/verify-core.mjs` 的同一套
 * 前置判据（frontmatter / name / H1 / 引用闭合），本脚本只补角色包特有的结构判据：
 * manifest 合法性、包名与保留名、内嵌技能集合、persona/rules 与技能的双向引用。
 *
 * SSOT 指针：
 * - manifest 结构/策略键区间：`src/role-pack/validator.ts` 的 `validateManifestText`
 *   （能动态加载内核时直接调用；加载不到时明确 SKIP，不静默放行）
 * - 包名规则/保留名：`role-pack-creator/scripts/skaffold.mjs` + `src/role-pack/validator.ts`
 * - 内嵌技能 frontmatter：`src/skill/skillManager.ts#validateFile`
 * - 双向引用：`hosts/memora-vscode/src/extension/host/__tests__/builtinPackCoverage.test.ts`
 *
 * 调用方式：
 *   node verify-pack.mjs <角色包目录> [--kernel-root 内核仓库根] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createReport,
  emitReport,
  scanSkillNames,
  verifySkillDocument,
} from '../../_lib/verify-core.mjs';

/** 角色包保留名（真源 role-pack-creator/scripts/skaffold.mjs，避免与内置角色撞名） */
const RESERVED_NAMES = new Set(['memora助手']);

/** 包名合法字符集（与 skaffold.mjs 同口径；内核 validator 另做长度/结构校验） */
const PACK_NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/;

/** 反引号内的 kebab 词：按 role-pack-creator 的约定，一律视为技能引用 */
const BACKTICK_KEBAB_RE = /`([a-z0-9]+(?:-[a-z0-9]+)*)`/g;

/**
 * 解析命令行参数
 * @param {string[]} argv 原始参数
 * @returns {{packDir: string, kernelRoot: string, json: boolean}}
 */
function parseArgs(argv) {
  const cfg = { packDir: '', kernelRoot: '', json: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--kernel-root':
        cfg.kernelRoot = argv[++i] ?? '';
        break;
      case '--json':
        cfg.json = true;
        break;
      default:
        if (argv[i].startsWith('--')) throw new Error(`未知参数 "${argv[i]}"`);
        if (!cfg.packDir) cfg.packDir = argv[i];
        break;
    }
  }
  if (!cfg.packDir) throw new Error('缺少参数：角色包目录');
  return cfg;
}

/**
 * 沿目录向上查找内核仓库根（package.json 的 name 为 @zooique/memora）
 * @param {string} startDir 起点目录
 * @returns {string} 内核根；找不到返回空串
 */
function findKernelRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.name === '@zooique/memora') return dir;
      } catch {
        // 损坏的 package.json 不阻断向上查找
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

/**
 * 尝试加载内核 validator；加载不到返回 null（调用方显式 SKIP）
 * @param {string} kernelRoot 显式内核根（可空）
 * @param {string} startDir 用于自动探测的起点
 * @returns {Promise<{validateManifestText?: Function} | null>} 内核模块或 null
 */
async function loadKernelValidator(kernelRoot, startDir) {
  const detected = kernelRoot ? resolve(kernelRoot) : findKernelRoot(startDir);
  const candidates = [];
  if (detected) candidates.push(pathToFileURL(join(detected, 'dist', 'index.js')).href);
  candidates.push('@zooique/memora');
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.validateManifestText === 'function') return mod;
    } catch {
      // 下一个候选
    }
  }
  return null;
}

/**
 * 校验包名合法性 + 保留名
 * @param {unknown} value manifest.name
 * @param {ReturnType<typeof createReport>} report 报告
 */
function checkPackName(value, report) {
  if (typeof value !== 'string' || !value.trim()) {
    report.error('pack-name', 'manifest.name 缺失或不是非空字符串');
    return;
  }
  if (!PACK_NAME_RE.test(value)) {
    report.error(
      'pack-name',
      `包名「${value}」非法（只允许中文/字母/数字/下划线/连字符，1~64 字符）`,
    );
  }
  if (RESERVED_NAMES.has(value)) {
    report.error('pack-name', `包名「${value}」是保留名，不得使用`);
  }
}

/**
 * 内核 validator 不可用时的最小结构检查（不做策略区间——区间是内核专属判据）
 * @param {Record<string, unknown>} manifest 已解析的 manifest
 * @param {ReturnType<typeof createReport>} report 报告
 */
function checkManifestStructure(manifest, report) {
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.trim()) {
    report.error('manifest', '缺少 displayName（宿主角色选择器展示名）');
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
    report.error('manifest', '缺少 description（角色包用途说明）');
  }
  if (
    manifest.formatVersion !== undefined &&
    !/^\d+\.\d+\.\d+$/.test(String(manifest.formatVersion))
  ) {
    report.error(
      'manifest',
      `formatVersion 必须是 semver（当前：${String(manifest.formatVersion)}）`,
    );
  }
  if (manifest.strategy !== undefined) {
    if (
      typeof manifest.strategy !== 'object' ||
      manifest.strategy === null ||
      Array.isArray(manifest.strategy)
    ) {
      report.error('manifest', 'strategy 必须是嵌套对象（{ prepare/act/reflect/global }）');
    }
  } else {
    // strategy 是可选字段，缺省走内核默认；不把「未声明」判成结构错误
    report.skip('manifest', '未声明 strategy，使用内核默认行为');
  }
}

/**
 * 校验 manifest 的 skills 白名单声明项是否真实存在（目录扫描优先，声明仅过滤）
 * @param {Record<string, unknown>} manifest manifest 对象
 * @param {string} packDir 角色包目录
 * @param {ReturnType<typeof createReport>} report 报告
 */
function checkDeclaredSkills(manifest, packDir, report) {
  const declared = manifest.skills;
  if (declared === undefined) return;
  if (!Array.isArray(declared)) {
    report.error('manifest-skills', 'skills 必须是对象数组（每项 { file }）');
    return;
  }
  declared.forEach((item, index) => {
    const file = item && typeof item === 'object' ? item.file : undefined;
    if (typeof file !== 'string' || !file.trim()) {
      report.error('manifest-skills', `skills[${index}] 必须声明 file`);
      return;
    }
    const full = resolve(packDir, file);
    if (!existsSync(full)) {
      report.error('manifest-skills', `skills[${index}].file 指向不存在的文件：${file}`);
    }
  });
}

/**
 * 校验 persona/rules 与内嵌技能的双向引用
 *
 * 规则真源：builtinPackCoverage.test.ts —— 每个技能至少被引用一次；
 * 设定文档里每条反引号 kebab 词都必须指向真实技能（非技能词请写纯文本）。
 *
 * @param {string} packDir 角色包目录
 * @param {string[]} skillNames 内嵌技能磁盘名
 * @param {ReturnType<typeof createReport>} report 报告
 */
function checkReferenceClosure(packDir, skillNames, report) {
  const docs = ['persona.md', 'rules.md']
    .map((name) => join(packDir, name))
    .filter((file) => existsSync(file));
  if (docs.length === 0) {
    report.warning('ref-closure', '未找到 persona.md / rules.md，跳过设定引用闭合');
    return;
  }
  const text = docs.map((file) => readFileSync(file, 'utf-8')).join('\n');
  const referenced = new Set();
  for (const match of text.matchAll(BACKTICK_KEBAB_RE)) referenced.add(match[1]);
  const known = new Set(skillNames);
  for (const name of skillNames) {
    if (!referenced.has(name)) {
      report.error(
        'ref-closure',
        `技能「${name}」未在 persona.md/rules.md 中被引用（每个技能至少要挂到一个设定场景）`,
      );
    }
  }
  for (const token of referenced) {
    if (!known.has(token)) {
      report.error(
        'ref-closure',
        `设定文档引用了不存在的技能「${token}」（非技能词请写成纯文本，不要放进反引号）`,
      );
    }
  }
}

/**
 * 主流程：manifest → 包名 → 内嵌技能 → 引用闭合
 */
async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const packDir = resolve(cfg.packDir);
  const report = createReport();

  // 1) manifest 读取与 JSON 合法性
  const manifestPath = join(packDir, 'manifest.json');
  let manifest = null;
  let manifestRaw = '';
  try {
    manifestRaw = readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(manifestRaw);
    report.pass('manifest-json', 'manifest.json 是合法 JSON');
  } catch (err) {
    report.error(
      'manifest-json',
      `无法读取/解析 manifest.json：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2) manifest 结构（产品级必填项与内核无关，保证有无内核时口径一致）
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    checkManifestStructure(manifest, report);
    checkPackName(manifest.name, report);
    checkDeclaredSkills(manifest, packDir, report);

    // 3) 内核可用时交由内核 validator 判区间/枚举/红线（真源优先，不在此复制规则）
    const kernel = await loadKernelValidator(cfg.kernelRoot, packDir);
    if (kernel) {
      const result = kernel.validateManifestText(manifestRaw);
      for (const issue of result.issues ?? []) {
        const message = `${issue.path} — ${issue.message}`;
        if (issue.severity === 'error') report.error('manifest-kernel', message);
        else report.warning('manifest-kernel', message);
      }
      if (result.valid)
        report.pass('manifest-kernel', '内核 validator 通过（策略区间/枚举/红线由内核判定）');
    } else {
      report.skip(
        'manifest-kernel',
        '策略键区间/枚举/内容红线未校验（未能加载内核 validator；可用 --kernel-root 指定内核仓库根）',
      );
    }
  } else if (manifest) {
    report.error('manifest', 'manifest.json 顶层必须是对象');
  }

  // 4) 内嵌技能逐份走共用结构判据（与 skill-creator 的 verify-skill 同一实现）
  const skillsDir = join(packDir, 'skills');
  const entries = scanSkillNames(skillsDir);
  if (entries.length === 0) {
    report.warning(
      'skills',
      'skills/ 下没有内嵌技能（允许零技能角色包；如有技能请补 frontmatter）',
    );
  } else {
    for (const entry of entries) {
      const filePath = entry.path.toLowerCase().endsWith('.md')
        ? entry.path
        : join(entry.path, 'SKILL.md');
      verifySkillDocument({ filePath, report, requireHeading: true });
    }
    report.pass('skills', `已校验 ${entries.length} 个内嵌技能`);
    checkReferenceClosure(
      packDir,
      entries.map((entry) => entry.name),
      report,
    );
  }

  emitReport(report, { json: cfg.json });
  process.exitCode = report.ok() ? 0 : 1;
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
