/**
 * 最小化 IPC 处理器测试
 *
 * 覆盖范围：Agent 未就绪时的 15 个最小化 IPC handler
 * - CONFIG_GET：成功返回配置 + 加载失败降级默认配置
 * - AGENT_STATUS：就绪/未就绪状态查询
 * - LLM_CONFIG_TEST：连接成功 + 空响应 + 失败降级 + 参数校验
 * - LLM_CONFIG_GET：已配置 + 未配置 + 加载失败降级 + background/embedding 分支 + apiKey 脱敏
 * - LLM_CONFIG_SAVE：成功完整链路 + 中断进行中对话 + 失败降级 + 参数校验 + 跳过 reinit
 * - LLM_PROVIDER_LIST：成功 + 失败降级
 * - LLM_PROVIDER_SAVE：参数校验 + agentReady 分支 + reinit 成功/失败
 * - LLM_PROVIDER_DELETE：参数校验 + 非 active + active 切换 + 失败降级
 * - LLM_PROVIDER_SET_ACTIVE：参数校验 + Provider 不存在 + Agent 未就绪 + 前后台切换 + 失败降级
 * - WRITE_CONFIRMATION_RESPONSE：找到/未找到 requestId
 * - AUDIT_LOG_LIST：auditManager 存在/null 降级 + limit 边界
 * - AUDIT_LOG_CLEAR：auditManager 存在/null 降级
 * - PROJECTS_LIST：始终返回空数组
 * - THEME_CHANGED：light/dark 主题 + windowManager undefined
 * - RENDERER_LOG：warn/error 级别日志转发 + 参数校验
 *
 * Mock 策略：
 * - electron.ipcMain：handle + on 双回调捕获 Map
 * - memora：createProviderFromConfig / toError / logger
 * - spriteConfig：loadSpriteConfig / DEFAULT_SPRITE_CONFIG
 * - spriteConfigStore：isConfigured / load / resolveProviderConfig
 * - index（宿主入口）：saveLlmConfig / reinitAgent / PROVIDER_PRESETS / getLlmProviders / saveLlmProvider / deleteLlmProvider / setActiveLlmProvider
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── vi.hoisted：vi.mock 被 hoisted，引用变量需用 vi.hoisted 声明 ──
const { handleCallbacks, onCallbacks, mockLogger, mockErrorHandler, mockSpriteConfigStore, mockSaveLlmConfig, mockReinitAgent, mockLoadSpriteConfig, DEFAULT_SPRITE_CONFIG, PROVIDER_PRESETS, mockGetLlmProviders, mockSaveLlmProvider, mockDeleteLlmProvider, mockSetActiveLlmProvider, mockResolveProviderConfig } = vi.hoisted(() => {
  const handleCallbacks = new Map<string, (...args: unknown[]) => unknown>();
  const onCallbacks = new Map<string, (...args: unknown[]) => void>();
  const mockLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const mockErrorHandler = { handle: vi.fn() };
  const mockSpriteConfigStore = {
    isConfigured: vi.fn<() => Promise<boolean>>(),
    load: vi.fn<() => Promise<unknown>>(),
  };
  const mockSaveLlmConfig = vi.fn<() => Promise<void>>();
  const mockReinitAgent = vi.fn<() => Promise<{
    agent: unknown;
    sprite: unknown;
    sessionStore: unknown;
    close: () => Promise<void>;
    dataDir: string;
  }>>();
  const mockLoadSpriteConfig = vi.fn(() => ({ silentMode: true }));
  const DEFAULT_SPRITE_CONFIG = { silentMode: false, silentModeExpiresAt: null };
  const PROVIDER_PRESETS = [{ name: 'OpenAI', value: 'openai' }];
  // 多 Provider 管理 IPC 的 mock
  const mockGetLlmProviders = vi.fn<() => Promise<unknown>>();
  const mockSaveLlmProvider = vi.fn<() => Promise<void>>();
  const mockDeleteLlmProvider = vi.fn<() => Promise<void>>();
  const mockSetActiveLlmProvider = vi.fn<() => Promise<void>>();
  // resolveProviderConfig 是纯函数，mock 为可控返回值
  const mockResolveProviderConfig = vi.fn<(config: unknown, key: string) => unknown>();
  return { handleCallbacks, onCallbacks, mockLogger, mockErrorHandler, mockSpriteConfigStore, mockSaveLlmConfig, mockReinitAgent, mockLoadSpriteConfig, DEFAULT_SPRITE_CONFIG, PROVIDER_PRESETS, mockGetLlmProviders, mockSaveLlmProvider, mockDeleteLlmProvider, mockSetActiveLlmProvider, mockResolveProviderConfig };
});

// ─── Mock electron 模块（handle + on 双回调捕获） ────────
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, callback: (...args: unknown[]) => unknown) => {
      handleCallbacks.set(channel, callback);
    }),
    removeHandler: vi.fn((channel: string) => {
      handleCallbacks.delete(channel);
    }),
    on: vi.fn((channel: string, callback: (...args: unknown[]) => void) => {
      onCallbacks.set(channel, callback);
    }),
    removeAllListeners: vi.fn(),
  },
}));

// ─── Mock memora 核心库 ─────────────────────────────────
vi.mock('memora', () => ({
  createProviderFromConfig: vi.fn(),
  toError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err;
    return new Error(String(err));
  }),
  logger: mockLogger,
}));

// ─── Mock errorHandler ──────────────────────────────────
vi.mock('../../../electron/errorHandler.js', () => ({
  errorHandler: mockErrorHandler,
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    INITIALIZATION_FAILED: 'INITIALIZATION_FAILED',
  },
}));

// ─── Mock spriteConfig ─────────────────────────────────

vi.mock('../../../sprite/spriteConfig.js', () => ({
  loadSpriteConfig: vi.fn(() => mockLoadSpriteConfig()),
  DEFAULT_SPRITE_CONFIG,
}));

// ─── Mock spriteConfigStore ─────────────────────────────
vi.mock('../../../storage/spriteConfigStore.js', () => ({
  spriteConfigStore: mockSpriteConfigStore,
  resolveProviderConfig: mockResolveProviderConfig,
}));

// ─── Mock index（宿主入口） ──────────────────────────────

vi.mock('../../../index.js', () => ({
  saveLlmConfig: mockSaveLlmConfig,
  reinitAgent: mockReinitAgent,
  PROVIDER_PRESETS,
  getLlmProviders: mockGetLlmProviders,
  saveLlmProvider: mockSaveLlmProvider,
  deleteLlmProvider: mockDeleteLlmProvider,
  setActiveLlmProvider: mockSetActiveLlmProvider,
}));

import { registerMinimalIpcHandlers } from '../../../electron/ipc/minimalHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
// MinimalIpcState / MinimalIpcCallbacks 真理源在 ipc/types.ts
import type { MinimalIpcState, MinimalIpcCallbacks } from '../../../electron/ipc/types.js';
import { createProviderFromConfig } from 'memora';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建默认 MinimalIpcState */
function createState(overrides?: Partial<MinimalIpcState>): MinimalIpcState {
  return {
    agentReady: false,
    initErrorDetail: null,
    currentAbortController: null,
    currentDataDir: '/tmp/test-data',
    pendingWriteConfirmations: new Map(),
    closeSprite: null,
    auditManager: null,
    windowManager: undefined,
    ...overrides,
  };
}

