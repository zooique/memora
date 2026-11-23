/**
 * 文档引文扫描器（DOC-GOV）：对过程产物候选逐文件扫全库引用，按 S5 三档输出分诊建议。
 *
 * 与 2026-10-23 DOC-DRAIN 一次性脚本的差别（两处判据修正）：
 * 1. 区分「消费引用」与「记账提及」——README 清理记录 / 保留项清单 / 台账登记段里出现的文件名，
 *    只证明「有人记过它」，不证明「有人需要它的内容」，不得作为存活依据（防自证循环）。
 * 2. `tasks/` 不再整族算真相链——只有主台账与 archive 收据是真相层；tasks 根目录的报告属过程产物，
 *    其互引按过程产物互引计，不再误升为外部消费。
 * 3. `.trae/` 不再整族算真相链（2026-11-23 判据修正）：`.trae/documents` 是过程稿层（生命周期同
 *    tasks 根报告），只有 `.trae/decisions` / `.trae/rules` / `.trae/skills` 是真相层。
 *    实证：巡检进度 / 台账冷读排雷结论的 bare 提及曾把 2 份 docs 文档抬进「外部消费」档。
 * 4. kind 参与强度判定（2026-11-23）：bare = 正文里出现过文件名，最小证据强度，不构成真相链消费，
 *    单列「仅弱引用」档（只出清单、不判删）——path / relpath / link 才算内容级消费。
 *
 * 用法：
 *   node scripts/doc-ref-scan.mjs          报告分诊（恒返回 0）
 *   node scripts/doc-ref-scan.mjs --check  追加「tasks 根目录证据附件是否被 archive 钉住」校验（告警档）
 *   node scripts/doc-ref-scan.mjs --dangling  追加「最近 20 笔提交删除的 md 是否仍被引用」校验（删除清算）
 *
 * 只读脚本：不做任何写操作，处置（删 / 指针化 / 保留）仍由人按 S5 判据拍板。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
// 过程稿层纳入候选（2026-11-23）：此前不在任何存活判据的候选面内，形成永久沉积层
for (const f of collectMd(join(ROOT, '.trae', 'documents'), '')) {
  candidates.push({ path: `.trae/documents/${f}`, core: false });
}
// artifacts 层纳入候选（2026-11-23）：同为过程产物，此前零存活判据视野
for (const f of collectMd(join(ROOT, 'artifacts'), '')) {
  if (f !== 'overview.md') candidates.push({ path: `artifacts/${f}`, core: false });
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
  // 过程稿层：与 tasks 根报告同生命周期，其提及不构成「真相链消费」
  if (by.startsWith('.trae/documents/')) return 'process';
  if (by.startsWith('.trae/') || by.startsWith('src/') || by.startsWith('scripts/')) return 'truth';
  if (by.startsWith('hosts/') || by.startsWith('role-packs/')) return 'truth';
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

// 分档：外部消费（truth 非记账非 bare）> 仅弱引用（truth 里只有 bare）> 仅过程互引 > 仅记账 > 零引用
const buckets = { external: [], weak: [], internal: [], ledgerOnly: [], none: [] };
for (const r of rows) {
  if (r.refs.length === 0) {
    buckets.none.push(r);
    continue;
  }
  const truthRefs = r.refs.filter((x) => !x.ledger && x.layer === 'truth');
  // bare = 正文里出现过文件名（清单点名/随口提及），不足以证明内容被消费
  const consuming = truthRefs.filter((x) => x.kind !== 'bare');
  const weakOnly = truthRefs.filter((x) => x.kind === 'bare');
  // 索引与过程产物互引都不构成真相链消费，同归「无外部消费」档（索引按口径不计活跃度）
  const processRefs = r.refs.filter((x) => !x.ledger && x.layer !== 'truth');
  if (consuming.length) buckets.external.push(r);
  else if (weakOnly.length) buckets.weak.push(r);
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
  `\n##### 仅弱引用（真相链里只有 bare 文件名提及）· ${buckets.weak.length} → 候选清单，不自动判删 #####`,
);
for (const r of buckets.weak) console.log(`${r.path}  <=  ${fmtRefs(r)}`);
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

// --dangling：最近 20 笔提交删除的 .md 是否仍被引用（删除清算机检化）
// 只查最近删除：更早的删除属历史，按 tasks/archive/README.md 纪律 3「失效指针可修」单独处置。
// 同一行含删除声明词（已删/已随/已退役/原指…）不算失效指针——它描述的是「曾经存在」。
//
// 两处**文件级豁免**（2026-11-23 补，同属「历史载体不产生活指针」这一条原则的两个面）：
//   ① `tasks/archive/**` —— 归档是发布时刻的**历史快照**，其引用描述当时状态；要求它跟着清算 = 篡改历史。
//   ② 文件头 10 行自述「历史过程稿 / 本稿不再更新」的文档 —— 整篇已冻结为历史记录，同上。
//      只认**文件头全篇定性**，不认正文局部处置词：否则任何活文档只要在引用旁写个「历史」就能
//      豁免全部悬空引用，判据当场失明（单条引用的 DISPOSAL ±2 行窗口是另一层，不替代本层）。
// 退出码：有残留引用 ⇒ 1（挂 local-ci full 档后，悬空引用 = 真回归）。
// ⚠️ 边界（fail-open，刻意）：`git log` 只看当前克隆的最近 20 笔删除——浅克隆（fetch-depth=1）
//    下删除集偏小甚至为空 ⇒ 覆盖变窄但不误报。本步挂在**本机** pre-push（非 CI，克隆为全量）；
//    若将来挪到 CI，必须先设 fetch-depth: 0，否则这一步会退化成恒绿假闸。
if (process.argv.includes('--dangling')) {
  const log = execSync(
    'git -c core.quotepath=false log --diff-filter=D --name-only --format= --max-count=20',
    { cwd: ROOT, encoding: 'utf8' },
  );
  const deleted = [
    ...new Set(
      log
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith('.md') && basename(s).length >= 6),
    ),
  ];
  // 判据：命中行 ±2 行窗口内出现处置词 ⇒ 是「记录删除」而非「失效指针」。
  // 治理 README 是清理记录的真源所在，整篇豁免（记账职责由 isLedgerHit 承担）。
  const DISPOSAL = /(删|已随|已退役|已失效|原指|原「|原'|历史陈述|当时口径|临时文档|清理)/;
  const GOVERNANCE = /^(tasks\/README\.md|deliverables\/README\.md|tasks\/archive\/README\.md)$/;
  // 文件头全篇定性（历史过程稿 / 快照）——见文件头「两处文件级豁免」②
  const HISTORY_HEAD = /(历史过程稿|历史快照|归档快照|本稿不再更新)/;
  const dangling = [];
  for (const d of deleted) {
    const name = basename(d);
    for (const doc of corpus) {
      if (doc.rel === d || GOVERNANCE.test(doc.rel)) continue;
      // 豁免①：归档目录 = 历史快照
      if (doc.rel.startsWith('tasks/archive/')) continue;
      // 豁免②：文件头自述历史稿（只看前 10 行，防正文局部说明冒充全篇定性）
      if (HISTORY_HEAD.test(doc.text.split(/\r?\n/, 10).join('\n'))) continue;
      const lines = doc.text.split(/\r?\n/);
      lines.forEach((ln, i) => {
        if (!ln.includes(name) && !ln.includes(d)) return;
        const window = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
        if (DISPOSAL.test(window)) return; // 删除声明不是失效指针
        dangling.push(`${doc.rel}:${i + 1}  →  ${d}`);
      });
    }
  }
  console.log(`\n##### --dangling：最近删除 .md 的残留引用 · ${dangling.length} #####`);
  for (const h of dangling) console.log(`⚠️  ${h}`);
  if (dangling.length > 0) process.exitCode = 1;
}
