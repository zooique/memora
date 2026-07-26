/**
 * 系统级 HTTP 路由测试
 *
 * 覆盖范围：
 * - GET /api/agent-status：Agent 就绪状态查询（不需要 Agent 就绪，本身用于检查状态）
 * - GET /api/llm-config：LLM 配置查询
 *   - 已配置时返回脱敏 config（apiKey → ***）
 *   - 未配置时返回 config: null
 *   - loadConfig 抛错时降级返回未配置状态
 *   - 无 embedding 时返回 embedding: null
 *   - apiKey 为空时返回空字符串（不脱敏）
 *   - embedding.baseUrl 缺失且 apiKey 为空时降级为空字符串
 *   - 带尾斜杠路径匹配
 * - POST /api/llm-config/test：测试 LLM 连接（动态 import('memora') → createLlmProvider）
 *   - 合法请求调用 createLlmProvider + provider.chat 迭代收集 reply
 *   - 缺少必填字段返回 400
 *   - createLlmProvider 抛错降级返回 success: false
 *   - provider.chat 抛错降级返回 success: false
 *   - 遇到非 stop finishReason 立即停止迭代
 *   - chunk.content 为空时 reply 为空字符串
 * - POST /api/llm-config：保存 LLM 配置（触发 reinitAgent + webCloseSprite 全局状态更新）
 *   - 合法请求调用 saveLlmConfig + reinitAgent
 *   - reinitAgent 返回的 close 写回 webCloseSprite（链式验证）
 *   - 缺少必填字段返回 400
 *   - saveLlmConfig / reinitAgent 抛错降级返回 success: false
 * - GET /api/llm-providers：多 Provider 列表查询（脱敏）
 *   - 正常返回列表
 *   - getLlmProviders 抛错降级返回空列表
 * - POST /api/llm-providers：保存 Provider（新增/更新）
 *   - 合法请求保存成功
 *   - 缺少 key/config.provider 返回 400
 *   - saveLlmProvider 抛错降级返回 success: false
 * - DELETE /api/llm-providers/:key：删除 Provider
 *   - 合法请求删除成功
 *   - 无 key 时返回 400
 *   - deleteLlmProvider 抛错降级返回 success: false
 * - POST /api/llm-providers/:key/active：切换激活 Provider（运行时切换）
 *   - 无 background 时切换前台 + 清空后台
 *   - 有 background 时同时切换前台 + 后台
 *   - provider 不存在返回 404
 *   - setActiveLlmProvider / setProvider 抛错降级返回 success: false
 *   - providerConfig 无 baseUrl/apiKey 时正常切换
 *   - key 为空时 fall through 到 404
 * - GET /api/audit-logs：审计日志列表（支持 ?limit 参数，上限 200）
 *   - 有/无 auditManager 时的返回
 *   - limit 参数解析（正常/超限/非法）
 * - DELETE /api/audit-logs：清空审计日志
 *   - 有/无 auditManager 时的返回
 * - POST /api/skill-install：安装技能文件
 *   - 合法请求安装成功
 *   - 缺少必填字段返回 400
 *   - 无 installSkill 返回 501
 * - GET /api/works：作品投影列表
 *   - 有/无 works 时的返回
 * - GET /api/works/detail：作品投影详情（query: filePath）
 *   - 合法 filePath 返回详情
 *   - filePath 缺失/过长/works 缺失/getProjection 返回 null 时返回 null
 * - GET /api/projects：项目列表（需要 Agent 就绪）
 * - GET /api/dashboard：仪表盘数据
 *   - 完整数据返回（含 sourceHealth/metrics/skills/各属性）
 *   - sourceHealth 抛错降级为 null
 *   - metrics 抛错降级为 null
 *   - agent.skills 为 undefined 时 skills 降级为空数组
 *   - skill.description 为 undefined 时降级为空字符串
 *   - dashboard() 抛错由 safeRoute 兜底返回 500
 * - GET /api/perception：感知面板数据（异常降级为空对象）
 * - setWebCloseSprite 全局状态：每个测试前 reset，避免状态泄漏
 * - 降级路径：Agent 未就绪 → 503；未匹配路由 → 404；异常 → 500（safeRoute 兜底）
 * - 防御性分支：req.method/url 为 undefined 时使用默认值
 *
 * Mock 策略：
 * - memora：vi.mock 提供 logger/toError/loadConfig/createLlmProvider/createProviderFromConfig（覆盖动态 import）
 * - ../../../index.js：vi.mock 提供 saveLlmConfig/isLlmConfigured/reinitAgent
 *   + getLlmProviders/saveLlmProvider/deleteLlmProvider/setActiveLlmProvider/DEFAULT_CONFIG_DIR
 * - ../../../storage/spriteConfigStore.js：vi.mock 提供 DEFAULT_CONFIG_PATH/resolveProviderConfig
 * - IncomingMessage：自建 mock 对象，实现 method/url 与 async iterator
 * - ServerResponse：自建 mock 对象，捕获 writeHead/end 调用
 * - HostContext.sprite：mock 全部仪表盘/项目/感知相关方法 + getter 属性
 * - HostContext.auditManager/installSkill：可选注入，测试审计/技能安装路由
 * - HostContext.agent.setProvider/setBackgroundProvider/works：可选注入，测试 Provider 切换/作品投影路由
 *
 * 风格参考：src/__tests__/web/routes/sessionRoutes.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─── Mock 模块：memora + ../../../index.js ─────────────────────────────
// vi.mock 是 hoisted 的，用 vi.hoisted 声明可在 factory 内引用的变量。
// 所有 mock 函数都在 hoisted 块中创建，测试中直接引用断言。

const {
  /** mock loadConfig 默认返回的完整 Config */
  MOCK_CONFIG,
  /** mock createLlmProvider 返回的 provider（含 chat 异步生成器） */
  MOCK_PROVIDER,
  /** mock reinitAgent 返回的结果（含 close 函数） */
  MOCK_REINIT_RESULT,
  /** mock saveLlmConfig 函数引用 */
  mockSaveLlmConfig,
  /** mock isLlmConfigured 函数引用 */
  mockIsLlmConfigured,
  /** mock reinitAgent 函数引用 */
  mockReinitAgent,
  /** mock loadConfig 函数引用 */
  mockLoadConfig,
  /** mock createLlmProvider 函数引用 */
  mockCreateLlmProvider,
  /** mock getLlmProviders 函数引用 */
  mockGetLlmProviders,
  /** mock saveLlmProvider 函数引用 */
  mockSaveLlmProvider,
  /** mock deleteLlmProvider 函数引用 */
  mockDeleteLlmProvider,
  /** mock setActiveLlmProvider 函数引用 */
  mockSetActiveLlmProvider,
  /** mock resolveProviderConfig 函数引用 */
  mockResolveProviderConfig,
  /** resolveProviderConfig 真实行为对齐函数（供 mock 默认实现 / beforeEach 使用） */
  faithfulResolveProviderConfig,
  /** mock createProviderFromConfig 函数引用 */
  mockCreateProviderFromConfig,
  /** mock getLlmProviders 默认返回的 Provider 列表 */
  MOCK_PROVIDERS_DATA,
} = vi.hoisted(() => {
  // mock loadConfig：默认返回含 llm + embedding 的完整配置（providers+active 单一格式）
  const mockLoadConfig = vi.fn(async () => ({
    llm: {
      providers: {
        default: {
          provider: 'deepseek',
          model: 'deepseek-chat',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test-key',
          temperature: 0.7,
        },
      },
      active: 'default',
    },
    embedding: {
      model: 'text-embedding-3',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-emb-key',
    },
  }));
  // mock createLlmProvider：返回含 chat 方法的 provider
  const mockCreateLlmProvider = vi.fn(() => ({ chat: vi.fn() }));
  // mock saveLlmConfig：默认成功
  const mockSaveLlmConfig = vi.fn(async () => undefined);
  // mock isLlmConfigured：默认返回 true
  const mockIsLlmConfigured = vi.fn(async () => true);
  // mock reinitAgent：默认返回含 close 的结果
  const mockReinitAgent = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
  // mock getLlmProviders：默认返回含 active + providers 的列表
  const mockGetLlmProviders = vi.fn(async () => ({ active: 'default', providers: [] }));
  // mock saveLlmProvider：默认成功
  const mockSaveLlmProvider = vi.fn(async () => undefined);
  // mock deleteLlmProvider：默认成功
  const mockDeleteLlmProvider = vi.fn(async () => undefined);
  // mock setActiveLlmProvider：默认成功
  const mockSetActiveLlmProvider = vi.fn(async () => undefined);
  // resolveProviderConfig 为纯函数：仅按 key 读取 providers 映射（v1.x 扁平兼容已移除）
  const faithfulResolveProviderConfig = (config: unknown, key: string) => {
    const providers = (config as { llm?: { providers?: Record<string, unknown> } } | undefined)?.llm?.providers;
    return providers?.[key];
  };
  const mockResolveProviderConfig = vi.fn(faithfulResolveProviderConfig);
  // mock createProviderFromConfig：返回空对象（代表 provider 实例）
  const mockCreateProviderFromConfig = vi.fn(() => ({}));
  return {
    MOCK_CONFIG: {
      llm: {
        providers: {
          default: {
            provider: 'deepseek',
            model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-test-key',
            temperature: 0.7,
          },
        },
        active: 'default',
      },
      embedding: {
        model: 'text-embedding-3',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-emb-key',
      },
    },
    MOCK_PROVIDER: { chat: vi.fn() },
    MOCK_REINIT_RESULT: { close: vi.fn(async () => {}) },
    mockSaveLlmConfig,
    mockIsLlmConfigured,
    mockReinitAgent,
    mockLoadConfig,
    mockCreateLlmProvider,
    mockGetLlmProviders,
    mockSaveLlmProvider,
    mockDeleteLlmProvider,
    mockSetActiveLlmProvider,
    mockResolveProviderConfig,
    faithfulResolveProviderConfig,
    mockCreateProviderFromConfig,
    MOCK_PROVIDERS_DATA: {
      active: 'default',
      providers: [
        {
          key: 'default',
          name: '默认',
          provider: 'deepseek',
          model: 'deepseek-chat',
          baseUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test',
          temperature: 0.7,
        },
      ],
    },
  };
});

