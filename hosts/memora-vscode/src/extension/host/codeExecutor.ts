/**
 * 本地代码执行器 — ICodeExecutionProvider 的 Node.js 子进程实现
 *
 * 用独立子进程执行 JavaScript，供 LLM 的 run_code 工具使用。
 *
 * 隔离策略（关键取舍）：
 *   - 子进程隔离：代码跑在 `spawn(process.execPath, ['-e', code])` 的独立进程，
 *     与插件主进程（extension host）进程级隔离——**死循环/崩溃只影响子进程，
 *     不会卡死或污染插件主进程**（这是首选 vm 沙箱但 vm 的 timeout 对纯 CPU
 *     死循环实测不可靠、会卡死主进程后放弃 vm 方案的根因）；
 *   - 硬超时强杀：到 timeoutMs 未退出即 `child.kill()`（Windows 下 TerminateProcess），
 *     返回 timedOut:true，防无限执行拖垮系统；
 *   - 输出收集 + 上限截断：stdout/stderr 累计进 result；超长输出由内核 ToolExecutor
 *     的 RUN_CODE_RESULT_MAX_LEN 截断，不在本层重复。
 *
 * ⚠️ 安全边界声明：子进程拥有 Node.js 运行时全能力（可 require('fs')/网络/读环境变量），
 * 与「在插件内直接跑 node」等价，其 fs 破坏风险与已有 write_file/read_file 工具同等级
 * （本宿主为 owner 权限、模型已可信）。本执行器提供的保护是**进程级隔离 + 超时强杀**
 * （防死循环/防卡死），而非文件系统/网络沙箱。如要运行不可信代码，需升级为
 * OS 级容器/沙箱（如专用受限用户 + rlimit + 网络隔离），不在本执行器范围。
 *
 * 语言支持：仅 JavaScript（javascript / js / nodejs / node）。经 supportedLanguages
 * 声明上报内核（§10.4-①(b)），run_code 工具描述按声明生成「支持：…」，描述与现实一致；
 * 不支持的语言由执行器回知清单（同源自 SUPPORTED_LANGUAGES 派生）。
 * 「node」对齐 script_path 模式按扩展名推断（.js/.mjs/.cjs/.ts → node）。
 */
import { spawn } from 'node:child_process';
import type {
  ICodeExecutionProvider,
  CodeExecutionResult,
  CodeExecutionOptions,
} from '@zooique/memora';

/** 默认执行超时（毫秒）：纯计算场景足够 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 最大执行超时（毫秒，对齐内核 safeExecuteCode 外层兜底 120s 上限约束） */
const MAX_TIMEOUT_MS = 120_000;
/** 支持的语言（小写归一；node 为内核 run_code script_path 推断出的规范名） */
const SUPPORTED_LANGUAGES = new Set(['javascript', 'js', 'nodejs', 'node']);

/**
 * 创建本地代码执行器（子进程隔离 + 超时强杀；注入 Agent 启用 run_code 工具）
 *
 * @returns 实现 ICodeExecutionProvider 的执行器
 */
export function createLocalCodeExecutor(): ICodeExecutionProvider {
  return {
    // 支持语言声明（方案 §10.4-①(b)）：内核 run_code 工具描述按本声明生成「支持：a、b、c」，
    // 消灭「描述与现实不符」（描述真源 = 本字段，回知文案亦从 SUPPORTED_LANGUAGES 派生，不双写）
    supportedLanguages: [...SUPPORTED_LANGUAGES],
    /**
     * 在独立 Node 子进程内执行 JavaScript 代码
     *
     * @param code 要执行的代码
     * @param language 代码语言（仅支持 javascript/js/nodejs/node）
     * @param options 执行选项（读取 timeoutMs；cwd 传递为子进程工作目录）
     * @returns 执行结果（stdout/stderr/exitCode/timedOut）
     */
    async execute(
      code: string,
      language: string,
      options?: CodeExecutionOptions,
    ): Promise<CodeExecutionResult> {
      const lang = (language ?? '').toLowerCase();
      // 暂不支持的语言：返回明确提示（支持清单从 SUPPORTED_LANGUAGES 派生——
      // 与 supportedLanguages 声明同源，杜绝声明与回知双写漂移）
      if (!SUPPORTED_LANGUAGES.has(lang)) {
        return {
          stdout: '',
          stderr: `暂不支持语言「${language || '(空)'}」；当前执行器支持：${[...SUPPORTED_LANGUAGES].join('、')}`,
          exitCode: -1,
          timedOut: false,
        };
      }
      // 超时：居中限制到 [100, 120_000] 毫秒（子进程最小给 100ms 容错）
      const timeoutMs = Math.min(
        Math.max(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100),
        MAX_TIMEOUT_MS,
      );

      // 外部兜底超时（safeExecuteCode 已包一层，此处再保底以防 not-race 场景）
      return new Promise<CodeExecutionResult>((resolve) => {
        let settled = false;
        /** 一次结算：保证只 resolve/落定时器一次 */
        const finish = (result: CodeExecutionResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(killer);
          resolve(result);
        };

        // 子进程执行（-e 直接传代码，不经 shell，避免命令注入；windowsHide 防多余的终端窗口弹出；
        // env 禁色：防 stdout/stderr 带 ANSI 颜色码（LLM 读到的输出应干净可解析））
        const child = spawn(process.execPath, ['-e', code, '--no-warnings'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: options?.cwd,
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });

        let stdout = '';
        let stderr = '';
        // 输出流收集（容量由内核 RUN_CODE_RESULT_MAX_LEN 截断，本地仅累积）
        child.stdout.on('data', (d) => {
          stdout += String(d);
        });
        child.stderr.on('data', (d) => {
          stderr += String(d);
        });
        // 子进程启动失败（如 execPath 不可用）
        child.on('error', (err) => {
          finish({
            stdout,
            stderr: stderr || `执行失败：${err.message}`,
            exitCode: -1,
            timedOut: false,
          });
        });
        // 子进程正常退出：exitCode = code
        child.on('close', (code) => {
          finish({ stdout, stderr, exitCode: code ?? -1, timedOut: false });
        });

        // 硬超时：到点强杀子进程，返回 timedOut
        const killer = setTimeout(() => {
          // 已退出则无需杀
          if (child.exitCode !== null || child.killed) {
            finish({ stdout, stderr, exitCode: child.exitCode ?? -1, timedOut: false });
            return;
          }
          child.kill(); // Windows 下等价 TerminateProcess
          finish({ stdout, stderr, exitCode: -1, timedOut: true });
        }, timeoutMs);
        // 定时器在 finish 中清理（unref 防仅定时器残留阻塞进程退出）
        if (typeof killer.unref === 'function') killer.unref();
      });
    },
  };
}
