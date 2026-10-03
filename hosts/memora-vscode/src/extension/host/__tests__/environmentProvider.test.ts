/**
 * environmentProvider 测试 — VS Code 宿主环境提供者（方案 §10.4-②）
 *
 * 覆盖：
 *   - getEnvironment 同步返回 OS/shell 基础快照（探测未完成也非 null）
 *   - 异步探测完成后 runtimes 含 node（测试进程本身即 node，必可探测成功）
 *   - python 探测失败不阻断（宁缺勿假：探测不到的运行时不上报，快照仍可用）
 * 用 node 环境执行（探测真实 spawn node --version，CI 可跑）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createVscodeEnvironmentProvider } from '../environmentProvider.js';

describe('environmentProvider（§10.4-② 宿主环境快照）', () => {
  // 探测超时上限 5s，等待窗口略放余量
  const PROBE_WAIT_MS = 8_000;

  it('getEnvironment 同步返回非 null 快照（OS/shell 基础字段先落）', () => {
    const provider = createVscodeEnvironmentProvider();
    const env = provider.getEnvironment();
    expect(env).not.toBeNull();
    // OS = 平台 + 内核版本（形如 "win32 10.0.22631"）；平台与测试进程一致（零解释转发）
    expect(env!.os).toContain(process.platform);
    // shell 恒可得（Windows 固定 PowerShell / POSIX 回落 $SHELL ?? 'sh'）
    expect(env!.shell).toBeTruthy();
  });

  it('异步探测完成后快照含 node 运行时（python 失败不阻断）', async () => {
    const provider = createVscodeEnvironmentProvider();
    // 等待异步探测落快照（node 探测在测试进程内必成功；python 视宿主机而定）
    await vi.waitFor(
      () => {
        expect(provider.getEnvironment()!.runtimes).toBeDefined();
      },
      { timeout: PROBE_WAIT_MS },
    );
    const runtimes = provider.getEnvironment()!.runtimes!;
    // node 必在清单（跑测试的即 node 运行时）；python 仅在探测成功时出现——不硬断言
    expect(runtimes.some((r) => r.startsWith('node '))).toBe(true);
  });

  it('探测成功后 OS/shell 基础字段不被覆盖（合并而非替换）', async () => {
    const provider = createVscodeEnvironmentProvider();
    await vi.waitFor(
      () => {
        expect(provider.getEnvironment()!.runtimes).toBeDefined();
      },
      { timeout: PROBE_WAIT_MS },
    );
    const env = provider.getEnvironment()!;
    expect(env.os).toContain(process.platform);
    expect(env.shell).toBeTruthy();
  });
});
