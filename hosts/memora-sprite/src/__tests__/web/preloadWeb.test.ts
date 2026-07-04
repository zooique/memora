/**
 * Web 版 preload 接口契约测试
 *
 * 覆盖范围：
 * - webElectronAPI 各方法正确调用 fetch 并返回 Promise
 *   - 对话：loadSession / listSessions / switchSession / deleteSession / renameSession
 *   - Agent 状态：getAgentStatus
 *   - LLM 配置：getLlmConfig / saveLlmConfig / testLlmConfig
 *   - 记忆：listMemories / searchMemories / showMemory / deleteMemory / addMemory
 *           deleteMemoriesBatch / getRelationGraph / addRelation / removeRelation /
 *           updateRelation / getHealthDashboard / getReviewData
 *   - 配置：getConfig / updateConfig
 *   - 角色：listPersonas / switchPersona
 *   - 项目：listProjects / 仪表盘：getDashboard
 * - 原生能力降级（windowMinimize / windowClose / clipboardAnalyze 等）→ noop 或返回 false
 * - notifyThemeChanged 写入 localStorage
 * - rendererLog 调用 console.error
 * - injectWebElectronAPI 在 window 存在时注入 / 不存在时不抛错
 *
 * Mock 策略：
 * - global.fetch：vi.stubGlobal 捕获调用参数
 * - global.localStorage：vi.stubGlobal 捕获 setItem 调用
 * - global.console：vi.spyOn 捕获 error 调用
 * - global.window：仅在 injectWebElectronAPI 测试中 stubGlobal
 *
 * 注意：preloadWeb.ts 在模块加载时会执行 `if (typeof window !== 'undefined') injectWebElectronAPI()`，
 * vitest 的 environment: 'node' 下 window 默认 undefined，不会自动注入。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 导入被测模块（在 node 环境下 window 为 undefined，自动注入不会执行）
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

// ─── 测试用例 ─────────────────────────────────────────────

describe('webElectronAPI', () => {
  /** fetch mock 实例（每个测试用例前重置） */
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = createFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
  });

  // ─── Agent 状态 ────────────────────────────────────────

  describe('Agent 状态', () => {
    it('getAgentStatus 应发起 GET /api/agent-status 请求', async () => {
      await webElectronAPI.getAgentStatus();

      expect(fetchMock).toHaveBeenCalledWith('/api/agent-status');
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
  });

  // ─── 项目与仪表盘 ──────────────────────────────────────

  describe('项目与仪表盘', () => {
    it('listProjects 应发起 GET /api/projects 请求', async () => {
      await webElectronAPI.listProjects();

      expect(fetchMock).toHaveBeenCalledWith('/api/projects');
    });

    it('getDashboard 应发起 GET /api/dashboard 请求', async () => {
      await webElectronAPI.getDashboard();

      expect(fetchMock).toHaveBeenCalledWith('/api/dashboard');
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

    it('流式监听 onStreamStart 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onStreamStart(() => {})).not.toThrow();
    });

    it('removeStreamListeners 应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.removeStreamListeners()).not.toThrow();
    });

    it('浮动窗口相关方法应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.moveFloatWindow(10, 20)).not.toThrow();
      expect(() => webElectronAPI.saveFloatPosition()).not.toThrow();
      expect(() => webElectronAPI.expandToFull()).not.toThrow();
      expect(() => webElectronAPI.showFloatContextMenu()).not.toThrow();
    });

    it('全局快捷键监听应为 noop（不抛错）', () => {
      expect(() => webElectronAPI.onQuickRecordTrigger(() => {})).not.toThrow();
      expect(() => webElectronAPI.onRecallMemoryTrigger(() => {})).not.toThrow();
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

    it('listWorkProjections 应返回空数组', async () => {
      const result = await webElectronAPI.listWorkProjections();
      expect(result).toEqual([]);
    });

    it('listAuditLog 应返回空数组', async () => {
      const result = await webElectronAPI.listAuditLog();
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
    /** 静默 console.log 避免测试输出污染 */
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    injectWebElectronAPI();

    expect(mockWindow.electronAPI).toBe(webElectronAPI);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('window 不存在时应不抛错（Node 环境）', () => {
    // window 默认不存在（vitest environment: 'node'）
    // 确保 unstub 后 window 为 undefined
    vi.unstubAllGlobals();

    expect(() => injectWebElectronAPI()).not.toThrow();
  });
});
