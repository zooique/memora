/**
 * sessionHandlers IPC 处理器测试（QC-TEST-SESSION）
 *
 * 覆盖范围：
 * - SESSION_LOAD：明确参数加载 + 无参数智能回退（当天 main → 最近会话 → 空会话）+ 分页 + 失败降级
 * - SESSION_SWITCH：Agent 未初始化 + 非法会话名 + 竞态保护 + sessionManager 未初始化 + 正常切换
 * - SESSION_DELETE：非法 sessionId + 按日期前缀批量删除 + 未找到匹配 + Agent 状态同步
 * - SESSION_RENAME：非法输入 + 正常重命名 + 会话不存在
 * - SESSION_FORK：Agent 未初始化 + 对话进行中拒绝 + 非法参数 + 无参数分叉 + 有参数分叉 + 内核抛错降级
 * - SESSION_LIST：按日期聚合 + 当天占位 + 失败降级
 *
 * Mock 策略：
 * - electron.ipcMain：vi.mock + handleCallbacks Map（对齐 configHandlers.test.ts 模式）
 * - errorHandler：mock handle 方法
 * - sessionStore：mock 全部 7 个方法
 * - agent：mock agentHistory/sessionManager/agentLoop 子集
 * - getLocalDate：mock 为固定日期，确保跨日逻辑测试稳定
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

// ─── Mock errorHandler 模块 ─────────────────────────────
vi.mock('../../../electron/errorHandler.js', () => ({
  errorHandler: {
    handle: vi.fn(),
  },
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    API_ERROR: 'API_ERROR',
  },
}));

// ─── Mock getLocalDate 为固定日期（跨日逻辑测试稳定） ───
const MOCK_TODAY = '2026-06-26';
vi.mock('../../../sprite/constants.js', () => ({
  getLocalDate: vi.fn(() => MOCK_TODAY),
}));

import { registerSessionHandlers } from '../../../electron/ipc/sessionHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { IpcContext } from '../../../electron/ipc/types.js';
import type { SessionMessage } from '../../../storage/sessionStore.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock SessionMessage */
function makeMsg(role: 'user' | 'assistant', content: string, timestamp?: string): SessionMessage {
  return { role, content, timestamp: timestamp ?? new Date().toISOString() };
}

/** 创建 mock sessionStore（全部 7 个方法） */
function createMockSessionStore(overrides?: {
  listSessions?: string[];
  countMessages?: number;
  loadMessages?: SessionMessage[];
  loadMessagesPaginated?: SessionMessage[];
  deleteSession?: boolean;
  renameSession?: boolean;
  getFirstUserMessage?: string;
}) {
  return {
    listSessions: vi.fn(() => overrides?.listSessions ?? []),
    countMessages: vi.fn(() => overrides?.countMessages ?? 0),
    loadMessages: vi.fn(() => overrides?.loadMessages ?? []),
    loadMessagesPaginated: vi.fn(() => overrides?.loadMessagesPaginated ?? []),
    deleteSession: vi.fn(() => overrides?.deleteSession ?? true),
    renameSession: vi.fn(() => overrides?.renameSession ?? true),
    getFirstUserMessage: vi.fn(() => overrides?.getFirstUserMessage ?? ''),
  };
}

