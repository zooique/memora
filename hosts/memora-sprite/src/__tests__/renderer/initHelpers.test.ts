/**
 * 渲染进程初始化辅助函数测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - createSilentRecoveryScheduler：
 *   - 返回 scheduleSilentRecovery 函数
 *   - 调用后注册 setTimeout（remainingMs 后触发）
 *   - 触发时调用 updateConfig(silentMode, false) + updateConfig(silentModeExpiresAt, null) + showToast
 *   - updateConfig 失败时走 reportError（不抛出）
 *   - 多次调用应 clear 旧定时器（避免重复触发）
 *   - timerRef.current 在定时器触发后置 null
 * - showAgentInitError：
 *   - 调用 appendMessage（system 角色 + 含错误信息的 content）
 *   - 调用 showSettingsError（含 retryCallback）
 *   - 调用 switchPanel('settings')
 *   - 调用 settingsController.loadConfig()
 *   - retryCallback：getLlmConfig 有 config 时调用 saveLlmConfig
 *   - retryCallback：getLlmConfig 无 config 时不调用 saveLlmConfig
 *   - retryCallback：getLlmConfig 异常时走 reportError（不抛出）
 * - showWelcomeMessage：调用 appendMessage（system 角色 + 欢迎文案）
 *
 * Mock 策略：
 * - mock uiManager（appendMessage/showSettingsError/switchPanel/showToast 为 vi.fn()）
 * - mock settingsController（loadConfig 为 vi.fn()）
 * - mock window.electronAPI（updateConfig/getLlmConfig/saveLlmConfig）
 * - vi.useFakeTimers：测试 setTimeout/clearTimeout 行为
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSilentRecoveryScheduler,
  showAgentInitError,
  showWelcomeMessage,
} from '../../electron/renderer/initHelpers.js';
import type { UIManager } from '../../electron/renderer/ui.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock uiManager */
function createMockUiManager(): {
  uiManager: UIManager;
  spies: {
    appendMessage: ReturnType<typeof vi.fn>;
    showSettingsError: ReturnType<typeof vi.fn>;
    switchPanel: ReturnType<typeof vi.fn>;
    showToast: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    appendMessage: vi.fn(),
    showSettingsError: vi.fn(),
    switchPanel: vi.fn().mockResolvedValue(undefined),
    showToast: vi.fn(),
  };
  const uiManager = spies as unknown as UIManager;
  return { uiManager, spies };
}

/** 创建 mock settingsController */
function createMockSettingsController(): {
  controller: { loadConfig: ReturnType<typeof vi.fn> };
  spies: { loadConfig: ReturnType<typeof vi.fn> };
} {
  const loadConfig = vi.fn().mockResolvedValue(undefined);
  return {
    controller: { loadConfig },
    spies: { loadConfig },
  };
}

