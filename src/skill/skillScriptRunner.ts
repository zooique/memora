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
import { sanitizeExternalText } from '@/agent/textSanitize.js';
import type { ScriptRuntime } from '@/utils/scanner.js';

/**
 * 收集侧**内存护栏**产物（可选）。
 *
 * 语义边界：这是**内存防线**产物（防 Node 进程被超长输出撑爆），与上下文侧防线
 * （调用方 `sanitizeExternalText` 的字符上限、`appendToolMessage` 入口关的 token 落盘）
 * **量纲与目的均不同，不是同一件事的两处实现**。
 *
 * ⚠️ 只挂在 `ScriptExecutionResult`（内核子进程收集侧），**不进 `CodeExecutionResult`**——
 * 后者是宿主 `ICodeExecutionProvider` 的公共返回类型，宿主执行器不产生这两个字段，
 * 挂上去只会给集成方制造「我该不该填」的噪声。
 */
export interface OutputTruncationInfo {
  /** 输出是否在收集侧被内存护栏截断 */
  truncated?: boolean;
  /** 被内存护栏丢弃的字节数（仅 `truncated` 为真时有意义） */
  discardedBytes?: number;
}

/**
 * 脚本执行结果 = 代码执行结果形态 + 收集侧护栏信息
 *
 * 复用 `CodeExecutionResult`（SSOT 不重复定义四个基础字段），仅在脚本侧**扩展**——
 * 宿主 `run_code` 链路不受影响（字段可选，传纯 `CodeExecutionResult` 即合规）。
 */
export type ScriptExecutionResult = CodeExecutionResult & OutputTruncationInfo;

/** 默认执行超时（毫秒）：脚本常用交互/构建任务在 1 分钟内完成；超长任务由 LLM 传 timeoutMs */
const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * **同步**执行等待上限（毫秒）：适配脚本内 API 调用/批处理等长耗时任务。
 * 上限只保护「阻塞 LLM」的同步路径——防 LLM 传天文数字把会话挂死。
 */
const SYNC_MAX_TIMEOUT_MS = 600_000;
/**
 * **后台**收割时限上限（毫秒）：长构建 / 冷缓存依赖安装是后台核心场景，600s 明显不够。
 *
 * 与 `SYNC_MAX_TIMEOUT_MS` **异义勿合并**（对齐 builtinToolHandlers「异义同值勿误合并」纪律）：
 * 两者风险性质不同（同步阻塞 LLM vs 后台不阻塞），各自独立演进，合并会让任一侧的
 * 调整误伤另一侧。
 */
const BACKGROUND_MAX_TIMEOUT_MS = 1_800_000;

/**
 * 收集侧**内存护栏**上限（字节）：stdout + stderr 共享该预算，超限停止拼接并累计丢弃量。
 *
 * 量纲纪律（勿改写成字符数）：本常量防的是 **Node 进程内存膨胀**，量纲必须是字节；
 * 上下文侧另有两层防线——调用方的 `sanitizeExternalText(x, 20_000)`（字符）与
 * `appendToolMessage` 入口关的 `SINGLE_TOOL_RESULT_MAX_TOKENS`（token，含落盘）。
 * 三者量纲各异、各司其职：**禁止**把本常量并入或对齐那两层（并列 = 双真源腐化）。
 *
 * 取值理由：2MB 对「脚本/命令刷屏」已是数量级冗余（下游上下文层只留 20_000 字符），
 * 同时远低于 Node 默认堆上限，不会成为新的 OOM 面。
 */
const MAX_COLLECTED_OUTPUT_BYTES = 2 * 1024 * 1024;

