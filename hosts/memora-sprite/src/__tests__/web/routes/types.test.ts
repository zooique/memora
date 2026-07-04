/**
 * Web 路由共享工具函数测试
 *
 * 覆盖范围：
 * - parseJsonBody：GET/DELETE 跳过、POST 解析、空 body 降级、超 10MB 抛错
 * - sendJson：writeHead 设置 Content-Type/Content-Length + end 写入 JSON
 * - sendError：委托 sendJson 响应 { error: message }
 * - safeRoute：fn 成功正常返回 / fn 抛错返回 500 不抛出
 * - ensureAgentReady：true 直接返回 / false 调用 sendError(503) 返回 false
 *
 * Mock 策略：
 * - IncomingMessage：自建 mock 对象，实现 method 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/end 调用
 * - HostContext：仅 mock isAgentReady
 *
 * 风格参考：src/__tests__/electron/ipc/safeHandle.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 模拟 logger 避免 safeRoute 内部错误日志污染测试输出
vi.mock('memora', () => {
  const mockLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
  return { logger: mockLogger };
});

// 导入被测函数
import {
  parseJsonBody,
  sendJson,
  sendError,
  safeRoute,
  ensureAgentReady,
} from '../../../web/routes/types.js';
import { logger } from 'memora';
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
 * 创建 mock IncomingMessage（带可选 body chunks）
 *
 * 实现 method 属性与 async iterator 接口，使 parseJsonBody 能读取 body。
 *
 * @param method HTTP 方法
 * @param chunks 请求体 Buffer 数组（可选，模拟流式 chunk）
 * @returns mock 请求对象
 */
