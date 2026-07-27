/**
 * tools.ts 单元测试
 *
 * 覆盖范围：
 * - webSearch：纯函数，execFile 跨平台浏览器打开
 * - webSearchHandler：ToolHandler 包装，参数容错（无状态，顶层导出）
 * - createSpriteHandlers：依赖注入工厂，返回 4 个有状态 ToolHandler
 *   - memorySearchHandler：委托注入的 memorySearcher
 *   - createPersonaHandler / createSkillHandler / createRuleHandler：写文件 + 热重载
 * - WEB_SEARCH_TOOL / MEMORY_SEARCH_TOOL / CREATE_*_TOOL：ToolDefinition 常量校验
 *
 * 测试策略（对齐 memoryController.test.ts 范式）：
 * - mock execFile（vi.mock('node:child_process', ...)）
 * - mock logger（通过 setLogger 注入 mockLogger）
 * - 每个测试通过 createSpriteHandlers 工厂构造独立 handler 实例
 *   （消除模块级全局状态，多 Agent 实例并行互不污染）
 * - 类型导入使用 import type（consistent-type-imports 规则）
 * - 禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { setLogger } from 'memora';
import type { ILogger, ToolContext } from 'memora';

// ─── Mock node:child_process ────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// ─── 模块导入 ────────────────────────────────────────────

import {
  webSearch,
  webSearchHandler,
  createSpriteHandlers,
  WEB_SEARCH_TOOL,
  MEMORY_SEARCH_TOOL,
  CREATE_PERSONA_TOOL,
  CREATE_SKILL_TOOL,
  CREATE_RULE_TOOL,
} from '../../sprite/tools.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 Mock ILogger
 *
 * 用于通过 setLogger() 注入，验证降级日志调用
 * logger 为 getter-only 单例，无法用 vi.spyOn，必须通过 setLogger 替换内部引用
 */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * 创建 Mock ToolContext
 *
 * ToolContext 仅含 guardPath 方法，handler 中未使用 _ctx 参数
 */
function createMockCtx(): ToolContext {
  return { guardPath: vi.fn() };
}

/**
 * 创建 Mock 记忆搜索器
 *
 * @param results 搜索结果数组，默认空数组
 */
function createMockSearcher(
  results: Array<{ name: string; contentPreview: string; score: number }> = []
): (query: string, limit: number) => Promise<Array<{ name: string; contentPreview: string; score: number }>> {
  return vi.fn().mockResolvedValue(results);
}

/**
 * 创建 Mock AgentRef
 *
 * 形状兼容 createSpriteHandlers 的 AgentRef 类型。
 * 返回类型由推断保留 Mock 方法（mockResolvedValue / mockRejectedValue 等）。
 */
function createMockAgent() {
  return {
    config: {
      confirmConfigSuggestion: vi.fn().mockResolvedValue(undefined),
    },
    reloadConfig: vi.fn().mockResolvedValue({ skill: 0, persona: 0 }),
  };
}

/**
 * 通过 createSpriteHandlers 工厂构造带 mock 依赖的 handlers
 *
 * 显式依赖注入测试范式：每个测试独立构造一份 handlers 实例，
 * 避免 setAgentRef / setMemorySearcher 模块级状态泄漏。
 *
 * @param options 可选的 mock 覆盖（agent / searcher）
 * @returns { handlers, mockAgent, mockSearch } — handlers + 注入的 mocks（用于断言）
 */
function createHandlersWithMocks(options?: {
  agent?: ReturnType<typeof createMockAgent>;
  searcher?: ReturnType<typeof createMockSearcher>;
}) {
  const mockAgent = options?.agent ?? createMockAgent();
  const mockSearch = options?.searcher ?? createMockSearcher();
  const handlers = createSpriteHandlers({
    agent: mockAgent,
    memorySearcher: mockSearch,
  });
  return { handlers, mockAgent, mockSearch };
}

// ─── 测试用例 ────────────────────────────────────────────

