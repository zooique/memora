/**
 * 技能脚本执行器 — L3 脚本运行时。
 * 三级渐进披露 L3：脚本在宿主环境（隔离子进程）执行，源代码不入 LLM 上下文，
 * 只有执行结果（stdout/stderr）作为工具返回值注入。
 * 安全模型：继承宿主用户环境变量（用户会话环境——脚本可读项目所需配置与用户 shell 环境；
 *   密钥默认经 SecretStorage→配置对象注入、不经 env（宿主默认路径）；env 回退配置模式
 *   （MEMORA_API_KEY 等，security_rules 支持）下 key 在进程 env、对脚本可见——owner 信任
 *   模型（默认自动批准）+ 脚本来源审阅（判据 B）为边界，视同用户本地 shell 语义）+ 超时
 *   限制（默认 30s，最大 120s）+ 白名单 runtime（node/python/shell）+ Windows 隐藏窗口
 *   （windowsHide:true，不弹 conhost）。
 * 注：当前为简单子进程执行，非完整沙箱（文件系统/网络隔离由宿主在生产环境实现）。
 */
import * as childProcess from 'node:child_process';
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
 *
 * @param scriptPath 脚本绝对路径
 * @param runtime 运行时（node/python/shell 白名单三档）
 * @param args 传给脚本的参数数组
 * @param timeoutMs 超时（毫秒，限制在 [1s, MAX_TIMEOUT_MS] 内）
 * @param cwd 子进程工作目录（可选；run_project_script 以项目根为 cwd，
 *        使项目脚本可加载项目本地依赖/相对数据文件）
 */
export async function runSkillScript(
  scriptPath: string,
  runtime: 'node' | 'python' | 'shell',
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd?: string,
): Promise<ScriptExecutionResult> {
  // 超时限制在 [1s, MAX_TIMEOUT_MS] 内
  const effectiveTimeout = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);

  const { command, args: cmdArgs } = resolveCommand(runtime, scriptPath, args);

  /**
   * 单次子进程执行（spawn + 输出收集）。
   *
   * @returns 执行结果 + enoent 标记（命令不存在 → 供调用方判定 L2 fallback 重试）
   */
  const runOnce = (
    cmd: string,
    runArgs: string[],
  ): Promise<ScriptExecutionResult & { enoent: boolean }> =>
    new Promise((resolve) => {
      /** ENOENT 标记：spawn 命令不存在（如 Windows 缺 python 命令，仅 python runtime 场景用） */
      let enoent = false;
      let child: childProcess.ChildProcess;
      try {
        child = childProcess.spawn(cmd, runArgs, {
          timeout: effectiveTimeout,
          // 继承宿主用户环境变量（2026-09-08 决策：原 PATH/HOME 白名单过度裁剪——
          // 项目脚本读用户环境（API KEY/PATH/工作区变量）是合理需求；密钥默认经
          // SecretStorage→config 不经 env，env 回退模式下 key 在 env 属 owner 信任
          // 语义（见文件头安全模型）。对齐宿主 codeExecutor 持久会话环境语义）
          // 禁子进程彩色输出：FORCE_COLOR:0/NO_COLOR:1 源头禁色（对齐宿主 codeExecutor
          // 同构）；回流净化由 toolExecutor sanitizeExternalText 兜底剥残留 ANSI——
          // 源头禁根因 + 通用防御两层不冲突（2026-09-08 同构评估采纳）
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          // 隐藏子进程窗口（Windows）：不传则每次执行弹 conhost 黑框（对齐宿主
          // codeExecutor 既有 windowsHide 语义 + 大厂仅隐藏子进程回流输出共识）
          windowsHide: true,
          // cwd 缺省时由 node 决定（当前进程目录）；仅显式传入时指定
          ...(cwd ? { cwd } : {}),
        });
      } catch (err) {
        logger.error({ scriptPath, runtime, err }, '启动脚本进程失败');
        resolve({
          stdout: '',
          stderr: `启动失败: ${(err as Error).message}`,
          exitCode: -1,
          timedOut: false,
          enoent: false,
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
        // ENOENT = 命令不存在（Windows python 9009 场景：现代 Python 只装 py 启动器）
        // 记标记供 L2 fallback，其余错误原样返回
        enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
        logger.error({ scriptPath, err }, '脚本进程执行错误');
        resolve({ stdout, stderr: stderr || String(err), exitCode: -1, timedOut: false, enoent });
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
          enoent,
        });
      });
    });

  let result = await runOnce(command, cmdArgs);

  // L2（2026-09-08）：Windows python 9009 兜底——python 命令不存在（现代 Python 安装
  // 仅提供 py 启动器）时，首次 ENOENT 自动换 `py -3` 重试一次（成功/其它错误原样返回）
  if (result.enoent && shouldFallbackPythonToPy(runtime, process.platform)) {
    result = await runOnce('py', ['-3', scriptPath, ...args]);
  }
  return result;
}

/**
 * L2 兜底判定：python runtime 在 Windows 下可用 py 启动器替换（纯函数，平台参数化可测）
 *
 * @param runtime  脚本运行时
 * @param platform 当前平台（process.platform；参数化便于测试）
 * @returns 是否应换 py -3 重试一次
 */
export function shouldFallbackPythonToPy(
  runtime: 'node' | 'python' | 'shell',
  platform: NodeJS.Platform,
): boolean {
  return runtime === 'python' && platform === 'win32';
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
