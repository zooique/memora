/**
 * 会话管理 HTTP 路由测试
 *
 * 覆盖范围：
 * - GET /api/sessions：列出所有会话（按日期聚合 + 预览 + 消息数 + 非法格式过滤）
 * - GET /api/sessions/messages：分页加载消息
 *   - limit ∈ [1, 500]、offset >= 0，非法值回退默认值
 *   - 无参数时回退到 ${today}-main
 *   - 非法 target 格式应返回空数组
 *   - hasMore 计算逻辑
 * - POST /api/sessions/switch：切换会话
 *   - 进行中对话阻断（getAbortController 非空时拒绝）
 *   - isValidSessionName 路径遍历防护（拒绝 / \ : * ? " < > | 字符）
 *   - sessionManager 不存在时跳过 Agent 状态更新
 *   - restoredCount = 0 时调用 agentLoop.restoreHistory([])
 * - DELETE /api/sessions/:id：删除会话（按日期前缀批量删除 + 非法 ID 拒绝）
 * - PUT /api/sessions/:id/rename：重命名会话
 *   - endsWith('/rename') 精确匹配，防 includes 误匹配
 *   - 非法 newName / sessionId 拒绝
 * - 安全分支：路径遍历字符逐一拒绝、limit/offset 边界值、null/undefined 入参
 * - 降级路径：Agent 未就绪 → 503；sessionStore 抛错 → 500；未匹配路由 → 404
 *
 * Mock 策略：
 * - sprite/constants.js：vi.mock getLocalDate 为固定日期（跨日逻辑测试稳定）
 * - IncomingMessage：自建 mock 对象，实现 method/url 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/end 调用
 * - HostContext：mock agent（sessionManager/agentLoop）+ sessionStore + isAgentReady + getAbortController
 *
 * 风格参考：src/__tests__/web/routes/memoryRoutes.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─── Mock getLocalDate 为固定日期（跨日逻辑测试稳定） ───
// vi.mock 是 hoisted 的，用 vi.hoisted 声明可在 factory 内引用的变量
const { MOCK_TODAY } = vi.hoisted(() => ({ MOCK_TODAY: '2026-06-26' }));
vi.mock('../../../sprite/constants.js', () => ({
  getLocalDate: vi.fn(() => MOCK_TODAY),
}));

// 导入被测模块（在 vi.mock 之后，确保 mock 生效）
import { handleSessionRoute } from '../../../web/routes/sessionRoutes.js';
import type { HostContext } from '../../../shared/hostContext.js';

// ─── 测试辅助：Mock 响应对象状态 ───────────────────────────

/** Mock 响应对象内部捕获的状态 */
interface MockResState {
  /** 捕获的状态码 */
  statusCode: number;
  /** 捕获的响应头 */
  headers: Record<string, string | number>;
  /** 捕获的响应体字符串 */
  body: string;
  /** headersSent 标志（end 调用后置 true；safeRoute 据此决定是否调用 sendError） */
  headersSent: boolean;
  /** writeHead mock 函数 */
  writeHead: ReturnType<typeof vi.fn>;
  /** end mock 函数 */
  end: ReturnType<typeof vi.fn>;
}

/** Mock ServerResponse：捕获 writeHead/end 调用供断言 */
type MockServerResponse = ServerResponse & MockResState;

/**
 * 创建 mock ServerResponse
 *
 * 捕获 writeHead(status, headers) 与 end(body) 调用到内部 state，
 * 测试用 res.statusCode / res.body / res.headers 断言。
 * headersSent 可读可写（safeRoute 检查此标志决定是否调用 sendError）。
 *
 * @returns mock 响应对象
 */
function createMockRes(): MockServerResponse {
  /** mock 响应对象（属性可读可写，writeHead/end 通过闭包修改属性） */
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    headersSent: false,
  } as MockResState;

  res.writeHead = vi.fn((status: number, headers?: Record<string, string | number>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
  });
  res.end = vi.fn((data?: string | Buffer) => {
    if (data !== undefined) res.body = data.toString();
    res.headersSent = true;
  });

  return res as unknown as MockServerResponse;
}

