/**
 * @vitest-environment jsdom
 *
 * Web 版 preload 接口契约测试
 *
 * 覆盖范围：
 * - webElectronAPI 各方法正确调用 fetch 并返回 Promise
 *   - 对话：sendUserInput / abortChat / loadSession / listSessions / switchSession /
 *           deleteSession / renameSession / forkSession
 *   - 流式监听：onStreamStart / onStreamChunk / onStreamEnd / onStreamRecall /
 *              onStreamToolStart / onStreamToolResult / onStreamThinking /
 *              onContextTruncated / onStreamAborted / removeStreamListeners
 *   - Agent 状态：getAgentStatus / onAgentReady（轮询就绪/立即就绪/超时/失败降级） /
 *                removeAgentReadyListener
 *   - LLM 配置：getLlmConfig / saveLlmConfig / testLlmConfig
 *   - 多 Provider 管理：listLlmProviders / saveLlmProvider / deleteLlmProvider /
 *                       setActiveLlmProvider
 *   - 记忆：listMemories / searchMemories / showMemory / deleteMemory / addMemory /
 *           deleteMemoriesBatch / getRelationGraph / addRelation / removeRelation /
 *           updateRelation / getHealthDashboard / getReviewData /
 *           restoreMemory / purgeMemory / listDeletedMemories（回收站）
 *   - 配置：getConfig / updateConfig / updateConfigBatch
 *   - 角色：listPersonas / switchPersona / setPersonaMode / getPersonaMode
 *   - 项目：listProjects / 仪表盘：getDashboard / 感知：getPerceptionSnapshot
 * - SSE 流式接收（startSseStream + parseSseEvent）：
 *   - 正常事件分发（start/chunk/end/recall/tool_start/tool_result/thinking/truncated/aborted/error）
 *   - 未知事件忽略
 *   - 跨 chunk 缓冲区解析
 *   - HTTP 错误响应（非 2xx）
 *   - response.body 为 null
 *   - 网络错误
 *   - abort 错误（DOMException AbortError）
 *   - 防御性 abort 旧流（sendUserInput 重复调用）
 * - parseJsonResponse 错误分支：
 *   - 非 2xx 带 error 字段
 *   - 非 2xx 无 error 字段
 *   - 非 2xx 非 JSON 响应体
 * - 原生能力降级（windowMinimize / windowClose / clipboardAnalyze 等）→ noop 或返回 false
 * - notifyThemeChanged 写入 localStorage
 * - rendererLog 调用 console.error
 * - injectWebElectronAPI 在 window 存在时注入 / 不存在时不抛错 / DOM 初始化分支
 * - initWebModeUi：body.web-mode class / 隐藏 titlebar-controls / 禁用拖拽 / 侧边栏品牌点击 /
 *                  MutationObserver 监听后续 DOM 变化
 *
 * Mock 策略：
 * - global.fetch：vi.stubGlobal 捕获调用参数（含 SSE 流式响应 mock）
 * - global.localStorage：vi.stubGlobal 捕获 setItem 调用
 * - global.console：vi.spyOn 捕获 error 调用
 * - ReadableStream + TextEncoder：构造 SSE 流式响应体（Node.js 全局提供，jsdom 保留）
 * - vi.useFakeTimers：控制 onAgentReady 轮询定时器
 *
 * 注意：preloadWeb.ts 在模块加载时会执行 `if (typeof window !== 'undefined') injectWebElectronAPI()`，
 * jsdom 环境下 window 已定义，会自动注入 electronAPI 并调用 initWebModeUi。
 * 这意味着模块导入后 window.electronAPI 已是 webElectronAPI，document.body 已有 web-mode class。
 * 测试中清理 DOM 后可重复调用 injectWebElectronAPI() 测试 DOM 适配逻辑。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 导入被测模块（jsdom 环境下 window 已定义，自动注入会执行）
import { webElectronAPI, injectWebElectronAPI } from '../../web/preloadWeb.js';

// ─── 测试辅助：fetch mock 工厂 ─────────────────────────────

/**
 * 创建 fetch mock
 *
 * 返回 vi.fn，默认 resolve 为模拟标准 Response 对象（含 ok/status/json）。
 * parseJsonResponse 检查 response.ok 判断请求成败，mock 必须提供该属性，
 * 否则会走错误分支抛出 "HTTP undefined"。
 * 测试可通过 fetchMock.mockResolvedValueOnce 覆盖单次返回值。
 *
 * @returns fetch mock 函数
 */
function createFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }));
}

/**
 * 创建 SSE 流式响应 mock
 *
 * 用 ReadableStream 包装 SSE 事件块数组，模拟服务端 SSE 流。
 * startSseStream 通过 response.body.getReader() 读取流，TextDecoder 解码，
 * 按 '\n\n' 切分事件块后调用 parseSseEvent 解析。
 *
 * @param events SSE 事件块数组（每个元素是一个完整事件块，含尾部 \n\n）
 * @param options.ok 响应是否成功（默认 true）
 * @param options.status HTTP 状态码（默认 200）
 * @returns 模拟的 Response 对象
 */
function createSseResponse(
  events: string[],
  options: { ok?: boolean; status?: number } = {},
): Response {
  const { ok = true, status = 200 } = options;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return {
    ok,
    status,
    body: stream,
    text: async () => events.join(''),
  } as Response;
}

/**
 * 创建不结束的 SSE 流式响应 mock（模拟持续接收的活跃流）
 *
 * 用于测试 sendUserInput 防御性 abort 旧流的场景：
 * 旧流未结束时用户发送新消息，应先 abort 旧流。
 *
 * @returns 模拟的 Response 对象 + controller 引用（用于手动关闭）
 */
function createPendingSseResponse(): { response: Response; close: () => void } {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      // 不 close，模拟持续接收
    },
  });
  return {
    response: { ok: true, status: 200, body: stream } as Response,
    close: () => controllerRef?.close(),
  };
}

/**
 * 创建错误响应 mock（非 2xx）
 *
 * parseJsonResponse 在非 2xx 时会尝试读取 response.json() 获取 error 字段，
 * 失败时降级为 response.statusText。
 *
 * @param status HTTP 状态码
 * @param errorBody 错误响应体（可选，{ error: string } 格式）
 * @param statusText 状态文本（可选，json 解析失败时使用）
 * @returns 模拟的 Response 对象
 */
