/**
 * 对话流式 SSE 路由测试
 *
 * 覆盖范围：
 * - POST /api/chat/abort：有/无进行中对话时的中断行为
 * - POST /api/chat 启动 SSE 对话：
 *   - 输入验证（缺失 text / 空字符串 / 超长文本）
 *   - 前置检查（Agent 未就绪 / 已有进行中对话）
 *   - SSE 响应头（Content-Type / Cache-Control）
 *   - start 事件（含 messageId）
 *   - chunk 类型分发（text / recall / tool_start / tool_result / thinking / done / truncated / error / aborted）
 *   - 异常处理（throw AbortError / throw 其他错误）
 *   - 对话正常结束（end 事件）
 *   - 跨日重置（restoreSession 调用 / sessionManager 为 null）
 * - 路由未匹配（GET /api/chat / POST /api/chat/unknown）
 * - SSE 协议格式（事件块格式 / 响应头）
 *
 * Mock 策略：
 * - memora 模块：vi.mock logger + toError（用 vi.hoisted 声明可追踪的 mock 函数）
 * - sprite/constants.js：vi.mock getLocalDate 为固定日期（跨日逻辑测试稳定）
 * - IncomingMessage：自建 mock 对象，实现 method/url 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/write/end 调用 + writableEnded/headersSent
 * - HostContext：mock agent（agentHistory/sessionManager/agentLoop/chat/getMetrics）+ isAgentReady + getAbortController
 *
 * 风格参考：src/__tests__/web/routes/memoryRoutes.test.ts + src/__tests__/electron/ipc/chatHandlers.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentChunk } from 'memora';

// ─── Mock memora 模块（logger + toError） ─────────────────
// vi.mock 是 hoisted 的，用 vi.hoisted 声明可在 factory 内引用的变量
const { loggerWarn, loggerError } = vi.hoisted(() => ({
  /** logger.warn mock（超时兜底等业务拒绝场景使用） */
  loggerWarn: vi.fn(),
  /** logger.error mock（非用户中断的错误日志） */
  loggerError: vi.fn(),
}));
vi.mock('memora', () => ({
  logger: {
    warn: loggerWarn,
    error: loggerError,
    info: vi.fn(),
    debug: vi.fn(),
  },
  // toError：与真实实现一致，Error 原样返回，其他转字符串
  toError: vi.fn((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
}));

// ─── Mock getLocalDate 为固定日期（跨日逻辑测试稳定） ───
const { MOCK_TODAY } = vi.hoisted(() => ({ MOCK_TODAY: '2026-06-26' }));
vi.mock('../../../sprite/constants.js', () => ({
  getLocalDate: vi.fn(() => MOCK_TODAY),
}));

// 导入被测模块（在 vi.mock 之后，确保 mock 生效）
import { handleChatStreamRoute } from '../../../web/routes/chatStreamRoutes.js';
import type { HostContext } from '../../../shared/hostContext.js';

// ─── 测试辅助：Mock 响应对象状态 ───────────────────────────

/** Mock 响应对象内部捕获的状态 */
interface MockResState {
  /** 捕获的状态码 */
  statusCode: number;
  /** 捕获的响应头 */
  headers: Record<string, string | number>;
  /** 捕获的 JSON 响应体（end(data) 的 data，用于 sendJson/sendError） */
  body: string;
  /** 捕获的 SSE 流式文本（所有 write(data) 的累积，用于 SSE 事件断言） */
  written: string;
  /** headersSent 标志（writeHead 调用后置 true） */
  headersSent: boolean;
  /** writableEnded 标志（end 调用后置 true） */
  writableEnded: boolean;
  /** writeHead mock 函数 */
  writeHead: ReturnType<typeof vi.fn>;
  /** write mock 函数 */
  write: ReturnType<typeof vi.fn>;
  /** end mock 函数 */
  end: ReturnType<typeof vi.fn>;
}

/** Mock ServerResponse：捕获 writeHead/write/end 调用供断言 */
type MockServerResponse = ServerResponse & MockResState;

/**
 * 创建 mock ServerResponse
 *
 * 捕获 writeHead(status, headers) / write(data) / end(data?) 调用到内部 state。
 * - JSON 响应（sendJson/sendError）：通过 end(data) 写入 body，written 为空
 * - SSE 响应：通过 write(data) 累积到 written，end() 无 data
 * - headersSent：writeHead 后 true（safeRoute 据此决定是否兜底 500）
 * - writableEnded：end 后 true（被测代码据此决定是否发送 end 事件）
 *
 * @returns mock 响应对象
 */
function createMockRes(): MockServerResponse {
  /** mock 响应对象（属性可读可写，writeHead/write/end 通过闭包修改属性） */
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    written: '',
    headersSent: false,
    writableEnded: false,
  } as MockResState;

  // writeHead：设置状态码 + 合并头 + 标记 headersSent
  res.writeHead = vi.fn((status: number, headers?: Record<string, string | number>) => {
    res.statusCode = status;
    if (headers) Object.assign(res.headers, headers);
    res.headersSent = true;
  });

  // write：累积 SSE 文本到 written（兼容 string | Buffer）
  res.write = vi.fn((data: string | Buffer) => {
    res.written += typeof data === 'string' ? data : data.toString('utf-8');
  });

  // end：若有 data 写入 body（JSON 响应），标记响应结束
  res.end = vi.fn((data?: string | Buffer) => {
    if (data !== undefined) {
      res.body = typeof data === 'string' ? data : data.toString('utf-8');
    }
    res.writableEnded = true;
    res.headersSent = true;
  });

  return res as unknown as MockServerResponse;
}

/**
 * 创建 mock IncomingMessage（带可选 body）
 *
 * 实现 method/url 属性与 async iterator 接口，
 * 使 parseJsonBody 的 `for await (const chunk of req)` 能读取 body。
 *
 * @param method HTTP 方法
 * @param url 完整 URL（含 query string）
 * @param body 请求体对象（可选，POST 使用）
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
    /**
     * EventEmitter.on 桩实现（handleChatStart 注册 req 'close' 事件检测客户端断开）
     * 测试不模拟客户端断开场景，仅注册回调不触发，保持签名兼容
     */
    on: vi.fn(),
  } as unknown as IncomingMessage;
  return req;
}

