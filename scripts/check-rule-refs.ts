/**
 * 规则引用路径检查器 —— 防「规则文件移动 / 重命名后，裸路径引用漏改」
 *
 * 为什么存在（血训 · 2026-09-26）：
 *   规则目录重组把 14 个规则文件从 `.trae/rules/` 移入 `.trae/rules/generic/`，却只改了
 *   **markdown 链接形态**的引用（`docs:links` 能抓），留下 **12 处反引号 / 纯文本形态**的
 *   裸路径引用陈旧。`docs:links` 抓不到它们——其判据只认 `](...)` 语法，且主动剥离行内代码跨度
 *   （见 check-publish-links.ts 的 `LINK_RE` / `INLINE_CODE_RE`）→ 裸路径根本不在其扫描面内。
 *   本脚本补这条盲区：裸路径引用是**同一族「参考腐烂」**的另一种书写形态。
 *
 * 判据（唯一）：文本文件里出现 `.trae/rules/<路径>.md` 或 `docs/<路径>.md` 裸引用 → 必须能在仓库中解析到该文件。
 *   docs 族是同一「参考腐烂」的第二书写面：`src/`、`hosts/` 注释里的设计依据指针多写成
 *   `docs/方案-xxx.md` 裸路径，`docs:links` 只抓 `](...)` 链接语法 → 这类指针在本族规则
 *   出现前零门禁覆盖（文档处置后指针留在注释里即静默腐烂，见 comment-doc-citation-rules §3）。
 *
 * 上述判据的三条限定（缺一条即产生系统性假阳/漏报，2026-10-25 补齐并各配自检样例）：
 *   1. **对象是「完整 token」而非「子串」**：匹配点左边若仍是路径字符（`A-Za-z0-9_./-`），
 *      说明它是更长路径的尾段（`hosts/x/docs/y.md`）⇒ 不在本门判据面，判 skip。
 *      不加这条的左边界 ⇒ 截尾后按仓库根解析恒 missing（假阳）；反向同源——若仓库根下
 *      恰有同名文件，**真断链会被尾段救活**（漏报，比假阳更险）。两病同根：判据对象错。
 *   2. **右边界**：`.md` 后紧跟路径字符（`.mdx` / `.md5`）不算本族引用，避免抽出半截扩展名。
 *   3. **链接目标不归本门**：`](…)` 的解析基是「源文件目录」（`docs:links` 的判据），
 *      本门的基是「仓库根」；同一文本被两门用不同基各判一次，必然产出假阳（相对链接被
 *      当根相对判死）或假 OK（链接失效但根下恰有同名）⇒ 按书写形态分工，一门只有一种基：
 *        书写形态                     归属门          解析基
 *        `](target)` 链接             docs:links      源文件目录
 *        裸 docs/ 或 .trae/rules/     rules:refs      仓库根
 *        `./x` `/x` `a/b.md` 简写     无门禁          明示边界（实测扩面会新增 141 处红）
 *      ⇒ 同一行文本不可能被判两次；每种形态只有一个真理源。
 *
 * 两条**刻意排除**（是判据边界，**不是**豁免清单）：
 *   1. 源文件位于 `.trae/skills/**` —— 技能手册是**可移植模板**，其中
 *      `.trae/rules/architecture-quickref.md` / `frontend_architecture_rules.md` 等指向的是
 *      **目标项目**里待生成的文件（big-tree-seeder 会在目标项目生成），在 memora 仓库内本就不该存在。
 *   2. 本脚本自身 —— 否则脚本内作为样例的旧路径文本会给「旧路径基线」续命（同术语门禁的教训：
 *      扫描自身 → 消失检测失效）。
 *
 * 闸门自检（每次运行都跑，不可关闭）：
 *   「0 命中即成功」这类断言若判据本身失明（正则改坏 / 排除逻辑写反），会**静默 exit 0**。
 *   故先对 12 条内置样例跑**同一套判据**（`scanLine`，与主扫描同源，非另写一套），未全过即 exit 2。
 *   样例覆盖「判据的三条限定」各自的正反面（截尾 skip / 链接 skip / 右边界 skip / 裸路径真断链 missing），
 *   缺任一面则那一条限定退化成无守：改坏判据仍会 0 命中假绿。
 *
 * 用法：npx tsx scripts/check-rule-refs.ts   # 有问题 exit 1
 *
 * 修法纪律：默认**不开豁免**。目标确实该存在 → 改正引用路径；目标确实不该存在 → 显式删除该引用或改写为散文。
 *
 * 设计纪律：纯 FS、零三方依赖、零网络、确定性（与 check-publish-links.ts 同型），可进 CI。
 *           不修改任何文件；只读盘点 + 退出码。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根：脚本位于 `<root>/scripts/`，故上跳一层 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 本脚本自身相对路径 —— 必须排除（见文件头「刻意排除」第 2 条） */