describe('tools', () => {
  let mockLogger: ILogger;
  let mockCtx: ToolContext;

  beforeEach(() => {
    // 每个测试用例获得全新的 mock 实例，避免状态泄漏
    mockLogger = createMockLogger();
    mockCtx = createMockCtx();
    // 注入 mock logger（替代默认 console fallback），使降级日志可验证
    setLogger(mockLogger);
    // 清除所有 mock 调用记录，避免跨测试累积
    vi.clearAllMocks();
  });

  // ─── 1. webSearch 函数（8 测试） ───────────────────────

  describe('webSearch', () => {
    it('空字符串查询应返回"错误：搜索关键词不能为空"', async () => {
      const result = await webSearch('');
      expect(result).toBe('错误：搜索关键词不能为空');
      // 不应调用 execFile
      expect(execFile).not.toHaveBeenCalled();
    });

    it('纯空格查询应返回"错误：搜索关键词不能为空"（trim 后为空）', async () => {
      const result = await webSearch('   ');
      expect(result).toBe('错误：搜索关键词不能为空');
      expect(execFile).not.toHaveBeenCalled();
    });

    it('正常查询应调用 execFile 执行 cmd /c start + Google 搜索 URL', async () => {
      // 默认 mock 不调用 callback，需要手动实现
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );

      await webSearch('React 19');

      // 验证 execFile 被调用，cmd 为 'cmd'（Windows 平台）
      expect(execFile).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(execFile).mock.calls[0]!;
      expect(callArgs[0]).toBe('cmd');
      // args 数组包含 /c start 和 URL
      expect(callArgs[1]).toEqual([
        '/c',
        'start',
        '',
        'https://www.google.com/search?q=React%2019',
      ]);
    });

    it('URL 应正确编码中文关键词（encodeURIComponent）', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );

      await webSearch('你好');

      const callArgs = vi.mocked(execFile).mock.calls[0]!;
      // 中文 "你好" → encodeURIComponent → "%E4%BD%A0%E5%A5%BD"
      expect(callArgs[1]![3]).toBe('https://www.google.com/search?q=%E4%BD%A0%E5%A5%BD');
    });

    it('execFile 成功回调应返回"已在系统默认浏览器中搜索：..."', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );

      const result = await webSearch('TypeScript');

      // 成功消息包含搜索关键词和提示
      expect(result).toContain('已在系统默认浏览器中搜索：');
      expect(result).toContain('TypeScript');
      expect(result).toContain('请用户查看浏览器窗口');
    });

    it('execFile 失败回调应返回"错误：无法打开浏览器..."', async () => {
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(new Error('browser not found'));
        }
      );

      const result = await webSearch('test');

      // 错误消息包含错误原因和手动访问 URL
      expect(result).toContain('错误：无法打开浏览器');
      expect(result).toContain('browser not found');
      expect(result).toContain('请用户手动访问');
      expect(result).toContain('https://www.google.com/search?q=test');
    });

    it('应返回 Promise<string> 类型', async () => {
      const result = webSearch('test');
      expect(result).toBeInstanceOf(Promise);
      // 验证 Promise resolve 后为 string
      await expect(result).resolves.toBeTypeOf('string');
    });

    it('跨平台：win32 → cmd /c start，darwin → open，其他 → xdg-open', async () => {
      const originalPlatform = process.platform;

      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );

      try {
        // 模拟 darwin 平台
        Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
        await webSearch('test');
        expect(execFile).toHaveBeenCalledWith('open', ['https://www.google.com/search?q=test'], expect.any(Function));

        vi.clearAllMocks();

        // 模拟 linux 平台
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        await webSearch('test');
        expect(execFile).toHaveBeenCalledWith('xdg-open', ['https://www.google.com/search?q=test'], expect.any(Function));
      } finally {
        // 恢复原始平台值
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  // ─── 2. webSearchHandler（3 测试） ────────────────────

  describe('webSearchHandler', () => {
    beforeEach(() => {
      // 默认 mock：execFile 成功
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );
    });

    it('正常调用应委托 webSearch(String(args.query))', async () => {
      const result = await webSearchHandler({ query: 'React' }, mockCtx);
      expect(result).toContain('React');
      expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('args.query 为 undefined 时应传空字符串给 webSearch', async () => {
      const result = await webSearchHandler({}, mockCtx);
      // webSearch('') → 错误：搜索关键词不能为空
      expect(result).toBe('错误：搜索关键词不能为空');
      expect(execFile).not.toHaveBeenCalled();
    });

    it('args.query 为数字时应转为字符串（如 42 → "42"）', async () => {
      const result = await webSearchHandler({ query: 42 }, mockCtx);
      // String(42) → "42" → 有效查询
      expect(result).toContain('42');
      expect(execFile).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 3. memorySearchHandler（6 测试） ─────────────────

  describe('memorySearchHandler', () => {
    let mockSearch: ReturnType<typeof createMockSearcher>;
    let memorySearchHandler: ReturnType<typeof createSpriteHandlers>['memorySearchHandler'];

    beforeEach(() => {
      // 每个测试通过工厂构造独立 handlers（消除模块级状态）
      mockSearch = createMockSearcher();
      const { handlers } = createHandlersWithMocks({ searcher: mockSearch });
      memorySearchHandler = handlers.memorySearchHandler;
    });

    it('成功搜索应返回格式化结果"找到 N 条相关记忆：..."', async () => {
      // 模拟返回 2 条记忆
      mockSearch.mockResolvedValue([
        { name: 'mem-1', contentPreview: '第一条记忆内容', score: 0.95 },
        { name: 'mem-2', contentPreview: '第二条记忆内容', score: 0.80 },
      ]);

      const result = await memorySearchHandler({ query: '关键词' }, mockCtx);

      expect(result).toContain('找到 2 条相关记忆：');
      expect(result).toContain('[mem-1] 第一条记忆内容 (score: 0.95)');
      expect(result).toContain('[mem-2] 第二条记忆内容 (score: 0.80)');
      // 验证 searcher 被正确调用
      expect(mockSearch).toHaveBeenCalledWith('关键词', 5);
    });

    it('搜索 0 条结果应返回"未找到与 "xxx" 相关的记忆"', async () => {
      mockSearch.mockResolvedValue([]);

      const result = await memorySearchHandler({ query: '不存在的关键词' }, mockCtx);

      expect(result).toBe('未找到与 "不存在的关键词" 相关的记忆');
    });

    it('query 为空字符串应返回"错误：query 参数不能为空"', async () => {
      const result = await memorySearchHandler({ query: '' }, mockCtx);
      expect(result).toBe('错误：query 参数不能为空');
      // 不应调用 searcher
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('query 为纯空格应返回"错误：query 参数不能为空"（trim 后为空）', async () => {
      const result = await memorySearchHandler({ query: '   ' }, mockCtx);
      expect(result).toBe('错误：query 参数不能为空');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('limit 参数解析：数字 "3"→3，负数→5，非数字→5，任意值取 min(limit,10)', async () => {
      mockSearch.mockResolvedValue([]);

      // 合法数字：3 → 3
      await memorySearchHandler({ query: 'test', limit: '3' }, mockCtx);
      expect(mockSearch).toHaveBeenLastCalledWith('test', 3);

      // 负数：-1 → 5（回退默认值）
      await memorySearchHandler({ query: 'test', limit: '-1' }, mockCtx);
      expect(mockSearch).toHaveBeenLastCalledWith('test', 5);

      // 非数字：'abc' → 5（回退默认值）
      await memorySearchHandler({ query: 'test', limit: 'abc' }, mockCtx);
      expect(mockSearch).toHaveBeenLastCalledWith('test', 5);

      // 超大值：20 → min(20, 10) = 10
      await memorySearchHandler({ query: 'test', limit: '20' }, mockCtx);
      expect(mockSearch).toHaveBeenLastCalledWith('test', 10);
    });

    it('searcher 抛异常应返回"错误：记忆搜索失败：..."并记录 logger.warn', async () => {
      mockSearch.mockRejectedValue(new Error('search engine crash'));

      const result = await memorySearchHandler({ query: 'test' }, mockCtx);

      // 返回错误信息给 LLM
      expect(result).toContain('错误：记忆搜索失败：');
      expect(result).toContain('search engine crash');
      // 验证 logger.warn 被调用，记录降级日志
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'search engine crash', query: 'test' }),
        '记忆搜索失败',
      );
    });
  });

  // ─── 4. createSpriteHandlers 工厂（替代原 setMemorySearcher 测试） ───

  describe('createSpriteHandlers 工厂', () => {
    it('注入 searcher 后 memorySearchHandler 可正常调用', async () => {
      const mockSearch = createMockSearcher([
        { name: 'mem-a', contentPreview: '内容A', score: 0.9 },
      ]);
      const { handlers } = createHandlersWithMocks({ searcher: mockSearch });

      const result = await handlers.memorySearchHandler({ query: 'test' }, mockCtx);

      expect(result).toContain('找到 1 条相关记忆：');
      expect(mockSearch).toHaveBeenCalledWith('test', 5);
    });

    it('多实例并行：两次工厂调用产生独立 handlers 闭包（不共享 searcher）', async () => {
      // 模拟多 Agent 实例并行场景（ADR-SP-019，原 HEAL-8 核心目标）
      const mockSearch1 = createMockSearcher([
        { name: 'mem-1', contentPreview: '内容1', score: 0.9 },
      ]);
      const mockSearch2 = createMockSearcher([
        { name: 'mem-2', contentPreview: '内容2', score: 0.8 },
      ]);
      const { handlers: handlers1 } = createHandlersWithMocks({ searcher: mockSearch1 });
      const { handlers: handlers2 } = createHandlersWithMocks({ searcher: mockSearch2 });

      const result1 = await handlers1.memorySearchHandler({ query: 'q1' }, mockCtx);
      const result2 = await handlers2.memorySearchHandler({ query: 'q2' }, mockCtx);

      // 两个实例各自调用各自的 searcher，互不污染
      expect(result1).toContain('[mem-1]');
      expect(result2).toContain('[mem-2]');
      expect(mockSearch1).toHaveBeenCalledWith('q1', 5);
      expect(mockSearch2).toHaveBeenCalledWith('q2', 5);
    });
  });

  // ─── 5. 工具定义常量（3 测试） ────────────────────────

  describe('工具定义常量', () => {
    it('WEB_SEARCH_TOOL：name="web_search"，parameters 含 query（required）', () => {
      expect(WEB_SEARCH_TOOL.name).toBe('web_search');
      expect(WEB_SEARCH_TOOL.description).toBeTruthy();
      expect(WEB_SEARCH_TOOL.parameters.type).toBe('object');
      expect(WEB_SEARCH_TOOL.parameters.properties).toHaveProperty('query');
      expect(WEB_SEARCH_TOOL.parameters.properties!.query!.type).toBe('string');
      expect(WEB_SEARCH_TOOL.parameters.required).toContain('query');
    });

    it('MEMORY_SEARCH_TOOL：name="memory_search"，parameters 含 query（required）+ limit（optional）', () => {
      expect(MEMORY_SEARCH_TOOL.name).toBe('memory_search');
      expect(MEMORY_SEARCH_TOOL.description).toBeTruthy();
      expect(MEMORY_SEARCH_TOOL.parameters.type).toBe('object');
      expect(MEMORY_SEARCH_TOOL.parameters.properties).toHaveProperty('query');
      expect(MEMORY_SEARCH_TOOL.parameters.properties).toHaveProperty('limit');
      expect(MEMORY_SEARCH_TOOL.parameters.properties!.query!.type).toBe('string');
      expect(MEMORY_SEARCH_TOOL.parameters.properties!.limit!.type).toBe('string');
      expect(MEMORY_SEARCH_TOOL.parameters.required).toContain('query');
      // limit 不在 required 中
      expect(MEMORY_SEARCH_TOOL.parameters.required).not.toContain('limit');
    });

    it('两个 Tool 定义的 description 非空且 parameters.type="object"', () => {
      // WEB_SEARCH_TOOL
      expect(WEB_SEARCH_TOOL.description.length).toBeGreaterThan(0);
      expect(WEB_SEARCH_TOOL.parameters.type).toBe('object');

      // MEMORY_SEARCH_TOOL
      expect(MEMORY_SEARCH_TOOL.description.length).toBeGreaterThan(0);
      expect(MEMORY_SEARCH_TOOL.parameters.type).toBe('object');
    });
  });

  // ─── 6. webSearch win32 平台补充 ─────────────────────

  describe('webSearch win32 平台', () => {
    it('win32 平台应构造 cmd /c start "" url 命令', async () => {
      const originalPlatform = process.platform;
      vi.mocked(execFile).mockImplementation(
        (_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
          callback(null);
        }
      );
      try {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        await webSearch('hello');
        expect(execFile).toHaveBeenCalledWith(
          'cmd',
          ['/c', 'start', '', 'https://www.google.com/search?q=hello'],
          expect.any(Function),
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  // ─── 7. memorySearchHandler 非 Error 降级 ─────────────

  describe('memorySearchHandler 非 Error 降级', () => {
    it('searcher reject 非 Error 值（字符串）时应返回 String(err) 形式错误消息', async () => {
      const mockSearch = createMockSearcher();
      // reject 一个非 Error 值，触发 err instanceof Error === false 分支
      mockSearch.mockRejectedValue('搜索服务不可用');
      const { handlers } = createHandlersWithMocks({ searcher: mockSearch });

      const result = await handlers.memorySearchHandler({ query: 'test' }, mockCtx);

      // err instanceof Error === false → String(err) 分支
      expect(result).toBe('错误：记忆搜索失败：搜索服务不可用');
      // logger.warn 仍应记录降级日志
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: '搜索服务不可用', query: 'test' }),
        '记忆搜索失败',
      );
    });
  });

  // ─── 8. createPersonaHandler ─────────────────────────

  describe('createPersonaHandler', () => {
    let mockAgent: ReturnType<typeof createMockAgent>;
    let createPersonaHandler: ReturnType<typeof createSpriteHandlers>['createPersonaHandler'];

    beforeEach(() => {
      // 每个测试通过工厂构造独立 handlers（消除模块级状态）
      mockAgent = createMockAgent();
      const { handlers } = createHandlersWithMocks({ agent: mockAgent });
      createPersonaHandler = handlers.createPersonaHandler;
    });

    it('name 为空时应返回"错误：角色名称不能为空"', async () => {
      const result = await createPersonaHandler({ name: '', content: '内容' }, mockCtx);
      expect(result).toBe('错误：角色名称不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('content 为空时应返回"错误：角色内容不能为空"', async () => {
      const result = await createPersonaHandler({ name: '角色', content: '' }, mockCtx);
      expect(result).toBe('错误：角色内容不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('仅 name+content 时应成功创建，content 等于原始 content，metadata 为 undefined', async () => {
      const result = await createPersonaHandler(
        { name: '写作助手', content: '你是一个写作助手' },
        mockCtx,
      );

      expect(result).toContain('创建成功');
      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith({
        type: 'persona',
        name: '写作助手',
        content: '你是一个写作助手',
        confidence: 0.95,
        metadata: undefined,
      });
    });

    it('带 description 时 content 保持纯正文，metadata.description 携带描述', async () => {
      await createPersonaHandler(
        { name: '角色A', description: '这是一个描述', content: '正文内容' },
        mockCtx,
      );

      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '正文内容',
          metadata: { description: '这是一个描述' },
        }),
      );
    });

    it('带 keywords 时 content 保持纯正文，metadata.keywords 携带关键词', async () => {
      await createPersonaHandler(
        { name: '角色A', keywords: '写作,编辑', content: '正文内容' },
        mockCtx,
      );

      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '正文内容',
          metadata: { keywords: '写作,编辑' },
        }),
      );
    });

    it('同时带 description 和 keywords 时 metadata 包含两个字段', async () => {
      await createPersonaHandler(
        { name: '角色A', description: '描述内容', keywords: '关键词1,关键词2', content: '正文' },
        mockCtx,
      );

      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '正文',
          metadata: { description: '描述内容', keywords: '关键词1,关键词2' },
        }),
      );
    });

    it('成功时应调用 reloadConfig("persona") 并返回含名称/描述/关键词的成功消息', async () => {
      const result = await createPersonaHandler(
        { name: '写作助手', description: '描述', content: '内容', keywords: '写作' },
        mockCtx,
      );

      expect(mockAgent.reloadConfig).toHaveBeenCalledWith('persona');
      expect(result).toContain('角色 "写作助手" 创建成功');
      expect(result).toContain('描述：描述');
      expect(result).toContain('关键词：写作');
    });

    it('confirmConfigSuggestion 抛 Error 时应返回"错误：创建角色失败：..."并记录 logger.warn', async () => {
      mockAgent.config.confirmConfigSuggestion.mockRejectedValue(new Error('配置文件不可写'));

      const result = await createPersonaHandler(
        { name: '角色A', content: '内容' },
        mockCtx,
      );

      expect(result).toBe('错误：创建角色失败：配置文件不可写');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: '配置文件不可写', name: '角色A' }),
        '创建角色失败：配置文件写入异常',
      );
    });

    it('reloadConfig 失败时应返回成功消息 + 热重载推迟提示（不掩盖文件已写入的事实）', async () => {
      mockAgent.reloadConfig.mockRejectedValue(new Error('对话繁忙'));

      const result = await createPersonaHandler(
        { name: '角色B', content: '内容' },
        mockCtx,
      );

      // 文件已成功写入，reloadConfig 失败不应返回错误
      expect(result).toContain('创建成功');
      expect(result).toContain('对话进行中');
      expect(result).toContain('重启后生效');
      // 日志级别为 info（不是 warn），因为文件已写入，只是热重载推迟
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ err: '对话繁忙', name: '角色B', type: 'persona' }),
        '角色文件已写入，热重载推迟（对话进行中）',
      );
    });

    it('reloadConfig reject 非 Error 值时同样返回成功消息', async () => {
      mockAgent.reloadConfig.mockRejectedValue('重载失败');

      const result = await createPersonaHandler(
        { name: '角色B', content: '内容' },
        mockCtx,
      );

      // err instanceof Error === false → toError(err).message = '重载失败'
      expect(result).toContain('创建成功');
      expect(result).toContain('对话进行中');
    });
  });

  // ─── 9. createSkillHandler ──────────────────────────

  describe('createSkillHandler', () => {
    let mockAgent: ReturnType<typeof createMockAgent>;
    let createSkillHandler: ReturnType<typeof createSpriteHandlers>['createSkillHandler'];

    beforeEach(() => {
      mockAgent = createMockAgent();
      const { handlers } = createHandlersWithMocks({ agent: mockAgent });
      createSkillHandler = handlers.createSkillHandler;
    });

    it('name 为空时应返回"错误：技能名称不能为空"', async () => {
      const result = await createSkillHandler({ name: '', content: '内容' }, mockCtx);
      expect(result).toBe('错误：技能名称不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('成功时应调用 confirmConfigSuggestion(type="skill") + reloadConfig("skill")', async () => {
      const result = await createSkillHandler(
        { name: '去AI味', content: '执行去AI味处理' },
        mockCtx,
      );

      expect(result).toContain('创建成功');
      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith({
        type: 'skill',
        name: '去AI味',
        content: '执行去AI味处理',
        confidence: 0.95,
        metadata: undefined,
      });
      expect(mockAgent.reloadConfig).toHaveBeenCalledWith('skill');
    });

    it('成功消息应包含"技能"标签和名称', async () => {
      const result = await createSkillHandler(
        { name: '审视角', description: '审视视角', content: '内容', keywords: '审视' },
        mockCtx,
      );

      expect(result).toContain('技能 "审视角" 创建成功');
      expect(result).toContain('描述：审视视角');
      expect(result).toContain('关键词：审视');
    });

    it('confirmConfigSuggestion 抛异常时应返回"错误：创建技能失败：..."', async () => {
      mockAgent.config.confirmConfigSuggestion.mockRejectedValue(new Error('磁盘已满'));

      const result = await createSkillHandler(
        { name: '技能A', content: '内容' },
        mockCtx,
      );

      expect(result).toBe('错误：创建技能失败：磁盘已满');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: '磁盘已满', name: '技能A' }),
        '创建技能失败：配置文件写入异常',
      );
    });
  });

  // ─── 9b. createRuleHandler ──────────────────────────

  describe('createRuleHandler', () => {
    let mockAgent: ReturnType<typeof createMockAgent>;
    let createRuleHandler: ReturnType<typeof createSpriteHandlers>['createRuleHandler'];

    beforeEach(() => {
      mockAgent = createMockAgent();
      const { handlers } = createHandlersWithMocks({ agent: mockAgent });
      createRuleHandler = handlers.createRuleHandler;
    });

    it('name 为空时应返回"错误：规则名称不能为空"', async () => {
      const result = await createRuleHandler({ name: '', content: '内容' }, mockCtx);
      expect(result).toBe('错误：规则名称不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('content 为空时应返回"错误：规则内容不能为空"', async () => {
      const result = await createRuleHandler({ name: '规则', content: '' }, mockCtx);
      expect(result).toBe('错误：规则内容不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('成功时应调用 confirmConfigSuggestion(type="rule") + reloadConfig("rule")', async () => {
      const result = await createRuleHandler(
        { name: '代码风格', content: '使用 TypeScript strict 模式' },
        mockCtx,
      );

      expect(result).toContain('创建成功');
      expect(mockAgent.config.confirmConfigSuggestion).toHaveBeenCalledWith({
        type: 'rule',
        name: '代码风格',
        content: '使用 TypeScript strict 模式',
        confidence: 0.95,
        metadata: undefined,
      });
      // rule 类型 reloadConfig 是 no-op（agent.ts 内部跳过），但仍会被调用
      expect(mockAgent.reloadConfig).toHaveBeenCalledWith('rule');
    });

    it('成功消息应包含"规则"标签和名称', async () => {
      const result = await createRuleHandler(
        { name: '回复格式', description: '控制回复格式', content: '回复用中文', keywords: '格式' },
        mockCtx,
      );

      expect(result).toContain('规则 "回复格式" 创建成功');
      expect(result).toContain('描述：控制回复格式');
    });

    it('confirmConfigSuggestion 抛异常时应返回"错误：创建规则失败：..."', async () => {
      mockAgent.config.confirmConfigSuggestion.mockRejectedValue(new Error('权限不足'));

      const result = await createRuleHandler(
        { name: '规则A', content: '内容' },
        mockCtx,
      );

      expect(result).toBe('错误：创建规则失败：权限不足');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: '权限不足', name: '规则A' }),
        '创建规则失败：配置文件写入异常',
      );
    });
  });

  // ─── 10. 角色/技能/规则工具定义常量 ─────────────────────────

  describe('角色/技能/规则工具定义常量', () => {
    it('CREATE_PERSONA_TOOL：name="create_persona"，required 含 name+content', () => {
      expect(CREATE_PERSONA_TOOL.name).toBe('create_persona');
      expect(CREATE_PERSONA_TOOL.description).toBeTruthy();
      expect(CREATE_PERSONA_TOOL.parameters.type).toBe('object');
      expect(CREATE_PERSONA_TOOL.parameters.required).toContain('name');
      expect(CREATE_PERSONA_TOOL.parameters.required).toContain('content');
    });

    it('CREATE_PERSONA_TOOL：parameters 含 name/description/content/keywords 四个属性', () => {
      const props = CREATE_PERSONA_TOOL.parameters.properties;
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('content');
      expect(props).toHaveProperty('keywords');
      expect(props.name!.type).toBe('string');
      expect(props.content!.type).toBe('string');
    });

    it('CREATE_SKILL_TOOL：name="create_skill"，required 含 name+content', () => {
      expect(CREATE_SKILL_TOOL.name).toBe('create_skill');
      expect(CREATE_SKILL_TOOL.description).toBeTruthy();
      expect(CREATE_SKILL_TOOL.parameters.type).toBe('object');
      expect(CREATE_SKILL_TOOL.parameters.required).toContain('name');
      expect(CREATE_SKILL_TOOL.parameters.required).toContain('content');
    });

    it('CREATE_SKILL_TOOL：parameters 含 name/description/content/keywords 四个属性', () => {
      const props = CREATE_SKILL_TOOL.parameters.properties;
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('content');
      expect(props).toHaveProperty('keywords');
      expect(props.name!.type).toBe('string');
      expect(props.content!.type).toBe('string');
    });

    it('CREATE_RULE_TOOL：name="create_rule"，required 含 name+content', () => {
      expect(CREATE_RULE_TOOL.name).toBe('create_rule');
      expect(CREATE_RULE_TOOL.description).toBeTruthy();
      expect(CREATE_RULE_TOOL.parameters.type).toBe('object');
      expect(CREATE_RULE_TOOL.parameters.required).toContain('name');
      expect(CREATE_RULE_TOOL.parameters.required).toContain('content');
    });

    it('CREATE_RULE_TOOL：parameters 含 name/description/content/keywords 四个属性', () => {
      const props = CREATE_RULE_TOOL.parameters.properties;
      expect(props).toHaveProperty('name');
      expect(props).toHaveProperty('description');
      expect(props).toHaveProperty('content');
      expect(props).toHaveProperty('keywords');
      expect(props.name!.type).toBe('string');
      expect(props.content!.type).toBe('string');
    });
  });

  // ─── 11. 参数 undefined 降级（?? '' 分支覆盖） ─────────

  describe('参数 undefined 降级', () => {
    it('memorySearchHandler: args.query 未传 key 时应走 ?? "" 分支返回空值错误', async () => {
      const mockSearch = createMockSearcher();
      const { handlers } = createHandlersWithMocks({ searcher: mockSearch });

      // 不传 query key → args.query 为 undefined → ?? '' 触发右操作数
      const result = await handlers.memorySearchHandler({}, mockCtx);

      expect(result).toBe('错误：query 参数不能为空');
      expect(mockSearch).not.toHaveBeenCalled();
    });

    it('createPersonaHandler: args.name 未传 key 时应走 ?? "" 分支返回名称错误', async () => {
      const mockAgent = createMockAgent();
      const { handlers } = createHandlersWithMocks({ agent: mockAgent });

      // 不传 name key → args.name 为 undefined → ?? '' 触发右操作数
      const result = await handlers.createPersonaHandler({ content: '内容' }, mockCtx);

      expect(result).toBe('错误：角色名称不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });

    it('createPersonaHandler: args.content 未传 key 时应走 ?? "" 分支返回内容错误', async () => {
      const mockAgent = createMockAgent();
      const { handlers } = createHandlersWithMocks({ agent: mockAgent });

      // 不传 content key → args.content 为 undefined → ?? '' 触发右操作数
      const result = await handlers.createPersonaHandler({ name: '角色' }, mockCtx);

      expect(result).toBe('错误：角色内容不能为空');
      expect(mockAgent.config.confirmConfigSuggestion).not.toHaveBeenCalled();
    });
  });
});