// Mock memora 模块：覆盖 `import { logger, toError } from 'memora'`、
// `import { loadConfig } from 'memora'` 以及动态 `await import('memora')`
vi.mock('memora', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  toError: (err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
  }),
  loadConfig: mockLoadConfig,
  createLlmProvider: mockCreateLlmProvider,
  createProviderFromConfig: mockCreateProviderFromConfig,
}));

// Mock ../../../index.js：覆盖 saveLlmConfig/isLlmConfigured/reinitAgent
// 以及多 Provider 管理函数 + 动态 import 的 DEFAULT_CONFIG_DIR
vi.mock('../../../index.js', () => ({
  saveLlmConfig: mockSaveLlmConfig,
  isLlmConfigured: mockIsLlmConfigured,
  reinitAgent: mockReinitAgent,
  getLlmProviders: mockGetLlmProviders,
  saveLlmProvider: mockSaveLlmProvider,
  deleteLlmProvider: mockDeleteLlmProvider,
  setActiveLlmProvider: mockSetActiveLlmProvider,
  DEFAULT_CONFIG_DIR: '/mock/config/dir',
}));

// Mock ../../../storage/spriteConfigStore.js：覆盖 DEFAULT_CONFIG_PATH / resolveProviderConfig
vi.mock('../../../storage/spriteConfigStore.js', () => ({
  DEFAULT_CONFIG_PATH: '/mock/config.json',
  resolveProviderConfig: mockResolveProviderConfig,
}));

// 导入被测模块（在 vi.mock 之后，确保 mock 生效）
import { handleSystemRoute, setWebCloseSprite } from '../../../web/routes/systemRoutes.js';
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

// ─── Mock Sprite / Agent / HostContext ───────────────────

/** Mock Sprite 方法集合（systemRoutes 用到的子集） */
interface MockSprite {
  /** 列出已注册项目 */
  listProjects: ReturnType<typeof vi.fn>;
  /** 仪表盘数据 */
  dashboard: ReturnType<typeof vi.fn>;
  /** 记忆源健康诊断 */
  sourceHealth: ReturnType<typeof vi.fn>;
  /** Agent 运行时指标 */
  getMetrics: ReturnType<typeof vi.fn>;
  /** 感知数据快照 */
  getPerceptionSnapshot: ReturnType<typeof vi.fn>;
  /** 待提示事件数（getter 属性） */
  pendingCount: number;
  /** 主动提示阈值（getter 属性） */
  proactiveThreshold: number;
  /** 已注册触发器名（getter 属性） */
  registeredTriggers: string[];
}

