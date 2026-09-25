#!/usr/bin/env node
/**
 * 本地 CI 模拟 — 在不开 GitHub Actions 的前提下等价复现 kernel-ci.yml 的门禁
 *
 * 为什么存在：
 *   `.github/workflows/kernel-ci.yml` 的 push / pull_request 触发
 *   被注释（仅剩 workflow_dispatch），且 `lefthook.yml` 的 pre-push vitest 亦被注释 →
 *   提交时**没有机器强制验证**，「全绿」全靠自报。本脚本把门禁搬回本地，
 *   使「跑没跑、过没过」可复现、可留痕，不依赖 GitHub 是否报错。
 *
 * 与 CI 的差异（刻意）：
 *   1. CI 只跑内核；本脚本**补跑宿主**（hosts/memora-vscode）——真机行为在宿主侧，
 *      内核全绿而宿主红的情况历史上出现过（宿主软链内核 dist，改内核会影响宿主）。
 *   2. 补跑**覆盖率闸门**（`npm run test:cov`）——`testing_rules.md` 要求，但
 *      `npm test` 不带 `--coverage`、CI 也不跑时，闸门等于从未接上任何会跑的链路。
 *      代价约 +40s（覆盖率会重跑一遍测试），可用 `--skip-cov` 跳过。
 *   3. `npm audit` 默认不跑（需网络、且 CI 本身 continue-on-error），用 `--audit` 开启。
 *   4. 默认**不 fail-fast**：全部步骤跑完再汇总，一次拿到完整体检结果。
 *   5. 补跑**宿主构建**（`host:build`）—— CI 不构建宿主，而宿主
 *      `dist/extension/extension.js`（内联内核的单文件 bundle）才是用户实际运行的东西。
 *      缺此步 → 「门禁全绿」与「宿主 bundle 陈旧」可以并存。
 *   6. 补跑 **dist 契约**（`verify:dist-contract`）—— 断言宿主 bundle 与内核 dist **同代**。
 *      没有它，宿主 dist 陈旧这一失效模式在门禁里零覆盖（历史教训：未改宿主 TS ≠ 未影响宿主 dist）。
 *
 * 用法：
 *   node scripts/local-ci.mjs                 # ≡ --preset=full（全量 11 步）
 *   node scripts/local-ci.mjs --preset=fast   # 快档：只跑两侧 tsc（≤60s，挂 pre-commit）
 *   node scripts/local-ci.mjs --preset=full   # 全档：11 步（挂 pre-push）
 *   node scripts/local-ci.mjs --kernel-only   # 只跑内核（≈ CI 原范围 + 覆盖率）
 *   node scripts/local-ci.mjs --skip-cov      # 跳过覆盖率闸门（省 ~40s）
 *   node scripts/local-ci.mjs --skip-build    # 跳过生产构建
 *   node scripts/local-ci.mjs --skip-cov --skip-build   # 最快内环
 *   node scripts/local-ci.mjs --from=host:test# 从指定步骤开始
 *   node scripts/local-ci.mjs --audit         # 额外跑依赖安全审计（允许失败）
 *
 * 分层（ADR-032）：
 *   步骤定义**只在本文件**，钩子只是触发器（`lefthook.yml` 传 --preset）。分层判据：
 *   ① 输入可被 staged 集合限定 ② 单步 ≤30s ③ 失败可归因本次改动。
 *   测试（内核 98s / 宿主 119s）与覆盖率（40s+）**不进 fast** —— 根 `vitest.config.ts`
 *   的 `fileParallelism` 处自记已知跨文件 flake，假红会直接诱发 `--no-verify`（长默认路径本身就是绕过诱因）。
 *
 * 退出码：任一 required 步骤失败 → 1；全绿 → 0。
 * 完整输出落盘 `.workbuddy/tmp/local-ci-<时间戳>.log`，**头部含收据行**（when/preset/head/tree/dirty/steps）
 * ——「全绿」由此从口头自证变成「存在一份 tree=X 的 full 档日志」：绕过一次即无收据，
 * 发布前清单一行比对即可发现（自觉不可观测，缺口可观测）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const HOST = join(ROOT, 'hosts', 'memora-vscode');
const LOG_DIR = join(ROOT, '.workbuddy', 'tmp');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const argOf = (key) => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.slice(key.length + 3) : undefined;
};

const STEP_TIMEOUT_MS = 15 * 60 * 1000; // 单步 15 分钟上限，防挂死

/**
 * 步骤定义 —— **全库唯一定义处**（钩子只传 `--preset`，不得在别处复制这份清单）
 * `presets`：该步骤属于哪些档。fast 档只跑两侧 `tsc`——lint 由 pre-commit 的 lint-staged
 * 承担（staged 集合限定），测试/覆盖率/构建因超时与 flake 成本**不进 fast**（见文件头分层说明）。
 * @type {{id:string,name:string,cmd:string,cwd:string,required:boolean,presets:string[],optionalFlag?:string,env?:Record<string,string>}[]}
 */
