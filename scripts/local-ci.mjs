#!/usr/bin/env node
/**
 * 本地 CI 模拟 — 在不开 GitHub Actions 的前提下等价复现 kernel-ci.yml 的门禁
 *
 * 为什么存在：
 *   `.github/workflows/kernel-ci.yml` 的 push / pull_request 触发自 2026-08-27 起
 *   被注释（仅剩 workflow_dispatch），且 `lefthook.yml` 的 pre-push vitest 亦被注释 →
 *   提交时**没有机器强制验证**，「全绿」全靠自报。本脚本把门禁搬回本地，
 *   使「跑没跑、过没过」可复现、可留痕，不依赖 GitHub 是否报错。
 *
 * 与 CI 的差异（刻意）：
 *   1. CI 只跑内核；本脚本**补跑宿主**（hosts/memora-vscode）——真机行为在宿主侧，
 *      内核全绿而宿主红的情况历史上出现过（宿主软链内核 dist，改内核会影响宿主）。
 *   2. `npm audit` 默认不跑（需网络、且 CI 本身 continue-on-error），用 `--audit` 开启。
 *   3. 默认**不 fail-fast**：全部步骤跑完再汇总，一次拿到完整体检结果。
 *
 * 用法：
 *   node scripts/local-ci.mjs                 # 全量（内核 4 步 + 宿主 3 步）
 *   node scripts/local-ci.mjs --kernel-only   # 只跑内核（等价于 CI 原范围）
 *   node scripts/local-ci.mjs --skip-build    # 跳过生产构建（最快的内环）
 *   node scripts/local-ci.mjs --from=host:test# 从指定步骤开始
 *   node scripts/local-ci.mjs --audit         # 额外跑依赖安全审计（允许失败）
 *
 * 退出码：任一 required 步骤失败 → 1；全绿 → 0。
 * 完整输出落盘 `.workbuddy/tmp/local-ci-<时间戳>.log`（失败时控制台只回显尾部）。
 */
import { spawn } from 'node:child_process';
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

/** @type {{id:string,name:string,cmd:string,cwd:string,required:boolean,optionalFlag?:string}[]} */
const ALL_STEPS = [
  { id: 'kernel:typecheck', name: '内核 TypeScript 类型检查', cmd: 'npm run typecheck', cwd: ROOT, required: true },
  { id: 'kernel:lint', name: '内核 ESLint（含 --max-warnings 0）', cmd: 'npm run lint', cwd: ROOT, required: true },
  { id: 'kernel:test', name: '内核单元测试', cmd: 'npm run test', cwd: ROOT, required: true },
  { id: 'kernel:build', name: '内核生产构建', cmd: 'npm run build', cwd: ROOT, required: true, optionalFlag: 'skip-build' },
  { id: 'host:typecheck', name: '宿主 TypeScript 类型检查', cmd: 'npm run typecheck', cwd: HOST, required: true },
  { id: 'host:lint', name: '宿主 ESLint（含 --max-warnings 0）', cmd: 'npm run lint', cwd: HOST, required: true },
  { id: 'host:test', name: '宿主单元测试', cmd: 'npm run test', cwd: HOST, required: true },
  { id: 'audit', name: '依赖安全审计（允许失败）', cmd: 'npm audit --audit-level=high', cwd: ROOT, required: false, optionalFlag: 'audit-invert' },
];

function selectSteps() {
  let steps = ALL_STEPS.slice();
  if (has('--kernel-only')) steps = steps.filter((s) => s.id.startsWith('kernel:'));
  if (has('--skip-build')) steps = steps.filter((s) => s.optionalFlag !== 'skip-build');
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

function runStep(step, index, total) {
  return new Promise((resolve) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn(step.cmd, {
      cwd: step.cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      chunks.push(`\n[local-ci] 步骤超时（>${STEP_TIMEOUT_MS / 1000}s），已强制终止`);
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

async function main() {
  const steps = selectSteps();
  mkdirSync(LOG_DIR, { recursive: true });
  console.log(`\n[local-ci] 开始本地门禁模拟 · 共 ${steps.length} 步 · 根因：GitHub CI 触发已停用\n`);

  const results = [];
  for (let i = 0; i < steps.length; i++) {
    results.push(await runStep(steps[i], i + 1, steps.length));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(LOG_DIR, `local-ci-${stamp}.log`);
  const logBody = results
    .map((r) => `===== ${r.id} | ${r.cmd} | exit=${r.code} | ${(r.ms / 1000).toFixed(1)}s =====\n${r.text}`)
    .join('\n\n');
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
