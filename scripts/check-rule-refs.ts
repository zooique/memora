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
 * 两条**刻意排除**（是判据边界，**不是**豁免清单）：
 *   1. 源文件位于 `.trae/skills/**` —— 技能手册是**可移植模板**，其中
 *      `.trae/rules/architecture-quickref.md` / `frontend_architecture_rules.md` 等指向的是
 *      **目标项目**里待生成的文件（big-tree-seeder 会在目标项目生成），在 memora 仓库内本就不该存在。
 *   2. 本脚本自身 —— 否则脚本内作为样例的旧路径文本会给「旧路径基线」续命（同术语门禁的教训：
 *      扫描自身 → 消失检测失效）。
 *
 * 闸门自检（每次运行都跑，不可关闭）：
 *   「0 命中即成功」这类断言若判据本身失明（正则改坏 / 排除逻辑写反），会**静默 exit 0**。
 *   故先对 3 条内置样例跑**同一套判据**（`scanLine`，与主扫描同源，非另写一套），未全过即 exit 2。
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

/** 裸路径引用提取口径（两族同判据）：首字符排除 `/` `.`，防跨段吞并；docs 族字符类含 CJK（文档名多为中文） */
const REF_RES: readonly RegExp[] = [
  /\.trae\/rules\/[A-Za-z0-9_][A-Za-z0-9_./-]*\.md/g,
  /docs\/[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿./-]*\.md/g,
];

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
  const text = commentText(line, fromRel);
  for (const refRe of REF_RES) {
    refRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(text)) !== null) {
      const raw = m[0] ?? '';
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

if (findings.length) {
  console.log(`\n[A] 引用目标不存在（参考腐烂）: ${findings.length}`);
  for (const f of findings) console.log(`  ${f.file}:${f.line}  ->  ${f.raw}`);
  console.log(
    '\n修法纪律：默认**不开豁免**。\n' +
      '  · 目标确实该存在 → 改正引用路径（如补 `generic/`）；\n' +
      '  · 目标确实不该存在 → 删除该引用或改写为散文。',
  );
  process.exit(1);
}
console.log('\nOK：规则裸路径引用全部可解析。');
