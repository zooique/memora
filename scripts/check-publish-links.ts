/**
 * 发布边界 · 出货文档死链检查器（D8 · 2026-09-12）
 *
 * 定位（C7 收口后的防回归闸门）：
 *   `package.json#files` 白名单才是「进发布包」的实锤边界。出货 `.md` 里的相对链接若解析到
 *   白名单之外，npm 消费者点开即 404 —— 但**在仓库内它往往是好的**，所以人工审查极易漏判
 *   （C7 人工初版只数出 3 处；以本判据回测**修复前**的文档为 10 处。本脚本建于修复之后，
 *   首次运行即为 0 命中，「10」是回测数而非本脚本实测数）。
 *
 * 双条件判据（缺一不可，只查一半会误判）：
 *   ① **目标在磁盘上存在** —— 不满足 = 连仓库内都是断的（真 bug，如路径深度写错）；
 *   ② **目标在发布白名单内** —— 不满足 = 仅 npm 消费者断（发布边界缺陷）。
 *   另：`package.json` 等属 npm **强制随包**文件（与 `files` 无关），不得误报。
 *
 * 闸门自检（self-test，每次运行都跑，不可关闭）：
 *   「扫描 0 命中即成功」这类断言若判据本身失明（正则改坏、白名单解析失效），会**静默 exit 0**
 *   —— 实测：把 `LINK_RE` 改成永不匹配的有效正则后，真死链也能被放行。故本脚本先对 2 条内置
 *   样例跑**同一套判据**（`classifyTarget`，与主扫描同源，非另写一套），未全捕获即 exit 2。
 *   自检跑不通过 = 闸门已瞎，此时「0 命中」不可信。
 *
 * 用法：
 *   npx tsx scripts/check-publish-links.ts          # 打印报告，有问题 exit 1
 *
 * 设计纪律：纯 FS、零三方依赖、零网络、确定性（与 `eval:budget` 同型），可进 CI。
 *           不修改任何文件；只读盘点 + 退出码。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** npm 无论 `files` 如何配置都会随包的文件（误报源，必须豁免） */
const ALWAYS_SHIPPED = new Set([
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
]);

/** 不入包且体量巨大的目录（遍历性能考虑；node_modules 永不随包） */
const SKIP_DIRS = new Set(['node_modules', '.git']);

interface Finding {
  file: string;
  line: number;
  raw: string;
  resolved: string;
  verdict: 'missing' | 'unshipped';
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  files?: string[];
};
const ALLOW = (pkg.files ?? []).map((f) => f.replace(/\\/g, '/'));

function isShipped(rel: string): boolean {
  const r = rel.replace(/\\/g, '/');
  if (ALWAYS_SHIPPED.has(r)) return true;
  return ALLOW.some((e) => r === e || r.startsWith(`${e}/`));
}

/** 收集所有随包的 markdown 文件（遍历含 dist，避免 .md 落进 dist 时的盲区） */
function collectShippedMarkdown(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collectShippedMarkdown(abs, out);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (isShipped(rel)) out.push(rel);
  }
}

const LINK_RE = /\]\(([^)]*)\)/g;

/** 自检样例的解析起点：选必然随包的出货 md，保证 dirname 相对解析有效 */
const SELF_TEST_ANCHOR = 'docs/architecture/role-pack-authoring-guide.md';

function isExternal(target: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(target);
}

/** 去片段、解码转义（如 %20），失败则原样返回 */
function normalizeTarget(raw: string): string {
  const noHash = raw.indexOf('#') >= 0 ? raw.slice(0, raw.indexOf('#')) : raw;
  const trimmed = noHash.trim();
  if (!trimmed) return '';
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

type Verdict = 'skip' | 'missing' | 'unshipped' | 'ok';

interface Classified {
  verdict: Verdict;
  resolved: string;
}

/** 链接判据唯一实现：主扫描与自检共用，杜绝「自检通过但判据已瞎」 */
function classifyTarget(raw: string, fromRel: string): Classified {
  const t = raw.trim();
  const none: Classified = { verdict: 'skip', resolved: '' };
  if (!t || t.startsWith('#') || isExternal(t)) return none;
  const target = normalizeTarget(t);
  if (!target) return none;
  const resolved = relative(ROOT, resolve(dirname(join(ROOT, fromRel)), target)).replace(/\\/g, '/');
  if (!existsSync(join(ROOT, resolved))) return { verdict: 'missing', resolved };
  if (!isShipped(resolved)) return { verdict: 'unshipped', resolved };
  return { verdict: 'ok', resolved };
}

/** 扫描一行：LINK_RE 提取 + classifyTarget 判定，主扫描与自检**端到端同源** */
function scanLine(line: string, fromRel: string): Array<Omit<Finding, 'line'>> {
  const out: Array<Omit<Finding, 'line'>> = [];
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(line)) !== null) {
    const { verdict, resolved } = classifyTarget(m[1], fromRel);
    if (verdict === 'missing' || verdict === 'unshipped') {
      out.push({ file: fromRel, raw: m[1].trim(), resolved, verdict });
    }
  }
  return out;
}

