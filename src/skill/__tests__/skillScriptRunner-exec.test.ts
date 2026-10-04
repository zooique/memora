/**
 * skillScriptRunner-exec.test.ts — L1/L2 spawn 行为锁定（独立文件）
 *
 * 与 skillScriptRunner.test.ts（真实子进程执行）隔离：本文件对
 * `node:child_process.spawn` 做文件级 mock，锁定以下行为：
 *   1. L1 spawn 选项三合一 —— windowsHide:true（不弹 conhost 黑框）
 *      + env 继承宿主（全量 process.env 超集）+ 源头禁色（FORCE_COLOR:0/NO_COLOR:1，
 *      对齐宿主 codeExecutor；回流净化由 toolExecutor sanitize 兜底剥残留）
 *   2. L2 python 9009 兜底 —— ENOENT 时自动 `py -3` 重试一次
 *   3. 参数映射 —— resolveCommand 的 node 命令映射、cwd 条件展开、timeoutMs 钳制
 *      （与超时文案同源的 normalizeTimeoutMs；2026-10-03 起钳制值落到**手动计时器**，
 *      不再下发 spawn `timeout` 选项）、spawn 同步抛错的启动失败态
 *   4. 进程树强杀（§13.6-A）—— 分平台机制断言（Windows `taskkill /T /F`
 *      / POSIX `process.kill(-pgid)`）
 *   5. 同步杀树原语（exit 钩子兜底专用，方案-后台任务跨轮存活 §4.2）——
 *      Windows `execFileSync('taskkill', …)` 参数/128 静默/非 128 降级；POSIX 同步 kill(-pgid)
 * 真实执行路径（退出码/超时/env 实际可读性、收集侧内存护栏）仍在
 * skillScriptRunner.test.ts 覆盖。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type * as ChildProcessModule from 'node:child_process';

// 文件级 mock：仅替换 spawn / execFileSync 为 vi.fn，其余 child_process 导出原样保留
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return { ...actual, spawn: vi.fn(), execFileSync: vi.fn() };
});

import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { runSkillScript, startBackgroundCommand } from '../skillScriptRunner.js';

/** 平台标识符（与真实执行测试同口径） */
const IS_WINDOWS = process.platform === 'win32';

/** 构造最小假子进程：stdout/stderr 置 null（防 'data' 挂接崩溃），事件由用例驱动 */
function fakeChild(emit: (e: EventEmitter) => void) {
  const fake = new EventEmitter();
  (fake as unknown as Record<string, unknown>).stdout = null;
  (fake as unknown as Record<string, unknown>).stderr = null;
  emit(fake);
  return fake;
}

/** 杀树原语测试用的固定 pid（负号 = POSIX 进程组） */
const FAKE_PID = 4321;

/** 带 pid 的假子进程：使 killProcessTree 走真实分支（kill 为空实现，防降级路径崩溃） */
function fakeChildWithPid(emit: (e: EventEmitter) => void) {
  const fake = fakeChild(emit) as unknown as Record<string, unknown>;
  fake.pid = FAKE_PID;
  fake.kill = () => true;
  return fake as unknown as childProcess.ChildProcess;
}