/** 创建默认 MinimalIpcCallbacks */
function createCallbacks(overrides?: Partial<MinimalIpcCallbacks>): MinimalIpcCallbacks {
  return {
    setAppRuntime: vi.fn(),
    setupAgentReady: vi.fn(),
    classifyInitError: vi.fn((msg: string) => msg),
    getCurrentAgent: vi.fn(() => null),
    ...overrides,
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('registerMinimalIpcHandlers', () => {
  beforeEach(() => {
    handleCallbacks.clear();
    onCallbacks.clear();
    vi.clearAllMocks();
  });

  // ─── CONFIG_GET ────────────────────────────────────────

  describe('CONFIG_GET', () => {
    it('应返回精灵配置', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockLoadSpriteConfig.mockImplementation(() => ({ silentMode: true, proactiveThreshold: 5 }));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_GET)!;
      const result = await callback();

      expect(result).toEqual({ config: { silentMode: true, proactiveThreshold: 5 } });
    });

    it('加载失败应降级返回 DEFAULT_SPRITE_CONFIG', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockLoadSpriteConfig.mockImplementation(() => {
        throw new Error('文件损坏');
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.CONFIG_GET)!;
      const result = await callback();

      expect(result.config).toEqual(DEFAULT_SPRITE_CONFIG);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ─── AGENT_STATUS ──────────────────────────────────────

  describe('AGENT_STATUS', () => {
    it('agentReady=true 应返回就绪状态', async () => {
      const state = createState({ agentReady: true, initErrorDetail: null });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AGENT_STATUS)!;
      const result = await callback();

      expect(result).toEqual({ ready: true, error: null });
    });

    it('agentReady=false 应返回未就绪状态 + 错误详情', async () => {
      const state = createState({
        agentReady: false,
        initErrorDetail: 'API Key 无效',
      });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AGENT_STATUS)!;
      const result = await callback();

      expect(result).toEqual({ ready: false, error: 'API Key 无效' });
    });
  });

  // ─── LLM_CONFIG_TEST ───────────────────────────────────

  describe('LLM_CONFIG_TEST', () => {
    const llmConfig = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    };

    it('连接成功应返回 success=true', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      // 模拟 provider.chat 返回非空 stream
      const mockProvider = {
        chat: vi.fn(() => ({
          [Symbol.asyncIterator]: () => {
            let called = false;
            return {
              next: async () => {
                if (!called) {
                  called = true;
                  return { done: false, value: { content: 'pong' } };
                }
                return { done: true, value: undefined };
              },
            };
          },
        })),
      };
      vi.mocked(createProviderFromConfig).mockReturnValue(mockProvider as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_TEST)!;
      const result = await callback({}, llmConfig);

      expect(result).toEqual({ success: true, error: null });
      expect(createProviderFromConfig).toHaveBeenCalledWith('test', {
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      });
    });

    it('空响应应返回 success=false', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      const mockProvider = {
        chat: vi.fn(() => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true, value: undefined }),
          }),
        })),
      };
      vi.mocked(createProviderFromConfig).mockReturnValue(mockProvider as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_TEST)!;
      const result = await callback({}, llmConfig);

      expect(result.success).toBe(false);
      expect(result.error).toContain('空响应');
    });

    it('provider.chat 抛错应返回 success=false', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      const mockProvider = {
        chat: vi.fn(() => {
          throw new Error('连接超时');
        }),
      };
      vi.mocked(createProviderFromConfig).mockReturnValue(mockProvider as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_TEST)!;
      const result = await callback({}, llmConfig);

      expect(result.success).toBe(false);
      expect(result.error).toBe('连接超时');
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ─── LLM_CONFIG_GET ────────────────────────────────────

  describe('LLM_CONFIG_GET', () => {
    it('已配置时应返回完整 config + configured=true', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.isConfigured.mockResolvedValue(true);
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: {
          provider: 'openai',
          model: 'gpt-4',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          temperature: 0.7,
        },
        memory: { dataDir: '/tmp', maxContextTokens: 120000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_GET)!;
      const result = await callback();

      expect(result.configured).toBe(true);
      expect(result.config.provider).toBe('openai');
      expect(result.config.model).toBe('gpt-4');
      expect(result.presets).toEqual(PROVIDER_PRESETS);
    });

    it('未配置时应返回 configured=false + null config', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.isConfigured.mockResolvedValue(false);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_GET)!;
      const result = await callback();

      expect(result.configured).toBe(false);
      expect(result.config).toBeNull();
      expect(result.presets).toEqual(PROVIDER_PRESETS);
    });

    it('加载失败应降级返回 configured=false', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.isConfigured.mockRejectedValue(new Error('读取失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_GET)!;
      const result = await callback();

      expect(result.configured).toBe(false);
      expect(result.config).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ─── LLM_CONFIG_SAVE ───────────────────────────────────

  describe('LLM_CONFIG_SAVE', () => {
    const llmConfig = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    };

    it('成功应走完整链路：save → abort → reinit → setAppRuntime → setupAgentReady', async () => {
      const state = createState({ currentAbortController: null });
      const callbacks = createCallbacks();
      const reinitResult = {
        agent: { id: 'agent' },
        sprite: { name: 'sprite' },
        sessionStore: { name: 'store' },
        close: vi.fn(),
        dataDir: '/tmp/new-data',
      };
      mockSaveLlmConfig.mockResolvedValue(undefined);
      mockReinitAgent.mockResolvedValue(reinitResult);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_SAVE)!;
      const result = await callback({}, llmConfig);

      // 验证完整链路
      expect(mockSaveLlmConfig).toHaveBeenCalledWith(llmConfig, undefined);
      expect(mockReinitAgent).toHaveBeenCalledWith(null);
      expect(state.currentDataDir).toBe('/tmp/new-data');
      expect(callbacks.setAppRuntime).toHaveBeenCalledWith({
        agent: reinitResult.agent,
        sprite: reinitResult.sprite,
        sessionStore: reinitResult.sessionStore,
        close: reinitResult.close,
      });
      expect(callbacks.setupAgentReady).toHaveBeenCalledWith(
        reinitResult.agent,
        reinitResult.sprite,
        reinitResult.sessionStore,
        '/tmp/new-data',
      );
      expect(result).toEqual({ success: true, error: null, reinit: true });
    });

    it('有进行中对话时应先中断再重新初始化', async () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const state = createState({ currentAbortController: abortController });
      const callbacks = createCallbacks();
      mockSaveLlmConfig.mockResolvedValue(undefined);
      mockReinitAgent.mockResolvedValue({
        agent: {},
        sprite: {},
        sessionStore: {},
        close: vi.fn(),
        dataDir: '/tmp/data',
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_SAVE)!;
      await callback({}, llmConfig);

      expect(abortSpy).toHaveBeenCalled();
      expect(state.currentAbortController).toBeNull();
    });

    it('reinitAgent 失败应设置 agentReady=false + 调用 errorHandler + classifyInitError', async () => {
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        classifyInitError: vi.fn((msg: string) => `分类后: ${msg}`),
      });
      mockSaveLlmConfig.mockResolvedValue(undefined);
      mockReinitAgent.mockRejectedValue(new Error('初始化失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_SAVE)!;
      const result = await callback({}, llmConfig);

      expect(state.agentReady).toBe(false);
      expect(callbacks.setAppRuntime).toHaveBeenCalledWith(null);
      expect(state.initErrorDetail).toBe('分类后: 初始化失败');
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: '初始化失败' });
    });
  });

  // ─── WRITE_CONFIRMATION_RESPONSE ───────────────────────

  describe('WRITE_CONFIRMATION_RESPONSE', () => {
    it('找到 requestId 应 resolve 并清理 Map', async () => {
      const resolve = vi.fn();
      const pendingWriteConfirmations = new Map<string, (confirmed: boolean) => void>();
      pendingWriteConfirmations.set('req-001', resolve);
      const state = createState({ pendingWriteConfirmations });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE)!;
      await callback({}, 'req-001', true);

      expect(resolve).toHaveBeenCalledWith(true);
      expect(pendingWriteConfirmations.has('req-001')).toBe(false);
    });

    it('未知 requestId 应仅记录 warn 日志', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE)!;
      await callback({}, 'unknown-id', false);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'unknown-id' }),
        expect.stringContaining('未知'),
      );
    });
  });

  // ─── AUDIT_LOG_LIST ────────────────────────────────────

  describe('AUDIT_LOG_LIST', () => {
    it('auditManager=null 应返回空数组', async () => {
      const state = createState({ auditManager: null });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_LIST)!;
      const result = await callback({}, 20);

      expect(result).toEqual([]);
    });

    it('auditManager 存在时应调用 readRecent 并返回结果', async () => {
      const logs = [{ id: '1', action: 'test' }];
      const auditManager = {
        readRecent: vi.fn(() => logs),
        clear: vi.fn(),
      };
      const state = createState({ auditManager: auditManager as never });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_LIST)!;
      const result = await callback({}, 20);

      expect(auditManager.readRecent).toHaveBeenCalledWith(20);
      expect(result).toEqual(logs);
    });

    it('limit 为非数字时应使用默认值 50', async () => {
      const auditManager = {
        readRecent: vi.fn(() => []),
        clear: vi.fn(),
      };
      const state = createState({ auditManager: auditManager as never });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_LIST)!;
      await callback({}, 'invalid');

      expect(auditManager.readRecent).toHaveBeenCalledWith(50);
    });
  });

  // ─── AUDIT_LOG_CLEAR ───────────────────────────────────

  describe('AUDIT_LOG_CLEAR', () => {
    it('auditManager=null 应无操作（不抛错）', async () => {
      const state = createState({ auditManager: null });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_CLEAR)!;
      await expect(callback()).resolves.toBeUndefined();
    });

    it('auditManager 存在时应调用 clear', async () => {
      const clear = vi.fn();
      const auditManager = { readRecent: vi.fn(), clear };
      const state = createState({ auditManager: auditManager as never });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_CLEAR)!;
      await callback();

      expect(clear).toHaveBeenCalled();
    });
  });

  // ─── PROJECTS_LIST ─────────────────────────────────────

  describe('PROJECTS_LIST', () => {
    it('应始终返回空数组', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.PROJECTS_LIST)!;
      const result = await callback();

      expect(result).toEqual({ projects: [] });
    });
  });

  // ─── THEME_CHANGED（ipcMain.on） ───────────────────────

  describe('THEME_CHANGED', () => {
    it('light 主题应设置浅色背景色', () => {
      const updateBackgroundColor = vi.fn();
      const windowManager = { updateBackgroundColor } as never;
      const state = createState({ windowManager });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
      callback({} as never, 'light');

      expect(updateBackgroundColor).toHaveBeenCalledWith('#f0f0f2');
    });

    it('dark 主题应设置深色背景色', () => {
      const updateBackgroundColor = vi.fn();
      const windowManager = { updateBackgroundColor } as never;
      const state = createState({ windowManager });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
      callback({} as never, 'dark');

      expect(updateBackgroundColor).toHaveBeenCalledWith('#1e1e2e');
    });

    it('windowManager=undefined 不应抛错', () => {
      const state = createState({ windowManager: undefined });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.THEME_CHANGED)!;
      expect(() => callback({} as never, 'dark')).not.toThrow();
    });
  });

  // ─── RENDERER_LOG（ipcMain.on） ────────────────────────

  describe('RENDERER_LOG', () => {
    it('level=warn 应调用 logger.warn', () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.RENDERER_LOG)!;
      callback({} as never, {
        level: 'warn',
        context: 'renderer',
        message: '渲染进程警告',
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { context: 'renderer', source: 'renderer' },
        '渲染进程警告',
      );
    });

    it('level=error 应调用 logger.error', () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.RENDERER_LOG)!;
      callback({} as never, {
        level: 'error',
        context: 'renderer',
        message: '渲染进程错误',
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        { context: 'renderer', source: 'renderer' },
        '渲染进程错误',
      );
    });
  });

  // ─── LLM_CONFIG_TEST（补充：参数校验） ─────────────────

  describe('LLM_CONFIG_TEST 参数校验', () => {
    it('llmConfig 为 null 应返回参数无效且不创建 Provider', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_TEST)!;
      const result = await callback({}, null);

      expect(result).toEqual({ success: false, error: '配置参数无效' });
      expect(createProviderFromConfig).not.toHaveBeenCalled();
    });

    it('apiKey 超长（>1000 字符）应返回参数无效', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_TEST)!;
      const longApiKey = 'x'.repeat(1001);
      const result = await callback({}, {
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: '',
        apiKey: longApiKey,
      });

      expect(result).toEqual({ success: false, error: '配置参数无效' });
      expect(createProviderFromConfig).not.toHaveBeenCalled();
    });
  });

  // ─── LLM_CONFIG_GET（补充：background/embedding 分支 + 脱敏） ──

  describe('LLM_CONFIG_GET 扩展分支', () => {
    it('配置了 background 时应返回 background 字段（enabled=true + 脱敏）', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.isConfigured.mockResolvedValue(true);
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: {
          provider: 'openai',
          model: 'gpt-4',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-test',
          temperature: 0.7,
          background: {
            provider: 'anthropic',
            model: 'claude-3',
            baseUrl: '',
            apiKey: 'sk-bg-test',
            temperature: 0.5,
          },
        },
        memory: { dataDir: '/tmp', maxContextTokens: 120000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_GET)!;
      const result = await callback();

      expect(result.configured).toBe(true);
      expect(result.config.background).toEqual({
        enabled: true,
        provider: 'anthropic',
        model: 'claude-3',
        baseUrl: '',
        // 'sk-bg-test' 长度 10 > 8，脱敏：前 3 + **** + 后 4
        apiKey: 'sk-****test',
        temperature: 0.5,
      });
    });

    it('配置了 embedding + 长 apiKey 时应返回脱敏后的字段（前3+****+后4）', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.isConfigured.mockResolvedValue(true);
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: {
          provider: 'openai',
          model: 'gpt-4',
          baseUrl: '',
          apiKey: 'sk-supersecretkey',
          temperature: 0.7,
        },
        embedding: {
          model: 'text-embedding-3',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-embedding-key-12345',
        },
        memory: { dataDir: '/tmp', maxContextTokens: 120000 },
        security: { permission: 'owner', confirmWrites: false },
        allowedPaths: [],
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_GET)!;
      const result = await callback();

      // 长 apiKey 脱敏：前 3 + **** + 后 4
      // 'sk-supersecretkey'（17 字符）→ 'sk-' + '****' + 'tkey'
      expect(result.config.apiKey).toBe('sk-****tkey');
      expect(result.embedding).toEqual({
        model: 'text-embedding-3',
        baseUrl: 'https://api.openai.com/v1',
        // 'sk-embedding-key-12345'（22 字符）→ 'sk-' + '****' + '2345'
        apiKey: 'sk-****2345',
      });
    });
  });

  // ─── LLM_CONFIG_SAVE（补充：参数校验 + 跳过 reinit） ────

  describe('LLM_CONFIG_SAVE 扩展分支', () => {
    const llmConfig = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    };

    it('llmConfig 为 null 应返回参数无效且不保存', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_SAVE)!;
      const result = await callback({}, null);

      expect(result).toEqual({ success: false, error: '配置参数无效' });
      expect(mockSaveLlmConfig).not.toHaveBeenCalled();
    });

    it('provider/model/baseUrl/apiKey 全部未变化时 needsReinit=false 不触发 reinit', async () => {
      const mockAgent = { id: 'agent' };
      const state = createState({
        agentReady: true,
        lastProvider: 'openai',
        lastModel: 'gpt-4',
        lastBaseUrl: 'https://api.openai.com/v1',
        lastApiKey: 'sk-test',
      });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => mockAgent as never),
      });
      mockSaveLlmConfig.mockResolvedValue(undefined);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_CONFIG_SAVE)!;
      // 仅 temperature 变化，不应触发 reinit
      const result = await callback({}, { ...llmConfig, temperature: 0.9 });

      expect(mockSaveLlmConfig).toHaveBeenCalled();
      expect(mockReinitAgent).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null, reinit: false });
    });
  });

  // ─── LLM_PROVIDER_LIST ────────────────────────────────

  describe('LLM_PROVIDER_LIST', () => {
    it('成功应返回 providers 列表', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      const providers = { active: 'default', providers: [{ key: 'default', provider: 'openai' }] };
      mockGetLlmProviders.mockResolvedValue(providers);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_LIST)!;
      const result = await callback();

      expect(result).toEqual(providers);
      expect(mockGetLlmProviders).toHaveBeenCalled();
    });

    it('读取失败应降级返回 { active: "", providers: [] }', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockGetLlmProviders.mockRejectedValue(new Error('读取失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_LIST)!;
      const result = await callback();

      expect(result).toEqual({ active: '', providers: [] });
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // ─── LLM_PROVIDER_SAVE ───────────────────────────────

  describe('LLM_PROVIDER_SAVE', () => {
    const providerConfig = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    };

    it('空 key 应返回参数无效', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SAVE)!;
      const result = await callback({}, '', providerConfig);

      expect(result).toEqual({ success: false, error: '参数无效' });
      expect(mockSaveLlmProvider).not.toHaveBeenCalled();
    });

    it('无 apiKey 应返回参数无效', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SAVE)!;
      const result = await callback({}, 'key1', { ...providerConfig, apiKey: '' });

      expect(result).toEqual({ success: false, error: '参数无效' });
      expect(mockSaveLlmProvider).not.toHaveBeenCalled();
    });

    it('agentReady=true 时保存后不触发 reinit', async () => {
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks();
      mockSaveLlmProvider.mockResolvedValue(undefined);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SAVE)!;
      const result = await callback({}, 'key1', providerConfig);

      expect(mockSaveLlmProvider).toHaveBeenCalledWith('key1', providerConfig);
      expect(mockReinitAgent).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null });
    });

    it('agentReady=false 时保存后应触发 reinit 并更新配置缓存', async () => {
      const state = createState({ agentReady: false });
      const callbacks = createCallbacks();
      mockSaveLlmProvider.mockResolvedValue(undefined);
      const reinitResult = {
        agent: { id: 'agent' },
        sprite: {},
        sessionStore: {},
        close: vi.fn(),
        dataDir: '/tmp/new',
      };
      mockReinitAgent.mockResolvedValue(reinitResult);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SAVE)!;
      const result = await callback({}, 'key1', providerConfig);

      expect(mockReinitAgent).toHaveBeenCalled();
      expect(state.lastProvider).toBe('openai');
      expect(state.lastModel).toBe('gpt-4');
      expect(state.lastApiKey).toBe('sk-test');
      expect(callbacks.setupAgentReady).toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null });
    });

    it('reinit 失败应重置状态、记录错误并调用 errorHandler', async () => {
      const state = createState({ agentReady: false });
      const callbacks = createCallbacks({
        classifyInitError: vi.fn((msg: string) => `分类: ${msg}`),
      });
      mockSaveLlmProvider.mockResolvedValue(undefined);
      mockReinitAgent.mockRejectedValue(new Error('初始化失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SAVE)!;
      const result = await callback({}, 'key1', providerConfig);

      expect(state.agentReady).toBe(false);
      expect(state.initErrorDetail).toBe('分类: 初始化失败');
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: '初始化失败' });
    });
  });

  // ─── LLM_PROVIDER_DELETE ─────────────────────────────

  describe('LLM_PROVIDER_DELETE', () => {
    it('空 key 应返回参数无效', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_DELETE)!;
      const result = await callback({}, '');

      expect(result).toEqual({ success: false, error: '参数无效' });
      expect(mockDeleteLlmProvider).not.toHaveBeenCalled();
    });

    it('删除非 active Provider 不触发运行时切换', async () => {
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => ({ setProvider: vi.fn() } as never)),
      });
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: { active: 'other-key', providers: {} },
      });
      mockDeleteLlmProvider.mockResolvedValue(undefined);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_DELETE)!;
      const result = await callback({}, 'key1');

      expect(mockDeleteLlmProvider).toHaveBeenCalledWith('key1');
      expect(createProviderFromConfig).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null });
    });

    it('删除 active Provider 且 agentReady=true 应切换到新 Provider', async () => {
      const setProvider = vi.fn();
      const mockAgent = { setProvider };
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => mockAgent as never),
      });
      // 删除前 active=key1，删除后 active=key2
      mockSpriteConfigStore.load
        .mockResolvedValueOnce({ llm: { active: 'key1', providers: {} } })
        .mockResolvedValueOnce({ llm: { active: 'key2', providers: {} } });
      mockDeleteLlmProvider.mockResolvedValue(undefined);
      mockResolveProviderConfig.mockReturnValue({
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-new',
      });
      vi.mocked(createProviderFromConfig).mockReturnValue({} as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_DELETE)!;
      const result = await callback({}, 'key1');

      expect(mockResolveProviderConfig).toHaveBeenCalled();
      expect(createProviderFromConfig).toHaveBeenCalledWith('key2', expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-new',
      }));
      expect(setProvider).toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null });
    });

    it('删除抛错应返回失败并附带错误消息', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSpriteConfigStore.load.mockResolvedValue({ llm: { active: 'other', providers: {} } });
      mockDeleteLlmProvider.mockRejectedValue(new Error('删除失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_DELETE)!;
      const result = await callback({}, 'key1');

      expect(result).toEqual({ success: false, error: '删除失败' });
    });
  });

  // ─── LLM_PROVIDER_SET_ACTIVE ─────────────────────────

  describe('LLM_PROVIDER_SET_ACTIVE', () => {
    it('空 key 应返回参数无效', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, '');

      expect(result).toEqual({ success: false, error: '参数无效' });
      expect(mockSetActiveLlmProvider).not.toHaveBeenCalled();
    });

    it('Provider 不存在应返回失败', async () => {
      const state = createState();
      const callbacks = createCallbacks();
      mockSetActiveLlmProvider.mockResolvedValue(undefined);
      mockSpriteConfigStore.load.mockResolvedValue({ llm: { providers: {} } });
      mockResolveProviderConfig.mockReturnValue(undefined);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, 'missing-key');

      expect(result).toEqual({ success: false, error: 'Provider "missing-key" 不存在' });
    });

    it('Agent 未就绪（currentAgent=null）应返回 warning（active 已持久化）', async () => {
      const state = createState({ agentReady: false });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => null),
      });
      mockSetActiveLlmProvider.mockResolvedValue(undefined);
      mockSpriteConfigStore.load.mockResolvedValue({ llm: { providers: {} } });
      mockResolveProviderConfig.mockReturnValue({
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: '',
        apiKey: 'sk-test',
      });
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, 'key1');

      expect(result).toEqual({
        success: true,
        error: null,
        warning: 'Agent 尚未就绪，已保存为默认 Provider，将在下次初始化时生效',
      });
    });

    it('成功切换前台 + 后台 Provider', async () => {
      const setProvider = vi.fn();
      const setBackgroundProvider = vi.fn();
      const mockAgent = { setProvider, setBackgroundProvider };
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => mockAgent as never),
      });
      mockSetActiveLlmProvider.mockResolvedValue(undefined);
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: {
          providers: {},
          background: {
            provider: 'anthropic',
            model: 'claude-3',
            baseUrl: '',
            apiKey: 'sk-bg',
          },
        },
      });
      mockResolveProviderConfig.mockReturnValue({
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      });
      vi.mocked(createProviderFromConfig).mockReturnValue({ id: 'provider' } as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, 'key1');

      expect(setProvider).toHaveBeenCalled();
      expect(createProviderFromConfig).toHaveBeenCalledWith('background', expect.objectContaining({
        provider: 'anthropic',
      }));
      expect(setBackgroundProvider).toHaveBeenCalled();
      expect(result).toEqual({ success: true, error: null });
    });

    it('无 background 配置时应清空后台 Provider（setBackgroundProvider(null)）', async () => {
      const setProvider = vi.fn();
      const setBackgroundProvider = vi.fn();
      const mockAgent = { setProvider, setBackgroundProvider };
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => mockAgent as never),
      });
      mockSetActiveLlmProvider.mockResolvedValue(undefined);
      mockSpriteConfigStore.load.mockResolvedValue({
        llm: { providers: {} },
      });
      mockResolveProviderConfig.mockReturnValue({
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: '',
        apiKey: 'sk-test',
      });
      vi.mocked(createProviderFromConfig).mockReturnValue({ id: 'provider' } as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, 'key1');

      expect(setBackgroundProvider).toHaveBeenCalledWith(null);
      expect(result).toEqual({ success: true, error: null });
    });

    it('切换抛错应重置 agentReady + setAppRuntime(null) + 调用 errorHandler', async () => {
      const state = createState({ agentReady: true });
      const callbacks = createCallbacks({
        classifyInitError: vi.fn((msg: string) => `分类: ${msg}`),
      });
      mockSetActiveLlmProvider.mockRejectedValue(new Error('切换失败'));
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      const result = await callback({}, 'key1');

      expect(state.agentReady).toBe(false);
      expect(callbacks.setAppRuntime).toHaveBeenCalledWith(null);
      expect(state.initErrorDetail).toBe('分类: 切换失败');
      expect(mockErrorHandler.handle).toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: '切换失败' });
    });

    it('有进行中对话时应先中断再切换 Provider', async () => {
      const abortController = new AbortController();
      const abortSpy = vi.spyOn(abortController, 'abort');
      const setProvider = vi.fn();
      const setBackgroundProvider = vi.fn();
      const mockAgent = { setProvider, setBackgroundProvider };
      const state = createState({
        agentReady: true,
        currentAbortController: abortController,
      });
      const callbacks = createCallbacks({
        getCurrentAgent: vi.fn(() => mockAgent as never),
      });
      mockSetActiveLlmProvider.mockResolvedValue(undefined);
      mockSpriteConfigStore.load.mockResolvedValue({ llm: { providers: {} } });
      mockResolveProviderConfig.mockReturnValue({
        provider: 'openai',
        model: 'gpt-4',
        baseUrl: '',
        apiKey: 'sk-test',
      });
      vi.mocked(createProviderFromConfig).mockReturnValue({ id: 'provider' } as never);
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE)!;
      await callback({}, 'key1');

      expect(abortSpy).toHaveBeenCalled();
      expect(state.currentAbortController).toBeNull();
    });
  });

  // ─── RENDERER_LOG（补充：参数校验） ───────────────────

  describe('RENDERER_LOG 参数校验', () => {
    it('context 非字符串应忽略（不调用 logger）', () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.RENDERER_LOG)!;
      callback({} as never, {
        level: 'warn',
        context: 123 as never,
        message: '消息',
      });

      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('message 超长（>10000 字符）应忽略', () => {
      const state = createState();
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = onCallbacks.get(IPC_CHANNELS.RENDERER_LOG)!;
      const longMessage = 'x'.repeat(10001);
      callback({} as never, {
        level: 'error',
        context: 'renderer',
        message: longMessage,
      });

      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  // ─── AUDIT_LOG_LIST（补充：limit 边界） ───────────────

  describe('AUDIT_LOG_LIST 边界', () => {
    it('limit 为 0 应使用默认值 50', async () => {
      const readRecent = vi.fn(() => []);
      const auditManager = { readRecent, clear: vi.fn() };
      const state = createState({ auditManager: auditManager as never });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_LIST)!;
      await callback({}, 0);

      expect(readRecent).toHaveBeenCalledWith(50);
    });

    it('limit 为负数应使用默认值 50', async () => {
      const readRecent = vi.fn(() => []);
      const auditManager = { readRecent, clear: vi.fn() };
      const state = createState({ auditManager: auditManager as never });
      const callbacks = createCallbacks();
      registerMinimalIpcHandlers(state, callbacks);

      const callback = handleCallbacks.get(IPC_CHANNELS.AUDIT_LOG_LIST)!;
      await callback({}, -10);

      expect(readRecent).toHaveBeenCalledWith(50);
    });
  });
});