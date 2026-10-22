/**
 * 系统提示音 — 交互提醒的**离屏层**（HOST-ATTN-1）
 *
 * 为什么是声音而不是系统 toast：WinRT toast 要求「发起进程 = AUMID 所属应用」，
 * 借用 VS Code 的 AUMID 从外部进程发会被系统静默丢弃（2026-10-22 真机实证，详见
 * `attentionNotice.ts` 头注释）。声音没有应用身份问题——任何进程都能播一个系统音，
 * 且不受「通知横幅开关 / 勿扰 / 横幅时长」任何一项系统设置影响（唯一受制于系统音量
 * 与静音，用户可感知可自控）。
 *
 * 🔴 验证状态（诚实标注，**不要改成「已验证」**）：
 *   | 平台  | 播放链路                                        | 验证程度 |
 *   |-------|------------------------------------------------|----------|
 *   | win32 | `powershell` + `Media.SoundPlayer` → 系统通知音 | ✅ 真机：用户人耳确认，`PlaySync` 耗时 2958ms |
 *   | darwin| `/bin/sh` → `afplay` 系统音 → 回退 `osascript beep` | ⚠️ **仅代码对齐，未在真机验证** |
 *   | linux | `/bin/sh` → `canberra-gtk-play` → 回退 `paplay` | ⚠️ **仅代码对齐，未在真机验证** |
 *   两行「未验证」是事实，不是免责声明：macOS/Linux 的候选播放器与音效文件是否存在于
 *   某台具体机器上，只有真机能答。代码保证的是**失败必留日志**，不是「一定响」。
 *
 * 🔴 实现纪律（与原 systemToast 同源，缺一条就是造伤）：
 *   ① **fire-and-forget，但不许哑巴失败到不可诊断**：spawn 绝不反噬主链路（确认卡建立
 *      是安全关键路径，不能被一次 spawn 拖慢或抛错）；`error` 事件必须有人接
 *      （无人接的 'error' 会抛成进程级未捕获异常，Node 语义）。
 *   ② **两层失败都落 `<tmpdir>/memora-sound.log`**（2026-10-22 排查教训：没有它，
 *      「没响」无法分诊）。两个失败面**互相独立、必须分别覆盖**：
 *      - **进程没起来**（`error` 事件：命令不存在、被安全软件拦、PATH/权限异常）
 *        ⇒ Node 侧 `error` 回调落盘。**「进程没起来时谁都写不了日志」是假命题**——
 *        写日志的是宿主 Node 进程，不依赖被 spawn 的播放器。
 *      - **进程起来了但非零退出**（`exit` 事件：播放器找不到音频服务、音效文件缺失、
 *        全部候选都不可用）⇒ Node 侧 `exit` 回调落盘。
 *      另有第三面：Windows 的 PlaySync 抛错在 **PowerShell 脚本内部** catch 落盘（那时
 *      进程还活着，比退出码更早拿到原因）。三面写的是同一个文件。
 *   ③ **`unref`**：不因这条子进程拖住宿主退出（VS Code 关窗时不等播放收尾）。
 *   ④ **数据不拼命令位**：三平台的播放脚本都是**固定模板**，Node 侧不拼任何用户数据
 *      （本模块无常量以外的动态数据，天然无注入面）。Windows 走 `-EncodedCommand`
 *      （UTF-16LE + Base64），路径由 `$env:WINDIR` 在 PowerShell 侧解析；POSIX 走
 *      `/bin/sh -c '<固定脚本>'`，**不经过 Node 拼串**。
 *   ⑤ **为什么 POSIX 用 `/bin/sh` 而不是直接 spawn 播放器**：播放器有多个候选，回退
 *      逻辑写在固定脚本里是一行，写在 Node 里是一个重试状态机——复杂度必须匹配问题。
 *      `/bin/sh` 是 POSIX 硬要求（Linux/macOS 必有），不像 Windows 的裸
 *      `powershell.exe` 依赖 PATH；故这里用绝对路径。
 *
 * 音效选择（Win）：`Windows Notify System Generic.wav` 是 Win10/11 自带的系统通知音
 * （即「叮」），不随主题/包安装变化；缺失时回退 `Windows Notify.wav`（更老系统同名音）。
 * 两个都缺则 SoundPlayer 抛错 → 被 ② 收敛，静默无声（等价于「提醒通道降级」，不反噬）。
 * 音效选择（macOS）：`/System/Library/Sounds/Glass.aiff` 是 macOS 十余年未变的标准音效
 * 目录成员；回退 `osascript -e 'beep'` 走系统「提醒音」设置，**一定存在**（保底）。
 * 音效选择（Linux）：`canberra-gtk-play -i message-new-instant` 按 freedesktop 事件名播
 * 主题音（最语义化）；回退 `paplay` + freedesktop 音效文件（`sound-theme-freedesktop`
 * 包，多数桌面发行版预装）；都没有则退出码 127 → 被 ② 记日志。
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIMARY_WAV = 'Windows Notify System Generic.wav';
const FALLBACK_WAV = 'Windows Notify.wav';

/** macOS 系统音效（十余年稳定），失败回退系统「提醒音」 */
const MACOS_SOUND_FILE = '/System/Library/Sounds/Glass.aiff';

