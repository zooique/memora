/**
 * 随包接入指南 ↔ 源码一致性守卫（GUIDE-AUDIT-1 的机器化）。
 *
 * 立项：`docs/memora-接入指南.md` 随包发布（在 `package.json#files` 白名单内）且含 20+ 段
 * 可照抄的示例代码，却**不在任何文档守卫射程**——`publicApiSurfaceGuard` 的向 B 只对账
 * README 与 API 手册 §十六/§十二。实锤（2026-10-27 审计）：示例里 `appendMessage` 这个方法
 * **内核全仓零命中**（`ISessionStore` 11 个必需方法只实现了 3 个），消费者照抄必编译失败；
 * 同批还有 `agent.projects` 僵尸引用（该 getter 已随项目层退役删除）。两类伤能长期存活的
 * 唯一原因是「没人机检这份文件」。
 *
 * 三条判据（全部以**源码活取值**为参照，不建冻结表 ⇒ 不存在第二份真源）：
 *  - 向 I（import 面）：代码块里 `from '@zooique/memora'` 的具名符号必须 ⊆ `src/index.ts` 导出面。
 *  - 向 M（成员面）：代码块 + 行内 `` `agent.X` `` 的 X 必须是 `Agent` 的公开成员
 *    （**含 `extends` 链**——`agent.on` / `agent.off` 来自 `TypedEventEmitter`，不解析继承必假红）。
 *  - 向 P（实现完整性 · **条件判**）：代码块**自称「接口全集 / 照抄可编译」**时，`class X implements Y`
 *    必须声明 Y 的**全部必需成员**（`?` 可选的不算）；未自称则**不判**——示例可合法节选，
 *    无条件强判会误伤（这是 GUIDE-AUDIT-1 立项时已写下的判断，此处照办而非推翻）。
 *    条件判的直接对住本次事故：该块明写「以下为接口全集（11 个必需方法，照抄可编译通过）」，
 *    实际只列了 3 个且含内核不存在的 `appendMessage` ⇒ 缺方法与拼错方法名都必须红。
 *
 * 诚实登记的界外（勿默认为已覆盖）：
 *  - 只验**名字存在**，不验签名/参数类型/返回值（示例传错参数不会红）；
 *  - prose 里的**二级**成员（`agent.memory.xxx` 的 xxx）不验——需类型推导，留给 API 手册与
 *    `publicMemberSurfaceGuard` 的可达层；
 *  - `AgentOptions` 字段、事件载荷字段、策略键清单不验（分别在 README 承诺面与手册 §十六）；
 *  - 其他随包文档（API 手册、升级指南、角色包指南）未纳入，本守卫只锁接入指南。
 *
 * 豁免判据（两条，均有真实用例，非臆测）：
 *  ① 行内含**删除态叙述词**（见 `DELETION_MARKERS`）⇒ 整行豁免。「`agent.projects.*` 已于
 *     5.0.0 退役」是**正确的历史留痕**，不是僵尸引用；不豁免就会把正确表述判红。
 *  ② 路径尾巴（`src/agent/agent.ts` 里的 `agent.ts`）不是成员引用 ⇒ 按文件扩展名排除。
 *
 * 自检用例防「因错误的原因通过」：文档路径写错 / 代码块被整体重写导致扫描面归零时，
 * 判据会恒绿 —— 故另设射程下限断言。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** 仓库根：本文件位于 src/__tests__/，向上两级 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 公开面真源 */
const INDEX_TS = join(ROOT, 'src', 'index.ts');
/** 被守卫的随包文档 */
const GUIDE = join(ROOT, 'docs', 'memora-接入指南.md');
/** 包名：只有从这个包 import 的符号才属于本内核的公开面 */
const PACKAGE_NAME = '@zooique/memora';

/**
 * 删除态叙述词典：命中即整行豁免（历史留痕是合法表述）。
 * 词表与文档实际用词对齐——新增词必须先有真实用例，不预先塞同义词。
 */
const DELETION_MARKERS = ['已删除', '已移除', '已退役', '不再存在', '不再提供', '历史留痕', '勿按'];