function createMockReq(method: string, chunks: Buffer[] = []): IncomingMessage {
  const req = {
    method,
    /** 实现 async iterator：按顺序 yield chunks 供 parseJsonBody 读取 */
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as IncomingMessage;
  return req;
}

/**
 * 创建 mock HostContext（仅含 isAgentReady）
 *
 * @param isReady Agent 是否就绪
 * @returns mock HostContext
 */
function createMockCtx(isReady = true): HostContext {
  return {
    agent: {} as HostContext['agent'],
    sprite: {} as HostContext['sprite'],
    sessionStore: {} as HostContext['sessionStore'],
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: vi.fn(() => isReady),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('Web 路由工具函数', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── parseJsonBody ─────────────────────────────────────

  describe('parseJsonBody', () => {
    it('GET 请求应返回 null（不读 body）', async () => {
      const req = createMockReq('GET', [Buffer.from('{}')]);
      const result = await parseJsonBody(req);
      expect(result).toBeNull();
    });

    it('DELETE 请求应解析 JSON body（DELETE /api/memories/relation 需要 body）', async () => {
      const req = createMockReq('DELETE', [Buffer.from('{"sourceId":"s1","targetId":"t1"}')]);
      const result = await parseJsonBody<{ sourceId: string; targetId: string }>(req);
      expect(result).toEqual({ sourceId: 's1', targetId: 't1' });
    });

    it('DELETE 请求空 body 应返回 null', async () => {
      const req = createMockReq('DELETE', []);
      const result = await parseJsonBody(req);
      expect(result).toBeNull();
    });

    it('POST 请求应解析 JSON body', async () => {
      const req = createMockReq('POST', [Buffer.from('{"name":"test","value":42}')]);
      const result = await parseJsonBody<{ name: string; value: number }>(req);
      expect(result).toEqual({ name: 'test', value: 42 });
    });

    it('POST 请求空 body 应返回 null', async () => {
      const req = createMockReq('POST', []);
      const result = await parseJsonBody(req);
      expect(result).toBeNull();
    });

    it('POST 请求仅空白字符 body 应返回 null', async () => {
      const req = createMockReq('POST', [Buffer.from('   \n\t  ')]);
      const result = await parseJsonBody(req);
      expect(result).toBeNull();
    });

    it('POST 请求 body 超过 10MB 应抛错', async () => {
      /** 构造 11MB 的 Buffer（超过 10MB 限制） */
      const hugeBuffer = Buffer.alloc(11 * 1024 * 1024, 97); // 97 = 'a'
      const req = createMockReq('POST', [hugeBuffer]);
      await expect(parseJsonBody(req)).rejects.toThrow('10MB');
    });

    it('POST 请求分块传输应正确合并解析', async () => {
      /** 模拟分块传输：JSON 被切分为两个 chunk */
      const req = createMockReq('POST', [
        Buffer.from('{"name":"'),
        Buffer.from('test"}'),
      ]);
      const result = await parseJsonBody<{ name: string }>(req);
      expect(result).toEqual({ name: 'test' });
    });
  });

  // ─── sendJson ──────────────────────────────────────────

  describe('sendJson', () => {
    it('应调用 writeHead 设置状态码和响应头', () => {
      const res = createMockRes();
      const data = { msg: 'hello' };

      sendJson(res, 200, data);

      expect(res.writeHead).toHaveBeenCalledTimes(1);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(JSON.stringify(data)),
        // SEC-WEB-04：安全响应头统一注入（nosniff / DENY / no-referrer）
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
    });

    it('应调用 end 写入 JSON 字符串', () => {
      const res = createMockRes();
      const data = { msg: 'hello' };

      sendJson(res, 200, data);

      expect(res.end).toHaveBeenCalledTimes(1);
      expect(res.body).toBe(JSON.stringify(data));
    });

    it('应在 end 后设置 headersSent 标志', () => {
      const res = createMockRes();

      sendJson(res, 201, { created: true });

      expect(res.headersSent).toBe(true);
    });

    it('应支持不同状态码（如 404）', () => {
      const res = createMockRes();

      sendJson(res, 404, { error: '未找到' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: '未找到' });
    });
  });

  // ─── sendError ─────────────────────────────────────────

  describe('sendError', () => {
    it('应委托 sendJson 响应 { error: message }', () => {
      const res = createMockRes();

      sendError(res, 400, '参数错误');

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: '参数错误' });
    });

    it('应设置 Content-Type 为 application/json', () => {
      const res = createMockRes();

      sendError(res, 500, '内部错误');

      expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    });

    it('应支持 503 状态码', () => {
      const res = createMockRes();

      sendError(res, 503, '服务不可用');

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: '服务不可用' });
    });
  });

  // ─── safeRoute ─────────────────────────────────────────

  describe('safeRoute', () => {
    it('fn 成功时应正常完成不抛错', async () => {
      const res = createMockRes();
      /** 业务逻辑标记（验证 fn 被执行） */
      let executed = false;

      await safeRoute(res, '测试上下文', () => {
        executed = true;
        sendJson(res, 200, { ok: true });
      });

      expect(executed).toBe(true);
      expect(res.statusCode).toBe(200);
    });

    it('fn 异步成功时应正常完成', async () => {
      const res = createMockRes();

      await safeRoute(res, '测试上下文', async () => {
        await Promise.resolve();
        sendJson(res, 200, { async: true });
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ async: true });
    });

    it('fn 抛错应返回 500 不向上传播', async () => {
      const res = createMockRes();

      await safeRoute(res, '记忆操作', () => {
        throw new Error('业务异常');
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toContain('记忆操作失败');
      expect(JSON.parse(res.body).error).toContain('业务异常');
      expect(logger.error).toHaveBeenCalled();
    });

    it('fn 异步 reject 应返回 500', async () => {
      const res = createMockRes();

      await safeRoute(res, '记忆操作', async () => {
        await Promise.resolve();
        throw new Error('异步异常');
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toContain('异步异常');
    });

    it('非 Error 类型异常应转为字符串', async () => {
      const res = createMockRes();

      await safeRoute(res, '记忆操作', () => {
        // 抛出非 Error 对象
        throw '字符串错误';
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toContain('字符串错误');
    });

    it('res.headersSent 已发送时不应重复调用 sendError', async () => {
      const res = createMockRes();

      // 先标记为已发送（模拟响应已写入，safeRoute 不应再调用 sendError）
      res.headersSent = true;

      await safeRoute(res, '记忆操作', () => {
        throw new Error('异常');
      });

      // 不应再调用 writeHead（sendError 被跳过）
      expect(res.writeHead).not.toHaveBeenCalled();
    });
  });

  // ─── ensureAgentReady ──────────────────────────────────

  describe('ensureAgentReady', () => {
    it('ctx.isAgentReady() 返回 true 时应返回 true', () => {
      const res = createMockRes();
      const ctx = createMockCtx(true);

      const result = ensureAgentReady(res, ctx);

      expect(result).toBe(true);
      expect(ctx.isAgentReady).toHaveBeenCalled();
      // 不应写响应
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('ctx.isAgentReady() 返回 false 时应返回 503 并返回 false', () => {
      const res = createMockRes();
      const ctx = createMockCtx(false);

      const result = ensureAgentReady(res, ctx);

      expect(result).toBe(false);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
    });

    it('未就绪时应提示用户配置 LLM 提供商和 API Key', () => {
      const res = createMockRes();
      const ctx = createMockCtx(false);

      ensureAgentReady(res, ctx);

      expect(JSON.parse(res.body).error).toContain('LLM');
      expect(JSON.parse(res.body).error).toContain('API Key');
    });
  });
});
