/**
 * 文档-代码一致性守卫 · 面 B（接口签名一致性）。
 *
 * 立此守卫的血训（2026-10-18 实测）：
 * `docs/memora-api-reference.md` §5.3 的 `ISessionStore` 曾只写 3 个方法（真实 12 个），
 * 且含一个内核根本没有的 `appendMessage` —— 宿主照抄编译不过。面 A（模块存在性）与
 * 面 C（`agent.X` 引用）都兜不住这种伤，因为**类型名没错、成员名错了**。
 *
 * 探针首次全量运行抓出 6 个接口 / 9 个字段漏写（含 `ToolDefinition.readonly` —— 宿主照手册
 * 注册工具会让只读工具在 readonly 模式被误阻，属功能性缺陷）。台账原定触发线是「接口差 ≥ 2 处
 * 才落地」，实测差 9 处 ⇒ **触发条件早已满足，当初按「成本最高」挂起是判断失误**。
 *
 * **判据**：源码声明（展开 `extends` 与交叉类型后）的成员集是唯一真源；手册同名代码块必须是
 * 它的超集。双向断言：漏写（源码有手册无）= 红；虚构（手册有源码无）= 红。
 *
 * **类型语义处理（首版三处假阳性的来源，已修）**：
 * - `interface X extends A` / `type X = A & {…}` ⇒ **递归展开**基类成员。不展开会把继承来的
 *   成员误判为「手册虚构」（实测 `ProjectTextSearchOptions.terms`、`AgentForkResult.newSession`）。
 * - 联合类型（`type X = (| {…} | {…} )`）⇒ **整体跳过比对**。联合分支各有独立成员，
 *   合并后必然互相判「漏写」（实测 `AgentChunk.phase`）。手册对联合类型只展示核心子集，
 *   属合法简化。跳过数设上限自检，防止「全跳过 = 守卫失明」。
 * - 方法参数跨行（`execute(\n code,\n language\n)`）⇒ 跟踪圆括号深度，只认深度 0 的成员。
 *
 * **已知边界（诚实登记）**：
 * - 只覆盖手册里**显式给出对象字面量代码块**的声明。散文描述、纯联合类型不在覆盖面内。
 * - 不比对**成员类型**（`string` vs `number`）与**可选性**（`foo?`）——只比对成员名。
 *   类型级漂移仍是人工审查职责。
 * - 不覆盖 `src/index.ts` 导出面（那是 `publicApiSurfaceGuard` 的职责）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANUAL = join(ROOT, 'docs', 'memora-api-reference.md');
const SRC = join(ROOT, 'src');

interface Decl {
  kind: 'object' | 'union';
  members: string[];
  /** interface extends A, B / type X = A & {…} —— 需要递归合并的基类型名 */
  bases: string[];
}

/**
 * 成员名抽取：只在「花括号深度 0 且圆括号未闭合」时认成员。
 * 不跟踪圆括号会把 `execute(code, language, options)` 的三个参数误认成接口成员
 * —— 这是首版探针的假阳性来源（3 处）。
 */