/**
 * 「完整性承诺」词典：代码块自称全集时才判 `implements` 覆盖度（向 P 的触发条件）。
 * 无承诺 = 允许节选，不判——避免把合法的示意片段判红。
 */
const COMPLETENESS_MARKERS = ['接口全集', '全集', '照抄可编译', '完整实现', '全部必需'];

/** 文件扩展名尾巴：`agent.ts` 这类是路径，不是成员引用 */
const FILE_EXT_TAIL = /^(ts|mts|mjs|js|md|json|css|html)$/;

/** 代码块：语言、围栏起始行（1-based，报错定位用）、块正文、紧邻其上的散文（判断完整性承诺用） */
interface Fence {
  lang: string;
  startLine: number;
  code: string;
  leadText: string;
}

/** 用 TS 编译器 API 解析（正则在「多行 import / as 别名 / 泛型」上必埋坑） */
function parseAst(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** 源文件解析结果缓存：同一文件被多处引用时不重复读盘 */
const AST_CACHE = new Map<string, ts.SourceFile>();
function astOf(file: string): ts.SourceFile {
  let sf = AST_CACHE.get(file);
  if (!sf) {
    sf = parseAst(file, readFileSync(file, 'utf8'));
    AST_CACHE.set(file, sf);
  }
  return sf;
}

/**
 * 导出面：公开名 → 声明位置。
 * `export { defaultTitle as defaultSessionTitle }` 取 `defaultSessionTitle`（消费者可见名）
 * 与 `defaultTitle`（源文件里的真实声明名）。
 * `src/index.ts` 无 `export *`（本守卫立项时实测 0 处）——若将来引入，本解析会漏，故断言。
 */
function parsePublicSurface(): Map<string, { file: string; declName: string }> {
  const sf = astOf(INDEX_TS);
  const surface = new Map<string, { file: string; declName: string }>();
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.exportClause) continue;
    if (!ts.isNamedExports(st.exportClause) || !st.moduleSpecifier) continue;
    const spec = (st.moduleSpecifier as ts.StringLiteral).text;
    const file = spec.startsWith('@/')
      ? join(ROOT, 'src', spec.slice(2).replace(/\.js$/, '.ts'))
      : '';
    for (const el of st.exportClause.elements) {
      surface.set(el.name.text, { file, declName: (el.propertyName ?? el.name).text });
    }
  }
  return surface;
}

/** 栈式遍历找类/接口声明（不用闭包赋值，避免 TS 控制流把它判成恒 null） */
function findTypeDecl(
  sf: ts.SourceFile,
  name: string,
): ts.ClassDeclaration | ts.InterfaceDeclaration | null {
  const stack: ts.Node[] = [sf];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    if (
      (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name?.text === name
    ) {
      return node;
    }
    ts.forEachChild(node, (child) => {
      stack.push(child);
    });
  }
  return null;
}

/** 取公开成员名（排除 private/protected/static）与 `extends` 基类名（泛型参数剥掉） */
function membersOf(
  decl: ts.ClassDeclaration | ts.InterfaceDeclaration,
  sf: ts.SourceFile,
): { names: Set<string>; base: string | null } {
  const names = new Set<string>();
  let base: string | null = null;
  for (const clause of decl.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const first = clause.types[0];
    if (first) base = first.expression.getText(sf);
  }
  for (const member of decl.members) {
    const isValueMember =
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      ts.isPropertyDeclaration(member);
    const isTypeMember =
      ts.isMethodSignature(member) ||
      ts.isPropertySignature(member) ||
      ts.isCallSignatureDeclaration(member);
    if (!isValueMember && !isTypeMember) continue;
    if (isValueMember) {
      const flags = ts.getCombinedModifierFlags(member);
      if (flags & ts.ModifierFlags.Private || flags & ts.ModifierFlags.Protected) continue;
      if (flags & ts.ModifierFlags.Static) continue;
    }
    if (member.name && ts.isIdentifier(member.name)) names.add(member.name.text);
  }
  return { names, base };
}