/** 失败日志文件名（落在系统临时目录）：三面失败的统一诊断面 */
export const SOUND_LOG_FILENAME = 'memora-sound.log';

/**
 * 生成 Windows 的 PowerShell 脚本（固定模板，无动态数据）
 *
 * `PlaySync()` 阻塞到播完再退出子进程——`Play()` 是异步的，进程立即退出会掐断声音。
 * 真机实测整条链路约 3s（`PlaySync` 2958ms，含 powershell 冷启动约 0.3~0.5s）。子进程由
 * 调用方 spawn + `unref`，宿主不等它，这段时间对宿主零影响。
 */
export function buildWindowsScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$log = Join-Path $env:TEMP '" + SOUND_LOG_FILENAME + "'",
    "$p = Join-Path $env:WINDIR ('Media\\' + '" + PRIMARY_WAV + "')",
    "if (-not (Test-Path -LiteralPath $p)) { $p = Join-Path $env:WINDIR ('Media\\' + '" + FALLBACK_WAV + "') }",
    'try { (New-Object Media.SoundPlayer $p).PlaySync() }',
    // 失败必须留线索（2026-10-22 排查教训：扩展侧 fire-and-forget，PowerShell 侧失败若不
    // 落日志则「没响」永远无法分诊——进程没起来的那一面由 Node 侧 error 回调兜住）。
    "catch { \"$(Get-Date -Format o) wav=$p error=$($_.Exception.Message)\" | Out-File -Append -Encoding utf8 $log }",
  ].join('\n');
}

/**
 * 生成 macOS 的 POSIX shell 脚本（固定模板，无动态数据）
 *
 * `afplay` 用绝对路径（不依赖 PATH）；播完才退出，宿主已 `unref` 不等它。
 * 回退 `osascript -e 'beep'` 一定存在（走用户的系统提醒音设置），所以 macOS 侧
 * 理论上只会在「音频服务整个不可用」时才是非零退出。
 */
export function buildDarwinScript(): string {
  return [
    `/usr/bin/afplay ${MACOS_SOUND_FILE} 2>/dev/null`,
    "|| exec /usr/bin/osascript -e 'beep'",
  ].join(' ');
}

/**
 * 生成 Linux 的 POSIX shell 脚本（固定模板，无动态数据）
 *
 * 候选顺序按「语义准确度 → 覆盖率」排：canberra 按事件名播主题音（不依赖文件路径）＞
 * paplay 播 freedesktop 主题文件（PulseAudio / PipeWire 兼容层均提供）。
 * 全部不可用时 `exit 127`（约定的「命令找不到」码）⇒ Node 侧 `exit` 回调记日志。
 */
export function buildLinuxScript(): string {
  return [
    'if command -v canberra-gtk-play >/dev/null 2>&1; then exec canberra-gtk-play -i message-new-instant; fi',
    'if command -v paplay >/dev/null 2>&1; then',
    'for f in /usr/share/sounds/freedesktop/stereo/message-new-instant.oga /usr/share/sounds/freedesktop/stereo/bell.oga; do',
    'if [ -f "$f" ]; then exec paplay "$f"; fi',
    'done',
    'fi',
    'echo "no-usable-player" >&2',
    'exit 127',
  ].join('\n');
}

