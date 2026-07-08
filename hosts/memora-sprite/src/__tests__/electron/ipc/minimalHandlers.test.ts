/**
 * 最小化 IPC 处理器测试（FOUNDATION-SEAL Phase 5 迭代 A）
 *
 * 覆盖范围：Agent 未就绪时的 11 个最小化 IPC handler
 * - CONFIG_GET：成功返回配置 + 加载失败降级默认配置
 * - AGENT_STATUS：就绪/未就绪状态查询
 * - LLM_CONFIG_TEST：连接成功 + 空响应 + 失败降级
 * - LLM_CONFIG_GET：已配置 + 未配置 + 加载失败降级
 * - LLM_CONFIG_SAVE：成功完整链路 + 中断进行中对话 + 失败降级
 * - WRITE_CONFIRMATION_RESPONSE：找到/未找到 requestId
 * - AUDIT_LOG_LIST：auditManager 存在/null 降级
 * - AUDIT_LOG_CLEAR：auditManager 存在/null 降级
 * - PROJECTS_LIST：始终返回空数组
 * - THEME_CHANGED：light/dark 主题 + windowManager undefined
 * - RENDERER_LOG：warn/error 级别日志转发
 *
 * Mock 策略：
 * - electron.ipcMain：handle + on 双回调捕获 Map
 * - memora：createProviderFromConfig / toError / logger
 * - spriteConfig：loadSpriteConfig / DEFAULT_SPRITE_CONFIG
 * - spriteConfigStore：isConfigured / load
 * - index（宿主入口）：saveLlmConfig / reinitAgent / PROVIDER_PRESETS
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── vi.hoisted：vi.mock 被 hoisted，引用变量需用 vi.hoisted 声明 ──
const { handleCallbacks, onCallbacks, mockLogger, mockErrorHandler, mockSpriteConfigStore, mockSaveLlmConfig, mockReinitAgent, mockLoadSpriteConfig, DEFAULT_SPRITE_CONFIG, PROVIDER_PRESETS } = vi.hoisted(() => {
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
  return { handleCallbacks, onCallbacks, mockLogger, mockErrorHandler, mockSpriteConfigStore, mockSaveLlmConfig, mockReinitAgent, mockLoadSpriteConfig, DEFAULT_SPRITE_CONFIG, PROVIDER_PRESETS };
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
}));

// ─── Mock index（宿主入口） ──────────────────────────────

vi.mock('../../../index.js', () => ({
  saveLlmConfig: mockSaveLlmConfig,
  reinitAgent: mockReinitAgent,
  PROVIDER_PRESETS,
}));

import { registerMinimalIpcHandlers } from '../../../electron/ipc/minimalHandlers.js';
import { IPC_CHANNELS } from '../../../electron/ipc/channels.js';
import type { MinimalIpcState, MinimalIpcCallbacks } from '../../../electron/ipc/minimalHandlers.js';
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
});