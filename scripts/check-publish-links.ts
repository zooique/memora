/**
 * 文档死链检查器 — 发布边界模式（默认）+ 全仓模式（--repo）
 *
 * 双模式定位：
 *   · publish（默认）= **发布边界**闸门：`package.json#files` 白名单才是「进发布包」的实锤边界。
 *     出货 `.md` 里的相对链接若解析到白名单之外，npm 消费者点开即 404 —— 但**在仓库内它往往是
 *     好的**，所以人工审查极易漏判（人工只数出 3 处，按本判据实为 10 处）。
 *   · repo（`--repo`）= **全仓**闸门：仓库内所有 `.md` 的相对链接必须在磁盘上存在。链接腐烂
 *     是静默失效（与「静默失败 = 假阴性」同族），靠人工巡检必漏。全仓 0 死链基线锁定后上闸，
 *     硬闸不设豁免清单（开口子即豁免清单腐烂的起点）。
 *
 * 双条件判据（缺一不可，只查一半会误判）：
 *   ① **目标在磁盘上存在** —— 不满足 = 连仓库内都是断的（真 bug，如路径深度写错）；两模式都查。
 *   ② **目标在发布白名单内** —— 不满足 = 仅 npm 消费者断（发布边界缺陷）；仅 publish 模式查。
 *   另：`package.json` 等属 npm **强制随包**文件（与 `files` 无关），不得误报。
 *
 * 闸门自检（self-test，每次运行都跑，不可关闭）：
 *   「扫描 0 命中即成功」这类断言若判据本身失明（正则改坏、白名单解析失效），会**静默 exit 0**
 *   —— 实测：把 `LINK_RE` 改成永不匹配的有效正则后，真死链也能被放行。故本脚本先对 3 条内置
 *   样例跑**同一套判据**（`classifyTarget`，与主扫描同源，非另写一套），未全捕获即 exit 2。
 *   自检跑不通过 = 闸门已瞎，此时「0 命中」不可信。样例期望**按模式分列**（同一样例在两模式下
 *   判定不同），防「换模式后判据悄悄变宽」。
 *
 * 用法：
 *   npx tsx scripts/check-publish-links.ts          # 发布边界模式，有问题 exit 1
 *   npx tsx scripts/check-publish-links.ts --repo   # 全仓模式，有问题 exit 1
 *
 * 修法纪律（两模式共用）：默认**不扩白名单**、不开豁免；改链接，或把链接显式降级为
 * 纯文本（不伪装可达）。publish 命中另有边界语义：指向内部文档 → 去链接化、使散文自足。
 *
 * 设计纪律：纯 FS、零三方依赖、零网络、确定性（与 `eval:budget` 同型），可进 CI。
 *           不修改任何文件；只读盘点 + 退出码。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 运行模式：false = 发布边界模式（默认）；true = 全仓模式（--repo，只查「目标是否存在」） */
const REPO_MODE = process.argv.includes('--repo');

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

/** 全仓模式额外跳过：派生产物/临时目录（由源码派生，扫它们只会重复报源里的问题） */
const REPO_SKIP_DIRS = new Set(['dist', 'coverage', '.workbuddy']);

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

/** 收集待扫 markdown：publish = 仅随包；repo = 全仓所有 .md（遍历含 dist，避免 .md 落进 dist 时的盲区） */
function collectShippedMarkdown(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (REPO_MODE && REPO_SKIP_DIRS.has(name)) continue;
      collectShippedMarkdown(abs, out);
      continue;
    }
    if (!name.endsWith('.md')) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (REPO_MODE || isShipped(rel)) out.push(rel);
  }
}

const LINK_RE = /\]\(([^)]*)\)/g;

