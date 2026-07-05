/**
 * settingsController 单元测试（QC-TEST-SETTINGS）
 *
 * 覆盖范围：
 * - onConfigSave：批量更新成功/事务失败/IPC 异常/字段透传（事务性保护）
 * - onLlmConfigSave：必填校验/成功/失败+agentStatus 同步
 * - onLlmTest：必填校验/成功/异常
 * - onConfigCancel：重新加载配置
 * - loadConfig：正常/静默恢复（未过期/已过期）/加载失败
 * - loadLlmConfig：加载失败错误横幅
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
import type { SpriteConfigForm, LlmConfigForm } from '../../../electron/renderer/types.js';

// ─── Mock UIManager 工厂 ─────────────────────────────────

/** 回调注册表：记录 onConfigSave/onLlmConfigSave/onConfigCancel/onLlmTest 注册的回调 */
interface RegisteredCallbacks {
  onConfigSave?: (config: SpriteConfigForm) => Promise<void>;
  onLlmConfigSave?: (payload: { llm: LlmConfigForm; embedding: { enabled: boolean; model: string; baseUrl: string; apiKey: string } | null }) => Promise<void>;
  onConfigCancel?: () => void;
  onLlmTest?: () => Promise<void>;
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
    onLlmConfigSave: vi.fn((cb) => { callbacks.onLlmConfigSave = cb; }),
    onConfigCancel: vi.fn((cb) => { callbacks.onConfigCancel = cb; }),
    onLlmTest: vi.fn((cb) => { callbacks.onLlmTest = cb; }),
    // ADR-015 归档模式变更回调（setupSettingsPanel 中注册，mock 需提供方法）
    onArchiveModeChange: vi.fn(),
    showToast: vi.fn(),
    showLlmTestResult: vi.fn(),
    getLlmConfigFromForm: vi.fn(() => ({ provider: '', model: '', baseUrl: '', apiKey: '', temperature: 0.7 })),
    loadConfigToForm: vi.fn(),
    loadProjectsToForm: vi.fn(),
    loadLlmConfigToForm: vi.fn(),
    hideSettingsError: vi.fn(),
    showSettingsError: vi.fn(),
    resetSettingsFormDirty: vi.fn(),
    setAgentReady: vi.fn(),
    updateAgentStatusIndicator: vi.fn(),
    loadUserProfile: vi.fn().mockResolvedValue(undefined),
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

/** 默认 LLM 表单配置（全字段填充） */
function makeLlmForm(overrides: Partial<LlmConfigForm> = {}): LlmConfigForm {
  return {
    provider: 'openai',
    model: 'gpt-4',
    baseUrl: '',
    apiKey: 'sk-test-key',
    temperature: 0.7,
    ...overrides,
  };
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
    // 传入的 updates 应包含全部 10 个字段
    const updates = api.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(updates)).toHaveLength(10);
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

