/**
 * 6.0.0 步 3 验收：每会话跨进程写锁（命名管道 / Unix domain socket）
 *
 * 五条机判（前四条 = 施工方案原定，第五条 = 启动双窗口让位）：
 *   ① 两进程开同一会话：第二者被拒（false），第一者不受影响仍能写完收尾
 *   ② 强杀持锁进程（`taskkill /F`）：新进程拿锁耗时 ≤2s（OS 关句柄即释放，零僵尸锁）
 *   ③ 两进程开不同会话（含不同工作区**同名**会话）互不阻塞，各 20 轮零丢失
 *   ④ 释放后同会话可重开并写入，且「拿锁后重读」读到对方刚写的轮（不是装饰）
 *   ⑤ 两窗口同时恢复到最后活跃会话：第二窗口**不被挡死**，按真实判据让位到
 *      最近的可用会话，且首选会话数据完好
 *
 * 判据口径：
 *   - 锁 = 每会话一把，锁名含数据目录哈希（跨工作区同名会话不得互挡）
 *   - 写断言 = fail-closed（已存在会话文件必须持锁；首次创建才允许无锁）
 *   - 启动让位判据单源 = src/webview/helpers/sessionStartupClaim.ts（生产同款）
 *   - 生产方式由 extension.ts 的 `enableCrossProcessLock()` 开启（静态守卫在下）
 *
 * ⚠️ 子进程通过 tsx 直跑 TS 源，`__tests__/**` 不进安装包。
 */
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 宿主根（本文件位于 src/extension/host/__tests__ 下） */
const HOST_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/** 仓库根（宿主包在 hosts/memora-vscode，再上两级） */
const REPO_ROOT = join(HOST_ROOT, '..', '..');
/** tsx CLI（直跑 TS 源，免预编译） */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** 跨进程锁验收子进程入口 */
const CHILD_FIXTURE = join(import.meta.dirname, 'fixtures', 'lockChild.ts');

/** `.memora` 数据目录 */
function memoraDir(ws: string): string {
  return join(ws, '.memora');
}

/** 单会话文件路径（与实现同口径：encodeURIComponent(sessionId)） */
function sessionFile(ws: string, sessionId: string): string {
  return join(memoraDir(ws), 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

/** 读会话文件的 roundIds（数据完好性判据） */
function readRoundIds(ws: string, sessionId: string): string[] {
  const data = JSON.parse(readFileSync(sessionFile(ws, sessionId), 'utf8')) as {
    roundIds?: string[];
  };
  return Array.isArray(data.roundIds) ? data.roundIds : [];
}

/** 子进程句柄：保留 stdout 累积与「等某行出现」能力 */
interface LockChild {
  /** 底层进程（用于 pid / 强杀） */
  child: ChildProcess;
  /** 等 stdout 出现以指定前缀开头的行（超时抛错，防测试挂死） */
  waitForLine: (prefix: string, timeoutMs?: number) => Promise<string>;
  /** 等进程退出（含完整 stdout / stderr） */
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** 起一个锁验收子进程 */
function spawnLockChild(
  ws: string,
  mode: string,
  sessionId: string,
  preferred?: string,
): LockChild {
  const args = [TSX_CLI, CHILD_FIXTURE, ws, mode, sessionId];
  if (preferred !== undefined) args.push(preferred);
  const child = spawn(process.execPath, args, {
    cwd: HOST_ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const waitForLine = (prefix: string, timeoutMs = 15_000): Promise<string> =>
    new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const line = stdout.split('\n').find((l) => l.startsWith(prefix));
        if (line) {
          clearInterval(timer);
          resolve(line);
          return;
        }
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`等不到子进程输出「${prefix}」（stdout=${stdout} stderr=${stderr}）`));
        }
      }, 20);
    });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, waitForLine, done };
}

/** 播种一个带 meta 的会话（让 listSessionMetas 能看到它，供启动让位候选） */
function plantSession(ws: string, sessionId: string, rounds: number): void {
  const store = new WorkspaceSessionStore(ws);
  store.load();
  store.updateSessionMeta(sessionId, {});
  for (let i = 0; i < rounds; i += 1) store.appendRoundId(sessionId, `${sessionId}-p${i}`);
}

