/**
 * codeExecutor 测试 — 本地子进程代码执行器
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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCodeExecutor } from '../codeExecutor.js';

describe('codeExecutor（G2 本地子进程执行器）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('支持 javascript/js/nodejs/node，不支持其他语言返回明确提示', async () => {
    const exe = createLocalCodeExecutor();
    // 声明一致性（命令执行能力方案 §10.4-①(b)）：supportedLanguages 上报内核生成工具描述，
    // 必须与 execute 实际支持集合同源一致——声明了却不支持 = 对模型说谎
    expect([...exe.supportedLanguages!].sort()).toEqual(
      ['javascript', 'js', 'node', 'nodejs'].sort(),
    );
    // node 别名：对齐内核 run_code script_path 模式按扩展名推断出的规范语言名
    for (const lang of ['javascript', 'js', 'nodejs', 'node']) {
      const r = await exe.execute('console.log(1 + 1)', lang);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('2');
    }
    const py = await exe.execute('print(1)', 'python');
    expect(py.exitCode).toBe(-1);
    expect(py.stderr).toContain('暂不支持语言「python」');
    // 回知清单从 SUPPORTED_LANGUAGES 派生（与声明同源，模型可据此直接改用）
    expect(py.stderr).toContain('javascript');
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

  it(
    'TOOL-ABORT-KILL-1：中断 → 终止真实子进程树，aborted true 且脚本不再写出标记',
    { timeout: 20_000 },
    async () => {
      const exe = createLocalCodeExecutor();
      // 标记文件：脚本存活到 3s 才写。中断发生在 1s；若进程树真死，文件永不出现。
      const marker = join(tmpdir(), `memora-run-code-abort-${Date.now()}.txt`);
      const controller = new AbortController();
      const code = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 3000);`;
      const startedAt = performance.now();
      const timer = setTimeout(() => controller.abort(), 1_000);
      const r = await exe.execute(code, 'js', { signal: controller.signal });
      clearTimeout(timer);
      const elapsed = performance.now() - startedAt;
      // 返回时点 ≤ 中断时点 + 2s（判据）
      expect(elapsed).toBeLessThanOrEqual(1_000 + 2_000);
      expect(r.aborted).toBe(true);
      expect(r.exitCode).toBe(-1);
      expect(r.terminationError).toBeUndefined();
      // 观察窗：等过脚本本来要写标记的时点
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 4_500 - (performance.now() - startedAt))),
      );
      expect(existsSync(marker), `中断后子进程仍在运行：标记文件被写出（${marker}）`).toBe(false);
    },
  );

  /**
   * 静态守卫：POSIX 上子进程必须自成进程组（detached）。
   *
   * 为什么需要它：`killProcessTree` 的 POSIX 分支按 `process.kill(-pid)` 杀整组，
   * 而 `-pid` 只有在子进程 `pgid == pid`（即 detached 自成组）时才指向真实进程组。
   * 缺 detached ⇒ 组从未存在 ⇒ 每次 ESRCH ⇒ 降级只杀直接子进程、孙进程成孤儿。
   * 本机是 Windows，走 `taskkill /T /F` 不暴露该路径，故用静态断言守契约（防误删后
   * 只有 ubuntu CI 才会红）。
   */
  it('POSIX 分支必须 detached 自成进程组（killProcessTree 的 -pid 前提）', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'codeExecutor.ts'), 'utf8');
    expect(src).toContain("process.platform === 'win32' ? {} : { detached: true }");
  });
});