  it('无论成功失败都应恢复按钮状态（finally）', async () => {
    const { setButtonLoading } = await import('../../../electron/renderer/helpers/domHelpers.js');
    await callbacks.onConfigSave!(makeFormConfig());

    // setButtonLoading(true, ...) + setButtonLoading(false)
    const calls = (setButtonLoading as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]).toEqual(['btn-settings-save', true, '保存中...']);
    expect(calls[calls.length - 1]).toEqual(['btn-settings-save', false]);
  });

  // ─── onLlmConfigSave ───────────────────────────────────

  it('LLM 配置缺 provider 应显示 warning 不调用 saveLlmConfig', async () => {
    await callbacks.onLlmConfigSave!({
      llm: makeLlmForm({ provider: '' }),
      embedding: null,
    });

    const saveLlmConfig = (globalThis as { electronAPI: { saveLlmConfig: { mock: { calls: unknown[][] } } } }).electronAPI.saveLlmConfig;
    expect(saveLlmConfig.mock.calls).toHaveLength(0);
    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    expect(showToast.mock.calls[0]![1]).toBe('warning');
  });

  it('LLM 配置缺 apiKey 应显示 warning 不调用 saveLlmConfig', async () => {
    await callbacks.onLlmConfigSave!({
      llm: makeLlmForm({ apiKey: '' }),
      embedding: null,
    });

    const saveLlmConfig = (globalThis as { electronAPI: { saveLlmConfig: { mock: { calls: unknown[][] } } } }).electronAPI.saveLlmConfig;
    expect(saveLlmConfig.mock.calls).toHaveLength(0);
  });

  it('LLM 配置保存成功应显示 success toast', async () => {
    await callbacks.onLlmConfigSave!({
      llm: makeLlmForm(),
      embedding: null,
    });

    const showToast = uiManager.showToast as unknown as { mock: { calls: unknown[][] } };
    // 第一次 toast 是"正在保存..."info，第二次是"已保存"success
    const successCall = showToast.mock.calls.find((c) => c[1] === 'success');
    expect(successCall).toBeDefined();
    expect(successCall![0]).toContain('Agent 已就绪');
  });

  it('LLM 配置保存失败应同步 agentStatus', async () => {
    const saveLlmConfig = (globalThis as { electronAPI: { saveLlmConfig: vi.Mock } }).electronAPI.saveLlmConfig;
    saveLlmConfig.mockResolvedValueOnce({ success: false, error: 'API Key 无效' });
    const getAgentStatus = (globalThis as { electronAPI: { getAgentStatus: vi.Mock } }).electronAPI.getAgentStatus;
    getAgentStatus.mockResolvedValueOnce({ ready: false, error: 'Agent 未就绪' });

    await callbacks.onLlmConfigSave!({
      llm: makeLlmForm(),
      embedding: null,
    });

    // 失败时应查询 agentStatus 并同步
    expect(getAgentStatus).toHaveBeenCalled();
    const setAgentReady = uiManager.setAgentReady as unknown as { mock: { calls: unknown[][] } };
    expect(setAgentReady.mock.calls[0]![0]).toBe(false);
    const updateIndicator = uiManager.updateAgentStatusIndicator as unknown as { mock: { calls: unknown[][] } };
    expect(updateIndicator.mock.calls[0]![0]).toBe('error');
  });

  // ─── onLlmTest ─────────────────────────────────────────

  it('LLM 测试缺必填字段应显示错误不调用 testLlmConfig', async () => {
    // getLlmConfigFromForm 默认返回空 provider
    await callbacks.onLlmTest!();

    const testLlmConfig = (globalThis as { electronAPI: { testLlmConfig: { mock: { calls: unknown[][] } } } }).electronAPI.testLlmConfig;
    expect(testLlmConfig.mock.calls).toHaveLength(0);
    const showLlmTestResult = uiManager.showLlmTestResult as unknown as { mock: { calls: unknown[][] } };
    expect(showLlmTestResult.mock.calls[0]![0]).toEqual({ success: false, error: '提供商、模型、API Key 为必填项' });
  });

  it('LLM 测试成功应显示结果含耗时', async () => {
    // 让 getLlmConfigFromForm 返回完整配置
    (uiManager.getLlmConfigFromForm as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(makeLlmForm());

    await callbacks.onLlmTest!();

    const showLlmTestResult = uiManager.showLlmTestResult as unknown as { mock: { calls: unknown[][] } };
    // 第一次是"测试中..."，第二次是真实结果
    expect(showLlmTestResult.mock.calls.length).toBeGreaterThanOrEqual(2);
    const resultCall = showLlmTestResult.mock.calls[showLlmTestResult.mock.calls.length - 1]!;
    expect(resultCall[0]).toEqual({ success: true, latencyMs: 150 });
    expect(typeof resultCall[1]).toBe('number'); // elapsed
  });

  it('LLM 测试异常应显示错误消息', async () => {
    (uiManager.getLlmConfigFromForm as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(makeLlmForm());
    const testLlmConfig = (globalThis as { electronAPI: { testLlmConfig: vi.Mock } }).electronAPI.testLlmConfig;
    testLlmConfig.mockRejectedValueOnce(new Error('连接超时'));

    await callbacks.onLlmTest!();

    const showLlmTestResult = uiManager.showLlmTestResult as unknown as { mock: { calls: unknown[][] } };
    const lastCall = showLlmTestResult.mock.calls[showLlmTestResult.mock.calls.length - 1]!;
    expect(lastCall[0]).toEqual({ success: false, error: '连接超时' });
  });

  // ─── onConfigCancel ────────────────────────────────────

  it('取消应重新加载配置（loadConfig + loadLlmConfig）', async () => {
    const getConfig = (globalThis as { electronAPI: { getConfig: vi.Mock } }).electronAPI.getConfig;
    const getLlmConfig = (globalThis as { electronAPI: { getLlmConfig: vi.Mock } }).electronAPI.getLlmConfig;
    getConfig.mockClear();
    getLlmConfig.mockClear();

    callbacks.onConfigCancel!();
    // onConfigCancel 内部 void loadConfig() + void loadLlmConfig()，异步需等待微任务
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getConfig).toHaveBeenCalled();
    expect(getLlmConfig).toHaveBeenCalled();
  });

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
