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
 * 判据与参照系说明：手册 §十六 承诺的是 Agent 实例成员与模块级符号的混合叙述，与 index.ts
 * 模块导出面天然不同构，故 B 向不与公开面对账、只验「存在性」（幻觉符号的特征 = src 全库无此标识符）。
 * 验收标准不是变绿而是能红：变异验证见文件尾（加假导出 / 加幻觉符号 / 断言反转均须变红）。
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
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'out', 'coverage', '.workbuddy', '.git']);

/** 递归收集目录下全部 .ts/.mts/.mjs 文件（排除产物目录），扫描面自动发现、不硬编码文件清单 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (EXCLUDED_DIRS.has(name)) continue;
    // 目录则深入，文件按扩展名收集
    if (statSync(full).isDirectory()) {
      listSourceFiles(full, out);
    } else if (/\.(ts|mts|mjs)$/.test(name)) {
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
const readmeText = readFileSync(README, 'utf8');
const manualText = readFileSync(API_MANUAL, 'utf8');
const manualSection = sliceManualSectionSixteen(manualText);
const promisedSurface = new Set([
  ...extractIdentifierTokens(readmeText),
  ...extractIdentifierTokens(manualSection),
]);
const manualTokens = extractIdentifierTokens(manualSection);

describe('公共 API 面登记门槛守卫（PUBLIC-API-SURFACE-1）', () => {
  it('扫描面自检：公开面与消费面均非空（防守卫失明假绿）', () => {
    expect(publicSurface.size).toBeGreaterThan(50);
    expect(consumerSurface.size).toBeGreaterThan(10);
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
    const phantom = [...manualTokens].filter((t) => !existsInSrc(t));
    const hint =
      `docs/memora-api-reference.md §十六 引用了 src 中不存在的符号——\n` +
      `文档虚构 API 比漏文档更伤消费者（历史事故 5 处）。删除该引用，或核实符号正确拼写。`;
    expect(
      phantom,
      `\n手册 §十六 幻觉符号：\n${phantom.map((s) => `  - ${s}`).join('\n')}\n${hint}`,
    ).toEqual([]);
  });
});