/** PowerShell `-EncodedCommand` 口径 = UTF-16LE + Base64（官方契约，非 base64(UTF-8)） */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 一条播放命令（命令 + 参数 = 一个固定模板，无动态数据） */
export interface SoundCommand {
  command: string;
  args: string[];
}

/**
 * 平台 ⇒ 播放命令（**唯一分派点**）
 *
 * 不认识的平台返回 `undefined`（= no-op）。新增平台只改这一处。
 */
export function resolveSoundCommand(platform: NodeJS.Platform): SoundCommand | undefined {
  switch (platform) {
    case 'win32':
      return {
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(buildWindowsScript())],
      };
    case 'darwin':
      return { command: '/bin/sh', args: ['-c', buildDarwinScript()] };
    case 'linux':
      return { command: '/bin/sh', args: ['-c', buildLinuxScript()] };
    default:
      return undefined;
  }
}

/** spawn 的最小结构面（只声明我们用到的三面，便于测试注入替身） */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => {
  on(event: 'error' | 'exit', listener: (payload: unknown) => void): void;
  unref?: () => void;
};

export interface SystemSoundDeps {
  spawnFn?: SpawnLike;
  platform?: NodeJS.Platform;
  /** 追加一行失败日志（默认真实写 `<tmpdir>/memora-sound.log`；测试注入替身以免污染临时目录） */
  appendLog?: (line: string) => void;
}

export type SystemSoundPlayer = () => void;

/** 默认日志落点：POSIX 侧的 `$TMPDIR` 与 Node 的 `os.tmpdir()` 同源，三面证据同一份文件 */
function defaultAppendLog(line: string): void {
  appendFileSync(join(tmpdir(), SOUND_LOG_FILENAME), line + '\n', 'utf8');
}

/** 异常转单行文案（`String(new Error('x'))` 会带上 `Error: ` 前缀，先按 Error 取 message） */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 构造系统提示音播放器
 *
 * 平台不支持（win32 / darwin / linux 之外）直接 no-op；播放失败、播放器不存在、音效文件
 * 缺失都在静默面——**不报错、不重试、不弹任何 UI**（提醒失败不得打扰主链路），
 * 但**必须留日志**（见文件头 ②）。
 */
export function createSystemSoundPlayer(deps: SystemSoundDeps = {}): SystemSoundPlayer {
  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnLike);
  const platform = deps.platform ?? process.platform;
  const appendLog = deps.appendLog ?? defaultAppendLog;

  /**
   * 记一条失败
   *
   * 诊断面自己也不许造伤：写日志抛错（磁盘满 / 临时目录不可写）一律吞掉——它只是旁路
   * 证据，不能把一次提醒升级成进程级异常。行格式统一 `<ISO 时间> key=value`，与
   * PowerShell 侧脚本内的 catch 同构（那边写的是 `wav=… error=…`）。
   */
  function logFailure(detail: string): void {
    try {
      appendLog(`${new Date().toISOString()} ${detail}`);
    } catch {
      // 日志面失败静默：诊断不得反噬
    }
  }

  return () => {
    const cmd = resolveSoundCommand(platform);
    if (!cmd) return;
    try {
      const child = spawnFn(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true });
      // error 必须有人接：无人接的 'error' 会抛成进程级未捕获异常（Node 语义）。
      // 同时这是「播放器根本没起来」的唯一可观测面。
      child.on('error', (err: unknown) => {
        logFailure(`spawn=${cmd.command} error=${describeError(err)}`);
      });
      // 起来了但非零退出（找不到音频服务 / 音效文件缺失 / 全部候选不可用）
      // `null` = 被信号终止（宿主退出时 kill 子进程），不算播放失败，不记。
      child.on('exit', (code: unknown) => {
        if (typeof code !== 'number' || code === 0) return;
        logFailure(`exit=${cmd.command} code=${code}`);
      });
      // unref：不因这条子进程拖住宿主退出（VS Code 关窗时不等播放收尾）
      child.unref?.();
    } catch (err) {
      // spawn 同步抛（参数非法等极端面）：记日志后吞掉，提醒失败绝不冒泡到调用方
      logFailure(`spawn=${cmd.command} error=${describeError(err)}`);
    }
  };
}