// ─── Mock agent.chat AsyncGenerator ───────────────────────

/**
 * 创建 mock agent.chat AsyncGenerator 工厂
 *
 * 返回一个 vi.fn，每次调用产生新的 async generator，
 * 按顺序 yield 预设的 chunks，可选在末尾 throw 错误。
 *
 * @param chunks 预设的 AgentChunk 数组（按顺序 yield）
 * @param error 可选的抛出错误（yield 完所有 chunk 后 throw）
 * @returns vi.fn mock 函数，调用返回 AsyncGenerator
 */
function makeChatMock(chunks: AgentChunk[], error?: Error): ReturnType<typeof vi.fn> {
  return vi.fn((_text: string, _signal?: AbortSignal) => {
    async function* gen(): AsyncGenerator<AgentChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (error) throw error;
    }
    return gen();
  });
}

// ─── Mock HostContext ─────────────────────────────────────

/**
 * 创建 mock HostContext
 *
 * 默认值：Agent 就绪 / 无进行中对话 / 非跨日 / chat 返回空 generator。
 * 通过 overrides 覆盖各字段以测试不同场景。
 *
 * @param overrides 可选的覆盖项
 * @returns mock HostContext
 */
function createMockCtx(overrides?: {
  /** isAgentReady mock（默认 () => true） */
  isAgentReady?: ReturnType<typeof vi.fn>;
  /** getAbortController mock（默认 () => null）；支持序列 mock 用于 throw 场景 */
  getAbortController?: ReturnType<typeof vi.fn>;
  /** setAbortController mock（默认 vi.fn()） */
  setAbortController?: ReturnType<typeof vi.fn>;
  /** agent.chat yield 的 chunks（默认 []） */
  chatChunks?: AgentChunk[];
  /** agent.chat throw 的错误（默认 undefined，不 throw） */
  chatError?: Error;
  /** agentHistory（默认 { currentDateValue: MOCK_TODAY }，非跨日） */
  agentHistory?: { currentDateValue: string } | null;
  /** sessionManager（默认 { restoreSession: () => 0 }） */
  sessionManager?: { restoreSession: ReturnType<typeof vi.fn> } | null;
  /** agentLoop（默认 { restoreHistory: vi.fn() }） */
  agentLoop?: { restoreHistory: ReturnType<typeof vi.fn> } | null;
  /** 对话开始前的截断次数（默认 0） */
  truncationBefore?: number;
  /** done 时的截断次数（默认 0；设置大于 truncationBefore 触发 truncated 事件） */
  truncationAfter?: number;
}): HostContext {
  // 构建 getMetrics mock：若提供 truncationAfter 则用序列 mock（开始前 + done 时）
  let getMetrics: ReturnType<typeof vi.fn>;
  if (overrides?.truncationAfter !== undefined) {
    // 序列：第一次返回 truncationBefore，第二次返回 truncationAfter，后续返回 truncationAfter
    getMetrics = vi
      .fn()
      .mockReturnValueOnce({ context: { truncationCount: overrides.truncationBefore ?? 0 } })
      .mockReturnValueOnce({ context: { truncationCount: overrides.truncationAfter } })
      .mockReturnValue({ context: { truncationCount: overrides.truncationAfter } });
  } else {
    // 固定返回 truncationBefore（默认 0）
    getMetrics = vi.fn(() => ({
      context: { truncationCount: overrides?.truncationBefore ?? 0 },
    }));
  }

  // 构建 mock agent
  // 注意：agentHistory/sessionManager/agentLoop 可能为 null（测试未初始化场景），
  // 不能用 ??（null ?? default 会返回 default），需用 in 操作符检查属性是否存在
  const hasAgentHistory = overrides && 'agentHistory' in overrides;
  const hasSessionManager = overrides && 'sessionManager' in overrides;
  const hasAgentLoop = overrides && 'agentLoop' in overrides;
  const agent = {
    agentHistory: hasAgentHistory ? overrides!.agentHistory : { currentDateValue: MOCK_TODAY },
    sessionManager: hasSessionManager
      ? overrides!.sessionManager
      : { restoreSession: vi.fn().mockResolvedValue(0), switchSession: vi.fn() },
    agentLoop: hasAgentLoop ? overrides!.agentLoop : { restoreHistory: vi.fn() },
    chat: makeChatMock(overrides?.chatChunks ?? [], overrides?.chatError),
    getMetrics,
  } as unknown as HostContext['agent'];

  return {
    agent,
    // 缺口 A/I：chatStreamHandler 调用 sprite.incrementDailyMessageCount() + prepareForChat()，mock 需提供方法
    sprite: { incrementDailyMessageCount: vi.fn(), prepareForChat: vi.fn() } as unknown as HostContext['sprite'],
    sessionStore: {} as HostContext['sessionStore'],
    getAbortController: overrides?.getAbortController ?? vi.fn(() => null),
    setAbortController: overrides?.setAbortController ?? vi.fn(),
    isAgentReady: overrides?.isAgentReady ?? vi.fn(() => true),
  };
}

