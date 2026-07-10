/**
 * settingsController 单元测试
 *
 * 覆盖范围：
 * - onConfigSave：批量更新成功/事务失败/IPC 异常/字段透传（事务性保护）
 * - onConfigCancel：重新加载精灵配置
 * - loadConfig：正常/静默恢复（未过期/已过期）/加载失败
 * - loadLlmConfig：加载 Embedding 配置/加载失败错误横幅
 *
 * 测试策略：
 * - 轻量 mock：vi.mock domHelpers/errorHelpers，避免 JSDOM 重依赖
 * - MockUiManager 满足 createSettingsController 使用的 UIManager 方法子集
 * - mock window.electronAPI 控制各 IPC 返回值
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── vi.hoisted 提升 mock 变量（vi.mock 工厂被提升到顶层，不能引用普通变量） ───
const { mockReportError, mockHandleIpcError } = vi.hoisted(() => ({
  mockReportError: vi.fn(),
  mockHandleIpcError: vi.fn(),
}));

// ─── Mock domHelpers（setButtonLoading 操作 DOM，需 mock） ───
vi.mock('../../../electron/renderer/helpers/domHelpers.js', () => ({
  setButtonLoading: vi.fn(),
}));

// ─── Mock errorHelpers（createIpcErrorHandler/reportError 依赖 UI，需 mock） ───
vi.mock('../../../electron/renderer/helpers/errorHelpers.js', () => ({
  createIpcErrorHandler: vi.fn(() => mockHandleIpcError),
  toError: vi.fn((err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'Error',
  })),
  reportError: mockReportError,
}));

// 导入被测模块（在 mock 之后导入，确保 mock 生效）
import { createSettingsController } from '../../../electron/renderer/controllers/settingsController.js';
import type { UIManager } from '../../../electron/renderer/ui.js';
import type { SpriteConfigForm } from '../../../electron/renderer/types.js';

// ─── Mock UIManager 工厂 ─────────────────────────────────

/** 回调注册表：记录 onConfigSave/onConfigCancel 注册的回调 */
interface RegisteredCallbacks {
  onConfigSave?: (config: SpriteConfigForm) => Promise<void>;
  onConfigCancel?: () => void;
}

/**
 * 创建 Mock UIManager
 *
 * 满足 createSettingsController 使用的 UIManager 方法子集。
 * 用 vi.fn() 记录调用，callbacks 参数捕获注册的回调供测试触发。
 */
function createMockUiManager(callbacks: RegisteredCallbacks = {}): UIManager {
  return {
    onConfigSave: vi.fn((cb) => { callbacks.onConfigSave = cb; }),
    onConfigCancel: vi.fn((cb) => { callbacks.onConfigCancel = cb; }),
    // ADR-015 归档模式变更回调（setupSettingsPanel 中注册，mock 需提供方法）
    onArchiveModeChange: vi.fn(),
    showToast: vi.fn(),
    loadConfigToForm: vi.fn(),
    loadProjectsToForm: vi.fn(),
    loadEmbeddingConfig: vi.fn(),
    hideSettingsError: vi.fn(),
    showSettingsError: vi.fn(),
    resetSettingsFormDirty: vi.fn(),
    setAgentReady: vi.fn(),
    updateAgentStatusIndicator: vi.fn(),
    loadUserProfile: vi.fn().mockResolvedValue(undefined),
    loadAuditLog: vi.fn().mockResolvedValue(undefined),
    // F-P0 技术债偿还：回调注入方法（setupSettingsPanel 中调用）
    setClearAuditLogCallback: vi.fn(),
    setConfirmProfileCallback: vi.fn(),
    setRejectProfileCallback: vi.fn(),
  } as unknown as UIManager;
}

/** 默认表单配置（全字段填充） */
function makeFormConfig(overrides: Partial<SpriteConfigForm> = {}): SpriteConfigForm {
  return {
    theme: 'light',
    // ADR-015 归档模式默认值（SpriteConfigForm 必填字段）
    archiveMode: 'full',
    silentMode: false,
    proactiveThreshold: 3,
    proactiveCooldownMs: 300_000,
    triggerIntervalMs: 3_600_000,
    fileWatcherEnabled: true,
    fileWatcherPaths: ['.'],
    fileWatcherDebounceMs: 1000,
    defaultPersona: '',
    projectMode: 'smart',
    focusProjectPath: '',
    ...overrides,
  } as SpriteConfigForm;
}