/** 行内代码跨度正则：反引号游程成对（同长开闭），跨距内的 `[..](...)` 是示例语法、非链接 */
const INLINE_CODE_RE = /(`+)(.*?)\1/g;

/** 代码围栏行（``` 或 ~~~ 开头）：围栏内的 `[..](...)` 同样是示例语法 */
const FENCE_RE = /^\s*(```|~~~)/;

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

/** 链接判据唯一实现：主扫描与自检共用，杜绝「自检通过但判据已瞎」；发布白名单判定仅 publish 模式生效 */
function classifyTarget(raw: string, fromRel: string): Classified {
  const t = raw.trim();
  const none: Classified = { verdict: 'skip', resolved: '' };
  if (!t || t.startsWith('#') || isExternal(t)) return none;
  const target = normalizeTarget(t);
  if (!target) return none;
  const resolved = relative(ROOT, resolve(dirname(join(ROOT, fromRel)), target)).replace(/\\/g, '/');
  if (!existsSync(join(ROOT, resolved))) return { verdict: 'missing', resolved };
  if (!REPO_MODE && !isShipped(resolved)) return { verdict: 'unshipped', resolved };
  return { verdict: 'ok', resolved };
}

/** 扫描一行：剥行内代码 → LINK_RE 提取 + classifyTarget 判定，主扫描与自检**端到端同源** */
function scanLine(line: string, fromRel: string): Array<Omit<Finding, 'line'>> {
  const out: Array<Omit<Finding, 'line'>> = [];
  // 示例语法豁免：文档教链接写法时必然出现 `[文档名](相对路径)` 之类的反引号示例，不是真链接
  const cleaned = line.replace(INLINE_CODE_RE, ' ');
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(cleaned)) !== null) {
    // noUncheckedIndexedAccess：捕获组索引访问为 string | undefined，判据容错为空串
    const raw = m[1] ?? '';
    const { verdict, resolved } = classifyTarget(raw, fromRel);
    if (verdict === 'missing' || verdict === 'unshipped') {
      out.push({ file: fromRel, raw: raw.trim(), resolved, verdict });
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
  /** publish 模式期望（含发布白名单判定） */
  publish: { hits: number; verdict?: 'missing' | 'unshipped' };
  /** repo 模式期望（只查磁盘存在性；目标在盘上的链接不报） */
  repo: { hits: number; verdict?: 'missing' };
}> = [
  // [A] 目标不存在 → 两模式各命中 1（同行的外链须被跳过）；verdict = missing
  {
    line: '见 [外链](https://example.com) 与 [坏链](../../__self_test_missing__/nope.md)。',
    publish: { hits: 1, verdict: 'missing' },
    repo: { hits: 1, verdict: 'missing' },
  },
  // [B] 目标存在但不随包（scripts/ 不在 files 白名单）→ publish 命中 1/unshipped；repo 命中 0
  {
    line: '见 [脚本](../../scripts/check-publish-links.ts) 说明。',
    publish: { hits: 1, verdict: 'unshipped' },
    repo: { hits: 0 },
  },
  // [C] 反向护栏：随包链接不得误报（正则过宽会连正常链接一起判死）→ 两模式命中 0
  { line: '见 [指南](./role-pack-spec.md) 说明。', publish: { hits: 0 }, repo: { hits: 0 } },
  // [D] 反向护栏：行内代码里的链接模板是示例语法，不算链接（豁免判据失明即误报）→ 两模式命中 0
  { line: '格式：`[文档名 §章节号 标题](相对路径)`。', publish: { hits: 0 }, repo: { hits: 0 } },
];

function runSelfTest(): boolean {
  let ok = 0;
  for (const c of SELF_TEST) {
    // 期望按模式取值：同一样例两模式判定不同，防「换模式后判据悄悄变宽」
    const exp = REPO_MODE ? c.repo : c.publish;
    const hit = scanLine(c.line, SELF_TEST_ANCHOR);
    const got = hit[0]?.verdict ?? 'none';
    const pass = hit.length === exp.hits && (exp.verdict === undefined || got === exp.verdict);
    if (pass) ok += 1;
    else console.error(`  自检失败: 「${c.line}」期望命中 ${exp.hits}/${exp.verdict ?? '-'}，实得 ${hit.length}/${got}`);
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
  let inFence = false; // 代码围栏状态：围栏内是示例代码，跳过
  lines.forEach((line, i) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const f of scanLine(line, rel)) {
      (f.verdict === 'missing' ? missing : unshipped).push({ ...f, line: i + 1 });
    }
  });
}

const total = missing.length + unshipped.length;

console.log(
  REPO_MODE
    ? `全仓文档死链检查 · markdown ${shippedMd.length} 个（全仓）`
    : `发布边界死链检查 · 随包 markdown ${shippedMd.length} 个 · 白名单 ${ALLOW.length} 项`,
);

if (missing.length) {
  console.log(`\n[A] 目标在磁盘上不存在（连仓库内都是断的）: ${missing.length}`);
  for (const f of missing) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
} else {
  console.log('\n[A] 目标在磁盘上不存在: 0');
}

if (!REPO_MODE) {
  if (unshipped.length) {
    console.log(`\n[B] 目标存在但不在发布包（仅 npm 消费者断）: ${unshipped.length}`);
    for (const f of unshipped) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}   (解析为 ${f.resolved})`);
  } else {
    console.log('\n[B] 目标存在但不在发布包: 0');
  }
}

console.log(`\n合计: ${total}`);

if (total > 0) {
  console.log(
    REPO_MODE
      ? '\n修法纪律：默认**不开豁免**（开口子即豁免清单腐烂的起点）。\n' +
          '  · 目标确实该存在 → 改正链接路径；\n' +
          '  · 目标确实不该存在 → 把链接显式降级为纯文本（不再伪装可达）。'
      : '\n修法纪律：默认**不扩白名单**（扩 = 把内部分析文档重新塞回 npm 包，与「发布面收窄」相反）。\n' +
          '  · 指向内部文档 → 去链接化、使散文自足；\n' +
          '  · 出货文档已有内容 → 改指向随包 SSOT。',
  );
  process.exit(1);
}
console.log(REPO_MODE ? '\nOK：全仓文档无死链。' : '\nOK：出货文档无越界链接。');