// ─── SSE 事件解析辅助 ─────────────────────────────────────

/** 解析后的 SSE 事件结构 */
interface SSEEvent {
  /** 事件名（如 start / chunk / end） */
  event: string;
  /** 事件数据（已 JSON.parse） */
  data: unknown;
}

/**
 * 从 SSE 流文本解析事件列表
 *
 * SSE 协议：每个事件块以 `event: xxx\ndata: {json}\n\n` 格式传输，
 * 事件块之间以 `\n\n` 分隔。
 *
 * @param written res.written 累积的 SSE 文本
 * @returns 解析后的事件数组
 */
function parseSSEEvents(written: string): SSEEvent[] {
  return written
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      const eventName = eventLine?.slice('event: '.length) ?? '';
      const dataStr = dataLine?.slice('data: '.length) ?? '';
      return { event: eventName, data: JSON.parse(dataStr) as unknown };
    });
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('handleChatStreamRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /api/chat/abort ──────────────────────────────

  describe('POST /api/chat/abort', () => {
    it('有进行中的对话时应调用 ctrl.abort 并响应 200', async () => {
      // 准备一个真实的 AbortController，spy abort 方法
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => abortController),
      });
      const req = createMockReq('POST', '/api/chat/abort');
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      // 验证 abort 被调用，且 reason 是 AbortError DOMException
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(abortController.signal.aborted).toBe(true);
      const reason = abortController.signal.reason;
      expect(reason).toBeInstanceOf(DOMException);
      expect((reason as DOMException).name).toBe('AbortError');
      // 响应 200 + { aborted: true }
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ aborted: true });
    });

    it('无进行中的对话时不应抛错并响应 200 + {aborted: true}', async () => {
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => null),
      });
      const req = createMockReq('POST', '/api/chat/abort');
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      // 无 ctrl 时不抛错，仍返回 200 + { aborted: true }
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ aborted: true });
    });
  });

  // ─── POST /api/chat 输入验证 ───────────────────────────

  describe('POST /api/chat 输入验证', () => {
    it('请求体缺失 text 字段时应返回 400', async () => {
      const ctx = createMockCtx();
      // body 不含 text 字段
      const req = createMockReq('POST', '/api/chat', { foo: 'bar' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('text');
      // 输入校验失败不应启动 SSE 流
      expect(ctx.setAbortController).not.toHaveBeenCalled();
    });

    it('text 为空字符串时应返回 400', async () => {
      const ctx = createMockCtx();
      const req = createMockReq('POST', '/api/chat', { text: '' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('text');
    });

    it('text 过长（>100KB）时应返回 400', async () => {
      const ctx = createMockCtx();
      // 构造长度 100001 的文本（超过 100000 限制）
      const longText = 'a'.repeat(100_001);
      const req = createMockReq('POST', '/api/chat', { text: longText });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toContain('过长');
    });
  });

  // ─── POST /api/chat 前置检查 ───────────────────────────

  describe('POST /api/chat 前置检查', () => {
    it('Agent 未就绪时应返回 503', async () => {
      const ctx = createMockCtx({
        isAgentReady: vi.fn(() => false),
      });
      const req = createMockReq('POST', '/api/chat', { text: '你好' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
      // 未就绪不应启动 SSE 流
      expect(ctx.setAbortController).not.toHaveBeenCalled();
    });

    it('已有进行中对话时应返回 409', async () => {
      // 模拟已有进行中对话：getAbortController 返回一个 ctrl
      const ctx = createMockCtx({
        getAbortController: vi.fn(() => new AbortController()),
      });
      const req = createMockReq('POST', '/api/chat', { text: '你好' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toContain('处理中');
      // 竞态保护不应启动 SSE 流
      expect(ctx.setAbortController).not.toHaveBeenCalled();
    });
  });

  // ─── POST /api/chat SSE 流式对话 ───────────────────────

  describe('POST /api/chat SSE 流式对话', () => {
    it('正常启动应设置 Content-Type: text/event-stream 响应头', async () => {
      const ctx = createMockCtx({ chatChunks: [{ type: 'done' }] });
      const req = createMockReq('POST', '/api/chat', { text: '你好' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(200);
      expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    });

    it('正常启动应发送 start 事件（含 messageId）', async () => {
      const ctx = createMockCtx({ chatChunks: [{ type: 'done' }] });
      const req = createMockReq('POST', '/api/chat', { text: '你好' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const startEvent = events.find((e) => e.event === 'start');
      expect(startEvent).toBeDefined();
      // messageId 应为非空字符串（randomUUID 生成）
      const messageId = (startEvent!.data as { messageId: string }).messageId;
      expect(typeof messageId).toBe('string');
      expect(messageId.length).toBeGreaterThan(0);
    });

    it('agent.chat yield text chunk 应发送 chunk 事件（累积完整文本）', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'text', content: '你好' },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const chunkEvents = events.filter((e) => e.event === 'chunk');
      expect(chunkEvents).toHaveLength(1);
      // chunk 事件的 text 应为累积完整文本
      expect((chunkEvents[0]!.data as { text: string }).text).toBe('你好');
    });

    it('agent.chat yield 多个 text chunk 应逐步累积', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'text', content: '你好' },
          { type: 'text', content: '，世界' },
          { type: 'text', content: '！' },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const chunkEvents = events.filter((e) => e.event === 'chunk');
      // 应有 3 个 chunk 事件，文本逐步累积
      expect(chunkEvents).toHaveLength(3);
      expect((chunkEvents[0]!.data as { text: string }).text).toBe('你好');
      expect((chunkEvents[1]!.data as { text: string }).text).toBe('你好，世界');
      expect((chunkEvents[2]!.data as { text: string }).text).toBe('你好，世界！');
    });

    it('agent.chat yield recall chunk 应发送 recall 事件', async () => {
      const memories = [
        { id: 'insight:1', name: '记忆1', score: 0.95, source: 'insight' },
      ];
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'recall', memories },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const recallEvent = events.find((e) => e.event === 'recall');
      expect(recallEvent).toBeDefined();
      expect((recallEvent!.data as { memories: typeof memories }).memories).toEqual(memories);
    });

    it('agent.chat yield tool_start chunk 应发送 tool_start 事件', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'tool_start', toolCallId: 'tc-1', name: 'search', args: '{"q":"test"}' },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const toolStartEvent = events.find((e) => e.event === 'tool_start');
      expect(toolStartEvent).toBeDefined();
      const data = toolStartEvent!.data as {
        toolCallId: string;
        name: string;
        args: string;
      };
      expect(data.toolCallId).toBe('tc-1');
      expect(data.name).toBe('search');
      expect(data.args).toBe('{"q":"test"}');
    });

    it('agent.chat yield tool_result chunk 应发送 tool_result 事件', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'tool_result', toolCallId: 'tc-1', name: 'search', ok: true, summary: '找到3条' },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      const toolResultEvent = events.find((e) => e.event === 'tool_result');
      expect(toolResultEvent).toBeDefined();
      const data = toolResultEvent!.data as {
        toolCallId: string;
        name: string;
        ok: boolean;
        summary: string;
      };
      expect(data.toolCallId).toBe('tc-1');
      expect(data.name).toBe('search');
      expect(data.ok).toBe(true);
      expect(data.summary).toBe('找到3条');
    });

    it('agent.chat yield thinking chunk 应发送 thinking 事件', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'thinking', phase: 'recalling' },
          { type: 'done' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // thinking 事件可能出现多次（recall 阶段 + done 后的 archiving keepalive）
      const thinkingEvents = events.filter((e) => e.event === 'thinking');
      // 第一个 thinking 事件应为 recalling 阶段
      const recallingEvent = thinkingEvents.find(
        (e) => (e.data as { phase: string }).phase === 'recalling',
      );
      expect(recallingEvent).toBeDefined();
    });

    it('agent.chat yield done chunk 应发送 thinking(archiving) 事件（无截断）', async () => {
      const ctx = createMockCtx({
        chatChunks: [{ type: 'done' }],
        // 截断次数不变，不应发送 truncated 事件
        truncationBefore: 0,
        truncationAfter: 0,
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // done 后应发送 thinking(archiving) keepalive
      const archivingEvent = events.find(
        (e) => e.event === 'thinking' && (e.data as { phase: string }).phase === 'archiving',
      );
      expect(archivingEvent).toBeDefined();
      // 截断次数未增加，不应有 truncated 事件
      const truncatedEvent = events.find((e) => e.event === 'truncated');
      expect(truncatedEvent).toBeUndefined();
    });

    it('agent.chat yield done chunk 且 truncationCount 增加应发送 truncated 事件', async () => {
      const ctx = createMockCtx({
        chatChunks: [{ type: 'done' }],
        // 截断次数从 0 增加到 3
        truncationBefore: 0,
        truncationAfter: 3,
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // 应发送 truncated 事件，count = 3
      const truncatedEvent = events.find((e) => e.event === 'truncated');
      expect(truncatedEvent).toBeDefined();
      expect((truncatedEvent!.data as { count: number }).count).toBe(3);
      // 同时仍应发送 thinking(archiving) keepalive
      const archivingEvent = events.find(
        (e) => e.event === 'thinking' && (e.data as { phase: string }).phase === 'archiving',
      );
      expect(archivingEvent).toBeDefined();
    });

    it('agent.chat yield error chunk 应发送 aborted 事件并 break', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'text', content: '部分输出' },
          { type: 'error', message: 'LLM 连接断开' },
          // error 后 break，此 chunk 不应被处理
          { type: 'text', content: '不应到达' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // 应发送 aborted 事件，reason 为 error chunk 的 message
      const abortedEvent = events.find((e) => e.event === 'aborted');
      expect(abortedEvent).toBeDefined();
      expect((abortedEvent!.data as { reason: string }).reason).toBe('LLM 连接断开');
      // error chunk 后 break，第二个 text chunk 不应产生 chunk 事件
      const chunkEvents = events.filter((e) => e.event === 'chunk');
      expect(chunkEvents).toHaveLength(1);
      expect((chunkEvents[0]!.data as { text: string }).text).toBe('部分输出');
    });

    it('agent.chat yield aborted chunk 应发送 aborted 事件并 break', async () => {
      const ctx = createMockCtx({
        chatChunks: [
          { type: 'aborted', reason: '内核主动中断' },
          // aborted 后 break，此 chunk 不应被处理
          { type: 'text', content: '不应到达' },
        ],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // 应发送 aborted 事件，reason 为 aborted chunk 的 reason
      const abortedEvent = events.find((e) => e.event === 'aborted');
      expect(abortedEvent).toBeDefined();
      expect((abortedEvent!.data as { reason: string }).reason).toBe('内核主动中断');
      // aborted chunk 后 break，text chunk 不应产生 chunk 事件
      const chunkEvents = events.filter((e) => e.event === 'chunk');
      expect(chunkEvents).toHaveLength(0);
    });

    it('对话正常结束应发送 end 事件', async () => {
      const ctx = createMockCtx({ chatChunks: [{ type: 'done' }] });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // finally 块应发送 end 事件
      const endEvent = events.find((e) => e.event === 'end');
      expect(endEvent).toBeDefined();
      // end 事件应在最后
      expect(events[events.length - 1]!.event).toBe('end');
      // 响应应已结束
      expect(res.writableEnded).toBe(true);
      // finally 应清理 AbortController（设为 null）
      expect(ctx.setAbortController).toHaveBeenLastCalledWith(null);
    });

    it('agent.chat throw AbortError（用户中断）应发送 aborted 事件', async () => {
      // 构造已 abort 的 ctrl（reason 为 AbortError DOMException），模拟用户中断
      const userAbortCtrl = new AbortController();
      userAbortCtrl.abort(new DOMException('用户手动停止', 'AbortError'));
      // getAbortController 序列 mock：
      //   第一次（前置检查）返回 null（无进行中对话）
      //   第二次（catch 块）返回已 abort 的 ctrl（判定为用户中断）
      const ctx = createMockCtx({
        chatChunks: [],
        chatError: new Error('generator 被 abort'),
        getAbortController: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(userAbortCtrl),
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // 用户中断应发送 aborted 事件，reason 为"用户手动停止"
      const abortedEvent = events.find((e) => e.event === 'aborted');
      expect(abortedEvent).toBeDefined();
      expect((abortedEvent!.data as { reason: string }).reason).toBe('用户手动停止');
      // 用户中断不应记录为 error 事件
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeUndefined();
      // 仍应发送 end 事件（finally 块）
      const endEvent = events.find((e) => e.event === 'end');
      expect(endEvent).toBeDefined();
    });

    it('agent.chat throw 其他错误应发送 error 事件', async () => {
      // getAbortController 序列 mock：
      //   第一次（前置检查）返回 null
      //   第二次（catch 块）返回 null（非用户中断）
      const ctx = createMockCtx({
        chatChunks: [],
        chatError: new Error('LLM 服务不可用'),
        getAbortController: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(null),
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      const events = parseSSEEvents(res.written);
      // 非用户中断应发送 error 事件
      const errorEvent = events.find((e) => e.event === 'error');
      expect(errorEvent).toBeDefined();
      // SEC-WEB-02：非网络错误返回通用友好消息，不回传原始 error.message
      expect((errorEvent!.data as { message: string }).message).toBe('对话出错，请重试');
      // 非用户中断不应发送 aborted 事件
      const abortedEvent = events.find((e) => e.event === 'aborted');
      expect(abortedEvent).toBeUndefined();
      // 仍应发送 end 事件（finally 块）
      const endEvent = events.find((e) => e.event === 'end');
      expect(endEvent).toBeDefined();
    });
  });

  // ─── 跨日重置 ──────────────────────────────────────────

  describe('跨日重置', () => {
    it('history.currentDateValue !== today 应调用 sessionManager.restoreSession', async () => {
      const restoreSession = vi.fn().mockResolvedValue(2); // 恢复 2 条消息
      const restoreHistory = vi.fn();
      const ctx = createMockCtx({
        // 跨日：Agent 记录的日期是昨天，mock getLocalDate 返回今天
        agentHistory: { currentDateValue: '2026-06-25' },
        sessionManager: { restoreSession, switchSession: vi.fn() },
        agentLoop: { restoreHistory },
        chatChunks: [{ type: 'done' }],
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      // 应调用 restoreSession 重置到当天 main 会话
      expect(restoreSession).toHaveBeenCalledWith(MOCK_TODAY, 'main');
      // 恢复 2 条消息（restoredCount > 0），不应调用 restoreHistory([])
      expect(restoreHistory).not.toHaveBeenCalledWith([]);
      // 对话应正常启动（SSE 响应）
      expect(res.statusCode).toBe(200);
    });

    it('sessionManager 为 null 应返回 503', async () => {
      const ctx = createMockCtx({
        agentHistory: { currentDateValue: '2026-06-25' }, // 跨日
        sessionManager: null, // sessionManager 未初始化
      });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toContain('会话管理器未初始化');
      // 不应启动 SSE 流
      expect(ctx.setAbortController).not.toHaveBeenCalled();
    });
  });

  // ─── 路由未匹配 ────────────────────────────────────────

  describe('路由未匹配', () => {
    it('GET /api/chat 应返回 404', async () => {
      const ctx = createMockCtx();
      const req = createMockReq('GET', '/api/chat');
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(404);
      // SEC-WEB-05：404 不回显 path，返回固定文案
      expect(JSON.parse(res.body).error).toBe('404 Not Found');
    });

    it('POST /api/chat/unknown 应返回 404', async () => {
      const ctx = createMockCtx();
      const req = createMockReq('POST', '/api/chat/unknown', {});
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.statusCode).toBe(404);
      // SEC-WEB-05：404 不回显 path，返回固定文案
      expect(JSON.parse(res.body).error).toBe('404 Not Found');
    });
  });

  // ─── SSE 协议格式 ──────────────────────────────────────

  describe('SSE 协议格式', () => {
    it('每个 SSE 事件格式应正确（event: xxx\\ndata: {json}\\n\\n）', async () => {
      const ctx = createMockCtx({ chatChunks: [{ type: 'done' }] });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      // 验证原始 SSE 文本格式：每个事件块含 event: 和 data: 行，以 \n\n 分隔
      const blocks = res.written.split('\n\n').filter((b) => b.trim().length > 0);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const lines = block.split('\n');
        // 每个事件块应含 event: 行
        expect(lines.some((l) => l.startsWith('event: '))).toBe(true);
        // 每个事件块应含 data: 行（JSON 格式）
        const dataLine = lines.find((l) => l.startsWith('data: '));
        expect(dataLine).toBeDefined();
        // data: 后的内容应为合法 JSON
        const jsonStr = dataLine!.slice('data: '.length);
        expect(() => JSON.parse(jsonStr)).not.toThrow();
      }
    });

    it('响应头应包含 Cache-Control: no-cache, no-transform', async () => {
      const ctx = createMockCtx({ chatChunks: [{ type: 'done' }] });
      const req = createMockReq('POST', '/api/chat', { text: '测试' });
      const res = createMockRes();

      await handleChatStreamRoute(req, res, ctx);

      expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
      // 同时验证其他 SSE 必需头
      expect(res.headers['Connection']).toBe('keep-alive');
      expect(res.headers['X-Accel-Buffering']).toBe('no');
    });
  });
});
