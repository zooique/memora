#!/usr/bin/env node
/**
 * 全量测试入口包装 —— 与门禁共用同一把互斥锁（判据真源 `scripts/lib/gateLock.mjs`）
 *
 * 为什么存在：
 *   门禁自己已有 pid 锁，但「人手动跑 `npm test`」完全不受约束。两份全量并发抢 CPU
 *   ⇒ 超时类假红 ⇒ 训练出「红了先重跑」的习惯（那个习惯迟早放行一个真红）。
 *   本包装把全量测试纳入同一把锁，**全量才取锁**。
 *
 * 四条行为（顺序即优先级）：
 *   1. 带位置参数**且该路径真实存在**（`npm test -- <文件/目录>`）⇒ **不取锁**，
 *      打印「单文件复核，已跳过互斥」。选项的取值（如 `--reporter verbose` 的 `verbose`）
 *      不算位置参数——否则整份全量会从豁免口子漏出锁外。
 *      这是硬条件：假红判定 SOP 的复核手段就是单文件重跑（`docs/测试并发确定性与flake判定SOP.md`
 *      §3 步骤 2），锁若罩住它等于把复核纪律锁死。
 *   2. env 里有 `MEMORA_GATE_TOKEN` 且与锁文件 token 一致 ⇒ 视为门禁子步骤，直接放行
 *      （凭令牌重入，解决「门禁父进程持锁、子进程再取锁 ⇒ 自锁死」）。
 *      令牌不一致（陈旧环境变量）⇒ 按未持锁处理，继续走获取。
 *   3. 逃生开关（`--concurrent` / `MEMORA_TEST_ALLOW_CONCURRENT=1`）⇒ 放行 + 醒目告警。
 *   4. 其余 = 取锁；被占用则拒绝（exit 2）并给出三条出路。
 *
 * 覆盖面（如实声明）：只保证同仓同机互斥；不宣称跨 clone / 跨机器。
 * 禁区：不抬超时、不改用例超时、不 skip flaky、不关并发——本包装只做串行化，不碰判据。
 *
 * 用法：
 *   npm test                         # 全量（取锁）
 *   npm test -- --no-file-parallelism# 门禁口径（取锁）
 *   npm test -- src/foo.test.ts      # 单文件复核（不取锁）
 *   npm test -- --concurrent         # 自担风险跑全量（不取锁）
 *   npm test -- --dry-run            # 只做锁决策、不启动 vitest（自检脚本用）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, TOKEN_ENV, acquire, describeHolder, probe } from './lib/gateLock.mjs';

/** vitest 入口（直接跑 mjs，不依赖 PATH 解析，避免 shell 层差异） */
const VITEST = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** 宿主包根（宿主测试须在宿主 cwd 下跑，`--config vitest.config.ts` 才指对） */
const HOST_ROOT = join(REPO_ROOT, 'hosts', 'memora-vscode');

/**
 * 套件清单 —— 三个入口的唯一真源（命令形态在此写一次，package.json 只传套件名）
 * @type {Record<string, {cwd:string, args:string[]}>}
 */
const SUITES = {
  /** 内核全量（并发口径，与旧 `vitest run` 等价） */
  kernel: { cwd: REPO_ROOT, args: ['run'] },
  /** 内核覆盖率闸门（前置 verify-node-pin 由 package.json 负责，此处只管 vitest） */
  cov: { cwd: REPO_ROOT, args: ['run', '--coverage'] },
  /** 宿主全量（宿主既定口径 = 串行） */
  host: {
    cwd: HOST_ROOT,
    args: ['run', '--config', 'vitest.config.ts', '--no-file-parallelism'],
  },
};

/** 只属于包装层、不得透传给 vitest 的开关 */
const WRAPPER_FLAGS = new Set(['--concurrent', '--dry-run']);

const rawArgs = process.argv.slice(2);
const suiteName = rawArgs[0];
/** @type {{cwd:string,args:string[]}|undefined} */
const suite = SUITES[suiteName];
if (!suite) {
  console.error(
    `[test-run] 未知套件：${suiteName ?? '(空)'} —— 可选：${Object.keys(SUITES).join(' | ')}`,
  );
  process.exit(2);
}

