#!/usr/bin/env node
/**
 * 公开面报数脚本（REPORT-SURFACE-1）——报告里所有「符号数 / 成员数 / 零消费数 / 未推提交数」
 * 必须来自本脚本输出，禁止手写。
 *
 * 立此脚本的血训（2026-10-18）：一份 9 提交的工作报告里 6 处数字是错的——
 * Agent 成员「62→58」实为 63→60、宿主「36 文件/795 用例」实为 44/870、
 * RolePackManager 零消费「3 个」实为 2 个、`GUARD-METHOD-1`「台账在册」实为零登记。
 * 共性：数字靠人抄，抄的时候没有机器来源。⇒ 把报数变成一条命令。
 *
 * 用法：
 *   node scripts/report-surface.mjs              # 静态面 + git 状态（毫秒级）
 *   node scripts/report-surface.mjs --json       # 机器可读
 *   node scripts/report-surface.mjs --with-tests # 附带内核/宿主用例数（约 5 分钟）
 *
 * 判据边界（诚实登记）：
 * - 成员消费扫描用 `\.member\b`，**getter/setter 去掉前缀后可能撞上同名局部变量**
 *   ⇒ 只会「少报零消费」、不会「多报」，方向保守。
 * - **同名跨类会互相借消费点**（实测 2026-10-18，案例已退役但仍成立）：`MemoryGovernance.detectConflicts`
 *   转调 `MemoryAdvisor.detectConflicts`，两者同名 ⇒ 前者被误判为「有外部消费」而漏报
 *   （这两类已于 5.0.0 随治理链整链退役，案例保留为方法论留痕）。
 *   同理「类内自用」也会把**对下游同名方法的调用**算成自用（`Agent.clearPlan` 里
 *   `this.requireSessionManager.clearPlan()` 被记成 Agent 自调 1 次，实际是调 SessionManager）。
 *   ⇒ 本脚本的零消费清单是**下限**，精确结论须用 `this.<member>` 逐个人工复核。
 * - 只扫 `src/` 与 `hosts/<pkg>/src/` 的非测试文件；`.d.ts`、`dist/`、`node_modules/` 排除。
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'src', '__tests__', 'publicMemberSurfaceGuard.test.ts');
const args = new Set(process.argv.slice(2));

/**
 * 解析 publicMemberSurfaceGuard 的 EXPECTED 基线（单一真源，不另抄一份）。
 *
 * ⚠️ 不能用「一行一个正则」——EXPECTED 里同时存在**单行条目**
 * （`ToolContext: { kind: 'interface', members: ['guardPath'] },`）与**多行条目**，
 * 且部分成员数组也写成单行（历史上 `MemoryGovernance` 即如此，5.0.0 已删）。此处按花括号配平切块，
 * 再提取块内全部单引号字符串：第一个是 kind，其余是成员。
 * 血训：首版用行正则只数出 46 个符号（真值 81）、MemoryGovernance 成员数算出 0。
 */
