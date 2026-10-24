/**
 * MCP 命令可用性预检（`command` / `args[0]` / `cwd` 的静态判据）
 *
 * **为什么要有这个文件**：拉起失败时 MCP SDK 一律抛
 * `MCP error -32000: Connection closed`（2026-10-24 实测：命令不存在、相对路径当命令、
 * 脚本路径写错、漏写 node 前缀，四种错法签名完全相同），真原因只在子进程 stderr 里
 * 且中文 Windows 下还是 GBK。用户在面板上看到的是「连接已关闭」，无从判断是路径问题。
 * ⇒ 把**能在拉起前判定的**部分收在拉起前这一处（**唯一生产调用点 = `connectionManager.connect`**），
 * 用静态判据给出人话原因。保存路径**刻意不预检**：探测要 spawnSync（最长 5s），放进保存会把
 * 写配置阻塞成「点了保存卡住」，而保存侧只负责字段完整性与合法性（`configProblem`）；
 * 必然失败留给拉起时由本文件说穿。
 *
 * **判据边界（只判「静态可判」，不判「能不能跑通」）**：
 *   - 判：命令为空 / 路径形态但文件不存在 / 指向脚本却当命令 / 裸名不在 PATH / cwd 不存在；
 *   - 不判：可执行位（Windows 无此语义）、依赖缺失、端口占用、握手能力——那些只能靠拉起。
 * 这条边界必须守住：预检说「没问题」不等于「一定能起来」，它只负责把**必然失败**提前说穿。
 *
 * 参数位还有一条更窄的边界：`args[0]` **只**在明确是本地文件路径（绝对 / `./` / `../`）时
 * 才判存在。包名（`@scope/pkg`）、URL、裸相对脚本名一律不判——「含分隔符」不等于「本地文件」，
 * 按那条判会把 `npx @scope/pkg` 这类官方最常见写法判死（见 {@link looksLikeFileArg}）。
 *
 * **相对路径基准（两段，勿并成一条）**：
 *   - 相对的 `cwd` 自身按 `baseDir`（调用方给工作区根）解析；
 *   - 相对的 `command` 与相对的 `args[0]` 按 **`cwd`（若配了）否则 `baseDir`** 解析。
 * 第二段的基准为什么跟着 `cwd` 走：子进程是「先 chdir 到 `cwd` 再执行」，`./server.js` 在
 * 用户心里就是「相对那个工作目录」。若一律按 `baseDir`，`{cwd:"./server", args:["./index.js"]}`
 * 会被解析成 `<baseDir>/index.js`——不存在就**误判失败**（原本能跑的被挡下），存在就**悄悄
 * 换成另一个文件**（比失败更糟）。解析结果**原样返回给调用方去 spawn**：判据与实现用同一份
 * 结果，不允许「判的时候按 A 解析、拉的时候按 B 解析」。
 */
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * 不能直接作为 `command` 执行的脚本扩展名
 *
 * 只收「普通双击/spawn 都不认」的：`.js/.mjs/.cjs` 需要 node，`.py` 需要 python。
 * 刻意**不收** `.sh`（POSIX 有执行位可以直接跑，收进来会误报）。
 *
 * ⚠️ 这条判据**只在 Windows 成立**：macOS/Linux 上「可执行位 + shebang」的脚本能被
 * `execvp` 直接拉起，一律拒绝 = 把原本能跑的配置判死。故非 Windows 还要看可执行位。
 */
const NON_EXECUTABLE_SCRIPT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.py',
  '.rb',
]);

/** Windows 可执行扩展名（PATH 查找用；非 Windows 只有原样名一种可能） */
const WIN_EXEC_EXTS = ['.exe', '.cmd', '.bat', '.com'];

/** 预检输入 */
export interface CommandProbeInput {
  /** 配置里的拉起命令（`memora.mcpServers[].command`） */
  readonly command: string;
  /** 配置里的参数（只检查第一个参数是否是「路径形态」） */
  readonly args?: readonly string[];
  /** 配置里的工作目录（相对值按 baseDir 解析） */
  readonly cwd?: string;
  /** 相对路径基准（调用方传工作区根；缺省 process.cwd()） */
  readonly baseDir?: string;
}

/** 预检通过后的可执行形态（调用方**必须**用这份结果去 spawn） */
export interface ProbedCommand {
  /** 解析后的命令（相对路径已转绝对；裸名原样） */
  readonly command: string;
  /** 解析后的参数（第一个参数若为路径形态，已转绝对） */
  readonly args: readonly string[];
  /** 解析后的工作目录（未配置 = undefined，保持 SDK 缺省语义） */
  readonly cwd?: string;
}