/** 创建 mock electronAPI（initHelpers 使用的子集） */
function mockElectronAPI(overrides?: {
  updateConfig?: ReturnType<typeof vi.fn>;
  getLlmConfig?: ReturnType<typeof vi.fn>;
  saveLlmConfig?: ReturnType<typeof vi.fn>;
}): {
  updateConfig: ReturnType<typeof vi.fn>;
  getLlmConfig: ReturnType<typeof vi.fn>;
  saveLlmConfig: ReturnType<typeof vi.fn>;
} {
  const updateConfig = overrides?.updateConfig ?? vi.fn().mockResolvedValue({ updated: true });
  const getLlmConfig = overrides?.getLlmConfig ?? vi.fn().mockResolvedValue({ configured: true, config: null });
  const saveLlmConfig = overrides?.saveLlmConfig ?? vi.fn().mockResolvedValue({ success: true, error: null });
  window.electronAPI = {
    updateConfig,
    getLlmConfig,
    saveLlmConfig,
  } as unknown as typeof window.electronAPI;
  return { updateConfig, getLlmConfig, saveLlmConfig };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('initHelpers', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleErrorSpy.mockRestore();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  // ─── createSilentRecoveryScheduler ────────────────────

  describe('createSilentRecoveryScheduler', () => {
    it('返回值应为 scheduleSilentRecovery 函数', () => {
      const { uiManager } = createMockUiManager();
      mockElectronAPI();
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      expect(typeof schedule).toBe('function');
    });

    it('调用 schedule 后应注册 setTimeout（remainingMs 后触发）', () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI();
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000); // 60 秒后恢复
      expect(timerRef.current).not.toBeNull(); // 定时器已注册

      // 未到时间不应触发
      vi.advanceTimersByTime(59_999);
      expect(spies.showToast).not.toHaveBeenCalled();
    });

    it('定时器触发时应调用 updateConfig(silentMode, false) + updateConfig(silentModeExpiresAt, null) + showToast', async () => {
      const { uiManager, spies } = createMockUiManager();
      const api = mockElectronAPI();
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000);
      // 异步推进定时器并等待 Promise 微任务
      await vi.advanceTimersByTimeAsync(60_000);

      expect(api.updateConfig).toHaveBeenNthCalledWith(1, 'silentMode', false);
      expect(api.updateConfig).toHaveBeenNthCalledWith(2, 'silentModeExpiresAt', null);
      expect(spies.showToast).toHaveBeenCalledWith('静默模式已到期自动恢复', 'info');
    });

    it('定时器触发后 timerRef.current 应置 null', async () => {
      const { uiManager } = createMockUiManager();
      mockElectronAPI();
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000);
      expect(timerRef.current).not.toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(timerRef.current).toBeNull();
    });

    it('多次调用应 clear 旧定时器（避免重复触发）', async () => {
      const { uiManager, spies } = createMockUiManager();
      mockElectronAPI();
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000);
      const firstTimer = timerRef.current;
      // 第二次调用应清理第一个定时器
      schedule(30_000);

      // 推进 30_000ms（第二次的定时器应触发，第一次的被清理不应触发）
      await vi.advanceTimersByTimeAsync(30_000);
      // showToast 仅被第二次定时器触发一次
      expect(spies.showToast).toHaveBeenCalledTimes(1);
      // timerRef.current 触发后置 null
      expect(timerRef.current).toBeNull();
      // firstTimer 与 timerRef.current 不同（清理证据）
      expect(firstTimer).not.toBe(timerRef.current);
    });

    it('updateConfig 失败应走 reportError（不抛出）', async () => {
      const { uiManager } = createMockUiManager();
      mockElectronAPI({
        updateConfig: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      });
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000);
      // 异步推进定时器，updateConfig rejected 走 catch → reportError
      await vi.advanceTimersByTimeAsync(60_000);

      // reportError 会调用 console.error
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it('timerRef.current 初始为 null 时不应调用 clearTimeout', () => {
      const { uiManager } = createMockUiManager();
      mockElectronAPI();
      const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
      const timerRef = { current: null as number | null };
      const schedule = createSilentRecoveryScheduler(uiManager, timerRef);

      schedule(60_000);

      // 初始为 null，不应调用 clearTimeout
      expect(clearTimeoutSpy).not.toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  // ─── showAgentInitError ───────────────────────────────

  describe('showAgentInitError', () => {
    it('应调用 appendMessage（system 角色 + 含错误信息的 content）', () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      mockElectronAPI();

      showAgentInitError(uiManager, controller, '数据库连接失败');

      expect(spies.appendMessage).toHaveBeenCalledTimes(1);
      const call = spies.appendMessage.mock.calls[0]![0] as { role: string; content: string };
      expect(call.role).toBe('system');
      expect(call.content).toContain('Agent 初始化失败');
      expect(call.content).toContain('数据库连接失败');
    });

    it('应调用 showSettingsError（含错误信息 + retryCallback）', () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      mockElectronAPI();

      showAgentInitError(uiManager, controller, '配置错误');

      expect(spies.showSettingsError).toHaveBeenCalledTimes(1);
      const [message, retryCallback] = spies.showSettingsError.mock.calls[0]!;
      expect(message).toContain('配置错误');
      expect(typeof retryCallback).toBe('function');
    });

    it('应调用 switchPanel("settings")', () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      mockElectronAPI();

      showAgentInitError(uiManager, controller, '错误');

      expect(spies.switchPanel).toHaveBeenCalledWith('settings');
    });

    it('应调用 settingsController.loadConfig()', () => {
      const { uiManager } = createMockUiManager();
      const { controller, spies } = createMockSettingsController();
      mockElectronAPI();

      showAgentInitError(uiManager, controller, '错误');

      expect(spies.loadConfig).toHaveBeenCalledTimes(1);
    });

    it('retryCallback：getLlmConfig 有 config 时应调用 saveLlmConfig', async () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      const api = mockElectronAPI({
        getLlmConfig: vi.fn().mockResolvedValue({
          configured: true,
          config: { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: 'sk-xxx', temperature: 0.7 },
        }),
      });

      showAgentInitError(uiManager, controller, '错误');
      const retryCallback = spies.showSettingsError.mock.calls[0]![1] as () => Promise<void>;

      await retryCallback();

      expect(api.saveLlmConfig).toHaveBeenCalledWith(
        { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: 'sk-xxx', temperature: 0.7 },
      );
    });

    it('retryCallback：getLlmConfig 无 config 时不调用 saveLlmConfig', async () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      const api = mockElectronAPI({
        getLlmConfig: vi.fn().mockResolvedValue({ configured: false, config: null }),
      });

      showAgentInitError(uiManager, controller, '错误');
      const retryCallback = spies.showSettingsError.mock.calls[0]![1] as () => Promise<void>;

      await retryCallback();

      expect(api.saveLlmConfig).not.toHaveBeenCalled();
    });

    it('retryCallback：getLlmConfig 异常应走 reportError（不抛出）', async () => {
      const { uiManager, spies } = createMockUiManager();
      const { controller } = createMockSettingsController();
      mockElectronAPI({
        getLlmConfig: vi.fn().mockRejectedValue(new Error('IPC 失败')),
      });

      showAgentInitError(uiManager, controller, '错误');
      const retryCallback = spies.showSettingsError.mock.calls[0]![1] as () => Promise<void>;

      // 不应抛出
      await expect(retryCallback()).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  // ─── showWelcomeMessage ───────────────────────────────

  describe('showWelcomeMessage', () => {
    it('应调用 appendMessage（system 角色 + 欢迎文案）', () => {
      const { uiManager, spies } = createMockUiManager();

      showWelcomeMessage(uiManager);

      expect(spies.appendMessage).toHaveBeenCalledTimes(1);
      const call = spies.appendMessage.mock.calls[0]![0] as { role: string; content: string };
      expect(call.role).toBe('system');
      expect(call.content).toContain('欢迎使用 Memora Sprite');
    });

    it('欢迎文案应包含"稍后配置"引导（P2-FLOW-10）', () => {
      const { uiManager, spies } = createMockUiManager();

      showWelcomeMessage(uiManager);

      const call = spies.appendMessage.mock.calls[0]![0] as { content: string };
      expect(call.content).toContain('稍后配置');
    });

    it('欢迎文案应包含 LLM 配置引导', () => {
      const { uiManager, spies } = createMockUiManager();

      showWelcomeMessage(uiManager);

      const call = spies.appendMessage.mock.calls[0]![0] as { content: string };
      expect(call.content).toContain('LLM');
      expect(call.content).toContain('保存');
    });
  });
});