/** 透传给 vitest 的参数（剔除包装层开关） */
const extra = rawArgs.slice(1);
const vitestArgs = [...suite.args, ...extra.filter((a) => !WRAPPER_FLAGS.has(a))];
/**
 * 位置参数 = 文件 / 目录过滤串 —— **必须是真实存在的路径**（相对套件 cwd 解析）。
 *
 * 为什么不能只看「不以 `-` 开头」：选项的**取值**也不以 `-` 开头（`--reporter verbose` 的
 * `verbose`、`--testNamePattern foo` 的 `foo`），只看前缀会把它们当成文件名 ⇒ 命中单文件豁免
 * ⇒ **整份全量在无锁状态下跑**。那正是这把锁要治的病，从豁免口子里漏回来。
 * 代价：路径写错（打错字）时不再享受豁免，退回「取锁跑全量」——宁慢不错。
 */
const positional = extra.filter((a) => !a.startsWith('-') && existsSync(resolve(suite.cwd, a)));
const dryRun = extra.includes('--dry-run');
const allowConcurrent =
  extra.includes('--concurrent') || process.env.MEMORA_TEST_ALLOW_CONCURRENT === '1';

/**
 * 启动真实 vitest（stdio 继承：输出与旧脚本逐字一致）
 *
 * @returns {void}
 */
function runVitest() {
  if (dryRun) {
    console.log(`[test-run] dry-run：锁决策完成，将运行 ${suiteName}（cwd=${suite.cwd}）`);
    return;
  }
  const child = spawn(process.execPath, [VITEST, ...vitestArgs], {
    cwd: suite.cwd,
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    // 被信号终止时 code 为 null：按失败处理（不把「没跑完」伪装成绿）
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.on('error', (err) => {
    console.error(`[test-run] 启动 vitest 失败：${err.message}`);
    process.exitCode = 1;
  });
}

/**
 * 主流程：先决定锁，再跑测试
 *
 * @returns {void}
 */
function main() {
  // ① 单文件 / 目录复核：永不取锁（硬条件，见文件头）
  if (positional.length > 0) {
    console.log('[test-run] 单文件复核，已跳过互斥（互斥只保护全量；SOP 的复核手段必须随时可用）');
    runVitest();
    return;
  }

  // ② 令牌继承：门禁父进程已持锁，子进程凭令牌重入（否则门禁会自己锁死自己）
  const inherited = process.env[TOKEN_ENV] ?? '';
  if (inherited !== '') {
    const state = probe();
    if (state.alive && state.holder && state.holder.token === inherited) {
      runVitest();
      return;
    }
    if (state.alive) {
      console.warn(
        '[test-run] ⚠️ 环境里的 MEMORA_GATE_TOKEN 与当前锁不符（陈旧变量，可能来自别的门禁或旧 shell），按未持锁处理',
      );
    }
  }

  // ③ 逃生开关：显式自担风险
  if (allowConcurrent) {
    console.warn(
      '[test-run] ⚠️ 已通过逃生开关放行并发（MEMORA_TEST_ALLOW_CONCURRENT=1 / --concurrent）——' +
        '结果可能含负载假红，请自行承担判断成本',
    );
    runVitest();
    return;
  }

  // ④ 取锁：被占用即拒绝，不排队（排队会让「等门禁」变成隐性长延时）
  const held = acquire({ kind: 'test' });
  if (!held.ok) {
    console.error(
      `\n[test-run] ❌ 另一份全量测试或门禁正在运行（${describeHolder(held.holder)}），已拒绝并发执行。` +
        '\n[test-run] 原因：并发跑全量会抢 CPU ⇒ 超时类假红 ⇒ 结果不可信（不是代码坏了，是负载）。' +
        '\n[test-run] 出路：① 等它结束；② 只复核单个文件：npm test -- <文件>；' +
        '③ 明确自担风险：MEMORA_TEST_ALLOW_CONCURRENT=1（或 npm test -- --concurrent）',
    );
    process.exit(2);
  }

  runVitest();
}

main();
