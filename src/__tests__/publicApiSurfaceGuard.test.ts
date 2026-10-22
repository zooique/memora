/**
 * 公共 API 面登记门槛守卫（PUBLIC-API-SURFACE-1）。
 *
 * 机器化 b69f85ff 收敛定案的两条判据（「宿主真实消费」/「README / API 手册 §十六 明文承诺」），
 * 双向对账防两族复发：
 *  - 向 A（防未登记公开）：index.ts 公开面 ⊆ 宿主消费面 ∪ 承诺面 —— 新增公共导出必须先过
 *    「①宿主/脚本真实 import」或「②README / docs/memora-api-reference.md §十六 明文承诺」其一；
 *    纯内部实现不挂公共面。桶导出时代「顺手 export 即公开」的零筛选默认态由此关门。
 *  - 向 B（防幻觉文档）：手册 §十六 承诺的符号必须在 src 源码中真实存在 —— 拦截「文档虚构 API」
 *    （历史事故：API 手册 5 处幻觉引用，src 无对应导出）。
 *  - 向 D（防自消费悬空）：src 内部经公开入口（`@/index.js` / `@zooique/memora`）的 import 符号必须
 *    仍在公开面 —— 堵「删公开导出后 src 内部（尤其 __tests__）import 悬空而守卫照绿」的盲区。
 *    结构成因：向 A 只迭代「现存公开面」符号，被删符号不再被其检查。实锤先例（2026-10-17 收面
 *    12 项）：`src/llm/__tests__/llmIntegration.test.ts` 曾 import 被删的 `createLlmProvider`（仅 tsc 兜住）。
 * 判据与参照系说明：手册 §十六 现为纯模块级类型/函数清单，与 index.ts 导出面同构——
 * B 向历史判据（只验「src 存在性」）保留，另以 C 向补「承诺 ⊆ 公开面」对账（防「src 有但
 * 未导出」——消费者按文档具名 import 会得到 undefined）。
 * 验收标准不是变绿而是能红：变异验证为提交前一次性动作（加假导出 / 加幻觉符号 /
 * 承诺改词 / 断言反转均须变红），产物在提交记录，不驻留本文件。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 仓库根：本文件位于 src/__tests__/，向上两级 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 包入口真源：公开面的唯一定义处 */
const INDEX_TS = join(ROOT, 'src', 'index.ts');
/** 承诺面文档：README 全文 + API 手册（B 向只取手册 §十六 区间） */
const README = join(ROOT, 'README.md');
const API_MANUAL = join(ROOT, 'docs', 'memora-api-reference.md');
/** 消费面扫描根：宿主（含构建脚本与测试）+ 验证脚本目录（当前零消费，纳入防未来漏扫） */
const CONSUMER_ROOTS = [join(ROOT, 'hosts'), join(ROOT, 'scripts')];
/** 目录排除清单：产物与依赖不进扫描面 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.workbuddy',
  '.git',
  '__tests__',
]);

/** 递归收集目录下全部 .ts/.mts/.mjs 文件（排除产物目录），扫描面自动发现、不硬编码文件清单 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (EXCLUDED_DIRS.has(name)) continue;
    // 目录则深入，文件按扩展名收集
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (
      /\.(ts|mts|mjs)$/.test(name) &&
      // 排除测试文件：SRC_TEXT 是「生产源码存在性」参照系，测试文件既非承诺面，
      // 其自身字符串/注释（如本文件第 346 行的锚点文案）还会污染 indexOf 定位。
      !/\.(test|spec)\.(ts|mts|mjs)$/.test(name)
    ) {
      out.push(full);
    }
  }
  return out;
}

/** 用 TS 编译器 API 解析单文件 AST（正则解析在「多行 import 子句 / as 别名」上必埋坑，弃用） */
function parseAst(full: string, text: string): ts.SourceFile {
  const kind = full.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(full, text, ts.ScriptTarget.ES2022, true, kind);
}

/**
 * 公开面：src/index.ts 全部导出符号名。
 * `export { defaultTitle as defaultSessionTitle }` 取 as 之后的公开名（消费者可见的名字）。
 */
