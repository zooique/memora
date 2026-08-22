/**
 * codeExecutor 测试 — 本地子进程代码执行器（G2，2026-08-23）
 *
 * 覆盖执行器行为：
 *   - 支持语言白名单（javascript/js/nodejs），其他语言返回不支持提示
 *   - console.log 捕获进 stdout、console.error 进 stderr
 *   - 语法/运行错误 → exitCode -1
 *   - 子进程死循环 → 超时强杀 timedOut true（不阻塞插件主进程）
 *   - 独立 Node 环境（可 require，与文件工具同风险等级）
 * 用 node 环境执行（非 jsdom），直接 await createLocalCodeExecutor().execute()。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLocalCodeExecutor } from '../codeExecutor.js';

describe('codeExecutor（G2 本地子进程执行器）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('支持 javascript/js/nodejs，不支持其他语言返回明确提示', async () => {
    const exe = createLocalCodeExecutor();
    for (const lang of ['javascript', 'js', 'nodejs']) {
      const r = await exe.execute('console.log(1 + 1)', lang);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('2');
    }
    const py = await exe.execute('print(1)', 'python');
    expect(py.exitCode).toBe(-1);
    expect(py.stderr).toContain('暂不支持语言「python」');
  });

  it('console.log 捕获进 stdout，console.error 进 stderr', async () => {
    const exe = createLocalCodeExecutor();
    const r = await exe.execute('console.log("out"); console.error("err")', 'js');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('out');
    expect(r.stderr).toContain('err');
  });

  it('语法错误 → exitCode 非 0 且 stderr 含错误信息', async () => {
    const exe = createLocalCodeExecutor();
    const r = await exe.execute('const = 1', 'js');
    // Node 未捕获异常/语法错误子进程退出码 1（契约 0=成功，非 0 即失败）
    expect(r.exitCode).not.toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('运行错误（抛异常）→ exitCode 非 0 且 stderr 含错误信息', async () => {
    const exe = createLocalCodeExecutor();
    const r = await exe.execute('throw new Error("boom")', 'js');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('boom');
  });

  it('dead-loop → 超时强杀 timedOut true，不阻塞主进程', async () => {
    const exe = createLocalCodeExecutor();
    // 短超时加速测试（最小 100ms）
    const r = await exe.execute('while(true){}', 'js', { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  it('独立 Node 环境：可正常 require（与文件工具同风险等级，非 fs 沙箱）', async () => {
    const exe = createLocalCodeExecutor();
    const r = await exe.execute('const os = require("os"); console.log(typeof os.platform)', 'js');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('function');
  });
});