#!/usr/bin/env node
/**
 * 测试互斥锁矩阵自检（门禁 fast 档步骤 `lock:verify` 的执行体）
 *
 * 为什么要有它：
 *   「共用一把锁」是纪律，纪律靠不住——要靠**能红的断言**钉住。本脚本用临时锁目录跑
 *   矩阵（不碰真实门禁锁、不跑任何用例，秒级），任何一条行为被改坏都必红。
 *
 * 八条矩阵（对应方案里承诺的能力 + 两处「全量不得从豁免口子漏出锁外」的防线）：
 *   1. 活锁存在 ⇒ 全量被拒（exit 2）
 *   2. 令牌匹配 ⇒ 放行（门禁自锁死的防线）；另断言令牌不符的陈旧变量被拒
 *   3. pid 已死 ⇒ 自动接管
 *   4. pid 存活但心跳过期（模拟 **pid 复用**）⇒ 自动接管
 *   5. 锁文件损坏（非法 JSON / 旧纯 pid 格式）⇒ 自动接管
 *   6. 单文件复核（**真实存在的路径**）⟹ 即使锁被持有也放行（假红判定 SOP §3 步骤 2 的
 *      复核手段不能被锁死，锚点：`docs/测试并发确定性与flake判定SOP.md` §7）
 *   7. 选项的**取值**不算位置参数（`--reporter verbose` 的 `verbose`）⇒ 必须 exit 2
 *   8. 位置参数**必须真实存在**（不存在的路径）⇒ 按全量处理，必须 exit 2
 *
 * 变异验证（人工执行，不进自动化；2026-11-08 已执行并留痕）：
 *   - 把 `probe()` 判活改成恒 true ⇒ 用例 3/4/5 必红（实测 ✅ 已红）；
 *   - 删掉 `test-run.mjs` 的单文件豁免分支 ⇒ 用例 6 必红（实测 ✅ 已红）；
 *   - 把位置参数判据改回宽松版（只判「不以 `-` 开头」）⇒ 用例 7/8 必红（实测 ✅ 已红）；
 *   各处还原后复跑全绿（证明这些断言不是恒绿的摆设）。
 *
 * 覆盖边界（如实声明）：本脚本只证明**锁的判据**正确，**不能**证明「假红不再发生」——
 * 那依赖真实负载，属人工压力验收项。
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/gateLock.mjs';

/** 被检的包装入口 */
const TEST_RUN = join(REPO_ROOT, 'scripts', 'test-run.mjs');

/** 自检专用临时锁目录（与真实门禁锁完全隔离） */
const LOCK_DIR = mkdtempSync(join(tmpdir(), 'memora-lock-verify-'));
const LOCK_PATH = join(LOCK_DIR, 'local-ci.lock');

/**
 * 写一个锁文件（直接写 JSON，故意不经 gateLock 的 acquire——自检要能构造任意病态状态）
 *
 * @param {{pid:number,token:string,kind?:string,hbOffsetMs?:number}} spec 持有者参数
 * @returns {void}
 */
function writeLock(spec) {
  const now = Date.now();
  writeFileSync(
    LOCK_PATH,
    JSON.stringify({
      pid: spec.pid,
      token: spec.token,
      kind: spec.kind ?? 'gate',
      startedAt: now,
      heartbeatAt: now - (spec.hbOffsetMs ?? 0),
    }),
  );
}

/**
 * 清掉上一个用例的锁文件
 * @returns {void}
 */
function clearLock() {
  rmSync(LOCK_PATH, { force: true });
}

/**
 * 取一个**必然已退出**的进程 pid（用于构造「崩溃残留锁」）
 *
 * @returns {number} 已结束进程的 pid
 */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid ?? 999999;
}

/**
 * 跑一次包装体（`--dry-run`：只做锁决策，不启动 vitest）
 *
 * 基座 env 里**显式删除** `MEMORA_GATE_TOKEN` / `MEMORA_TEST_ALLOW_CONCURRENT`：
 * 本脚本可能作为门禁步骤运行，若继承真实令牌，用例 1 会被令牌绕过——自检自身就不能假绿。
 *
 * @param {{args?:string[],env?:Record<string,string>}} [opts] 额外参数 / 额外环境变量
 * @returns {{code:number, out:string}} 退出码与合并输出
 */