function createErrorResponse(
  status: number,
  errorBody?: unknown,
  statusText?: string,
): Response {
  return {
    ok: false,
    status,
    statusText: statusText ?? `HTTP ${status}`,
    json: async () => {
      if (errorBody !== undefined) return errorBody;
      throw new SyntaxError('Not JSON');
    },
    text: async () => (errorBody !== undefined ? JSON.stringify(errorBody) : ''),
  } as Response;
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('webElectronAPI', () => {
  /** fetch mock 实例（每个测试用例前重置） */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    // 清理 DOM 状态（模块加载时已自动调用 initWebModeUi，body 已有 web-mode class）
    document.body.className = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    // 清理可能残留的流式监听器状态
    webElectronAPI.removeStreamListeners();
    webElectronAPI.removeSpriteErrorListener();
    webElectronAPI.removeAgentReadyListener();
  });

  // ─── 对话相关 ──────────────────────────────────────────

  describe('对话', () => {
    it('loadSession 应发起 GET /api/sessions/messages 请求', async () => {
      await webElectronAPI.loadSession({ date: '2024-01-01', session: 's1' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain('/api/sessions/messages');
      expect(url).toContain('date=2024-01-01');
      expect(url).toContain('session=s1');
    });

    it('loadSession 应支持 limit 和 offset 参数', async () => {
      await webElectronAPI.loadSession({ date: '2024-01-01', session: 's1', limit: 50, offset: 100 });

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toContain('limit=50');
      expect(url).toContain('offset=100');
    });

    it('loadSession 无参数时应只发起基础请求', async () => {
      await webElectronAPI.loadSession({});

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/sessions/messages?');
    });

    it('listSessions 应发起 GET /api/sessions 请求', async () => {
      await webElectronAPI.listSessions();

      expect(fetchMock).toHaveBeenCalledWith('/api/sessions');
    });

    it('switchSession 应发起 POST /api/sessions/switch 请求', async () => {
      const query = { date: '2024-01-01', session: 's1' };
      await webElectronAPI.switchSession(query);

      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
      });
    });

    it('deleteSession 应发起 DELETE /api/sessions/:id 请求', async () => {
      await webElectronAPI.deleteSession('session-1');

      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1', {
        method: 'DELETE',
        headers: undefined,
        body: undefined,
      });
    });

    it('deleteSession 应对特殊字符 ID 进行 URL 编码', async () => {
      await webElectronAPI.deleteSession('a/b c');

      const [url] = fetchMock.mock.calls[0]!;
      // encodeURIComponent('a/b c') === 'a%2Fb%20c'
      expect(url).toBe('/api/sessions/a%2Fb%20c');
    });

    it('renameSession 应发起 PUT /api/sessions/:id/rename 请求', async () => {
      await webElectronAPI.renameSession('session-1', '新名称');

      expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: '新名称' }),
      });
    });

    it('forkSession 无参数时应发起 POST /api/memories/fork 请求（空 body）', async () => {
      await webElectronAPI.forkSession();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    });

    it('forkSession 带参数时应发起 POST /api/memories/fork 请求（含 session）', async () => {
      await webElectronAPI.forkSession('target-session');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: 'target-session' }),
      });
    });
  });

  // ─── SSE 流式对话（sendUserInput + startSseStream） ────

  describe('SSE 流式对话', () => {
    it('sendUserInput 应启动 SSE 流并分发 start/chunk/end 事件', async () => {
      /** start 事件回调 */
      const startCb = vi.fn();
      /** chunk 事件回调 */
      const chunkCb = vi.fn();
      /** end 事件回调 */
      const endCb = vi.fn();

      webElectronAPI.onStreamStart(startCb);
      webElectronAPI.onStreamChunk(chunkCb);
      webElectronAPI.onStreamEnd(endCb);

      // mock fetch 返回 SSE 流（包含 start + chunk + end 三个事件）
      const sseEvents = [
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
        'event: chunk\ndata: {"messageId":"msg-1","text":"hello"}\n\n',
        'event: end\ndata: {"messageId":"msg-1"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test input');

      // 等待异步 SSE 流处理完成
      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalledWith({ messageId: 'msg-1' });
        expect(chunkCb).toHaveBeenCalledWith({ messageId: 'msg-1', text: 'hello' });
        expect(endCb).toHaveBeenCalledWith({ messageId: 'msg-1' });
      });
    });

    it('SSE 应正确分发 recall 事件', async () => {
      const recallCb = vi.fn();
      webElectronAPI.onStreamRecall(recallCb);

      const memories = [{ id: 'm1', name: '记忆1', score: 0.9, source: 'insight' }];
      const sseEvents = [
        `event: recall\ndata: ${JSON.stringify({ messageId: 'msg-1', memories })}\n\n`,
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(recallCb).toHaveBeenCalledWith({ messageId: 'msg-1', memories });
      });
    });

    it('SSE 应正确分发 tool_start 和 tool_result 事件', async () => {
      const toolStartCb = vi.fn();
      const toolResultCb = vi.fn();
      webElectronAPI.onStreamToolStart(toolStartCb);
      webElectronAPI.onStreamToolResult(toolResultCb);

      const sseEvents = [
        'event: tool_start\ndata: {"messageId":"msg-1","toolCallId":"tc-1","name":"search","args":"{\\"q\\":\\"test\\"}"}\n\n',
        'event: tool_result\ndata: {"messageId":"msg-1","toolCallId":"tc-1","name":"search","ok":true,"summary":"找到3条结果"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(toolStartCb).toHaveBeenCalledWith({
          messageId: 'msg-1',
          toolCallId: 'tc-1',
          name: 'search',
          args: '{"q":"test"}',
        });
        expect(toolResultCb).toHaveBeenCalledWith({
          messageId: 'msg-1',
          toolCallId: 'tc-1',
          name: 'search',
          ok: true,
          summary: '找到3条结果',
        });
      });
    });

    it('SSE 应正确分发 thinking 和 truncated 事件', async () => {
      const thinkingCb = vi.fn();
      const truncatedCb = vi.fn();
      webElectronAPI.onStreamThinking(thinkingCb);
      webElectronAPI.onContextTruncated(truncatedCb);

      const sseEvents = [
        'event: thinking\ndata: {"messageId":"msg-1","phase":"analyzing"}\n\n',
        'event: truncated\ndata: {"messageId":"msg-1","count":5}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(thinkingCb).toHaveBeenCalledWith({ messageId: 'msg-1', phase: 'analyzing' });
        expect(truncatedCb).toHaveBeenCalledWith({ messageId: 'msg-1', count: 5 });
      });
    });

    it('SSE 应正确分发 aborted 事件', async () => {
      const abortedCb = vi.fn();
      webElectronAPI.onStreamAborted(abortedCb);

      const sseEvents = [
        'event: aborted\ndata: {"messageId":"msg-1","reason":"用户手动停止"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(abortedCb).toHaveBeenCalledWith({ messageId: 'msg-1', reason: '用户手动停止' });
      });
    });

    it('SSE error 事件应转发到 onSpriteError 回调', async () => {
      const errorCb = vi.fn();
      const spriteErrorCb = vi.fn();
      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.onStreamEnd(() => {});
      webElectronAPI.onSpriteError(spriteErrorCb);

      const sseEvents = [
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
        'event: error\ndata: {"messageId":"msg-1","message":"LLM 调用失败"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(spriteErrorCb).toHaveBeenCalledWith({ text: 'LLM 调用失败' });
      });
    });

    it('SSE 未知事件名应被忽略（向前兼容）', async () => {
      const startCb = vi.fn();
      webElectronAPI.onStreamStart(startCb);

      const sseEvents = [
        'event: unknown_future_event\ndata: {"foo":"bar"}\n\n',
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalledWith({ messageId: 'msg-1' });
      });
    });

    it('SSE 默认事件名（无 event: 行）应为 message', async () => {
      // parseSseEvent 在没有 event: 行时使用默认事件名 'message'
      // message 不在 switch case 中，走 default 分支被忽略
      const startCb = vi.fn();
      webElectronAPI.onStreamStart(startCb);

      const sseEvents = [
        'data: {"foo":"bar"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      // 等待足够时间确保流处理完成
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
      });
      // start 回调不应被调用（message 事件走 default 分支）
      expect(startCb).not.toHaveBeenCalled();
    });

    it('SSE 应支持跨 chunk 的事件解析（缓冲区）', async () => {
      // 将一个完整事件拆成多个 chunk，验证缓冲区正确拼接
      const chunkCb = vi.fn();
      webElectronAPI.onStreamChunk(chunkCb);

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 第一个 chunk：半个事件（不完整）
          controller.enqueue(encoder.encode('event: chunk\ndata: {"messageId":"msg-1"'));
          // 第二个 chunk：事件后半部分 + 尾部 \n\n
          controller.enqueue(encoder.encode(',"text":"hi"}\n\n'));
          controller.close();
        },
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: stream,
      } as Response);

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(chunkCb).toHaveBeenCalledWith({ messageId: 'msg-1', text: 'hi' });
      });
    });

    it('parseSseEvent 无 data 行时应返回 null（忽略）', async () => {
      const startCb = vi.fn();
      webElectronAPI.onStreamStart(startCb);

      // 事件块只有 event 行没有 data 行 → parseSseEvent 返回 null
      const sseEvents = [
        'event: start\n\n',
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalledTimes(1);
        expect(startCb).toHaveBeenCalledWith({ messageId: 'msg-1' });
      });
    });

    it('parseSseEvent data JSON 解析失败时应返回 null', async () => {
      const startCb = vi.fn();
      webElectronAPI.onStreamStart(startCb);

      // data 不是合法 JSON → parseSseEvent catch 返回 null
      const sseEvents = [
        'event: start\ndata: {invalid json}\n\n',
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
      ];
      fetchMock.mockResolvedValueOnce(createSseResponse(sseEvents));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalledTimes(1);
        expect(startCb).toHaveBeenCalledWith({ messageId: 'msg-1' });
      });
    });

    it('HTTP 非 2xx 响应应通知 error 和 spriteError 回调', async () => {
      const errorCb = vi.fn();
      const spriteErrorCb = vi.fn();
      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.onSpriteError(spriteErrorCb);

      // mock fetch 返回 503 错误响应
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: null,
        text: async () => 'Service Unavailable',
      } as Response);

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(spriteErrorCb).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('对话请求失败') }),
        );
      });
    });

    it('response.body 为 null 时应通知 error 回调', async () => {
      const spriteErrorCb = vi.fn();
      webElectronAPI.onSpriteError(spriteErrorCb);

      // ok=true 但 body=null → 走 !response.body 分支
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
        text: async () => '',
      } as Response);

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(spriteErrorCb).toHaveBeenCalledWith(
          expect.objectContaining({ text: expect.stringContaining('对话请求失败') }),
        );
      });
    });

    it('fetch 网络错误应通知 error 和 spriteError 回调', async () => {
      const spriteErrorCb = vi.fn();
      webElectronAPI.onSpriteError(spriteErrorCb);

      // mock fetch 抛出网络错误
      fetchMock.mockRejectedValueOnce(new Error('network error'));

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(spriteErrorCb).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('SSE 流式接收失败'),
          }),
        );
      });
    });

    it('fetch abort 错误应通知 aborted 回调（用户手动停止）', async () => {
      const abortedCb = vi.fn();
      webElectronAPI.onStreamAborted(abortedCb);

      // mock fetch 抛出 AbortError（DOMException）
      const abortError = new DOMException('The user aborted a request.', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortError);

      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(abortedCb).toHaveBeenCalledWith(
          expect.objectContaining({ reason: '用户手动停止' }),
        );
      });
    });

    it('sendUserInput 在已有活跃 SSE 流时应先 abort 旧流并发送 abort 请求', async () => {
      // 第一次：启动一个不结束的活跃流
      const pendingResponse = createPendingSseResponse();
      fetchMock
        .mockResolvedValueOnce(pendingResponse.response) // 第一次 /api/chat
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) }) // /api/chat/abort 响应
        .mockResolvedValueOnce(createSseResponse([])); // 第二次 /api/chat（空流立即结束）

      webElectronAPI.onStreamStart(() => {});

      // 发送第一条消息（启动活跃流）
      webElectronAPI.sendUserInput('first');
      // 等待第一次 fetch 完成
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // 发送第二条消息（应触发 abort 旧流）
      webElectronAPI.sendUserInput('second');

      // 验证 /api/chat/abort 请求被发送
      await vi.waitFor(() => {
        const abortCall = fetchMock.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0] === '/api/chat/abort',
        );
        expect(abortCall).toBeDefined();
      });
    });

    it('abortChat 应中断活跃 SSE 流并发送 abort 请求', async () => {
      // 先启动一个活跃流
      const pendingResponse = createPendingSseResponse();
      fetchMock
        .mockResolvedValueOnce(pendingResponse.response) // /api/chat
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) }); // /api/chat/abort

      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.sendUserInput('test');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // 调用 abortChat
      await webElectronAPI.abortChat();

      // 验证 abort 请求被发送
      const abortCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0] === '/api/chat/abort',
      );
      expect(abortCall).toBeDefined();
    });

    it('abortChat 无活跃 SSE 流时只发送 abort 请求', async () => {
      // 无活跃流，直接调用 abortChat
      await webElectronAPI.abortChat();

      expect(fetchMock).toHaveBeenCalledWith('/api/chat/abort', expect.objectContaining({ method: 'POST' }));
    });

    it('removeStreamListeners 应中断活跃 SSE 流并清空回调', async () => {
      // 先启动一个活跃流
      const pendingResponse = createPendingSseResponse();
      fetchMock.mockResolvedValueOnce(pendingResponse.response);

      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.sendUserInput('test');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // 调用 removeStreamListeners（应中断活跃流）
      webElectronAPI.removeStreamListeners();

      // 验证：removeStreamListeners 不抛错，且后续 sendUserInput 不触发旧回调
      const startCb = vi.fn();
      webElectronAPI.onStreamStart(startCb);
      fetchMock.mockResolvedValueOnce(createSseResponse([
        'event: start\ndata: {"messageId":"msg-2"}\n\n',
      ]));
      webElectronAPI.sendUserInput('second');

      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalledWith({ messageId: 'msg-2' });
      });
    });

    it('onStream* 方法应注册回调到监听器注册表', async () => {
      // 验证所有 onStream* 方法都能正确注册回调
      const startCb = vi.fn();
      const chunkCb = vi.fn();
      const endCb = vi.fn();
      const recallCb = vi.fn();
      const toolStartCb = vi.fn();
      const toolResultCb = vi.fn();
      const thinkingCb = vi.fn();
      const truncatedCb = vi.fn();
      const abortedCb = vi.fn();

      webElectronAPI.onStreamStart(startCb);
      webElectronAPI.onStreamChunk(chunkCb);
      webElectronAPI.onStreamEnd(endCb);
      webElectronAPI.onStreamRecall(recallCb);
      webElectronAPI.onStreamToolStart(toolStartCb);
      webElectronAPI.onStreamToolResult(toolResultCb);
      webElectronAPI.onStreamThinking(thinkingCb);
      webElectronAPI.onContextTruncated(truncatedCb);
      webElectronAPI.onStreamAborted(abortedCb);

      // 一次性触发所有事件
      fetchMock.mockResolvedValueOnce(createSseResponse([
        'event: start\ndata: {"messageId":"msg-1"}\n\n',
        'event: chunk\ndata: {"messageId":"msg-1","text":"hi"}\n\n',
        'event: recall\ndata: {"messageId":"msg-1","memories":[]}\n\n',
        'event: tool_start\ndata: {"messageId":"msg-1","toolCallId":"tc-1","name":"t"}\n\n',
        'event: tool_result\ndata: {"messageId":"msg-1","toolCallId":"tc-1","name":"t","ok":true}\n\n',
        'event: thinking\ndata: {"messageId":"msg-1","phase":"p"}\n\n',
        'event: truncated\ndata: {"messageId":"msg-1","count":1}\n\n',
        'event: end\ndata: {"messageId":"msg-1"}\n\n',
      ]));
      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(startCb).toHaveBeenCalled();
        expect(chunkCb).toHaveBeenCalled();
        expect(endCb).toHaveBeenCalled();
        expect(recallCb).toHaveBeenCalled();
        expect(toolStartCb).toHaveBeenCalled();
        expect(toolResultCb).toHaveBeenCalled();
        expect(thinkingCb).toHaveBeenCalled();
        expect(truncatedCb).toHaveBeenCalled();
      });
    });
  });

  // ─── Agent 状态 ────────────────────────────────────────

  describe('Agent 状态', () => {
    it('getAgentStatus 应发起 GET /api/agent-status 请求', async () => {
      await webElectronAPI.getAgentStatus();

      expect(fetchMock).toHaveBeenCalledWith('/api/agent-status');
    });

    it('onAgentReady 立即检查就绪时应同步调用回调', async () => {
      // mock getAgentStatus 返回 ready: true
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ready: true, error: null }),
      });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      // 等待微任务完成（立即检查路径）
      await vi.waitFor(() => {
        expect(cb).toHaveBeenCalledTimes(1);
      });
    });

    it('onAgentReady 未就绪时应启动轮询，就绪后调用回调', async () => {
      vi.useFakeTimers();

      // 立即检查：未就绪
      // 第1次轮询：未就绪
      // 第2次轮询：就绪
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: false, error: null }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: false, error: null }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: true, error: null }) });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      // 推进微任务（立即检查）
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).not.toHaveBeenCalled();

      // 推进到第1次轮询（1.5s）
      await vi.advanceTimersByTimeAsync(1500);
      expect(cb).not.toHaveBeenCalled();

      // 推进到第2次轮询（3s）→ 就绪
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(0);

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onAgentReady 立即检查失败时应降级为轮询', async () => {
      vi.useFakeTimers();

      // 立即检查：fetch 抛错（服务未启动）
      // 第1次轮询：就绪
      fetchMock
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: true, error: null }) });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      // 推进微任务（立即检查失败）
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).not.toHaveBeenCalled();

      // 推进到第1次轮询（1.5s）→ 就绪
      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(0);

      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onAgentReady 轮询失败时应继续下一轮轮询', async () => {
      vi.useFakeTimers();

      // 立即检查：未就绪
      // 第1次轮询：fetch 抛错
      // 第2次轮询：就绪
      fetchMock
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: false, error: null }) })
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ready: true, error: null }) });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      expect(cb).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      await vi.advanceTimersByTimeAsync(0);
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('onAgentReady 轮询超过 20 次应停止轮询', async () => {
      vi.useFakeTimers();

      // 所有请求都返回未就绪
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ready: false, error: null }),
      });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      // 推进足够时间（21 次 × 1.5s = 31.5s）
      await vi.advanceTimersByTimeAsync(32000);

      // 回调不应被调用
      expect(cb).not.toHaveBeenCalled();
      // 验证轮询次数：立即检查 1 次 + 轮询 20 次 = 21 次
      expect(fetchMock).toHaveBeenCalledTimes(21);
    });

    it('removeAgentReadyListener 应取消轮询并清除回调', async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ready: false, error: null }),
      });

      const cb = vi.fn();
      webElectronAPI.onAgentReady(cb);

      // 推进微任务（立即检查）
      await vi.advanceTimersByTimeAsync(0);

      // 取消监听
      webElectronAPI.removeAgentReadyListener();

      // 推进时间，不应再触发轮询
      await vi.advanceTimersByTimeAsync(5000);

      // 回调不应被调用
      expect(cb).not.toHaveBeenCalled();
    });

    it('onAgentReady 重复调用应取消之前的轮询', async () => {
      vi.useFakeTimers();

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ready: false, error: null }),
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      webElectronAPI.onAgentReady(cb1);
      await vi.advanceTimersByTimeAsync(0);

      // 第二次调用应取消第一次的轮询
      webElectronAPI.onAgentReady(cb2);
      await vi.advanceTimersByTimeAsync(0);

      // 推进时间，cb1 不应被调用
      await vi.advanceTimersByTimeAsync(3000);

      expect(cb1).not.toHaveBeenCalled();
    });
  });

  // ─── LLM 配置 ──────────────────────────────────────────

  describe('LLM 配置', () => {
    it('getLlmConfig 应发起 GET /api/llm-config 请求', async () => {
      await webElectronAPI.getLlmConfig();

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-config');
    });

    it('saveLlmConfig 应发起 POST /api/llm-config 请求', async () => {
      const config = { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: 'sk-xxx', temperature: 0.7 };
      await webElectronAPI.saveLlmConfig(config);

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    });

    it('testLlmConfig 应发起 POST /api/llm-config/test 请求', async () => {
      const config = { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: 'sk-xxx' };
      await webElectronAPI.testLlmConfig(config);

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-config/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
    });
  });

  // ─── 多 Provider 管理 ──────────────────────────────────

  describe('多 Provider 管理', () => {
    it('listLlmProviders 应发起 GET /api/llm-providers 请求', async () => {
      await webElectronAPI.listLlmProviders();

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-providers');
    });

    it('saveLlmProvider 应发起 POST /api/llm-providers 请求（含 key 和 config）', async () => {
      const config = { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: 'sk-xxx', temperature: 0.7 };
      await webElectronAPI.saveLlmProvider('work', config);

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'work', config }),
      });
    });

    it('deleteLlmProvider 应发起 DELETE /api/llm-providers/:key 请求', async () => {
      await webElectronAPI.deleteLlmProvider('work');

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-providers/work', {
        method: 'DELETE',
        headers: undefined,
        body: undefined,
      });
    });

    it('deleteLlmProvider 应对特殊字符 key 进行 URL 编码', async () => {
      await webElectronAPI.deleteLlmProvider('a/b c');

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/llm-providers/a%2Fb%20c');
    });

    it('setActiveLlmProvider 应发起 POST /api/llm-providers/:key/active 请求', async () => {
      await webElectronAPI.setActiveLlmProvider('work');

      expect(fetchMock).toHaveBeenCalledWith('/api/llm-providers/work/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: undefined,
      });
    });
  });

  // ─── 记忆 ─────────────────────────────────────────────

  describe('记忆', () => {
    it('listMemories 无 source 应发起 GET /api/memories 请求', async () => {
      await webElectronAPI.listMemories();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories');
    });

    it('listMemories 带 source 应发起 GET /api/memories?source=... 请求', async () => {
      await webElectronAPI.listMemories({ source: 'profile' });

      expect(fetchMock).toHaveBeenCalledWith('/api/memories?source=profile');
    });

    it('listMemories 带特殊字符 source 应进行 URL 编码', async () => {
      await webElectronAPI.listMemories({ source: 'a&b=c' });

      const [url] = fetchMock.mock.calls[0]!;
      // encodeURIComponent('a&b=c') === 'a%26b%3Dc'
      expect(url).toContain('source=a%26b%3Dc');
    });

    it('searchMemories 应发起 GET /api/memories/search?q=... 请求', async () => {
      await webElectronAPI.searchMemories('关键词');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/search?q=' + encodeURIComponent('关键词'));
    });

    it('showMemory 应发起 GET /api/memories/:id 请求', async () => {
      await webElectronAPI.showMemory('mem-1');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-1');
    });

    it('showMemory 应对特殊字符 ID 进行 URL 编码', async () => {
      await webElectronAPI.showMemory('a/b');

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/memories/a%2Fb');
    });

    it('deleteMemory 应发起 DELETE /api/memories/:id 请求', async () => {
      await webElectronAPI.deleteMemory('mem-1');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/mem-1', {
        method: 'DELETE',
        headers: undefined,
        body: undefined,
      });
    });

    it('addMemory 应发起 POST /api/memories 请求', async () => {
      const data = { source: 'insight', name: '新记忆', content: '内容' };
      await webElectronAPI.addMemory(data);

      expect(fetchMock).toHaveBeenCalledWith('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    });

    it('deleteMemoriesBatch 应发起 POST /api/memories/batch-delete 请求', async () => {
      const ids = ['id-1', 'id-2', 'id-3'];
      await webElectronAPI.deleteMemoriesBatch(ids);

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    it('getRelationGraph 应发起 GET /api/memories/graph 请求', async () => {
      await webElectronAPI.getRelationGraph();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/graph');
    });

    it('addRelation 应发起 POST /api/memories/relation 请求', async () => {
      const data = { sourceId: 's1', targetId: 't1', type: 'related', weight: 0.8 };
      await webElectronAPI.addRelation(data);

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/relation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    });

    it('removeRelation 应发起 DELETE /api/memories/relation 请求（带 body）', async () => {
      const data = { sourceId: 's1', targetId: 't1', type: 'related' };
      await webElectronAPI.removeRelation(data);

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/relation', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    });

    it('updateRelation 应发起 PUT /api/memories/relation 请求', async () => {
      const data = { sourceId: 's1', targetId: 't1', type: 'related', weight: 0.5 };
      await webElectronAPI.updateRelation(data);

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/relation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    });

    it('getHealthDashboard 应发起 GET /api/memories/health 请求', async () => {
      await webElectronAPI.getHealthDashboard();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/health');
    });

    it('getReviewData 应发起 GET /api/memories/review 请求', async () => {
      await webElectronAPI.getReviewData();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/review');
    });

    // ─── 回收站 API ──────────────────────────────────────

    it('restoreMemory 应发起 POST /api/memories/trash/restore 请求', async () => {
      await webElectronAPI.restoreMemory('mem-1');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/trash/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'mem-1' }),
      });
    });

    it('purgeMemory 应发起 DELETE /api/memories/trash/:id 请求', async () => {
      await webElectronAPI.purgeMemory('mem-1');

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/trash/mem-1', {
        method: 'DELETE',
        headers: undefined,
        body: undefined,
      });
    });

    it('purgeMemory 应对特殊字符 ID 进行 URL 编码', async () => {
      await webElectronAPI.purgeMemory('a/b');

      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('/api/memories/trash/a%2Fb');
    });

    it('listDeletedMemories 应发起 GET /api/memories/trash 请求', async () => {
      await webElectronAPI.listDeletedMemories();

      expect(fetchMock).toHaveBeenCalledWith('/api/memories/trash');
    });
  });

  // ─── 配置 ─────────────────────────────────────────────

  describe('配置', () => {
    it('getConfig 应发起 GET /api/config 请求', async () => {
      await webElectronAPI.getConfig();

      expect(fetchMock).toHaveBeenCalledWith('/api/config');
    });

    it('updateConfig 应发起 PUT /api/config 请求（带 key 和 value）', async () => {
      await webElectronAPI.updateConfig('theme', 'dark');

      expect(fetchMock).toHaveBeenCalledWith('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'theme', value: 'dark' }),
      });
    });

    it('updateConfigBatch 应发起 PUT /api/config/batch 请求', async () => {
      const updates = { theme: 'dark', language: 'zh' };
      await webElectronAPI.updateConfigBatch(updates);

      expect(fetchMock).toHaveBeenCalledWith('/api/config/batch', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    });
  });

  // ─── 角色 ─────────────────────────────────────────────

  describe('角色', () => {
    it('listPersonas 应发起 GET /api/personas 请求', async () => {
      await webElectronAPI.listPersonas();

      expect(fetchMock).toHaveBeenCalledWith('/api/personas');
    });

    it('switchPersona 应发起 POST /api/personas/switch 请求（带 name）', async () => {
      await webElectronAPI.switchPersona('coder');

      expect(fetchMock).toHaveBeenCalledWith('/api/personas/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'coder' }),
      });
    });

    it('setPersonaMode 应发起 POST /api/personas/mode 请求', async () => {
      await webElectronAPI.setPersonaMode('manual');

      expect(fetchMock).toHaveBeenCalledWith('/api/personas/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'manual' }),
      });
    });

    it('getPersonaMode 应发起 GET /api/personas/mode 请求', async () => {
      await webElectronAPI.getPersonaMode();

      expect(fetchMock).toHaveBeenCalledWith('/api/personas/mode');
    });
  });

  // ─── 项目、仪表盘与感知 ────────────────────────────────

  describe('项目、仪表盘与感知', () => {
    it('listProjects 应发起 GET /api/projects 请求', async () => {
      await webElectronAPI.listProjects();

      expect(fetchMock).toHaveBeenCalledWith('/api/projects');
    });

    it('getDashboard 应发起 GET /api/dashboard 请求', async () => {
      await webElectronAPI.getDashboard();

      expect(fetchMock).toHaveBeenCalledWith('/api/dashboard');
    });

    it('getPerceptionSnapshot 应发起 GET /api/perception 请求', async () => {
      await webElectronAPI.getPerceptionSnapshot();

      expect(fetchMock).toHaveBeenCalledWith('/api/perception');
    });
  });

  // ─── parseJsonResponse 错误处理 ─────────────────────────

  describe('parseJsonResponse 错误处理', () => {
    it('非 2xx 响应带 error 字段时应抛出包含 error 消息的 Error', async () => {
      fetchMock.mockResolvedValueOnce(createErrorResponse(503, { error: 'Agent 未就绪' }));

      await expect(webElectronAPI.getAgentStatus()).rejects.toThrow('Agent 未就绪');
    });

    it('非 2xx 响应 json 成功但无 error 字段时应保持默认 HTTP 状态码', async () => {
      // parseJsonResponse 逻辑：json() 成功但 errorBody.error 不存在 → errorMessage 保持 `HTTP ${status}`
      // 只有 json() 抛错（非 JSON）才走 catch 降级为 statusText
      fetchMock.mockResolvedValueOnce(createErrorResponse(500, { message: 'something wrong' }, 'Internal Server Error'));

      await expect(webElectronAPI.getAgentStatus()).rejects.toThrow('HTTP 500');
    });

    it('非 2xx 响应体非 JSON 时应降级为 statusText', async () => {
      fetchMock.mockResolvedValueOnce(createErrorResponse(502, undefined, 'Bad Gateway'));

      await expect(webElectronAPI.getAgentStatus()).rejects.toThrow('Bad Gateway');
    });

    it('非 2xx 响应无 statusText 时应使用 HTTP + status', async () => {
      // statusText 为空字符串 → 降级为 `HTTP ${status}`
      fetchMock.mockResolvedValueOnce(createErrorResponse(400, undefined, ''));

      await expect(webElectronAPI.getAgentStatus()).rejects.toThrow('HTTP 400');
    });
  });

  // ─── 精灵输出（onSpriteError 注册与清除） ────────────────

  describe('精灵输出', () => {
    it('onSpriteError 应注册回调', async () => {
      const spriteErrorCb = vi.fn();
      webElectronAPI.onSpriteError(spriteErrorCb);

      // 触发一个 SSE error 事件验证回调被调用
      fetchMock.mockResolvedValueOnce(createSseResponse([
        'event: error\ndata: {"messageId":"msg-1","message":"测试错误"}\n\n',
      ]));
      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.sendUserInput('test');

      await vi.waitFor(() => {
        expect(spriteErrorCb).toHaveBeenCalledWith({ text: '测试错误' });
      });
    });

    it('removeSpriteErrorListener 应清除回调', async () => {
      const spriteErrorCb = vi.fn();
      webElectronAPI.onSpriteError(spriteErrorCb);
      webElectronAPI.removeSpriteErrorListener();

      // 触发 SSE error 事件验证回调不再被调用
      fetchMock.mockResolvedValueOnce(createSseResponse([
        'event: error\ndata: {"messageId":"msg-1","message":"测试错误"}\n\n',
      ]));
      webElectronAPI.onStreamStart(() => {});
      webElectronAPI.sendUserInput('test');

      // 等待 fetch 调用完成
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.anything());
      });
      // 给一点时间确保流处理完成
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(spriteErrorCb).not.toHaveBeenCalled();
    });

    it('onSpriteOutput / removeSpriteOutputListener 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onSpriteOutput(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeSpriteOutputListener()).not.toThrow();
    });

    it('onSpriteEvent / removeSpriteEventListener 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onSpriteEvent(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeSpriteEventListener()).not.toThrow();
    });

    it('onAppError / removeAppErrorListener 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onAppError(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeAppErrorListener()).not.toThrow();
    });
  });

  // ─── 原生能力降级 ──────────────────────────────────────

  describe('原生能力降级（Web 模式无原生能力）', () => {
    it('windowMinimize 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.windowMinimize()).not.toThrow();
    });

    it('windowMaximize 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.windowMaximize()).not.toThrow();
    });

    it('windowClose 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.windowClose()).not.toThrow();
    });

    it('clipboardAnalyze 应返回 false（Promise<boolean>）', async () => {
      const result = await webElectronAPI.clipboardAnalyze();
      expect(result).toBe(false);
    });

    it('installSkill 应返回失败结果（Web 模式暂不支持）', async () => {
      const result = await webElectronAPI.installSkill('skill.json', '{}');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Web 模式');
    });

    it('浮动窗口相关方法应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onFloatUnread(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeFloatUnreadListener()).not.toThrow();
      expect(() => webElectronAPI.moveFloatWindow(10, 20)).not.toThrow();
      expect(() => webElectronAPI.saveFloatPosition()).not.toThrow();
      expect(() => webElectronAPI.expandToFull()).not.toThrow();
      expect(() => webElectronAPI.showFloatContextMenu()).not.toThrow();
    });

    it('主动提示相关方法应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.proactivePromptShown()).not.toThrow();
      expect(() => webElectronAPI.proactiveAccept()).not.toThrow();
      expect(() => webElectronAPI.proactiveReject()).not.toThrow();
    });

    it('窗口状态变更监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onWindowStateChanged(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeWindowStateChangedListener()).not.toThrow();
    });

    it('主题广播监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onThemeBroadcast(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeThemeBroadcastListener()).not.toThrow();
    });

    it('配置建议推送监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onSuggestionPush(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeSuggestionPushListener()).not.toThrow();
    });

    it('写入确认监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onWriteConfirmation(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeWriteConfirmationListener()).not.toThrow();
    });

    it('剪贴板监听相关方法应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onClipboardChanged(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeClipboardChangedListener()).not.toThrow();
      expect(() => webElectronAPI.onClipboardSensitiveIgnored(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeClipboardSensitiveIgnoredListener()).not.toThrow();
      expect(() => webElectronAPI.onClipboardAnalysisReady(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeClipboardAnalysisReadyListener()).not.toThrow();
      expect(() => webElectronAPI.onClipboardAnalysisRejected(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeClipboardAnalysisRejectedListener()).not.toThrow();
    });

    it('全局快捷键监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onQuickRecordTrigger(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeQuickRecordTriggerListener()).not.toThrow();
      expect(() => webElectronAPI.onRecallMemoryTrigger(() => {})).not.toThrow();
      expect(() => webElectronAPI.removeRecallMemoryTriggerListener()).not.toThrow();
    });

    it('流式监听 onStreamStart 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onStreamStart(() => {})).not.toThrow();
    });

    it('removeStreamListeners 无活跃流时应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.removeStreamListeners()).not.toThrow();
    });
  });

  // ─── 主题（localStorage 持久化） ───────────────────────

  describe('主题', () => {
    it('notifyThemeChanged 应将主题写入 localStorage', () => {
      /** localStorage mock（捕获 setItem 调用） */
      const localStorageMock = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      };
      vi.stubGlobal('localStorage', localStorageMock);

      webElectronAPI.notifyThemeChanged('dark');

      expect(localStorageMock.setItem).toHaveBeenCalledWith('theme', 'dark');
    });

    it('notifyThemeChanged 支持 light 主题', () => {
      const localStorageMock = {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      };
      vi.stubGlobal('localStorage', localStorageMock);

      webElectronAPI.notifyThemeChanged('light');

      expect(localStorageMock.setItem).toHaveBeenCalledWith('theme', 'light');
    });
  });

  // ─── 日志上报 ─────────────────────────────────────────

  describe('日志上报', () => {
    it('rendererLog level=error 应调用 console.error 带 [Renderer Error] 前缀', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      webElectronAPI.rendererLog('error', 'ChatPanel', '消息发送失败');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [message] = consoleSpy.mock.calls[0]!;
      expect(message).toContain('[Renderer Error]');
      expect(message).toContain('ChatPanel');
      expect(message).toContain('消息发送失败');
      consoleSpy.mockRestore();
    });

    it('rendererLog level=warn 应调用 console.error 带 [Renderer Warn] 前缀', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      webElectronAPI.rendererLog('warn', 'MemoryPanel', '记忆数量超阈值');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const [message] = consoleSpy.mock.calls[0]!;
      expect(message).toContain('[Renderer Warn]');
      expect(message).toContain('MemoryPanel');
      consoleSpy.mockRestore();
    });
  });

  // ─── Phase 2 预留接口（Promise 降级返回） ──────────────

  describe('Phase 2 预留接口', () => {
    it('acceptSuggestion 应返回 success: true', async () => {
      const result = await webElectronAPI.acceptSuggestion({ id: '1' });
      expect(result.success).toBe(true);
    });

    it('rejectSuggestion 应返回 success: true', async () => {
      const result = await webElectronAPI.rejectSuggestion({ id: '1' });
      expect(result.success).toBe(true);
    });

    it('listUserProfile 应返回空 entries', async () => {
      const result = await webElectronAPI.listUserProfile();
      expect(result.entries).toEqual([]);
    });

    it('confirmUserProfile 应返回 success: true', async () => {
      const result = await webElectronAPI.confirmUserProfile('profile-1');
      expect(result.success).toBe(true);
    });

    it('rejectUserProfile 应返回 success: true', async () => {
      const result = await webElectronAPI.rejectUserProfile('profile-1');
      expect(result.success).toBe(true);
    });

    it('responseWriteConfirmation 应无返回值', async () => {
      await expect(webElectronAPI.responseWriteConfirmation('req-1', true)).resolves.toBeUndefined();
    });

    it('listWorkProjections 应返回空数组', async () => {
      const result = await webElectronAPI.listWorkProjections();
      expect(result).toEqual([]);
    });

    it('showWorkProjection 应返回 null', async () => {
      const result = await webElectronAPI.showWorkProjection('/path/to/file');
      expect(result).toBeNull();
    });

    it('listAuditLog 应返回空数组', async () => {
      const result = await webElectronAPI.listAuditLog();
      expect(result).toEqual([]);
    });

    it('listAuditLog 带 limit 参数应返回空数组', async () => {
      const result = await webElectronAPI.listAuditLog(100);
      expect(result).toEqual([]);
    });

    it('clearAuditLog 应无返回值', async () => {
      await expect(webElectronAPI.clearAuditLog()).resolves.toBeUndefined();
    });
  });
});