const SELF_REL = 'scripts/check-rule-refs.ts';

/** 不入扫描的目录：依赖 / 版本库 / 派生产物 / 临时工作区（与死链检查器同款） */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.workbuddy']);

/** 承载裸路径引用的文本扩展名：实测形态全集（引用散落在 md 文档与 ts/mjs/yml 的注释里） */
const TEXT_EXTS = ['.md', '.ts', '.mjs', '.yml'];

/** 技能手册前缀 —— 其引用指向目标项目文件，属判据边界外（见文件头「刻意排除」第 1 条） */
const SKILLS_PREFIX = '.trae/skills/';

/**
 * 裸路径引用提取口径（两族同判据）：首字符排除 `/` `.`，防跨段吞并；docs 族字符类含 CJK（文档名多为中文）。
 *
 * 右边界 `(?![A-Za-z0-9_./-])`：`.mdx` / `.md5` 这类更长扩展名不得被抽出半截 `.md`（见头注释「三条限定」2）。
 * 左边界不写在正则里——它需要**向左看**才知道是不是更长路径的尾段，由 `tokenStart()` 判（限定 1）。
 */
const REF_SOURCES: readonly string[] = [
  String.raw`\.trae\/rules\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md`,
  String.raw`docs\/[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿./-]*\.md`,
];
const RIGHT_BOUNDARY = String.raw`(?![A-Za-z0-9_./-])`;
const REF_RES: readonly RegExp[] = REF_SOURCES.map((s) => new RegExp(s + RIGHT_BOUNDARY, 'g'));
/** 非全局同源探针（判「某段文本里是否含本族引用」，用于统计被剥掉的链接目标规模） */
const REF_PROBES: readonly RegExp[] = REF_SOURCES.map((s) => new RegExp(s + RIGHT_BOUNDARY));

/** 路径字符（**只取 ASCII**）：用于把匹配向左扩张成完整 token —— 刻意不含 CJK，否则会吞掉紧邻的中文散文 */
const PATH_CHAR = /[A-Za-z0-9_./-]/;

/**
 * markdown 链接目标（`](…)`）：归 `docs:links` 判（其基 = 源文件目录），本门剥掉不判。
 * 非贪婪 + 不跨 `)`，与 check-publish-links 的 `LINK_RE` 同口径（两门对「链接」的边界必须一致）。
 */
const LINK_TARGET_RE = /\]\([^)]*\)/g;