/** Mock 技能对象（与 memora Skill 类型对齐的子集） */
interface MockSkill {
  /** 技能名 */
  name: string;
  /** 关键词 */
  keywords: string[];
  /** 描述（可选，测试降级为空字符串） */
  description?: string;
  /** 分层 */
  layer: string;
}

/** Mock Agent（systemRoutes 用到的子集：skills.list/setProvider/setBackgroundProvider/works） */
interface MockAgent {
  /** 技能管理器（可选，未初始化时为 undefined） */
  skills?: { list: MockSkill[] } | null;
  /** 运行时切换前台 Provider（可选，切换激活 Provider 路由使用） */
  setProvider?: ReturnType<typeof vi.fn>;
  /** 运行时切换后台 Provider（可选，切换激活 Provider 路由使用） */
  setBackgroundProvider?: ReturnType<typeof vi.fn>;
  /** 作品投影管理器（可选，未初始化时为 undefined/null） */
  works?: { loadAll: ReturnType<typeof vi.fn>; getProjection: ReturnType<typeof vi.fn> } | null;
}

/**
 * 创建 mock Sprite
 *
 * 默认所有方法返回空/默认值，通过 overrides 覆盖默认返回值。
 * dashboard 默认返回包含 5 个字段的最小对象。
 *
 * @param overrides 可选的字段覆盖
 * @returns mock Sprite
 */
function createMockSprite(overrides?: Partial<MockSprite>): MockSprite {
  return {
    listProjects: overrides?.listProjects ?? vi.fn(() => []),
    dashboard: overrides?.dashboard ?? vi.fn(() => ({
      total: 0,
      bySource: {},
      suggestions: [],
      relationCount: 0,
      conflictCount: 0,
    })),
    sourceHealth: overrides?.sourceHealth ?? vi.fn(() => null),
    getMetrics: overrides?.getMetrics ?? vi.fn(() => ({ llm: { calls: 0 } })),
    getPerceptionSnapshot: overrides?.getPerceptionSnapshot ?? vi.fn(() => null),
    pendingCount: overrides?.pendingCount ?? 0,
    proactiveThreshold: overrides?.proactiveThreshold ?? 5,
    registeredTriggers: overrides?.registeredTriggers ?? [],
  };
}

/**
 * 创建 mock HostContext
 *
 * 组合 mock agent + sprite + isAgentReady。
 * 通过 overrides 覆盖各字段以测试不同场景。
 * 注意：用 in 操作符区分"未传"和"显式传 null"，避免 null ?? 默认值 的陷阱。
 *
 * @param overrides 可选的覆盖项
 * @returns mock HostContext
 */
