/**
 * 配置与角色 IPC 处理器测试
 *
 * 覆盖范围：
 * - scheduleSilentRecovery：未启用静默/已过期立即关闭/未来到期设定时器（vi.useFakeTimers）
 * - CONFIG_GET：获取配置 + 失败降级
 * - CONFIG_UPDATE：合法键更新 + 非法键拒绝 + silentMode 同步托盘 + silentModeExpiresAt 触发定时器 + 抛错降级
 * - CONFIG_UPDATE_BATCH（QC-CONFIG-01）：委托 updateConfigBatch + 失败不触发副作用 + silentMode 批量同步托盘 + 抛错降级
 * - PERSONA_LIST：列出角色 + 失败降级
 * - PERSONA_SWITCH：切换角色 + 失败降级
 * - PERSONA_MODE：设置模式 + 失败降级
 * - PERSONA_MODE_GET：查询模式 + 失败降级
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map
 * - IpcContext.sprite：mock getConfig/updateConfig/listPersonas/switchPersona/setPersonaMode/personaMode
 * - IpcContext.trayManager：mock setState/updateMenu
 * - vi.useFakeTimers 测试 scheduleSilentRecovery 定时器逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

// ─── Mock errorHandler 模块（CONFIG_UPDATE catch 块调用 errorHandler.handle） ────
vi.mock('../../../electron/errorHandler.js', () => ({
  errorHandler: {
    handle: vi.fn(),
  },
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    CONFIG_LOAD_FAILED: 'CONFIG_LOAD_FAILED',
  },
}));

import { registerConfigHandlers, scheduleSilentRecovery } from '../../../electron/ipc/configHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock IpcContext */
function createMockCtx(overrides?: {
  sprite?: Partial<IpcContext['sprite']>;
  trayManager?: { setState: ReturnType<typeof vi.fn>; updateMenu: ReturnType<typeof vi.fn> } | null;
}): IpcContext {
  return {
    agent: {} as IpcContext['agent'],
    sprite: {
      getConfig: vi.fn(() => ({
        silentMode: false,
        silentModeExpiresAt: null,
      })),
      updateConfig: vi.fn(),
      // QC-CONFIG-01：默认 batch 成功，单个测试可覆盖为失败以验证事务回滚
      updateConfigBatch: vi.fn(() => ({ updated: true })),
      listPersonas: vi.fn(() => ['default', 'coder']),
      switchPersona: vi.fn(() => 'coder'),
      setPersonaMode: vi.fn(() => true),
      personaMode: 'auto',
      ...overrides?.sprite,
    } as unknown as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
    windowStateManager: {} as IpcContext['windowStateManager'],
    windowManager: {} as IpcContext['windowManager'],
    trayManager: overrides?.trayManager ?? null,
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  };
}

// ─── scheduleSilentRecovery 纯函数测试 ───────────────────

describe('scheduleSilentRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('未启用静默模式不应设置定时器', () => {
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: false, silentModeExpiresAt: null })),
      },
    });
    scheduleSilentRecovery(ctx);

    // 推进时间，不应有任何副作用
    vi.advanceTimersByTime(10000);
    expect(ctx.sprite.updateConfig).not.toHaveBeenCalled();
  });

  it('silentModeExpiresAt 为 null 不应设置定时器', () => {
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: true, silentModeExpiresAt: null })),
      },
    });
    scheduleSilentRecovery(ctx);

    vi.advanceTimersByTime(10000);
    expect(ctx.sprite.updateConfig).not.toHaveBeenCalled();
  });

  it('已过期应立即关闭静默模式 + 更新托盘', () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const expiredTime = new Date(Date.now() - 1000).toISOString();
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: true, silentModeExpiresAt: expiredTime })),
      },
      trayManager: { setState, updateMenu },
    });
    scheduleSilentRecovery(ctx);

    expect(ctx.sprite.updateConfig).toHaveBeenCalledWith('silentMode', false);
    expect(ctx.sprite.updateConfig).toHaveBeenCalledWith('silentModeExpiresAt', null);
    expect(setState).toHaveBeenCalledWith('idle');
    expect(updateMenu).toHaveBeenCalled();
  });

  it('未来到期应设置定时器，到期后关闭静默模式', () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const futureTime = new Date(Date.now() + 5000).toISOString();
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: true, silentModeExpiresAt: futureTime })),
      },
      trayManager: { setState, updateMenu },
    });
    scheduleSilentRecovery(ctx);

    // 未到期不应调用 updateConfig
    vi.advanceTimersByTime(4999);
    expect(ctx.sprite.updateConfig).not.toHaveBeenCalled();

    // 到期应关闭静默模式
    vi.advanceTimersByTime(1);
    expect(ctx.sprite.updateConfig).toHaveBeenCalledWith('silentMode', false);
    expect(ctx.sprite.updateConfig).toHaveBeenCalledWith('silentModeExpiresAt', null);
    expect(setState).toHaveBeenCalledWith('idle');
    expect(updateMenu).toHaveBeenCalled();
  });

  it('trayManager=null 时已过期仍应关闭静默模式（不抛错）', () => {
    const expiredTime = new Date(Date.now() - 1000).toISOString();
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: true, silentModeExpiresAt: expiredTime })),
      },
      trayManager: null,
    });
    expect(() => scheduleSilentRecovery(ctx)).not.toThrow();
    expect(ctx.sprite.updateConfig).toHaveBeenCalledWith('silentMode', false);
  });

  it('重复调用应清除已有定时器（避免叠加）', () => {
    const futureTime = new Date(Date.now() + 5000).toISOString();
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => ({ silentMode: true, silentModeExpiresAt: futureTime })),
      },
    });
    scheduleSilentRecovery(ctx);
    scheduleSilentRecovery(ctx); // 第二次应清除第一次的定时器

    // 推进时间，updateConfig 应只被调用一次（第二个定时器触发）
    vi.advanceTimersByTime(5000);
    // 两次 scheduleSilentRecovery 各设置一个定时器，但第二次清除了第一次
    // 最终只有第二个定时器触发，updateConfig 被调用 2 次（silentMode + silentModeExpiresAt）
    expect(ctx.sprite.updateConfig).toHaveBeenCalledTimes(2);
  });
});

