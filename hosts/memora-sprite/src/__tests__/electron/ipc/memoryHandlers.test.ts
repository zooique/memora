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

/** 创建 mock IpcContext（仅包含 memoryHandlers 需要的 sprite/agent 方法） */
function createMockCtx(overrides?: {
  listMemories?: ReturnType<typeof vi.fn>;
  searchMemories?: ReturnType<typeof vi.fn>;
  showMemory?: ReturnType<typeof vi.fn>;
  deleteMemory?: ReturnType<typeof vi.fn>;
  upsertMemory?: ReturnType<typeof vi.fn>;
  boostMemory?: ReturnType<typeof vi.fn>;
  archiveProfileFacts?: ReturnType<typeof vi.fn>;
  archiveInsight?: ReturnType<typeof vi.fn>;
  restoreMemory?: ReturnType<typeof vi.fn>;
  purgeMemory?: ReturnType<typeof vi.fn>;
  restoreAllMemories?: ReturnType<typeof vi.fn>;
  purgeAllMemories?: ReturnType<typeof vi.fn>;
  listDeletedMemories?: ReturnType<typeof vi.fn>;
  getRelationGraph?: ReturnType<typeof vi.fn>;
  getHealthDashboard?: ReturnType<typeof vi.fn>;
  getReviewData?: ReturnType<typeof vi.fn>;
  deleteMemoriesBatch?: ReturnType<typeof vi.fn>;
  addRelation?: ReturnType<typeof vi.fn>;
  removeRelation?: ReturnType<typeof vi.fn>;
  updateRelation?: ReturnType<typeof vi.fn>;
  getRelationPath?: ReturnType<typeof vi.fn>;
  getRelationNeighbors?: ReturnType<typeof vi.fn>;
  archiveSessionContent?: ReturnType<typeof vi.fn>;
  // L1~L3 LLM 治理（G1）
  deduplicateMemories?: ReturnType<typeof vi.fn>;
  evaluateTimeliness?: ReturnType<typeof vi.fn>;
  detectConflicts?: ReturnType<typeof vi.fn>;
}): IpcContext {
  return {
    agent: {
      archiveSessionContent:
        overrides?.archiveSessionContent ?? vi.fn(async () => ({ memories: [] })),
    } as IpcContext['agent'],
    sprite: {
      listMemories: overrides?.listMemories ?? vi.fn(() => []),
      searchMemories: overrides?.searchMemories ?? vi.fn(async () => []),
      showMemory: overrides?.showMemory ?? vi.fn(() => null),
      deleteMemory: overrides?.deleteMemory ?? vi.fn(() => false),
      upsertMemory: overrides?.upsertMemory ?? vi.fn(() => 'new-id'),
      // L2 采纳反哺内核
      boostMemory: overrides?.boostMemory ?? vi.fn(() => true),
      // 归档委托方法
      archiveProfileFacts: overrides?.archiveProfileFacts ?? vi.fn(async () => []),
      archiveInsight: overrides?.archiveInsight ?? vi.fn(async () => []),
      // 回收站操作
      restoreMemory: overrides?.restoreMemory ?? vi.fn(() => false),
      purgeMemory: overrides?.purgeMemory ?? vi.fn(() => false),
      restoreAllMemories:
        overrides?.restoreAllMemories ?? vi.fn(() => ({ restored: 0, failed: 0 })),
      purgeAllMemories:
        overrides?.purgeAllMemories ?? vi.fn(() => ({ purged: 0, failed: 0 })),
      listDeletedMemories: overrides?.listDeletedMemories ?? vi.fn(() => []),
      // 关系图谱与诊断
      getRelationGraph:
        overrides?.getRelationGraph ?? vi.fn(() => ({ nodes: [], edges: [] })),
      getHealthDashboard: overrides?.getHealthDashboard ?? vi.fn(() => ({})),
      getReviewData: overrides?.getReviewData ?? vi.fn(() => ({})),
      deleteMemoriesBatch:
        overrides?.deleteMemoriesBatch ?? vi.fn(async () => ({ deleted: 0, total: 0 })),
      // 关系 CRUD
      addRelation: overrides?.addRelation ?? vi.fn(),
      removeRelation: overrides?.removeRelation ?? vi.fn(),
      updateRelation: overrides?.updateRelation ?? vi.fn(),
      getRelationPath:
        overrides?.getRelationPath ?? vi.fn(() => ({ nodes: [], edges: [] })),
      getRelationNeighbors:
        overrides?.getRelationNeighbors ?? vi.fn(() => ({ neighbors: [] })),
      // L1~L3 LLM 治理（G1：异步，返回报告对象）
      deduplicateMemories:
        overrides?.deduplicateMemories ??
        vi.fn(async () => ({
          scannedCount: 0,
          pairCount: 0,
          deduplicatedCount: 0,
          demotedIds: [],
          skippedReason: '测试默认跳过',
        })),
      evaluateTimeliness:
        overrides?.evaluateTimeliness ??
        vi.fn(async () => ({
          scannedCount: 0,
          outdatedCount: 0,
          demotedIds: [],
          skippedReason: '测试默认跳过',
        })),
      detectConflicts:
        overrides?.detectConflicts ??
        vi.fn(async () => ({
          scannedCount: 0,
          pairCount: 0,
          conflictCount: 0,
          conflicts: [],
          skippedReason: '测试默认跳过',
        })),
    } as unknown as IpcContext['sprite'],
    sessionStore: {} as IpcContext['sessionStore'],
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

  // ─── MEMORIES_BOOST（L2 采纳反哺内核） ─────

  it('MEMORIES_BOOST 合法 ID 应返回 success: true', async () => {
    const boostMemory = vi.fn(() => true);
    const ctx = createMockCtx({ boostMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_BOOST)!;
    const result = await callback({}, 'insight:测试记忆');

    expect(boostMemory).toHaveBeenCalledWith('insight:测试记忆');
    expect(result).toEqual({ success: true });
  });

  it('MEMORIES_BOOST 记忆不存在应返回 success: false（不抛错）', async () => {
    // 候选可能来自对话历史，无对应记忆，内核返回 false 而非抛错
    const boostMemory = vi.fn(() => false);
    const ctx = createMockCtx({ boostMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_BOOST)!;
    const result = await callback({}, 'insight:不存在');

    expect(boostMemory).toHaveBeenCalledWith('insight:不存在');
    expect(result).toEqual({ success: false });
  });

  it('MEMORIES_BOOST 非法 ID（空字符串）应拒绝（返回 success: false，不调用内核）', async () => {
    const boostMemory = vi.fn();
    const ctx = createMockCtx({ boostMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_BOOST)!;
    const result = await callback({}, '');

    expect(boostMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  it('MEMORIES_BOOST 抛错应降级返回 success: false', async () => {
    const boostMemory = vi.fn(() => {
      throw new Error('存储不可用');
    });
    const ctx = createMockCtx({ boostMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_BOOST)!;
    const result = await callback({}, 'insight:测试记忆');

    expect(result).toEqual({ success: false });
  });

  // ─── MEMORIES_DEDUP（L1 语义去重，G1） ─────

  it('MEMORIES_DEDUP 应返回去重报告', async () => {
    const report = {
      scannedCount: 10,
      pairCount: 3,
      deduplicatedCount: 2,
      demotedIds: ['insight:1', 'insight:2'],
    };
    const deduplicateMemories = vi.fn(async () => report);
    const ctx = createMockCtx({ deduplicateMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DEDUP)!;
    const result = await callback({});

    expect(deduplicateMemories).toHaveBeenCalled();
    expect(result).toEqual(report);
  });

  it('MEMORIES_DEDUP 抛错应降级返回空报告（不崩溃）', async () => {
    const deduplicateMemories = vi.fn(async () => {
      throw new Error('LLM 不可用');
    });
    const ctx = createMockCtx({ deduplicateMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DEDUP)!;
    const result = await callback({});

    expect(result).toMatchObject({
      scannedCount: 0,
      deduplicatedCount: 0,
      demotedIds: [],
      skippedReason: expect.any(String),
    });
  });

  // ─── MEMORIES_EVALUATE_TIMELINESS（L2 时效性评估，G1） ─────

  it('MEMORIES_EVALUATE_TIMELINESS 应返回评估报告', async () => {
    const report = {
      scannedCount: 5,
      outdatedCount: 2,
      demotedIds: ['insight:old1', 'insight:old2'],
    };
    const evaluateTimeliness = vi.fn(async () => report);
    const ctx = createMockCtx({ evaluateTimeliness });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_EVALUATE_TIMELINESS)!;
    const result = await callback({});

    expect(evaluateTimeliness).toHaveBeenCalled();
    expect(result).toEqual(report);
  });

  it('MEMORIES_EVALUATE_TIMELINESS 抛错应降级返回空报告', async () => {
    const evaluateTimeliness = vi.fn(async () => {
      throw new Error('LLM 不可用');
    });
    const ctx = createMockCtx({ evaluateTimeliness });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_EVALUATE_TIMELINESS)!;
    const result = await callback({});

    expect(result).toMatchObject({
      scannedCount: 0,
      outdatedCount: 0,
      demotedIds: [],
      skippedReason: expect.any(String),
    });
  });

  // ─── MEMORIES_DETECT_CONFLICTS（L3 冲突检测，G1） ─────

  it('MEMORIES_DETECT_CONFLICTS 应返回冲突报告', async () => {
    const report = {
      scannedCount: 8,
      pairCount: 4,
      conflictCount: 1,
      conflicts: [
        {
          memoryA: { id: 'insight:a' },
          memoryB: { id: 'insight:b' },
          hasConflict: true,
          conflictDescription: '观点矛盾',
          reason: 'A 说东，B 说西',
        },
      ],
    };
    const detectConflicts = vi.fn(async () => report);
    const ctx = createMockCtx({ detectConflicts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DETECT_CONFLICTS)!;
    const result = await callback({});

    expect(detectConflicts).toHaveBeenCalled();
    expect(result).toEqual(report);
  });

  it('MEMORIES_DETECT_CONFLICTS 抛错应降级返回空报告', async () => {
    const detectConflicts = vi.fn(async () => {
      throw new Error('LLM 不可用');
    });
    const ctx = createMockCtx({ detectConflicts });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DETECT_CONFLICTS)!;
    const result = await callback({});

    expect(result).toMatchObject({
      scannedCount: 0,
      conflictCount: 0,
      conflicts: [],
      skippedReason: expect.any(String),
    });
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

  // ─── MEMORIES_LIST（补充：source 校验） ─────────────

  it('MEMORIES_LIST 非法 source（空字符串）应抛出校验异常（不调用内核）', async () => {
    const listMemories = vi.fn(() => []);
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    await expect(callback({}, { source: '' })).rejects.toThrow('非法 source 参数');

    expect(listMemories).not.toHaveBeenCalled();
  });

  it('MEMORIES_LIST 非法 source（超长）应抛出校验异常', async () => {
    const listMemories = vi.fn(() => []);
    const ctx = createMockCtx({ listMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST)!;
    await expect(callback({}, { source: 'a'.repeat(501) })).rejects.toThrow('非法 source 参数');

    expect(listMemories).not.toHaveBeenCalled();
  });

  // ─── MEMORIES_RESTORE（恢复软删除） ────────────────

  it('MEMORIES_RESTORE 应返回恢复结果（含 id 供渲染层定位）', async () => {
    const restoreMemory = vi.fn(() => true);
    const ctx = createMockCtx({ restoreMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RESTORE)!;
    const result = await callback({}, 'mem-1');

    expect(restoreMemory).toHaveBeenCalledWith('mem-1');
    expect(result).toEqual({ restored: true, id: 'mem-1' });
  });

  it('MEMORIES_RESTORE 非法 ID 应拒绝（返回 restored: false，不调用内核）', async () => {
    const restoreMemory = vi.fn(() => false);
    const ctx = createMockCtx({ restoreMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RESTORE)!;
    const result = await callback({}, '');

    expect(restoreMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ restored: false });
  });

  it('MEMORIES_RESTORE 抛错应降级返回 restored: false', async () => {
    const restoreMemory = vi.fn(() => {
      throw new Error('恢复失败');
    });
    const ctx = createMockCtx({ restoreMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RESTORE)!;
    const result = await callback({}, 'mem-1');

    expect(result).toEqual({ restored: false });
  });

  // ─── MEMORIES_PURGE（物理删除） ─────────────────────

  it('MEMORIES_PURGE 应返回物理删除结果', async () => {
    const purgeMemory = vi.fn(() => true);
    const ctx = createMockCtx({ purgeMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_PURGE)!;
    const result = await callback({}, 'mem-1');

    expect(purgeMemory).toHaveBeenCalledWith('mem-1');
    expect(result).toEqual({ purged: true });
  });

  it('MEMORIES_PURGE 非法 ID 应拒绝（返回 purged: false，不调用内核）', async () => {
    const purgeMemory = vi.fn(() => false);
    const ctx = createMockCtx({ purgeMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_PURGE)!;
    const result = await callback({}, '');

    expect(purgeMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ purged: false });
  });

  it('MEMORIES_PURGE 抛错应降级返回 purged: false', async () => {
    const purgeMemory = vi.fn(() => {
      throw new Error('物理删除失败');
    });
    const ctx = createMockCtx({ purgeMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_PURGE)!;
    const result = await callback({}, 'mem-1');

    expect(result).toEqual({ purged: false });
  });

  // ─── MEMORIES_RESTORE_ALL（批量恢复） ──────────────

  it('MEMORIES_RESTORE_ALL 应返回批量恢复结果', async () => {
    const restoreAllMemories = vi.fn(() => ({ restored: 5, failed: 1 }));
    const ctx = createMockCtx({ restoreAllMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RESTORE_ALL)!;
    const result = await callback({});

    expect(restoreAllMemories).toHaveBeenCalled();
    expect(result).toEqual({ restored: 5, failed: 1 });
  });

  it('MEMORIES_RESTORE_ALL 抛错应降级返回 { restored: 0, failed: 0 }', async () => {
    const restoreAllMemories = vi.fn(() => {
      throw new Error('批量恢复失败');
    });
    const ctx = createMockCtx({ restoreAllMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RESTORE_ALL)!;
    const result = await callback({});

    expect(result).toEqual({ restored: 0, failed: 0 });
  });

  // ─── MEMORIES_PURGE_ALL（批量清空） ────────────────

  it('MEMORIES_PURGE_ALL 应返回批量清空结果', async () => {
    const purgeAllMemories = vi.fn(() => ({ purged: 3, failed: 0 }));
    const ctx = createMockCtx({ purgeAllMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_PURGE_ALL)!;
    const result = await callback({});

    expect(purgeAllMemories).toHaveBeenCalled();
    expect(result).toEqual({ purged: 3, failed: 0 });
  });

  it('MEMORIES_PURGE_ALL 抛错应降级返回 { purged: 0, failed: 0 }', async () => {
    const purgeAllMemories = vi.fn(() => {
      throw new Error('批量清空失败');
    });
    const ctx = createMockCtx({ purgeAllMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_PURGE_ALL)!;
    const result = await callback({});

    expect(result).toEqual({ purged: 0, failed: 0 });
  });

  // ─── MEMORIES_LIST_DELETED（回收站列表） ───────────

  it('MEMORIES_LIST_DELETED 应返回回收站记忆列表', async () => {
    const memories = [{ id: '1', name: '已删除记忆' }];
    const listDeletedMemories = vi.fn(() => memories);
    const ctx = createMockCtx({ listDeletedMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST_DELETED)!;
    const result = await callback({});

    expect(listDeletedMemories).toHaveBeenCalled();
    expect(result).toEqual({ memories });
  });

  it('MEMORIES_LIST_DELETED 抛错应向上抛出（让渲染层感知加载失败）', async () => {
    const listDeletedMemories = vi.fn(() => {
      throw new Error('加载回收站失败');
    });
    const ctx = createMockCtx({ listDeletedMemories });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_LIST_DELETED)!;
    await expect(callback({})).rejects.toThrow('加载回收站失败');
  });

  // ─── MEMORIES_ADD（补充：source/name 校验） ─────────

  it('MEMORIES_ADD 非法 source（空字符串）应拒绝（返回空 ID，不调用内核）', async () => {
    const upsertMemory = vi.fn();
    const ctx = createMockCtx({ upsertMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD)!;
    const result = await callback({}, {
      source: '',
      name: '新记忆',
      content: '合法内容',
    });

    expect(upsertMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ id: '' });
  });

  it('MEMORIES_ADD 非法 name（空字符串）应拒绝（返回空 ID，不调用内核）', async () => {
    const upsertMemory = vi.fn();
    const ctx = createMockCtx({ upsertMemory });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD)!;
    const result = await callback({}, {
      source: 'insight',
      name: '',
      content: '合法内容',
    });

    expect(upsertMemory).not.toHaveBeenCalled();
    expect(result).toEqual({ id: '' });
  });

  // ─── MEMORIES_RELATION_GRAPH（关系图谱） ───────────

  it('MEMORIES_RELATION_GRAPH 应返回关系图谱', async () => {
    const graph = {
      nodes: [{ id: 'm1' }],
      edges: [{ source: 'm1', target: 'm2', type: 'supports' }],
    };
    const getRelationGraph = vi.fn(() => graph);
    const ctx = createMockCtx({ getRelationGraph });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_GRAPH)!;
    const result = await callback({});

    expect(getRelationGraph).toHaveBeenCalled();
    expect(result).toBe(graph);
  });

  it('MEMORIES_RELATION_GRAPH 抛错应向上抛出', async () => {
    const getRelationGraph = vi.fn(() => {
      throw new Error('图谱加载失败');
    });
    const ctx = createMockCtx({ getRelationGraph });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_GRAPH)!;
    await expect(callback({})).rejects.toThrow('图谱加载失败');
  });

  // ─── ARCHIVE_SESSION（批量归档会话） ───────────────

  it('ARCHIVE_SESSION 合法参数应返回归档条目数', async () => {
    const archiveSessionContent = vi.fn(async () => ({
      memories: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    }));
    const ctx = createMockCtx({ archiveSessionContent });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.ARCHIVE_SESSION)!;
    const result = await callback({}, { date: '2026-07-12', session: '会话1' });

    expect(archiveSessionContent).toHaveBeenCalledWith('2026-07-12', '会话1');
    expect(result).toEqual({ archivedCount: 3 });
  });

  it('ARCHIVE_SESSION 非字符串 date 应拒绝（返回 archivedCount: 0，不调用内核）', async () => {
    const archiveSessionContent = vi.fn(async () => ({ memories: [] }));
    const ctx = createMockCtx({ archiveSessionContent });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.ARCHIVE_SESSION)!;
    const result = await callback({}, { date: 12345, session: '会话1' });

    expect(archiveSessionContent).not.toHaveBeenCalled();
    expect(result).toEqual({ archivedCount: 0 });
  });

  it('ARCHIVE_SESSION 非字符串 session 应拒绝（返回 archivedCount: 0）', async () => {
    const archiveSessionContent = vi.fn(async () => ({ memories: [] }));
    const ctx = createMockCtx({ archiveSessionContent });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.ARCHIVE_SESSION)!;
    const result = await callback({}, { date: '2026-07-12', session: null });

    expect(archiveSessionContent).not.toHaveBeenCalled();
    expect(result).toEqual({ archivedCount: 0 });
  });

  it('ARCHIVE_SESSION 抛错应降级返回 archivedCount: 0', async () => {
    const archiveSessionContent = vi.fn(async () => {
      throw new Error('归档失败');
    });
    const ctx = createMockCtx({ archiveSessionContent });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.ARCHIVE_SESSION)!;
    const result = await callback({}, { date: '2026-07-12', session: '会话1' });

    expect(result).toEqual({ archivedCount: 0 });
  });

  // ─── MEMORIES_HEALTH_DASHBOARD（健康度仪表盘） ─────

  it('MEMORIES_HEALTH_DASHBOARD 应返回仪表盘数据', async () => {
    const dashboard = { total: 100, healthy: 80 };
    const getHealthDashboard = vi.fn(() => dashboard);
    const ctx = createMockCtx({ getHealthDashboard });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD)!;
    const result = await callback({});

    expect(getHealthDashboard).toHaveBeenCalled();
    expect(result).toBe(dashboard);
  });

  it('MEMORIES_HEALTH_DASHBOARD 抛错应向上抛出', async () => {
    const getHealthDashboard = vi.fn(() => {
      throw new Error('仪表盘加载失败');
    });
    const ctx = createMockCtx({ getHealthDashboard });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD)!;
    await expect(callback({})).rejects.toThrow('仪表盘加载失败');
  });

  // ─── MEMORIES_REVIEW_DATA（对话回顾） ──────────────

  it('MEMORIES_REVIEW_DATA 应返回回顾数据', async () => {
    const reviewData = { sessions: 10, insights: 5 };
    const getReviewData = vi.fn(() => reviewData);
    const ctx = createMockCtx({ getReviewData });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_REVIEW_DATA)!;
    const result = await callback({});

    expect(getReviewData).toHaveBeenCalled();
    expect(result).toBe(reviewData);
  });

  it('MEMORIES_REVIEW_DATA 抛错应向上抛出', async () => {
    const getReviewData = vi.fn(() => {
      throw new Error('回顾数据加载失败');
    });
    const ctx = createMockCtx({ getReviewData });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_REVIEW_DATA)!;
    await expect(callback({})).rejects.toThrow('回顾数据加载失败');
  });

  // ─── MEMORIES_DELETE_BATCH（批量删除） ─────────────

  it('MEMORIES_DELETE_BATCH 应返回批量删除结果', async () => {
    const deleteMemoriesBatch = vi.fn(async () => ({ deleted: 3, total: 5 }));
    const ctx = createMockCtx({ deleteMemoriesBatch });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE_BATCH)!;
    const result = await callback({}, ['id-1', 'id-2', 'id-3']);

    expect(deleteMemoriesBatch).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3']);
    expect(result).toEqual({ deleted: 3, total: 5 });
  });

  it('MEMORIES_DELETE_BATCH 抛错应降级返回 { deleted: 0, total: N }', async () => {
    const deleteMemoriesBatch = vi.fn(async () => {
      throw new Error('批量删除失败');
    });
    const ctx = createMockCtx({ deleteMemoriesBatch });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_DELETE_BATCH)!;
    const result = await callback({}, ['id-1', 'id-2']);

    expect(result).toEqual({ deleted: 0, total: 2 });
  });

  // ─── MEMORIES_ADD_RELATION（添加关系） ─────────────

  it('MEMORIES_ADD_RELATION 合法参数应返回 success: true', async () => {
    const addRelation = vi.fn();
    const ctx = createMockCtx({ addRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'supports',
      weight: 0.8,
    });

    expect(addRelation).toHaveBeenCalledWith('mem-1', 'mem-2', 'supports', 0.8);
    expect(result).toEqual({ success: true });
  });

  it('MEMORIES_ADD_RELATION 非法 type（不在白名单）应拒绝（返回 success: false）', async () => {
    const addRelation = vi.fn();
    const ctx = createMockCtx({ addRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'invalid-type',
      weight: 0.5,
    });

    expect(addRelation).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  it('MEMORIES_ADD_RELATION 非法 sourceId（空字符串）应拒绝（返回 success: false）', async () => {
    const addRelation = vi.fn();
    const ctx = createMockCtx({ addRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD_RELATION)!;
    const result = await callback({}, {
      sourceId: '',
      targetId: 'mem-2',
      type: 'supports',
      weight: 0.5,
    });

    expect(addRelation).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  it('MEMORIES_ADD_RELATION 抛错应降级返回 success: false', async () => {
    const addRelation = vi.fn(() => {
      throw new Error('关系写入失败');
    });
    const ctx = createMockCtx({ addRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_ADD_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'supports',
      weight: 0.8,
    });

    expect(result).toEqual({ success: false });
  });

  // ─── MEMORIES_REMOVE_RELATION（删除关系） ──────────

  it('MEMORIES_REMOVE_RELATION 合法参数应返回 success: true', async () => {
    const removeRelation = vi.fn();
    const ctx = createMockCtx({ removeRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_REMOVE_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'contradicts',
    });

    expect(removeRelation).toHaveBeenCalledWith('mem-1', 'mem-2', 'contradicts');
    expect(result).toEqual({ success: true });
  });

  it('MEMORIES_REMOVE_RELATION 非法 targetId（空字符串）应拒绝（返回 success: false）', async () => {
    const removeRelation = vi.fn();
    const ctx = createMockCtx({ removeRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_REMOVE_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: '',
      type: 'supports',
    });

    expect(removeRelation).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  // ─── MEMORIES_UPDATE_RELATION（更新关系） ──────────

  it('MEMORIES_UPDATE_RELATION 合法参数应返回 success: true', async () => {
    const updateRelation = vi.fn();
    const ctx = createMockCtx({ updateRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_UPDATE_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'refines',
      weight: 0.9,
    });

    expect(updateRelation).toHaveBeenCalledWith('mem-1', 'mem-2', 'refines', 0.9);
    expect(result).toEqual({ success: true });
  });

  it('MEMORIES_UPDATE_RELATION 非法 type 应拒绝（返回 success: false）', async () => {
    const updateRelation = vi.fn();
    const ctx = createMockCtx({ updateRelation });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_UPDATE_RELATION)!;
    const result = await callback({}, {
      sourceId: 'mem-1',
      targetId: 'mem-2',
      type: 'not-a-valid-type',
      weight: 0.5,
    });

    expect(updateRelation).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false });
  });

  // ─── MEMORIES_RELATION_PATH（关系路径） ────────────

  it('MEMORIES_RELATION_PATH 合法参数应返回路径（默认 maxDepth=5, direction=incoming）', async () => {
    const path = { nodes: [{ id: 'm1' }], edges: [] };
    const getRelationPath = vi.fn(() => path);
    const ctx = createMockCtx({ getRelationPath });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_PATH)!;
    const result = await callback({}, { memoryId: 'mem-1' });

    expect(getRelationPath).toHaveBeenCalledWith('mem-1', 5, 'incoming');
    expect(result).toBe(path);
  });

  it('MEMORIES_RELATION_PATH 自定义 maxDepth 和 direction 应透传', async () => {
    const getRelationPath = vi.fn(() => ({ nodes: [], edges: [] }));
    const ctx = createMockCtx({ getRelationPath });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_PATH)!;
    await callback({}, { memoryId: 'mem-1', maxDepth: 10, direction: 'outgoing' });

    expect(getRelationPath).toHaveBeenCalledWith('mem-1', 10, 'outgoing');
  });

  it('MEMORIES_RELATION_PATH 非法 memoryId 应抛出校验异常（不调用内核）', async () => {
    const getRelationPath = vi.fn();
    const ctx = createMockCtx({ getRelationPath });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_PATH)!;
    await expect(callback({}, { memoryId: '' })).rejects.toThrow('非法记忆 ID');

    expect(getRelationPath).not.toHaveBeenCalled();
  });

  // ─── MEMORIES_RELATION_NEIGHBORS（关系邻居） ────────

  it('MEMORIES_RELATION_NEIGHBORS 合法参数应返回邻居（默认 limit=10）', async () => {
    const neighbors = { neighbors: [{ id: 'm2' }, { id: 'm3' }] };
    const getRelationNeighbors = vi.fn(() => neighbors);
    const ctx = createMockCtx({ getRelationNeighbors });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS)!;
    const result = await callback({}, { memoryId: 'mem-1' });

    expect(getRelationNeighbors).toHaveBeenCalledWith('mem-1', 10);
    expect(result).toBe(neighbors);
  });

  it('MEMORIES_RELATION_NEIGHBORS 自定义 limit 应透传', async () => {
    const getRelationNeighbors = vi.fn(() => ({ neighbors: [] }));
    const ctx = createMockCtx({ getRelationNeighbors });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS)!;
    await callback({}, { memoryId: 'mem-1', limit: 20 });

    expect(getRelationNeighbors).toHaveBeenCalledWith('mem-1', 20);
  });

  it('MEMORIES_RELATION_NEIGHBORS 非法 memoryId 应抛出校验异常（不调用内核）', async () => {
    const getRelationNeighbors = vi.fn();
    const ctx = createMockCtx({ getRelationNeighbors });
    registerMemoryHandlers(ctx);

    const callback = handleCallbacks.get(IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS)!;
    await expect(callback({}, { memoryId: '' })).rejects.toThrow('非法记忆 ID');

    expect(getRelationNeighbors).not.toHaveBeenCalled();
  });
});