// ─── injectWebElectronAPI 测试 ─────────────────────────────

describe('injectWebElectronAPI', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('window 存在时应注入 electronAPI 到 window', () => {
    /** mock window 对象 */
    const mockWindow: { electronAPI?: unknown } = {};
    vi.stubGlobal('window', mockWindow);

    injectWebElectronAPI();

    expect(mockWindow.electronAPI).toBe(webElectronAPI);
  });

  it('window 不存在时应不抛错（Node 环境兼容）', () => {
    // 在 jsdom 环境下模拟 window 不存在
    vi.stubGlobal('window', undefined);

    expect(() => injectWebElectronAPI()).not.toThrow();
  });

  it('document 存在且 readyState=complete 时应立即调用 initWebModeUi', () => {
    // jsdom 默认 readyState 为 'complete'
    const mockWindow: { electronAPI?: unknown } = {};
    vi.stubGlobal('window', mockWindow);

    // 清理 body class 验证 initWebModeUi 被调用
    document.body.className = '';

    injectWebElectronAPI();

    // initWebModeUi 会添加 web-mode class
    expect(document.body.classList.contains('web-mode')).toBe(true);
  });

  it('document 存在且 readyState=loading 时应注册 DOMContentLoaded 监听', () => {
    const mockWindow: { electronAPI?: unknown } = {};
    vi.stubGlobal('window', mockWindow);

    // mock document.readyState 为 'loading'
    vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    injectWebElectronAPI();

    expect(addEventListenerSpy).toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function));
  });
});

