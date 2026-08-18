/**
 * 技能脚本执行器 — L3 脚本运行时
 *
 * 三级渐进披露 L3：脚本在宿主环境中执行，**源代码不进入 LLM 上下文**——
 * 只有脚本的执行结果（stdout/stderr）作为工具返回值注入。
 *
 * 安全模型：
 *   - 脚本执行在隔离的子进程中完成，不暴露宿主环境变量
 *   - 执行有超时限制（默认 30s，最大 120s）
 *   - 仅支持白名单 runtime：node / python / shell
 *
 * 注：当前实现为简单子进程执行，不含完整沙箱。
 * 完整沙箱（文件系统隔离、网络限制）由宿主在生产环境中实现。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '@/logging/logger.js';

/** 脚本执行结果 */
export interface ScriptExecutionResult {
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码（0 = 成功） */
  exitCode: number;
  /** 是否超时 */
  timedOut: boolean;
}

/** 默认执行超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 最大执行超时（毫秒） */
const MAX_TIMEOUT_MS = 120_000;

/**
 * 执行技能脚本
 *
 * @param scriptPath 脚本文件绝对路径
 * @param runtime 运行时（node / python / shell）
 * @param args 传递给脚本的参数
 * @param timeoutMs 超时时间（毫秒，默认 30_000）
 * @returns 执行结果（stdout/stderr/exitCode/timedOut）
 */
export async function runSkillScript(
  scriptPath: string,
  runtime: 'node' | 'python' | 'shell',
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScriptExecutionResult> {
  // 限制超时
  const effectiveTimeout = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);

  // 根据 runtime 确定执行命令
  const { command, args: cmdArgs } = resolveCommand(runtime, scriptPath, args);

  return new Promise<ScriptExecutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, cmdArgs, {
        timeout: effectiveTimeout,
        // 不继承宿主环境变量（最小化暴露）
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        // 隔离 stdio
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logger.error({ scriptPath, runtime, err }, '启动脚本进程失败');
      resolve({
        stdout: '',
        stderr: `启动失败: ${(err as Error).message}`,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    child.on('error', (err) => {
      logger.error({ scriptPath, err }, '脚本进程执行错误');
      resolve({ stdout, stderr: stderr || String(err), exitCode: -1, timedOut: false });
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        timedOut = true;
        logger.warn({ scriptPath, effectiveTimeout }, '脚本执行超时，已被终止');
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        timedOut,
      });
    });
  });
}

/**
 * 根据 runtime 解析执行命令
 *
 * @param runtime 运行时
 * @param scriptPath 脚本路径
 * @param args 用户传入参数
 */
function resolveCommand(
  runtime: 'node' | 'python' | 'shell',
  scriptPath: string,
  args: string[],
): { command: string; args: string[] } {
  switch (runtime) {
    case 'node':
      return { command: 'node', args: [scriptPath, ...args] };
    case 'python':
      return { command: 'python', args: [scriptPath, ...args] };
    case 'shell':
      // Windows 环境下使用 cmd /c 执行 shell 脚本
      // 非 Windows 环境使用 sh -c
      if (process.platform === 'win32') {
        return { command: 'cmd', args: ['/c', scriptPath, ...args] };
      }
      return { command: 'sh', args: ['-c', scriptPath, ...args] };
    default:
      // 兜底：直接执行
      return { command: scriptPath, args };
  }
}

/**
 * 格式化脚本执行结果为可读字符串（供 tool 返回值）
 *
 * @param result 执行结果
 * @returns 格式化字符串
 */
export function formatScriptResult(result: ScriptExecutionResult): string {
  if (result.timedOut) {
    return `[SCRIPT_TIMEOUT] 脚本执行超时（超过 ${MAX_TIMEOUT_MS / 1000}s）\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  if (result.exitCode !== 0) {
    return `[SCRIPT_ERROR] 脚本执行失败（退出码: ${result.exitCode}）\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  // 成功：优先返回 stdout，stderr 附加
  const output = result.stdout || '(无输出)';
  if (result.stderr) {
    return `${output}\n[stderr] ${result.stderr}`;
  }
  return output;
}