/**
 * 超时钳制真理源（SSOT）：实际超时 = clamp(timeoutMs, 1s, maxMs)
 *
 * 执行侧（计时器时长）与文案侧（formatScriptResult 的「超过 Ns」）必须同源，
 * 否则两处漂移会重现「实际 60s 超时却告知超过 600s」的谎报。
 *
 * **上限由调用方按模式选常量**（同步 `SYNC_MAX_TIMEOUT_MS` / 后台
 * `BACKGROUND_MAX_TIMEOUT_MS`），函数本身仍是单参纯函数——不按模式内部分支
 * （分支 = 同一语义两套判定，属并列腐化）。
 *
 * @param timeoutMs 调用方传入的超时（毫秒；toolExecutor 由 LLM 的 timeout_ms 秒值 ×1000 得到）
 * @param maxMs 上限（默认同步上限）
 * @returns 钳制后的实际超时（毫秒，落在 [1_000, maxMs] 区间内）
 */
function normalizeTimeoutMs(timeoutMs: number, maxMs: number = SYNC_MAX_TIMEOUT_MS): number {
  return Math.min(Math.max(timeoutMs, 1_000), maxMs);
}

/**
 * 后台收割时限钳制：与同步共用 `normalizeTimeoutMs` 同一实现，只换上限常量。
 *
 * 单点是刻意的：后台若另写一个 clamp，就会与同步侧的「1s 下限 / 上限语义」分叉，
 * 两处漂移后难以判断哪边是真理源。
 */