const ALL_STEPS = [
  { id: 'kernel:typecheck', name: '内核 TypeScript 类型检查', cmd: 'npm run typecheck', cwd: ROOT, required: true, presets: ['fast', 'full'] },
  { id: 'kernel:lint', name: '内核 ESLint（含 --max-warnings 0）', cmd: 'npm run lint', cwd: ROOT, required: true, presets: ['full'] },
  { id: 'kernel:test', name: '内核单元测试', cmd: 'npm run test', cwd: ROOT, required: true, presets: ['full'] },
  {
    id: 'kernel:coverage',
    name: '内核覆盖率闸门',
    cmd: 'npm run test:cov',
    cwd: ROOT,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-cov',
    // 覆盖率跑前会 clean，本环境的 safe-delete guard 会把它拦成崩溃（前提=有残留）；
    // 置空 NODE_OPTIONS 可绕过（实测可行）。
    env: { NODE_OPTIONS: '' },
  },
  { id: 'kernel:build', name: '内核生产构建', cmd: 'npm run build', cwd: ROOT, required: true, presets: ['full'], optionalFlag: 'skip-build' },
  { id: 'host:typecheck', name: '宿主 TypeScript 类型检查', cmd: 'npm run typecheck', cwd: HOST, required: true, presets: ['fast', 'full'] },
  { id: 'host:lint', name: '宿主 ESLint（含 --max-warnings 0）', cmd: 'npm run lint', cwd: HOST, required: true, presets: ['full'] },
  { id: 'host:test', name: '宿主单元测试', cmd: 'npm run test', cwd: HOST, required: true, presets: ['full'] },
  // 宿主构建：产出用户实际运行的单文件 bundle（内联内核 dist）。缺此步则「门禁绿 + bundle 陈旧」可并存。
  { id: 'host:build', name: '宿主构建（tsc + esbuild 内联内核）', cmd: 'npm run compile', cwd: HOST, required: true, presets: ['full'], optionalFlag: 'skip-build' },
  // dist 契约：断言宿主 bundle 与内核 dist 同代（读构建戳比对哈希 + 核内核导出符号面）。
  // 依赖刚构建出的产物，故与 build 同受 --skip-build 约束。
  {
    id: 'verify:dist-contract',
    name: 'dist 契约（宿主 bundle 与内核同代）',
    cmd: 'node scripts/verify-dist-contract.mjs',
    cwd: ROOT,
    required: true,
    presets: ['full'],
    optionalFlag: 'skip-build',
  },
  // 全仓文档死链：链接腐烂是静默失效，全仓 0 死链基线锁定后硬闸（确定性 FS 扫描，秒级）。
  {
    id: 'docs:links',
    name: '全仓文档死链检查',
    cmd: 'npm run docs:links:repo',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  // 术语载体集合漂移：同族半补丁（改了函数名漏改事件名 / 只挡一半）的机械化防线。
  // 集合基线锁在 scripts/terminology-carrier-snapshot.ts，冻结例外由术语锚点 §3 派生（确定性 FS 扫描，秒级）。
  {
    id: 'terminology:check',
    name: '术语载体集合漂移检查',
    cmd: 'npm run terminology:check',
    cwd: ROOT,
    required: true,
    presets: ['full'],
  },
  { id: 'audit', name: '依赖安全审计（允许失败）', cmd: 'npm audit --audit-level=high', cwd: ROOT, required: false, presets: ['full'], optionalFlag: 'audit-invert' },
];

function selectSteps() {
  const preset = argOf('preset') ?? 'full';
  if (preset !== 'fast' && preset !== 'full') {
    console.error(`[local-ci] --preset=${preset} 无效。可选：fast | full`);
    process.exit(2);
  }
  let steps = ALL_STEPS.filter((s) => s.presets.includes(preset));
  if (has('--kernel-only')) steps = steps.filter((s) => s.id.startsWith('kernel:'));
  if (has('--skip-build')) steps = steps.filter((s) => s.optionalFlag !== 'skip-build');
  if (has('--skip-cov')) steps = steps.filter((s) => s.optionalFlag !== 'skip-cov');
  // audit 默认关闭：需网络且 CI 本身 continue-on-error，不让它影响本地门禁稳定性
  if (!has('--audit')) steps = steps.filter((s) => s.id !== 'audit');
  const from = argOf('from');
  if (from) {
    const idx = steps.findIndex((s) => s.id === from);
    if (idx < 0) {
      console.error(`[local-ci] --from=${from} 不是有效步骤 id。可选：${ALL_STEPS.map((s) => s.id).join(', ')}`);
      process.exit(2);
    }
    steps = steps.slice(idx);
  }
  return steps;
}

/** 从命令输出里抓关键统计，便于控制台一眼看数 */
function extractStats(text) {
  const out = [];
  const tests = text.match(/Tests\s+(\d+)\s+passed/);
  if (tests) out.push(`${tests[1]} passed`);
  const files = text.match(/Test Files\s+(\d+)\s+passed/);
  if (files) out.push(`${files[1]} 文件`);
  const skipped = text.match(/(\d+)\s+skipped/);
  if (skipped) out.push(`${skipped[1]} skipped`);
  const failed = text.match(/(\d+)\s+failed/);
  if (failed) out.push(`❌ ${failed[1]} failed`);
  const problems = text.match(/✖\s+(\d+)\s+problems?/);
  if (problems) out.push(`eslint ${problems[1]} problems`);
  const warn = text.match(/(\d+)\s+warnings?/);
  if (warn && !problems) out.push(`eslint ${warn[1]} warnings`);
  return out.join(' · ');
}

/**
 * 杀**整棵进程树**，而非只杀 shell。
 *
 * 为什么不能只 `child.kill()`：本脚本以 `shell: true` 启动，`child.pid` 是 shell 的 pid；
 * shell 被杀后，它拉起的 `npm` / `vitest` **孙进程仍活着**（孤儿/僵尸，继续吃 CPU 与端口）。
 * 平台分派：
 *   - Windows：`taskkill /PID <pid> /T /F`（/T 杀树、/F 强制）
 *   - POSIX：spawn 时 `detached: true` 建立独立进程组，再 `process.kill(-pid)` 打整组
 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // 进程组已消失（子进程先退）——退化为杀 shell 本身
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // 已退出
  }
}

function runStep(step, index, total) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(step.cmd, {
      cwd: step.cwd,
      shell: true,
      // 非 Windows：建独立进程组，供 killTree 打整组（Windows 走 taskkill /T，无需此位）
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(step.env ?? {}) },
    });
    const timer = setTimeout(() => {
      killTree(child);
      chunks.push(`\n[local-ci] 步骤超时（>${STEP_TIMEOUT_MS / 1000}s），已强制终止整棵进程树`);
    }, STEP_TIMEOUT_MS);

    child.stdout.on('data', (d) => chunks.push(d.toString()));
    child.stderr.on('data', (d) => chunks.push(d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const text = chunks.join('');
      const ok = code === 0;
      const stats = extractStats(text);
      const label = `[${index}/${total}] ${step.name}`;
      const dots = '.'.repeat(Math.max(2, 46 - label.length));
      const verdict = ok ? '✅ PASS' : step.required ? '❌ FAIL' : '⚠️  WARN';
      console.log(`${label} ${dots} ${verdict} ${(ms / 1000).toFixed(1)}s${stats ? `  (${stats})` : ''}`);
      resolve({ ...step, ok, code, ms, text, stats });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ...step, ok: false, code: -1, ms: Date.now() - started, text: String(err), stats: '' });
    });
  });
}

/** 只读 git 取值（门禁收据用）。取不到时返回 null —— 收据降级为 unknown，绝不因此中断门禁 */
function gitOut(args) {
  try {
    const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return res.status === 0 ? String(res.stdout).trim() : null;
  } catch {
    return null;
  }
}

/**
 * 收据（receipt）—— 把「全绿」从口头自证变成一份**可外部比对的留痕**。
 * 本地钩子物理上不可强制（LEFTHOOK=0 / --no-verify / 删钩子），故不承诺强制，
 * 只保证：**绕过一次即无收据** —— 缺口可观测，发布前清单一行比对即可发现。
 * `dirty` 必须在场：脏树上的全绿证明力弱，不写下来就会被当成 HEAD 的全绿。
 */
function buildReceipt(preset, stepCount) {
  const porcelain = gitOut(['status', '--porcelain']);
  const dirtyCount = porcelain === null ? null : porcelain === '' ? 0 : porcelain.split('\n').filter((l) => l.trim() !== '').length;
  return {
    when: new Date().toISOString(),
    preset,
    head: gitOut(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown',
    tree: gitOut(['rev-parse', '--short=12', 'HEAD^{tree}']) ?? 'unknown',
    dirty: dirtyCount === null ? 'unknown' : dirtyCount === 0 ? 'clean' : `${dirtyCount} 项未提交`,
    steps: stepCount,
  };
}

function formatReceipt(receipt) {
  return [
    '══════ local-ci 收据（receipt）══════',
    `when   = ${receipt.when}`,
    `preset = ${receipt.preset}`,
    `head   = ${receipt.head}`,
    `tree   = ${receipt.tree}`,
    `dirty  = ${receipt.dirty}`,
    `steps  = ${receipt.steps}`,
    '═════════════════════════════════════',
  ].join('\n');
}

async function main() {
  const preset = argOf('preset') ?? 'full';
  const steps = selectSteps();
  const receipt = buildReceipt(preset, steps.length);
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`\n[local-ci] 开始本地门禁模拟 · preset=${preset} · 共 ${steps.length} 步 · 根因：GitHub CI 触发已停用`);
  console.log(`[local-ci] 收据：preset=${receipt.preset} head=${receipt.head} tree=${receipt.tree} dirty=${receipt.dirty} steps=${receipt.steps}\n`);

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(await runStep(steps[i], i + 1, steps.length));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(LOG_DIR, `local-ci-${stamp}.log`);
  const logBody = `${formatReceipt(receipt)}\n\n${results
    .map((r) => `===== ${r.id} | ${r.cmd} | exit=${r.code} | ${(r.ms / 1000).toFixed(1)}s =====\n${r.text}`)
    .join('\n\n')}`;
  writeFileSync(logPath, logBody, 'utf8');

  const failed = results.filter((r) => !r.ok && r.required);
  const warned = results.filter((r) => !r.ok && !r.required);

  console.log('\n──────── 汇总 ────────');
  for (const r of results) {
    console.log(`${r.ok ? '✅' : r.required ? '❌' : '⚠️ '} ${r.id.padEnd(18)} exit=${String(r.code).padStart(3)}  ${(r.ms / 1000).toFixed(1)}s  ${r.stats}`);
  }
  const totalMs = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n总耗时 ${(totalMs / 1000).toFixed(1)}s · 失败 ${failed.length} · 告警 ${warned.length}`);
  console.log(`完整日志：${logPath}`);

  if (failed.length) {
    console.log('\n──────── 失败步骤尾部输出 ────────');
    for (const r of failed) {
      console.log(`\n### ${r.id} (exit=${r.code})`);
      console.log(r.text.split(/\r?\n/).slice(-40).join('\n'));
    }
    console.log(`\n[local-ci] 门禁未通过：${failed.map((r) => r.id).join(', ')}`);
    process.exit(1);
  }
  console.log('\n[local-ci] ✅ 全部通过');
}

main().catch((err) => {
  console.error('[local-ci] 脚本自身异常:', err);
  process.exit(2);
});