describe('settingsController', () => {
  let uiManager: UIManager;
  let callbacks: RegisteredCallbacks;
  let controller: ReturnType<typeof createSettingsController>;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = {};
    uiManager = createMockUiManager(callbacks);
    controller = createSettingsController(uiManager);
    controller.setupSettingsPanel();

    // mock window.electronAPI（每个测试可在用例内覆盖具体返回值）
    (globalThis as { window: unknown }).window = globalThis;
    (globalThis as { electronAPI: unknown }).electronAPI = {
      updateConfigBatch: vi.fn().mockResolvedValue({ updated: true }),
      updateConfig: vi.fn().mockResolvedValue({ updated: true }),
      saveLlmConfig: vi.fn().mockResolvedValue({ success: true }),
      getAgentStatus: vi.fn().mockResolvedValue({ ready: true, error: null }),
      testLlmConfig: vi.fn().mockResolvedValue({ success: true, latencyMs: 150 }),
      getConfig: vi.fn().mockResolvedValue({ config: makeFormConfig() }),
      getLlmConfig: vi.fn().mockResolvedValue({ provider: 'openai', model: 'gpt-4' }),
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    };
    (globalThis as { window: { electronAPI: unknown } }).window = { electronAPI: (globalThis as { electronAPI: unknown }).electronAPI };
  });

  // ─── onConfigSave（事务性保护） ───────────

  it('批量更新成功应显示 success toast', async () => {
    const config = makeFormConfig();
    await callbacks.onConfigSave!(config);

    const api = (globalThis as { window: { electronAPI: { updateConfigBatch: { mock: { calls: unknown[][] } } } } }).window.electronAPI.updateConfigBatch;
    expect(api.mock.calls).toHaveLength(1);
    // fileWatcherIgnore 纳入批量更新后，字段数从 10 增至 11
    const updates = api.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(updates)).toHaveLength(11);
    expect(updates.silentMode).toBe(false);
    expect(updates.projectMode).toBe('smart');

    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    expect(showToast.mock.calls[0]).toEqual(['精灵配置已保存', 'success']);
  });

  it('事务失败（updated=false）应显示 error toast 含错误信息', async () => {
    const api = (globalThis as { electronAPI: { updateConfigBatch: vi.Mock } }).electronAPI.updateConfigBatch;
    api.mockResolvedValueOnce({ updated: false, error: '配置值类型非法：proactiveThreshold' });

    await callbacks.onConfigSave!(makeFormConfig());

    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    expect(showToast.mock.calls[0]![0]).toContain('保存失败');
    expect(showToast.mock.calls[0]![0]).toContain('proactiveThreshold');
    expect(showToast.mock.calls[0]![1]).toBe('error');
  });

  it('IPC 异常应调用 handleIpcError', async () => {
    const api = (globalThis as { electronAPI: { updateConfigBatch: vi.Mock } }).electronAPI.updateConfigBatch;
    api.mockRejectedValueOnce(new Error('IPC 网络错误'));

    await callbacks.onConfigSave!(makeFormConfig());

    expect(mockHandleIpcError).toHaveBeenCalledWith('onConfigSave', expect.any(Error), '保存精灵配置失败');
  });

  it('自动保存成功应显示成功提示', async () => {
    await callbacks.onConfigSave!(makeFormConfig());

    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    expect(showToast.mock.calls[0]).toEqual(['精灵配置已保存', 'success']);
  });

  // ─── onConfigCancel 已移除（自动保存改造后无需取消按钮） ──

  // ─── loadConfig ────────────────────────────────────────

  it('loadConfig 正常应加载配置到表单 + 重置 dirty', async () => {
    await controller.loadConfig();

    expect(uiManager.loadConfigToForm).toHaveBeenCalled();
    expect(uiManager.resetSettingsFormDirty).toHaveBeenCalled();
    expect(uiManager.hideSettingsError).toHaveBeenCalled();
  });

  it('loadConfig 静默模式未过期应调用 silentRecoveryCallback', async () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const getConfig = (globalThis as { electronAPI: { getConfig: vi.Mock } }).electronAPI.getConfig;
    getConfig.mockResolvedValueOnce({
      config: makeFormConfig({ silentMode: true, silentModeExpiresAt: futureTime } as unknown as SpriteConfigForm),
    });

    const recoveryCb = vi.fn();
    controller.setSilentRecoveryCallback(recoveryCb);

    await controller.loadConfig();

    expect(recoveryCb).toHaveBeenCalled();
    const remainingMs = recoveryCb.mock.calls[0]![0] as number;
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(60_000);
  });

  it('loadConfig 静默模式已过期应自动关闭静默模式', async () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const getConfig = (globalThis as { electronAPI: { getConfig: vi.Mock } }).electronAPI.getConfig;
    getConfig.mockResolvedValueOnce({
      config: makeFormConfig({ silentMode: true, silentModeExpiresAt: pastTime } as unknown as SpriteConfigForm),
    });
    const updateConfig = (globalThis as { electronAPI: { updateConfig: vi.Mock } }).electronAPI.updateConfig;

    await controller.loadConfig();

    // 应调用 updateConfig 关闭 silentMode + 清空 expiresAt
    expect(updateConfig).toHaveBeenCalledWith('silentMode', false);
    expect(updateConfig).toHaveBeenCalledWith('silentModeExpiresAt', null);
    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    const recoveryToast = showToast.mock.calls.find((c) => c[0]?.includes?.('自动恢复'));
    expect(recoveryToast).toBeDefined();
  });

  it('loadConfig 加载失败应显示错误横幅', async () => {
    const getConfig = (globalThis as { electronAPI: { getConfig: vi.Mock } }).electronAPI.getConfig;
    getConfig.mockRejectedValueOnce(new Error('配置文件损坏'));

    await controller.loadConfig();

    expect(mockReportError).toHaveBeenCalledWith('loadConfig', expect.any(Error));
    expect(uiManager.showSettingsError).toHaveBeenCalled();
  });

  // ─── loadLlmConfig ─────────────────────────────────────

  it('loadLlmConfig 加载失败应显示错误横幅', async () => {
    const getLlmConfig = (globalThis as { electronAPI: { getLlmConfig: vi.Mock } }).electronAPI.getLlmConfig;
    getLlmConfig.mockRejectedValueOnce(new Error('LLM 配置缺失'));

    await controller.loadLlmConfig();

    expect(mockReportError).toHaveBeenCalledWith('loadLlmConfig', expect.any(Error));
    expect(uiManager.showSettingsError).toHaveBeenCalled();
  });
});