// ─── initWebModeUi 测试（DOM 适配） ────────────────────────

describe('initWebModeUi（DOM 适配）', () => {
  beforeEach(() => {
    // 清理 DOM 状态
    document.body.className = '';
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  it('应给 body 添加 web-mode class', () => {
    injectWebElectronAPI();

    expect(document.body.classList.contains('web-mode')).toBe(true);
  });

  it('应隐藏 titlebar-controls 元素（display:none important）', () => {
    const controls = document.createElement('div');
    controls.id = 'titlebar-controls';
    document.body.appendChild(controls);

    injectWebElectronAPI();

    expect(controls.style.display).toBe('none');
  });

  it('应禁用 titlebar-drag 的拖拽区域样式', () => {
    const drag = document.createElement('div');
    drag.id = 'titlebar-drag';
    document.body.appendChild(drag);
    /** spy 捕获 setProperty 调用（jsdom 不支持 -webkit-app-region 非标准属性，用 spy 验证） */
    const setPropertySpy = vi.spyOn(drag.style, 'setProperty');

    injectWebElectronAPI();

    expect(setPropertySpy).toHaveBeenCalledWith('-webkit-app-region', 'no-drag', 'important');
    expect((drag as HTMLElement).style.cursor).toBe('default');
  });

  it('应禁用 header 的拖拽区域样式', () => {
    const header = document.createElement('header');
    document.body.appendChild(header);
    const setPropertySpy = vi.spyOn(header.style, 'setProperty');

    injectWebElectronAPI();

    expect(setPropertySpy).toHaveBeenCalledWith('-webkit-app-region', 'no-drag', 'important');
  });

  it('应禁用 titlebar 的拖拽区域样式', () => {
    const titlebar = document.createElement('div');
    titlebar.id = 'titlebar';
    document.body.appendChild(titlebar);
    const setPropertySpy = vi.spyOn(titlebar.style, 'setProperty');

    injectWebElectronAPI();

    expect(setPropertySpy).toHaveBeenCalledWith('-webkit-app-region', 'no-drag', 'important');
  });

  it('应为侧边栏品牌图标添加点击回到对话面板功能', () => {
    // 创建侧边栏品牌图标
    const sidebarBrand = document.createElement('div');
    sidebarBrand.className = 'sidebar-brand';
    document.body.appendChild(sidebarBrand);

    // 创建对话面板按钮
    const chatBtn = document.createElement('button');
    chatBtn.className = 'nav-btn';
    chatBtn.dataset.panel = 'chat';
    document.body.appendChild(chatBtn);

    /** 点击事件 spy */
    const clickSpy = vi.spyOn(chatBtn, 'click');

    injectWebElectronAPI();

    // 触发侧边栏品牌图标点击
    sidebarBrand.click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('侧边栏品牌图标重复调用 injectWebElectronAPI 不应重复绑定（data-web-bound 标记）', () => {
    const sidebarBrand = document.createElement('div');
    sidebarBrand.className = 'sidebar-brand';
    document.body.appendChild(sidebarBrand);

    const chatBtn = document.createElement('button');
    chatBtn.className = 'nav-btn';
    chatBtn.dataset.panel = 'chat';
    document.body.appendChild(chatBtn);

    const clickSpy = vi.spyOn(chatBtn, 'click');

    // 第一次调用：绑定点击事件
    injectWebElectronAPI();
    // 第二次调用：不应重复绑定（data-web-bound 标记已存在）
    injectWebElectronAPI();

    sidebarBrand.click();

    // 只应触发一次 click
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('应通过 MutationObserver 监听后续 DOM 变化', async () => {
    // 先调用 injectWebElectronAPI 启动 MutationObserver
    injectWebElectronAPI();

    // 异步插入 titlebar-controls 元素
    const controls = document.createElement('div');
    controls.id = 'titlebar-controls';
    document.body.appendChild(controls);

    // 等待 MutationObserver 回调执行（MutationObserver 是微任务）
    await vi.waitFor(() => {
      expect(controls.style.display).toBe('none');
    });
  });

  it('titlebar-controls 不存在时不应抛错', () => {
    expect(() => injectWebElectronAPI()).not.toThrow();
  });

  it('sidebar-brand 不存在时不应抛错', () => {
    expect(() => injectWebElectronAPI()).not.toThrow();
  });
});
