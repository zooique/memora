/**
 * gitExec.test.ts — 生产 spawn wrapper 行为锁定（独立文件）
 *
 * 与 gitCollector.test.ts（假执行器、纯逻辑）隔离：本文件对 `node:child_process`
 * 做文件级 mock（codeExecutor-exec.test.ts 同款先例），锁定 gitCollector 模块头
 * 钉下的五条 wrapper 契约：
 *   ① 白名单逐项守卫（三组只读外连 spawn 都不发生）
 *   ② env NO_COLOR=1（ANSI 不进注入正文）
 *   ③ windowsHide:true（禁弹控制台窗口）
 *   ④ 超时强杀按失败处置
 *   ⑤ cwd 透传
 * 另锁 exec 层进程级防护（stdout 8MB 上限）与 ENOENT / 非 0 退出的事实收集。
 * 真实 git 执行属真机四态（非 git 仓库 / git 缺失 / 大 diff / 混合），不在单测里跑。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type * as ChildProcessModule from 'node:child_process';

// 文件级 mock：仅替换 spawn 为 vi.fn，其余 child_process 导出原样保留
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn() };
});

import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { gitExec } from '../gitExec.js';
import { GIT_COMMANDS } from '../gitCollector.js';

/** 假子进程（可配 kill 观察）：stdout/stderr 为 EventEmitter，事件由用例手动驱动 */
function fakeChild() {
  const fake = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  fake.exitCode = null;
  fake.killed = false;
  fake.kill = vi.fn(() => {
    fake.killed = true;
  });
  return fake;
}

describe('gitExec — 生产 spawn wrapper 契约锁定', () => {
  const mockedSpawn = vi.mocked(childProcess.spawn);
  afterEach(() => {
    mockedSpawn.mockReset();
    vi.useRealTimers();
  });

  it('白名单三组放行：git + 逐项相等 args（status --porcelain / diff / diff --cached）', async () => {
    mockedSpawn.mockImplementation((() => fakeChild()) as never);
    const cases: readonly (readonly string[])[] = [
      GIT_COMMANDS.status,
      GIT_COMMANDS.diffUnstaged,
      GIT_COMMANDS.diffStaged,
    ];
    for (const args of cases) {
      mockedSpawn.mockClear();
      const p = gitExec(args, '/repo');
      // close 由 microtask 驱动（真实子进程异步语义）
      await Promise.resolve();
      mockedSpawn.mock.results[0]!.value.emit('close', 0, null);
      const r = await p;
      expect(r.code).toBe(0);
      expect(mockedSpawn.mock.calls[0]![0]).toBe('git');
      expect(mockedSpawn.mock.calls[0]![1]).toEqual([...args]);
    }
  });

  it('白名单外 args 一律拒绝且不 spawn（写操作 / 意外多参结构上断掉）', async () => {
    const rejects: readonly (readonly string[])[] = [
      ['push'],
      ['commit', '-m', 'x'],
      ['diff', '--stat'],
      ['status'],
      ['log'],
    ];
    for (const args of rejects) {
      const r = await gitExec(args, '/repo');
      expect(r.code).toBeNull();
      expect(r.stdout).toBe('');
      expect(r.error).toContain('白名单');
    }
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('spawn 选项：windowsHide + NO_COLOR=1 + env 全量继承 + cwd 透传', async () => {
    mockedSpawn.mockImplementation((() => fakeChild()) as never);
    const p = gitExec(GIT_COMMANDS.status, '/repo/root');
    await Promise.resolve();
    mockedSpawn.mock.results[0]!.value.emit('close', 0, null);
    await p;

    const opts = mockedSpawn.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.windowsHide).toBe(true);
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env.NO_COLOR).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
    expect(opts.cwd).toBe('/repo/root');
  });

  it('stdout/stderr 收集 + 非 0 退出码原样上报（进程级事实，不做解释）', async () => {
    const child = fakeChild();
    mockedSpawn.mockImplementation((() => child) as never);
    const p = gitExec(GIT_COMMANDS.diffUnstaged, '/repo');
    await Promise.resolve();
    child.stdout.emit('data', Buffer.from('diff --git a/f b/f\n'));
    child.stderr.emit('data', 'fatal: not a git repository\n');
    child.emit('close', 128, null);
    const r = await p;

    expect(r.code).toBe(128);
    expect(r.stdout).toContain('diff --git');
    expect(r.stderr).toContain('not a git repository');
    expect(r.error).toBeUndefined();
  });

  it('spawn 启动失败（ENOENT = 未安装 git）→ code=null + error 消息（collector 依此给事实行）', async () => {
    const child = fakeChild();
    mockedSpawn.mockImplementation((() => child) as never);
    const p = gitExec(GIT_COMMANDS.status, '/repo');
    await Promise.resolve();
    child.emit('error', new Error('spawn git ENOENT'));
    const r = await p;

    expect(r.code).toBeNull();
    expect(r.error).toBe('spawn git ENOENT');
    expect(r.stdout).toBe('');
  });

  it('超时（>10s）强杀并按失败处置（大仓库慢命令不挂死发送）', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    mockedSpawn.mockImplementation((() => child) as never);

    const p = gitExec(GIT_COMMANDS.status, '/repo');
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(r.code).toBeNull();
    expect(r.error).toContain('超时');
  });

  it('stdout 超 exec 层上限（8MB）强杀并报超限（语义截断归采集器，进程级归本层）', async () => {
    const child = fakeChild();
    mockedSpawn.mockImplementation((() => child) as never);
    const p = gitExec(GIT_COMMANDS.diffUnstaged, '/repo');
    await Promise.resolve();
    child.stdout.emit('data', Buffer.alloc(8_000_001, 0x61));
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('close', null, 'SIGTERM');
    const r = await p;

    expect(r.stdout).toBe('');
    expect(r.error).toContain('exec 层上限');
  });
});