function parseExpected() {
  const text = readFileSync(GUARD, 'utf8');
  const body = text.slice(text.indexOf('const EXPECTED'));
  const out = [];
  const headRe = /^ {2}([A-Za-z_][A-Za-z0-9_]*): \{/gm;
  let m;
  while ((m = headRe.exec(body))) {
    const open = body.indexOf('{', m.index);
    let depth = 0;
    let i = open;
    let inStr = null;
    for (; i < body.length; i++) {
      const c = body[i];
      if (inStr) {
        if (c === inStr && body[i - 1] !== '\\') inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        inStr = c;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    const chunk = body.slice(open + 1, i);
    const strs = [...chunk.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    out.push({
      name: m[1],
      kind: strs[0],
      members: strs.slice(1).map((s) => s.replace(/^(get|set) /, '')),
    });
    headRe.lastIndex = i;
  }
  return out;
}

/** 递归收集 .ts（排除测试 / .d.ts / dist / node_modules） */
function collectSources(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'coverage', '.git'].includes(e.name)) continue;
      collectSources(p, acc);
    } else if (extname(e.name) === '.ts' && !e.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const files = [...collectSources(join(ROOT, 'src')), ...collectSources(join(ROOT, 'hosts'))].filter(
  (f) => !f.includes(`__tests__`) && !f.includes(`/test/`),
);

const fileTexts = files.map((f) => ({
  path: relative(ROOT, f).replace(/\\/g, '/'),
  text: readFileSync(f, 'utf8'),
}));

/**
 * 统计一个成员的消费面，**分内外两侧**（判据不可混）：
 * - `external`：定义文件之外的引用点 → 决定「这个公开成员有没有外部消费者」
 * - `internal`：定义文件内部的 `this.x` 引用数 → 决定「它是死代码还是内部实现」
 *
 * 为什么必须分开（2026-10-18 实测教训）：首版只报 external，把
 * `SessionManager.completePlanItem`（唯一消费方是同文件的
 * `concludeActivePlanItemIfPlanFullyReached`）也报成「零消费」——
 * 听起来像死代码，实际是「public 但只内部用」，处置方式是降 private 而非删除。
 */
function scanMember(member, ownerFileHint) {
  const re = new RegExp(`\\.${member}\\b`, 'g');
  const external = [];
  let internal = 0;
  for (const f of fileTexts) {
    const hits = (f.text.match(re) || []).length;
    if (hits === 0) continue;
    if (ownerFileHint.some((h) => f.path.endsWith(h))) internal += hits;
    else external.push(f.path);
  }
  return { external, internal };
}

/** 符号名 → 定义文件（用于把定义点排除出消费面） */
function ownerFilesOf(symbolName) {
  const idx = fileTexts.filter((f) =>
    new RegExp(`(class|interface)\\s+${symbolName}\\b`).test(f.text),
  );
  return idx.map((f) => f.path.split('/').slice(-1)[0]);
}

function git(cmd) {
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const expected = parseExpected();
const classSymbols = expected.filter((s) => s.kind === 'class');

/**
 * 零外部消费成员清单（只对 class 有意义：interface 的成员由实现方消费，不计）。
 * `internal` 列 = 类内自用次数：> 0 说明不是死代码，只是「public 但外部没人用」，
 * 处置方向是降 private / 收回公开面；= 0 才是真僵尸，需按 §3.2.1 三条件定性。
 */
const deadMembers = [];
for (const sym of classSymbols) {
  const hint = ownerFilesOf(sym.name);
  if (hint.length === 0) continue;
  for (const m of sym.members) {
    const { external, internal } = scanMember(m, hint);
    if (external.length === 0) deadMembers.push({ symbol: sym.name, member: m, internal });
  }
}

const report = {
  publicSymbols: expected.length,
  symbolsWithMembers: expected.length,
  membersBySymbol: Object.fromEntries(classSymbols.map((s) => [s.name, s.members.length])),
  deadMembers,
  totalMembers: expected.reduce((n, s) => n + s.members.length, 0),
  scanCorpusFiles: fileTexts.length,
  git: {
    branch: git('git rev-parse --abbrev-ref HEAD'),
    dirty: git('git status --porcelain').length > 0,
    unpushed: Number(git('git rev-list --count origin/main..HEAD') || 0),
    head: git('git log -1 --format=%h'),
  },
};

if (args.has('--with-tests')) {
  const run = (cwd, cmd) => {
    try {
      const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.replace(/\x1b\[[0-9;]*m/g, '').match(/Tests\s+(.+)/);
      return m ? m[1].trim() : '无法解析';
    } catch (e) {
      const out = `${e.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
      const m = out.match(/Tests\s+(.+)/);
      return m ? `${m[1].trim()}（有失败）` : '执行失败';
    }
  };
  report.tests = {
    kernel: run(ROOT, 'node ./node_modules/vitest/vitest.mjs run'),
    host: run(
      join(ROOT, 'hosts', 'memora-vscode'),
      'node ../../node_modules/vitest/vitest.mjs run',
    ),
  };
}

if (args.has('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`## 公开面报数（机器生成 · ${new Date().toISOString().slice(0, 10)}）\n`);
  console.log(`| 指标 | 值 |`);
  console.log(`|---|---|`);
  console.log(`| 公开面符号数（EXPECTED 顶层键） | **${report.publicSymbols}** |`);
  console.log(`| 成员总数（全部类/接口/常量对象） | **${report.totalMembers}** |`);
  console.log(`| 类符号数（参与零消费扫描） | ${classSymbols.length} |`);
  console.log(`| 扫描语料文件数 | ${report.scanCorpusFiles} |`);
  console.log(`| 零消费成员数 | **${deadMembers.length}** |`);
  console.log(`| 当前分支 | ${report.git.branch} |`);
  console.log(`| 工作树 | ${report.git.dirty ? '🔴 有未提交改动' : '✅ 干净'} |`);
  console.log(`| 未推提交数 | **${report.git.unpushed}** |`);
  console.log(`| HEAD | ${report.git.head} |`);
  console.log('');
  console.log(`### 各符号成员数\n`);
  console.log(`| 符号 | 成员数 |`);
  console.log(`|---|---|`);
  for (const [k, v] of Object.entries(report.membersBySymbol)) console.log(`| ${k} | ${v} |`);
  console.log('');
  console.log(`### 零外部消费成员（供人工定性，勿直接删）\n`);
  if (deadMembers.length === 0) {
    console.log('（无）');
  } else {
    console.log(`| 符号 | 成员 | 类内自用 | 性质 |`);
    console.log(`|---|---|---|---|`);
    for (const d of deadMembers) {
      const kind = d.internal > 0 ? 'public 但只内部用' : '真零（仅测试）';
      console.log(`| ${d.symbol} | ${d.member} | ${d.internal} | ${kind} |`);
    }
    console.log('');
    console.log(
      '> 「类内自用 > 0」= 不是死代码，处置方向是降 private / 收回公开面；\n' +
        '> 「真零」才需按 legacy-contract-audit-rules §3.2.1 三条件定性（预留键 / 僵尸 / 该接没接）。\n' +
        '> 两者都**不是**「可以直接删」的同义词。',
    );
  }
  if (report.tests) {
    console.log('');
    console.log(`### 测试\n`);
    console.log(`- 内核：${report.tests.kernel}`);
    console.log(`- 宿主：${report.tests.host}`);
  }
}
