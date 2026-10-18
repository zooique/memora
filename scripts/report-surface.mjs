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
 * 且部分成员数组也写成单行（`MemoryGovernance`）。此处按花括号配平切块，
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

/** 统计一个成员名的消费点（排除定义所在文件） */
function consumersOf(member, ownerFileHint) {
  const re = new RegExp(`\\.${member}\\b`);
  return fileTexts
    .filter((f) => re.test(f.text))
    .map((f) => f.path)
    .filter((p) => !ownerFileHint.some((h) => p.endsWith(h)));
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

/** 零消费成员清单（只对 class 有意义：interface 的成员由实现方消费，不计） */
const deadMembers = [];
for (const sym of classSymbols) {
  const hint = ownerFilesOf(sym.name);
  if (hint.length === 0) continue;
  for (const m of sym.members) {
    const consumers = consumersOf(m, hint);
    if (consumers.length === 0) deadMembers.push({ symbol: sym.name, member: m });
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
  console.log(`### 零消费成员（生产代码零引用 · 供人工定性，勿直接删）\n`);
  if (deadMembers.length === 0) {
    console.log('（无）');
  } else {
    console.log(`| 符号 | 成员 |`);
    console.log(`|---|---|`);
    for (const d of deadMembers) console.log(`| ${d.symbol} | ${d.member} |`);
    console.log('');
    console.log(
      '> 零消费 ≠ 该删：可能是治理机制人工入口、宿主待接线能力、或继承成员。须按\n' +
        '> legacy-contract-audit-rules §3.2.1 三条件定性后再动。',
    );
  }
  if (report.tests) {
    console.log('');
    console.log(`### 测试\n`);
    console.log(`- 内核：${report.tests.kernel}`);
    console.log(`- 宿主：${report.tests.host}`);
  }
}