function createMockCtx(overrides?: {
  /** agent mock（默认含空 skills list）；传 undefined 测试无 skills 场景 */
  agent?: MockAgent | null;
  /** sprite mock（默认空实现） */
  sprite?: MockSprite;
  /** isAgentReady mock（默认 () => true） */
  isAgentReady?: ReturnType<typeof vi.fn>;
  /** 审计日志管理器 mock（可选，不传则 undefined） */
  auditManager?: { readRecent: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } | null;
  /** 技能安装回调 mock（可选，不传则 undefined） */
  installSkill?: ReturnType<typeof vi.fn> | null;
}): HostContext {
  // agent 可能为 null/undefined（测试无 skills 场景），不能用 ?? 替换
  const hasAgent = overrides && 'agent' in overrides;
  // auditManager/installSkill 用 in 操作符区分"未传"和"显式传 null"
  const hasAudit = overrides && 'auditManager' in overrides;
  const hasInstall = overrides && 'installSkill' in overrides;
  return {
    agent: (hasAgent ? overrides!.agent : { skills: { list: [] } }) as unknown as HostContext['agent'],
    sprite: (overrides?.sprite ?? createMockSprite()) as unknown as HostContext['sprite'],
    sessionStore: {} as HostContext['sessionStore'],
    getAbortController: vi.fn(() => null),
    setAbortController: vi.fn(),
    isAgentReady: overrides?.isAgentReady ?? vi.fn(() => true),
    auditManager: (hasAudit ? overrides!.auditManager : undefined) as unknown as HostContext['auditManager'],
    installSkill: (hasInstall ? overrides!.installSkill : undefined) as unknown as HostContext['installSkill'],
    initError: () => null,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('handleSystemRoute', () => {
  beforeEach(() => {
    // 重置所有 mock 调用记录（不重置 implementation）
    vi.clearAllMocks();
    // 重置 memora mock 默认返回值（个别测试可能修改）
    mockLoadConfig.mockResolvedValue(MOCK_CONFIG);
    mockCreateLlmProvider.mockReturnValue(MOCK_PROVIDER);
    mockIsLlmConfigured.mockResolvedValue(true);
    mockSaveLlmConfig.mockResolvedValue(undefined);
    mockReinitAgent.mockResolvedValue(MOCK_REINIT_RESULT);
    // 重置多 Provider 管理 mock 默认返回值
    mockGetLlmProviders.mockResolvedValue(MOCK_PROVIDERS_DATA);
    mockSaveLlmProvider.mockResolvedValue(undefined);
    mockDeleteLlmProvider.mockResolvedValue(undefined);
    mockSetActiveLlmProvider.mockResolvedValue(undefined);
    // 默认按真实 resolveProviderConfig 行为从传入 config 解析（GET /api/llm-config 测试依赖此契约）
    mockResolveProviderConfig.mockImplementation(faithfulResolveProviderConfig);
    mockCreateProviderFromConfig.mockReturnValue({});
    // 重置 MOCK_PROVIDER.chat 默认行为：yield 一个 chunk 后 stop
    MOCK_PROVIDER.chat.mockImplementation(async function* () {
      yield { content: 'hi', finishReason: 'stop' };
    });
    // 重置 webCloseSprite 全局状态（避免测试间状态泄漏）
    setWebCloseSprite(null);
  });

  // ─── GET /api/agent-status ─────────────────────────────

  it('GET /api/agent-status Agent 就绪时应返回 ready: true', async () => {
    const ctx = createMockCtx({ isAgentReady: vi.fn(() => true) });
    const req = createMockReq('GET', '/api/agent-status');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(ctx.isAgentReady).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ready: true, error: null });
  });

  it('GET /api/agent-status Agent 未就绪时应返回 ready: false（此路由不受 503 约束）', async () => {
    const ctx = createMockCtx({ isAgentReady: vi.fn(() => false) });
    const req = createMockReq('GET', '/api/agent-status');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // 关键：agent-status 在 Agent 就绪检查之前，应直接返回状态而非 503
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ready: false, error: null });
  });

  // ─── GET /api/llm-config ───────────────────────────────

  it('GET /api/llm-config 已配置时应返回脱敏后的 config（apiKey → ***）', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockIsLlmConfigured).toHaveBeenCalled();
    expect(mockLoadConfig).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    /** 解析响应体验证脱敏 */
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(true);
    expect(body.config.apiKey).toBe('***'); // 脱敏
    expect(body.config.provider).toBe('deepseek');
    expect(body.config.model).toBe('deepseek-chat');
    expect(body.config.baseUrl).toBe('https://api.deepseek.com');
    expect(body.config.temperature).toBe(0.7);
    // embedding 也应脱敏
    expect(body.embedding.apiKey).toBe('***');
    expect(body.embedding.model).toBe('text-embedding-3');
  });

  it('GET /api/llm-config 未配置时应返回 config: null', async () => {
    mockIsLlmConfigured.mockResolvedValue(false);
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(false);
    expect(body.config).toBeNull();
    // 注意：源码即使未配置也会调用 loadConfig 取 embedding 信息
  });

  it('GET /api/llm-config loadConfig 抛错时应降级返回未配置状态', async () => {
    mockIsLlmConfigured.mockResolvedValue(true);
    mockLoadConfig.mockRejectedValue(new Error('配置文件损坏'));
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // catch 块应返回未配置状态（而非 500）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.configured).toBe(false);
    expect(body.config).toBeNull();
    expect(body.embedding).toBeNull();
  });

  it('GET /api/llm-config 无 embedding 时应返回 embedding: null', async () => {
    mockLoadConfig.mockResolvedValue({
      llm: {
        providers: {
          default: {
            provider: 'openai',
            model: 'gpt-4o',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-x',
            temperature: 0.5,
          },
        },
        active: 'default',
      },
      // 无 embedding 字段
    });
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding).toBeNull();
  });

  it('GET /api/llm-config apiKey 为空时应返回 apiKey: ""（不脱敏）', async () => {
    mockLoadConfig.mockResolvedValue({
      llm: {
        providers: {
          default: {
            provider: 'openai',
            model: 'gpt-4o',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            temperature: 0.5,
          },
        },
        active: 'default',
      },
    });
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.config.apiKey).toBe('');
  });

  it('GET /api/llm-config/ 带尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).configured).toBe(true);
  });

  // ─── POST /api/llm-config/test ─────────────────────────

  it('POST /api/llm-config/test 合法请求应调用 createLlmProvider 并返回 success: true', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // 应动态 import memora 并调用 createLlmProvider
    expect(mockCreateLlmProvider).toHaveBeenCalled();
    expect(MOCK_PROVIDER.chat).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    expect(body.reply).toBe('hi'); // 来自 mock chat 的 chunk.content
  });

  it('POST /api/llm-config/test 缺少必填字段应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'deepseek',
      // 缺少 model/baseUrl/apiKey
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockCreateLlmProvider).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('POST /api/llm-config/test createLlmProvider 抛错时应降级返回 success: false', async () => {
    mockCreateLlmProvider.mockImplementation(() => {
      throw new Error('无效的 provider 配置');
    });
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'invalid',
      model: 'm',
      baseUrl: 'u',
      apiKey: 'k',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // catch 块应返回 success: false（而非 500）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('配置无效');
  });

  it('POST /api/llm-config/test provider.chat 抛错时应降级返回 success: false', async () => {
    MOCK_PROVIDER.chat.mockImplementation(async function* () {
      throw new Error('连接超时');
    });
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('超时');
  });

  it('POST /api/llm-config/test 遇到非 stop finishReason 应立即停止迭代', async () => {
    // 模拟先返回一个无 finishReason chunk，再返回一个 length chunk，最后 stop 不应被消费
    MOCK_PROVIDER.chat.mockImplementation(async function* () {
      yield { content: 'A', finishReason: undefined };
      yield { content: 'B', finishReason: 'length' };
      yield { content: 'C', finishReason: 'stop' }; // 不应被消费
    });
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // A + B（C 因 finishReason=length 提前 break，不应被收集）
    expect(body.reply).toBe('AB');
  });

  // ─── POST /api/llm-config ──────────────────────────────

  it('POST /api/llm-config 合法请求应调用 saveLlmConfig + reinitAgent 并返回成功', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-new',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // 1. 应保存配置
    expect(mockSaveLlmConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'deepseek',
        apiKey: 'sk-new',
      }),
    );
    // 2. 应用 prevClose=null 调用 reinitAgent（beforeEach 已重置 webCloseSprite）
    expect(mockReinitAgent).toHaveBeenCalledWith(null);
    // 3. 应返回成功（提示重启）
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toContain('重启');
  });

  it('POST /api/llm-config 应将 reinitAgent 返回的 close 写回 webCloseSprite 全局状态', async () => {
    /** 新的 close 函数（与默认不同，便于断言） */
    const newClose = vi.fn(async () => {});
    mockReinitAgent.mockResolvedValue({ close: newClose });
    const ctx = createMockCtx();
    const req1 = createMockReq('POST', '/api/llm-config', {
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
    });
    const res1 = createMockRes();

    await handleSystemRoute(req1, res1, ctx);

    // 第一次调用应用 null 调用 reinitAgent
    expect(mockReinitAgent).toHaveBeenCalledWith(null);

    // 第二次调用应将上一次的 newClose 作为 prevClose 传给 reinitAgent
    mockReinitAgent.mockClear();
    const req2 = createMockReq('POST', '/api/llm-config', {
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-y',
    });
    const res2 = createMockRes();
    await handleSystemRoute(req2, res2, ctx);

    expect(mockReinitAgent).toHaveBeenCalledWith(newClose);
  });

  it('POST /api/llm-config 缺少必填字段应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config', {
      provider: 'deepseek',
      // 缺少 model/baseUrl/apiKey
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSaveLlmConfig).not.toHaveBeenCalled();
    expect(mockReinitAgent).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('POST /api/llm-config saveLlmConfig 抛错时应降级返回 success: false', async () => {
    mockSaveLlmConfig.mockRejectedValue(new Error('文件系统错误'));
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config', {
      provider: 'deepseek',
      model: 'm',
      baseUrl: 'u',
      apiKey: 'k',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  it('POST /api/llm-config reinitAgent 抛错时应降级返回 success: false', async () => {
    mockReinitAgent.mockRejectedValue(new Error('Agent 初始化失败'));
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config', {
      provider: 'deepseek',
      model: 'm',
      baseUrl: 'u',
      apiKey: 'k',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  it('POST /api/llm-config/ 带尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/', {
      provider: 'deepseek',
      model: 'm',
      baseUrl: 'u',
      apiKey: 'k',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSaveLlmConfig).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  // ─── Agent 未就绪 → 503（以下路由需要 Agent 就绪） ──────

  it('Agent 未就绪时 GET /api/projects 应返回 503', async () => {
    const sprite = createMockSprite({
      listProjects: vi.fn(() => [{ name: 'p1', path: '/p1' }]),
    });
    const ctx = createMockCtx({ isAgentReady: vi.fn(() => false), sprite });
    const req = createMockReq('GET', '/api/projects');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.listProjects).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toContain('Agent 未就绪');
  });

  it('Agent 未就绪时 GET /api/dashboard 应返回 503', async () => {
    const sprite = createMockSprite();
    const ctx = createMockCtx({ isAgentReady: vi.fn(() => false), sprite });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.dashboard).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it('Agent 未就绪时 GET /api/perception 应返回 503', async () => {
    const sprite = createMockSprite();
    const ctx = createMockCtx({ isAgentReady: vi.fn(() => false), sprite });
    const req = createMockReq('GET', '/api/perception');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.getPerceptionSnapshot).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  // ─── GET /api/projects ────────────────────────────────

  it('GET /api/projects 应返回项目列表', async () => {
    const projects = [
      { name: 'project-a', path: '/path/a' },
      { name: 'project-b', path: '/path/b' },
    ];
    const sprite = createMockSprite({ listProjects: vi.fn(() => projects) });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/projects');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.listProjects).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ projects });
  });

  it('GET /api/projects/ 带尾斜杠也应匹配', async () => {
    const sprite = createMockSprite({ listProjects: vi.fn(() => []) });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/projects/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ projects: [] });
  });

  it('GET /api/projects listProjects 抛错应由 safeRoute 兜底返回 500', async () => {
    const sprite = createMockSprite({
      listProjects: vi.fn(() => {
        throw new Error('扫描失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/projects');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── GET /api/dashboard ───────────────────────────────

  it('GET /api/dashboard 应返回完整仪表盘数据（含 sourceHealth/metrics/skills）', async () => {
    const dashboardData = {
      total: 100,
      bySource: { insight: 60, profile: 40 },
      suggestions: [{ type: 'x', message: '建议1' }],
      relationCount: 12,
      conflictCount: 2,
    };
    const sourceHealth = { insight: { count: 60, healthy: true } };
    const metrics = { llm: { calls: 10, tokens: 500 } };
    const sprite = createMockSprite({
      dashboard: vi.fn(() => dashboardData),
      sourceHealth: vi.fn(() => sourceHealth),
      getMetrics: vi.fn(() => metrics),
      pendingCount: 3,
      proactiveThreshold: 5,
      registeredTriggers: ['timer', 'fileWatcher'],
    });
    const skills = [
      { name: 'skill-1', keywords: ['kw1'], description: 'desc1', layer: 'L1' },
    ];
    const ctx = createMockCtx({
      sprite,
      agent: { skills: { list: skills } },
    });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.dashboard).toHaveBeenCalled();
    expect(sprite.sourceHealth).toHaveBeenCalled();
    expect(sprite.getMetrics).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.total).toBe(100);
    expect(body.bySource).toEqual(dashboardData.bySource);
    expect(body.suggestions).toEqual(dashboardData.suggestions);
    expect(body.pendingNotices).toBe(3);
    expect(body.proactiveThreshold).toBe(5);
    expect(body.registeredTriggers).toEqual(['timer', 'fileWatcher']);
    expect(body.relationCount).toBe(12);
    expect(body.conflictCount).toBe(2);
    expect(body.sourceHealth).toEqual(sourceHealth);
    expect(body.metrics).toEqual(metrics);
    expect(body.skills).toEqual([
      { name: 'skill-1', keywords: ['kw1'], description: 'desc1', layer: 'L1' },
    ]);
  });

  it('GET /api/dashboard sourceHealth 抛错时应降级为 null', async () => {
    const sprite = createMockSprite({
      sourceHealth: vi.fn(() => {
        throw new Error('sourceHealth 失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // try-catch 应捕获异常，sourceHealth 降级为 null，整体仍返回 200
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sourceHealth).toBeNull();
    // metrics 仍应正常返回
    expect(body.metrics).not.toBeNull();
  });

  it('GET /api/dashboard metrics 抛错时应降级为 null', async () => {
    const sprite = createMockSprite({
      // sourceHealth 显式返回非 null，验证 metrics 抛错不影响 sourceHealth
      sourceHealth: vi.fn(() => ({ insight: { count: 10, healthy: true } })),
      getMetrics: vi.fn(() => {
        throw new Error('metrics 失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.metrics).toBeNull();
    // sourceHealth 仍应正常返回（独立 try-catch 互不影响）
    expect(body.sourceHealth).not.toBeNull();
  });

  it('GET /api/dashboard sourceHealth 和 metrics 都抛错时应同时降级为 null', async () => {
    const sprite = createMockSprite({
      sourceHealth: vi.fn(() => {
        throw new Error('sourceHealth 失败');
      }),
      getMetrics: vi.fn(() => {
        throw new Error('metrics 失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sourceHealth).toBeNull();
    expect(body.metrics).toBeNull();
  });

  it('GET /api/dashboard agent.skills 为 undefined 时 skills 应为空数组', async () => {
    const sprite = createMockSprite();
    const ctx = createMockCtx({
      sprite,
      agent: { skills: undefined },
    });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.skills).toEqual([]);
  });

  it('GET /api/dashboard skill.description 为 undefined 时应降级为空字符串', async () => {
    const sprite = createMockSprite();
    const skills = [
      { name: 'skill-no-desc', keywords: ['kw'], description: undefined, layer: 'L2' },
    ];
    const ctx = createMockCtx({
      sprite,
      agent: { skills: { list: skills } },
    });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.skills[0].description).toBe('');
  });

  it('GET /api/dashboard/ 带尾斜杠也应匹配', async () => {
    const sprite = createMockSprite({
      dashboard: vi.fn(() => ({
        total: 5,
        bySource: {},
        suggestions: [],
        relationCount: 0,
        conflictCount: 0,
      })),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/dashboard/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.dashboard).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).total).toBe(5);
  });

  it('GET /api/dashboard dashboard() 抛错应由 safeRoute 兜底返回 500', async () => {
    const sprite = createMockSprite({
      dashboard: vi.fn(() => {
        throw new Error('仪表盘生成失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/dashboard');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
    // 安全：safeRoute 不再暴露原始错误消息，改为通用提示
    expect(JSON.parse(res.body).error).toContain('系统操作失败');
    expect(JSON.parse(res.body).error).toContain('请稍后重试');
  });

  // ─── GET /api/perception ──────────────────────────────

  it('GET /api/perception 应返回感知快照', async () => {
    const snapshot = {
      affect: { mood: 'neutral' },
      rapport: { level: 3 },
      context: { topic: 'coding' },
      patterns: [],
      proactiveStats: { accepted: 5, rejected: 1 },
    };
    const sprite = createMockSprite({
      getPerceptionSnapshot: vi.fn(() => snapshot),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/perception');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(sprite.getPerceptionSnapshot).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(snapshot);
  });

  it('GET /api/perception 返回 null 时应返回空对象', async () => {
    const sprite = createMockSprite({
      getPerceptionSnapshot: vi.fn(() => null),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/perception');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  it('GET /api/perception getPerceptionSnapshot 抛错时应降级返回空对象', async () => {
    const sprite = createMockSprite({
      getPerceptionSnapshot: vi.fn(() => {
        throw new Error('感知推导失败');
      }),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/perception');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // try-catch 应捕获异常，返回空对象（而非 500）
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
  });

  it('GET /api/perception/ 带尾斜杠也应匹配', async () => {
    const sprite = createMockSprite({
      getPerceptionSnapshot: vi.fn(() => ({ mood: 'happy' })),
    });
    const ctx = createMockCtx({ sprite });
    const req = createMockReq('GET', '/api/perception/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mood: 'happy' });
  });

  // ─── setWebCloseSprite 全局状态 ───────────────────────

  it('setWebCloseSprite(null) 应重置全局状态，后续 POST /api/llm-config 应以 null 调用 reinitAgent', async () => {
    // 模拟前一次测试遗留的 close 函数
    const staleClose = vi.fn(async () => {});
    setWebCloseSprite(staleClose);

    // 重置全局状态
    setWebCloseSprite(null);

    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config', {
      provider: 'deepseek',
      model: 'm',
      baseUrl: 'u',
      apiKey: 'k',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // reinitAgent 应用 null 调用，而非 staleClose
    expect(mockReinitAgent).toHaveBeenCalledWith(null);
    expect(staleClose).not.toHaveBeenCalled();
  });

  // ─── GET /api/llm-providers ──────────────────────────

  it('GET /api/llm-providers 应返回 Provider 列表', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-providers');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockGetLlmProviders).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(MOCK_PROVIDERS_DATA);
  });

  it('GET /api/llm-providers/ 带尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-providers/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(MOCK_PROVIDERS_DATA);
  });

  // getLlmProviders 抛错时降级返回空列表（catch 块）
  it('GET /api/llm-providers getLlmProviders 抛错时应降级返回空列表', async () => {
    mockGetLlmProviders.mockRejectedValue(new Error('读取失败'));
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-providers');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ active: '', providers: [] });
  });

  // ─── POST /api/llm-providers ─────────────────────────

  it('POST /api/llm-providers 合法请求应保存 Provider 并返回成功', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers', {
      key: 'new-provider',
      config: {
        provider: 'openai',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
      },
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSaveLlmProvider).toHaveBeenCalledWith('new-provider', expect.objectContaining({ provider: 'openai' }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it('POST /api/llm-providers/ 带尾斜杠也应匹配', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers/', {
      key: 'k',
      config: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: 'a' },
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSaveLlmProvider).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/llm-providers 缺少 key 应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers', {
      config: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: 'a' },
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSaveLlmProvider).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('POST /api/llm-providers 缺少 config.provider 应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers', {
      key: 'k',
      config: { model: 'm', baseUrl: 'u', apiKey: 'a' },
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('POST /api/llm-providers saveLlmProvider 抛错时应降级返回 success: false', async () => {
    mockSaveLlmProvider.mockRejectedValue(new Error('写入失败'));
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers', {
      key: 'k',
      config: { provider: 'p', model: 'm', baseUrl: 'u', apiKey: 'a' },
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  // ─── DELETE /api/llm-providers/:key ───────────────────

  it('DELETE /api/llm-providers/:key 合法请求应删除 Provider 并返回成功', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/llm-providers/my-key');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockDeleteLlmProvider).toHaveBeenCalledWith('my-key');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  // 尾斜杠无 key 时 path.split('/').pop() 返回空字符串，触发 400
  it('DELETE /api/llm-providers/ 无 key 时应返回 400', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/llm-providers/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockDeleteLlmProvider).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('key 必填');
  });

  it('DELETE /api/llm-providers/:key deleteLlmProvider 抛错时应降级返回 success: false', async () => {
    mockDeleteLlmProvider.mockRejectedValue(new Error('删除失败'));
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/llm-providers/my-key');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  // ─── POST /api/llm-providers/:key/active ──────────────

  it('POST /api/llm-providers/:key/active 合法请求应切换激活 Provider（无 background）', async () => {
    // 该测试不喂 providers 映射，显式让 resolveProviderConfig 返回有效 Provider（模拟"key 已存在"）
    mockResolveProviderConfig.mockReturnValue({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      temperature: 0.7,
    });
    const setProvider = vi.fn();
    const setBackgroundProvider = vi.fn();
    const ctx = createMockCtx({
      agent: { skills: { list: [] }, setProvider, setBackgroundProvider },
    });
    const req = createMockReq('POST', '/api/llm-providers/my-key/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(mockSetActiveLlmProvider).toHaveBeenCalledWith('my-key');
    expect(mockCreateProviderFromConfig).toHaveBeenCalled();
    expect(setProvider).toHaveBeenCalled();
    // 无 background 时应调用 setBackgroundProvider(null)
    expect(setBackgroundProvider).toHaveBeenCalledWith(null);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toContain('切换');
  });

  it('POST /api/llm-providers/:key/active 有 background 时应同时切换后台 Provider', async () => {
    // 该测试不喂 providers 映射，显式让 resolveProviderConfig 返回有效 Provider（模拟"key 已存在"）
    mockResolveProviderConfig.mockReturnValue({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      temperature: 0.7,
    });
    // 覆盖 loadConfig 返回含 background 的配置
    mockLoadConfig.mockResolvedValue({
      llm: {
        providers: {
          default: {
            provider: 'deepseek',
            model: 'deepseek-chat',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-test',
            temperature: 0.7,
          },
        },
        active: 'default',
        background: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-bg',
        },
      },
    });
    const setProvider = vi.fn();
    const setBackgroundProvider = vi.fn();
    const ctx = createMockCtx({
      agent: { skills: { list: [] }, setProvider, setBackgroundProvider },
    });
    const req = createMockReq('POST', '/api/llm-providers/my-key/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // 应创建前台 + 后台两个 provider 实例
    expect(mockCreateProviderFromConfig).toHaveBeenCalledTimes(2);
    expect(setProvider).toHaveBeenCalled();
    expect(setBackgroundProvider).toHaveBeenCalled();
    // setBackgroundProvider 应收到非 null 参数（后台 provider 实例）
    expect(setBackgroundProvider).not.toHaveBeenCalledWith(null);
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/llm-providers/:key/active provider 不存在时应返回 404', async () => {
    mockResolveProviderConfig.mockReturnValue(undefined);
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers/missing/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toContain('不存在');
  });

  it('POST /api/llm-providers/:key/active setActiveLlmProvider 抛错时应降级返回 success: false', async () => {
    mockSetActiveLlmProvider.mockRejectedValue(new Error('持久化失败'));
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers/my-key/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  it('POST /api/llm-providers/:key/active setProvider 抛错时应降级返回 success: false', async () => {
    // 该测试不喂 providers 映射，显式让 resolveProviderConfig 返回有效 Provider（模拟"key 已存在"）
    mockResolveProviderConfig.mockReturnValue({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      temperature: 0.7,
    });
    const setProvider = vi.fn(() => { throw new Error('Agent 未就绪'); });
    const ctx = createMockCtx({
      agent: { skills: { list: [] }, setProvider, setBackgroundProvider: vi.fn() },
    });
    const req = createMockReq('POST', '/api/llm-providers/my-key/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('请稍后重试');
  });

  // ─── GET /api/audit-logs ──────────────────────────────

  it('GET /api/audit-logs 有 auditManager 时应返回日志列表', async () => {
    const logs = [{ ts: '2026-07-12', action: 'write', path: '/a' }];
    const auditManager = { readRecent: vi.fn(async () => logs), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('GET', '/api/audit-logs');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.readRecent).toHaveBeenCalledWith(50);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(logs);
  });

  it('GET /api/audit-logs/ 带尾斜杠也应匹配', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('GET', '/api/audit-logs/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('GET /api/audit-logs 无 auditManager 时应返回空数组', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/audit-logs');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('GET /api/audit-logs?limit=10 应将 limit 传递给 readRecent', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('GET', '/api/audit-logs?limit=10');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.readRecent).toHaveBeenCalledWith(10);
  });

  it('GET /api/audit-logs?limit=500 超过 200 时应被截断为 200', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('GET', '/api/audit-logs?limit=500');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.readRecent).toHaveBeenCalledWith(200);
  });

  it('GET /api/audit-logs?limit=abc 非法 limit 应降级为默认 50', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('GET', '/api/audit-logs?limit=abc');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.readRecent).toHaveBeenCalledWith(50);
  });

  // ─── DELETE /api/audit-logs ───────────────────────────

  it('DELETE /api/audit-logs 有 auditManager 时应清空日志', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('DELETE', '/api/audit-logs');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.clear).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  it('DELETE /api/audit-logs/ 带尾斜杠也应匹配', async () => {
    const auditManager = { readRecent: vi.fn(async () => []), clear: vi.fn(async () => {}) };
    const ctx = createMockCtx({ auditManager });
    const req = createMockReq('DELETE', '/api/audit-logs/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(auditManager.clear).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('DELETE /api/audit-logs 无 auditManager 时应仍返回成功', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('DELETE', '/api/audit-logs');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
  });

  // ─── POST /api/skill-install ──────────────────────────

  it('POST /api/skill-install 合法请求应安装技能', async () => {
    const installResult = { success: true, skillName: 'my-skill', installedPath: '/skills/my-skill.md' };
    const installSkill = vi.fn(async () => installResult);
    const ctx = createMockCtx({ installSkill });
    const req = createMockReq('POST', '/api/skill-install', {
      fileName: 'my-skill.md',
      content: '# My Skill\n技能内容',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(installSkill).toHaveBeenCalledWith('# My Skill\n技能内容', 'my-skill.md', '/mock/config/dir');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(installResult);
  });

  it('POST /api/skill-install/ 带尾斜杠也应匹配', async () => {
    const installSkill = vi.fn(async () => ({ success: true }));
    const ctx = createMockCtx({ installSkill });
    const req = createMockReq('POST', '/api/skill-install/', {
      fileName: 's.md',
      content: 'c',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(installSkill).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/skill-install 缺少 content 应返回 400', async () => {
    const installSkill = vi.fn(async () => ({ success: true }));
    const ctx = createMockCtx({ installSkill });
    const req = createMockReq('POST', '/api/skill-install', {
      fileName: 's.md',
      // 缺少 content
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(installSkill).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('必填');
  });

  it('POST /api/skill-install 无 installSkill 时应返回 501', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/skill-install', {
      fileName: 's.md',
      content: 'c',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body).error).toContain('未启用');
  });

  // ─── GET /api/works ───────────────────────────────────

  it('GET /api/works 有 works 时应返回作品投影列表', async () => {
    const entries = [
      {
        id: 'work-1',
        sourcePath: '/path/a.ts',
        fileHash: 'abc123',
        summary: '文件摘要',
        structure: ['模块1', '模块2'],
        keyDecisions: ['决策1'],
        updatedAt: '2026-07-12T00:00:00Z',
      },
    ];
    const works = { loadAll: vi.fn(async () => entries), getProjection: vi.fn() };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const req = createMockReq('GET', '/api/works');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(works.loadAll).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('work-1');
    expect(body[0].sourcePath).toBe('/path/a.ts');
    expect(body[0].summary).toBe('文件摘要');
    expect(body[0].structure).toEqual(['模块1', '模块2']);
  });

  it('GET /api/works/ 带尾斜杠也应匹配', async () => {
    const works = { loadAll: vi.fn(async () => []), getProjection: vi.fn() };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const req = createMockReq('GET', '/api/works/');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('GET /api/works works 为 undefined 时应返回空数组', async () => {
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works: undefined } });
    const req = createMockReq('GET', '/api/works');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  // ─── GET /api/works/detail ────────────────────────────

  it('GET /api/works/detail 合法 filePath 应返回作品详情', async () => {
    const entry = {
      id: 'work-1',
      sourcePath: '/path/a.ts',
      fileHash: 'abc123',
      summary: '摘要',
      structure: ['模块1'],
      keyDecisions: ['决策1'],
      updatedAt: '2026-07-12T00:00:00Z',
    };
    const works = { loadAll: vi.fn(), getProjection: vi.fn(async () => entry) };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const req = createMockReq('GET', '/api/works/detail?filePath=/path/a.ts');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(works.getProjection).toHaveBeenCalledWith('/path/a.ts');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('work-1');
    expect(body.summary).toBe('摘要');
  });

  it('GET /api/works/detail 缺少 filePath 时应返回 null', async () => {
    const works = { loadAll: vi.fn(), getProjection: vi.fn() };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const req = createMockReq('GET', '/api/works/detail');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(works.getProjection).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('GET /api/works/detail filePath 过长（>1000）时应返回 null', async () => {
    const works = { loadAll: vi.fn(), getProjection: vi.fn() };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const longPath = 'a'.repeat(1001);
    const req = createMockReq('GET', `/api/works/detail?filePath=${longPath}`);
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(works.getProjection).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('GET /api/works/detail works 为 undefined 时应返回 null', async () => {
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works: undefined } });
    const req = createMockReq('GET', '/api/works/detail?filePath=/path/a.ts');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  it('GET /api/works/detail getProjection 返回 null 时应返回 null', async () => {
    const works = { loadAll: vi.fn(), getProjection: vi.fn(async () => null) };
    const ctx = createMockCtx({ agent: { skills: { list: [] }, works } });
    const req = createMockReq('GET', '/api/works/detail?filePath=/not/found.ts');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toBeNull();
  });

  // ─── 补充分支覆盖 ──────────────────────────────────────

  // chunk.content 为空时不应拼接 reply（覆盖 line 140 的 falsy 分支）
  it('POST /api/llm-config/test chunk.content 为空时 reply 应为空字符串', async () => {
    MOCK_PROVIDER.chat.mockImplementation(async function* () {
      yield { content: '', finishReason: 'stop' };
    });
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-config/test', {
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
    });
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.reply).toBe('');
  });

  // POST /api/llm-providers//active key 为空时条件不满足，fall through 到 404
  it('POST /api/llm-providers//active key 为空时应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/llm-providers//active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // key 为空时 parts[4]==='active' && key 条件不满足，fall through 到未匹配路由
    expect(res.statusCode).toBe(404);
  });

  // providerConfig.baseUrl/apiKey 为空时正常切换（覆盖 lines 254-255 的 falsy 分支）
  it('POST /api/llm-providers/:key/active provider 配置无 baseUrl/apiKey 时应正常切换', async () => {
    mockResolveProviderConfig.mockReturnValue({
      provider: 'custom',
      model: 'm',
      // baseUrl 和 apiKey 缺失，触发 || undefined / || '' 分支
    });
    const setProvider = vi.fn();
    const setBackgroundProvider = vi.fn();
    const ctx = createMockCtx({
      agent: { skills: { list: [] }, setProvider, setBackgroundProvider },
    });
    const req = createMockReq('POST', '/api/llm-providers/my-key/active');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(setProvider).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  // embedding.baseUrl 缺失且 apiKey 为空时降级为空字符串（覆盖 lines 96-97 的 falsy 分支）
  it('GET /api/llm-config embedding.baseUrl 缺失且 apiKey 为空时应返回空字符串', async () => {
    mockLoadConfig.mockResolvedValue({
      llm: {
        providers: {
          default: {
            provider: 'openai',
            model: 'gpt-4o',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-x',
            temperature: 0.5,
          },
        },
        active: 'default',
      },
      embedding: {
        model: 'text-embedding-3',
        // baseUrl 缺失触发 ?? '' 分支，apiKey 为空触发 ? '' : '' 分支
        apiKey: '',
      },
    });
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/llm-config');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.embedding.baseUrl).toBe('');
    expect(body.embedding.apiKey).toBe('');
  });

  // req.method/url 为 undefined 时使用默认值（覆盖 lines 66-68 的 ?? 防御性分支）
  it('req.method/url 为 undefined 时应使用默认值 GET 和空字符串并返回 404', async () => {
    const ctx = createMockCtx();
    // 构造 method/url 均为 undefined 的请求对象
    const req = {} as unknown as IncomingMessage;
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    // method 默认 'GET'，url 默认 ''，path 默认 ''，不匹配任何路由 → 404
    expect(res.statusCode).toBe(404);
  });

  // ─── 未匹配路由 → 404 ──────────────────────────────────

  it('未匹配的 GET 路由应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('GET', '/api/unknown-system-path');
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
    // 不回显 path 防止注入/泄露路由结构，仅返回通用 404 文案
    expect(JSON.parse(res.body).error).toBe('404 Not Found');
  });

  it('未匹配的 POST 路由应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('POST', '/api/unknown', {});
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
  });

  it('未匹配的方法（PUT）应返回 404', async () => {
    const ctx = createMockCtx();
    const req = createMockReq('PUT', '/api/dashboard', {});
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(404);
  });

  // ─── 异常兜底 ──────────────────────────────────────────

  it('parseJsonBody 解析非法 JSON 应由 safeRoute 兜底返回 500', async () => {
    const ctx = createMockCtx();
    // 构造一个会触发 JSON.parse 失败的 body（非法 JSON）
    const req = {
      method: 'POST',
      url: '/api/llm-config',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('not-a-json');
      },
    } as unknown as IncomingMessage;
    const res = createMockRes();

    await handleSystemRoute(req, res, ctx);

    expect(res.statusCode).toBe(500);
  });
});
