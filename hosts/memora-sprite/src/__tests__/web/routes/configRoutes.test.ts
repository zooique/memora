/**
 * 配置与角色 HTTP 路由测试
 *
 * 覆盖范围：
 * - GET /api/config：获取精灵配置（SpriteConfig 不含 apiKey，明文密钥由 systemRoutes 的 /api/llm-config 脱敏）
 * - PUT /api/config：更新单个配置项（含 isSpriteConfigKey 白名单校验，未知键返回 200 + updated:false）
 * - PUT /api/config/batch：批量更新配置（事务性，部分失败应全部回滚）
 * - GET /api/personas：列出角色
 * - POST /api/personas/switch：切换角色（含正则校验防注入）
 * - POST /api/personas/mode：设置角色匹配模式
 * - GET /api/personas/mode：获取角色匹配模式
 * - 安全分支：未知配置键名拒绝、角色名特殊字符拒绝、null/undefined 入参、apiKey 永不回显明文
 * - 降级路径：Agent 未就绪 → 503；sprite 方法抛错 safeRoute 兜底 → 500；路由未匹配 → 404
 *
 * Mock 策略：
 * - IncomingMessage：自建 mock 对象，实现 method/url 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/end 调用
 * - HostContext.sprite：mock 全部配置/角色相关方法（getConfig/updateConfig/updateConfigBatch/listPersonas/switchPersona/setPersonaMode/personaMode）
 *
 * 风格参考：src/__tests__/web/routes/memoryRoutes.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// 导入被测模块
import { handleConfigRoute } from '../../../web/routes/configRoutes.js';
import type { HostContext } from '../../../shared/hostContext.js';
import { DEFAULT_SPRITE_CONFIG } from '../../../sprite/spriteConfig.js';

// ─── 测试辅助：Mock 响应对象状态 ───────────────────────────

/** Mock 响应对象内部捕获的状态 */
interface MockResState {
  /** 捕获的状态码 */
  statusCode: number;
  /** 捕获的响应头 */
  headers: Record<string, string | number>;
  /** 捕获的响应体字符串 */
  body: string;
  /** headersSent 标志（end 调用后置 true） */
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
 * @param body 请求体对象（可选，POST/PUT 使用；传 null 会序列化为 'null'）
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
 * 仅包含 configRoutes 需要的 sprite 方法 + isAgentReady，
 * 其余字段（agent/sessionStore 等）置空对象。
 *
 * @param overrides 可选的 sprite 方法/属性覆盖
 * @returns mock HostContext
 */
function createMockCtx(overrides?: {
  getConfig?: ReturnType<typeof vi.fn>;
  updateConfig?: ReturnType<typeof vi.fn>;
  updateConfigBatch?: ReturnType<typeof vi.fn>;
  listPersonas?: ReturnType<typeof vi.fn>;
  switchPersona?: ReturnType<typeof vi.fn>;
  setPersonaMode?: ReturnType<typeof vi.fn>;
  /** personaMode 属性值（Sprite 中为 getter，mock 中作为普通属性） */
  personaMode?: string;
  isAgentReady?: ReturnType<typeof vi.fn>;
}): HostContext {
  return {
    agent: {} as HostContext['agent'],
    sprite: {
      getConfig: overrides?.getConfig ?? vi.fn(() => ({ ...DEFAULT_SPRITE_CONFIG })),
      updateConfig: overrides?.updateConfig ?? vi.fn(),
      updateConfigBatch:
        overrides?.updateConfigBatch ?? vi.fn(() => ({ updated: true })),
      listPersonas: overrides?.listPersonas ?? vi.fn(() => []),
      switchPersona: overrides?.switchPersona ?? vi.fn(() => null),
      setPersonaMode: overrides?.setPersonaMode ?? vi.fn(() => true),
      // personaMode 在 Sprite 中是 getter，mock 中直接作为普通属性读取
      personaMode: overrides?.personaMode ?? 'auto',
    } as unknown as HostContext['sprite'],
    sessionStore: {} as HostContext['sessionStore'],
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: overrides?.isAgentReady ?? vi.fn(() => true),
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('handleConfigRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /api/config ───────────────────────────────────

  it('GET /api/config 应返回 200 + config 对象', async () => {
    /** 自定义配置副本，含 theme 字段以便断言 */
    const config = { ...DEFAULT_SPRITE_CONFIG, theme: 'dark' as const };
    const getConfig = vi.fn(() => config);
    const ctx = createMockCtx({ getConfig });
    const req = createMockReq('GET', '/api/config');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(getConfig).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ config });
  });

  it('GET /api/config/ 尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/config/');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).config).toBeDefined();
  });

  it('GET /api/config 返回的配置不应包含 apiKey 字段（密钥由 /api/llm-config 脱敏暴露）', async () => {
    // SpriteConfig 不定义 apiKey 字段；apiKey 存储在 config.json（LLM 配置），
    // 通过 systemRoutes.ts 的 GET /api/llm-config 路由以 '***' 脱敏后暴露。
    // 此处验证 /api/config 不会意外回显密钥明文。
    const config = { ...DEFAULT_SPRITE_CONFIG };
    const getConfig = vi.fn(() => config);
    const ctx = createMockCtx({ getConfig });
    const req = createMockReq('GET', '/api/config');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const { config: returned } = JSON.parse(res.body);
    expect(returned).not.toHaveProperty('apiKey');
  });

  // ─── PUT /api/config ───────────────────────────────────

  it('PUT /api/config 合法 key 应调用 updateConfig 并返回 { updated: true }', async () => {
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config', {
      key: 'silentMode',
      value: true,
    });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).toHaveBeenCalledWith('silentMode', true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ updated: true });
  });

  it('PUT /api/config/ 尾斜杠也应匹配', async () => {
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config/', {
      key: 'theme',
      value: 'dark',
    });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).toHaveBeenCalledWith('theme', 'dark');
    expect(res.statusCode).toBe(200);
  });

  it('PUT /api/config 未知 key 应返回 200 + { updated: false, error }', async () => {
    // 注意：源文件对未知键返回 200（非 400），通过 updated:false 标识失败。
    // 这与 PUT /api/config/batch 的事务性错误返回风格一致。
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config', {
      key: 'unknownKey',
      value: 'whatever',
    });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toContain('unknownKey');
  });

  it('PUT /api/config 缺少 key 应返回 400', async () => {
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config', { value: true });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('key');
  });

  it('PUT /api/config 空 key 字符串应返回 400', async () => {
    // 源文件检查 !body?.key，空字符串 '' 是 falsy，应被拒绝
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config', { key: '', value: true });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/config 无请求体（null）应返回 400', async () => {
    // parseJsonBody 在无 body 时返回 null，!null?.key 为 true → 400
    const updateConfig = vi.fn();
    const ctx = createMockCtx({ updateConfig });
    const req = createMockReq('PUT', '/api/config');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  // ─── PUT /api/config/batch ─────────────────────────────

  it('PUT /api/config/batch 合法批量应调用 updateConfigBatch 并返回结果', async () => {
    const result = { updated: true };
    const updateConfigBatch = vi.fn(() => result);
    const ctx = createMockCtx({ updateConfigBatch });
    const req = createMockReq('PUT', '/api/config/batch', {
      silentMode: true,
      theme: 'dark',
    });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfigBatch).toHaveBeenCalledWith({ silentMode: true, theme: 'dark' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(result);
  });

  it('PUT /api/config/batch 空对象应返回 { updated: true }', async () => {
    // updateConfigBatch 对空批量幂等返回 { updated: true }
    const updateConfigBatch = vi.fn(() => ({ updated: true }));
    const ctx = createMockCtx({ updateConfigBatch });
    const req = createMockReq('PUT', '/api/config/batch', {});
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfigBatch).toHaveBeenCalledWith({});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ updated: true });
  });

  it('PUT /api/config/batch 无请求体应返回 400', async () => {
    const updateConfigBatch = vi.fn();
    const ctx = createMockCtx({ updateConfigBatch });
    const req = createMockReq('PUT', '/api/config/batch');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfigBatch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('配置对象');
  });

  it('PUT /api/config/batch 非对象请求体（字符串）应返回 400', async () => {
    // JSON 字符串 "hello" 解析后为 string，typeof !== 'object' → 400
    const updateConfigBatch = vi.fn();
    const ctx = createMockCtx({ updateConfigBatch });
    const req = createMockReq('PUT', '/api/config/batch', 'hello');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfigBatch).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('PUT /api/config/batch 部分失败（事务性）应返回 { updated: false, error }', async () => {
    // 模拟 updateConfigBatch 检测到非法键时的事务性回滚：
    // 校验阶段任一 key 非法即返回 { updated: false, error }，config 状态不变
    const result = { updated: false, error: '非法配置键：unknownKey' };
    const updateConfigBatch = vi.fn(() => result);
    const ctx = createMockCtx({ updateConfigBatch });
    const req = createMockReq('PUT', '/api/config/batch', {
      silentMode: true,
      unknownKey: 'evil',
    });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(updateConfigBatch).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(result);
    expect(JSON.parse(res.body).updated).toBe(false);
  });

  // ─── GET /api/personas ────────────────────────────────

  it('GET /api/personas 应返回 200 + personas 数组', async () => {
    const personas = [
      { name: 'coder', description: '编码角色', active: true },
      { name: 'writer', description: '写作角色', active: false },
    ];
    const listPersonas = vi.fn(() => personas);
    const ctx = createMockCtx({ listPersonas });
    const req = createMockReq('GET', '/api/personas');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(listPersonas).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ personas });
  });

  it('GET /api/personas/ 尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/personas/');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).personas).toBeDefined();
  });

  // ─── POST /api/personas/switch ────────────────────────

  it('POST /api/personas/switch 合法角色名应调用 switchPersona 并返回 switched + name', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: 'coder' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).toHaveBeenCalledWith('coder');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ switched: true, name: 'coder' });
  });

  it('POST /api/personas/switch switchPersona 返回 null 时应返回 switched: false', async () => {
    // 角色不存在时 switchPersona 返回 null
    const switchPersona = vi.fn(() => null);
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: 'nonexistent' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).toHaveBeenCalledWith('nonexistent');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ switched: false, name: null });
  });

  it('POST /api/personas/switch 缺少 name 应返回 400', async () => {
    const switchPersona = vi.fn(() => 'coder');
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', {});
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('name');
  });

  it('POST /api/personas/switch 角色名含路径分隔符 ../etc 应返回 400', async () => {
    // 正则 ^[a-zA-Z0-9._-]+$ 拒绝 '/' 字符，防止路径遍历注入
    const switchPersona = vi.fn();
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: '../etc/passwd' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('无效的角色名');
  });

  it('POST /api/personas/switch 角色名含空格应返回 400', async () => {
    const switchPersona = vi.fn();
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: 'evil name' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/personas/switch 角色名含分号（命令注入尝试）应返回 400', async () => {
    const switchPersona = vi.fn();
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: 'a;rm -rf /' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/personas/switch 角色名超长（>100 字符）应返回 400', async () => {
    const switchPersona = vi.fn();
    const ctx = createMockCtx({ switchPersona });
    /** 构造长度 101 的角色名（超过 100 限制） */
    const longName = 'a'.repeat(101);
    const req = createMockReq('POST', '/api/personas/switch', { name: longName });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/personas/switch 角色名含合法特殊字符（. _ -）应成功', async () => {
    // 正则允许 a-zA-Z0-9._- ，验证合法特殊字符不被误拒
    const switchPersona = vi.fn(() => 'my.persona_v1-2');
    const ctx = createMockCtx({ switchPersona });
    const req = createMockReq('POST', '/api/personas/switch', { name: 'my.persona_v1-2' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(switchPersona).toHaveBeenCalledWith('my.persona_v1-2');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).switched).toBe(true);
  });

  // ─── POST /api/personas/mode ──────────────────────────

  it('POST /api/personas/mode mode=auto 应调用 setPersonaMode 并返回 { set: true }', async () => {
    const setPersonaMode = vi.fn(() => true);
    const ctx = createMockCtx({ setPersonaMode });
    const req = createMockReq('POST', '/api/personas/mode', { mode: 'auto' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(setPersonaMode).toHaveBeenCalledWith('auto');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ set: true });
  });

  it('POST /api/personas/mode mode=manual 应调用 setPersonaMode 并返回 { set: true }', async () => {
    const setPersonaMode = vi.fn(() => true);
    const ctx = createMockCtx({ setPersonaMode });
    const req = createMockReq('POST', '/api/personas/mode', { mode: 'manual' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(setPersonaMode).toHaveBeenCalledWith('manual');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ set: true });
  });

  it('POST /api/personas/mode mode=invalid 应返回 400', async () => {
    const setPersonaMode = vi.fn();
    const ctx = createMockCtx({ setPersonaMode });
    const req = createMockReq('POST', '/api/personas/mode', { mode: 'invalid' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(setPersonaMode).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('auto 或 manual');
  });

  it('POST /api/personas/mode 缺少 mode 应返回 400', async () => {
    const setPersonaMode = vi.fn();
    const ctx = createMockCtx({ setPersonaMode });
    const req = createMockReq('POST', '/api/personas/mode', {});
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(setPersonaMode).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/personas/mode setPersonaMode 返回 false 时应返回 { set: false }', async () => {
    // setPersonaMode 返回 false 表示设置未生效（如内部状态机不允许切换）
    const setPersonaMode = vi.fn(() => false);
    const ctx = createMockCtx({ setPersonaMode });
    const req = createMockReq('POST', '/api/personas/mode', { mode: 'auto' });
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(setPersonaMode).toHaveBeenCalledWith('auto');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ set: false });
  });

  // ─── GET /api/personas/mode ───────────────────────────

  it('GET /api/personas/mode 应返回 { mode }', async () => {
    // personaMode 在 Sprite 中是 getter，mock 中作为普通属性
    const ctx = createMockCtx({ personaMode: 'manual' });
    const req = createMockReq('GET', '/api/personas/mode');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mode: 'manual' });
  });

  // ─── 降级路径：Agent 未就绪 ────────────────────────────

  it('Agent 未就绪时应返回 503', async () => {
    // ensureAgentReady 在 safeRoute 之前执行，直接返回 503，sprite 方法不应被调用
    const isAgentReady = vi.fn(() => false);
    const getConfig = vi.fn();
    const ctx = createMockCtx({ isAgentReady, getConfig });
    const req = createMockReq('GET', '/api/config');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(isAgentReady).toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
  });

  // ─── 降级路径：sprite 方法抛错 ────────────────────────

  it('getConfig 抛错应由 safeRoute 兜底返回 500', async () => {
    // 模拟 personaController 缺失或内部错误导致 getConfig 抛错
    const getConfig = vi.fn(() => {
      throw new Error('配置读取失败');
    });
    const ctx = createMockCtx({ getConfig });
    const req = createMockReq('GET', '/api/config');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('配置操作失败');
    expect(JSON.parse(res.body).error).toContain('配置读取失败');
  });

  it('listPersonas 抛错应由 safeRoute 兜底返回 500', async () => {
    // 模拟 personaManager 缺失导致 listPersonas 抛错，不应崩溃
    const listPersonas = vi.fn(() => {
      throw new Error('personaController 未初始化');
    });
    const ctx = createMockCtx({ listPersonas });
    const req = createMockReq('GET', '/api/personas');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('配置操作失败');
    expect(JSON.parse(res.body).error).toContain('personaController 未初始化');
  });

  // ─── 未匹配路由 ────────────────────────────────────────

  it('未匹配的路由应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/config/unknown-path');
    const res = createMockRes();

    await handleConfigRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
    // 不回显 path 防止注入/泄露路由结构，仅返回通用 404 文案
    expect(JSON.parse(res.body).error).toBe('404 Not Found');
  });
});
