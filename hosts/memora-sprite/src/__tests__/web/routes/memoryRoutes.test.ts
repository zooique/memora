/**
 * 记忆 CRUD HTTP 路由测试
 *
 * 覆盖范围：
 * - GET /api/memories：列出记忆（含 source 过滤）
 * - GET /api/memories/search：搜索记忆 + 输入验证（空 q / 超长 q 降级）
 * - GET /api/memories/:id：查看记忆详情 + 输入验证（超长 ID 降级）
 * - DELETE /api/memories/:id：删除记忆 + 输入验证（超长 ID 降级）
 * - POST /api/memories：添加记忆 + 必填字段校验
 * - POST /api/memories/batch-delete：批量删除（循环调用 deleteMemory）
 * - POST/DELETE/PUT /api/memories/relation：记忆关系增删改
 * - GET /api/memories/graph|health|review：图谱 / 健康度 / 回顾数据
 * - Agent 未就绪 → 503；路由未匹配 → 404；异常 → 500（safeRoute 兜底）
 *
 * Mock 策略：
 * - IncomingMessage：自建 mock 对象，实现 method/url 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/end 调用
 * - HostContext.sprite：mock 全部记忆相关方法
 *
 * 风格参考：src/__tests__/electron/ipc/memoryHandlers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 导入被测模块
import { handleMemoryRoute } from '../../../web/routes/memoryRoutes.js';
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
  /** headersSent 标志（end 调用后置 true；测试也可手动设置以模拟已发送） */
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

/**
 * 创建 mock HostContext
 *
 * 仅包含 memoryRoutes 需要的 sprite 方法 + isAgentReady，
 * 其余字段（agent/sessionStore 等）置空对象。
 *
 * @param overrides 可选的 sprite 方法覆盖
 * @returns mock HostContext
 */