/**
 * 闸门自检：判据失明时「0 命中」是假绿，故先证明闸门还看得见。
 * 必须**从原始文本行**起跑（含 LINK_RE 提取环节）——只测判据会漏掉「提取正则被改坏」
 * 这一类最易发生的失明（实测：只测判据时，正则失明仍能静默 exit 0）。
 * 样例锚点选必然随包的出货 md（保证 dirname 解析有效），目标零额外磁盘依赖。
 * 断言**命中数**而不只是首条判定：否则「外链跳过逻辑失效」会碰巧凑出同样的首条判定而蒙混过关。
 */
const SELF_TEST: ReadonlyArray<{
  line: string;
  hits: number;
  verdict?: 'missing' | 'unshipped';
}> = [
  // [A] 目标不存在 → 命中 1（同行的外链须被跳过）；verdict = missing
  {
    line: '见 [外链](https://example.com) 与 [坏链](../../__self_test_missing__/nope.md)。',
    hits: 1,
    verdict: 'missing',
  },
  // [B] 目标存在但不随包（scripts/ 不在 files 白名单）→ 命中 1，verdict = unshipped
  { line: '见 [脚本](../../scripts/check-publish-links.ts) 说明。', hits: 1, verdict: 'unshipped' },
  // [C] 反向护栏：随包链接不得误报（正则过宽会连正常链接一起判死）→ 命中 0
  { line: '见 [指南](./role-pack-spec.md) 说明。', hits: 0 },
];

function runSelfTest(): boolean {
  let ok = 0;
  for (const c of SELF_TEST) {
    const hit = scanLine(c.line, SELF_TEST_ANCHOR);
    const got = hit[0]?.verdict ?? 'none';
    const pass = hit.length === c.hits && (c.verdict === undefined || got === c.verdict);
    if (pass) ok += 1;
    else console.error(`  自检失败: 「${c.line}」期望命中 ${c.hits}/${c.verdict ?? '-'}，实得 ${hit.length}/${got}`);
  }
  console.log(`闸门自检: ${ok}/${SELF_TEST.length} 样例符合预期`);
  return ok === SELF_TEST.length;
}

if (!runSelfTest()) {
  console.error('\n闸门自检未通过：判据可能已失明，此时「0 命中」不可信。');
  process.exit(2);
}

const missing: Finding[] = [];
const unshipped: Finding[] = [];

const shippedMd: string[] = [];
collectShippedMarkdown(ROOT, shippedMd);
shippedMd.sort();

for (const rel of shippedMd) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const f of scanLine(line, rel)) {
      (f.verdict === 'missing' ? missing : unshipped).push({ ...f, line: i + 1 });
    }
  });
}

const total = missing.length + unshipped.length;

console.log(`发布边界死链检查 · 随包 markdown ${shippedMd.length} 个 · 白名单 ${ALLOW.length} 项`);

if (missing.length) {
  console.log(`\n[A] 目标在磁盘上不存在（连仓库内都是断的）: ${missing.length}`);
  for (const f of missing) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
} else {
  console.log('\n[A] 目标在磁盘上不存在: 0');
}

if (unshipped.length) {
  console.log(`\n[B] 目标存在但不在发布包（仅 npm 消费者断）: ${unshipped.length}`);
  for (const f of unshipped) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
} else {
  console.log('\n[B] 目标存在但不在发布包: 0');
}

console.log(`\n合计: ${total}`);

if (total > 0) {
  console.log(
    '\n修法纪律：默认**不扩白名单**（扩 = 把内部分析文档重新塞回 npm 包，与「发布面收窄」相反）。\n' +
      '  · 指向内部文档 → 去链接化、使散文自足；\n' +
      '  · 出货文档已有内容 → 改指向随包 SSOT。',
  );
  process.exit(1);
}
console.log('\nOK：出货文档无越界链接。');
