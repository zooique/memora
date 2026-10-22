/**
 * 系统提示音单测（HOST-ATTN-1）
 *
 * 守的是**载荷与纪律**，不是真响不响（真响是 spawn 的系统行为，单测不覆盖）：
 *   ① 三平台脚本固定、无动态数据 ⇒ 天然无注入面；
 *   ② 各平台音效都有回退（Windows 主音→旧音；macOS afplay→osascript beep；
 *      Linux canberra→paplay→exit 127）；
 *   ③ 平台闸：win32 / darwin / linux 各自分派，其它平台 no-op；
 *   ④ **两层失败都落 `<tmpdir>/memora-sound.log`**：进程没起来（`error`）+ 起来了但
 *      非零退出（`exit`）。初版曾把 `error` 回调写成 `() => undefined` = 纯吞，是
 *      「没响」里最难分诊的形态，本文件锁死不得回退。
 *
 * ⚠️ 本文件**不能**证明 macOS / Linux 上真会响——那两行在 `systemSound.ts` 头注里明确
 * 标注「未真机验证」。这里只证明「命令拼对了、失败会记下来」。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  buildWindowsScript,
  buildDarwinScript,
  buildLinuxScript,
  encodeCommand,
  resolveSoundCommand,
  createSystemSoundPlayer,
  type SpawnLike,
} from '../systemSound.js';

describe('buildWindowsScript —— Windows 载荷', () => {
  it('确定性：不依赖调用时状态（两次生成逐字相同）', () => {
    expect(buildWindowsScript()).toBe(buildWindowsScript());
  });

  it('主音 + 回退音都在（缺主音时 PlaySync 前有 Test-Path 兜底）', () => {
    const script = buildWindowsScript();
    expect(script).toContain('Windows Notify System Generic.wav');
    expect(script).toContain('Windows Notify.wav');
  });

  it('用 $env:WINDIR 解析系统目录（不硬编码盘符，不使用 cmd 的 %VAR% 语法）', () => {
    expect(buildWindowsScript()).toContain('$env:WINDIR');
    expect(buildWindowsScript()).not.toContain('%WINDIR%');
  });

  it('PlaySync 而非 Play（子进程立即退出会掐断异步播放）', () => {
    expect(buildWindowsScript()).toContain('PlaySync()');
    expect(buildWindowsScript()).not.toMatch(/[^a-zA-Z]Play\(\)/);
  });

  it('PlaySync 失败落 memora-sound.log（PowerShell 侧诊断面）', () => {
    const script = buildWindowsScript();
    expect(script).toContain('memora-sound.log');
    expect(script).toContain('Out-File -Append');
    // catch 在 PlaySync 之后：PlaySync 抛错不会逃出脚本，但线索留下了
    expect(script.indexOf('PlaySync()')).toBeLessThan(script.indexOf('catch'));
  });
});

describe('buildDarwinScript —— macOS 载荷', () => {
  it('afplay 走绝对路径（不依赖 PATH）', () => {
    expect(buildDarwinScript()).toContain('/usr/bin/afplay');
  });

  it('系统音文件在 macOS 标准目录（十余年稳定）', () => {
    expect(buildDarwinScript()).toContain('/System/Library/Sounds/');
    expect(buildDarwinScript()).toMatch(/\.aiff/);
  });

  it('afplay 失败回退 osascript beep（系统提醒音，保底存在）', () => {
    const script = buildDarwinScript();
    expect(script).toContain('/usr/bin/osascript');
    expect(script).toContain('beep');
    // 回退是 || 串联：afplay 非零才走 osascript
    expect(script).toContain('||');
  });
});

describe('buildLinuxScript —— Linux 载荷', () => {
  it('canberra-gtk-play 优先（按 freedesktop 事件名播主题音，不依赖文件路径）', () => {
    const script = buildLinuxScript();
    expect(script).toContain('canberra-gtk-play');
    expect(script).toContain('message-new-instant');
  });

  it('回退 paplay + freedesktop 音效文件（.oga 两个候选）', () => {
    const script = buildLinuxScript();
    expect(script).toContain('paplay');
    expect(script).toContain('/usr/share/sounds/freedesktop/stereo/');
    expect(script).toContain('.oga');
  });

  it('全部候选不可用时 exit 127（让 Node 侧 exit 回调能记日志，不静默退出 0）', () => {
    const script = buildLinuxScript();
    expect(script).toContain('exit 127');
    // exit 127 必须在所有 exec 之后（否则候选永远没机会跑）
    expect(script.indexOf('exit 127')).toBeGreaterThan(script.indexOf('canberra-gtk-play'));
    expect(script.indexOf('exit 127')).toBeGreaterThan(script.indexOf('paplay'));
  });

  it('候选探测用 command -v（找不到就跳下一个，不报错刷屏）', () => {
    expect(buildLinuxScript()).toContain('command -v');
    expect(buildLinuxScript()).toContain('/dev/null 2>&1');
  });
});

describe('encodeCommand —— 与 PowerShell 官方契约一致', () => {
  it('UTF-16LE + Base64（不是 base64(UTF-8)）', () => {
    const script = buildWindowsScript();
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le');
    expect(decoded).toBe(script);
  });
});

describe('resolveSoundCommand —— 平台分派单点', () => {
  it('win32 ⇒ powershell + -EncodedCommand', () => {
    const cmd = resolveSoundCommand('win32');
    expect(cmd?.command).toBe('powershell.exe');
    expect(cmd?.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      expect.any(String),
    ]);
  });

  it('darwin ⇒ /bin/sh -c <macOS 脚本>', () => {
    const cmd = resolveSoundCommand('darwin');
    expect(cmd?.command).toBe('/bin/sh');
    expect(cmd?.args[0]).toBe('-c');
    expect(cmd?.args[1]).toBe(buildDarwinScript());
  });

  it('linux ⇒ /bin/sh -c <Linux 脚本>', () => {
    const cmd = resolveSoundCommand('linux');
    expect(cmd?.command).toBe('/bin/sh');
    expect(cmd?.args[1]).toBe(buildLinuxScript());
  });

  it('未知平台（aix / freebsd / openbsd…）⇒ undefined（no-op，不是猜一个命令）', () => {
    expect(resolveSoundCommand('aix')).toBeUndefined();
    expect(resolveSoundCommand('freebsd')).toBeUndefined();
    expect(resolveSoundCommand('openbsd')).toBeUndefined();
    expect(resolveSoundCommand('sunos')).toBeUndefined();
  });
});

describe('createSystemSoundPlayer —— 平台闸与失败收敛', () => {
  /** 捕获 error / exit 两个回调，便于手动触发 */
  interface Harness {
    player: () => void;
    spawnFn: ReturnType<typeof vi.fn>;
    fire: { error?: (err: unknown) => void; exit?: (code: unknown) => void };
    log: string[];
  }

  function setup(
    overrides: {
      platform?: NodeJS.Platform;
      throwSync?: boolean;
      appendLog?: (l: string) => void;
    } = {},
  ): Harness {
    const fire: Harness['fire'] = {};
    const log: string[] = [];
    const spawnFn = vi.fn(() => {
      if (overrides.throwSync) throw new Error('参数非法');
      return {
        on: (event: 'error' | 'exit', listener: (p: unknown) => void) => {
          if (event === 'error') fire.error = listener;
          else fire.exit = listener;
        },
        unref: vi.fn(),
      };
    }) as unknown as ReturnType<typeof vi.fn> & SpawnLike;
    const player = createSystemSoundPlayer({
      spawnFn: spawnFn as unknown as SpawnLike,
      platform: overrides.platform ?? 'win32',
      // 注入替身：本组只关心「是否 spawn / 是否记日志」，不该写真实临时目录
      appendLog: overrides.appendLog ?? ((line) => log.push(line)),
    });
    return { player, spawnFn, fire, log };
  }

  it('win32 spawn powershell 且带 -EncodedCommand', () => {
    const { player, spawnFn } = setup();
    player();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawnFn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock
      .calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
  });

  it('darwin / linux 各自 spawn /bin/sh（不是 no-op）', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { player, spawnFn } = setup({ platform });
      player();
      const [cmd] = (spawnFn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock
        .calls[0];
      expect(cmd).toBe('/bin/sh');
    }
  });

  it('三平台都会接 error 与 exit 两个回调（缺 exit = 非零退出静默）', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const { player, fire } = setup({ platform });
      player();
      expect(fire.error).toBeTypeOf('function');
      expect(fire.exit).toBeTypeOf('function');
    }
  });

  it('未知平台直接 no-op（不 spawn，也不写日志）', () => {
    const { player, spawnFn, log } = setup({ platform: 'aix' });
    player();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(log).toHaveLength(0);
  });

  it('unref 被调用（不因播放子进程拖住宿主退出）', () => {
    const unref = vi.fn();
    const spawnFn: SpawnLike = () => ({ on: vi.fn(), unref });
    const player = createSystemSoundPlayer({
      spawnFn,
      platform: 'win32',
      appendLog: () => undefined,
    });
    player();
    expect(unref).toHaveBeenCalledTimes(1);
  });

  describe('两层失败落日志', () => {
    it('error（播放器没起来 / ENOENT）⇒ 一行日志，含时间、命令与原因', () => {
      const { player, fire, log } = setup({ platform: 'linux' });
      player();
      fire.error?.(new Error('spawn /bin/sh ENOENT'));
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(
        /^\d{4}-\d{2}-\d{2}T[\d:.]+Z spawn=\/bin\/sh error=spawn \/bin\/sh ENOENT$/,
      );
    });

    it('exit 非零 ⇒ 一行日志，含命令与退出码', () => {
      const { player, fire, log } = setup({ platform: 'linux' });
      player();
      fire.exit?.(127);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z exit=\/bin\/sh code=127$/);
    });

    it('exit 0 ⇒ 不记（正常播完不是失败）', () => {
      const { player, fire, log } = setup();
      player();
      fire.exit?.(0);
      expect(log).toHaveLength(0);
    });

    it('exit null（被信号终止，宿主关窗 kill 子进程）⇒ 不记，不冤枉成播放失败', () => {
      const { player, fire, log } = setup();
      player();
      fire.exit?.(null);
      expect(log).toHaveLength(0);
    });

    it('同步抛（参数非法）⇒ 同样落一行日志（不是只吞）', () => {
      const { player, log } = setup({ throwSync: true });
      expect(() => player()).not.toThrow();
      expect(log).toHaveLength(1);
      expect(log[0]).toContain('error=参数非法');
    });

    it('reason 非 Error 形态（字符串 / undefined）也能成行，不二次抛', () => {
      const { player, fire, log } = setup();
      player();
      expect(() => fire.error?.('字符串原因')).not.toThrow();
      expect(() => fire.error?.(undefined)).not.toThrow();
      expect(log[0]).toContain('error=字符串原因');
      expect(log[1]).toContain('error=undefined');
    });

    it('写日志自身抛错（临时目录不可写）⇒ 静默，不反噬调用方', () => {
      const { player, fire } = setup({
        throwSync: true,
        appendLog: () => {
          throw new Error('EACCES: 日志不可写');
        },
      });
      expect(() => player()).not.toThrow();
      expect(() => fire.error?.(new Error('x'))).not.toThrow();
    });
  });
});
