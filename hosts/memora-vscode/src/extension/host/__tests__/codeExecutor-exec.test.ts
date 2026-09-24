/**
 * codeExecutor-exec.test.ts — spawn 行为锁定（独立文件）
 *
 * 与 codeExecutor.test.ts（真实子进程执行）隔离：本文件对 `node:child_process`
 * 做文件级 mock，锁定 spawn 选项（与内核
 * skillScriptRunner-exec.test.ts 同构）：
 *   1. 执行形态 — node -e 直传代码（不经 shell，无命令注入）+ windowsHide:true
 *      （不弹多余终端窗口）
 *   2. env 全量继承宿主 + 源头禁色（FORCE_COLOR:0/NO_COLOR:1，子进程输出无 ANSI
 *      色码，LLM 读到的输出干净可解析；回流净化由内核 toolExecutor sanitize 兜底）
 *   3. cwd 透传为子进程工作目录
 * 真实执行路径（stdout 捕获/语法与运行时错误/超时强杀/require 可用性）仍在
 * codeExecutor.test.ts 覆盖。
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
import { createLocalCodeExecutor } from '../codeExecutor.js';

/** 构造最小假子进程：stdout/stderr 为 EventEmitter（execute 恒挂 'data' 监听），close 即结算 */
function fakeChild() {
  const fake = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  // 正常退出：close 触发 execute 结算（exitCode 0）
  queueMicrotask(() => fake.emit('close', 0, null));
  return fake;
}

/** 构造「spawn 启动失败」假子进程：只发 error（如 execPath 不可用/权限被拒），close 不跟发 */
function fakeSpawnErrorChild(err = new Error('spawn ENOENT')) {
  const fake = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  fake.stdout = new EventEmitter();
  fake.stderr = new EventEmitter();
  queueMicrotask(() => fake.emit('error', err));
  return fake;
}

describe('codeExecutor — spawn 行为锁定（内核 exec 同构）', () => {
  const mockedSpawn = vi.mocked(childProcess.spawn);
  afterEach(() => {
    mockedSpawn.mockReset();
    delete process.env.MEMORA_TEST_VAR;
  });

  it('spawn：node -e 直传不经 shell + windowsHide + env 全量继承且源头禁色', async () => {
    const exe = createLocalCodeExecutor();
    mockedSpawn.mockImplementation((() => fakeChild()) as never);

    // env = 宿主 process.env 超集 + 源头禁色（对齐内核 skillScriptRunner；须在 execute 前设，
    // env 在调用时展开——鉴别「全量继承」vs「PATH/HOME 白名单+禁色」式回归）
    process.env.MEMORA_TEST_VAR = 'test-var-456';
    await exe.execute('console.log(1 + 1)', 'js');

    expect(mockedSpawn).toHaveBeenCalledTimes(1);
    // 执行形态：node -e 直传（不经 shell 解析，无命令注入面）；--no-warnings 抑制告警噪声
    expect(mockedSpawn.mock.calls[0]![0]).toBe(process.execPath);
    expect(mockedSpawn.mock.calls[0]![1]).toEqual(['-e', 'console.log(1 + 1)', '--no-warnings']);
    const opts = mockedSpawn.mock.calls[0]![2] as Record<string, unknown>;
    // 黑框防护：Windows 隐藏子进程窗口（与内核 skillScriptRunner 同语义）
    expect(opts.windowsHide).toBe(true);
    // env 继承 = process.env 超集 + 源头禁色（对齐内核 skillScriptRunner-exec L1）；宿主测试
    // 环境强置 FORCE_COLOR:1，此处断言被 codeExecutor 覆盖为 '0'——真值校验非空断言
    const env = opts.env as NodeJS.ProcessEnv;
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.NO_COLOR).toBe('1');
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.MEMORA_TEST_VAR).toBe('test-var-456');
  });

  it('cwd 透传为子进程工作目录（run_code 脚本以指定目录执行）', async () => {
    const exe = createLocalCodeExecutor();
    mockedSpawn.mockImplementation((() => fakeChild()) as never);

    await exe.execute('console.log("cwd")', 'js', { cwd: '/tmp/memora-exec-test' });

    const opts = mockedSpawn.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.cwd).toBe('/tmp/memora-exec-test');
  });

  it('spawn 启动失败（error 事件，如 execPath 不可用）→ 降级 exitCode -1 且不误报超时', async () => {
    const exe = createLocalCodeExecutor();
    mockedSpawn.mockImplementation((() => fakeSpawnErrorChild()) as never);

    const r = await exe.execute('console.log(1)', 'js');
    // error 分支契约（codeExecutor）：stderr 带「执行失败：<err.message>」、timedOut 保持 false
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain('执行失败：spawn ENOENT');
  });
});