function parsePublicSurface(): Set<string> {
  const sf = parseAst(INDEX_TS, readFileSync(INDEX_TS, 'utf8'));
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause) continue;
    if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * 消费面：宿主 + 脚本经 `from '@zooique/memora'` 实际 import 的符号。
 * `import { X as Y }` 消费的是内核符号 X（as 前的原名）；namespace import 无法枚举符号，
 * 记入告警表由用例断言为空（出现时人工定性：改具名 import 或扩充豁免）。
 */
function parseConsumerSurface(): { symbols: Set<string>; namespaceImports: string[] } {
  const symbols = new Set<string>();
  const namespaceImports: string[] = [];
  for (const root of CONSUMER_ROOTS) {
    for (const full of listSourceFiles(root)) {
      const sf = parseAst(full, readFileSync(full, 'utf8'));
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        if ((st.moduleSpecifier as ts.StringLiteral).text !== '@zooique/memora') continue;
        const clause = st.importClause;
        if (!clause?.namedBindings) {
          if (clause) namespaceImports.push(full);
          continue;
        }
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            symbols.add((el.propertyName ?? el.name).text);
          }
        } else {
          namespaceImports.push(full);
        }
      }
    }
  }
  return { symbols, namespaceImports };
}

/**
 * 自消费面：`src/` 内部（排除 index.ts 自身）经**公开入口** import 的符号。
 *
 * 公开入口 = 解析到 `src/index.ts` 的模块说明符（`@/index.js` 别名 / `@zooique/memora` 包名 /
 * 指向该文件的相对路径）。这些是「仓库内、非宿主」的消费者：**不计入向 A 的登记面**
 * （登记只认外部消费者），但其**引用必须有效**——删公开导出而此处仍 import 即悬空。
 *
 * 结构盲区成因：向 A 只迭代「现存公开面」符号，被删符号不再被其检查 ⇒ 结构上照绿
 * （此前仅 `tsc --noEmit` 兜底）。本向 D 补此盲区。
 *
 * @returns filesBySymbol（符号 → 导入它的源文件列表）+ scannedFiles（扫描文件数，供失明自检）
 */
function parseSelfConsumptionSurface(): {
  filesBySymbol: Map<string, string[]>;
  scannedFiles: number;
} {
  const filesBySymbol = new Map<string, string[]>();
  /** 说明符 → 目标文件：包名 / @ 别名 / 相对路径三种解析（统一归一为 .ts 路径） */
  const resolveSpecifier = (spec: string, fromFile: string): string => {
    if (spec === '@zooique/memora') return INDEX_TS;
    if (spec.startsWith('@/')) return join(ROOT, 'src', spec.slice(2).replace(/\.js$/, '.ts'));
    if (spec.startsWith('.')) return join(dirname(fromFile), spec).replace(/\.js$/, '.ts');
    return spec;
  };
  let scannedFiles = 0;
  for (const full of listSourceFiles(join(ROOT, 'src'))) {
    if (full === INDEX_TS) continue; // index.ts 是公开面真源本身，非自消费方
    scannedFiles++;
    const sf = parseAst(full, readFileSync(full, 'utf8'));
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      if (resolveSpecifier((st.moduleSpecifier as ts.StringLiteral).text, full) !== INDEX_TS)
        continue;
      const bindings = st.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue; // namespace import 无法枚举，略过
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        const arr = filesBySymbol.get(name);
        if (arr) arr.push(full);
        else filesBySymbol.set(name, [full]);
      }
    }
  }
  return { filesBySymbol, scannedFiles };
}

/**
 * 从文本的 backtick 片段中提取标识符形态的候选符号。
 * `agent.chat(input)` 这类带点成员访问会产出 agent / chat 两个 token——A 向不受影响
 * （对账方向是公开面出发，多余 token 只放大承诺面不漏报）；B 向靠「src 存在性」过滤。
 */
function extractIdentifierTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/`([^`]*)`/g)) {
    const seg = m[1];
    if (!seg) continue;
    for (const t of seg.matchAll(/[$A-Za-z_][$\w]*/g)) {
      if (t[0]) tokens.add(t[0]);
    }
  }
  return tokens;
}

/** 手册 §十六 区间切片：'## 十六、' 起，'## 十七、' 止（b69f85ff 判据②的「明文承诺」区间） */
function sliceManualSectionSixteen(manual: string): string {
  const start = manual.indexOf('## 十六、');
  const end = manual.indexOf('## 十七、');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('手册 §十六/§十七 标题未找到——章节改名时须同步本守卫的区间标记');
  }
  return manual.slice(start, end);
}

/**
 * 手册 §十二 区间切片（2026-10-16 补盲区）：'## 十二、' 起，'## 十三、' 止——「完整 API 一览」
 * 承诺了 Agent 面全部方法名，却在 §十六 之外 = 原 B 向盲区（实锤：`processEvent(event)`
 * 幻觉行存活至 5.0.0 发版前审查才被人工发现）。与 §十六 同型 B 向对账：承诺符号必须在 src 存在。
 */
function sliceManualSectionTwelve(manual: string): string {
  const start = manual.indexOf('## 十二、');
  const end = manual.indexOf('## 十三、');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('手册 §十二/§十三 标题未找到——章节改名时须同步本守卫的区间标记');
  }
  return manual.slice(start, end);
}

/** src 全源码文本拼接（B 向存在性参照系） */
const SRC_TEXT = listSourceFiles(join(ROOT, 'src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** 标识符是否在 src 源码中真实存在（词边界精确匹配） */
function existsInSrc(token: string): boolean {
  return new RegExp(`(?<![\\w$])${token.replace(/[$]/g, '\\$')}(?![\\w$])`).test(SRC_TEXT);
}

const publicSurface = parsePublicSurface();
const { symbols: consumerSurface, namespaceImports } = parseConsumerSurface();
const { filesBySymbol: selfConsumption, scannedFiles: selfScannedFiles } =
  parseSelfConsumptionSurface();
const readmeText = readFileSync(README, 'utf8');
const manualText = readFileSync(API_MANUAL, 'utf8');
const manualSection = sliceManualSectionSixteen(manualText);
const promisedSurface = new Set([
  ...extractIdentifierTokens(readmeText),
  ...extractIdentifierTokens(manualSection),
]);
const manualTokens = extractIdentifierTokens(manualSection);
/** §十二 token（B-12 向对账用） */
const manualTwelveTokens = extractIdentifierTokens(sliceManualSectionTwelve(manualText));

/**
 * §十六 非「具名导出承诺」的 token 豁免名单（C 向对账用，冻结自 2026-10-08 差集实测）。
 *
 * 两类分账：
 *  - import 示例噪声（9）：§十六 示例代码 `import { … } from '@zooique/memora'` 被
 *    token 化的残留词——非 API 承诺；
 *  - 类型/叙述词（4）：`DedupReport` / `SourceHealthReport` 为事件载荷 `interface`
 *    （模块内导出、不经桶导出——消费者经回调签名结构推导可用，不占具名导出）；
 *    `LLM` / `IDE` 为叙述用缩写词，非符号；
 *  - 枚举成员/属性引用（1）：`NOT_AVAILABLE` 是 `ToolErrorCode` 对象的成员（属性），
 *    非模块级导出——消费者按 `ToolErrorCode.NOT_AVAILABLE` 访问，不占具名导出。
 *
 * ⚠️ 名单是**冻结的封闭集**：§十六 新增承诺符号若未进公开面，C 向即红——
 * 此时先补导出（真承诺），或确认属本名单同族后带分账理由加入。
 */
const SECTION_SIXTEEN_NON_EXPORT_TOKENS: ReadonlySet<string> = new Set([
  // import 示例噪声
  'export',
  'from',
  'index',
  'memora',
  'src',
  'ts',
  'type',
  'typescript',
  'zooique',
  // 类型（结构推导可用）/ 叙述词
  'DedupReport',
  'SourceHealthReport',
  'LLM',
  'IDE',
  // 枚举成员（属性引用，非模块级导出）
  'NOT_AVAILABLE',
]);

/**
 * §十二 非 API 叙述词豁免（B-12 向对账用）。
 *
 * §十二「完整 API 一览」line 1048 有一处守卫名交叉引用：`PUBLIC-API-SURFACE-1`。
 * `extractIdentifierTokens` 按 `-` 拆出 `PUBLIC` / `SURFACE` 片段，它们是守卫名碎片、
 * 不是 API 方法名，不应被当成幻觉符号。与 §十六 `SECTION_SIXTEEN_NON_EXPORT_TOKENS` 同理：
 * 叙事词不是承诺。`API` 因在 src 真实存在已自然通过，`1` 非标识符不被 token 化，故仅豁免此二者。
 */
const SECTION_TWELVE_NON_API_TOKENS: ReadonlySet<string> = new Set(['PUBLIC', 'SURFACE']);

describe('公共 API 面登记门槛守卫（PUBLIC-API-SURFACE-1）', () => {
  it('扫描面自检：公开面 / 消费面 / 自消费面均非空（防守卫失明假绿）', () => {
    expect(publicSurface.size).toBeGreaterThan(50);
    expect(consumerSurface.size).toBeGreaterThan(10);
    expect(selfScannedFiles).toBeGreaterThan(50); // src 源文件被扫到，防扫错根目录
  });

  it('namespace import 当前为零（无法枚举符号，出现即须人工定性）', () => {
    expect(namespaceImports).toEqual([]);
  });

  it('向 A：公开面全部有登记（宿主/脚本真实消费 或 README/手册§十六 承诺）', () => {
    const unregistered = [...publicSurface].filter(
      (s) => !consumerSurface.has(s) && !promisedSurface.has(s),
    );
    // 红时输出修法指引，而非裸断言失败
    const hint =
      `挂公共面须满足其一：①宿主/脚本经 '@zooique/memora' 真实 import；\n` +
      `②README / docs/memora-api-reference.md §十六 明文承诺（写清签名与稳定性语义）。\n` +
      `纯内部实现请移出 src/index.ts（类型随签名推导仍可用）。`;
    expect(
      unregistered,
      `\n发现 ${unregistered.length} 个未登记公共导出：\n${unregistered.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 B：手册 §十六 承诺符号在 src 源码中真实存在（防幻觉文档）', () => {
    const phantom = [...manualTokens].filter(
      (t) => !existsInSrc(t) && !SECTION_SIXTEEN_NON_EXPORT_TOKENS.has(t),
    );
    const hint =
      `docs/memora-api-reference.md §十六 引用了 src 中不存在的符号——\n` +
      `文档虚构 API 比漏文档更伤消费者（历史事故 5 处）。删除该引用，或核实符号正确拼写。`;
    expect(
      phantom,
      `\n手册 §十六 幻觉符号：\n${phantom.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 B-12：手册 §十二 完整 API 一览的承诺符号在 src 真实存在（堵原盲区）', () => {
    const phantom = [...manualTwelveTokens].filter(
      (t) => !existsInSrc(t) && !SECTION_TWELVE_NON_API_TOKENS.has(t),
    );
    const hint =
      `docs/memora-api-reference.md §十二 引用了 src 中不存在的符号——\n` +
      `与 §十六 同型幻觉（实锤先例：processEvent(event) 行 2026-10-16 删除）。\n` +
      `修法：删除该引用，或核实符号正确拼写。`;
    expect(
      phantom,
      `\n手册 §十二 幻觉符号：\n${phantom.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 C：手册 §十六 承诺的模块级符号必须在公开面（防「文档承诺但未导出」）', () => {
    const unexported = [...manualTokens]
      .filter((t) => !SECTION_SIXTEEN_NON_EXPORT_TOKENS.has(t))
      .filter((t) => !publicSurface.has(t));
    const hint =
      `§十六 承诺的符号未出现在 src/index.ts 导出面——消费者按文档具名 import 会得到 undefined。\n` +
      `修法：① 真承诺 → index.ts 补导出；② 类型/叙述词 → 登记进 SECTION_SIXTEEN_NON_EXPORT_TOKENS（带分账理由）。`;
    expect(
      unexported,
      `\n§十六 承诺但未导出的符号：\n${unexported.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 D：src 内部经公开入口的导入符号必须在公开面（堵 __tests__ 自消费盲区）', () => {
    const dangling = [...selfConsumption.keys()].filter((s) => !publicSurface.has(s));
    const located = [...selfConsumption.entries()]
      .map(([s, files]) => `  - ${s} ← ${files.join(' / ')}`)
      .join('\n');
    const hint =
      `src 内部经公开入口（@/index.js / @zooique/memora）import 的符号必须仍在 src/index.ts 公开面。\n` +
      `悬空 = 某次收面删了导出、但此处 import 未同步（向 A 只看现存符号，删掉的不再被它检查 ⇒ 照绿）。\n` +
      `修法：① 改深路径 import（内部代码走 @/<模块>.js，不经公开面）；② 或恢复该导出（真外部承诺）。\n` +
      `当前自消费清单（供定位，非异常）：\n${located}`;
    expect(
      dangling,
      `\n自消费悬空 ${dangling.length} 项：\n${dangling.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 B-21：手册 §2.1 AgentOptions 表字段与接口成员双向对账（防「字段有·文档无」+ 幻觉行）', () => {
    // 切 §2.1 区间（'### 2.1' 起，'### 2.2' 止）；表行第一列 `字段`（~~删除线~~ 行也抓，豁免另行处理）
    const start = manualText.indexOf('### 2.1');
    const end = manualText.indexOf('### 2.2');
    if (start < 0 || end < 0 || end <= start) {
      throw new Error('手册 §2.1/§2.2 标题未找到——章节改名时须同步本守卫');
    }
    const tableFields = new Set<string>();
    for (const m of manualText.slice(start, end).matchAll(/^\|\s*(?:~~)?`([A-Za-z_]\w*)`/gm)) {
      const f = m[1];
      if (f) tableFields.add(f);
    }
    // 定位 src 中 interface AgentOptions 体，取顶层成员（缩进 2 空格的 `name?:` / `name:`）
    const declIdx = SRC_TEXT.indexOf('interface AgentOptions');
    expect(declIdx, 'src 中未找到 interface AgentOptions').toBeGreaterThan(-1);
    let brace = 0;
    let bodyEnd = declIdx;
    for (let i = SRC_TEXT.indexOf('{', declIdx); i < SRC_TEXT.length; i++) {
      if (SRC_TEXT[i] === '{') brace++;
      else if (SRC_TEXT[i] === '}') {
        brace--;
        if (brace === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const ifaceMembers = new Set<string>();
    for (const m of SRC_TEXT.slice(declIdx, bodyEnd).matchAll(/^\s{2}([A-Za-z_]\w*)\??:/gm)) {
      const f = m[1];
      if (f) ifaceMembers.add(f);
    }
    // 双向差集：表有接口无 = 幻觉/已删未标（删除线历史行豁免）；接口有表无 = 新字段未补文档
    const DELETED_FIELDS = new Set(['vectorStore', 'recallExcludeSources']); // 删除线历史行，合法
    const phantom = [...tableFields].filter((f) => !ifaceMembers.has(f) && !DELETED_FIELDS.has(f));
    const undocumented = [...ifaceMembers].filter((f) => !tableFields.has(f));
    const hint =
      `§2.1 表与 AgentOptions 接口不对账——消费者按表配构造项会拿到不存在/未记载的字段。\n` +
      `修法：幻觉行删表行；新字段补表行（说明抄接口 JSDoc 要点）；新删除字段用 ~~删除线~~ 行留痕。\n` +
      `实锤先例（2026-10-16）：9 个 4.0.0 后新增字段零文档，本轮补齐。`;
    expect(
      phantom,
      `\n§2.1 表有·接口无（幻觉/未标删除）：\n${phantom.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
    expect(
      undocumented,
      `\n接口有·§2.1 表无（承诺缺失）：\n${undocumented.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });

  it('向 B-27：手册 §2.7 事件表与 AgentEventMap 双向对账（事件名 + 载荷字段）', () => {
    const start = manualText.indexOf('### 2.7');
    const end = manualText.indexOf('## 三、');
    if (start < 0 || end < 0 || end <= start) {
      throw new Error('手册 §2.7/§三 标题未找到——章节改名时须同步本守卫');
    }
    const sec = manualText.slice(start, end);
    // 表行：| `事件名` | `{ 载荷 }` | 触发时机 |
    const rows = [...sec.matchAll(/^\|\s*`([A-Za-z_]\w*)`\s*\|\s*([^|]*)\|/gm)]
      .map((r) => ({ name: r[1] ?? '', cell: r[2] ?? '' }))
      .filter((r) => r.name);
    const tableEvents = new Set(rows.map((r) => r.name));

    // AgentEventMap 接口体（eventEmitter.ts）：顶层成员 = 事件名
    const emitterPath = join(ROOT, 'src', 'utils', 'eventEmitter.ts');
    const emitterText = readFileSync(emitterPath, 'utf8');
    const declIdx = emitterText.indexOf('interface AgentEventMap');
    expect(declIdx, 'eventEmitter.ts 中未找到 interface AgentEventMap').toBeGreaterThan(-1);
    let brace = 0;
    let bodyEnd = declIdx;
    for (let i = emitterText.indexOf('{', declIdx); i < emitterText.length; i++) {
      if (emitterText[i] === '{') brace++;
      else if (emitterText[i] === '}') {
        brace--;
        if (brace === 0) {
          bodyEnd = i;
          break;
        }
      }
    }
    const ifaceBody = emitterText.slice(declIdx, bodyEnd);
    const mapEvents = new Set<string>();
    const eventSlices = new Map<string, string>();
    // 顶层键位置切片：键起点 → 下一个顶层键起点（供载荷字段定位）
    const keyMatches = [...ifaceBody.matchAll(/^\s{2}([A-Za-z_]\w*):/gm)];
    for (let i = 0; i < keyMatches.length; i++) {
      const cur = keyMatches[i];
      if (!cur) continue;
      const name = cur[1];
      if (!name || mapEvents.has(name)) continue; // 顶层嵌套误抓（缩进恰为 2 的子键）按首现为准
      mapEvents.add(name);
      const from = cur.index ?? 0;
      const to = keyMatches[i + 1]?.index ?? ifaceBody.length;
      eventSlices.set(name, ifaceBody.slice(from, to));
    }

    const phantom = [...tableEvents].filter((t) => !mapEvents.has(t));
    const missing = [...mapEvents].filter((t) => !tableEvents.has(t));

    // 载荷字段对账：表行第二列 `{ a, b: T, c?: T }` 的字段名须在该事件的 Map 切片内
    const badPayload: string[] = [];
    for (const r of rows) {
      const { name, cell } = r;
      if (!mapEvents.has(name)) continue;
      const slice = eventSlices.get(name) ?? '';
      const obj = cell.match(/\{([^}]*)\}/);
      if (!obj?.[1]) continue; // 纯类型单元格（如 AskQuestion[]）不在此对账
      for (const part of obj[1].split(',')) {
        const raw = part.split(':')[0] ?? '';
        const field = raw.replace(/[?{}\s]/g, '');
        if (!field) continue;
        if (/[|\[\]]/.test(field)) continue; // 无字段名的类型片段
        // 字段名须在该事件载荷定义内以 `field?:` / `field:` 出现
        if (!new RegExp(`(?<!\\w)${field}\\s*[?:]`).test(slice)) {
          badPayload.push(`${name}.${field}`);
        }
      }
    }

    const hint =
      `手册 §2.7 事件表与 AgentEventMap 不对账——宿主按表订阅/解构会拿到 undefined。\n` +
      `修法：删幻觉事件行 / 补缺失事件行 / 按 AgentEventMap 订正载荷字段名。\n` +
      `实锤先例（2026-10-16）：personaSwitched（改名后残留）/ skillMatched（能力已删）/ ` +
      `sessionForked.messageCount（实际 roundCount）/ archiveFailed.stage 'content'（实际 'session'）。`;
    expect(
      phantom,
      `\n表有·Map 无（幻觉事件）：\n${phantom.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
    expect(
      missing,
      `\nMap 有·表无（承诺缺失）：\n${missing.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
    expect(
      badPayload,
      `\n载荷字段与 AgentEventMap 不符：\n${badPayload.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });
});