/** 创建 mock agent（含 agentHistory/sessionManager/agentLoop 子集） */
function createMockAgent(overrides?: {
  sessionManager?: {
    switchSession?: ReturnType<typeof vi.fn>;
    restoreSession?: ReturnType<typeof vi.fn>;
    /** 会话切换前用于查询当前会话标识（决定是否触发自动归档） */
    getCurrentSessionInfo?: ReturnType<typeof vi.fn>;
  } | null;
  agentHistory?: {
    currentDateValue?: string;
    loadSessionMessages?: ReturnType<typeof vi.fn>;
  } | null;
  agentLoop?: {
    restoreHistory?: ReturnType<typeof vi.fn>;
  } | null;
}) {
  // 注意：用 ?? 会让显式传 null 被默认值替换，这里需要区分"未传"和"显式传 null"
  const hasSessionManager = overrides && 'sessionManager' in overrides;
  const hasAgentHistory = overrides && 'agentHistory' in overrides;
  const hasAgentLoop = overrides && 'agentLoop' in overrides;
  return {
    agentHistory: hasAgentHistory ? overrides!.agentHistory : null,
    sessionManager: hasSessionManager
      ? overrides!.sessionManager
      : {
          switchSession: vi.fn(),
          restoreSession: vi.fn().mockResolvedValue(0),
          getCurrentSessionInfo: vi.fn(() => null),
        },
    agentLoop: hasAgentLoop ? overrides!.agentLoop : { restoreHistory: vi.fn() },
    // 归档模式默认 full（自动归档），archiveSessionContent 默认返回空结果
    getArchiveMode: vi.fn(() => 'full'),
    archiveSessionContent: vi.fn().mockResolvedValue({ memories: [], sessionLabel: '', messageCount: 0 }),
    // 会话分叉：默认返回 newSession + messageCount（测试可覆盖）
    forkSession: vi.fn(() => ({ newSession: 'fork-001', messageCount: 5 })),
  } as unknown as IpcContext['agent'];
}

/** 创建 mock IpcContext */
function createMockCtx(overrides?: {
  sessionStore?: ReturnType<typeof createMockSessionStore>;
  agent?: ReturnType<typeof createMockAgent> | null;
  getAbortController?: ReturnType<typeof vi.fn>;
}): IpcContext {
  // 注意：agent 可能为 null（测试 Agent 未初始化场景），不能用 ?? 替换
  const hasAgent = overrides && 'agent' in overrides;
  return {
    agent: hasAgent ? (overrides!.agent as IpcContext['agent']) : createMockAgent(),
    sprite: {} as IpcContext['sprite'],
    sessionStore: (overrides?.sessionStore ?? createMockSessionStore()) as unknown as IpcContext['sessionStore'],
    windowStateManager: {} as IpcContext['windowStateManager'],
    windowManager: {} as IpcContext['windowManager'],
    trayManager: null,
    getAbortController: overrides?.getAbortController ?? vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => true),
    getUnreadCount: vi.fn(() => 0),
    incrementUnreadCount: vi.fn(),
    resetUnreadCount: vi.fn(),
  } as unknown as IpcContext;
}