function extractMembers(body: string): string[] {
  const out: string[] = [];
  let brace = 0;
  let paren = 0;
  let inBlockComment = false;

  for (const raw of body.split(/\r?\n/)) {
    let line = raw;
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    line = line.replace(/\/\*[\s\S]*?\*\//g, '');
    const openComment = line.indexOf('/*');
    if (openComment !== -1) {
      line = line.slice(0, openComment);
      inBlockComment = true;
    }
    line = line.replace(/\/\/.*$/, '');
    const t = line.trim();
    if (!t) continue;

    if (brace === 0 && paren === 0) {
      const m = t.match(/^(?:readonly\s+)?([a-zA-Z_$][\w$]*)(\?)?\s*[:(<]/);
      if (m) out.push(m[1] as string);
    }
    brace += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
    paren += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
    if (brace < 0) brace = 0;
    if (paren < 0) paren = 0;
  }
  return out;
}

/** 取 `{` 开头的配平片段（含首尾花括号） */
function balancedBrace(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

/** 从一段代码里抽接口/类型别名声明 */
function extractDeclarations(code: string): Map<string, Decl> {
  const found = new Map<string, Decl>();

  // interface X extends A, B { … }
  for (const m of code.matchAll(
    /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\s*(?:extends\s+([^{]+?))?\s*\{/gm,
  )) {
    const name = m[1] as string;
    const bases = (m[2] ?? '')
      .split(',')
      .map((s) => s.trim().split(/[<\s]/)[0] as string)
      .filter(Boolean);
    const open = code.indexOf('{', m.index);
    const members = extractMembers(balancedBrace(code, open));
    if (members.length === 0) continue;
    found.set(name, { kind: 'object', members, bases });
  }

  // type X = A & B & { … }   /   type X = ( | {…} | {…} )
  for (const m of code.matchAll(
    /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);/gm,
  )) {
    const name = m[1] as string;
    if (found.has(name)) continue;
    const rhs = (m[2] ?? '').trim();
    // 联合类型：以 `(` 或 `|` 开头，且顶层出现 ≥2 个 `{`
    const isUnion = /^\(?\s*\|/.test(rhs) || (rhs.match(/\{/g) ?? []).length > 1;
    if (isUnion) {
      found.set(name, { kind: 'union', members: [], bases: [] });
      continue;
    }
    const braceAt = rhs.indexOf('{');
    if (braceAt === -1) continue;
    const head = rhs.slice(0, braceAt);
    const bases = head
      .split('&')
      .map((s) => s.trim().replace(/^\(/, ''))
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    const members = extractMembers(balancedBrace(code, code.indexOf('{', m.index)));
    if (members.length === 0) continue;
    found.set(name, { kind: 'object', members, bases });
  }

  return found;
}

/** 递归展开基类型成员（防「继承来的成员被判虚构」） */
function resolveMembers(
  name: string,
  decls: Map<string, Decl>,
  seen: Set<string> = new Set(),
): { members: Set<string>; kind: Decl['kind'] | 'missing' } {
  if (seen.has(name)) return { members: new Set(), kind: 'missing' };
  seen.add(name);
  const d = decls.get(name);
  if (!d) return { members: new Set(), kind: 'missing' };
  if (d.kind === 'union') return { members: new Set(), kind: 'union' };
  const acc = new Set(d.members);
  for (const b of d.bases) {
    for (const m of resolveMembers(b, decls, seen).members) acc.add(m);
  }
  return { members: acc, kind: 'object' };
}

/** 手册侧：只扫 ```typescript / ```ts 代码块 */
function manualDeclarations(): Map<string, Decl> {
  const text = readFileSync(MANUAL, 'utf8');
  const acc = new Map<string, Decl>();
  for (const m of text.matchAll(/```(?:typescript|ts)\r?\n([\s\S]*?)```/g)) {
    for (const [k, v] of extractDeclarations(m[1] as string)) {
      const prev = acc.get(k);
      if (!prev) {
        acc.set(k, v);
        continue;
      }
      // 同一接口在手册多处展示：成员取并集，联合态优先（跳过）
      acc.set(k, {
        kind: prev.kind === 'union' || v.kind === 'union' ? 'union' : 'object',
        members: [...new Set([...prev.members, ...v.members])],
        bases: [...new Set([...prev.bases, ...v.bases])],
      });
    }
  }
  return acc;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '__tests__'].includes(e.name)) continue;
      walk(p, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** 源码侧同名声明可能散在多个文件 —— 合并成员集（宁可多不可漏） */
function sourceDeclarations(): Map<string, Decl> {
  const acc = new Map<string, Decl>();
  for (const f of walk(SRC)) {
    for (const [k, v] of extractDeclarations(readFileSync(f, 'utf8'))) {
      const prev = acc.get(k);
      if (!prev) {
        acc.set(k, v);
        continue;
      }
      acc.set(k, {
        kind: prev.kind === 'union' || v.kind === 'union' ? 'union' : 'object',
        members: [...new Set([...prev.members, ...v.members])],
        bases: [...new Set([...prev.bases, ...v.bases])],
      });
    }
  }
  return acc;
}

describe('文档-代码一致性守卫（GUARD-METHOD-1 · 面 B 接口签名）', () => {
  it('面 B · 手册 interface/type 成员集必须覆盖源码同名声明', () => {
    const manual = manualDeclarations();
    const src = sourceDeclarations();

    const issues: string[] = [];
    let matched = 0;
    let skippedUnion = 0;

    for (const [name, docDecl] of manual) {
      const real = resolveMembers(name, src);
      if (real.kind === 'missing') continue; // 手册自有的展示型类型，无源码对应
      if (real.kind === 'union' || docDecl.kind === 'union') {
        skippedUnion++;
        continue;
      }
      matched++;
      // 手册侧也要展开：手册写了 `extends A` 就按源码里 A 的成员补齐
      // —— 读者看到 extends 即知有基类，不写基类成员不算漏写（实测 ProjectTextSearchOptions）
      const docMembers = new Set(docDecl.members);
      for (const b of docDecl.bases) {
        for (const m of resolveMembers(b, src).members) docMembers.add(m);
      }
      const missing = [...real.members].filter((m) => !docMembers.has(m));
      const phantom = [...docMembers].filter((m) => !real.members.has(m));
      if (missing.length > 0) {
        issues.push(`[${name}] 手册漏写：${missing.join(', ')}（宿主照抄会丢能力）`);
      }
      if (phantom.length > 0) {
        issues.push(`[${name}] 手册虚构：${phantom.join(', ')}（源码无此成员，照抄编译不过）`);
      }
    }

    // 失明自检①：手册接口数量骤降 ⇒ 代码块正则失效
    expect(manual.size, '手册声明代码块数量异常偏少——解析可能失明').toBeGreaterThan(20);
    // 失明自检②：参与比对的接口太少 ⇒ 名字解析或源码遍历失效
    expect(
      matched,
      `手册 ${manual.size} 个声明里只有 ${matched} 个参与比对（跳过联合 ${skippedUnion}）——` +
        `解析可能失明，或大量类型名与源码对不上`,
    ).toBeGreaterThan(20);
    // 失明自检③：联合类型跳过是合法简化，但不得过半（否则守卫形同虚设）
    expect(skippedUnion, `跳过 ${skippedUnion} 个联合类型——超过半数说明判据被绕过`).toBeLessThan(
      manual.size / 2,
    );

    expect(
      issues,
      `\n手册与源码接口成员集不一致 ${issues.length} 处：\n` +
        issues.map((s) => `  - ${s}`).join('\n') +
        `\n处理：源码新增成员 ⇒ 同步手册（含一行注释说明用途）；` +
        `\n      手册写了源码没有的成员 ⇒ 删手册行（或先补源码再写）。` +
        `\n      禁止只改手册不改源码、或反向「补源码迁就手册」。`,
    ).toEqual([]);
  });
});
