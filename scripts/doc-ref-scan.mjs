/**
 * 文档引文扫描器（DOC-GOV）：对过程产物候选逐文件扫全库引用，按 S5 三档输出分诊建议。
 *
 * 与 2026-10-23 DOC-DRAIN 一次性脚本的差别（两处判据修正）：
 * 1. 区分「消费引用」与「记账提及」——README 清理记录 / 保留项清单 / 台账登记段里出现的文件名，
 *    只证明「有人记过它」，不证明「有人需要它的内容」，不得作为存活依据（防自证循环）。
 * 2. `tasks/` 不再整族算真相链——只有主台账与 archive 收据是真相层；tasks 根目录的报告属过程产物，
 *    其互引按过程产物互引计，不再误升为外部消费。
 *
 * 用法：
 *   node scripts/doc-ref-scan.mjs          报告分诊（恒返回 0）
 *   node scripts/doc-ref-scan.mjs --check  追加「tasks 根目录证据附件是否被 archive 钉住」校验（告警档）
 *
 * 只读脚本：不做任何写操作，处置（删 / 指针化 / 保留）仍由人按 S5 判据拍板。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname, relative, sep } from 'node:path';

const ROOT = process.cwd();

// 扫描排除目录：与 .gitignore 同源（含 coverage-tmp，原一次性脚本漏排的变体目录）
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.workbuddy',
  'dist',
  'out',
  '.vsix-build',
  'tmp',
  'coverage',
  'coverage-tmp',
]);

const TEXT_EXT = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.yml',
  '.yaml',
  '.html',
  '.css',
  '.txt',
]);

// 治理文档 + 治理段落关键词：命中即视为「记账提及」，不计入消费。
// 判据按「段落」而非「单行」——清理记录表格的文件名行与段落标题常分行，单行判定会漏。
// README（治理说明）认全部处置词；主台账只认「处置已发生」类词（指针档/删除档/已删），
// 不认「取证/方案/拍板」等普通叙述词——否则会把开放项对方案稿的真实引用误判为记账（HOST-CTX-4 实证）。
const GOVERNANCE_README = /(^|\/)README\.md$/;
const GOVERNANCE_LEDGER = /^tasks\/待完成任务\.md$/;
const GOVERNANCE_LINE = /(清理记录|保留项|已删|删除档|降指针|指针档|迁入|迁出)/;
const LEDGER_DISPOSAL = /(指针档|删除档|已删|\b删\s*\d+\s*份)/;

/** 递归收集文件（可跳过目录） */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** 递归收集 md 相对路径 */
function collectMd(dir, base, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) collectMd(p, rel, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(rel);
  }
  return out;
}

// 候选集 = 可能被 S5 处置的过程产物（真相链文档与治理 README 不在其列）
const CORE_DOCS = new Set([
  '白话设计文档.md',
  '白话设计文档-模块篇.md',
  '导航索引.md',
  'memora-api-reference.md',
  'memora-接入指南.md',
  'memora-升级指南-4.x-到-5.0.0.md',
]);
const candidates = [];
for (const f of collectMd(join(ROOT, 'docs'), '')) {
  candidates.push({ path: `docs/${f}`, core: CORE_DOCS.has(f) });
}
for (const f of readdirSync(join(ROOT, 'tasks'))) {
  // 主台账与治理 README 不是过程产物候选
  if (f.endsWith('.md') && f !== '待完成任务.md' && f !== 'README.md')
    candidates.push({ path: `tasks/${f}`, core: false });
}
for (const f of collectMd(join(ROOT, 'deliverables'), '')) {
  if (f !== 'README.md') candidates.push({ path: `deliverables/${f}`, core: false });
}

// 全库文本索引（排除动态产物目录）
const corpus = walk(ROOT)
  .filter((p) => TEXT_EXT.has(extname(p)))
  .map((p) => ({
    rel: relative(ROOT, p).replace(/\\/g, '/'),
    text: readFileSync(p, 'utf8'),
  }));

/**
 * 引用者分层：truth = 真相链与收据；process = 过程产物互引；index = 导航索引（同义反复，不计活跃度）
 */
function classify(by) {
  if (by === 'docs/导航索引.md') return 'index';
  if (by === 'tasks/待完成任务.md' || by.startsWith('tasks/archive/')) return 'truth';
  if (by.startsWith('.trae/') || by.startsWith('src/') || by.startsWith('scripts/')) return 'truth';
  if (by.startsWith('hosts/') || by.startsWith('prompts/') || by.startsWith('role-packs/'))
    return 'truth';
  if (by === 'package.json' || by === 'CHANGELOG.md' || /^README(\.[a-z]{2})?\.md$/.test(by))
    return 'truth';
  if (by.startsWith('docs/')) return 'process';
  if (by.startsWith('deliverables/')) return 'process';
  if (by.startsWith('tasks/')) return 'process'; // tasks 根目录报告 = 过程产物
  return 'process';
}

/**
 * 判定引用是否为「记账提及」：只有治理文档中的治理段落才算。
 * 段落 = 以空行分隔的连续文本块；表格行与其上方标题同属一段。
 * @param {string} by 引用者相对路径
 * @param {string} paragraph 命中所在段落文本
 */
