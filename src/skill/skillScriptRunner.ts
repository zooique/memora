/**
 * 技能脚本执行器 — L3 脚本运行时。
 * 三级渐进披露 L3：脚本在宿主环境（隔离子进程）执行，源代码不入 LLM 上下文，
 * 只有执行结果（stdout/stderr）作为工具返回值注入。
 * 安全模型：继承宿主用户环境变量（用户会话环境——脚本可读项目所需配置与用户 shell 环境；
 *   密钥默认经 SecretStorage→配置对象注入、不经 env（宿主默认路径）；env 回退配置模式
 *   （MEMORA_API_KEY 等，security_rules 支持）下 key 在进程 env、对脚本可见——owner 信任
 *   模型（默认自动批准）+ 脚本来源审阅（判据 B）为边界，视同用户本地 shell 语义）+ 超时
 *   限制（默认 60s，最大 600s——适配脚本内 API 调用/批处理长耗时）+ 白名单 runtime（node/python/shell）+ Windows 隐藏窗口
 *   （windowsHide:true，不弹 conhost）。
 * 注：当前为简单子进程执行，非完整沙箱（文件系统/网络隔离由宿主在生产环境实现）。
 */
import * as childProcess from 'node:child_process';
import type { CodeExecutionResult } from '@/code-exec/types.js';
import { logger } from '@/logging/logger.js';
import type { ScriptRuntime } from '@/utils/scanner.js';

/** 脚本执行结果（= CodeExecutionResult，复用代码执行结果形态，SSOT 不重复定义） */
export type ScriptExecutionResult = CodeExecutionResult;

/** 默认执行超时（毫秒）：脚本常用交互/构建任务在 1 分钟内完成；超长任务由 LLM 传 timeoutMs */
const DEFAULT_TIMEOUT_MS = 60_000;
/** 最大执行超时（毫秒）：适配脚本内 API 调用/批处理等长耗时任务 */
const MAX_TIMEOUT_MS = 600_000;

/**
 * 超时钳制真理源（SSOT）：实际超时 = clamp(timeoutMs, 1s, MAX_TIMEOUT_MS)
 *
 * 执行侧（spawn 的 timeout 选项）与文案侧（formatScriptResult 的「超过 Ns」）必须同源，
 * 否则两处漂移会重现「实际 60s 超时却告知超过 600s」的谎报。
 *
 * @param timeoutMs 调用方传入的超时（毫秒；toolExecutor 由 LLM 的 timeout_ms 秒值 ×1000 得到）
 * @returns 钳制后的实际超时（毫秒，落在 [1_000, MAX_TIMEOUT_MS] 区间内）
 */
function normalizeTimeoutMs(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);
}

/**
 * Windows 平台 shell 档脚本守卫
 *
 * 缺陷事实链：`.sh` → runtime `shell`（scanner.SCRIPT_RUNTIME_MAP）→ win32 派发
 * `cmd /c <path>`（resolveCommand shell 分支）——而 `.sh` 不是 cmd 原生可执行类型
 * （只有 `.bat`/`.cmd` 是），命令退到「Windows 关联程序」路径：status=0 但
 * stdout/stderr 全空（静默空跑）。`formatExecutionResult` 见 status=0 向模型报
 * 「成功」→ 模型认定脚本已跑完 → 静默失败。
 * `.ps1` 同理：`cmd /c` 不起 PowerShell，同样静默空跑（不新增 powershell runtime 档——
 * 那是新能力，留待宿主 shell 选型一并设计）。
 *
 * 本守卫改的是「喂给判据的事实」（Win 下喂进 spawn 的 `cmd /c foo.sh` 只会制造假
 * status=0），非判据本身——属止血。POSIX 不受影响（`sh <path>` 合法）。
 *
 * @param scriptPath 脚本路径
 * @param runtime 运行时（node/python/shell）
 * @param platform 当前平台（win32 才拦截；参数化便于测试）
 * @returns 命中拦截返回显式错误文案（含替代方案），否则 null
 */
