/**
 * skillScriptRunner-exec.test.ts — L1/L2 spawn 行为锁定（独立文件）
 *
 * 与 skillScriptRunner.test.ts（真实子进程执行）隔离：本文件对
 * `node:child_process.spawn` 做文件级 mock，锁定修复（2026-09-08，含审查批更新）：
 *   1. L1 spawn 选项三合一 —— windowsHide:true（不弹 conhost 黑框）
 *      + env 继承宿主（全量 process.env 超集）+ 源头禁色（FORCE_COLOR:0/NO_COLOR:1，
 *      对齐宿主 codeExecutor；回流净化由 toolExecutor sanitize 兜底剥残留）
 *   2. L2 python 9009 兜底 —— ENOENT 时自动 `py -3` 重试一次
 *   3. 参数映射 —— resolveCommand 的 node 命令映射、cwd 条件展开、timeoutMs 钳制
 *      （与超时文案同源的 normalizeTimeoutMs）、spawn 同步抛错的启动失败态
 * 真实执行路径（退出码/超时/env 实际可读性）仍在 skillScriptRunner.test.ts 覆盖。
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
import { runSkillScript } from '../skillScriptRunner.js';

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

describe('skillScriptRunner — L1/L2 执行修复 spawn 行为（2026-09-08）', () => {
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
      // 黑框根因修复：Windows 隐藏子进程窗口
      expect(calls[0]!.opts.windowsHide).toBe(true);
      const env = calls[0]!.opts.env as NodeJS.ProcessEnv;
      expect(env.FORCE_COLOR).toBe('0');
      expect(env.NO_COLOR).toBe('1');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.MEMORA_TEST_VAR).toBe('test-var-456');
      // 超时默认 60s（2026-09-08 由 30s 调大；上限 600s 见 MAX_TIMEOUT_MS）
      expect(calls[0]!.opts.timeout).toBe(60_000);
    } finally {
      delete process.env.MEMORA_TEST_VAR;
    }
  });

  // ── L1 补充：resolveCommand 的 node 映射（文件头声称覆盖，此前从未断言命令名）──
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

  // ── S3（2026-09-22）：node 路径可注入 ──
  it('nodePath 注入 → spawn 命令用注入值而非 node（命令换、args 不变）', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('scripts/b.js', 'node', ['-x'], undefined, undefined, 'C:/runtime/node.exe');

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
  it('timeoutMs 钳制到 [1s, 600s] 后下发给 spawn（执行侧与超时文案同源）', async () => {
    const timeouts: number[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
      timeouts.push((opts as { timeout: number }).timeout);
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('x.js', 'node', [], 120_000);
    await runSkillScript('x.js', 'node', [], 999);
    await runSkillScript('x.js', 'node', [], 10_000_000);

    expect(timeouts).toEqual([120_000, 1_000, 600_000]);
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

  // ── L3：9009 空壳启动器 → cmd /c python 兜底（2026-09-17） ──
  it.runIf(IS_WINDOWS)('Windows python 退出码 9009（Store 空壳启动器）→ py 亦 9009 → cmd /c python 成功', async () => {
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
  });

  // ── L3 负向：py -3 与 cmd 均不可用（全不可用才返回最后一次失败） ──
  it.runIf(IS_WINDOWS)('python 9009 且 py/cmd 均 ENOENT → 返回最后一次失败（不掩盖根因）', async () => {
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
  });
});