function createMockCtx(overrides?: {
  listMemories?: ReturnType<typeof vi.fn>;
  searchMemories?: ReturnType<typeof vi.fn>;
  showMemory?: ReturnType<typeof vi.fn>;
  deleteMemory?: ReturnType<typeof vi.fn>;
  upsertMemory?: ReturnType<typeof vi.fn>;
  getRelationGraph?: ReturnType<typeof vi.fn>;
  getHealthDashboard?: ReturnType<typeof vi.fn>;
  getReviewData?: ReturnType<typeof vi.fn>;
  addRelation?: ReturnType<typeof vi.fn>;
  removeRelation?: ReturnType<typeof vi.fn>;
  updateRelation?: ReturnType<typeof vi.fn>;
  isAgentReady?: ReturnType<typeof vi.fn>;
}): HostContext {
  return {
    agent: {} as HostContext['agent'],
    sprite: {
      listMemories: overrides?.listMemories ?? vi.fn(() => []),
      searchMemories: overrides?.searchMemories ?? vi.fn(async () => []),
      showMemory: overrides?.showMemory ?? vi.fn(() => null),
      deleteMemory: overrides?.deleteMemory ?? vi.fn(() => false),
      upsertMemory: overrides?.upsertMemory ?? vi.fn(() => 'new-id'),
      getRelationGraph: overrides?.getRelationGraph ?? vi.fn(() => ({ nodes: [], edges: [] })),
      getHealthDashboard: overrides?.getHealthDashboard ?? vi.fn(() => ({ score: 100 })),
      getReviewData: overrides?.getReviewData ?? vi.fn(() => ({ summary: '' })),
      addRelation: overrides?.addRelation ?? vi.fn(),
      removeRelation: overrides?.removeRelation ?? vi.fn(),
      updateRelation: overrides?.updateRelation ?? vi.fn(),
    } as unknown as HostContext['sprite'],
    sessionStore: {} as HostContext['sessionStore'],
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: overrides?.isAgentReady ?? vi.fn(() => true),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('handleMemoryRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/memories ─────────────────────────────────

  it('GET /api/memories 应返回 200 + memories 数组', async () => {
    const memories = [{ id: '1', name: '记忆1' }];
    const listMemories = vi.fn(() => memories);
    const ctx = createMockCtx({ listMemories });
    const req = createMockReq('GET', '/api/memories');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(listMemories).toHaveBeenCalledWith(undefined);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ memories });
  });

  it('GET /api/memories?source=profile 应传递 source 过滤参数', async () => {
    const listMemories = vi.fn(() => []);
    const ctx = createMockCtx({ listMemories });
    const req = createMockReq('GET', '/api/memories?source=profile');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(listMemories).toHaveBeenCalledWith('profile');
    expect(res.statusCode).toBe(200);
  });

  // ─── GET /api/memories/search ──────────────────────────

  it('GET /api/memories/search?q=xxx 应调用 searchMemories 并返回 hits', async () => {
    const hits = [{ id: '1', score: 0.95 }];
    const searchMemories = vi.fn(async () => hits);
    const ctx = createMockCtx({ searchMemories });
    const req = createMockReq('GET', '/api/memories/search?q=关键词');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(searchMemories).toHaveBeenCalledWith('关键词');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hits });
  });

  it('GET /api/memories/search 无 q 参数应降级返回 hits: []', async () => {
    const searchMemories = vi.fn(async () => [{ id: '1' }]);
    const ctx = createMockCtx({ searchMemories });
    const req = createMockReq('GET', '/api/memories/search');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(searchMemories).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hits: [] });
  });

  it('GET /api/memories/search?q=超长应降级返回 hits: []', async () => {
    const searchMemories = vi.fn(async () => [{ id: '1' }]);
    const ctx = createMockCtx({ searchMemories });
    /** 构造长度 1001 的关键词（超过 1000 限制） */
    const longQuery = 'a'.repeat(1001);
    const req = createMockReq('GET', `/api/memories/search?q=${longQuery}`);
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(searchMemories).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hits: [] });
  });

  // ─── GET /api/memories/:id ─────────────────────────────

  it('GET /api/memories/:id 应返回 200 + memory 详情', async () => {
    const memory = { id: '1', name: '记忆1', content: '内容' };
    const showMemory = vi.fn(() => memory);
    const ctx = createMockCtx({ showMemory });
    const req = createMockReq('GET', '/api/memories/abc-123');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(showMemory).toHaveBeenCalledWith('abc-123');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ memory });
  });

  it('GET /api/memories/超长 ID 应降级返回 memory: null', async () => {
    const showMemory = vi.fn(() => null);
    const ctx = createMockCtx({ showMemory });
    /** 构造长度 501 的 ID（超过 500 限制） */
    const longId = 'a'.repeat(501);
    const req = createMockReq('GET', `/api/memories/${longId}`);
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(showMemory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ memory: null });
  });

  // ─── DELETE /api/memories/:id ──────────────────────────

  it('DELETE /api/memories/:id 应调用 deleteMemory 并返回 deleted', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    const req = createMockReq('DELETE', '/api/memories/abc-123');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(deleteMemory).toHaveBeenCalledWith('abc-123');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
  });

  it('DELETE /api/memories/超长 ID 应降级返回 deleted: false', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    const longId = 'a'.repeat(501);
    const req = createMockReq('DELETE', `/api/memories/${longId}`);
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: false });
  });

  // ─── POST /api/memories ────────────────────────────────

  it('POST /api/memories 合法请求应调用 upsertMemory 并返回 id', async () => {
    const upsertMemory = vi.fn(() => 'new-id');
    const ctx = createMockCtx({ upsertMemory });
    const req = createMockReq('POST', '/api/memories', {
      source: 'insight',
      name: '新记忆',
      content: '内容',
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(upsertMemory).toHaveBeenCalledWith('insight', '新记忆', '内容');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: 'new-id' });
  });

  it('POST /api/memories 缺少必填字段应返回 400', async () => {
    const upsertMemory = vi.fn(() => 'new-id');
    const ctx = createMockCtx({ upsertMemory });
    const req = createMockReq('POST', '/api/memories', {
      source: 'insight',
      // 缺少 name 和 content
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(upsertMemory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  // ─── POST /api/memories/batch-delete ───────────────────

  it('POST /api/memories/batch-delete 应循环调用 deleteMemory', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    const req = createMockReq('POST', '/api/memories/batch-delete', {
      ids: ['id-1', 'id-2', 'id-3'],
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(deleteMemory).toHaveBeenCalledTimes(3);
    expect(deleteMemory).toHaveBeenCalledWith('id-1');
    expect(deleteMemory).toHaveBeenCalledWith('id-2');
    expect(deleteMemory).toHaveBeenCalledWith('id-3');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 3, total: 3 });
  });

  it('POST /api/memories/batch-delete 缺少 ids 数组应返回 400', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    const req = createMockReq('POST', '/api/memories/batch-delete', { foo: 'bar' });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(deleteMemory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/memories/batch-delete 应跳过超长 ID', async () => {
    const deleteMemory = vi.fn(() => true);
    const ctx = createMockCtx({ deleteMemory });
    /** 构造长度 501 的 ID（超过 500 限制，应被跳过） */
    const longId = 'a'.repeat(501);
    const req = createMockReq('POST', '/api/memories/batch-delete', {
      ids: ['valid-id', longId],
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(deleteMemory).toHaveBeenCalledTimes(1);
    expect(deleteMemory).toHaveBeenCalledWith('valid-id');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: 1, total: 2 });
  });

  // ─── POST /api/memories/relation ───────────────────────

  it('POST /api/memories/relation 应调用 addRelation', async () => {
    const addRelation = vi.fn();
    const ctx = createMockCtx({ addRelation });
    const req = createMockReq('POST', '/api/memories/relation', {
      sourceId: 's1',
      targetId: 't1',
      type: 'related',
      weight: 0.8,
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(addRelation).toHaveBeenCalledWith('s1', 't1', 'related', 0.8);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('POST /api/memories/relation 缺少 sourceId/targetId 应返回 400', async () => {
    const addRelation = vi.fn();
    const ctx = createMockCtx({ addRelation });
    const req = createMockReq('POST', '/api/memories/relation', { sourceId: 's1' });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(addRelation).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  // ─── DELETE /api/memories/relation ─────────────────────

  it('DELETE /api/memories/relation 应调用 removeRelation', async () => {
    const removeRelation = vi.fn();
    const ctx = createMockCtx({ removeRelation });
    const req = createMockReq('DELETE', '/api/memories/relation', {
      sourceId: 's1',
      targetId: 't1',
      type: 'related',
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(removeRelation).toHaveBeenCalledWith('s1', 't1', 'related');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('DELETE /api/memories/relation 缺少 sourceId/targetId 应返回 400', async () => {
    const removeRelation = vi.fn();
    const ctx = createMockCtx({ removeRelation });
    const req = createMockReq('DELETE', '/api/memories/relation', {});
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(removeRelation).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  // ─── PUT /api/memories/relation ────────────────────────

  it('PUT /api/memories/relation 应调用 updateRelation', async () => {
    const updateRelation = vi.fn();
    const ctx = createMockCtx({ updateRelation });
    const req = createMockReq('PUT', '/api/memories/relation', {
      sourceId: 's1',
      targetId: 't1',
      type: 'related',
      weight: 0.5,
    });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(updateRelation).toHaveBeenCalledWith('s1', 't1', 'related', 0.5);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('PUT /api/memories/relation 缺少 sourceId/targetId 应返回 400', async () => {
    const updateRelation = vi.fn();
    const ctx = createMockCtx({ updateRelation });
    const req = createMockReq('PUT', '/api/memories/relation', { sourceId: 's1' });
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(updateRelation).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  // ─── GET /api/memories/graph ───────────────────────────

  it('GET /api/memories/graph 应返回关系图谱', async () => {
    const graph = { nodes: [{ id: '1' }], edges: [{ sourceId: '1', targetId: '2' }] };
    const getRelationGraph = vi.fn(() => graph);
    const ctx = createMockCtx({ getRelationGraph });
    const req = createMockReq('GET', '/api/memories/graph');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(getRelationGraph).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(graph);
  });

  // ─── GET /api/memories/health ──────────────────────────

  it('GET /api/memories/health 应返回健康度仪表盘', async () => {
    const dashboard = { score: 85, suggestions: [] };
    const getHealthDashboard = vi.fn(() => dashboard);
    const ctx = createMockCtx({ getHealthDashboard });
    const req = createMockReq('GET', '/api/memories/health');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(getHealthDashboard).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(dashboard);
  });

  // ─── GET /api/memories/review ──────────────────────────

  it('GET /api/memories/review 应返回对话回顾数据', async () => {
    const reviewData = { summary: '本周回顾', insights: [] };
    const getReviewData = vi.fn(() => reviewData);
    const ctx = createMockCtx({ getReviewData });
    const req = createMockReq('GET', '/api/memories/review');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(getReviewData).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(reviewData);
  });

  // ─── Agent 未就绪 ──────────────────────────────────────

  it('Agent 未就绪时应返回 503', async () => {
    const isAgentReady = vi.fn(() => false);
    const ctx = createMockCtx({ isAgentReady });
    const listMemories = vi.fn(() => []);
    ctx.sprite.listMemories = listMemories;
    const req = createMockReq('GET', '/api/memories');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(isAgentReady).toHaveBeenCalled();
    expect(listMemories).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
  });

  // ─── 路由未匹配 ────────────────────────────────────────

  it('未匹配的路由应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/memories/unknown-path', {});
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
    // 不回显 path 防止注入/泄露路由结构，仅返回通用 404 文案
    expect(JSON.parse(res.body).error).toBe('404 Not Found');
  });

  // ─── 异常兜底 ──────────────────────────────────────────

  it('sprite 方法抛错应由 safeRoute 兜底返回 500', async () => {
    const listMemories = vi.fn(() => {
      throw new Error('数据库错误');
    });
    const ctx = createMockCtx({ listMemories });
    const req = createMockReq('GET', '/api/memories');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('数据库错误');
  });

  it('异步 sprite 方法 reject 应由 safeRoute 兜底返回 500', async () => {
    const searchMemories = vi.fn(async () => {
      throw new Error('搜索服务不可用');
    });
    const ctx = createMockCtx({ searchMemories });
    const req = createMockReq('GET', '/api/memories/search?q=test');
    const res = createMockRes();

    await handleMemoryRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('搜索服务不可用');
  });
});