/** 代码围栏行（``` 或 ~~~ 开头）：围栏内是示例代码，md 中跳过 */
const FENCE_RE = /^\s*(```|~~~)/;

/** 代码文件的注释行形态：`//` 行注释、`/*`/`*` 块注释、`#`（yml） */
const CODE_COMMENT_PREFIX = /^\s*(\/\/|\/\*|\*|#)/;

/** 行内注释分隔（前后空格的 `//`，避开 URL 的 `://` 与字符串里的 `//`） */
const INLINE_COMMENT = ' // ';

/**
 * 引用语义边界：**文档引用在代码里只会写在注释里**。
 * 字符串 / 参数位置的 `docs/…` 是运行时路径数据（测试 fixture 的 `docs/a.md`）或示例文本
 * （工具参数 description 的「如 docs/architecture.md」），不是引用——按存在性判它们是判据
 * 取了与语义无关的表面特征。md 全篇是散文（裸路径即引用形态），不适用本边界。
 */
function commentText(line: string, fromRel: string): string {
  if (fromRel.endsWith('.md')) return line;
  const trimmed = line.trimStart();
  if (CODE_COMMENT_PREFIX.test(trimmed)) return line;
  const idx = line.indexOf(INLINE_COMMENT);
  return idx >= 0 ? line.slice(idx) : '';
}

/** 引用判定三种结果：skip = 判据边界外；missing = 目标不存在（真问题）；ok = 解析成功 */
type Verdict = 'skip' | 'missing' | 'ok';

/**
 * 判据面统计（可观测性：把「不覆盖」显式报数，避免静默缩水）
 *
 * - judged：真正参与存在性判定的引用条数
 * - tailSkip：因是更长路径尾段而 skip 的条数（限定 1；即「嵌套路径不在本门判据面」的规模）
 * - linkSkip：因位于 `](…)` 链接目标内而被剥掉的条数（限定 3；这部分由 docs:links 承担）
 */
const stats = { judged: 0, tailSkip: 0, linkSkip: 0 };

/** 复位统计（自检会调用 scanLine，不能把样例计入正式扫描的账） */
function resetStats(): void {
  stats.judged = 0;
  stats.tailSkip = 0;
  stats.linkSkip = 0;
}

/**
 * 剥离 markdown 链接目标（等长空格替换，保持列偏移）
 *
 * 为什么剥：链接的基是「源文件目录」（docs:links 判据），裸路径的基是「仓库根」（本门判据）。
 * 同一文本被两门用不同基各判一次 ⇒ 假阳（相对链接被当根相对判死）或假 OK（链接失效但根下
 * 恰有同名）。按书写形态分工后，一门只有一种基（见头注释「三条限定」3）。
 */
function stripLinkTargets(text: string): string {
  return text.replace(LINK_TARGET_RE, (m) => ' '.repeat(m.length));
}

/**
 * 完整 token 起点：自匹配位置向左扩张到第一个非路径字符
 *
 * 判据对象必须是「路径」而不是「子串」：`hosts/x/docs/y.md` 若只从 `docs/` 处匹配，
 * 截出的 `docs/y.md` 按仓库根解析恒 missing（假阳）；反向更险——根下恰有同名文件时，
 * 真正的断链会被尾段救活（漏报）。两病同根，故在提取环节一次性消除。
 */
function tokenStart(text: string, at: number): number {
  let s = at;
  while (s > 0 && PATH_CHAR.test(text[s - 1] ?? '')) s -= 1;
  return s;
}

/**
 * 单条引用的判定
 * @param raw 匹配到的裸路径（仓库根相对，形如 `.trae/rules/generic/x.md`）
 * @param fromRel 引用所在源文件的仓库根相对路径（决定是否落在技能手册边界外）
 */
function classify(raw: string, fromRel: string): Verdict {
  // 技能手册引用的是目标项目待生成文件，在 memora 仓库内本就不该存在 → 跳过判定
  if (fromRel.startsWith(SKILLS_PREFIX)) return 'skip';
  return existsSync(join(ROOT, raw)) ? 'ok' : 'missing';
}

/**
 * 扫描一行：提取裸路径引用并逐条判定。
 * 主扫描与自检**共用本函数**，杜绝「自检通过但判据已瞎」。
 */
function scanLine(line: string, fromRel: string): Array<{ raw: string; verdict: Verdict }> {
  const out: Array<{ raw: string; verdict: Verdict }> = [];
  // 代码文件只扫注释片段（引用语义边界，见 commentText）；md 全篇
  const comment = commentText(line, fromRel);
  if (!comment) return out;
  // 链接目标先计数再剥离：剥离后它不再产生命中，但规模要报出来（判据面缩水必须可见）
  for (const m of comment.matchAll(LINK_TARGET_RE)) {
    const target = m[0];
    if (REF_PROBES.some((probe) => probe.test(target))) stats.linkSkip += 1;
  }
  const text = stripLinkTargets(comment);
  for (const refRe of REF_RES) {
    refRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(text)) !== null) {
      const raw = m[0] ?? '';
      // 限定 1：匹配点是更长路径的尾段 ⇒ 不在本门判据面（否则截尾按根解析 = 假阳 + 漏报）
      if (tokenStart(text, m.index) !== m.index) {
        stats.tailSkip += 1;
        out.push({ raw, verdict: 'skip' });
        continue;
      }
      stats.judged += 1;
      out.push({ raw, verdict: classify(raw, fromRel) });
    }
  }
  return out;
}