/**
 * 创建 mock IncomingMessage
 *
 * 实现 method/url 属性与 async iterator 接口，
 * 使 parseJsonBody 的 `for await (const chunk of req)` 能读取 body。
 *
 * @param method HTTP 方法
 * @param url 完整 URL（含 query string）
 * @param body 请求体对象（可选，POST/PUT/DELETE 使用）
 * @returns mock 请求对象
 */
function createMockReq(method: string, url: string, body?: unknown): IncomingMessage {
  /** 序列化后的 body Buffer（无 body 时为 null） */
  const bodyBuffer = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;

  const req = {
    method,
    url,
    /** 实现 async iterator：yield body chunks 供 parseJsonBody 读取 */
    async *[Symbol.asyncIterator]() {
      if (bodyBuffer) yield bodyBuffer;
    },
  } as unknown as IncomingMessage;

  return req;
}

// ─── Mock SessionStore ───────────────────────────────────

/** Mock 会话消息（与 memora SessionMessage 结构对齐） */
interface MockSessionMessage {
  /** 消息角色 */
  role: 'user' | 'assistant';
  /** 消息内容 */
  content: string;
  /** 消息时间戳 */
  timestamp: string;
}

/** Mock SessionStore 方法集合 */
interface MockSessionStore {
  /** 列出所有会话 ID */
  listSessions: ReturnType<typeof vi.fn>;
  /** 列出所有会话及其元数据（批量查询，替代 N+1） */
  listSessionsWithMetadata: ReturnType<typeof vi.fn>;
  /** 统计会话消息数 */
  countMessages: ReturnType<typeof vi.fn>;
  /** 加载会话全部消息（用于 switch） */
  loadMessages: ReturnType<typeof vi.fn>;
  /** 分页加载会话消息（用于 list/messages） */
  loadMessagesPaginated: ReturnType<typeof vi.fn>;
  /** 删除会话 */
  deleteSession: ReturnType<typeof vi.fn>;
  /** 重命名会话 */
  renameSession: ReturnType<typeof vi.fn>;
}

/**
 * 创建 mock SessionStore
 *
 * 默认所有方法返回空/零/false，通过 overrides 覆盖默认返回值。
 *
 * @param overrides 可选的默认返回值
 * @returns mock SessionStore
 */
function createMockSessionStore(overrides?: {
  listSessions?: string[];
  listSessionsWithMetadata?: Array<{ id: string; date: string; name: string; preview: string; messageCount: number }>;
  countMessages?: number;
  loadMessages?: MockSessionMessage[];
  loadMessagesPaginated?: MockSessionMessage[];
  deleteSession?: boolean;
  renameSession?: boolean;
}): MockSessionStore {
  return {
    listSessions: vi.fn(() => overrides?.listSessions ?? []),
    listSessionsWithMetadata: vi.fn(() => overrides?.listSessionsWithMetadata ?? []),
    countMessages: vi.fn(() => overrides?.countMessages ?? 0),
    loadMessages: vi.fn(() => overrides?.loadMessages ?? []),
    loadMessagesPaginated: vi.fn(() => overrides?.loadMessagesPaginated ?? []),
    deleteSession: vi.fn(() => overrides?.deleteSession ?? true),
    renameSession: vi.fn(() => overrides?.renameSession ?? true),
  };
}

// ─── Mock Agent ──────────────────────────────────────────

/** Mock Agent（仅含 sessionRoutes 需要的 sessionManager + agentLoop 子集） */
interface MockAgent {
  /** 会话管理器（切换 + 恢复历史） */
  sessionManager: {
    switchSession: ReturnType<typeof vi.fn>;
    restoreSession: ReturnType<typeof vi.fn>;
  } | null;
  /** Agent 循环（恢复工作记忆） */
  agentLoop: {
    restoreHistory: ReturnType<typeof vi.fn>;
  } | null;
}