/** 预检结果（失败给可直接展示的原因） */
export type CommandProbeResult =
  | { readonly ok: true; readonly resolved: ProbedCommand }
  | { readonly ok: false; readonly problem: string };

/**
 * `command` 位置上的「路径形态」：绝对路径 / `./` `../` 开头 / 含路径分隔符
 *
 * 裸名（`node` / `npx`）不走这条——它们属于 PATH 查找，含义完全不同，
 * 混在一起判会把 `node` 当成「当前目录下叫 node 的文件」。
 *
 * ⚠️ **不能拿这个谓词去判 `args[0]`**（2026-10-24 实测的误杀）：参数位置上的「含 `/`」
 * 不蕴含「本地文件」——`@modelcontextprotocol/server-filesystem` 这种 npm scope 包名、
 * `https://…`、`ts-node/register` 全含分隔符。同一个谓词套两种语义 ⇒ 官方最常见的
 * `npx @scope/pkg`（不带 `-y`）被判「参数里的文件不存在」。判参数请用
 * {@link looksLikeFileArg}。
 *
 * @param value 待判字符串
 */
function looksLikeCommandPath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\') ||
    value.includes('/') ||
    value.includes('\\')
  );
}

/**
 * `args[0]` 位置上的「本地文件路径形态」：只认绝对路径与显式相对路径
 *
 * **刻意不含「含路径分隔符」**：那是 `command` 的判据，搬到参数位就是误杀面（见
 * {@link looksLikeCommandPath} 的说明）。用户写 `./server.js` / `/srv/index.js` /
 * `C:\tools\x.js` 是明确指向本地文件；写 `mcp-server-git` / `@scope/pkg` 是包名。
 *
 * 已知**不判**（宁可漏判也不误杀，漏判由 stderr 尾部兜底）：裸相对脚本名
 * `node server.js`——它与 `npx mcp-server-git` 形态完全相同，静态无法区分，
 * 只能靠拉起后 node 的 `Cannot find module`。要判它就得引入「哪些命令是解释器」的
 * 知识表，那是新的判据面，不在本文件职责内（见台账）。
 *
 * @param value 已剥成对引号的参数值
 */
function looksLikeFileArg(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  );
}

/**
 * 取文件状态（不存在 / 无权限 → undefined，不抛）
 *
 * 用 `statSync(throwIfNoEntry: false)` 而不是 `existsSync`：后者对「目录」也返回 true，
 * 而 `command` 指向一个目录时 spawn 会以 EACCES 失败——这里要能区分。
 *
 * `executable` 只在 POSIX 有意义（Windows 的 mode 不带执行位），判据里必须连带平台判断。
 *
 * @param path 绝对路径
 */
function fileStat(
  path: string,
): { isFile: boolean; isDirectory: boolean; executable: boolean } | undefined {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) return undefined;
    return {
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      executable: (stat.mode & 0o111) !== 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * 去掉成对的首尾引号
 *
 * 用户从 Windows「属性 → 安全对象名」或截图里复制路径时常连引号一起带走，
 * `spawn('"C:\\tools\\s.exe"')` 必失败。剥掉再判、并且**把剥掉的值交给 spawn**
 * （判据与实现同源），否则会报「找不到可执行文件："C:\…"」——文件明明在那儿。
 *
 * @param value 原始字符串（**不** trim：判空由调用方负责，值原样进判据与 spawn）
 */
function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  return value;
}

/**
 * 在 PATH 里找一个裸命令
 *
 * @param command 裸命令名（`node` / `npx`）
 * @returns 命中的绝对路径；找不到 = null
 */
function findOnPath(command: string): string | null {
  const dirs = (process.env['PATH'] ?? process.env['Path'] ?? '')
    .split(delimiter)
    .filter((dir) => dir.length > 0);
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env['PATHEXT'] ?? '').split(';').filter(Boolean), ...WIN_EXEC_EXTS]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (fileStat(candidate)?.isFile) return candidate;
    }
  }
  return null;
}

/**
 * 脚本文件（`.js` / `.py` 之类）是否**必须**靠解释器拉起
 *
 * 纯判据（平台与可执行位作入参而不是读全局）：这样它在 Windows 开发机上也能被断言，
 * 而不是靠「CI 跑在什么平台」碰运气。
 *
 *   - Windows：无执行位语义，CreateProcess 不认 shebang ⇒ 一律要解释器；
 *   - POSIX：`execvp` 对「执行位 + shebang」的脚本能直接拉起 ⇒ 有执行位就不强制。
 *
 * @param platform `process.platform`
 * @param executable 文件是否带执行位（stat.mode & 0o111）
 */
