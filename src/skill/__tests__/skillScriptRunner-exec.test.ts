/**
 * skillScriptRunner-exec.test.ts — L1/L2 spawn 行为锁定（独立文件）
 *
 * 与 skillScriptRunner.test.ts（真实子进程执行）隔离：本文件对
 * `node:child_process.spawn` 做文件级 mock，锁定两处修复（2026-09-08）：
 *   1. L1 windowsHide:true —— Windows 不再弹 conhost 黑框
 *   2. L2 python 9009 兜底 —— ENOENT 时自动 `py -3` 重试一次
 * 真实执行路径（env 继承/退出码/超时）仍在 skillScriptRunner.test.ts 覆盖。
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
  it('spawn 选项：windowsHide=true 且环境继承宿主（L1）', async () => {
    const calls: { opts: Record<string, unknown> }[] = [];
    mockedSpawn.mockImplementation(((_cmd: string, _args: string[], opts: object) => {
      calls.push({ opts: opts as Record<string, unknown> });
      return fakeChild((e) => queueMicrotask(() => e.emit('close', 0, null)));
    }) as never);

    await runSkillScript('x.js', 'node');

    expect(calls).toHaveLength(1);
    // 黑框根因修复：Windows 隐藏子进程窗口
    expect(calls[0]!.opts.windowsHide).toBe(true);
    // env 继承 = process.env 本体（原 PATH/HOME 白名单裁剪废除）
    expect(calls[0]!.opts.env).toBe(process.env);
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
});