/** 解析某导出符号的公开成员全集（沿 `extends` 链展开，链上类型须同样在导出面内） */
function resolveMembers(
  surface: Map<string, { file: string; declName: string }>,
  name: string,
  depth = 0,
): Set<string> | null {
  if (depth > 3) return null;
  const ref = surface.get(name);
  if (!ref || !ref.file) return null;
  const sf = astOf(ref.file);
  const decl = findTypeDecl(sf, ref.declName);
  if (!decl) return null;
  const { names, base } = membersOf(decl, sf);
  const out = new Set(names);
  const inherited = base ? resolveMembers(surface, base, depth + 1) : null;
  if (inherited) for (const n of inherited) out.add(n);
  return out;
}

/** 接口的必需成员（`?` 可选的排除）——向 P 的判据 */
function requiredMembersOf(
  surface: Map<string, { file: string; declName: string }>,
  name: string,
): string[] | null {
  const ref = surface.get(name);
  if (!ref || !ref.file) return null;
  const sf = astOf(ref.file);
  const decl = findTypeDecl(sf, ref.declName);
  if (!decl || !ts.isInterfaceDeclaration(decl)) return null;
  const required: string[] = [];
  for (const member of decl.members) {
    if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) continue;
    if (member.questionToken) continue;
    if (member.name && ts.isIdentifier(member.name)) required.push(member.name.text);
  }
  return required;
}

/** 切出全部围栏代码块（记录起始行 + 紧邻其上的散文，供「完整性承诺」判定） */
function parseFences(lines: readonly string[]): Fence[] {
  const fences: Fence[] = [];
  let open: { lang: string; startLine: number; body: string[] } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const opening = /^```(\w*)\s*$/.exec(line);
    if (opening && !open) {
      open = { lang: opening[1] ?? '', startLine: i + 1, body: [] };
      continue;
    }
    if (/^```\s*$/.test(line) && open) {
      fences.push({
        lang: open.lang,
        startLine: open.startLine,
        code: open.body.join('\n'),
        // 承诺可能写在围栏内的注释里，也可能写在其上方散文（如「下面是接口的完整实现」）
        leadText: lines.slice(Math.max(0, open.startLine - 4), open.startLine - 1).join('\n'),
      });
      open = null;
      continue;
    }
    if (open) open.body.push(line);
  }
  return fences;
}