/**
 * 闸门自检样例：判据失明时「0 命中」是假绿，故先证明闸门还看得见。
 * 每条按「命中数」断言（不只是首条判定），否则跳过逻辑失效可能碰巧凑出同样结果。
 */
const SELF_TEST: ReadonlyArray<{
  line: string;
  from: string;
  /** 期望的 missing 命中数 */
  missing: number;
  /** 期望的 skip 命中数（默认 0） */
  skip?: number;
}> = [
  // [A] 目标不存在 → 命中 1（证明正则在提取，未失明）
  { from: 'docs/__x__.md', line: '见 `.trae/rules/__self_test_no_such__.md`。', missing: 1 },
  // [B] 目标存在 → 命中 0（反向护栏：正则过宽会连正常引用一起判死）
  { from: 'docs/__x__.md', line: '见 `.trae/rules/project-rules.md`。', missing: 0 },
  // [C] 技能手册 → missing 0 且 skip 1（证明技能边界排除生效，未写反）
  {
    from: '.trae/skills/big-tree-grower/references/__x__.md',
    line: '加载 `.trae/rules/architecture-quickref.md`。',
    missing: 0,
    skip: 1,
  },
  // [D] docs 族：注释里目标不存在 → 命中 1（证明第二族提取在工作，未失明）
  { from: 'src/__x__.ts', line: '// 论证见 docs/__self_test_no_such__.md §6.2。', missing: 1 },
  // [E] docs 族：注释里真实目标 → 命中 0（反向护栏：正则过宽会连正常引用一起判死）
  { from: 'src/__x__.ts', line: ' * 设计依据：docs/architecture/role-pack-spec.md。', missing: 0 },
  // [F] docs 族：占位/通配/拆分写法不得误抓（`<文档名>` 断首字符、`*` 使结尾不成 .md、`docs/` 下的 `x.md` 拆分形态）
  {
    from: 'docs/__x__.md',
    line: '格式：`docs/<文档名>-探索方案.md`、`docs/方案-*.md`，或 `docs/` 下的 `x.md`。',
    missing: 0,
  },
  // [G] 引用语义边界：代码里字符串/参数位置的 docs/… 是数据或示例，不是引用 → 命中 0
  { from: 'src/__x__.ts', line: "  const p = 'docs/a.md'; // fixture 路径数据", missing: 0 },
  // [H] 引用语义边界反向：行内注释里的引用仍须抓到 → 命中 1
  {
    from: 'src/__x__.ts',
    line: '  const x = 1; // 见 docs/__self_test_no_such__.md。',
    missing: 1,
  },
  // [I] 左边界：嵌套路径的尾段不是本门判据面 → skip 1 / missing 0
  //     （修前：被截出 docs/mcp-setup.md 再按仓库根解析 ⇒ missing 1 = 假阳）
  {
    from: 'docs/__x__.md',
    line: '见 hosts/memora-vscode/docs/mcp-setup.md 末。',
    missing: 0,
    skip: 1,
  },
  // [J] 链接目标归 docs:links（基 = 源文件目录）→ missing 0
  //     （修前：按仓库根判死 = 假阳，且与 docs:links 重复判同一条文本）
  { from: 'hosts/__x__/README.md', line: '详见 [MCP 接入](docs/__no_such__.md)。', missing: 0 },
  // [K] 反向护栏：补边界 + 剥链接不得连「裸路径真断链」一起放过 → missing 1
  { from: 'hosts/__x__/README.md', line: '详见 `docs/__self_test_no_such__.md`。', missing: 1 },
  // [L] 右边界：`.mdx` 不属本族 → missing 0（修前抽出 __self_test_no_such__.md 判死 = 假阳）
  { from: 'docs/__x__.md', line: '详见 `docs/__self_test_no_such__.mdx`。', missing: 0 },
];