/**
 * 创建 mock Agent
 *
 * 默认 sessionManager 和 agentLoop 都存在，restoreSession 默认返回 0。
 * 通过 overrides 可注入 null 测试"未初始化"场景。
 * 注意：用 in 操作符区分"未传"和"显式传 null"，避免 null ?? 默认值 的陷阱。
 *
 * @param overrides 可选的覆盖项
 * @returns mock Agent
 */
function createMockAgent(overrides?: {
  sessionManager?: MockAgent['sessionManager'] | null;
  agentLoop?: MockAgent['agentLoop'] | null;
}): MockAgent {
  const hasSessionManager = overrides && 'sessionManager' in overrides;
  const hasAgentLoop = overrides && 'agentLoop' in overrides;
  return {
    sessionManager: hasSessionManager
      ? overrides!.sessionManager
      : {
          switchSession: vi.fn(),
          restoreSession: vi.fn().mockResolvedValue(0),
        },
    agentLoop: hasAgentLoop ? overrides!.agentLoop : { restoreHistory: vi.fn() },
  };
}

// ─── Mock HostContext ────────────────────────────────────

/**
 * 创建 mock HostContext
 *
 * 组合 mock agent + sessionStore + isAgentReady + getAbortController。
 * 通过 overrides 覆盖各字段以测试不同场景。
 *
 * @param overrides 可选的覆盖项
 * @returns mock HostContext
 */
function createMockCtx(overrides?: {
  /** sessionStore mock（默认空实现） */
  sessionStore?: MockSessionStore;
  /** agent mock（默认含 sessionManager + agentLoop）；传 null 测试未初始化场景 */
  agent?: MockAgent | null;
  /** isAgentReady mock（默认 () => true） */
  isAgentReady?: ReturnType<typeof vi.fn>;
  /** getAbortController mock（默认 () => null）；返回非空模拟进行中对话 */
  getAbortController?: ReturnType<typeof vi.fn>;
}): HostContext {
  // 注意：agent 可能为 null（测试未初始化场景），不能用 ?? 替换
  const hasAgent = overrides && 'agent' in overrides;
  return {
    agent: (hasAgent ? overrides!.agent : createMockAgent()) as unknown as HostContext['agent'],
    sprite: {} as HostContext['sprite'],
    sessionStore: (overrides?.sessionStore ?? createMockSessionStore()) as unknown as HostContext['sessionStore'],
    getAbortController: overrides?.getAbortController ?? vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: overrides?.isAgentReady ?? vi.fn(() => true),
  };
}

