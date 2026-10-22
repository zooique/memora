/**
 * 系统提示音单测（HOST-ATTN-1）
 *
 * 守的是**载荷与纪律**，不是真响不响（真响是 spawn 的系统行为，单测不覆盖）：
 *   ① 脚本固定、无动态数据 ⇒ 天然无注入面；
 *   ② 音效文件存在性有回退（主音缺失退到旧音）；
 *   ③ 非 Windows no-op、spawn error 事件被接住、同步抛被吞——提醒失败不反噬主链路。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { buildSoundScript, encodeCommand, createSystemSoundPlayer, type SpawnLike } from '../systemSound.js';

describe('buildSoundScript —— 载荷生成', () => {
  it('确定性：不依赖调用时状态（两次生成逐字相同）', () => {
    expect(buildSoundScript()).toBe(buildSoundScript());
  });

  it('主音 + 回退音都在（缺主音时 PlaySync 前有 Test-Path 兜底）', () => {
    const script = buildSoundScript();
    expect(script).toContain('Windows Notify System Generic.wav');
    expect(script).toContain('Windows Notify.wav');
  });

  it('用 $env:WINDIR 解析系统目录（不硬编码盘符，不使用 cmd 的 %VAR% 语法）', () => {
    expect(buildSoundScript()).toContain('$env:WINDIR');
    expect(buildSoundScript()).not.toContain('%WINDIR%');
  });

  it('PlaySync 而非 Play（子进程立即退出会掐断异步播放）', () => {
    expect(buildSoundScript()).toContain('PlaySync()');
    expect(buildSoundScript()).not.toMatch(/[^a-zA-Z]Play\(\)/);
  });

  it('PlaySync 失败落 %TEMP%/memora-sound.log（「没响」的唯一分诊面）', () => {
    const script = buildSoundScript();
    expect(script).toContain('memora-sound.log');
    expect(script).toContain('Out-File -Append');
    // catch 在 PlaySync 之后：PlaySync 抛错不会逃出脚本（exit 仍 0，但线索留下了）
    expect(script.indexOf('PlaySync()')).toBeLessThan(script.indexOf('catch'));
  });
});

describe('encodeCommand —— 与 PowerShell 官方契约一致', () => {
  it('UTF-16LE + Base64（不是 base64(UTF-8)）', () => {
    const script = buildSoundScript();
    const decoded = Buffer.from(encodeCommand(script), 'base64').toString('utf16le');
    expect(decoded).toBe(script);
  });
});

describe('createSystemSoundPlayer —— 平台闸与失败收敛', () => {
  interface Harness {
    player: () => void;
    spawnFn: ReturnType<typeof vi.fn>;
  }

  function setup(overrides: { platform?: NodeJS.Platform; spawnImpl?: SpawnLike; throwSync?: boolean } = {}): Harness {
    const spawnFn = vi.fn(() => {
      if (overrides.throwSync) throw new Error('参数非法');
      return {
        on: vi.fn(),
        unref: vi.fn(),
      };
    }) as unknown as ReturnType<typeof vi.fn> & SpawnLike;
    const player = createSystemSoundPlayer({
      spawnFn: overrides.spawnImpl ?? (spawnFn as unknown as SpawnLike),
      platform: overrides.platform ?? 'win32',
    });
    return { player, spawnFn };
  }

  it('Windows 上 spawn powershell 且带 -EncodedCommand', () => {
    const { player, spawnFn } = setup();
    player();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = (spawnFn as unknown as { mock: { calls: Array<[string, string[]]> } }).mock.calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)]);
  });

  it('非 Windows 直接 no-op（macOS / Linux 通道未接，登记为待触发项）', () => {
    const { player, spawnFn } = setup({ platform: 'darwin' });
    player();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('spawn 异步 error 事件有人接（无人接的 error 会抛成进程级未捕获异常）', () => {
    let errorHandler: (() => void) | undefined;
    const spawnFn: SpawnLike = () => ({
      on: (event, listener) => {
        if (event === 'error') errorHandler = listener;
      },
      unref: vi.fn(),
    });
    const player = createSystemSoundPlayer({ spawnFn, platform: 'win32' });
    expect(() => player()).not.toThrow();
    expect(errorHandler).toBeTypeOf('function');
    expect(() => errorHandler?.()).not.toThrow();
  });

  it('spawn 同步抛 ⇒ 被吞，不冒泡到调用方（确认卡路径是同步直调）', () => {
    const { player } = setup({ throwSync: true });
    expect(() => player()).not.toThrow();
  });

  it('unref 被调用（不因播放子进程拖住宿主退出）', () => {
    const unref = vi.fn();
    const spawnFn: SpawnLike = () => ({ on: vi.fn(), unref });
    const player = createSystemSoundPlayer({ spawnFn, platform: 'win32' });
    player();
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