/** 行内代码引用（跳过围栏内的行）：返回 [行号, 成员名] */
function inlineAgentRefs(lines: readonly string[]): Array<{ line: number; member: string }> {
  const refs: Array<{ line: number; member: string }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (DELETION_MARKERS.some((marker) => line.includes(marker))) continue;
    for (const span of line.matchAll(/`([^`\n]*)`/g)) {
      const spanText = span[1] ?? '';
      // 路径形态（`src/agent/agent.ts`）不是成员引用
      if (/\/\s*agent\.\w+\.(ts|mts|mjs|js|md)$/.test(spanText)) continue;
      for (const hit of spanText.matchAll(/(?<![\/\w.$])agent\.([A-Za-z_]\w*)/g)) {
        const member = hit[1];
        if (!member) continue;
        refs.push({ line: i + 1, member });
      }
    }
  }
  return refs;
}

const SURFACE = parsePublicSurface();
const AGENT_MEMBERS = resolveMembers(SURFACE, 'Agent') ?? new Set<string>();
const GUIDE_LINES = readFileSync(GUIDE, 'utf8').split('\n');
const TS_FENCES = parseFences(GUIDE_LINES).filter(
  (f) => f.lang === 'ts' || f.lang === 'typescript',
);
const INLINE_REFS = inlineAgentRefs(GUIDE_LINES);

/**
 * 三种违规集中收集，测试按标签分方向断言（一处扫描、三条判据，避免三份解析逻辑漂移）。
 */
function collectViolations(): string[] {
  const out: string[] = [];

  for (const fence of TS_FENCES) {
    const sf = parseAst(`${GUIDE}#L${fence.startLine}`, fence.code);

    // 向 I：import 符号必须在导出面
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st)) continue;
      if ((st.moduleSpecifier as ts.StringLiteral).text !== PACKAGE_NAME) continue;
      const bindings = st.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const el of bindings.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (!SURFACE.has(name)) {
          out.push(`[import] L${fence.startLine} \`${name}\` 不在 src/index.ts 导出面`);
        }
      }
    }

    // 向 M（代码块）：agent.<成员>
    const walk = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'agent'
      ) {
        const member = node.name.text;
        if (!FILE_EXT_TAIL.test(member) && !AGENT_MEMBERS.has(member)) {
          out.push(`[member] L${fence.startLine} 代码块 \`agent.${member}\` 不是 Agent 公开成员`);
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);

    // 向 P：implements 完整性（**条件判**——仅在文档自称全集时生效，见文件头）
    const claimsComplete = COMPLETENESS_MARKERS.some(
      (marker) => fence.code.includes(marker) || fence.leadText.includes(marker),
    );
    if (!claimsComplete) continue;
    for (const st of sf.statements) {
      if (!ts.isClassDeclaration(st) || !st.heritageClauses) continue;
      const implemented: string[] = [];
      for (const clause of st.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of clause.types) implemented.push(t.expression.getText(sf));
      }
      if (!implemented.length) continue;
      const declared = new Set(
        st.members
          .filter((m) => ts.isMethodDeclaration(m))
          .map((m) => (m.name as ts.Identifier).getText(sf)),
      );
      for (const iface of implemented) {
        const required = requiredMembersOf(SURFACE, iface);
        if (!required) {
          out.push(`[implements] L${fence.startLine} \`${iface}\` 不是导出面内的接口声明`);
          continue;
        }
        const missing = required.filter((r) => !declared.has(r));
        if (missing.length) {
          out.push(
            `[implements] L${fence.startLine} \`${st.name?.text}\` 自称全集却缺 ${iface} 必需成员：${missing.join('、')}`,
          );
        }
      }
    }
  }

  // 向 M（行内）：agent.<成员>
  for (const ref of INLINE_REFS) {
    if (FILE_EXT_TAIL.test(ref.member) || AGENT_MEMBERS.has(ref.member)) continue;
    out.push(`[member] L${ref.line} 行内 \`agent.${ref.member}\` 不是 Agent 公开成员`);
  }

  return out;
}

const VIOLATIONS = collectViolations();
const hint =
  '\n（修法：改文档对齐源码；若是**已退役能力**，写成删除态叙述并留「已移除/历史留痕」等词）';

describe('接入指南 ↔ 源码一致性（GUIDE-AUDIT-1）', () => {
  it('射程自检：扫描面不得归零（防路径漂移 / 文档重写导致恒绿）', () => {
    // 下限取「明显低于现值」的保守值：文档正常增删不会红，被整体替换或路径失效才红。
    expect(TS_FENCES.length, '接入指南的 TypeScript 代码块数量异常少').toBeGreaterThanOrEqual(10);
    expect(INLINE_REFS.length, '接入指南的行内 agent 引用数量异常少').toBeGreaterThanOrEqual(10);
    expect(SURFACE.size, 'src/index.ts 导出面解析异常').toBeGreaterThanOrEqual(100);
    expect(AGENT_MEMBERS.size, 'Agent 成员解析异常（含 extends 链）').toBeGreaterThanOrEqual(40);
  });

  it('向 I：代码块 import 的符号必须存在于导出面', () => {
    const issues = VIOLATIONS.filter((v) => v.startsWith('[import]'));
    expect(issues, `\n虚构 API ${issues.length} 项：\n${issues.join('\n')}${hint}`).toEqual([]);
  });

  it('向 M：`agent.<成员>` 必须是 Agent 的公开成员（含继承链）', () => {
    const issues = VIOLATIONS.filter((v) => v.startsWith('[member]'));
    expect(issues, `\n僵尸成员引用 ${issues.length} 项：\n${issues.join('\n')}${hint}`).toEqual([]);
  });

  it('向 P：自称「接口全集」的示例类必须实现接口全部必需成员', () => {
    const issues = VIOLATIONS.filter((v) => v.startsWith('[implements]'));
    expect(issues, `\n示例实现不完整 ${issues.length} 项：\n${issues.join('\n')}${hint}`).toEqual(
      [],
    );
  });
});