function runWrapper(opts = {}) {
  const baseEnv = { ...process.env, MEMORA_GATE_LOCK_DIR: LOCK_DIR };
  delete baseEnv.MEMORA_GATE_TOKEN;
  delete baseEnv.MEMORA_TEST_ALLOW_CONCURRENT;
  const r = spawnSync(process.execPath, [TEST_RUN, 'kernel', '--dry-run', ...(opts.args ?? [])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...baseEnv, ...(opts.env ?? {}) },
    timeout: 30_000,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * 断言工具：把「期望」写成声明式，失败不抛而是记一笔（一次跑完六条，便于定位）
 *
 * @param {string} name 用例名
 * @param {boolean} ok 条件
 * @param {string} detail 失败时的观测值
 * @returns {boolean} 是否通过
 */
function assertCase(name, ok, detail) {
  console.log(`[lock:verify] ${ok ? '✅' : '❌'} ${name}${ok ? '' : ` —— ${detail}`}`);
  return ok;
}

let failed = 0;
function check(name, ok, detail) {
  if (!assertCase(name, ok, detail)) failed++;
}

// ── 用例 1：活锁存在 ⇒ 全量被拒（exit 2，文案含「另一份全量测试或门禁正在运行」）
clearLock();
writeLock({ pid: process.pid, token: 'tok-alive' });
{
  const r = runWrapper();
  check(
    '活锁存在 ⇒ 全量拒绝（exit 2）',
    r.code === 2 && r.out.includes('另一份全量测试或门禁正在运行'),
    `code=${r.code} out=${r.out.slice(0, 120)}`,
  );
}

// ── 用例 2：令牌匹配 ⇒ 放行（门禁子步骤防「自锁死」）；令牌不符 ⇒ 拒绝
{
  clearLock();
  writeLock({ pid: process.pid, token: 'tok-inherit' });
  const r = runWrapper({ env: { MEMORA_GATE_TOKEN: 'tok-inherit' } });
  check(
    '令牌匹配 ⇒ 长驱直入（不重复取锁）',
    r.code === 0 && !r.out.includes('已拒绝并发'),
    `code=${r.code} out=${r.out.slice(0, 120)}`,
  );

  clearLock();
  writeLock({ pid: process.pid, token: 'tok-inherit' });
  const stale = runWrapper({ env: { MEMORA_GATE_TOKEN: 'tok-stale' } });
  check(
    '令牌不符（陈旧变量）⇒ 按未持锁处理后拒绝',
    stale.code === 2 && stale.out.includes('陈旧变量'),
    `code=${stale.code} out=${stale.out.slice(0, 120)}`,
  );
}

// ── 用例 3：pid 已死 ⇒ 自动接管（崩溃残留）
clearLock();
writeLock({ pid: deadPid(), token: 'tok-dead' });
{
  const r = runWrapper();
  check(
    'pid 已死 ⇒ 自动接管',
    r.code === 0 && r.out.includes('接管死锁') && r.out.includes('进程已不存在'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 用例 4：pid 存活但心跳过期 ⇒ 自动接管（**pid 复用**的防线）
clearLock();
writeLock({ pid: process.pid, token: 'tok-stale-hb', hbOffsetMs: 120_000 });
{
  const r = runWrapper();
  check(
    '心跳过期 ⇒ 自动接管（pid 复用不再永久卡锁）',
    r.code === 0 && r.out.includes('接管死锁') && r.out.includes('心跳已过期'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 用例 5：锁文件损坏 ⇒ 自动接管
clearLock();
writeFileSync(LOCK_PATH, 'garbage-not-json');
{
  const r = runWrapper();
  check(
    '锁文件损坏 ⇒ 自动接管',
    r.code === 0 && r.out.includes('锁文件损坏'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 用例 6：单文件复核 ⇒ 即使锁被持有也放行（硬条件；路径须真实存在）
clearLock();
writeLock({ pid: process.pid, token: 'tok-exempt' });
{
  // 用仓库里**真实存在**的目录：豁免判据已收紧为「位置参数且 existsSync」，不存在的路径不再豁免
  const r = runWrapper({ args: ['src/__tests__'] });
  check(
    '单文件复核（真实路径）⇒ 跳过互斥',
    r.code === 0 && r.out.includes('单文件复核，已跳过互斥'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 用例 7：选项取值不得冒充文件名（`--reporter verbose` 的 `verbose`）⇒ 仍须取锁被拒
clearLock();
writeLock({ pid: process.pid, token: 'tok-optval' });
{
  const r = runWrapper({ args: ['--reporter', 'verbose'] });
  check(
    '选项取值（--reporter verbose）⇒ 不算单文件豁免，必须 exit 2',
    r.code === 2 && r.out.includes('另一份全量测试或门禁正在运行'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 用例 8：位置参数必须真实存在（打错字的路径）⇒ 按全量处理，必须 exit 2
clearLock();
writeLock({ pid: process.pid, token: 'tok-ghost' });
{
  const r = runWrapper({ args: ['src/no-such-file.test.ts'] });
  check(
    '不存在的路径 ⇒ 不享受豁免，必须 exit 2',
    r.code === 2 && !r.out.includes('单文件复核'),
    `code=${r.code} out=${r.out.slice(0, 160)}`,
  );
}

// ── 收尾：清临时目录（失败也要清，避免 temp 里堆垃圾）
clearLock();
rmSync(LOCK_DIR, { recursive: true, force: true });

if (failed > 0) {
  console.error(`[lock:verify] ❌ ${failed} 条矩阵失败——锁判据已偏离方案，先修再跑门禁`);
  process.exit(1);
}
console.log(
  '[lock:verify] ✅ 八条矩阵全部通过（含令牌继承 / 双泄漏接管 / 单文件豁免 / 豁免口子两条反例）',
);