describe('sessionHandlers', () => {
  beforeEach(() => {
    // 固定系统时间为 MOCK_TODAY（2026-06-26），保证依赖 new Date() 的测试与 mock 数据一致
    vi.useFakeTimers({ now: new Date('2026-06-26T12:00:00Z') });
    vi.clearAllMocks();
    handleCallbacks.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── SESSION_LOAD ──────────────────────────────────────

  describe('SESSION_LOAD', () => {
    it('有明确 date+session 参数时应直接加载目标会话', async () => {
      const messages = [makeMsg('user', '你好'), makeMsg('assistant', '你好！')];
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-25-main', '2026-06-26-main'],
        countMessages: 2,
        loadMessagesPaginated: messages,
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, { date: '2026-06-25', session: 'main' });

      // 应加载 2026-06-25-main 会话
      expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-25', 'main', 50, 0);
      expect(result).toEqual({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: '你好' }),
          expect.objectContaining({ role: 'assistant', content: '你好！' }),
        ]),
        loadedSessionId: '2026-06-25-main',
        total: 2,
        hasMore: false,
      });
    });

    it('无参数 + 当天 main 有消息时应加载当天 main', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-25-main', '2026-06-26-main'],
        countMessages: 5, // 当天 main 有消息
        loadMessagesPaginated: [makeMsg('user', '今天的内容')],
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, {});

      // countMessages 应针对当天 main 检查
      expect(sessionStore.countMessages).toHaveBeenCalledWith('2026-06-26', 'main');
      expect(result.loadedSessionId).toBe('2026-06-26-main');
    });

    it('无参数 + 当天无消息时应始终加载今天的 main 会话', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-24-main', '2026-06-25-main'], // 当天 06-26 不在列表
        countMessages: 0, // 当天 main 无消息
        loadMessagesPaginated: [makeMsg('user', '昨天的内容')],
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, {});

      // 实现行为：无参数时始终加载今天的 main 会话（不看历史列表）
      expect(result.loadedSessionId).toBe('2026-06-26-main');
    });

    it('无参数 + 无任何历史会话时应返回当天空会话', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: [],
        countMessages: 0,
        loadMessagesPaginated: [],
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, {});

      expect(result.loadedSessionId).toBe('2026-06-26-main');
      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('分页参数应正确透传 + hasMore 计算', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-26-main'],
        countMessages: 100,
        loadMessagesPaginated: [makeMsg('user', '第1页')],
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      // limit=20, offset=0，返回 1 条但 total=100，应 hasMore=true
      const result = await callback({}, { date: '2026-06-26', session: 'main', limit: 20, offset: 0 });

      expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 20, 0);
      expect(result.hasMore).toBe(true); // 0 + 1 < 100
    });

    it('加载失败应降级返回空数组', async () => {
      const sessionStore = createMockSessionStore();
      sessionStore.loadMessagesPaginated.mockImplementation(() => {
        throw new Error('数据库损坏');
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main' });

      expect(result).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
    });

    // ─── FOUNDATION-SEAL Phase 3 轮3：query 对象校验失败路径 ──

    it('query=null 应降级返回空数组（不调用内核）', async () => {
      const sessionStore = createMockSessionStore();
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, null);

      expect(result).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
      // 内核方法不应被调用
      expect(sessionStore.listSessions).not.toHaveBeenCalled();
      expect(sessionStore.loadMessagesPaginated).not.toHaveBeenCalled();
    });

    it('query 非对象（字符串）应降级返回空数组', async () => {
      const sessionStore = createMockSessionStore();
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, 'not-an-object' as unknown as { date?: string });

      expect(result).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
      expect(sessionStore.listSessions).not.toHaveBeenCalled();
    });

    it('date 字段非字符串应降级返回空数组', async () => {
      const sessionStore = createMockSessionStore();
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, { date: 12345 } as unknown as { date: string });

      expect(result).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
      expect(sessionStore.listSessions).not.toHaveBeenCalled();
    });

    it('limit 字段非数字应降级返回空数组', async () => {
      const sessionStore = createMockSessionStore();
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LOAD)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main', limit: '50' } as unknown as { date: string; session: string; limit: number });

      expect(result).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
      expect(sessionStore.loadMessagesPaginated).not.toHaveBeenCalled();
    });
  });

  // ─── SESSION_SWITCH ────────────────────────────────────

  describe('SESSION_SWITCH', () => {
    it('Agent 未初始化时应返回错误', async () => {
      const ctx = createMockCtx({ agent: null as unknown as IpcContext['agent'] });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent 未初始化');
    });

    it('非法会话名（含路径分隔符）应被拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main/../../../etc' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的会话名');
    });

    it('有进行中对话时应拒绝切换', async () => {
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => new AbortController()), // 模拟有进行中对话
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('进行中的对话');
    });

    it('sessionManager 未初始化时应返回错误', async () => {
      const ctx = createMockCtx({
        agent: createMockAgent({ sessionManager: null }),
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-26', session: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('SessionManager 未初始化');
    });

    it('正常切换应更新 Agent 状态并返回消息列表', async () => {
      // sessionManager 需提供 getCurrentSessionInfo（full 模式下切换前会调用以决定是否归档）
      const sessionManager = {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(3),
        getCurrentSessionInfo: vi.fn(() => null),
      };
      const messages = [makeMsg('user', '历史消息')];
      const sessionStore = createMockSessionStore({ loadMessages: messages });
      const ctx = createMockCtx({
        agent: createMockAgent({ sessionManager }),
        sessionStore,
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-25', session: 'coding' });

      expect(result.success).toBe(true);
      expect(sessionManager.switchSession).toHaveBeenCalledWith('coding');
      expect(sessionManager.restoreSession).toHaveBeenCalledWith('2026-06-25', 'coding');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: '历史消息' }));
    });

    it('切换失败应降级返回错误信息', async () => {
      // sessionManager 需提供 getCurrentSessionInfo（归档分支会先于 restoreSession 调用）
      const sessionManager = {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockRejectedValue(new Error('恢复失败')),
        getCurrentSessionInfo: vi.fn(() => null),
      };
      const ctx = createMockCtx({
        agent: createMockAgent({ sessionManager }),
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '2026-06-25', session: 'coding' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('恢复失败');
    });

    // ─── FOUNDATION-SEAL Phase 3 轮3：query 对象 + date 校验失败路径 ──

    it('query=null 应拒绝（不调用 Agent）', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, null);

      expect(result.success).toBe(false);
      expect(result.error).toBe('无效的请求参数');
    });

    it('query 非对象（字符串）应拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, 'invalid' as unknown as { date: string; session: string });

      expect(result.success).toBe(false);
      expect(result.error).toBe('无效的请求参数');
    });

    it('date 为空字符串应拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: '', session: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('无效的请求参数');
    });

    it('date 非字符串（number）应拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_SWITCH)!;
      const result = await callback({}, { date: 20260626 as unknown as string, session: 'main' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('无效的请求参数');
    });
  });

  // ─── SESSION_DELETE ────────────────────────────────────

  describe('SESSION_DELETE', () => {
    it('非法 sessionId（含路径分隔符）应被拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_DELETE)!;
      const result = await callback({}, '2026-06-26-main/../../../etc');

      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的会话 ID');
    });

    it('应按日期前缀批量删除当天所有子会话', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-25-main', '2026-06-25-coding', '2026-06-26-main'],
        deleteSession: true,
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_DELETE)!;
      const result = await callback({}, '2026-06-25-main');

      // 应删除 2026-06-25 的两个会话（main + coding）
      expect(result.success).toBe(true);
      expect(sessionStore.deleteSession).toHaveBeenCalledTimes(2);
      expect(sessionStore.deleteSession).toHaveBeenCalledWith('2026-06-25-main');
      expect(sessionStore.deleteSession).toHaveBeenCalledWith('2026-06-25-coding');
      expect(sessionStore.deleteSession).not.toHaveBeenCalledWith('2026-06-26-main');
    });

    it('未找到匹配会话时应返回错误', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-26-main'], // 只有当天
        deleteSession: true,
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_DELETE)!;
      const result = await callback({}, '2026-06-25-main');

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到');
    });

    it('删除当前日期会话后应同步 Agent 状态', async () => {
      const loadSessionMessages = vi.fn().mockResolvedValue(undefined);
      const restoreHistory = vi.fn();
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-25-main'],
        deleteSession: true,
      });
      const ctx = createMockCtx({
        sessionStore,
        agent: createMockAgent({
          agentHistory: {
            currentDateValue: '2026-06-25', // Agent 当前日期正是被删的日期
            loadSessionMessages,
          },
          agentLoop: { restoreHistory },
        }),
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_DELETE)!;
      const result = await callback({}, '2026-06-25-main');

      expect(result.success).toBe(true);
      // 应重置到当天 main 会话
      expect(loadSessionMessages).toHaveBeenCalledWith('2026-06-26', 'main');
      expect(restoreHistory).toHaveBeenCalledWith([]);
    });
  });

  // ─── SESSION_RENAME ────────────────────────────────────

  describe('SESSION_RENAME', () => {
    it('非法 sessionId 应被拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_RENAME)!;
      const result = await callback({}, '2026-06-26-main/..', '新名称');

      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的会话名');
    });

    it('非法 newName（含空格特殊字符）应被拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_RENAME)!;
      const result = await callback({}, '2026-06-26-main', '新名称/路径');

      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的会话名');
    });

    it('正常重命名应成功', async () => {
      const sessionStore = createMockSessionStore({ renameSession: true });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_RENAME)!;
      const result = await callback({}, '2026-06-26-main', 'coding-session');

      expect(result.success).toBe(true);
      // renameSession 接收原始 sessionId + trim 后的 newName
      expect(sessionStore.renameSession).toHaveBeenCalledWith('2026-06-26-main', 'coding-session');
    });

    it('会话不存在时返回错误', async () => {
      const sessionStore = createMockSessionStore({ renameSession: false });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_RENAME)!;
      const result = await callback({}, '2026-06-26-main', 'coding');

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在或重命名失败');
    });
  });

  // ─── SESSION_FORK ──────────────────────────────────────

  describe('SESSION_FORK', () => {
    it('Agent 未初始化时应返回错误', async () => {
      const ctx = createMockCtx({ agent: null as unknown as IpcContext['agent'] });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, undefined);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent 未初始化');
    });

    it('有进行中对话时应拒绝分叉', async () => {
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => new AbortController()), // 模拟有进行中对话
      });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, undefined);

      expect(result.success).toBe(false);
      expect(result.error).toContain('进行中的对话');
    });

    it('非法 targetSession（含路径分隔符）应被拒绝', async () => {
      const ctx = createMockCtx();
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, 'fork/../../../etc');

      expect(result.success).toBe(false);
      expect(result.error).toContain('无效的目标会话名');
    });

    it('无参数时应调用内核 forkSession 并返回结果', async () => {
      const agent = createMockAgent();
      // 覆盖默认返回值，验证无参数路径
      vi.mocked(agent.forkSession).mockReturnValue({ newSession: 'auto-branch', messageCount: 10 });
      const ctx = createMockCtx({ agent });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, undefined);

      expect(result.success).toBe(true);
      expect(result.newSession).toBe('auto-branch');
      expect(result.messageCount).toBe(10);
      // 无参数时 forkSession 应被调用且参数为空
      expect(agent.forkSession).toHaveBeenCalledWith();
    });

    it('有参数时应调用内核 forkSession 并传入 trim 后的名称', async () => {
      const agent = createMockAgent();
      vi.mocked(agent.forkSession).mockReturnValue({ newSession: 'custom-branch', messageCount: 3 });
      const ctx = createMockCtx({ agent });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, '  custom-name  ');

      expect(result.success).toBe(true);
      expect(result.newSession).toBe('custom-branch');
      expect(result.messageCount).toBe(3);
      // 应 trim 后传入内核
      expect(agent.forkSession).toHaveBeenCalledWith('custom-name');
    });

    it('空字符串参数等同于无参数（由内核自动生成）', async () => {
      const agent = createMockAgent();
      vi.mocked(agent.forkSession).mockReturnValue({ newSession: 'auto-branch', messageCount: 0 });
      const ctx = createMockCtx({ agent });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, '');

      expect(result.success).toBe(true);
      // 空字符串走无参数路径
      expect(agent.forkSession).toHaveBeenCalledWith();
    });

    it('内核 forkSession 抛错时应降级返回错误信息', async () => {
      const agent = createMockAgent();
      vi.mocked(agent.forkSession).mockImplementation(() => {
        throw new Error('对话繁忙');
      });
      const ctx = createMockCtx({ agent });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_FORK)!;
      const result = await callback({}, undefined);

      expect(result.success).toBe(false);
      expect(result.error).toBe('对话繁忙');
    });
  });

  // ─── SESSION_LIST ──────────────────────────────────────

  describe('SESSION_LIST', () => {
    it('应按日期聚合并始终包含当天占位会话', async () => {
      const sessionStore = createMockSessionStore({
        listSessions: ['2026-06-24-main', '2026-06-25-main', '2026-06-25-coding'],
        countMessages: 3,
        getFirstUserMessage: '预览内容',
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LIST)!;
      const result = await callback({});

      // 06-24 一条 + 06-25 取最后一条（coding）+ 06-26 当天占位 = 3 条
      expect(result.sessions).toHaveLength(3);
      const dates = result.sessions.map((s: { date: string }) => s.date);
      expect(dates).toEqual(['2026-06-24', '2026-06-25', '2026-06-26']);
      // 当天占位会话 id 应为 2026-06-26-main
      const todaySession = result.sessions.find((s: { date: string }) => s.date === '2026-06-26');
      expect(todaySession.id).toBe('2026-06-26-main');
    });

    it('列出失败应降级返回空数组', async () => {
      const sessionStore = createMockSessionStore();
      sessionStore.listSessions.mockImplementation(() => {
        throw new Error('列表查询失败');
      });
      const ctx = createMockCtx({ sessionStore });
      registerSessionHandlers(ctx);

      const callback = handleCallbacks.get(IPC_CHANNELS.SESSION_LIST)!;
      const result = await callback({});

      expect(result.sessions).toEqual([]);
    });
  });
});