describe('skillScriptRunner — L1/L2 执行修复 spawn 行为', () => {
  const mockedSpawn = vi.mocked(childProcess.spawn);
  afterEach(() => mockedSpawn.mockReset());

  // ── L1：spawn 选项 ──
  it('spawn 选项：windowsHide=true 且环境继承宿主 + 源头禁色（L1）', async () => {
    const calls: { opts: Record<string, unknown> }[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
      calls.push({ opts: opts as Record<string, unknown> });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    // env = 宿主 process.env 超集 + 源头禁色（对齐宿主 codeExecutor；FORCE_COLOR 透传
    // 会致脚本输出色码，回流净化由 toolExecutor sanitize 兜底剥残留，源头禁根因）
    process.env.MEMORA_TEST_VAR = 'test-var-456'; // 须在 runSkillScript 前设（env 在调用时展开）：鉴别「全量继承」vs「PATH/HOME 白名单+禁色」式回归
    try {
      await runSkillScript('x.js', 'node');

      expect(calls).toHaveLength(1);
      // 黑框防护：Windows 隐藏子进程窗口
      expect(calls[0]!.opts.windowsHide).toBe(true);
      const env = calls[0]!.opts.env as NodeJS.ProcessEnv;
      expect(env.FORCE_COLOR).toBe('0');
      expect(env.NO_COLOR).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.MEMORA_TEST_VAR).toBe('test-var-456');
      // 超时**不再**经 spawn `timeout` 选项下发：该选项到期只 kill 直接子进程，
      // 经 shell 派发时孙进程变孤儿 → 改为手动计时器 + killProcessTree 杀整棵树
      // （方案文档 §13.6-A）。钳制后的值落到计时器，见下方 timeoutMs 用例。
      expect(calls[0]!.opts).not.toHaveProperty('timeout');
      // POSIX：子进程自成进程组（收割按 -pid 杀组）；Windows 走 taskkill /T，无需 detached
      expect(calls[0]!.opts.detached).toBe(IS_WINDOWS ? undefined : true);
    } finally {
      delete process.env.MEMORA_TEST_VAR;
    }
  });

  // ── L1 resolveCommand 的 node 映射（文件头声称覆盖，须断言命令名）──
  it('resolveCommand：node runtime → 命令 node，脚本路径 + args 依次追加', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('scripts/a.js', 'node', ['--flag', 'v']);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('node');
    expect(calls[0]!.args).toEqual(['scripts/a.js', '--flag', 'v']);
  });

  // ── node 路径可注入 ──
  it('nodePath 注入 → spawn 命令用注入值而非 node（命令换、args 不变）', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript(
      'scripts/b.js',
      'node',
      ['-x'],
      undefined,
      undefined,
      'C:/runtime/node.exe',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('C:/runtime/node.exe');
    expect(calls[0]!.args).toEqual(['scripts/b.js', '-x']);
  });

  it('nodePath 缺省 → 仍用 node（变异锁：注入逻辑未吞默认）', async () => {
    const calls: { cmd: string }[] = [];
    mockedSpawn.mockImplementation(((cmd: string) => {
      calls.push({ cmd });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('scripts/c.js', 'node');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('node');
  });

  it('nodePath 注入不污染 non-node runtime（python 仍走 python；S3 边界收敛）', async () => {
    const calls: { cmd: string }[] = [];
    mockedSpawn.mockImplementation(((cmd: string) => {
      calls.push({ cmd });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('scripts/d.py', 'python', [], undefined, undefined, 'C:/runtime/node.exe');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('python');
  });

  // ── L1 补充：cwd 条件展开（run_project_script 以项目根为 cwd）──
  it('cwd 显式传入 → spawn opts.cwd 原样透传（项目脚本可加载本地依赖）', async () => {
    const calls: { opts: Record<string, unknown> }[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
      calls.push({ opts: opts as Record<string, unknown> });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('x.js', 'node', [], undefined, '/some/cwd');

    expect(calls[0]!.opts.cwd).toBe('/some/cwd');
  });

  it('cwd 省略 → spawn opts 上不出现 cwd 键（交由 node 继承当前进程目录）', async () => {
    const calls: { opts: Record<string, unknown> }[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
      calls.push({ opts: opts as Record<string, unknown> });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('x.js', 'node');

    expect(calls[0]!.opts).not.toHaveProperty('cwd');
  });

  // ── L1 补充：timeoutMs 钳制（执行侧与超时文案同源的 normalizeTimeoutMs）──
  it('timeoutMs 钳制到 [1s, 600s] 后作为手动计时器时长（不再下发 spawn timeout）', async () => {
    vi.useFakeTimers();
    try {
      const optsList: Record<string, unknown>[] = [];
      // 假子进程不 close：收场只能由超时计时器触发（验证钳制值确实落到了计时器）
      mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
        optsList.push(opts as Record<string, unknown>);
        return fakeChild(() => undefined);
      }) as never);

      const cases = [
        { timeoutMs: 120_000, expected: 120_000 }, // 区间内 → 原值
        { timeoutMs: 999, expected: 1_000 }, // 下限
        { timeoutMs: 10_000_000, expected: 600_000 }, // 上限
      ];
      for (const c of cases) {
        let settled = false;
        const pending = runSkillScript('x.js', 'node', [], c.timeoutMs).then((r) => {
          settled = true;
          return r;
        });
        await vi.advanceTimersByTimeAsync(c.expected - 1);
        expect(settled).toBe(false); // 未到点不得收场
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(-1);
      }
      // 计时器承载超时 ⇒ spawn 侧不再有 timeout 选项（杀树原语替代）
      optsList.forEach((o) => expect(o).not.toHaveProperty('timeout'));
    } finally {
      vi.useRealTimers();
    }
  });

  // ── §13.6-A 进程树强杀：机制级分平台断言 ──
  // 为何锁机制而非结果：本机（Windows）实测 `child.kill()` 单杀时孙进程同样停止心跳
  // （共享控制台被销毁连带终止）⇒ 「孙进程是否已死」的结果级断言无法区分两种实现，
  // 会**因错误的原因通过**。故在此锁定机制（与方案文档 §13.6-A 定案逐字对应），
  // 真机级验证列为阶段 1 手工项。
  it('超时收割走进程树强杀原语（Windows taskkill /T /F；POSIX kill(-pgid)）', async () => {
    vi.useFakeTimers();
    try {
      const spawnCalls: { cmd: string; args: string[] }[] = [];
      mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        return fakeChildWithPid(() => undefined);
      }) as never);
      // POSIX 分支会真调 process.kill(-pid)：spy 掉，避免向真实进程组发信号
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const pending = runSkillScript('x.js', 'node', [], 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await pending;
      expect(result.timedOut).toBe(true);

      if (IS_WINDOWS) {
        expect(
          spawnCalls.some(
            (c) => c.cmd === 'taskkill' && c.args.join(' ') === `/pid ${FAKE_PID} /T /F`,
          ),
        ).toBe(true);
      } else {
        // 负 pid = 杀整个进程组（依赖 spawn 的 detached:true 使子进程自成组长）
        expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL');
      }
      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── L1 补充：spawn 同步抛错（区别于下方异步 error 事件分支）──
  it('spawn 同步抛错 → 启动失败态（exitCode -1 + stderr 以「启动失败: 」开头）', async () => {
    mockedSpawn.mockImplementation((() => {
      throw new Error('EMFILE: too many open files');
    }) as never);

    const result = await runSkillScript('x.js', 'node');

    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe('');
    expect(result.stderr.startsWith('启动失败: ')).toBe(true);
    expect(result.stderr).toContain('EMFILE: too many open files');
  });

  // ── L2：python 9009 兜底 ──
  it.runIf(IS_WINDOWS)('Windows python ENOENT → 自动换 py -3 重试成功（L2 兜底）', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (calls.length === 1) {
        // 首次 python 命令不存在（9009 场景）
        return fakeChild((e) =>
          queueMicrotask(() =>
            e.emit('error', Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' })),
          ),
        );
      }
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    const result = await runSkillScript('scripts/test.py', 'python');

    // 两次 spawn：python → py -3 自动重试
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('python');
    expect(calls[1]!.cmd).toBe('py');
    expect(calls[1]!.args[0]).toBe('-3');
    expect(calls[1]!.args[1]).toBe('scripts/test.py');
    // 兜底后按 py 执行结果返回
    expect(result.exitCode).toBe(0);
  });

  // ── L2 负向：非 python runtime 不兜底（node ENOENT 原样返回） ──
  it.runIf(IS_WINDOWS)('node ENOENT 不触发 py 兜底（仅 python 命令解析问题）', async () => {
    const calls: { cmd: string }[] = [];
    mockedSpawn.mockImplementation(((cmd: string) => {
      calls.push({ cmd });
      return fakeChild((e) =>
        queueMicrotask(() =>
          e.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' })),
        ),
      );
    }) as never);

    const result = await runSkillScript('scripts/test.js', 'node');

    expect(calls).toHaveLength(1);
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('ENOENT');
  });

  // ── L3：9009 空壳启动器 → cmd /c python 兜底 ──
  it.runIf(IS_WINDOWS)(
    'Windows python 退出码 9009（Store 空壳启动器）→ py 亦 9009 → cmd /c python 成功',
    async () => {
      const calls: { cmd: string }[] = [];
      mockedSpawn.mockImplementation(((cmd: string) => {
        calls.push({ cmd });
        if (calls.length === 1 || calls.length === 2) {
          // 前两次：python + py -3 均 spawn 成功但以 9009 退出（本机无 py 启动器、仅 store 空壳）
          return fakeChild((e) => queueMicrotask(() => e.emit('close', 9009, null)));
        }
        // 第三次 cmd /c python：cmd 按 PATHEXT 解析让 pyenv shim 生效 → 成功
        return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
      }) as never);

      const result = await runSkillScript('scripts/test.py', 'python');

      // python(9009) → py -3(9009) → cmd /c python(0)：共 3 次 spawn
      expect(calls).toHaveLength(3);
      expect(calls[0]!.cmd).toBe('python');
      expect(calls[1]!.cmd).toBe('py');
      expect(calls[2]!.cmd).toBe('cmd');
      // cmd /c python 的 argv 形态：['/c','python',scriptPath,args...]
      expect(mockedSpawn.mock.calls[2]?.[1]).toEqual(['/c', 'python', 'scripts/test.py']);
      expect(result.exitCode).toBe(0);
    },
  );

  // ── L3 负向：py -3 与 cmd 均不可用（全不可用才返回最后一次失败） ──
  it.runIf(IS_WINDOWS)(
    'python 9009 且 py/cmd 均 ENOENT → 返回最后一次失败（不掩盖根因）',
    async () => {
      const calls: { cmd: string }[] = [];
      mockedSpawn.mockImplementation(((cmd: string) => {
        calls.push({ cmd });
        if (calls.length === 1) {
          return fakeChild((e) => queueMicrotask(() => e.emit('close', 9009, null)));
        }
        // py 与 cmd 均 ENOENT：走 error 事件（enoent=true）
        return fakeChild((e) =>
          queueMicrotask(() =>
            e.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' })),
          ),
        );
      }) as never);

      const result = await runSkillScript('scripts/test.py', 'python');

      expect(calls).toHaveLength(3);
      expect(calls[0]!.cmd).toBe('python');
      expect(calls[1]!.cmd).toBe('py');
      expect(calls[2]!.cmd).toBe('cmd');
      // 全不可用 → 返回最后一次（cmd）的失败态：error 事件固定 exitCode -1，
      // stderr 回落到 String(err)（含命令名 cmd），陈述根因而非吞掉
      expect(result.exitCode).toBe(-1);
      expect(result.stderr).toContain('cmd');
    },
  );
});

// ── 同步杀树原语（exit 钩子兜底专用 · 方案-后台任务跨轮存活 §4.2）──
// 为何锁机制：exit 钩子返回后 Node 即退出，「taskkill 是否真把进程杀了」的结果级断言
// 无法在单测内构造（不能真退宿主进程）——故锁「同步原语被正确调用」这一机制层，
// 真机级验证 = 观察点 ⑧ 第三轮（退出 VS Code 后查 ping 残留）。
describe('killProcessTreeSync（exit 兜底同步杀树，经 startBackgroundCommand.killNowSync）', () => {
  const mockedSpawn = vi.mocked(childProcess.spawn);
  const mockedExecFileSync = vi.mocked(childProcess.execFileSync);
  afterEach(() => {
    mockedSpawn.mockReset();
    mockedExecFileSync.mockReset();
  });

  /** 起一条后台命令（spawn 已 mock 为带 pid 的假子进程），返回其句柄与 kill 调用记录 */
  function startWithFakeChild() {
    const killCalls: (string | number | undefined)[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[]) => {
      const fake = fakeChild(() => undefined) as unknown as Record<string, unknown>;
      fake.pid = FAKE_PID;
      fake.kill = (signal?: string | number) => {
        killCalls.push(signal);
        return true;
      };
      return fake as unknown as childProcess.ChildProcess;
    }) as never);
    const handle = startBackgroundCommand('node -e 1', undefined, null, () => undefined);
    return { handle, killCalls };
  }

  it('Windows：走 execFileSync taskkill /T /F（与异步原语同源参数）；POSIX：同步 kill(-pgid)', () => {
    const { handle, killCalls } = startWithFakeChild();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      handle.killNowSync();
      if (IS_WINDOWS) {
        // 同源参数：/pid <pid> /T /F（改参数构造须同步异步一起改，本断言拦异步版漏改）
        expect(mockedExecFileSync).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', String(FAKE_PID), '/T', '/F'],
          expect.objectContaining({ windowsHide: true, stdio: 'ignore' }),
        );
        expect(killCalls).toHaveLength(0); // 成功路径不降级
      } else {
        expect(killSpy).toHaveBeenCalledWith(-FAKE_PID, 'SIGKILL');
        expect(mockedExecFileSync).not.toHaveBeenCalled();
      }
    } finally {
      killSpy.mockRestore();
    }
  });

  it.runIf(IS_WINDOWS)('execFileSync 退出码 128（目标已退出）→ 静默达成，不降级 kill', () => {
    const { handle, killCalls } = startWithFakeChild();
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('command failed'), { status: 128 });
    });

    expect(() => handle.killNowSync()).not.toThrow();
    expect(killCalls).toHaveLength(0);
  });

  it.runIf(IS_WINDOWS)('execFileSync 非零非 128（权限不足等）→ 降级 child.kill 单杀', () => {
    const { handle, killCalls } = startWithFakeChild();
    mockedExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Access is denied.'), { status: 1 });
    });

    expect(() => handle.killNowSync()).not.toThrow();
    expect(killCalls).toHaveLength(1); // 降级路径（只及直接子进程，属降级非等价）
  });
});