export function normalizeBackgroundTimeoutMs(timeoutMs: number): number {
  return normalizeTimeoutMs(timeoutMs, BACKGROUND_MAX_TIMEOUT_MS);
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
 * taskkill 参数构造（同步 / 异步两形态**同源**单一处）
 *
 * 为什么抽出来：异步原语（运行时收割）与同步原语（进程退出钩子兜底）都要打同一组参数，
 * 各写一份 = 第二真理源（改一处漏一处，无测试报警）。
 */
function buildTaskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

/**
 * 进程树强杀原语（跨平台，零新依赖）
 *
 * 缺口事实：Node spawn 的 `timeout` 选项到期只 kill **直接子进程**——`cmd /c npm test`
 * 这类经 shell 派发的场景，孙进程（npm/node/vitest）变孤儿继续跑（占端口 / 锁文件）。
 * 故不再依赖 spawn timeout，改为手动计时 + 本原语（同步与后台路径统一）。
 *
 * - Windows：`taskkill /pid <pid> /T /F`（/T = 进程树）；taskkill 自身失败（权限不足 /
 *   进程已退出）降级为 `child.kill()`——只及直接子进程，属**降级**而非等价，如实记录。
 * - POSIX：spawn 时 `detached: true` 使子进程自成进程组（pgid == pid），
 *   故 `process.kill(-pid, 'SIGKILL')` 杀整组；失败降级同上。
 *
 * ⚠️ 本原语是**私有**实现：宿主 codeExecutor 属另一进程上下文，够不着本函数；其同款缺口
 * （`child.kill()` 单杀）已独立登记立项（方案文档 命令执行能力方案 §13.6 未决一）——**禁止**在宿主侧复制
 * 一份实现（双轨各造 = 并列腐化），要么阶段 2 一起提成内核内部共享原语，要么维持登记。
 */
function killProcessTree(child: childProcess.ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const killer = childProcess.spawn('taskkill', buildTaskkillArgs(pid), {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', (err) => {
      logger.warn({ pid, err }, 'taskkill 启动失败，降级为 kill 直接子进程');
      child.kill();
    });
    killer.on('close', (code) => {
      if (code === 128) {
        // 128 = ERROR_PROC_NOT_FOUND（Windows taskkill 语义）：目标进程已退出——
        // 强杀目标已达成（正常竞态：探活与 taskkill 之间进程自然结束），
        // 静默结束，不当降级也不打 WARN（2026-10-03 实锤：门禁日志噪音源）。
        // 主 pid 已死时孙进程成孤儿无人收割——child.kill 够不着，属残余边界
        // （Windows pid 复用窗口下的 taskkill 误杀风险同样在此，见 命令执行能力方案 §13.6-A 登记）。
        return;
      }
      if (code !== 0) {
        logger.warn({ pid, code }, 'taskkill 未成功结束进程树，降级为 kill 直接子进程');
        child.kill();
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    logger.warn({ pid, err }, '进程组强杀失败，降级为 kill 直接子进程');
    child.kill('SIGKILL');
  }
}

/**
 * 同步杀树原语——**专供** `process.on('exit')` 钩子（`BackgroundTaskRegistry` 兜底收割）
 *
 * 为什么必须同步（与 `killProcessTree` 并存的原因，不是冗余双轨）：
 *   exit 钩子返回后 Node 立即退出，异步 `spawn` 的 fork 由 libuv 线程池派发，
 *   可能**来不及完成** taskkill 就随宿主进程消失——杀树静默失败（假阴性）。
 *   `execFileSync` 在当前进程内同步等 taskkill 执行完，钩子返回前杀树已落地。
 *
 * - Windows：`execFileSync('taskkill', …)`；退出码 128（目标已退出）= 强杀已达成，静默；
 *   其他失败（权限不足等）降级 `child.kill()` 并记 WARN。
 * - POSIX：`process.kill(-pid, 'SIGKILL')` 本就是同步系统调用，语义与异步版一致。
 *
 * 调用纪律：只在 exit 钩子（或等价的「进程即将终止、无后续异步机会」语境）使用；
 * 常规运行时收割仍走 `killProcessTree`（异步版有完整 error/close 事件处理）。
 */
export function killProcessTreeSync(child: childProcess.ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      childProcess.execFileSync('taskkill', buildTaskkillArgs(pid), {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { status?: number }).status;
      if (code === 128) return; // 目标已退出 = 强杀已达成（与异步版 128 语义同源）
      logger.warn({ pid, code }, 'exit 兜底 taskkill 未成功，降级为 kill 直接子进程');
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (err) {
    logger.warn({ pid, err }, 'exit 兜底进程组强杀失败，降级为 kill 直接子进程');
    child.kill('SIGKILL');
  }
}

/**
 * 输出收集器（内存护栏）：stdout/stderr **共享**一个字节预算，超限即停止拼接并累计丢弃量。
 *
 * 只在收集侧生效。**不做「头尾保留」**：尾部保留在此处是无效复杂度——下游
 * `sanitizeExternalText` 的头截断会把尾部抹掉（方案文档 命令执行能力方案 §13.6-B / 缺口 D）。
 */
function createOutputCollector(limitBytes: number) {
  let collected = 0;
  let discarded = 0;
  return {
    /** 追加一个 chunk，返回**应当拼入**的部分（已超限返回空串） */
    push(chunk: string): string {
      const size = Buffer.byteLength(chunk, 'utf-8');
      const remaining = limitBytes - collected;
      if (remaining <= 0) {
        discarded += size;
        return '';
      }
      if (size <= remaining) {
        collected += size;
        return chunk;
      }
      // 部分容纳：按字节精确切分后回退到 UTF-8 字符边界（续字节形如 0b10xxxxxx），
      // 避免切出半个多字节字符产生 U+FFFD 污染脚本输出
      const buf = Buffer.from(chunk, 'utf-8');
      let end = remaining;
      while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
      const kept = buf.subarray(0, end).toString('utf-8');
      const keptBytes = Buffer.byteLength(kept, 'utf-8');
      collected += keptBytes;
      discarded += size - keptBytes;
      return kept;
    },
    get discardedBytes(): number {
      return discarded;
    },
    get truncated(): boolean {
      return discarded > 0;
    },
  };
}

/**
 * 统一的 spawn 选项（进程治理同源）
 *
 * 同步与后台共用一份：防止「同步一套选项 / 后台另一套」的漂移——一旦漂移，
 * 杀树 / detached / 禁色 / windowsHide 会各自演化出不同行为。
 */
function buildSpawnOptions(cwd?: string): childProcess.SpawnOptions {
  return {
    // ⚠️ 不用 spawn 原生 `timeout` 选项：它到期只 kill **直接子进程**，
    // 经 shell 派发（`cmd /c npm test`）时孙进程会变孤儿继续跑。改为手动计时
    // + `killProcessTree` 强杀整棵树（方案文档 命令执行能力方案 §13.6-A）。
    // POSIX `detached`：子进程自成进程组（pgid == pid），收割按 -pid 杀组；
    // Windows 不需要 detached（走 taskkill /T /F）。
    ...(process.platform === 'win32' ? {} : { detached: true }),
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
  };
}

/** 进程治理挂载参数 */
interface GovernanceOptions {
  /** 超时收割毫秒；**null = 不限时**（后台缺省语义） */
  timeoutMs: number | null;
  /** 日志标签（脚本路径或命令） */
  logLabel: string;
  /** 终局回调（**只调用一次**） */
  resolve: (result: ScriptExecutionResult & { enoent: boolean }) => void;
}

/**
 * 给已 spawn 的子进程挂上**统一治理**：输出收集（内存护栏）+ 超时杀树 + 终局回调。
 *
 * 同步（await 终局）与后台（不 await，监听终局）两条路径共用同一实现——
 * 「同步一套 / 后台另一套」是并列腐化，进程治理必须只有一处。
 */
function attachGovernance(
  child: childProcess.ChildProcess,
  opts: GovernanceOptions,
): { peek: () => ScriptExecutionResult & { enoent: boolean } } {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let enoent = false;
  /** 是否已结算（超时强杀与 close/error 竞争时的单点守卫） */
  let settled = false;
  /** 收集侧内存护栏：stdout/stderr 共享字节预算（方案文档 命令执行能力方案 §13.6-B） */
  const collector = createOutputCollector(MAX_COLLECTED_OUTPUT_BYTES);

  child.stdout?.on('data', (data: Buffer) => {
    stdout += collector.push(data.toString('utf-8'));
  });
  child.stderr?.on('data', (data: Buffer) => {
    stderr += collector.push(data.toString('utf-8'));
  });

  const snapshot = (exitCode: number): ScriptExecutionResult & { enoent: boolean } => ({
    stdout,
    stderr,
    exitCode,
    timedOut,
    enoent,
    truncated: collector.truncated,
    discardedBytes: collector.discardedBytes,
  });

  // 硬超时：到点强杀**进程树**并立即结算——对齐宿主 codeExecutor 的 killer 形态
  // （不等 close，避免 taskkill 异步失败 / 子进程僵死时终局永不发生）
  let killer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs !== null) {
    killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      logger.warn(
        { logLabel: opts.logLabel, timeoutMs: opts.timeoutMs },
        '子进程执行超时，已强杀进程树',
      );
      killProcessTree(child);
      opts.resolve(snapshot(-1));
    }, opts.timeoutMs);
    // 定时器不阻塞宿主进程退出（对齐宿主 codeExecutor 的 killer.unref 语义）
    if (typeof killer.unref === 'function') killer.unref();
  }

  child.on('error', (err) => {
    // ENOENT = 命令不存在（Windows python 9009 场景：现代 Python 只装 py 启动器）
    // 记标记供 L2 fallback，其余错误原样返回
    enoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    logger.error({ logLabel: opts.logLabel, err }, '子进程执行错误');
    if (settled) return;
    settled = true;
    if (killer) clearTimeout(killer);
    opts.resolve({ ...snapshot(-1), stderr: stderr || String(err) });
  });

  child.on('close', (code) => {
    if (settled) return;
    settled = true;
    if (killer) clearTimeout(killer);
    opts.resolve(snapshot(code ?? 0));
  });

  // 中途快照（后台 kill_command 需要「截至终止时的已捕获输出」）：
  // 退出码在进程未退出时取 -1，timedOut / 护栏标记随当时状态
  return { peek: () => snapshot(child.exitCode ?? -1) };
}

/**
 * 裸命令 → shell 派发形态（纯函数，平台参数化可测）
 *
 * Windows 经 `cmd /c`，类 Unix 经 `sh -c`。**不在此引入 powershell/bash 第二档**——
 * 那是宿主 shell 选型的议题，内核只做「命令 → 平台默认 shell」的单点映射。
 *
 * ⚠️ **本函数是「命令实际派发到哪个 shell」的唯一真源**（2026-10-03 审查 P0 锚点）：
 * 宿主把该事实注入 system prompt「## 运行环境 · 默认 Shell」段供模型避坑，
 * 两侧若不一致 = 对模型说假话（曾发生：宿主报 `PowerShell` 而此处是 `cmd`，
 * 模型写 PowerShell 语法却由 cmd 执行，每次必败）。
 * **改本映射必须同批核对宿主镜像**：`hosts/memora-vscode/src/extension/host/environmentProvider.ts`
 * 的 `shell` 字段（与 `run_command` / `run_project_script` 的 shell 档共用此派发形态）。
 */
export function resolveShellCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  return platform === 'win32'
    ? { command: 'cmd', args: ['/c', command] }
    : { command: 'sh', args: ['-c', command] };
}