export function guardWindowsShellScript(
  scriptPath: string,
  runtime: ScriptRuntime,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== 'win32' || runtime !== 'shell') return null;
  const ext = scriptPath.slice(scriptPath.lastIndexOf('.')).toLowerCase();
  // cmd 原生可执行类型：批处理文件（与 scanner SCRIPT_RUNTIME_MAP 注释同源，
  // win32 派发 `cmd /c` 实测 status=0 + 输出正确）
  if (ext === '.bat' || ext === '.cmd') return null;
  return (
    `Windows 平台 shell 档仅支持 .bat/.cmd（cmd 原生可执行类型）。当前脚本扩展名 "${ext}" ` +
    (ext === '.ps1'
      ? '(.ps1 静默空跑：cmd /c 不起 PowerShell，且内核未接入 PowerShell runtime档)。'
      : '(shell 档在 Windows 依赖 sh/bash 解释器——本机无 Git Bash 时会静默空跑：退出码 0 但 stdout/stderr 全空，不是执行成功)。') +
    '请改用跨平台脚本 .mjs/.js/.py；确需 Windows 批处理用 .bat/.cmd。'
  );
}

/**
 * 执行技能脚本：在隔离子进程中运行，收集 stdout/stderr/exitCode/timedOut
 *
 * @param scriptPath 脚本绝对路径
 * @param runtime 运行时（node/python/shell 白名单三档）
 * @param args 传给脚本的参数数组
 * @param timeoutMs 超时（毫秒，限制在 [1s, MAX_TIMEOUT_MS] 内）
 * @param cwd 子进程工作目录（可选；run_project_script 以项目根为 cwd，
 *        使项目脚本可加载项目本地依赖/相对数据文件）
 * @param nodePath node 可执行文件路径（可选，缺省 'node' 走 PATH）——供宿主注入真实
 *        node 路径用。
 *        ⚠️ 宿主尚未接入——`hosts/memora-vscode` 零注入点，故实际恒走缺省 `'node'`。
 *        且真解不止「传个路径」：Electron 宿主（VS Code）的
 *        `process.execPath` 指向应用二进制，需配 `ELECTRON_RUN_AS_NODE` 一类环境变量才能以
 *        node 语义执行 `.mjs` **文件**，而内核只收路径、不收环境（边界铁律：内核不持有平台知识）。
 *        ⇒ 真解 = 接口扩展（宿主上报运行时环境，内核零解释转发），留待与宿主 shell 选型同批。
 *        此处保留该可选参数：接入点已就绪，扩展时无须再动调用链。
 */
export async function runSkillScript(
  scriptPath: string,
  runtime: ScriptRuntime,
  args: string[] = [],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd?: string,
  nodePath?: string,
): Promise<ScriptExecutionResult> {
  // win32 + shell + 非 .bat/.cmd → 在 spawn 前显式拒绝，
  // 不让假 status=0 进入 formatExecutionResult（喂给判据的事实必须为真）
  const guardError = guardWindowsShellScript(scriptPath, runtime, process.platform);
  if (guardError) {
    return { stdout: '', stderr: guardError, exitCode: -1, timedOut: false };
  }

  // 超时限制在 [1s, MAX_TIMEOUT_MS] 内（与超时文案同源，见 normalizeTimeoutMs）
  const effectiveTimeout = normalizeTimeoutMs(timeoutMs);

  const { command, args: cmdArgs } = resolveCommand(runtime, scriptPath, args, nodePath);

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
          // 继承宿主用户环境变量（不走 PATH/HOME 最小白名单——
          // 项目脚本读用户环境（API KEY/PATH/工作区变量）是合理需求；密钥默认经
          // SecretStorage→config 不经 env，env 回退模式下 key 在 env 属 owner 信任
          // 语义（见文件头安全模型）。对齐宿主 codeExecutor 持久会话环境语义）
          // 禁子进程彩色输出：FORCE_COLOR:0/NO_COLOR:1 源头禁色（对齐宿主 codeExecutor
          // 同构）；回流净化由 toolExecutor sanitizeExternalText 兜底剥残留 ANSI——
          // 源头禁根因 + 通用防御两层不冲突
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

  const result = await runOnce(command, cmdArgs);

  // Windows python 不可用兜底链。python 命令在本机
  // 不可用有两种形态：① spawn ENOENT（现代 Python 只装 py 启动器、无 python 命令）；
  // ② 退出码 9009（spawn 命中 Windows Store 空壳启动器 python.exe，它启动即退出 9009；
  // 非 ENOENT，故不能只看 enoent 标记）。命中即在两个候选解释器间逐级替换重试：
  //   ① `py -3`（py 启动器）② `cmd /c python`（shell 派发——cmd 按 PATHEXT 解析 .bat shim，
  //   pyenv/conda 的 python.bat 由此生效；原生 spawn 不解析 .bat 的跨层缺环在此补上）。
  if (
    shouldFallbackPythonToPy(runtime, process.platform) &&
    isPythonUnavailable(result, process.platform)
  ) {
    // ① py 启动器重试：任一成功（上已判定不可用、此命令=解释器本体）即返回
    const pyResult = await runOnce('py', ['-3', scriptPath, ...args]);
    if (!isPythonUnavailable(pyResult, process.platform)) {
      return pyResult;
    }
    // ② shell 派发兜底：cmd /c python —— 经 cmd 的 PATHEXT 解析让 pyenv/conda shim 生效
    return await runOnce('cmd', ['/c', 'python', scriptPath, ...args]);
  }
  return result;
}