function isLedgerHit(by, paragraph) {
  if (GOVERNANCE_README.test(by)) return GOVERNANCE_LINE.test(paragraph);
  if (GOVERNANCE_LEDGER.test(by)) return LEDGER_DISPOSAL.test(paragraph);
  return false;
}

/** 取首个命中行所在的段落（用于记账判定） */
function firstHitParagraph(text, path, name) {
  const pathRe = new RegExp(
    `\\.\\./.*${escapeRe(name)}|/\\./${escapeRe(name)}|\\]\\([^)]*${escapeRe(name)}`,
  );
  const paragraphs = text.split(/\r?\n\s*\r?\n/);
  for (const para of paragraphs) {
    if (para.includes(path) || para.includes(name) || pathRe.test(para)) return para;
  }
  return '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scanFile(c) {
  const name = basename(c.path);
  const refs = [];
  for (const doc of corpus) {
    if (doc.rel === c.path) continue; // 自引用不计
    const t = doc.text;
    let kind = null;
    if (t.includes(c.path)) kind = 'path';
    else if (new RegExp(`\\.\\./.*${escapeRe(name)}|/\\./${escapeRe(name)}`).test(t))
      kind = 'relpath';
    else if (new RegExp(`\\]\\([^)]*${escapeRe(name)}`).test(t)) kind = 'link';
    else if (t.includes(name)) kind = 'bare';
    if (!kind) continue;
    const paragraph = firstHitParagraph(t, c.path, name);
    refs.push({
      by: doc.rel,
      kind,
      layer: classify(doc.rel),
      ledger: isLedgerHit(doc.rel, paragraph),
    });
  }
  return refs;
}

const rows = candidates.map((c) => ({ ...c, refs: scanFile(c) }));

// 分档：外部消费（truth 非记账）> 仅过程互引 > 仅记账入边 > 零引用
const buckets = { external: [], internal: [], ledgerOnly: [], none: [] };
for (const r of rows) {
  if (r.refs.length === 0) {
    buckets.none.push(r);
    continue;
  }
  const consuming = r.refs.filter((x) => !x.ledger && x.layer === 'truth');
  // 索引与过程产物互引都不构成真相链消费，同归「无外部消费」档（索引按口径不计活跃度）
  const processRefs = r.refs.filter((x) => !x.ledger && x.layer !== 'truth');
  if (consuming.length) buckets.external.push(r);
  else if (processRefs.length) buckets.internal.push(r);
  else buckets.ledgerOnly.push(r);
}

const fmtRefs = (r) =>
  r.refs.map((x) => `${x.by}(${x.kind}${x.ledger ? '·记账' : ''})`).join(' | ');

console.log(
  `===== 候选 ${rows.length}（CORE ${rows.filter((r) => r.core).length}）· 判据：消费 ≠ 记账 =====\n`,
);
console.log(
  `##### 外部消费（真相链/台账/archive/rules/src 非记账引用）· ${buckets.external.length} → 保留 #####`,
);
for (const r of buckets.external) console.log(`${r.path}  <=  ${fmtRefs(r)}`);
console.log(
  `\n##### 仅过程产物互引 / 索引（无真相链消费）· ${buckets.internal.length} → S5 删除档候选 #####`,
);
for (const r of buckets.internal) console.log(`${r.path}  <=  ${fmtRefs(r)}`);
console.log(
  `\n##### 仅治理记账提及（README 清理记录/保留项）· ${buckets.ledgerOnly.length} → 不可作为存活依据 #####`,
);
for (const r of buckets.ledgerOnly) console.log(`${r.path}  <=  ${fmtRefs(r)}`);
console.log(`\n##### 零引用 · ${buckets.none.length} → 删除档候选（git 即档案）#####`);
for (const r of buckets.none) console.log(`${r.core ? '[CORE!] ' : ''}${r.path}`);

// --check：tasks 根目录的「证据附件」必须被 archive 收据钉住（README 声明的治理规则机检化）
// 语料排除 reviews/：reviews 区本身是迁入的过程产物（报告互引裸名），其提及不是收据——
// 否则「迁入 reviews 的报告裸名提及某 tasks 根报告」会把后者误消音（自证循环同族，2026-10-23 实证）。
if (process.argv.includes('--check')) {
  const archiveText = walk(join(ROOT, 'tasks', 'archive'))
    .filter((p) => p.endsWith('.md') && !p.includes(`${sep}reviews${sep}`))
    .map((p) => readFileSync(p, 'utf8'))
    .join('\n');
  const orphans = [];
  for (const f of readdirSync(join(ROOT, 'tasks'))) {
    if (!f.endsWith('.md') || f === '待完成任务.md' || f === 'README.md') continue;
    if (!archiveText.includes(f)) orphans.push(`tasks/${f}`);
  }
  console.log(
    `\n##### --check：未被 archive 收据引用的 tasks 根目录报告 · ${orphans.length} #####`,
  );
  for (const p of orphans) console.log(`⚠️  ${p}`);
}
