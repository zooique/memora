/**
 * 门禁 / 全量测试互斥锁 —— **唯一实现处**（local-ci 与 test-run 共用同一锁文件、同一判据）
 *
 * 为什么要有这个文件：
 *   旧实现把锁写在 `local-ci.mjs` 内部（锁内容只有一串 pid），只能保护「门禁 vs 门禁」，
 *   保护不到「人手动跑 `npm test`」——两份全量并发抢 CPU ⇒ 超时类假红 ⇒ 训练出
 *   「红了先重跑」的习惯（那个习惯迟早放行一个真红）。抽成共享库后两个入口共用一把锁。
 *
 * 判活升级（2026-11-08）：
 *   旧判据只有 `process.kill(pid, 0)`：**pid 复用**时锁文件里的旧 pid 被无关进程占用，
 *   会被判成「活着」⇒ 永久拒绝，只能人工删文件。现在判活 = **pid 存活 且 心跳新鲜**
 *   （持有者每 30s 刷 `heartbeatAt`，超过 TTL=90s 即视为死锁）。心跳同时干掉
 *   崩溃残留（进程已死）与 pid 复用（进程活着但不是锁主）两种误判。
 *
 * 覆盖面（如实声明，不外推）：
 *   只保证**同一 clone、同一台机器**内的互斥。两个 clone / 两台机器并发仍会抢 CPU，
 *   本锁不宣称解决那种情况（锁文件在 `.workbuddy/`，已 gitignore，天然不跨 clone）。
 *
 * 孤儿进程（如实登记，不假装干净）：
 *   接管只保证「新锁可获取」，**不保证旧进程已退出**。Windows 下强杀 npm 父进程时
 *   其 vitest 子树可能存活——此时心跳停止、锁可被接管，但孤儿仍在抢 CPU。接管告警
 *   会把这句话打给用户，不省略。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（本文件位于 `scripts/lib/`，向上两级） */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 持有者心跳间隔：每 30s 刷一次 `heartbeatAt` */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 心跳过期阈值：超过即判死锁（= 3 个心跳周期，容忍一次调度抖动） */
export const LOCK_TTL_MS = 90_000;

/** 令牌环境变量名：门禁取锁后向子步骤注入，子进程凭它证明「我是持有者的后代」 */
export const TOKEN_ENV = 'MEMORA_GATE_TOKEN';

/**
 * 锁目录（默认 `.workbuddy/tmp`，已 gitignore）
 *
 * `MEMORA_GATE_LOCK_DIR` 仅用于自检脚本隔离（`scripts/verify-test-lock.mjs` 用临时目录
 * 跑矩阵，避免干扰真实门禁锁）；生产路径不得依赖它。
 *
 * @returns {string} 锁目录绝对路径
 */
export function lockDir() {
  return process.env.MEMORA_GATE_LOCK_DIR || join(REPO_ROOT, '.workbuddy', 'tmp');
}

/**
 * 锁文件路径（沿用旧名 `local-ci.lock`，不新增第二把锁）
 *
 * @returns {string} 锁文件绝对路径
 */
export function lockFilePath() {
  return join(lockDir(), 'local-ci.lock');
}

/**
 * 探活单个 pid（跨平台）
 *
 * @param {number} pid 目标进程号
 * @returns {boolean} true = 进程存在（含无权探活的 EPERM）
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权探活，视为活着（与旧实现同口径）
    return err?.code === 'EPERM';
  }
}

/**
 * 读锁文件并解析 JSON 持有者信息
 *
 * 兼容旧格式：旧锁文件只有一串 pid 数字 ⇒ JSON 解析必失败 ⇒ 按「损坏」处理并由调用方
 * 接管（升级当次不卡人，代价是一行接管告警）。
 *
 * @returns {{pid:number,token:string,kind:string,startedAt:number,heartbeatAt:number}|null} 解析成功返回持有者，失败返回 null
 */
function readHolder() {
  const file = lockFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const pid = Number(parsed?.pid);
    const token = parsed?.token;
    const startedAt = Number(parsed?.startedAt);
    const heartbeatAt = Number(parsed?.heartbeatAt);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (typeof token !== 'string' || token === '') return null;
    if (!Number.isFinite(startedAt) || !Number.isFinite(heartbeatAt)) return null;
    return {
      pid,
      token,
      kind: typeof parsed?.kind === 'string' ? parsed.kind : 'unknown',
      startedAt,
      heartbeatAt,
    };
  } catch {
    // 读失败 / 非法 JSON / 旧格式纯 pid ⇒ 一律当损坏（下方按死锁接管）
    return null;
  }
}

/**
 * 探测锁状态（只读，不修改文件）
 *
 * 判活三段式：① 文件存在且可解析 → ② pid 存活 → ③ 心跳未超 TTL。
 * 任一不成立即视为死锁（`stale` 记录具体原因，供告警文案区分「崩溃残留」与「pid 复用」）。
 *
 * @param {{now?:number}} [opts] now 用于自检脚本模拟时间流逝（生产不传）
 * @returns {{alive:boolean,stale:'corrupt'|'pid-dead'|'heartbeat-expired'|null,holder:object|null}}
 *
 * @example
 * const p = probe();
 * if (p.alive) console.log(`被 pid=${p.holder.pid} 占用`);
 */
export function probe(opts = {}) {
  const now = opts.now ?? Date.now();
  if (!existsSync(lockFilePath())) return { alive: false, stale: null, holder: null };
  const holder = readHolder();
  if (!holder) return { alive: false, stale: 'corrupt', holder: null };
  if (!isPidAlive(holder.pid)) return { alive: false, stale: 'pid-dead', holder };
  if (now - holder.heartbeatAt > LOCK_TTL_MS) {
    return { alive: false, stale: 'heartbeat-expired', holder };
  }
  return { alive: true, stale: null, holder };
}