/**
 * 执行裸 shell 命令（**同步**）：与脚本执行共用同一套进程治理（命令执行能力方案 §13.6-A/B），
 * 只多一层「命令 → shell 派发」解析。后台形态见 `backgroundTasks` 注册表——
 * 同一治理实现的另一条消费路径，不是另一套实现。
 */
export async function runShellCommand(
  command: string,
  cwd?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ScriptExecutionResult> {
  const { command: shell, args } = resolveShellCommand(command);
  return new Promise((resolve) => {
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(shell, args, buildSpawnOptions(cwd));
    } catch (err) {
      logger.error({ command, err }, '启动命令进程失败');
      resolve({
        stdout: '',
        stderr: `启动失败: ${(err as Error).message}`,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }
    attachGovernance(child, {
      timeoutMs: normalizeTimeoutMs(timeoutMs),
      logLabel: command,
      resolve,
    });
  });
}

/**
 * 启动**后台**裸命令（立即返回，不等待进程结束）
 *
 * @param command 裸命令
 * @param cwd 工作目录
 * @param timeoutMs 收割时限（**null = 不限时**；后台任务可活过 turn，见
 *        `BackgroundTaskRegistry.detachAll`）；由调用方按
 *        `BACKGROUND_MAX_TIMEOUT_MS` 钳制后传入（钳制真源不在本函数内分支）
 * @param onSettled 终局回调（完成 / 超时 / 出错均经此，**只调用一次**）
 * @returns 句柄：killNow = 中途终止（异步杀树原语，运行时收割用）；
 *          killNowSync = 同步杀树原语（**仅** exit 钩子兜底用，见 `killProcessTreeSync`）
 */
export function startBackgroundCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number | null,
  onSettled: (result: ScriptExecutionResult) => void,
): { killNow: () => void; killNowSync: () => void; peek: () => ScriptExecutionResult } {
  const { command: shell, args } = resolveShellCommand(command);
  let child: childProcess.ChildProcess;
  try {
    child = childProcess.spawn(shell, args, buildSpawnOptions(cwd));
  } catch (err) {
    logger.error({ command, err }, '启动后台命令进程失败');
    onSettled({
      stdout: '',
      stderr: `启动失败: ${(err as Error).message}`,
      exitCode: -1,
      timedOut: false,
    });
    return {
      killNow: () => undefined,
      killNowSync: () => undefined,
      peek: () => ({ stdout: '', stderr: '', exitCode: -1, timedOut: false }),
    };
  }
  const governance = attachGovernance(child, {
    timeoutMs,
    logLabel: command,
    resolve: onSettled,
  });
  return {
    killNow: () => killProcessTree(child),
    killNowSync: () => killProcessTreeSync(child),
    peek: governance.peek,
  };
}

/**
 * 执行技能脚本：在隔离子进程中运行，收集 stdout/stderr/exitCode/timedOut
 *
 * @param scriptPath 脚本绝对路径
 * @param runtime 运行时（node/python/shell 白名单三档）
 * @param args 传给脚本的参数数组
 * @param timeoutMs 超时（毫秒，限制在 [1s, SYNC_MAX_TIMEOUT_MS] 内）
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

  // 超时限制在 [1s, SYNC_MAX_TIMEOUT_MS] 内（与超时文案同源，见 normalizeTimeoutMs；
  // 后台走 BACKGROUND_MAX_TIMEOUT_MS，见 normalizeBackgroundTimeoutMs）
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
      let child: childProcess.ChildProcess;
      try {
        child = childProcess.spawn(cmd, runArgs, buildSpawnOptions(cwd));
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

      // 治理挂载（单点）：输出收集 + 超时杀树 + 终局回调，与后台命令同一实现
      attachGovernance(child, {
        timeoutMs: effectiveTimeout,
        logLabel: scriptPath,
        resolve,
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

/** formatExecutionResult 的三态标签配置：前缀与详情文案（run_skill_script / run_code / run_command 各自定制） */
export interface ExecutionResultFormatLabels {
  /** 三态前缀标签（'SCRIPT' → [SCRIPT_TIMEOUT]/[SCRIPT_ERROR]；'CODE' → [CODE_TIMEOUT]/[CODE_ERROR]；'COMMAND' → [COMMAND_TIMEOUT]/[COMMAND_ERROR]） */
  kind: 'SCRIPT' | 'CODE' | 'COMMAND';
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
  result: CodeExecutionResult & OutputTruncationInfo,
  labels: ExecutionResultFormatLabels,
): string {
  // 截断诚实化：收集侧内存护栏生效时必须显式告知丢弃量——静默截断会让 LLM 以为
  // 所见即完整输出（假阴性；与 read_file 分段脚注「已显示第 X–Y 行」同一纪律）
  const truncatedNote = result.truncated
    ? `\n[OUTPUT_TRUNCATED] 输出超过收集侧内存上限，已停止收集（丢弃 ${result.discardedBytes ?? 0} 字节，所见非完整输出）`
    : '';
  if (result.timedOut) {
    return `[${labels.kind}_TIMEOUT] ${labels.timeoutDetail}\nstdout: ${result.stdout}\nstderr: ${result.stderr}${truncatedNote}`;
  }
  if (result.exitCode !== 0) {
    return `[${labels.kind}_ERROR] ${labels.errorDetail}（退出码: ${result.exitCode}）\nstdout: ${result.stdout}\nstderr: ${result.stderr}${truncatedNote}`;
  }
  // 成功：优先 stdout，stderr 附加
  const output = result.stdout || '(无输出)';
  if (result.stderr) {
    return `${output}\n[stderr] ${result.stderr}${truncatedNote}`;
  }
  return `${output}${truncatedNote}`;
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

/**
 * 同步命令的**实际生效超时**（毫秒）：run_command 同步路径的钳制真源入口。
 *
 * 存在的理由是「执行侧与文案侧同源」这条硬约束：`runShellCommand` 内部钳制，
 * 若文案侧自行 clamp 就会重演「实际 60s 超时却告知超过 600s」的谎报。
 * 调用方拿本值同时喂给执行与格式化，两侧恒等。
 *
 * @param timeoutMs LLM 传入值（undefined/非法 → 取默认 60s）
 */
export function resolveCommandTimeoutMs(timeoutMs: number | undefined): number {
  return normalizeTimeoutMs(
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  );
}

/**
 * 命令结果进入上下文的**定长真源**（字符层）+ 格式化收口
 *
 * **定长为何住在格式化层而非调用方**：命令结果有**两个消费面**——① `run_command` 的工具
 * 返回值 ② 后台命令完成的回流通知（`formatBackgroundTaskNotice`）。上限若住在
 * toolExecutor 的模块私有常量里，第二个消费面就看不到它 ⇒ 回流路径无上限
 * （2MB 内存护栏放行的输出可直灌上下文）。定义在两者的**共同下游**，两个消费面
 * 自动一致、无法漏配。
 *
 * 量纲纪律：与 `MAX_COLLECTED_OUTPUT_BYTES`（**字节**，防 Node 进程内存膨胀）、
 * `SINGLE_TOOL_RESULT_MAX_TOKENS`（**token**，入口关落盘）三者各异，**禁止互相对齐或合并**。
 *
 * 超时文案用**调用方传入的本次实际生效超时**（`resolveCommandTimeoutMs` 的产物）；
 * 传 undefined 表示本次未设收割时限（后台缺省），此时只说「超时」不编造秒数——
 * 报一个不存在的秒数比不报更坏（LLM 会据此误判该等多久）。
 */
const COMMAND_RESULT_MAX_CHARS = 20_000;
/** 命令结果尾部保留（缺口 D 同款：构建/测试失败原因常在尾部） */
const COMMAND_RESULT_TAIL_CHARS = 4_000;

/**
 * 格式化命令执行结果为可读字符串（run_command 同步 / kill_command 回传 / 后台回流共用）
 *
 * **定长真源在此**（见 `COMMAND_RESULT_MAX_CHARS`）：本函数是命令结果进上下文的唯一收口，
 * 调用方**不要**再各自套一层上限——那会让「限了多少」在两处漂移。
 *
 * 超时文案用**调用方传入的本次实际生效超时**（`resolveCommandTimeoutMs` 的产物）；
 * 传 undefined 表示本次未设收割时限（后台缺省），此时只说「超时」不编造秒数——
 * 报一个不存在的秒数比不报更坏（LLM 会据此误判该等多久）。
 */
export function formatCommandResult(
  result: ScriptExecutionResult,
  effectiveTimeoutMs?: number,
): string {
  return sanitizeExternalText(
    formatExecutionResult(result, {
      kind: 'COMMAND',
      timeoutDetail:
        effectiveTimeoutMs === undefined
          ? '命令执行超时'
          : `命令执行超时（超过 ${Math.round(effectiveTimeoutMs / 1000)}s）`,
      errorDetail: '命令执行失败',
    }),
    COMMAND_RESULT_MAX_CHARS,
    COMMAND_RESULT_TAIL_CHARS,
  );
}

/**
 * 格式化「被主动终止」的命令输出（kill_command 专用）
 *
 * ⚠️ 刻意**不走** `formatCommandResult`：进程被强杀时**没有退出码**——
 * `peek()` 取的 -1 意思是「尚未退出」，不是「退出码 -1」。丢给三态格式化会被判成
 * `[COMMAND_ERROR] 命令执行失败（退出码: -1）`，与 kill_command 头部的「已终止」
 * 自相矛盾（对 LLM 是谎报：它会以为命令自己挂了，而不是被我们停掉）。
 *
 * 因此这里只如实列出截至终止时已捕获的输出，不声称任何退出状态。定长口径与
 * `formatCommandResult` **同源**（同一对常量）——两个函数对「多少字进上下文」的
 * 判断若有差异，LLM 就会在同一会话里看到两种长度 policy。
 */
export function formatKilledCommandOutput(result: ScriptExecutionResult): string {
  const stdout = result.stdout || '(无输出)';
  const stderr = result.stderr ? `\n[stderr] ${result.stderr}` : '';
  const truncatedNote = result.truncated
    ? `\n[OUTPUT_TRUNCATED] 输出超过收集侧内存上限，已停止收集（丢弃 ${result.discardedBytes ?? 0} 字节，所见非完整输出）`
    : '';
  return sanitizeExternalText(
    `stdout: ${stdout}${stderr}${truncatedNote}`,
    COMMAND_RESULT_MAX_CHARS,
    COMMAND_RESULT_TAIL_CHARS,
  );
}
