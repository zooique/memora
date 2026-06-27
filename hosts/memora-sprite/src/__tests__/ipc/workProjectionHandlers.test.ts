/**
 * 作品投影 IPC 处理器测试
 *
 * 覆盖范围：
 * - WORK_PROJECTION_LIST：列出所有投影 + works=null 降级 + 抛错降级
 * - WORK_PROJECTION_SHOW：查看单个投影 + works=null 降级 + entry=null 降级 + 抛错降级
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map
 * - IpcContext.agent.works：mock loadAll/getProjection（async 方法）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerWorkProjectionHandlers } from '../../electron/ipc/workProjectionHandlers.js';
import { IPC_CHANNELS } from '../../electron/ipc/channels.js';
import type { IpcContext } from '../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock 作品投影条目 */
function createMockEntry(id: string, filePath: string) {
  return {
    id,
    sourcePath: filePath,
    fileHash: 'hash-' + id,
    summary: '摘要-' + id,
    structure: '结构-' + id,
    keyDecisions: ['决策1', '决策2'],
    updatedAt: '2026-06-26T00:00:00Z',
  };
}

/** 创建 mock IpcContext（含 agent.works 可空） */
function createMockCtx(works: unknown): IpcContext {
  return {
    agent: { works } as unknown as IpcContext['agent'],
    sprite: {} as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
    windowStateManager: {} as IpcContext['windowStateManager'],
    windowManager: {} as IpcContext['windowManager'],
    trayManager: null,
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('registerWorkProjectionHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── WORK_PROJECTION_LIST ──────────────────────────────

  it('应返回所有作品投影列表', async () => {
    const entries = [createMockEntry('1', '/path/a.ts'), createMockEntry('2', '/path/b.ts')];
    const works = {
      loadAll: vi.fn(async () => entries),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_LIST)!;
    const result = await callback();

    expect(works.loadAll).toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: '1',
      sourcePath: '/path/a.ts',
      fileHash: 'hash-1',
      summary: '摘要-1',
      structure: '结构-1',
      keyDecisions: ['决策1', '决策2'],
      updatedAt: '2026-06-26T00:00:00Z',
    });
  });

  it('works=null 应降级返回空数组', async () => {
    const ctx = createMockCtx(null);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_LIST)!;
    const result = await callback();

    expect(result).toEqual([]);
  });

  it('loadAll 抛错应降级返回空数组', async () => {
    const works = {
      loadAll: vi.fn(async () => {
        throw new Error('加载失败');
      }),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_LIST)!;
    const result = await callback();

    expect(result).toEqual([]);
  });

  // ─── WORK_PROJECTION_SHOW ──────────────────────────────

  it('应返回指定路径的作品投影详情', async () => {
    const entry = createMockEntry('1', '/path/file.ts');
    const works = {
      getProjection: vi.fn(async () => entry),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, '/path/file.ts');

    expect(works.getProjection).toHaveBeenCalledWith('/path/file.ts');
    expect(result).toEqual({
      id: '1',
      sourcePath: '/path/file.ts',
      fileHash: 'hash-1',
      summary: '摘要-1',
      structure: '结构-1',
      keyDecisions: ['决策1', '决策2'],
      updatedAt: '2026-06-26T00:00:00Z',
    });
  });

  it('works=null 应降级返回 null', async () => {
    const ctx = createMockCtx(null);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, '/path/file.ts');

    expect(result).toBeNull();
  });

  it('getProjection 返回 null 应降级返回 null', async () => {
    const works = {
      getProjection: vi.fn(async () => null),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, '/path/unknown.ts');

    expect(result).toBeNull();
  });

  it('getProjection 抛错应降级返回 null', async () => {
    const works = {
      getProjection: vi.fn(async () => {
        throw new Error('查询失败');
      }),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, '/path/file.ts');

    expect(result).toBeNull();
  });

  // ─── FOUNDATION-SEAL Phase 3 轮3：filePath 校验失败路径 ──

  it('空字符串 filePath 应降级返回 null（不调用 works.getProjection）', async () => {
    const works = {
      getProjection: vi.fn(async () => createMockEntry('1', '/path/file.ts')),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, '');

    expect(result).toBeNull();
    expect(works.getProjection).not.toHaveBeenCalled();
  });

  it('非字符串 filePath 应降级返回 null', async () => {
    const works = {
      getProjection: vi.fn(async () => createMockEntry('1', '/path/file.ts')),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, null as unknown as string);

    expect(result).toBeNull();
    expect(works.getProjection).not.toHaveBeenCalled();
  });

  it('超长 filePath（1001 字符）应降级返回 null', async () => {
    const works = {
      getProjection: vi.fn(async () => createMockEntry('1', '/path/file.ts')),
    };
    const ctx = createMockCtx(works);
    registerWorkProjectionHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.WORK_PROJECTION_SHOW)!;
    const result = await callback({}, 'a'.repeat(1001));

    expect(result).toBeNull();
    expect(works.getProjection).not.toHaveBeenCalled();
  });
});
