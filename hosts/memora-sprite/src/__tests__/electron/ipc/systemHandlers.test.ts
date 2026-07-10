/**
 * 系统级 IPC 处理器测试
 *
 * 覆盖范围：
 * - PROACTIVE_PROMPT_SHOWN：on 监听 + trayManager.setState('idle')
 * - PROJECTS_LIST：列出项目 + 失败降级
 * - DASHBOARD_GET：仪表盘聚合 + sourceHealth 降级 + metrics 降级 + 外层 catch 降级
 * - THEME_CHANGED：on 监听 + floatWindow.broadcastTheme
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks/onCallbacks Map
 * - IpcContext.sprite：mock dashboard/sourceHealth/getMetrics/listProjects
 * - IpcContext.trayManager：mock setState
 * - IpcContext.windowManager：mock getFloatWindow().broadcastTheme
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock electron 模块 ──────────────────────────────────
const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();
const onCallbacks = new Map<string, (...args: unknown[]) => void>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      onCallbacks.set(channel, callback);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      onCallbacks.delete(channel);
    }),
  },
}));

// ─── Mock memora 模块（logger.debug 用于降级日志） ────────
vi.mock('memora', () => ({
  toError: (err: unknown): Error => (err instanceof Error ? err : new Error(String(err))),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { registerSystemHandlers } from '../../../electron/ipc/systemHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock IpcContext */
function createMockCtx(overrides?: {
  trayManager?: { setState: ReturnType<typeof vi.fn> } | null;
  floatWindow?: { broadcastTheme: ReturnType<typeof vi.fn> } | null;
  sprite?: Partial<IpcContext['sprite']>;
  agent?: Partial<IpcContext['agent']>;
}): IpcContext {
  const floatWindow = overrides?.floatWindow ?? { broadcastTheme: vi.fn() };
  return {
    agent: {
      skills: { list: [] },
      ...overrides?.agent,
    } as unknown as IpcContext['agent'],
    sprite: {
      dashboard: vi.fn(() => ({
        total: 10,
        bySource: { insight: 5, profile: 5 },
        suggestions: [],
      })),
      sourceHealth: vi.fn(() => ({ insight: { count: 5 } })),
      getMetrics: vi.fn(() => ({ llm: { calls: 10 } })),
      listProjects: vi.fn(() => ['project-a', 'project-b']),
      pendingCount: 2,
      proactiveThreshold: 3,
      registeredTriggers: ['trigger-1'],
      ...overrides?.sprite,
    } as unknown as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
    windowStateManager: {} as IpcContext['windowStateManager'],
    windowManager: {
      getFloatWindow: vi.fn(() => floatWindow),
    } as unknown as IpcContext['windowManager'],
    trayManager: overrides?.trayManager ?? null,
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('registerSystemHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    onCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── PROACTIVE_PROMPT_SHOWN ────────────────────────────

  it('PROACTIVE_PROMPT_SHOWN 应调用 trayManager.setState("idle")', () => {
    const setState = vi.fn();
    const ctx = createMockCtx({ trayManager: { setState } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN)!;
    callback();

    expect(setState).toHaveBeenCalledWith('idle');
  });

  it('trayManager=null 时 PROACTIVE_PROMPT_SHOWN 不应抛错', () => {
    const ctx = createMockCtx({ trayManager: null });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN)!;
    expect(() => callback()).not.toThrow();
  });

  // ─── PROJECTS_LIST ─────────────────────────────────────

  it('PROJECTS_LIST 应返回项目列表', async () => {
    const listProjects = vi.fn(() => ['project-a', 'project-b']);
    const ctx = createMockCtx({ sprite: { listProjects } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PROJECTS_LIST)!;
    const result = await callback();

    expect(listProjects).toHaveBeenCalled();
    expect(result).toEqual({ projects: ['project-a', 'project-b'] });
  });

  it('PROJECTS_LIST 抛错应向上抛出（让渲染层感知加载失败）', async () => {
    const listProjects = vi.fn(() => {
      throw new Error('加载失败');
    });
    const ctx = createMockCtx({ sprite: { listProjects } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PROJECTS_LIST)!;
    await expect(callback()).rejects.toThrow('加载失败');
  });

  // ─── DASHBOARD_GET ─────────────────────────────────────

  it('DASHBOARD_GET 正常应返回聚合数据', () => {
    const ctx = createMockCtx();
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result).toEqual({
      total: 10,
      bySource: { insight: 5, profile: 5 },
      suggestions: [],
      pendingNotices: 2,
      proactiveThreshold: 3,
      registeredTriggers: ['trigger-1'],
      sourceHealth: { insight: { count: 5 } },
      metrics: { llm: { calls: 10 } },
      skills: [],
    });
  });

  it('sourceHealth 抛错应降级为 null（仪表盘仍正常返回）', () => {
    const sourceHealth = vi.fn(() => {
      throw new Error('健康诊断失败');
    });
    const ctx = createMockCtx({ sprite: { sourceHealth } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.sourceHealth).toBeNull();
    expect(result.total).toBe(10); // 其他字段仍正常
  });

  it('metrics 抛错应降级为 null（仪表盘仍正常返回）', () => {
    const getMetrics = vi.fn(() => {
      throw new Error('指标获取失败');
    });
    const ctx = createMockCtx({ sprite: { getMetrics } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.metrics).toBeNull();
    expect(result.total).toBe(10);
  });

  it('dashboard 主调用抛错应向上抛出（让渲染层感知加载失败）', () => {
    const dashboard = vi.fn(() => {
      throw new Error('仪表盘失败');
    });
    const ctx = createMockCtx({ sprite: { dashboard } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    // 主查询失败时显性抛出，让渲染层 loadDashboard 的 catch 触发 showToast
    expect(() => callback()).toThrow('仪表盘失败');
  });

  it('agent.skills 有数据应映射为 IPC 传输形态', () => {
    const ctx = createMockCtx({
      agent: {
        skills: {
          list: [
            {
              name: '代码审查',
              keywords: ['review'],
              description: '审查代码质量',
              layer: 'project',
            },
          ],
        },
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.skills).toEqual([
      {
        name: '代码审查',
        keywords: ['review'],
        description: '审查代码质量',
        layer: 'project',
      },
    ]);
  });

  // ─── THEME_CHANGED ─────────────────────────────────────

  it('THEME_CHANGED 应广播主题到浮动窗口', () => {
    const broadcastTheme = vi.fn();
    const ctx = createMockCtx({ floatWindow: { broadcastTheme } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
    callback({}, 'dark');

    expect(broadcastTheme).toHaveBeenCalledWith('dark');
  });

  it('floatWindow=null 时 THEME_CHANGED 不应抛错', () => {
    const ctx = createMockCtx({ floatWindow: null });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
    expect(() => callback({}, 'light')).not.toThrow();
  });
});
