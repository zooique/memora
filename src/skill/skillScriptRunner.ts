/**
 * 技能脚本执行器 — L3 脚本运行时。
 * 三级渐进披露 L3：脚本在宿主环境（隔离子进程）执行，源代码不入 LLM 上下文，
 * 只有执行结果（stdout/stderr）作为工具返回值注入。
 * 安全模型：不继承宿主环境变量、超时限制（默认 30s，最大 120s）、白名单 runtime（node/python/shell）。
 * 注：当前为简单子进程执行，非完整沙箱（文件系统/网络隔离由宿主在生产环境实现）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { CodeExecutionResult } from '@/code-exec/types.js';
import { logger } from '@/logging/logger.js';

/** 脚本执行结果（= CodeExecutionResult，复用代码执行结果形态，SSOT 不重复定义） */
export type ScriptExecutionResult = CodeExecutionResult;

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
      // Windows 用 cmd /c，其余平台用 sh 直接解释脚本文件
      // 注意：用 sh <scriptPath> 而非 sh -c（-c 把路径当命令执行，依赖文件可执行位，POSIX 下无 chmod 会报 126）
      if (process.platform === 'win32') {
        return { command: 'cmd', args: ['/c', scriptPath, ...args] };
      }
      return { command: 'sh', args: [scriptPath, ...args] };
    default:
      return { command: scriptPath, args };
  }
}

/** formatExecutionResult 的三态标签配置：前缀与详情文案（run_skill_script / run_code 各自定制） */
export interface ExecutionResultFormatLabels {
  /** 三态前缀标签（'SCRIPT' → [SCRIPT_TIMEOUT]/[SCRIPT_ERROR]；'CODE' → [CODE_TIMEOUT]/[CODE_ERROR]） */
  kind: 'SCRIPT' | 'CODE';
  /** 超时详情文案（如「脚本执行超时（超过 120s）」） */
  timeoutDetail: string;
  /** 失败详情文案（如「代码执行失败」） */
  errorDetail: string;
}

/**
 * 执行结果三态格式化（run_skill_script 与 run_code 共用的格式化真理源）
 *
 * 超时 / 非零退出码 / 成功三态；前缀与文案由 labels 定制，成功分支统一
 * 「无输出兜底 + stderr 附加」。stdout/stderr 须由调用方先行净化。
 *
 * @param result 执行结果
 * @param labels 三态前缀标签与详情文案
 * @returns 格式化后的可读字符串（供工具返回值注入 LLM 上下文）
 */
export function formatExecutionResult(
  result: CodeExecutionResult,
  labels: ExecutionResultFormatLabels,
): string {
  if (result.timedOut) {
    return `[${labels.kind}_TIMEOUT] ${labels.timeoutDetail}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  if (result.exitCode !== 0) {
    return `[${labels.kind}_ERROR] ${labels.errorDetail}（退出码: ${result.exitCode}）\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  // 成功：优先 stdout，stderr 附加
  const output = result.stdout || '(无输出)';
  if (result.stderr) {
    return `${output}\n[stderr] ${result.stderr}`;
  }
  return output;
}

/**
 * 格式化脚本执行结果为可读字符串（供 tool 返回值）：formatExecutionResult 的 SCRIPT 变体
 */
export function formatScriptResult(result: ScriptExecutionResult): string {
  return formatExecutionResult(result, {
    kind: 'SCRIPT',
    timeoutDetail: `脚本执行超时（超过 ${MAX_TIMEOUT_MS / 1000}s）`,
    errorDetail: '脚本执行失败',
  });
}
