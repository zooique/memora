/**
 * 技能脚本执行器 — L3 脚本运行时。
 * 三级渐进披露 L3：脚本在宿主环境（隔离子进程）执行，源代码不入 LLM 上下文，
 * 只有执行结果（stdout/stderr）作为工具返回值注入。
 * 安全模型：不继承宿主环境变量、超时限制（默认 30s，最大 120s）、白名单 runtime（node/python/shell）。
 * 注：当前为简单子进程执行，非完整沙箱（文件系统/网络隔离由宿主在生产环境实现）。
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
 * 执行技能脚本：在隔离子进程中运行，收集 stdout/stderr/exitCode/timedOut
 */
export async function runSkillScript(
  scriptPath: string,
  runtime: 'node' | 'python' | 'shell',
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScriptExecutionResult> {
  // 超时限制在 [1s, MAX_TIMEOUT_MS] 内
  const effectiveTimeout = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);

  const { command, args: cmdArgs } = resolveCommand(runtime, scriptPath, args);

  return new Promise<ScriptExecutionResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, cmdArgs, {
        timeout: effectiveTimeout,
        // 不继承宿主环境变量（最小化暴露），仅保留 PATH/HOME
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
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
 * 根据 runtime 解析执行命令：node/python 直接执行，shell 依平台用 cmd /c（Windows）或 sh -c
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
      // Windows 用 cmd /c，其余平台用 sh -c
      if (process.platform === 'win32') {
        return { command: 'cmd', args: ['/c', scriptPath, ...args] };
      }
      return { command: 'sh', args: ['-c', scriptPath, ...args] };
    default:
      return { command: scriptPath, args };
  }
}

/**
 * 格式化脚本执行结果为可读字符串（供 tool 返回值）：超时/失败前缀标记 + stdout/stderr
 */
export function formatScriptResult(result: ScriptExecutionResult): string {
  if (result.timedOut) {
    return `[SCRIPT_TIMEOUT] 脚本执行超时（超过 ${MAX_TIMEOUT_MS / 1000}s）\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  if (result.exitCode !== 0) {
    return `[SCRIPT_ERROR] 脚本执行失败（退出码: ${result.exitCode}）\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  // 成功：优先 stdout，stderr 附加
  const output = result.stdout || '(无输出)';
  if (result.stderr) {
    return `${output}\n[stderr] ${result.stderr}`;
  }
  return output;
}