/** 创建 mock SessionMessage 的便捷工厂 */
function makeMsg(role: 'user' | 'assistant', content: string, timestamp?: string): MockSessionMessage {
  return { role, content, timestamp: timestamp ?? '2026-06-26T10:00:00.000Z' };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('handleSessionRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/sessions ─────────────────────────────────

  it('GET /api/sessions 应返回 200 + 按日期聚合的会话列表', async () => {
    const sessionStore = createMockSessionStore({
      listSessionsWithMetadata: [
        { id: '2026-06-26-main', date: '2026-06-26', name: 'main', preview: '你好', messageCount: 5 },
        { id: '2026-06-25-test', date: '2026-06-25', name: 'test', preview: '测试', messageCount: 5 },
      ],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // 应调用 listSessionsWithMetadata 批量获取会话元数据（替代 N+1 模式）
    expect(sessionStore.listSessionsWithMetadata).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    /** 解析响应体 */
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toEqual({
      id: '2026-06-26-main',
      date: '2026-06-26',
      name: 'main',
      preview: '你好',
      messageCount: 5,
    });
  });

  it('GET /api/sessions 无会话时应返回空数组', async () => {
    const sessionStore = createMockSessionStore({ listSessionsWithMetadata: [] });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sessions: [] });
  });

  it('GET /api/sessions 非法 sessionId 格式应被过滤掉', async () => {
    // listSessionsWithMetadata 由 SessionStore 实现层过滤非法格式
    const sessionStore = createMockSessionStore({
      listSessionsWithMetadata: [
        { id: '2026-06-26-main', date: '2026-06-26', name: 'main', preview: '', messageCount: 0 },
      ],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    /** 仅 2026-06-26-main 符合格式，其余由 SQL 层过滤 */
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('2026-06-26-main');
  });

  it('GET /api/sessions messageCount=0 时 preview 应为空', async () => {
    const sessionStore = createMockSessionStore({
      listSessionsWithMetadata: [
        { id: '2026-06-26-main', date: '2026-06-26', name: 'main', preview: '', messageCount: 0 },
      ],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions[0].preview).toBe('');
    expect(body.sessions[0].messageCount).toBe(0);
  });

  it('GET /api/sessions preview 应截断到 50 字符', async () => {
    /** 构造长度 60 的内容，preview 应截断为 50 */
    const longContent = 'a'.repeat(60);
    const sessionStore = createMockSessionStore({
      listSessionsWithMetadata: [
        { id: '2026-06-26-main', date: '2026-06-26', name: 'main', preview: longContent.slice(0, 50), messageCount: 1 },
      ],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions[0].preview).toBe('a'.repeat(50));
    expect(body.sessions[0].preview.length).toBe(50);
  });

  it('GET /api/sessions listSessionsWithMetadata 抛错应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore();
    sessionStore.listSessionsWithMetadata.mockImplementation(() => {
      throw new Error('数据库损坏');
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── GET /api/sessions/messages ────────────────────────

  it('GET /api/sessions/messages 有 date+session 参数时应加载指定会话', async () => {
    const messages = [makeMsg('user', '你好'), makeMsg('assistant', '你好！')];
    const sessionStore = createMockSessionStore({
      countMessages: 2,
      loadMessagesPaginated: messages,
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-25&session=main&limit=10&offset=0');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-25', 'main', 10, 0);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.loadedSessionId).toBe('2026-06-25-main');
    expect(body.total).toBe(2);
    expect(body.hasMore).toBe(false); // 0 + 2 = 2, not < 2
    expect(body.messages).toHaveLength(2);
  });

  it('GET /api/sessions/messages 无参数时应回退到今天的 main 会话', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 0,
      loadMessagesPaginated: [],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // 应回退到 ${MOCK_TODAY}-main
    expect(sessionStore.countMessages).toHaveBeenCalledWith(MOCK_TODAY, 'main');
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith(MOCK_TODAY, 'main', 50, 0);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).loadedSessionId).toBe(`${MOCK_TODAY}-main`);
  });

  it('GET /api/sessions/messages 默认 limit=50 + offset=0', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 100,
      loadMessagesPaginated: [makeMsg('user', 'msg')],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // 未传 limit/offset 时应使用默认值 50/0
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 50, 0);
  });

  it('GET /api/sessions/messages limit=500（上限）应正常透传', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 600,
      loadMessagesPaginated: [makeMsg('user', 'msg')],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&limit=500');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 500, 0);
  });

  it('GET /api/sessions/messages limit=0（低于下限）应回退默认值 50', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 0,
      loadMessagesPaginated: [],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&limit=0');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // limit=0 < 1，应回退到默认值 50
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 50, 0);
  });

  it('GET /api/sessions/messages limit=501（超过上限）应回退默认值 50', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 0,
      loadMessagesPaginated: [],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&limit=501');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // limit=501 > 500，应回退到默认值 50
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 50, 0);
  });

  it('GET /api/sessions/messages offset=-1（负数）应回退默认值 0', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 0,
      loadMessagesPaginated: [],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&offset=-1');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // offset=-1 < 0，应回退到默认值 0
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 50, 0);
  });

  it('GET /api/sessions/messages limit/offset 非数字应回退默认值', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 0,
      loadMessagesPaginated: [],
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&limit=abc&offset=xyz');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // parseInt('abc') = NaN，Number.isFinite(NaN) = false，应回退默认值 50/0
    expect(sessionStore.loadMessagesPaginated).toHaveBeenCalledWith('2026-06-26', 'main', 50, 0);
  });

  it('GET /api/sessions/messages hasMore 在还有未加载消息时应为 true', async () => {
    const sessionStore = createMockSessionStore({
      countMessages: 100,
      loadMessagesPaginated: [makeMsg('user', 'msg')],
    });
    const ctx = createMockCtx({ sessionStore });
    // limit=10, offset=0，返回 1 条但 total=100，应 hasMore=true
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main&limit=10&offset=0');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    const body = JSON.parse(res.body);
    expect(body.hasMore).toBe(true); // 0 + 1 < 100
  });

  it('GET /api/sessions/messages 非法 target 格式应返回空数组', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    // date 不符合 YYYY-MM-DD 格式，target = "invalid-main" 不匹配正则
    const req = createMockReq('GET', '/api/sessions/messages?date=invalid&session=main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ messages: [], loadedSessionId: '', total: 0, hasMore: false });
    // 内核方法不应被调用
    expect(sessionStore.countMessages).not.toHaveBeenCalled();
  });

  it('GET /api/sessions/messages countMessages 抛错应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore();
    sessionStore.countMessages.mockImplementation(() => {
      throw new Error('查询失败');
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('GET', '/api/sessions/messages?date=2026-06-26&session=main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── POST /api/sessions/switch ─────────────────────────

  it('POST /api/sessions/switch 正常切换应调用 switchSession + restoreSession + loadMessages', async () => {
    const messages = [makeMsg('user', '历史消息')];
    const sessionStore = createMockSessionStore({ loadMessages: messages });
    const agent = createMockAgent({
      sessionManager: {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(3),
      },
    });
    const ctx = createMockCtx({ sessionStore, agent });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-25',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(agent.sessionManager!.switchSession).toHaveBeenCalledWith('main');
    expect(agent.sessionManager!.restoreSession).toHaveBeenCalledWith('2026-06-25', 'main');
    expect(sessionStore.loadMessages).toHaveBeenCalledWith('2026-06-25', 'main');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.messages).toHaveLength(1);
  });

  it('POST /api/sessions/switch restoredCount=0 时应调用 agentLoop.restoreHistory([])', async () => {
    const sessionStore = createMockSessionStore({ loadMessages: [] });
    const agent = createMockAgent({
      sessionManager: {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(0),
      },
      agentLoop: { restoreHistory: vi.fn() },
    });
    const ctx = createMockCtx({ sessionStore, agent });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'empty-session',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // restoredCount=0 时应清理旧上下文
    expect(agent.agentLoop!.restoreHistory).toHaveBeenCalledWith([]);
  });

  it('POST /api/sessions/switch restoredCount>0 时不应调用 agentLoop.restoreHistory', async () => {
    const sessionStore = createMockSessionStore({ loadMessages: [] });
    const agent = createMockAgent({
      sessionManager: {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockResolvedValue(5),
      },
      agentLoop: { restoreHistory: vi.fn() },
    });
    const ctx = createMockCtx({ sessionStore, agent });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(agent.agentLoop!.restoreHistory).not.toHaveBeenCalled();
  });

  it('POST /api/sessions/switch sessionManager=null 时应跳过 Agent 状态更新但仍加载消息', async () => {
    const messages = [makeMsg('user', 'msg')];
    const sessionStore = createMockSessionStore({ loadMessages: messages });
    const agent = createMockAgent({ sessionManager: null });
    const ctx = createMockCtx({ sessionStore, agent });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // sessionManager 为 null 时不调用 switchSession/restoreSession，但仍加载消息
    expect(sessionStore.loadMessages).toHaveBeenCalledWith('2026-06-26', 'main');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /api/sessions/switch 缺少 date 或 session 应返回 400', async () => {
    const ctx = createMockCtx();
    const req1 = createMockReq('POST', '/api/sessions/switch', { session: 'main' });
    const res1 = createMockRes();
    await handleSessionRoute(req1, res1, ctx);
    expect(res1.statusCode).toBe(400);
    expect(JSON.parse(res1.body).error).toContain('必填');

    const req2 = createMockReq('POST', '/api/sessions/switch', { date: '2026-06-26' });
    const res2 = createMockRes();
    await handleSessionRoute(req2, res2, ctx);
    expect(res2.statusCode).toBe(400);
  });

  it('POST /api/sessions/switch 非法 session 名（含路径分隔符等）应被拒绝', async () => {
    const forbiddenChars = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    for (const ch of forbiddenChars) {
      const ctx = createMockCtx();
      const req = createMockReq('POST', '/api/sessions/switch', {
        date: '2026-06-26',
        session: `evil${ch}name`,
      });
      const res = createMockRes();

      await handleSessionRoute(req, res, ctx);

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('无效的会话名');
    }
  });

  it('POST /api/sessions/switch session 名超长（> 200）应被拒绝', async () => {
    // 长度上限 200（与 IPC 层 isValidSessionName 一致，避免两层行为分歧）
    const ctx = createMockCtx();
    /** 构造长度 201 的会话名（超过 200 限制） */
    const longName = 'a'.repeat(201);
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: longName,
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('无效的会话名');
  });

  it('POST /api/sessions/switch 有进行中对话时应拒绝切换', async () => {
    const ctx = createMockCtx({
      getAbortController: vi.fn(() => new AbortController()), // 模拟有进行中对话
    });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('进行中的对话');
  });

  it('POST /api/sessions/switch loadMessages 抛错应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore();
    sessionStore.loadMessages.mockImplementation(() => {
      throw new Error('加载失败');
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── DELETE /api/sessions/:id ──────────────────────────

  it('DELETE /api/sessions/:id 应按日期前缀批量删除当天所有子会话', async () => {
    const sessionStore = createMockSessionStore({
      listSessions: ['2026-06-26-main', '2026-06-26-test', '2026-06-25-main'],
      deleteSession: true,
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('DELETE', '/api/sessions/2026-06-26-main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // datePrefix = '2026-06-26'，应删除当天 2 个会话，不删除 2026-06-25
    expect(sessionStore.deleteSession).toHaveBeenCalledWith('2026-06-26-main');
    expect(sessionStore.deleteSession).toHaveBeenCalledWith('2026-06-26-test');
    expect(sessionStore.deleteSession).not.toHaveBeenCalledWith('2026-06-25-main');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('DELETE /api/sessions/:id 非法 sessionId（含路径分隔符）应被拒绝', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('DELETE', '/api/sessions/2026-06-26-ev%2Fil');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // decodeURIComponent 后 sessionId 含 /，应被 isValidSessionName 拒绝
    expect(sessionStore.deleteSession).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('无效的会话 ID');
  });

  it('DELETE /api/sessions/ 空 sessionId 应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/sessions/');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('DELETE /api/sessions/:id 无匹配会话应返回 success: false', async () => {
    const sessionStore = createMockSessionStore({
      listSessions: ['2026-06-25-main'], // 不含 2026-06-26 的会话
      deleteSession: true,
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('DELETE', '/api/sessions/2026-06-26-main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('未找到');
  });

  it('DELETE /api/sessions（无尾斜杠无 ID）应返回 404', async () => {
    const ctx = createMockCtx();
    // path = '/api/sessions'，不匹配 startsWith('/api/sessions/')，应落入 404
    const req = createMockReq('DELETE', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/sessions/:id deleteSession 抛错应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore({
      listSessions: ['2026-06-26-main'],
    });
    sessionStore.deleteSession.mockImplementation(() => {
      throw new Error('删除失败');
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('DELETE', '/api/sessions/2026-06-26-main');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── PUT /api/sessions/:id/rename ──────────────────────

  it('PUT /api/sessions/:id/rename 正常重命名应调用 renameSession', async () => {
    const sessionStore = createMockSessionStore({ renameSession: true });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: 'new-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).toHaveBeenCalledWith('2026-06-26-main', 'new-name');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('PUT /api/sessions/:id/rename 缺少 newName 应返回 success: false', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {});
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('无效的会话名');
  });

  it('PUT /api/sessions/:id/rename 非法 newName（含路径分隔符）应被拒绝', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: 'evil/name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('无效的会话名');
  });

  it('PUT /api/sessions/:id/rename newName 超长（> 200）应被拒绝', async () => {
    // 长度上限 200（与 IPC 层 isValidSessionName 一致，避免两层行为分歧）
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    /** 构造长度 201 的新会话名（超过 200 限制） */
    const longName = 'a'.repeat(201);
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: longName,
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('PUT /api/sessions/:id/rename 非法 sessionId 应被拒绝', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    // sessionId 含 /，应被 isValidSessionName 拒绝
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-evil%2Fname/rename', {
      newName: 'valid-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).not.toHaveBeenCalled();
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('无效的会话 ID');
  });

  it('PUT /api/sessions/:id/rename renameSession 返回 false 应返回 success: false', async () => {
    const sessionStore = createMockSessionStore({ renameSession: false });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: 'new-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('不存在或重命名失败');
  });

  it('PUT /api/sessions/rename-xxx 不应匹配 rename 路由（endsWith 精确匹配）', async () => {
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ sessionStore });
    // path = '/api/sessions/rename-xxx'，endsWith('/rename') = false
    // 若用 includes('/rename') 会误匹配，endsWith 防止此问题
    const req = createMockReq('PUT', '/api/sessions/rename-xxx', {
      newName: 'new-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    // 不应调用 renameSession，应落入 404
    expect(sessionStore.renameSession).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it('PUT /api/sessions/:id/rename 正常路径应精确匹配（正向验证）', async () => {
    const sessionStore = createMockSessionStore({ renameSession: true });
    const ctx = createMockCtx({ sessionStore });
    // path = '/api/sessions/2026-06-26-main/rename'，endsWith('/rename') = true
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: 'new-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(sessionStore.renameSession).toHaveBeenCalledWith('2026-06-26-main', 'new-name');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('PUT /api/sessions/:id/rename renameSession 抛错应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore();
    sessionStore.renameSession.mockImplementation(() => {
      throw new Error('重命名失败');
    });
    const ctx = createMockCtx({ sessionStore });
    const req = createMockReq('PUT', '/api/sessions/2026-06-26-main/rename', {
      newName: 'new-name',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── 通用：Agent 未就绪 / 404 / 500 兜底 ────────────────

  it('Agent 未就绪时应返回 503', async () => {
    const isAgentReady = vi.fn(() => false);
    const sessionStore = createMockSessionStore();
    const ctx = createMockCtx({ isAgentReady, sessionStore });
    const req = createMockReq('GET', '/api/sessions');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(isAgentReady).toHaveBeenCalled();
    expect(sessionStore.listSessions).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
  });

  it('未匹配的路由应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/sessions/unknown-path', {});
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
  });

  it('未匹配的 GET 路由也应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/sessions/unknown');
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
  });

  it('异步异常（restoreSession reject）应由 safeRoute 兜底返回 500', async () => {
    const sessionStore = createMockSessionStore({ loadMessages: [] });
    const agent = createMockAgent({
      sessionManager: {
        switchSession: vi.fn(),
        restoreSession: vi.fn().mockRejectedValue(new Error('恢复失败')),
      },
    });
    const ctx = createMockCtx({ sessionStore, agent });
    const req = createMockReq('POST', '/api/sessions/switch', {
      date: '2026-06-26',
      session: 'main',
    });
    const res = createMockRes();

    await handleSessionRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });
});