// ─── registerConfigHandlers 测试 ─────────────────────────

describe('registerConfigHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── CONFIG_GET ────────────────────────────────────────

  it('CONFIG_GET 应返回当前配置', async () => {
    const config = { silentMode: false, windowBounds: { width: 900, height: 680 } };
    const ctx = createMockCtx({
      sprite: { getConfig: vi.fn(() => config) },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_GET)!;
    const result = await callback();

    expect(result).toEqual({ config });
  });

  it('CONFIG_GET 抛错应降级返回 DEFAULT_SPRITE_CONFIG', async () => {
    const ctx = createMockCtx({
      sprite: {
        getConfig: vi.fn(() => {
          throw new Error('配置加载失败');
        }),
      },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_GET)!;
    const result = await callback();

    expect(result.config).toBeDefined();
    expect(result.config.silentMode).toBe(false);
  });

  // ─── CONFIG_UPDATE ─────────────────────────────────────

  it('合法配置键应更新成功', async () => {
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ sprite: { updateConfig } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE)!;
    const result = await callback({}, 'silentMode', true);

    expect(updateConfig).toHaveBeenCalledWith('silentMode', true);
    expect(result).toEqual({ updated: true });
  });

  it('非法配置键应拒绝更新', async () => {
    const ctx = createMockCtx();
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE)!;
    const result = await callback({}, 'invalidKey', 'value');

    expect(result).toEqual({ updated: false, error: '非法配置键：invalidKey' });
  });

  it('silentMode=true 应同步托盘为 sleeping 状态', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const ctx = createMockCtx({
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE)!;
    await callback({}, 'silentMode', true);

    expect(setState).toHaveBeenCalledWith('sleeping');
    expect(updateMenu).toHaveBeenCalled();
  });

  it('silentMode=false 应同步托盘为 idle 状态', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const ctx = createMockCtx({
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE)!;
    await callback({}, 'silentMode', false);

    expect(setState).toHaveBeenCalledWith('idle');
  });

  it('trayManager=null 时 silentMode 切换不应抛错', async () => {
    const ctx = createMockCtx({ trayManager: null });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE)!;
    expect(() => callback({}, 'silentMode', true)).not.toThrow();
  });

  // ─── CONFIG_UPDATE_BATCH（QC-CONFIG-01） ───────────────

  it('CONFIG_UPDATE_BATCH 成功应委托 updateConfigBatch 并返回结果', async () => {
    const updateConfigBatch = vi.fn(() => ({ updated: true }));
    const ctx = createMockCtx({ sprite: { updateConfigBatch } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    const updates = { silentMode: true, proactiveThreshold: 5 };
    const result = await callback({}, updates);

    expect(updateConfigBatch).toHaveBeenCalledWith(updates);
    expect(result).toEqual({ updated: true });
  });

  it('CONFIG_UPDATE_BATCH 失败应返回错误且不触发托盘副作用', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const updateConfigBatch = vi.fn(() => ({ updated: false, error: '配置值类型非法：proactiveThreshold' }));
    const ctx = createMockCtx({
      sprite: { updateConfigBatch },
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    const result = await callback({}, { silentMode: true, proactiveThreshold: 'bad' });

    expect(result.updated).toBe(false);
    expect(result.error).toContain('proactiveThreshold');
    // 事务失败：不触发任何托盘副作用
    expect(setState).not.toHaveBeenCalled();
    expect(updateMenu).not.toHaveBeenCalled();
  });

  it('含 silentMode=true 应同步托盘 sleeping + 重建菜单', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const ctx = createMockCtx({
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    await callback({}, { silentMode: true, proactiveThreshold: 5 });

    expect(setState).toHaveBeenCalledWith('sleeping');
    expect(updateMenu).toHaveBeenCalledTimes(1);
  });

  it('含 silentMode=false 应同步托盘 idle', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const ctx = createMockCtx({
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    await callback({}, { silentMode: false });

    expect(setState).toHaveBeenCalledWith('idle');
    expect(updateMenu).toHaveBeenCalledTimes(1);
  });

  it('不含 silentMode 时不应触发托盘同步', async () => {
    const setState = vi.fn();
    const updateMenu = vi.fn();
    const ctx = createMockCtx({
      trayManager: { setState, updateMenu },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    await callback({}, { proactiveThreshold: 5, triggerIntervalMs: 1_800_000 });

    expect(setState).not.toHaveBeenCalled();
    expect(updateMenu).not.toHaveBeenCalled();
  });

  it('trayManager=null 时含 silentMode 不应抛错', async () => {
    const ctx = createMockCtx({ trayManager: null });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    await expect(callback({}, { silentMode: true })).resolves.toEqual({ updated: true });
  });

  it('updateConfigBatch 抛错应降级返回错误', async () => {
    const updateConfigBatch = vi.fn(() => {
      throw new Error('batch 内部错误');
    });
    const ctx = createMockCtx({ sprite: { updateConfigBatch } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_UPDATE_BATCH)!;
    const result = await callback({}, { silentMode: true });

    expect(result.updated).toBe(false);
    expect(result.error).toBe('batch 内部错误');
  });

  // ─── PERSONA_LIST ──────────────────────────────────────

  it('PERSONA_LIST 应返回角色列表', async () => {
    const listPersonas = vi.fn(() => ['default', 'coder', 'writer']);
    const ctx = createMockCtx({ sprite: { listPersonas } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_LIST)!;
    const result = await callback();

    expect(result).toEqual({ personas: ['default', 'coder', 'writer'] });
  });

  it('PERSONA_LIST 抛错应降级返回空列表', async () => {
    const ctx = createMockCtx({
      sprite: {
        listPersonas: vi.fn(() => {
          throw new Error('加载失败');
        }),
      },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_LIST)!;
    const result = await callback();

    expect(result).toEqual({ personas: [] });
  });

  // ─── PERSONA_SWITCH ────────────────────────────────────

  it('PERSONA_SWITCH 成功应返回 switched=true + 新角色名', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ sprite: { switchPersona } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_SWITCH)!;
    const result = await callback({}, 'coder');

    expect(switchPersona).toHaveBeenCalledWith('coder');
    expect(result).toEqual({ switched: true, name: 'coder' });
  });

  it('PERSONA_SWITCH 返回 null 应 switched=false', async () => {
    const ctx = createMockCtx({
      sprite: {
        switchPersona: vi.fn(() => null),
      },
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_SWITCH)!;
    const result = await callback({}, 'unknown');

    expect(result).toEqual({ switched: false, name: null });
  });

  // FOUNDATION-SEAL Phase 3 轮2：角色名称校验失败路径
  it('PERSONA_SWITCH 含路径分隔符应拒绝（不调用 switchPersona）', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ sprite: { switchPersona } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_SWITCH)!;
    const result = await callback({}, '../etc/passwd');

    expect(switchPersona).not.toHaveBeenCalled();
    expect(result).toEqual({ switched: false, name: null });
  });

  it('PERSONA_SWITCH 含空格应拒绝（不调用 switchPersona）', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ sprite: { switchPersona } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_SWITCH)!;
    const result = await callback({}, 'code reviewer');

    expect(switchPersona).not.toHaveBeenCalled();
    expect(result).toEqual({ switched: false, name: null });
  });

  it('PERSONA_SWITCH 空字符串应拒绝（不调用 switchPersona）', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ sprite: { switchPersona } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_SWITCH)!;
    const result = await callback({}, '');

    expect(switchPersona).not.toHaveBeenCalled();
    expect(result).toEqual({ switched: false, name: null });
  });

  // ─── PERSONA_MODE ──────────────────────────────────────

  it('PERSONA_MODE 应调用 setPersonaMode 并返回结果', async () => {
    const setPersonaMode = vi.fn(() => true);
    const ctx = createMockCtx({ sprite: { setPersonaMode } });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_MODE)!;
    const result = await callback({}, 'manual');

    expect(setPersonaMode).toHaveBeenCalledWith('manual');
    expect(result).toEqual({ set: true });
  });

  // ─── PERSONA_MODE_GET ──────────────────────────────────

  it('PERSONA_MODE_GET 应返回当前角色模式', async () => {
    const ctx = createMockCtx({
      sprite: { personaMode: 'manual' } as unknown as IpcContext['sprite'],
    });
    registerConfigHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_MODE_GET)!;
    const result = await callback();

    expect(result).toEqual({ mode: 'manual' });
  });

  it('PERSONA_MODE_GET 抛错应降级返回 auto', async () => {
    const ctx = createMockCtx({
      sprite: {
        personaMode: 'auto',
        getConfig: vi.fn(() => {
          throw new Error('err');
        }),
      } as unknown as IpcContext['sprite'],
    });
    registerConfigHandlers(ctx);

    // 通过覆盖 getter 抛错模拟
    Object.defineProperty(ctx.sprite, 'personaMode', {
      get() {
        throw new Error('读取失败');
      },
    });
    const callback = handleCallbacks.get(IPC_CHANNELS.PERSONA_MODE_GET)!;
    const result = await callback();

    expect(result).toEqual({ mode: 'auto' });
  });
});
