#!/usr/bin/env node
/**
 * 技能骨架脚手架（skaffold-skill）—— LLM 调用脚本：把静态标准模板
 * `templates/standard/SKILL.md` 复制到项目级技能目录并替换身份占位符，
 * 产出结构合法的技能骨架，再由 LLM 精修内容。
 *
 * 设计边界（与 role-pack-creator/scripts/skaffold.mjs 同一纪律）：
 * - 模板是静态真实文件（结构 SSOT），脚本只做「复制 + 填槽」，不生成内容；
 * - 纯 Node 标准库，零第三方依赖；
 * - 落点固定为 `<workspace>/.memora/skills/<name>/SKILL.md`
 *   （真源 `src/agent/assembler.ts` 的 SKILL_WRITE_LOCATION_PROMPT；
 *   宿主侧白名单见 `hosts/memora-vscode/src/extension/host/assemble.ts`）。
 *
 * 调用方式：
 *   node skaffold-skill.mjs <name> --desc "一句话用途与触发场景"
 *        [--display 中文展示名] [--workspace 项目根] [--force]
 */
import { access, cp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEBAB_RE, inspectDescription } from '../../_lib/verify-core.mjs';

/** 模板目录：本脚本 ../templates/standard/（静态结构唯一真相源） */
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'standard');

/** 需要做占位符替换的模板文件（相对模板根） */
const PLACEHOLDER_FILES = ['SKILL.md'];

/**
 * 解析命令行参数
 * @param {string[]} argv 原始参数（不含 node 与脚本自身）
 * @returns {{name: string, desc: string, display: string, workspace: string, force: boolean}}
 */
function parseArgs(argv) {
  const cfg = { name: argv[0] ?? '', desc: '', display: '', workspace: '', force: false };
  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case '--desc':
        cfg.desc = argv[++i] ?? '';
        break;
      case '--display':
        cfg.display = argv[++i] ?? '';
        break;
      case '--workspace':
        cfg.workspace = argv[++i] ?? '';
        break;
      case '--force':
        cfg.force = true;
        break;
      default:
        throw new Error(`未知参数 "${argv[i]}"`);
    }
  }
  return cfg;
}

/**
 * 校验技能名（kebab + 非空）
 * @param {string} name 技能名
 * @returns {string} 错误信息（空串 = 合法）
 */
function validateName(name) {
  if (!name) return '技能名不能为空';
  if (!KEBAB_RE.test(name)) return '技能名必须是 kebab-case（只允许小写字母/数字/连字符）';
  return '';
}

/**
 * 对单个文件做占位符替换（模板由本 skill 维护，占位符无二义）
 * @param {string} filePath 绝对路径
 * @param {Record<string, string>} map 占位符 → 值
 */
async function replacePlaceholders(filePath, map) {
  let text = await readFile(filePath, 'utf-8');
  for (const [token, value] of Object.entries(map)) text = text.split(token).join(value);
  await writeFile(filePath, text, 'utf-8');
}

/**
 * 主流程：校验名字/描述 → 防覆盖 → 复制模板 → 填槽 → 输出下一步
 */
async function main() {
  // 冒烟模式：verify-skill.mjs 注入 MEMORA_VERIFY_SMOKE=1 后只验证脚本可加载，不写任何文件
  if (process.env.MEMORA_VERIFY_SMOKE === '1') {
    console.log('冒烟模式：skaffold-skill.mjs 依赖与语法自检通过');
    return;
  }

  const cfg = parseArgs(process.argv.slice(2));

  // 1) 名字与 description 前置校验（description 是 L1 唯一触发依据，空值不可交付）
  const nameErr = validateName(cfg.name);
  if (nameErr) throw new Error(nameErr);
  const descCheck = inspectDescription(cfg.desc);
  if (descCheck.errors.length > 0) throw new Error(descCheck.errors.join('；'));

  // 2) 落点固定为项目级 `.memora/skills`（不允许写用户级 globalStorage）
  const workspace = cfg.workspace ? resolve(cfg.workspace) : resolve(process.cwd());
  const targetDir = join(workspace, '.memora', 'skills', cfg.name);
  const targetFile = join(targetDir, 'SKILL.md');

  // 3) 目标已存在则默认拒绝（防覆盖已有技能），--force 覆盖
  await mkdir(dirname(targetDir), { recursive: true });
  try {
    await access(targetDir);
    if (!cfg.force) throw new Error(`目标已存在：${targetDir}（如需覆盖请加 --force）`);
  } catch (err) {
    if (err && err.message?.startsWith('目标已存在')) throw err;
    // 其他错误 = 目录不存在，继续
  }

  // 4) 模板完整性自检
  try {
    await access(TEMPLATE_DIR);
  } catch {
    throw new Error(`标准模板不存在：${TEMPLATE_DIR}（技能 templates/ 分发异常）`);
  }

  // 5) 复制模板 → 目标
  await cp(TEMPLATE_DIR, targetDir, { recursive: true });

  // 6) 占位符替换（身份字段注入）
  // 展示名缺省不能直接用 kebab id：校验闸要求 H1 不得等于英文 id，否则骨架一生成就红
  const display = cfg.display || `${cfg.name} 技能`;
  const map = {
    '{{SKILL_NAME}}': cfg.name,
    '{{SKILL_DESCRIPTION}}': cfg.desc.trim(),
    '{{SKILL_DISPLAY_NAME}}': display,
  };
  for (const rel of PLACEHOLDER_FILES) {
    await replacePlaceholders(join(targetDir, rel), map);
  }

  // 7) 摘要（供 LLM 继续精修时定位）
  console.log(`✅ 技能骨架已生成：${targetFile}`);
  console.log(`   展示名：${display}`);
  console.log('下一步：');
  console.log(`  1. 编辑 ${targetFile}（补全何时使用/执行步骤/输出/边界）`);
  console.log(`  2. 需要长文档或脚本时，新建 ${targetDir}/references/ 或 scripts/`);
  console.log(`  3. 校验：node scripts/verify-skill.mjs ${targetDir}`);
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
