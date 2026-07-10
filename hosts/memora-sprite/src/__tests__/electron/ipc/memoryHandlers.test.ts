/**
 * 记忆 CRUD IPC 处理器测试
 *
 * 覆盖范围：
 * - MEMORIES_LIST：列出记忆（含 source 过滤）+ 失败降级
 * - MEMORIES_SEARCH：搜索记忆 + 失败降级 + 输入验证（非字符串/超长拒绝）
 * - MEMORIES_SHOW：查看记忆详情 + 失败降级 + 输入验证（空/非字符串/超长 ID 拒绝）
 * - MEMORIES_DELETE：删除记忆 + 失败降级 + 输入验证（空/非字符串/超长 ID 拒绝）
 * - MEMORIES_ADD：添加记忆 + 输入验证（超大内容拒绝）+ 失败降级
 * - MEMORIES_ARCHIVE_PROFILE：手动归档个人偏好 + 失败降级 + 输入验证
 * - MEMORIES_ARCHIVE_INSIGHT：手动归档洞察 + 失败降级 + 输入验证
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map 捕获注册的回调
 * - IpcContext.sprite：mock listMemories/searchMemories/showMemory/deleteMemory/upsertMemory/archiveProfileFacts/archiveInsight
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
import { registerMemoryHandlers } from '../../../electron/ipc/memoryHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock IpcContext（仅包含 memoryHandlers 需要的 sprite 方法） */
function createMockCtx(overrides?: {
  listMemories?: ReturnType<typeof vi.fn>;
  searchMemories?: ReturnType<typeof vi.fn>;
  showMemory?: ReturnType<typeof vi.fn>;
  deleteMemory?: ReturnType<typeof vi.fn>;
  upsertMemory?: ReturnType<typeof vi.fn>;
  archiveProfileFacts?: ReturnType<typeof vi.fn>;
  archiveInsight?: ReturnType<typeof vi.fn>;
}): IpcContext {
  return {
    agent: {} as IpcContext['agent'],
    sprite: {
      listMemories: overrides?.listMemories ?? vi.fn(() => []),
      searchMemories: overrides?.searchMemories ?? vi.fn(async () => []),
      showMemory: overrides?.showMemory ?? vi.fn(() => null),
      deleteMemory: overrides?.deleteMemory ?? vi.fn(() => false),
      upsertMemory: overrides?.upsertMemory ?? vi.fn(() => 'new-id'),
      // 新增的归档委托方法
      archiveProfileFacts: overrides?.archiveProfileFacts ?? vi.fn(async () => []),
      archiveInsight: overrides?.archiveInsight ?? vi.fn(async () => []),
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

  it('MEMORIES_LIST 抛错应向上抛出（让渲染层感知加载失败）', async () => {
    const listMemories = vi.fn(() => {
      throw new Error('数据库错误');
    });
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    await expect(callback({}, {})).rejects.toThrow('数据库错误');
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

  it('MEMORIES_SEARCH 抛错应向上抛出（让渲染层感知加载失败）', async () => {
    const searchMemories = vi.fn(async () => {
      throw new Error('搜索失败');
    });
    const ctx = createMockCtx({ searchMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SEARCH)!;
    await expect(callback({}, '关键词')).rejects.toThrow('搜索失败');
  });

  // 搜索关键词校验失败路径
  it('MEMORIES_SEARCH 非字符串关键词应抛出校验异常（不调用内核）', async () => {
    const searchMemories = vi.fn(async () => []);
    const ctx = createMockCtx({ searchMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SEARCH)!;
    await expect(callback({}, 123 as unknown as string)).rejects.toThrow('非法搜索关键词');

    expect(searchMemories).not.toHaveBeenCalled();
  });

  it('MEMORIES_SEARCH 超长关键词应抛出校验异常（不调用内核）', async () => {
    const searchMemories = vi.fn(async () => []);
    const ctx = createMockCtx({ searchMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SEARCH)!;
    await expect(callback({}, 'a'.repeat(1001))).rejects.toThrow('非法搜索关键词');

    expect(searchMemories).not.toHaveBeenCalled();
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

  it('MEMORIES_SHOW 抛错应向上抛出（让渲染层感知加载失败）', async () => {
    const showMemory = vi.fn(() => {
      throw new Error('未找到');
    });
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    await expect(callback({}, '1')).rejects.toThrow('未找到');
  });

  // 记忆 ID 校验失败路径
  it('MEMORIES_SHOW 空字符串 ID 应抛出校验异常（不调用内核）', async () => {
    const showMemory = vi.fn(() => null);
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    await expect(callback({}, '')).rejects.toThrow('非法记忆 ID');

    expect(showMemory).not.toHaveBeenCalled();
  });

  it('MEMORIES_SHOW 非字符串 ID 应抛出校验异常（不调用内核）', async () => {
    const showMemory = vi.fn(() => null);
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    await expect(callback({}, null as unknown as string)).rejects.toThrow('非法记忆 ID');

    expect(showMemory).not.toHaveBeenCalled();
  });

  it('MEMORIES_SHOW 超长 ID 应抛出校验异常（不调用内核）', async () => {
    const showMemory = vi.fn(() => null);
    const ctx = createMockCtx({ showMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_SHOW)!;
    await expect(callback({}, 'a'.repeat(501))).rejects.toThrow('非法记忆 ID');

    expect(showMemory).not.toHaveBeenCalled();
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

  // 记忆 ID 校验失败路径
  it('MEMORIES_DELETE 空字符串 ID 应拒绝（返回 deleted: false，不调用内核）', async () => {
    const deleteMemory = vi.fn(() => false);
    const ctx = createMockCtx({ deleteMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE)!;
    const result = await callback({}, '');

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: false });
  });

  it('MEMORIES_DELETE 非字符串 ID 应拒绝（返回 deleted: false，不调用内核）', async () => {
    const deleteMemory = vi.fn(() => false);
    const ctx = createMockCtx({ deleteMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE)!;
    const result = await callback({}, undefined as unknown as string);

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ deleted: false });
  });

  it('MEMORIES_DELETE 超长 ID 应拒绝（返回 deleted: false，不调用内核）', async () => {
    const deleteMemory = vi.fn(() => false);
    const ctx = createMockCtx({ deleteMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE)!;
    const result = await callback({}, 'a'.repeat(501));

    expect(deleteMemory).not.toHaveBeenCalled();
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

  // ─── MEMORIES_ARCHIVE_PROFILE（手动归档） ─────

  it('MEMORIES_ARCHIVE_PROFILE 合法输入应返回归档条目数', async () => {
    // 模拟内核归档出 3 条 profile 事实
    const archiveProfileFacts = vi.fn(async () => [
      { id: 'p1', name: '偏好1' },
      { id: 'p2', name: '偏好2' },
      { id: 'p3', name: '偏好3' },
    ]);
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    const result = await callback({}, { input: '我喜欢简洁的界面' });

    expect(archiveProfileFacts).toHaveBeenCalledWith('我喜欢简洁的界面');
    // 返回值精简为 { count: number }，不泄露完整 Memory 对象（最小披露原则）
    expect(result).toEqual({ count: 3 });
  });

  it('MEMORIES_ARCHIVE_PROFILE 空输入应拒绝（返回 count: 0，不调用内核）', async () => {
    const archiveProfileFacts = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    const result = await callback({}, { input: '' });

    expect(archiveProfileFacts).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_PROFILE 非字符串 input 应拒绝（返回 count: 0）', async () => {
    const archiveProfileFacts = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    const result = await callback({}, { input: null as unknown as string });

    expect(archiveProfileFacts).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_PROFILE 超大内容应拒绝（返回 count: 0）', async () => {
    const archiveProfileFacts = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    // 构造超过 10MB 的内容
    const hugeContent = 'a'.repeat(11 * 1024 * 1024);
    const result = await callback({}, { input: hugeContent });

    expect(archiveProfileFacts).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_PROFILE 抛错应降级返回 count: 0', async () => {
    const archiveProfileFacts = vi.fn(async () => {
      throw new Error('LLM 调用失败');
    });
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    const result = await callback({}, { input: '合法输入' });

    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_PROFILE 无价值输入应返回 count: 0（内核返回空数组）', async () => {
    // 模拟内核 classify 判断无价值，返回空数组
    const archiveProfileFacts = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveProfileFacts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE)!;
    const result = await callback({}, { input: '今天天气不错' });

    expect(archiveProfileFacts).toHaveBeenCalledWith('今天天气不错');
    expect(result).toEqual({ count: 0 });
  });

  // ─── MEMORIES_ARCHIVE_INSIGHT（手动归档） ─────

  it('MEMORIES_ARCHIVE_INSIGHT 合法输入应返回归档条目数', async () => {
    // 模拟内核归档出 2 条洞察记忆
    const archiveInsight = vi.fn(async () => [
      { id: 'i1', name: '洞察1' },
      { id: 'i2', name: '洞察2' },
    ]);
    const ctx = createMockCtx({ archiveInsight });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT)!;
    const result = await callback({}, {
      input: '用户提问',
      assistantContent: '助手回复',
    });

    expect(archiveInsight).toHaveBeenCalledWith('用户提问', '助手回复');
    expect(result).toEqual({ count: 2 });
  });

  it('MEMORIES_ARCHIVE_INSIGHT 空 input 应拒绝（返回 count: 0）', async () => {
    const archiveInsight = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveInsight });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT)!;
    const result = await callback({}, { input: '', assistantContent: '回复' });

    expect(archiveInsight).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_INSIGHT 空 assistantContent 应拒绝（返回 count: 0）', async () => {
    const archiveInsight = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveInsight });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT)!;
    const result = await callback({}, { input: '提问', assistantContent: '' });

    expect(archiveInsight).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_INSIGHT 超大 assistantContent 应拒绝（返回 count: 0）', async () => {
    const archiveInsight = vi.fn(async () => []);
    const ctx = createMockCtx({ archiveInsight });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT)!;
    const hugeContent = 'a'.repeat(11 * 1024 * 1024);
    const result = await callback({}, { input: '提问', assistantContent: hugeContent });

    expect(archiveInsight).not.toHaveBeenCalled();
    expect(result).toEqual({ count: 0 });
  });

  it('MEMORIES_ARCHIVE_INSIGHT 抛错应降级返回 count: 0', async () => {
    const archiveInsight = vi.fn(async () => {
      throw new Error('归档失败');
    });
    const ctx = createMockCtx({ archiveInsight });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT)!;
    const result = await callback({}, { input: '提问', assistantContent: '回复' });

    expect(result).toEqual({ count: 0 });
  });
});