/**
 * 兜底判定：python runtime 在 Windows 下进入兜底链（纯函数，平台参数化可测）
 *
 * @param runtime  脚本运行时
 * @param platform 当前平台（process.platform；参数化便于测试）
 * @returns 是否应进入「py -3 → cmd /c python」兜底链
 */
export function shouldFallbackPythonToPy(
  runtime: ScriptRuntime,
  platform: NodeJS.Platform,
): boolean {
  return runtime === 'python' && platform === 'win32';
}

/**
 * python 是否不可用（判定「要不要继续走兜底链」）
 *
 * 两种失败形态任一命中即不可用：
 *   ① enoent —— spawn 未找到 python 命令（PATH 缺 python / 只装 py 启动器）
 *   ② exitCode 9009 —— spawn 命中 Windows Store 空壳启动器 python.exe，它非文件缺失、
 *     而是启动后立即以 9009（Windows「命令未找到」）退出。此形态 spawn 不报 ENOENT、
 *     `enoent` 标记为 false，必须靠退出码识别，否则 python 被误判「执行失败」而非「不可用」。
 *
 * @param result  单次执行结果（含 enoent/exitCode 标记）
 * @param platform 当前平台（win32 之外的平台不判 9009——非 Windows「命令未找到」语义）
 */
export function isPythonUnavailable(
  result: ScriptExecutionResult & { enoent: boolean },
  platform: NodeJS.Platform,
): boolean {
  if (platform !== 'win32') return result.enoent;
  return result.enoent || result.exitCode === 9009;
}

/**
 * 根据 runtime 解析执行命令：node/python 直接执行，shell 依平台用 cmd /c（Windows）或 sh -c
 *
 * @param nodePath node 可执行文件路径（可选）：缺省 'node'（走 PATH 查找）。
 *        供给方（宿主）可注入真实 node 路径（如 VS Code 内置 node / 用户配置的 node），
 *        避免「系统无独立 node → .js/.mjs 技能脚本 ENOENT」。
 */
function resolveCommand(
  runtime: ScriptRuntime,
  scriptPath: string,
  args: string[],
  nodePath?: string,
): { command: string; args: string[] } {
  switch (runtime) {
    case 'node':
      return { command: nodePath ?? 'node', args: [scriptPath, ...args] };
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
 *
 * 超时文案的「超过 Ns」取本次**实际**超时（经 normalizeTimeoutMs 钳制），不再恒写上限 600s：
 * 默认 60s 超时却报「超过 600s」是对 LLM 的谎报，会诱导它盲目调大 timeout_ms 重试。
 *
 * @param result 执行结果
 * @param timeoutMs 本次实际超时（毫秒）；省略则用 DEFAULT_TIMEOUT_MS（与执行侧默认同源）
 */
export function formatScriptResult(
  result: ScriptExecutionResult,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): string {
  return formatExecutionResult(result, {
    kind: 'SCRIPT',
    timeoutDetail: `脚本执行超时（超过 ${Math.round(normalizeTimeoutMs(timeoutMs) / 1000)}s）`,
    errorDetail: '脚本执行失败',
  });
}
