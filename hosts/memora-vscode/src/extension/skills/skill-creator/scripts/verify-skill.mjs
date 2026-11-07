#!/usr/bin/env node
/**
 * 技能生成物确定性校验闸（verify-skill）
 *
 * 用途：在交付前验证「LLM 刚生成的技能」能被 memora 正确发现、触发与读取。
 * 任一项硬判据失败时退出码非 0，生成器不得交付。
 *
 * 六条硬判据（每条的实现都指向内核 SSOT，不在本脚本另造语义）：
 * 1. frontmatter 可解析、description/正文非空、layer 合法
 *    → 真源 `src/skill/skillManager.ts#validateFile` + `src/utils/frontmatter.ts`
 * 2. `name` 是 kebab 且等于目录名
 *    → 真源 `hosts/memora-vscode/src/extension/host/__tests__/globalSkillsConformance.test.ts`
 * 3. 落点是 `<workspace>/.memora/skills/<name>/SKILL.md`
 *    → 真源 `src/agent/assembler.ts` 的 SKILL_WRITE_LOCATION_PROMPT
 * 4. 正文引用的 `references/` `resources/` `scripts/` 路径逐个存在；`assets/` 直接判错
 *    → 真源 `src/utils/scanner.ts` 的 L3 目录白名单
 * 5. 与可见技能不重名
 *    → 真源同判据 2 的守卫文件（跨源重名会被 UI 静默去重）
 * 6. 正文指向的新脚本实际能跑一次
 *    → 纪律同 `role-pack-creator` 的「写→验→用闭环」
 *
 * 调用方式：
 *   node verify-skill.mjs <技能目录|SKILL.md> [--workspace 项目根]
 *        [--user-skills-dir 用户技能目录] [--visible-name 名字]...
 *        [--skip-scripts] [--json]
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkLandingPath,
  collectVisibleSkillNames,
  createReport,
  emitReport,
  runScriptOnce,
  scanSkillNames,
  verifySkillDocument,
} from '../../_lib/verify-core.mjs';

/**
 * 随插件分发的内置技能池根目录。
 * 本脚本固定位于 `<skills>/skill-creator/scripts/verify-skill.mjs`，向上两级即池根；
 * 这样无论用户在哪个项目里生成技能，重名检查都覆盖真实可见的内置技能（不止 workspace 内那几处）。
 */
const BUILTIN_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 解析命令行参数
 * @param {string[]} argv 原始参数（不含 node 与脚本自身）
 * @returns {{
 *   target: string,
 *   workspace: string,
 *   userSkillsDir: string,
 *   visibleNames: string[],
 *   skipScripts: boolean,
 *   json: boolean,
 * }}
 */
function parseArgs(argv) {
  const cfg = {
    target: '',
    workspace: '',
    userSkillsDir: '',
    visibleNames: [],
    skipScripts: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--workspace':
        cfg.workspace = argv[++i] ?? '';
        break;
      case '--user-skills-dir':
        cfg.userSkillsDir = argv[++i] ?? '';
        break;
      case '--visible-name':
        cfg.visibleNames.push(argv[++i] ?? '');
        break;
      case '--skip-scripts':
        cfg.skipScripts = true;
        break;
      case '--json':
        cfg.json = true;
        break;
      default:
        if (argv[i].startsWith('--')) throw new Error(`未知参数 "${argv[i]}"`);
        if (!cfg.target) cfg.target = argv[i];
        break;
    }
  }
  if (!cfg.target) throw new Error('缺少参数：技能目录或 SKILL.md 路径');
  return cfg;
}

/**
 * 把「技能目录」或「SKILL.md 文件」统一解析为技能文件绝对路径
 * @param {string} target 命令行目标
 * @returns {string} SKILL.md 绝对路径
 */
function resolveSkillFile(target) {
  const full = resolve(target);
  if (existsSync(full) && statSync(full).isDirectory()) return join(full, 'SKILL.md');
  return full;
}

/**
 * 主流程：结构校验 → 落点 → 重名 → 脚本冒烟 → 输出
 */
function main() {
  // 冒烟模式：被别的技能校验闸冒烟调用时只证明可加载，不执行真实校验
  if (process.env.MEMORA_VERIFY_SMOKE === '1') {
    console.log('冒烟模式：verify-skill.mjs 依赖与语法自检通过');
    return;
  }

  const cfg = parseArgs(process.argv.slice(2));
  const workspace = cfg.workspace ? resolve(cfg.workspace) : resolve(process.cwd());
  const skillFile = resolveSkillFile(cfg.target);
  const report = createReport();

  // 1) 共用结构判据（与角色包内嵌技能同一套实现）
  const doc = verifySkillDocument({ filePath: skillFile, report });
  for (const check of [
    'frontmatter',
    'description',
    'body',
    'layer',
    'name',
    'heading',
    'doc-refs',
    'assets',
  ]) {
    if (!report.items.some((item) => item.check === check)) report.pass(check, '通过');
  }

  // 2) 落点必须是项目级技能目录（name 可用时才比对，否则由 name 判据负责报错）
  if (doc.name) {
    checkLandingPath({ filePath: skillFile, workspace, name: doc.name, report });
  }

  // 3) 跨源重名（内置池/项目级/角色包内嵌/可选的用户级）
  if (doc.name) {
    // 自锚：扫不到内置池时显式 SKIP，防「0 个可见技能 → 恒不重名」的假绿
    if (scanSkillNames(BUILTIN_SKILLS_DIR).length === 0) {
      report.skip(
        'collision-builtin',
        `未扫到随插件分发的内置技能池 ${BUILTIN_SKILLS_DIR}（跨源重名退化为仅 workspace 可见范围）`,
      );
    }
    const visible = collectVisibleSkillNames({
      workspace,
      targetPath: skillFile,
      userSkillsDir: cfg.userSkillsDir,
      extraNames: cfg.visibleNames.filter(Boolean),
      extraSkillsDirs: [BUILTIN_SKILLS_DIR],
      report,
    });
    if (visible.includes(doc.name)) {
      report.error(
        'collision',
        `技能名「${doc.name}」与可见技能重名（UI 会按名静默去重，可能出现看得见、点不到）`,
      );
    } else {
      report.pass('collision', `未与 ${visible.length} 个可见技能重名`);
    }
  }

  // 4) 正文指向的脚本逐个跑一次（--skip-scripts 只用于只读预检，不算通过）
  const scripts = [...new Set(doc.scripts)];
  if (scripts.length === 0) {
    report.pass('scripts', '正文未引用 scripts/ 下的文件，无需冒烟');
  } else if (cfg.skipScripts) {
    report.skip('scripts', `跳过 ${scripts.length} 个脚本的冒烟执行（--skip-scripts）`);
  } else {
    for (const script of scripts) {
      const result = runScriptOnce(script);
      if (result.ok) report.pass('scripts', `${script} 冒烟通过`);
      else report.error('scripts', `${script} ${result.reason}`);
    }
  }

  emitReport(report, { json: cfg.json });
  process.exitCode = report.ok() ? 0 : 1;
}

try {
  main();
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