export function scriptNeedsInterpreter(platform: NodeJS.Platform, executable: boolean): boolean {
  return platform === 'win32' || !executable;
}

/**
 * 预检一条 MCP 配置能不能被拉起（静态部分）
 *
 * @param input 命令 / 参数 / 工作目录
 * @returns ok=true 时带解析后的可执行形态；ok=false 时带人话原因
 */
export function probeCommand(input: CommandProbeInput): CommandProbeResult {
  // 判空用 trim（全空白 = 没填），但**值本身不改写**：判据面必须与字段面同源——
  // 保存侧已保真（不 trim），这里再 trim 就成了「判定按 A、spawn 按 B」的假阴性
  // （command 带尾随空格时预检说没事、拉起却失败）。
  const rawCommand = stripWrappingQuotes(typeof input.command === 'string' ? input.command : '');
  if (rawCommand.trim().length === 0)
    return { ok: false, problem: '缺少 command（要填可执行程序，如 node / npx / python）' };

  const baseDir = input.baseDir && input.baseDir.length > 0 ? input.baseDir : process.cwd();

  // ① cwd：先解析再判存在（相对 cwd 的基准 = baseDir）。同样只判空、值原样解析。
  const cwdValue = typeof input.cwd === 'string' ? stripWrappingQuotes(input.cwd) : '';
  const cwd = cwdValue.trim().length > 0 ? resolve(baseDir, cwdValue) : undefined;
  if (cwd) {
    const stat = fileStat(cwd);
    if (!stat) return { ok: false, problem: `工作目录不存在：${cwd}（cwd 字段填错了）` };
    if (!stat.isDirectory) return { ok: false, problem: `工作目录不是文件夹：${cwd}` };
  }

  // ② 其余相对路径的基准：子进程先 chdir 再执行 ⇒ 配了 cwd 就是它，否则退回工作区根
  const pathBase = cwd ?? baseDir;

  // ③ 参数里的第一个：只在它**明确指向本地文件**时判存在（`-y` / 包名一律不动）
  const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : [];
  if (args.length > 0 && typeof args[0] === 'string') {
    // 先剥引号再判（用户可能把带空格的路径连引号一起粘进来）；判为文件路径才替换成绝对
    const first = stripWrappingQuotes(args[0]);
    if (looksLikeFileArg(first)) {
      const abs = resolve(pathBase, first);
      if (!fileStat(abs)) {
        return { ok: false, problem: `参数里的文件不存在：${abs}（检查 args 第一项）` };
      }
      args[0] = abs;
    }
  }

  // ④ command：路径形态 ⇒ 判文件；裸名 ⇒ 判 PATH
  let command = rawCommand;
  if (looksLikeCommandPath(rawCommand)) {
    const abs = resolve(pathBase, rawCommand);
    const stat = fileStat(abs);
    if (!stat) {
      const ext = extname(abs).toLowerCase();
      const hint = NON_EXECUTABLE_SCRIPT_EXTS.has(ext)
        ? `；如果这是一个脚本文件，命令请填 node（或 python），把 ${abs} 放进「参数」`
        : '';
      return { ok: false, problem: `找不到可执行文件：${abs}${hint}` };
    }
    if (!stat.isFile) return { ok: false, problem: `命令指向的是文件夹而不是文件：${abs}` };
    const ext = extname(abs).toLowerCase();
    // POSIX 上「可执行位 + shebang」的脚本能被直接拉起 ⇒ 有执行位就不拦（无执行位则必然失败）
    if (
      NON_EXECUTABLE_SCRIPT_EXTS.has(ext) &&
      scriptNeedsInterpreter(process.platform, stat.executable)
    ) {
      return {
        ok: false,
        problem: `「${abs}」是脚本文件，不能直接执行：命令填 node（Python 填 python），脚本路径放进「参数」`,
      };
    }
    command = abs;
  } else if (!findOnPath(rawCommand)) {
    return {
      ok: false,
      problem: `PATH 里找不到「${rawCommand}」：命令要么是 PATH 中的可执行程序（node / npx / python），要么写绝对路径；脚本文件请填 node 并把脚本放进「参数」`,
    };
  }

  return { ok: true, resolved: { command, args, ...(cwd ? { cwd } : {}) } };
}
