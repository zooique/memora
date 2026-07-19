/**
 * 系统级 IPC 处理器测试
 *
 * 覆盖范围：
 * - PROACTIVE_PROMPT_SHOWN：on 监听 + trayManager.setState('idle')
 * - PROACTIVE_ACCEPT/REJECT：on 监听 + sprite.recordProactiveAccept/Reject
 * - PROJECTS_LIST：列出项目 + 失败降级 + 非 Error 抛出
 * - DASHBOARD_GET：仪表盘聚合 + sourceHealth 降级 + metrics 降级 + 外层 catch 降级 + skills 映射
 * - PERCEPTION_GET：感知快照 + null 降级 + 抛错降级
 * - STARTUP_SUMMARY_GET：启动摘要 + null 透传 + 抛错降级
 * - THEME_CHANGED：on 监听 + floatWindow.broadcastTheme + light/dark 双主题
 * - USAGE_STATS_EXPORT：导出 + 采集器未就绪 + 抛错降级
 * - USAGE_STATS_CLEAR：清除 + 采集器未就绪 + 抛错静默
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks/onCallbacks Map
 * - IpcContext.sprite：mock dashboard/sourceHealth/getMetrics/listProjects/recordProactiveAccept/Reject/getPerceptionSnapshot/getStartupSummary
 * - IpcContext.trayManager：mock setState
 * - IpcContext.windowManager：mock getFloatWindow().broadcastTheme
 * - IpcContext.usageStatsCollector：mock export/clear
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
  usageStatsCollector?: { export: () => Promise<string>; clear: () => Promise<void> } | null;
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
      recordProactiveAccept: vi.fn(),
      recordProactiveReject: vi.fn(),
      getPerceptionSnapshot: vi.fn(() => ({ affect: { warmth: 0.5 } })),
      getStartupSummary: vi.fn(() => ({ totalMemories: 10 })),
      ...overrides?.sprite,
    } as unknown as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
    windowManager: {
      getFloatWindow: vi.fn(() => floatWindow),
    } as unknown as IpcContext['windowManager'],
    trayManager: overrides?.trayManager ?? null,
    shortcutManager: null,
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
    usageStatsCollector: (overrides?.usageStatsCollector ?? null) as IpcContext['usageStatsCollector'],
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

  // ─── PROACTIVE_ACCEPT ─────────────────────────────────

  it('PROACTIVE_ACCEPT 应调用 sprite.recordProactiveAccept()', () => {
    const recordProactiveAccept = vi.fn();
    const ctx = createMockCtx({ sprite: { recordProactiveAccept } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_ACCEPT)!;
    callback();

    expect(recordProactiveAccept).toHaveBeenCalledOnce();
  });

  it('PROACTIVE_ACCEPT 多次调用应每次都触发 recordProactiveAccept()', () => {
    const recordProactiveAccept = vi.fn();
    const ctx = createMockCtx({ sprite: { recordProactiveAccept } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_ACCEPT)!;
    callback();
    callback();
    callback();

    expect(recordProactiveAccept).toHaveBeenCalledTimes(3);
  });

  // ─── PROACTIVE_REJECT ─────────────────────────────────

  it('PROACTIVE_REJECT 应调用 sprite.recordProactiveReject()', () => {
    const recordProactiveReject = vi.fn();
    const ctx = createMockCtx({ sprite: { recordProactiveReject } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_REJECT)!;
    callback();

    expect(recordProactiveReject).toHaveBeenCalledOnce();
  });

  it('PROACTIVE_REJECT 多次调用应每次都触发 recordProactiveReject()', () => {
    const recordProactiveReject = vi.fn();
    const ctx = createMockCtx({ sprite: { recordProactiveReject } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.PROACTIVE_REJECT)!;
    callback();
    callback();

    expect(recordProactiveReject).toHaveBeenCalledTimes(2);
  });

  // ─── DASHBOARD_GET 补充分支 ───────────────────────────

  it('DASHBOARD_GET 应包含 sprite.pendingCount 作为 pendingNotices', () => {
    const ctx = createMockCtx({ sprite: { pendingCount: 7 } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.pendingNotices).toBe(7);
  });

  it('DASHBOARD_GET 应包含 sprite.proactiveThreshold', () => {
    const ctx = createMockCtx({ sprite: { proactiveThreshold: 5 } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.proactiveThreshold).toBe(5);
  });

  it('DASHBOARD_GET 应包含 sprite.registeredTriggers', () => {
    const triggers = ['trigger-1', 'trigger-2'];
    const ctx = createMockCtx({ sprite: { registeredTriggers: triggers } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.registeredTriggers).toEqual(triggers);
  });

  it('DASHBOARD_GET agent.skills 为 null 时 skills 应返回空数组', () => {
    const ctx = createMockCtx({ agent: { skills: null } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.skills).toEqual([]);
  });

  it('DASHBOARD_GET 技能缺少 description 时应降级为空字符串', () => {
    const ctx = createMockCtx({
      agent: {
        skills: {
          list: [
            { name: '技能A', keywords: ['a'], layer: 'agent' },
          ],
        },
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.skills).toEqual([
      { name: '技能A', keywords: ['a'], description: '', layer: 'agent' },
    ]);
  });

  it('DASHBOARD_GET sourceHealth 和 metrics 都抛错时应同时降级为 null', () => {
    const ctx = createMockCtx({
      sprite: {
        sourceHealth: vi.fn(() => {
          throw new Error('健康失败');
        }),
        getMetrics: vi.fn(() => {
          throw new Error('指标失败');
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.sourceHealth).toBeNull();
    expect(result.metrics).toBeNull();
    expect(result.total).toBe(10);
  });

  it('DASHBOARD_GET sourceHealth 抛出非 Error 对象时应降级为 null', () => {
    const ctx = createMockCtx({
      sprite: {
        sourceHealth: vi.fn(() => {
          throw '字符串错误';
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.sourceHealth).toBeNull();
  });

  it('DASHBOARD_GET 多个技能应全部映射为 IPC 传输形态', () => {
    const ctx = createMockCtx({
      agent: {
        skills: {
          list: [
            { name: '技能1', keywords: ['k1'], description: '描述1', layer: 'agent' },
            { name: '技能2', keywords: ['k2', 'k3'], description: '描述2', layer: 'project' },
          ],
        },
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]).toEqual({
      name: '技能1',
      keywords: ['k1'],
      description: '描述1',
      layer: 'agent',
    });
    expect(result.skills[1]).toEqual({
      name: '技能2',
      keywords: ['k2', 'k3'],
      description: '描述2',
      layer: 'project',
    });
  });

  it('DASHBOARD_GET 应透传 dashboard 的 suggestions 字段', () => {
    const suggestions = [{ id: 's1', text: '建议1' }];
    const ctx = createMockCtx({
      sprite: {
        dashboard: vi.fn(() => ({
          total: 5,
          bySource: { insight: 3 },
          suggestions,
        })),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.DASHBOARD_GET)!;
    const result = callback();

    expect(result.suggestions).toBe(suggestions);
  });

  // ─── PERCEPTION_GET ───────────────────────────────────

  it('PERCEPTION_GET 正常应返回感知快照', () => {
    const snapshot = { affect: { warmth: 0.8 }, rapport: { level: 'close' } };
    const ctx = createMockCtx({
      sprite: { getPerceptionSnapshot: vi.fn(() => snapshot) },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERCEPTION_GET)!;
    const result = callback();

    expect(result).toEqual(snapshot);
  });

  it('PERCEPTION_GET 返回 null 时应降级为空对象', () => {
    const ctx = createMockCtx({
      sprite: { getPerceptionSnapshot: vi.fn(() => null) },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERCEPTION_GET)!;
    const result = callback();

    expect(result).toEqual({});
  });

  it('PERCEPTION_GET 抛错时应降级为空对象', () => {
    const ctx = createMockCtx({
      sprite: {
        getPerceptionSnapshot: vi.fn(() => {
          throw new Error('感知失败');
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PERCEPTION_GET)!;
    const result = callback();

    expect(result).toEqual({});
  });

  // ─── STARTUP_SUMMARY_GET ──────────────────────────────

  it('STARTUP_SUMMARY_GET 正常应返回启动摘要', () => {
    const summary = { totalMemories: 20, totalInsights: 5, skillCount: 3 };
    const ctx = createMockCtx({
      sprite: { getStartupSummary: vi.fn(() => summary) },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.STARTUP_SUMMARY_GET)!;
    const result = callback();

    expect(result).toEqual(summary);
  });

  it('STARTUP_SUMMARY_GET 返回 null 时应透传 null', () => {
    const ctx = createMockCtx({
      sprite: { getStartupSummary: vi.fn(() => null) },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.STARTUP_SUMMARY_GET)!;
    const result = callback();

    expect(result).toBeNull();
  });

  it('STARTUP_SUMMARY_GET 抛错时应降级为 null', () => {
    const ctx = createMockCtx({
      sprite: {
        getStartupSummary: vi.fn(() => {
          throw new Error('摘要失败');
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.STARTUP_SUMMARY_GET)!;
    const result = callback();

    expect(result).toBeNull();
  });

  // ─── THEME_CHANGED 补充 ───────────────────────────────

  it('THEME_CHANGED light 主题应广播 light 到浮动窗口', () => {
    const broadcastTheme = vi.fn();
    const ctx = createMockCtx({ floatWindow: { broadcastTheme } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
    callback({}, 'light');

    expect(broadcastTheme).toHaveBeenCalledWith('light');
  });

  it('THEME_CHANGED 应忽略 event 参数仅透传 theme', () => {
    const broadcastTheme = vi.fn();
    const ctx = createMockCtx({ floatWindow: { broadcastTheme } });
    registerSystemHandlers(ctx);

    const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
    const fakeEvent = { sender: {}, frameId: 1 };
    callback(fakeEvent, 'dark');

    expect(broadcastTheme).toHaveBeenCalledOnce();
    expect(broadcastTheme).toHaveBeenCalledWith('dark');
  });

  // ─── PROJECTS_LIST 补充 ───────────────────────────────

  it('PROJECTS_LIST 空项目列表应返回空数组', async () => {
    const ctx = createMockCtx({ sprite: { listProjects: vi.fn(() => []) } });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PROJECTS_LIST)!;
    const result = await callback();

    expect(result).toEqual({ projects: [] });
  });

  it('PROJECTS_LIST 抛出非 Error 对象时应向上抛出（throwingHandle 透传）', async () => {
    const ctx = createMockCtx({
      sprite: {
        listProjects: vi.fn(() => {
          throw '字符串错误';
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.PROJECTS_LIST)!;
    await expect(callback()).rejects.toBe('字符串错误');
  });

  // ─── USAGE_STATS_EXPORT ───────────────────────────────

  it('USAGE_STATS_EXPORT 采集器未就绪时应返回 null', async () => {
    const ctx = createMockCtx({ usageStatsCollector: null });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_EXPORT)!;
    const result = await callback();

    expect(result).toBeNull();
  });

  it('USAGE_STATS_EXPORT 正常应返回文件路径', async () => {
    const exportFn = vi.fn(async () => '/path/to/stats.json');
    const ctx = createMockCtx({
      usageStatsCollector: { export: exportFn, clear: vi.fn() },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_EXPORT)!;
    const result = await callback();

    expect(exportFn).toHaveBeenCalledOnce();
    expect(result).toBe('/path/to/stats.json');
  });

  it('USAGE_STATS_EXPORT 导出抛错时应降级为 null', async () => {
    const ctx = createMockCtx({
      usageStatsCollector: {
        export: vi.fn(async () => {
          throw new Error('导出失败');
        }),
        clear: vi.fn(),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_EXPORT)!;
    const result = await callback();

    expect(result).toBeNull();
  });

  // ─── USAGE_STATS_CLEAR ────────────────────────────────

  it('USAGE_STATS_CLEAR 采集器未就绪时应返回 undefined', async () => {
    const ctx = createMockCtx({ usageStatsCollector: null });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_CLEAR)!;
    const result = await callback();

    expect(result).toBeUndefined();
  });

  it('USAGE_STATS_CLEAR 正常应调用 collector.clear()', async () => {
    const clearFn = vi.fn(async () => undefined);
    const ctx = createMockCtx({
      usageStatsCollector: { export: vi.fn(), clear: clearFn },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_CLEAR)!;
    await callback();

    expect(clearFn).toHaveBeenCalledOnce();
  });

  it('USAGE_STATS_CLEAR 清除抛错时不应向上抛出（静默降级）', async () => {
    const ctx = createMockCtx({
      usageStatsCollector: {
        export: vi.fn(),
        clear: vi.fn(async () => {
          throw new Error('清除失败');
        }),
      },
    });
    registerSystemHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.USAGE_STATS_CLEAR)!;
    await expect(callback()).resolves.toBeUndefined();
  });

  // ─── 注册完整性 ────────────────────────────────────────

  it('registerSystemHandlers 应注册所有系统级 IPC 通道', () => {
    const ctx = createMockCtx();
    registerSystemHandlers(ctx);

    // handle 类通道（invoke）
    expect(handleCallbacks.has(IPC_CHANNELS.PROJECTS_LIST)).toBe(true);
    expect(handleCallbacks.has(IPC_CHANNELS.DASHBOARD_GET)).toBe(true);
    expect(handleCallbacks.has(IPC_CHANNELS.PERCEPTION_GET)).toBe(true);
    expect(handleCallbacks.has(IPC_CHANNELS.STARTUP_SUMMARY_GET)).toBe(true);
    expect(handleCallbacks.has(IPC_CHANNELS.USAGE_STATS_EXPORT)).toBe(true);
    expect(handleCallbacks.has(IPC_CHANNELS.USAGE_STATS_CLEAR)).toBe(true);

    // on 类通道（send）
    expect(onCallbacks.has(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN)).toBe(true);
    expect(onCallbacks.has(IPC_CHANNELS.PROACTIVE_ACCEPT)).toBe(true);
    expect(onCallbacks.has(IPC_CHANNELS.PROACTIVE_REJECT)).toBe(true);
    expect(onCallbacks.has(IPC_CHANNELS.THEME_CHANGED)).toBe(true);
  });
});