/**
 * 把持有者信息写回锁文件（心跳 / 首次获取都走这里，保证字段形状同源）
 *
 * @param {object} holder 完整持有者对象
 */
function writeHolder(holder) {
  writeFileSync(lockFilePath(), JSON.stringify(holder));
}

/**
 * 启动心跳定时器（`unref()`：不因心跳拖住进程退出）
 *
 * 每次刷新前**先核对 token**：若锁已被接管（token 变了），本进程停止刷心跳，不覆盖新持有者。
 *
 * @param {string} token 本进程持有的令牌
 * @returns {NodeJS.Timeout} 定时器句柄（调用方可忽略）
 */
function startHeartbeat(token) {
  const timer = setInterval(() => {
    try {
      const current = readHolder();
      if (!current || current.token !== token) {
        clearInterval(timer);
        return;
      }
      writeHolder({ ...current, heartbeatAt: Date.now() });
    } catch {
      // 心跳失败不影响测试本体：最坏结果是本锁被判过期后被他进程接管
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

/**
 * 释放锁（只删自己那把：token 不符说明已被接管，不得误删新持有者的锁）
 *
 * @param {string} token 本进程持有的令牌
 */
export function release(token) {
  try {
    const current = readHolder();
    if (current && current.token === token) rmSync(lockFilePath(), { force: true });
  } catch {
    // 释放失败不抛：残留锁由下一进程的心跳判死接管
  }
}

/**
 * 获取锁（并发即失败；崩溃残留 / 心跳过期自动接管）
 *
 * 竞态说明：只用 `wx` 独占创建，不做「先读后判再写」——后者有窗口。接管路径 = 删残留后
 * 重试一次 `wx`；若重试仍 EEXIST（另一进程抢先），再探一次并如实返回失败。
 * ⚠️ **接管不是原子的**：两个进程同时判同一个残留锁为死锁时，「删 → 写」之间彼此可删掉
 * 对方刚写的锁 ⇒ 双方都可能自认持锁（概率低、后果是静默并发）。尚未改为「临时文件 + rename」，
 * 命中条件与处理建议见 `docs/测试并发确定性与flake判定SOP.md` §7。
 *
 * @param {{kind?:'gate'|'test'}} [opts] kind 仅用于告警文案区分持有者类型
 * @returns {{ok:true,token:string,release:()=>void}|{ok:false,holder:object|null}}
 *
 * @example
 * const held = acquire({ kind: 'gate' });
 * if (!held.ok) { console.error(...); process.exit(2); }
 * // ... 跑步骤；进程退出时由 exit 钩子释放
 */
export function acquire(opts = {}) {
  const kind = opts.kind ?? 'test';
  const now = Date.now();
  // 目录是懒建的：`.workbuddy/tmp` 也可能被日志先建好，recursive 幂等
  mkdirSync(lockDir(), { recursive: true });

  const token = randomUUID();
  const result = tryCreate(token, kind, now);
  if (!result.ok) return result;

  startHeartbeat(token);
  process.on('exit', () => release(token));
  return { ok: true, token, release: () => release(token) };
}

/**
 * 独占创建锁文件（`wx` 原子语义）
 *
 * @param {string} token 本进程令牌
 * @param {string} kind 持有者类型
 * @param {number} now 获取时刻
 * @returns {{ok:true}|{ok:false,holder:object|null}}
 */
function tryCreate(token, kind, now) {
  const payload = JSON.stringify({
    pid: process.pid,
    token,
    kind,
    startedAt: now,
    heartbeatAt: now,
  });
  try {
    writeFileSync(lockFilePath(), payload, { flag: 'wx' });
    return { ok: true };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const state = probe();
    if (state.alive) return { ok: false, holder: state.holder };
    // 死锁接管：告警必须带上「旧进程可能仍在跑」这句，不许假装干净
    const old = state.holder;
    const reason =
      state.stale === 'corrupt'
        ? '锁文件损坏（非法 JSON / 旧格式）'
        : state.stale === 'pid-dead'
          ? `原持有者进程已不存在（pid=${old?.pid ?? '未知'}）`
          : `原持有者心跳已过期（pid=${old?.pid ?? '未知'}，已停止心跳 ${Math.round((now - (old?.heartbeatAt ?? now)) / 1000)}s）`;
    console.warn(
      `[gate-lock] ⚠️ 接管死锁：${reason}。` +
        `\n[gate-lock] ⚠️ 注意：接管只保证新锁可获取，**不保证旧进程已退出**——` +
        `若其 vitest 子树仍存活，它会继续抢 CPU（Windows 强杀 npm 父进程的常见残留）。`,
    );
    try {
      rmSync(lockFilePath(), { force: true });
    } catch {
      // 删不掉说明权限问题，下面的重试会如实失败
    }
    try {
      writeFileSync(lockFilePath(), payload, { flag: 'wx' });
      return { ok: true };
    } catch (retryErr) {
      if (retryErr?.code !== 'EEXIST') throw retryErr;
      // 被另一进程抢先：以对方的真实状态为准
      const raced = probe();
      return { ok: false, holder: raced.holder };
    }
  }
}

/**
 * 生成持有者描述（供两个入口的拒绝文案共用，避免各自拼一份）
 *
 * @param {object|null} holder probe/acquire 返回的持有者
 * @returns {string} 形如 `gate · pid=12345 · 已持续 12s`
 */
export function describeHolder(holder) {
  if (!holder) return '持有者信息不可读';
  const age = Math.max(0, Math.round((Date.now() - holder.startedAt) / 1000));
  return `${holder.kind} · pid=${holder.pid} · 已持续 ${age}s`;
}