/** 跑自检；任一失败即报错。返回是否全过 */
function runSelfTest(): boolean {
  let ok = 0;
  for (const c of SELF_TEST) {
    const hits = scanLine(c.line, c.from);
    const missing = hits.filter((h) => h.verdict === 'missing').length;
    const skip = hits.filter((h) => h.verdict === 'skip').length;
    const pass = missing === c.missing && skip === (c.skip ?? 0);
    if (pass) ok += 1;
    else
      console.error(
        `  自检失败: 「${c.line}」@${c.from} 期望 missing=${c.missing}/skip=${c.skip ?? 0}，实得 missing=${missing}/skip=${skip}`,
      );
  }
  console.log(`闸门自检: ${ok}/${SELF_TEST.length} 样例符合预期`);
  return ok === SELF_TEST.length;
}

if (!runSelfTest()) {
  console.error('\n闸门自检未通过：判据可能已失明，此时「0 命中」不可信。');
  process.exit(2);
}
// 自检也走 scanLine（同源），其计数不属于正式扫描的账
resetStats();

/** 收集待扫文本文件（递归；跳过 SKIP_DIRS 与本脚本自身） */
function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(abs, out);
      continue;
    }
    if (!TEXT_EXTS.some((e) => name.endsWith(e))) continue;
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (rel === SELF_REL) continue; // 自身排除：防样例文本给自己的旧路径续命
    out.push(rel);
  }
}

const files: string[] = [];
collect(ROOT, files);
files.sort();

/** 命中记录：源文件 + 行号 + 引用原文 */
interface Finding {
  file: string;
  line: number;
  raw: string;
}

const findings: Finding[] = [];

for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
  // md 才跳围栏：代码文件没有 ``` 围栏语义
  const skipFence = rel.endsWith('.md');
  let inFence = false;
  lines.forEach((line, i) => {
    if (skipFence && FENCE_RE.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    for (const hit of scanLine(line, rel)) {
      if (hit.verdict === 'missing') findings.push({ file: rel, line: i + 1, raw: hit.raw });
    }
  });
}

console.log(
  `裸路径引用检查（.trae/rules + docs 两族） · 文本文件 ${files.length} 个（排除 .trae/skills 与本脚本）`,
);

/** 判据面统计行：把「哪些没被判、为什么」显式报出来（判据面缩水必须可见，不靠读代码猜） */
function printScope(): void {
  console.log(
    `判据面：判定 ${stats.judged} 条｜尾段跳过 ${stats.tailSkip} 条（嵌套路径，非 docs//.trae/rules 前缀）` +
      `｜链接目标跳过 ${stats.linkSkip} 条（归 docs:links，按源文件目录解析）`,
  );
}

if (findings.length) {
  console.log(`\n[A] 引用目标不存在（参考腐烂）: ${findings.length}`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}`);
  printScope();
  console.log(
    '\n修法纪律：默认**不开豁免**。\n' +
      '  · 目标确实该存在 → 改正引用路径（如补 `generic/`）；\n' +
      '  · 目标确实不该存在 → 删除该引用或改写为散文。',
  );
  process.exit(1);
}
printScope();
console.log('\nOK：规则裸路径引用全部可解析。');
