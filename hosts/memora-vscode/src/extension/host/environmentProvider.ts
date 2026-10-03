/**
 * VS Code 宿主环境提供者 — IEnvironmentProvider 的宿主实现（方案 §10.4-②）
 *
 * 职责：探测本机运行环境事实（OS / 默认 shell / 可用运行时），以**快照**上报内核，
 * 供 system prompt 注入「## 运行环境」段——让模型知道自己在什么环境里跑
 * （如在 Windows 上避免建议 Unix 命令；装了哪些语言运行时决定脚本语言选择）。
 *
 * 设计要点：
 *   - **探测节奏宿主自理**：内核 getEnvironment() 是同步接口，本实现启动期异步探测
 *     一次并缓存快照（环境事实是低频变化数据，会话生命周期内不必重探）；
 *   - **诚实上报**：探测失败 / 退出码非 0 的运行时不上报（Windows 上 `python` 可能是
 *     Microsoft Store stub 假阳性，退出码 9009 会被滤掉）——宁缺勿假；
 *   - **零解释转发**：内核只格式化不裁决（§10.5 刻意不做：环境事实不升级为内核判据）。
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { IEnvironmentProvider, HostEnvironmentInfo } from '@zooique/memora';

/** 运行时探测超时（毫秒）：--version 类调用应瞬间完成，超时视为不可用 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 探测单个运行时：spawn `<command> --version`，退出码 0 才上报版本行
 *
 * @param command 运行时命令名（如 node / python）
 * @returns 版本描述（如 "node v22.10.0"）；探测失败返回 null（不上报）
 */
function probeRuntime(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    /** 一次结算：超时 / 错误 / 退出三路竞争下单点守卫 */
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // shell:false 直传命令（无注入面；命令名是本文件常量，非用户输入）
    const child = spawn(command, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', () => finish(null)); // ENOENT = 未安装，不上报
    child.on('close', (code) => {
      // 退出码 0 才认定可用（Windows Store python stub 会走非 0 路径，自然被滤掉）
      const version = stdout.trim().split('\n')[0]?.trim();
      finish(code === 0 && version ? `${command} ${version}` : null);
    });

    // 探测超时兜底：杀进程并按不可用处理（不阻塞装配）
    const killer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill();
      finish(null);
    }, PROBE_TIMEOUT_MS);
    if (typeof killer.unref === 'function') killer.unref();
  });
}

/**
 * 创建 VS Code 宿主环境提供者
 *
 * 启动期异步探测一次（node / python），缓存快照供内核同步读取；
 * 探测进行中 / 全部失败时 getEnvironment() 返回已有部分或 null（不阻塞、不报错）。
 *
 * @returns 实现 IEnvironmentProvider 的环境提供者
 */
export function createVscodeEnvironmentProvider(): IEnvironmentProvider {
  // 快照容器：探测完成后一次性填充（OS/shell 可同步获得，运行时需异步探测）
  let snapshot: HostEnvironmentInfo | null = null;

  // OS / shell 同步可得的字段先落快照（内核装配早于探测完成时也能拿到基础事实）
  const partial: HostEnvironmentInfo = {
    // 形如 "win32 10.0.22631"（平台 + 内核版本号，宿主进程内零成本事实）
    os: `${process.platform} ${os.release()}`,
    // 默认 shell：Windows 侧 VS Code 集成终端默认 PowerShell；POSIX 读 $SHELL 环境变量
    shell: process.platform === 'win32' ? 'PowerShell' : (process.env.SHELL ?? 'sh'),
  };
  snapshot = partial;

  // 运行时探测异步进行，完成后合并进快照（下次 getEnvironment 即含 runtimes）
  void Promise.all([probeRuntime('node'), probeRuntime('python')]).then(([node, python]) => {
    // 只上报探测成功的运行时（宁缺勿假，见文件头「诚实上报」）
    const runtimes = [node, python].filter((r): r is string => r !== null);
    if (runtimes.length > 0) {
      snapshot = { ...partial, runtimes };
    }
  });

  return {
    /**
     * 返回环境事实快照（同步，内核装配/前缀刷新路径零等待读取）
     *
     * @returns 快照；探测未就绪时返回 OS/shell 基础字段（不返回 null——基础事实恒可得）
     */
    getEnvironment(): HostEnvironmentInfo | null {
      return snapshot;
    },
  };
}
