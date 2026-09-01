#!/usr/bin/env node
/**
 * 角色包初始化脚手架（skaffold）—— LLM 调用脚本：把内置静态标准模板（templates/standard/）
 * 复制到当前项目并替换身份占位符，产出结构合法的角色包骨架，再由 LLM 精修。
 *
 * 设计：模板是静态真实文件（SSOT 结构来源，不手写 JSON），脚本只做「复制 + 改名 + 填槽」。
 * 纯 Node 标准库、零第三方依赖。调用方式：
 *   node skaffold.mjs <角色名> [--display 展示名] [--desc 描述]
 *                     [--keywords k1,k2] [--handoff 话术] [--out 目标目录] [--force]
 */
import { cp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 兜底契约包名（memora 内置角色，禁止同名创建；与内核 BUILTIN_FALLBACK_PACK 一致）
const BUILTIN_FALLBACK_PACK = 'memora助手';
// 角色名合法字符（中文+CJK、字母、数字、下划线、连字符），长度 1~64
const NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/;
// 模板目录：本脚本 ../templates/standard/
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'standard');
// 需要做占位符替换的模板文件（相对模板根）
const PLACEHOLDER_FILES = ['manifest.json', 'persona.md', 'rules.md', 'skills/README.md'];
// 默认衔接话术（handoffPrompt 缺省版本）
const DEFAULT_HANDOFF = '我已准备好。请告诉我：本次要处理什么任务、有什么已知约束？';

/**
 * 解析命令行参数
 * @param {string[]} argv 原始参数（不含 node 与脚本自身）
 */
function parseArgs(argv) {
  const cfg = {
    name: argv[0] ?? '',
    display: '',
    desc: '',
    keywords: [],
    handoff: '',
    out: '',
    force: false,
  };
  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case '--display': cfg.display = argv[++i] ?? ''; break;
      case '--desc': cfg.desc = argv[++i] ?? ''; break;
      case '--keywords':
        cfg.keywords = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--handoff': cfg.handoff = argv[++i] ?? ''; break;
      case '--out': cfg.out = argv[++i] ?? ''; break;
      case '--force': cfg.force = true; break;
      default: throw new Error(`未知参数 "${argv[i]}"`);
    }
  }
  return cfg;
}

/**
 * 校验角色名：非空、不是保留名、不含非法字符
 * @param {string} name
 * @returns {string} 错误信息（空串 = 合法）
 */
function validateName(name) {
  if (!name) return '角色名不能为空';
  if (name === BUILTIN_FALLBACK_PACK) return `保留名 "${BUILTIN_FALLBACK_PACK}" 不可创建/替换（memora 内置兜底角色，避免冲突）`;
  if (name.startsWith('.')) return '角色名不能以 "." 开头';
  if (!NAME_RE.test(name)) return '角色名仅允许 中文/字母/数字/下划线/连字符（长度 1~64）';
  return '';
}

/**
 * 对单个文件做占位符替换（模板由本 skill 维护，占位符无二义）
 * @param {string} filePath 绝对路径
 * @param {Record<string,string>} map 占位符 → 值
 */
async function replacePlaceholders(filePath, map) {
  let text = await readFile(filePath, 'utf-8');
  for (const [token, value] of Object.entries(map)) text = text.split(token).join(value);
  await writeFile(filePath, text, 'utf-8');
}

/**
 * 主流程：校验 → 复制模板 → 占位符替换 → 摘要
 */
async function main() {
  const cfg = parseArgs(process.argv.slice(2));

  // 1) 校验角色名 + 目标父目录
  const nameErr = validateName(cfg.name);
  if (nameErr) throw new Error(nameErr);
  const outDir = cfg.out ? resolve(cfg.out) : resolve(process.cwd());
  const targetDir = join(outDir, cfg.name);

  // 2) 目标已存在则默认拒绝（防覆盖已有角色包），--force 覆盖
  await mkdir(outDir, { recursive: true });
  try {
    await access(targetDir);
    if (!cfg.force) throw new Error(`目标目录已存在：${targetDir}（如需覆盖请加 --force）`);
  } catch (err) {
    if (err && err.message?.startsWith('目标目录已存在')) throw err;
    // 其他错误 = 目录不存在，继续
  }

  // 3) 模板完整性自检
  try {
    await access(TEMPLATE_DIR);
  } catch {
    throw new Error(`标准模板不存在：${TEMPLATE_DIR}（技能 templates/ 分发异常）`);
  }

  // 4) 复制模板 → 目标
  await cp(TEMPLATE_DIR, targetDir, { recursive: true });

  // 5) 占位符替换（身份字段注入；keywords 超 20 截断，符合 schema maxItems=20）
  const display = cfg.display || cfg.name;
  const keywordsJson = JSON.stringify(cfg.keywords.slice(0, 20));
  const map = {
    '{{PACK_NAME}}': cfg.name,
    '{{PACK_DISPLAY_NAME}}': display,
    '{{PACK_DESCRIPTION}}': cfg.desc || '（待补充：一句话定位这个角色的职责与边界）',
    '{{PACK_KEYWORDS}}': keywordsJson,
    '{{PACK_HANDOFF}}': cfg.handoff || DEFAULT_HANDOFF,
  };
  for (const rel of PLACEHOLDER_FILES) {
    await replacePlaceholders(join(targetDir, rel), map);
  }

  // 6) 摘要（供 LLM 继续精修时定位）
  console.log(`✅ 角色包骨架已生成：${targetDir}`);
  console.log(`   展示名：${display} ｜ 关键词：${keywordsJson}`);
  console.log('下一步：');
  console.log(`  1. 编辑 ${targetDir}/manifest.json（增删 capabilities / 调整 strategy）`);
  console.log(`  2. 编辑 persona.md / rules.md / skills/（按角色精修）`);
  console.log('  3. 校验：manifest 为合法 JSON；数值/枚举在 SKILL.md 键速查区间内；skills/*.md 含 description');
  console.log('  4. 完成产物即交付用户，由用户决定复制到哪个 memora 宿主');
}

main().catch((err) => {
  console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});