describe('6.0.0 步 3 验收：每会话跨进程写锁', () => {
  /** 每个用例独立临时工作区（不同目录 ⇒ 不同锁名，测试互不干扰） */
  let ws: string;

  beforeEach(() => {
    ws = makeTempDir('memora-session-lock-');
    mkdirSync(memoraDir(ws), { recursive: true });
  });

  it('① 两进程同会话：第二者被拒，第一者仍能正常收尾', async () => {
    const holder = spawnLockChild(ws, 'hold', 's-one');
    await holder.waitForLine('LOCKED');
    const second = spawnLockChild(ws, 'try', 's-one');
    const acquiredLine = await second.waitForLine('ACQUIRED');
    expect(acquiredLine.split(' ')[1]).toBe('false');
    await second.done;
    // 第一写者不受影响：等它写完第二轮并正常退出
    const holderDone = await holder.done;
    expect(holderDone.code).toBe(0);
    expect(holderDone.stdout).toContain('DONE');
    // 两轮都在盘上（没有「第二窗口覆盖 → 丢轮」）
    const ids = readRoundIds(ws, 's-one');
    expect(ids.filter((id) => id.includes('hold-0'))).toHaveLength(1);
    expect(ids.filter((id) => id.includes('hold-1'))).toHaveLength(1);
  }, 20_000);

  it('② 强杀持锁进程：新进程拿锁耗时 ≤2s（零僵尸锁）', async () => {
    const holder = spawnLockChild(ws, 'kill', 's-kill');
    await holder.waitForLine('LOCKED');
    const pid = holder.child.pid;
    expect(pid).toBeTruthy();
    // 用户口径：`taskkill /F` 强杀（Windows）；非 Windows 用 SIGKILL 等价
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
    await holder.done;
    const retry = spawnLockChild(ws, 'try', 's-kill');
    const line = await retry.waitForLine('ACQUIRED', 10_000);
    const [acquired, elapsedRaw] = line.replace('ACQUIRED ', '').split(' ');
    expect(acquired).toBe('true');
    // 拿锁本身（进程内计时）必须 ≤2s：OS 关句柄即释放，不存在需要等心跳的租约
    expect(Number(elapsedRaw)).toBeLessThanOrEqual(2000);
    await retry.done;
  }, 20_000);

  it('③ 不同会话（含跨工作区同名会话）互不阻塞，20 轮零丢失', async () => {
    const wsOther = makeTempDir('memora-session-lock-other-');
    mkdirSync(memoraDir(wsOther), { recursive: true });
    const children = [
      spawnLockChild(ws, 'distinct', 's-a'),
      spawnLockChild(ws, 'distinct', 's-b'),
      // 同名会话、不同工作区：锁名必须含数据目录，否则这一路会被误挡
      spawnLockChild(wsOther, 'distinct', 's-a'),
    ];
    const results = await Promise.all(children.map(async (c) => c.done));
    for (const res of results) {
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('DONE');
    }
    expect(readRoundIds(ws, 's-a')).toHaveLength(20);
    expect(readRoundIds(ws, 's-b')).toHaveLength(20);
    expect(readRoundIds(wsOther, 's-a')).toHaveLength(20);
  }, 30_000);

  it('④ 释放后重开可写，且「拿锁后重读」读到对方刚写的轮', async () => {
    // 两个实例模拟两个进程：s2 先 load（内存里没有 s1 后来写的轮）
    const roundA = new WorkspaceSessionStore(ws);
    const roundB = new WorkspaceSessionStore(ws);
    roundA.load();
    roundB.load();
    roundA.enableCrossProcessLock();
    roundB.enableCrossProcessLock();

    expect(await roundA.acquireSessionLock('s-share')).toBe(true);
    roundA.appendRoundId('s-share', 's-share-a');
    // 未持锁的 s2 覆盖已存在会话文件 ⇒ fail-closed（不静默覆盖）
    expect(() => roundB.appendRoundId('s-share', 's-share-x')).toThrow(/跨进程锁/);
    roundA.releaseSessionLock('s-share');

    expect(await roundB.acquireSessionLock('s-share')).toBe(true);
    // 拿锁后重读：被 s1 写过的轮必须已在内存里
    expect(roundB.getRoundIds('s-share')).toEqual(['s-share-a']);
    roundB.appendRoundId('s-share', 's-share-b');
    roundB.releaseSessionLock('s-share');
    expect(readRoundIds(ws, 's-share')).toEqual(['s-share-a', 's-share-b']);
  }, 15_000);

  it('⑤ 两窗口同时恢复到最后活跃会话：第二窗口让位而不是被挡死', async () => {
    const preferred = 's-preferred';
    const fallback = 's-fallback';
    plantSession(ws, preferred, 3);
    plantSession(ws, fallback, 1);
    // 首选 = lastActiveAt 最大者（与 getInitialSessionId 同口径）
    const store = new WorkspaceSessionStore(ws);
    store.load();
    store.setLastActiveSession(preferred);
    expect(store.getInitialSessionId()).toBe(preferred);

    // 窗口 A 先占住首选会话（模拟第一个窗口已打开）；显式释放信号避免固定睡眠被冷启抖动击穿
    const firstWindow = spawnLockChild(ws, 'holdwait', preferred);
    await firstWindow.waitForLine('LOCKED');
    // 窗口 B 按真实启动判据裁决：首选被占 ⇒ 让位到最近可用的非留存会话
    const secondWindow = spawnLockChild(ws, 'startup', fallback, preferred);
    const claimLine = await secondWindow.waitForLine('CLAIM');
    const [, claimedId, displaced] = claimLine.split(' ');
    expect(displaced).toBe('true');
    expect(claimedId).toBe(fallback);
    const secondDone = await secondWindow.done;
    expect(secondDone.code).toBe(0);
    // 第二窗口确实可用（在自己的会话里写成功）
    expect(readRoundIds(ws, fallback).some((id) => id.includes('claim'))).toBe(true);

    // 断言完再放行窗口 A（哨兵文件 = 唯一释放信号）
    writeFileSync(join(ws, '.lock-release'), '', 'utf8');
    const firstDone = await firstWindow.done;
    expect(firstDone.code).toBe(0);
    // 首选会话数据完好：3 个播种轮 + 2 个 hold 轮，一个不少
    const ids = readRoundIds(ws, preferred);
    for (let i = 0; i < 3; i += 1) expect(ids).toContain(`${preferred}-p${i}`);
    expect(ids.filter((id) => id.includes('hold-0'))).toHaveLength(1);
    expect(ids.filter((id) => id.includes('hold-1'))).toHaveLength(1);
  }, 30_000);

  it('生产装配守卫：extension.ts 必须启用跨进程锁', () => {
    const source = readFileSync(join(HOST_ROOT, 'src', 'extension', 'extension.ts'), 'utf8');
    // 漏调 = 生产退化为「静默覆盖」，本步所有验收都失去意义——用静态守卫把装配点钉死
    expect(source).toMatch(/sessionStore\.enableCrossProcessLock\(\);/);
  });
});
