/**
 * Windows 系统提示音 — 交互提醒的**离屏层**（HOST-ATTN-1）
 *
 * 为什么是声音而不是系统 toast：WinRT toast 要求「发起进程 = AUMID 所属应用」，
 * 借用 VS Code 的 AUMID 从外部进程发会被系统静默丢弃（2026-10-22 真机实证，详见
 * `attentionNotice.ts` 头注释）。声音没有应用身份问题——`Media.SoundPlayer` 播一个
 * wav 文件即可，任何进程都能响，且不受「通知横幅开关 / 勿扰 / 横幅时长」任何一项
 * 系统设置影响（唯一受制于系统音量与静音，用户可感知可自控）。
 *
 * 🔴 实现纪律（与原 systemToast 同源，缺一条就是造伤）：
 *   ① **fire-and-forget，但不许哑巴失败到不可诊断**：spawn 失败绝不反噬主链路（确认卡
 *      建立是安全关键路径，不能被一次 spawn 拖慢或抛错）；`error` 事件必须有人接
 *      （无人接的 'error' 会抛成进程级未捕获异常，Node 语义）。
 *   ② **两层失败都要落 `%TEMP%/memora-sound.log`**（2026-10-22 排查教训：没有它，
 *      「没响」无法分诊）。两个失败面**互相独立、必须分别覆盖**：
 *      - **PowerShell 侧**（进程起来了，PlaySync 抛错）⇒ 脚本内 catch 落盘；
 *      - **spawn 侧**（powershell.exe 根本没起来：被安全软件拦、PATH 异常、企业策略
 *        禁用）⇒ Node 侧 `error` 回调落盘。**「powershell 没起来时谁都写不了日志」是
 *        假命题**——写日志的是宿主 Node 进程，不依赖 PowerShell。
 *      ⚠️ 后者恰是最难分诊的形态（进程静默不存在），漏了它 = 诊断面只有一半。
 *   ③ **`unref`**：不因这条子进程拖住宿主退出（VS Code 关窗时不等播放收尾）。
 *   ④ **非 Windows 直接 no-op**（macOS `afplay` / Linux 播放器路径各异，未接，登记为
 *      待触发项——与原 toast 的平台边界同口径）。
 *   ⑤ **数据不拼命令位**：整段脚本走 `-EncodedCommand`（UTF-16LE + Base64），路径由
 *      `$env:WINDIR` 在 PowerShell 侧解析，Node 侧不拼任何用户数据（本模块无常量以外的
 *      动态数据，天然无注入面）。
 *
 * 音效选择：`Windows Notify System Generic.wav` 是 Win10/11 自带的系统通知音（即「叮」），
 * 不随主题/包安装变化；缺失时回退 `Windows Notify.wav`（更老系统同名音）。两个都缺则
 * SoundPlayer 抛错 → 被 ① 收敛，静默无声（等价于「提醒通道降级」，不反噬）。
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIMARY_WAV = 'Windows Notify System Generic.wav';
const FALLBACK_WAV = 'Windows Notify.wav';

/** 失败日志文件名（落在 `%TEMP%`）：PlaySync 抛错时的唯一诊断面 */
export const SOUND_LOG_FILENAME = 'memora-sound.log';

/**
 * 生成 PowerShell 脚本（固定模板，无动态数据）
 *
 * `PlaySync()` 阻塞到播完再退出子进程——`Play()` 是异步的，进程立即退出会掐断声音。
 * 真机实测整条链路约 3s（`PlaySync` 2958ms，含 powershell 冷启动约 0.3~0.5s）。子进程由
 * 调用方 spawn + `unref`，宿主不等它，这段时间对宿主零影响。
 */
export function buildSoundScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    "$log = Join-Path $env:TEMP '" + SOUND_LOG_FILENAME + "'",
    "$p = Join-Path $env:WINDIR ('Media\\' + '" + PRIMARY_WAV + "')",
    "if (-not (Test-Path -LiteralPath $p)) { $p = Join-Path $env:WINDIR ('Media\\' + '" + FALLBACK_WAV + "') }",
    'try { (New-Object Media.SoundPlayer $p).PlaySync() }',
    // 失败必须留线索（2026-10-22 排查教训：扩展侧 fire-and-forget，PowerShell 侧失败若不
    // 落日志则「没响」永远无法分诊——spawn 层失败除外，powershell 没起来时谁都写不了）。
    "catch { \"$(Get-Date -Format o) wav=$p error=$($_.Exception.Message)\" | Out-File -Append -Encoding utf8 $log }",
  ].join('\n');
}

/** PowerShell `-EncodedCommand` 口径 = UTF-16LE + Base64（官方契约，非 base64(UTF-8)） */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** spawn 的最小结构面（只声明我们用到的两面，便于测试注入替身） */
export type SpawnLike = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: boolean },
) => { on(event: 'error', listener: (err: unknown) => void): void; unref?: () => void };

export interface SystemSoundDeps {
  spawnFn?: SpawnLike;
  platform?: NodeJS.Platform;
  /** 追加一行失败日志（默认真实写 `%TEMP%/memora-sound.log`；测试注入替身以免污染 TEMP） */
  appendLog?: (line: string) => void;
}

export type SystemSoundPlayer = () => void;

/** 默认日志落点：与 PowerShell 侧同一个 `%TEMP%/memora-sound.log`（两份证据同一份文件） */
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
 * 非 Windows 平台直接 no-op；spawn 失败、PowerShell 不存在、wav 缺失均在静默面——
 * **不报错、不重试**（与原 toast 的静默口径一致：提醒失败不得打扰主链路），
 * 但**必须留日志**（见文件头 ②）。
 */
export function createSystemSoundPlayer(deps: SystemSoundDeps = {}): SystemSoundPlayer {
  const spawnFn = deps.spawnFn ?? (spawn as unknown as SpawnLike);
  const platform = deps.platform ?? process.platform;
  const appendLog = deps.appendLog ?? defaultAppendLog;

  /**
   * 记一条 spawn 侧失败
   *
   * 诊断面自己也不许造伤：写日志抛错（磁盘满 / TEMP 不可写）一律吞掉——它只是旁路证据，
   * 不能把一次提醒升级成进程级异常。行格式与 PowerShell 侧同构（`时间 key=value`）。
   */
  function logSpawnFailure(err: unknown): void {
    try {
      appendLog(`${new Date().toISOString()} spawn=powershell.exe error=${describeError(err)}`);
    } catch {
      // 日志面失败静默：诊断不得反噬
    }
  }

  return () => {
    if (platform !== 'win32') return;
    try {
      const child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(buildSoundScript())],
        { stdio: 'ignore', windowsHide: true },
      );
      // error 事件必须有人接：无人接的 'error' 会抛成进程级未捕获异常（Node 语义）。
      // 同时这是「powershell 根本没起来」的唯一可观测面（PlaySync 侧 catch 那时还不存在）。
      child.on('error', logSpawnFailure);
      // unref：不因这条子进程拖住宿主退出（VS Code 关窗时不等播放收尾）
      child.unref?.();
    } catch (err) {
      // spawn 同步抛（参数非法等极端面）：记日志后吞掉，提醒失败绝不冒泡到调用方
      logSpawnFailure(err);
    }
  };
}
