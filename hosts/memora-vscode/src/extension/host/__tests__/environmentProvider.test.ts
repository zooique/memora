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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVscodeEnvironmentProvider } from '../environmentProvider.js';

describe('environmentProvider（§10.4-② 宿主环境快照）', () => {
  // 探测超时上限 5s，等待窗口略放余量
  const PROBE_WAIT_MS = 8_000;

  // 内核 shell 派发真源（resolveShellCommand）—— 读源码文本提取，不重算映射
  // __dirname = hosts/memora-vscode/src/extension/host/__tests__ → 6 次上跳抵仓库根
  const KERNEL_SHELL_PATH = join(__dirname, '../../../../../../src/skill/skillScriptRunner.ts');

  it('getEnvironment 同步返回非 null 快照（OS/shell 基础字段先落）', () => {
    const provider = createVscodeEnvironmentProvider();
    const env = provider.getEnvironment();
    expect(env).not.toBeNull();
    // OS = 平台 + 内核版本（形如 "win32 10.0.22631"）；平台与测试进程一致（零解释转发）
    expect(env!.os).toContain(process.platform);
    // shell 恒可得（本会话执行器实际派发的 shell，见下条镜像守卫）
    expect(env!.shell).toBeTruthy();
  });

  it('shell 字段与内核 resolveShellCommand 派发形态镜像一致（2026-10-03 审查 P0 守卫）', () => {
    // 谎报后果：shell 字段唯一用途是「供模型避坑」，报集成终端的 shell 而非实际派发 shell
    // ⇒ 模型按 PowerShell 语法写命令却由 cmd 执行，每次必败（本仓真实发生过的伤）。
    //
    // 判据**取自内核源码文本**而非在本测试里重算一份映射：重算 = 复制第二份判据，
    // 内核改映射而本测试的期望值不变 ⇒ 全绿而谎报已存在（「因错误的原因通过」）。
    // 做法沿用 toolNameMap 双向闭合守卫的既有范式（读内核 src 文本提取真源）。
    const src = readFileSync(KERNEL_SHELL_PATH, 'utf8');
    // 提取 win32 分支派发的 shell 名（形如 `{ command: 'cmd', args: ['/c', command] }`）
    const win32Match = /platform === 'win32'\s*\?\s*\{\s*command:\s*'([^']+)'/.exec(src);
    expect(win32Match).not.toBeNull();
    const kernelWin32Shell = win32Match![1]!;
    // 提取 POSIX 分支派发的 shell 名（形如 `{ command: 'sh', args: ... }`）
    const posixMatch = /:\s*\{\s*command:\s*'([^']+)',\s*args:\s*\['-c'/.exec(src);
    expect(posixMatch).not.toBeNull();
    const kernelPosixShell = posixMatch![1]!;

    const env = createVscodeEnvironmentProvider().getEnvironment()!;
    // 宿主上报值必须等于内核实际派发值（本平台）
    expect(env.shell).toBe(process.platform === 'win32' ? kernelWin32Shell : kernelPosixShell);
    // 点名守卫：Windows 上尤其要防「PowerShell 回归」——这正是本条守卫点名的具体伤
    if (process.platform === 'win32') {
      expect(env.shell).not.toBe('PowerShell');
      expect(env.shell).toBe(kernelWin32Shell);
    }
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
