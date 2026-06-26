/**
 * 记忆 CRUD IPC 处理器测试
 *
 * 覆盖范围：
 * - MEMORIES_LIST：列出记忆（含 source 过滤）+ 失败降级
 * - MEMORIES_SEARCH：搜索记忆 + 失败降级
 * - MEMORIES_SHOW：查看记忆详情 + 失败降级
 * - MEMORIES_DELETE：删除记忆 + 失败降级
 * - MEMORIES_ADD：添加记忆 + 输入验证（超大内容拒绝）+ 失败降级
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map 捕获注册的回调
 * - IpcContext.sprite：mock listMemories/searchMemories/showMemory/deleteMemory/upsertMemory
 * - 复用 ipcHandlers.test.ts 的 mock 模板
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

// 导入被测模块（在 mock 之后）
import { registerMemoryHandlers } from '../../electron/ipc/memoryHandlers.js';
import { IPC_CHANNELS } from '../../electron/ipc/channels.js';
import type { IpcContext } from '../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock IpcContext（仅包含 memoryHandlers 需要的 sprite 方法） */
function createMockCtx(overrides?: {
  listMemories?: ReturnType<typeof vi.fn>;
  searchMemories?: ReturnType<typeof vi.fn>;
  showMemory?: ReturnType<typeof vi.fn>;
  deleteMemory?: ReturnType<typeof vi.fn>;
  upsertMemory?: ReturnType<typeof vi.fn>;
}): IpcContext {
  return {
    agent: {} as IpcContext['agent'],
    sprite: {
      listMemories: overrides?.listMemories ?? vi.fn(() => []),
      searchMemories: overrides?.searchMemories ?? vi.fn(async () => []),
      showMemory: overrides?.showMemory ?? vi.fn(() => null),
      deleteMemory: overrides?.deleteMemory ?? vi.fn(() => false),
      upsertMemory: overrides?.upsertMemory ?? vi.fn(() => 'new-id'),
    } as unknown as IpcContext['sprite'],
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

describe('registerMemoryHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── MEMORIES_LIST ─────────────────────────────────────

  it('MEMORIES_LIST 应返回记忆列表', async () => {
    const memories = [{ id: '1', name: '记忆1' }];
    const listMemories = vi.fn(() => memories);
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    const result = await callback({}, { source: 'profile' });

    expect(listMemories).toHaveBeenCalledWith('profile');
    expect(result).toEqual({ memories });
  });

  it('MEMORIES_LIST 无 source 参数应传递 undefined', async () => {
    const listMemories = vi.fn(() => []);
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    await callback({}, {});

    expect(listMemories).toHaveBeenCalledWith(undefined);
  });

  it('MEMORIES_LIST 抛错应降级返回空列表', async () => {
    const listMemories = vi.fn(() => {
      throw new Error('数据库错误');
    });
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    const result = await callback({}, {});

    expect(result).toEqual({ memories: [] });
  });

  // ─── MEMORIES_SEARCH ───────────────────────────────────

  it('MEMORIES_SEARCH 应返回搜索结果', async () => {
    const hits = [{ id: '1', score: 0.95 }];
    const searchMemories = vi.fn(async () => hits);
    const ctx = createMockCtx({ searchMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SEARCH)!;
    const result = await callback({}, '关键词');

    expect(searchMemories).toHaveBeenCalledWith('关键词');
    expect(result).toEqual({ hits });
  });

  it('MEMORIES_SEARCH 抛错应降级返回空结果', async () => {
    const searchMemories = vi.fn(async () => {
      throw new Error('搜索失败');
    });
    const ctx = createMockCtx({ searchMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SEARCH)!;
    const result = await callback({}, '关键词');

    expect(result).toEqual({ hits: [] });
  });

  // ─── MEMORIES_SHOW ─────────────────────────────────────

  it('MEMORIES_SHOW 应返回记忆详情', async () => {
    const memory = { id: '1', name: '记忆1', content: '内容' };
    const showMemory = vi.fn(() => memory);
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    const result = await callback({}, '1');

    expect(showMemory).toHaveBeenCalledWith('1');
    expect(result).toEqual({ memory });
  });

  it('MEMORIES_SHOW 抛错应降级返回 null', async () => {
    const showMemory = vi.fn(() => {
      throw new Error('未找到');
    });
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    const result = await callback({}, '1');

    expect(result).toEqual({ memory: null });
  });

  // ─── MEMORIES_DELETE ───────────────────────────────────

  it('MEMORIES_DELETE 应返回删除结果', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE)!;
    const result = await callback({}, '1');

    expect(deleteMemory).toHaveBeenCalledWith('1');
    expect(result).toEqual({ deleted: true });
  });

  it('MEMORIES_DELETE 抛错应降级返回 deleted: false', async () => {
    const deleteMemory = vi.fn(() => {
      throw new Error('删除失败');
    });
    const ctx = createMockCtx({ deleteMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE)!;
    const result = await callback({}, '1');

    expect(result).toEqual({ deleted: false });
  });

  // ─── MEMORIES_ADD ──────────────────────────────────────

  it('MEMORIES_ADD 合法内容应返回新 ID', async () => {
    const upsertMemory = vi.fn(() => 'new-id');
    const ctx = createMockCtx({ upsertMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD)!;
    const result = await callback({}, {
      source: 'insight',
      name: '新记忆',
      content: '合法内容',
    });

    expect(upsertMemory).toHaveBeenCalledWith('insight', '新记忆', '合法内容');
    expect(result).toEqual({ id: 'new-id' });
  });

  it('MEMORIES_ADD 超大内容应拒绝（返回空 ID）', async () => {
    const upsertMemory = vi.fn();
    const ctx = createMockCtx({ upsertMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD)!;
    // 构造超过 10MB 的内容
    const hugeContent = 'a'.repeat(11 * 1024 * 1024);
    const result = await callback({}, {
      source: 'insight',
      name: '超大记忆',
      content: hugeContent,
    });

    expect(upsertMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ id: '' });
  });

  it('MEMORIES_ADD 抛错应降级返回空 ID', async () => {
    const upsertMemory = vi.fn(() => {
      throw new Error('写入失败');
    });
    const ctx = createMockCtx({ upsertMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD)!;
    const result = await callback({}, {
      source: 'insight',
      name: '新记忆',
      content: '合法内容',
    });

    expect(result).toEqual({ id: '' });
  });
});
