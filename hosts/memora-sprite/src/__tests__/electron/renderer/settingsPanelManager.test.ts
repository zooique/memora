/**
 * 设置面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - initListeners：tab 切换 / API Key 切换 / 后台 Provider 联动 / dirty 追踪 /
 *   保存按钮 / 取消按钮（dirty 确认）/ 恢复默认 / LLM 预设 / LLM 测试 /
 *   项目模式联动 / 角色模式 / 主题切换 / 稍后配置
 * - updateAgentStatusIndicator：三态 + null 降级
 * - loadLlmConfigToForm：加载 LLM + 后台 Provider + Embedding + 预设反匹配
 * - collectLlmConfigFromForm：收集 LLM + 后台 Provider + Embedding
 * - loadConfigToForm：加载精灵配置 + 项目模式 + 专注项目联动
 * - collectConfigFromForm：收集精灵配置 + 项目模式 + 主题
 * - showLlmTestResult：成功 / 失败 / null 降级
 * - 回调注册：onConfigSave / onConfigCancel / onLlmConfigSave / onLlmTest / onPersonaModeChange
 * - cleanup：事件监听器解绑
 *
 * Mock 策略：
 * - Mock SettingsPanelHost 接口（setTheme/updatePersonaModeBadge/showConfirmDialog/showToast/switchPanel）
 * - 真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsPanelManager, type SettingsPanelHost } from '../../../electron/renderer/panels/settingsPanelManager.js';
import type { SpriteConfigForm, LlmConfigForm } from '../../../electron/renderer/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock SettingsPanelHost */
function createMockHost(overrides?: Partial<SettingsPanelHost>): SettingsPanelHost {
  return {
    setTheme: vi.fn(),
    updatePersonaModeBadge: vi.fn(),
    showConfirmDialog: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
    switchPanel: vi.fn(),
    ...overrides,
  };
}

/** 设置面板完整 DOM 结构（LLM + 后台 Provider + Embedding + 精灵配置 + 按钮 + 单选按钮） */
const SETTINGS_HTML = `
  <div id="panel-settings">
    <!-- LLM 配置 -->
    <select id="cfg-llm-preset"><option value="">自定义</option><option value="openai">OpenAI</option></select>
    <input id="cfg-llm-provider" type="text" />
    <input id="cfg-llm-model" type="text" />
    <input id="cfg-llm-base-url" type="text" />
    <input id="cfg-llm-api-key" type="password" />
    <input id="cfg-llm-temperature" type="number" value="0.7" />
    <button id="btn-toggle-llm-key">👁</button>

    <!-- 后台 Provider（H6） -->
    <input id="cfg-bg-enabled" type="checkbox" />
    <input id="cfg-bg-provider" type="text" disabled />
    <input id="cfg-bg-model" type="text" disabled />
    <input id="cfg-bg-base-url" type="text" disabled />
    <input id="cfg-bg-api-key" type="password" disabled />
    <button id="btn-toggle-bg-key" disabled>👁</button>

    <!-- Embedding -->
    <input id="cfg-emb-enabled" type="checkbox" />
    <input id="cfg-emb-model" type="text" />
    <input id="cfg-emb-base-url" type="text" />
    <input id="cfg-emb-api-key" type="password" />
    <button id="btn-toggle-emb-key">👁</button>

    <!-- 精灵配置 -->
    <input id="cfg-silent" type="checkbox" />
    <input id="cfg-threshold" type="number" value="3" />
    <input id="cfg-cooldown" type="number" value="5" />
    <input id="cfg-interval" type="number" value="60" />
    <input id="cfg-watcher-enabled" type="checkbox" />
    <input id="cfg-watcher-paths" type="text" />
    <input id="cfg-watcher-debounce" type="number" value="1000" />
    <input id="cfg-default-persona" type="text" />
    <select id="cfg-focus-project"><option value="">选择项目</option></select>

    <!-- 按钮 -->
    <button id="btn-settings-save">保存</button>
    <button id="btn-settings-cancel">取消</button>
    <button id="btn-settings-reset">恢复默认</button>
    <button id="btn-settings-skip">稍后配置</button>
    <button id="btn-llm-test">测试连接</button>

    <!-- 单选按钮组 -->
    <input type="radio" name="persona-mode" value="auto" checked />
    <input type="radio" name="persona-mode" value="manual" />
    <input type="radio" name="project-mode" value="smart" checked />
    <input type="radio" name="project-mode" value="focus" />
    <input type="radio" name="theme-mode" value="light" checked />
    <input type="radio" name="theme-mode" value="dark" />
    <input type="radio" name="theme-mode" value="auto" />

    <!-- 状态显示 -->
    <div id="agent-status-indicator"><span class="agent-status-text">检测中...</span></div>
    <div id="llm-test-result"></div>

    <!-- tab 切换 -->
    <div class="settings-tab active" data-settings-tab="llm">LLM</div>
    <div class="settings-tab" data-settings-tab="sprite">精灵</div>
    <div class="settings-tab-content active" data-settings-tab="llm">LLM 内容</div>
    <div class="settings-tab-content" data-settings-tab="sprite">精灵内容</div>
  </div>
`;

/** 创建 SettingsPanelManager（已 initListeners） */
function createManager(opts?: {
  host?: SettingsPanelHost;
  html?: string;
  init?: boolean;
}): { manager: SettingsPanelManager; host: SettingsPanelHost } {
  document.body.innerHTML = opts?.html ?? SETTINGS_HTML;
  const host = opts?.host ?? createMockHost();
  const manager = new SettingsPanelManager(host);
  if (opts?.init !== false) {
    manager.initListeners();
  }
  return { manager, host };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

// ─── initListeners · 稍后配置 ─────────────

describe('initListeners · 稍后配置按钮', () => {
  it('click 稍后配置应清除 dirty + 切换到 chat 面板', () => {
    const { manager, host } = createManager();
    // 先标记 dirty
    manager['settingsFormDirty'] = true;
    document.getElementById('btn-settings-skip')!.click();
    expect(host.switchPanel).toHaveBeenCalledWith('chat');
    // dirty 应被清除
    expect(manager.isDirty()).toBe(false);
  });
});

// ─── initListeners · API Key 切换 ────────────────────────

describe('initListeners · API Key 切换', () => {
  it('click 切换按钮应在 password/text 间切换 + 更新按钮文案', () => {
    createManager();
    const input = document.getElementById('cfg-llm-api-key') as HTMLInputElement;
    const btn = document.getElementById('btn-toggle-llm-key') as HTMLButtonElement;
    // 初始 password
    expect(input.type).toBe('password');
    btn.click();
    // 切换为 text（可见态：SVG icon-eye + data-visible="true" 触发 CSS accent 高亮）
    expect(input.type).toBe('text');
    expect(btn.innerHTML).toContain('icon-eye');
    expect(btn.dataset.visible).toBe('true');
    expect(btn.title).toBe('隐藏 API Key');
    // 再次点击切换回 password（隐藏态：SVG icon-eye + data-visible="false" 无 accent）
    btn.click();
    expect(input.type).toBe('password');
    expect(btn.innerHTML).toContain('icon-eye');
    expect(btn.dataset.visible).toBe('false');
  });
});

// ─── initListeners · 后台 Provider 联动 ─────────────────

describe('initListeners · 后台 Provider 联动', () => {
  it('勾选 bg-enabled 应启用后台字段', () => {
    createManager();
    const checkbox = document.getElementById('cfg-bg-enabled') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    // 后台字段应启用
    expect((document.getElementById('cfg-bg-provider') as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById('cfg-bg-model') as HTMLInputElement).disabled).toBe(false);
  });

  it('取消勾选 bg-enabled 应禁用后台字段', () => {
    createManager();
    const checkbox = document.getElementById('cfg-bg-enabled') as HTMLInputElement;
    // 先启用
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    // 再禁用
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect((document.getElementById('cfg-bg-provider') as HTMLInputElement).disabled).toBe(true);
  });
});

// ─── initListeners · dirty 追踪 ──────────────────────────

describe('initListeners · dirty 追踪', () => {
  it('表单 input 事件应标记 settingsFormDirty', () => {
    const { manager } = createManager();
    expect(manager.isDirty()).toBe(false);
    // 触发表单 input 事件
    const input = document.getElementById('cfg-threshold') as HTMLInputElement;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(manager.isDirty()).toBe(true);
  });

  it('表单 change 事件应标记 settingsFormDirty', () => {
    const { manager } = createManager();
    const checkbox = document.getElementById('cfg-silent') as HTMLInputElement;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    expect(manager.isDirty()).toBe(true);
  });

  it('LLM 字段 input 事件应标记 llmFormDirty', () => {
    const { manager } = createManager();
    const input = document.getElementById('cfg-llm-provider') as HTMLInputElement;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(manager.isDirty()).toBe(true);
  });

  it('resetFormDirty 应清除 dirty 标志', () => {
    const { manager } = createManager();
    manager['settingsFormDirty'] = true;
    manager['llmFormDirty'] = true;
    manager.resetFormDirty();
    expect(manager.isDirty()).toBe(false);
  });
});

// ─── initListeners · 保存按钮 ────────────────────────────

describe('initListeners · 保存按钮', () => {
  it('click 保存应触发 configSaveCallback + 清除 dirty', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    // 先标记 dirty
    manager['settingsFormDirty'] = true;
    document.getElementById('btn-settings-save')!.click();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ silentMode: expect.any(Boolean) }));
    // dirty 应被清除
    expect(manager.isDirty()).toBe(false);
  });

  it('click 保存且 llmFormDirty 时应触发 llmConfigSaveCallback', () => {
    const { manager } = createManager();
    const llmCb = vi.fn();
    manager.onLlmConfigSave(llmCb);
    // 标记 LLM dirty
    manager['llmFormDirty'] = true;
    document.getElementById('btn-settings-save')!.click();
    expect(llmCb).toHaveBeenCalledTimes(1);
    expect(llmCb).toHaveBeenCalledWith(expect.objectContaining({ llm: expect.any(Object) }));
  });

  it('click 保存但 llmFormDirty=false 时不应触发 llmConfigSaveCallback', () => {
    const { manager } = createManager();
    const llmCb = vi.fn();
    manager.onLlmConfigSave(llmCb);
    document.getElementById('btn-settings-save')!.click();
    expect(llmCb).not.toHaveBeenCalled();
  });
});

// ─── initListeners · 取消按钮 ────────────────────────────

describe('initListeners · 取消按钮', () => {
  it('dirty=false 时 click 取消应直接触发 configCancelCallback', async () => {
    const { manager, host } = createManager();
    const cb = vi.fn();
    manager.onConfigCancel(cb);
    document.getElementById('btn-settings-cancel')!.click();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(host.showConfirmDialog).not.toHaveBeenCalled();
  });

  it('dirty=true 时 click 取消应先确认，确认后触发 configCancelCallback', async () => {
    const { manager, host } = createManager();
    const cb = vi.fn();
    manager.onConfigCancel(cb);
    manager['settingsFormDirty'] = true;
    document.getElementById('btn-settings-cancel')!.click();
    await Promise.resolve();
    expect(host.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '放弃修改' }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('dirty=true 且用户取消确认时不应触发 configCancelCallback', async () => {
    const host = createMockHost({ showConfirmDialog: vi.fn().mockResolvedValue(false) });
    const { manager } = createManager({ host });
    const cb = vi.fn();
    manager.onConfigCancel(cb);
    manager['settingsFormDirty'] = true;
    document.getElementById('btn-settings-cancel')!.click();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });
});

// ─── initListeners · 恢复默认按钮 ───────────────────────

describe('initListeners · 恢复默认按钮', () => {
  it('click 恢复默认且确认时应加载默认配置 + 标记 dirty + 显示 toast', async () => {
    const { manager, host } = createManager();
    document.getElementById('btn-settings-reset')!.click();
    await Promise.resolve();
    // 应显示确认对话框
    expect(host.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: '恢复默认设置' }));
    // 应显示 toast
    expect(host.showToast).toHaveBeenCalledWith('已恢复默认设置，点击「保存」生效', 'info');
    // 应标记 dirty
    expect(manager.isDirty()).toBe(true);
    // 应加载默认值（threshold=3）
    expect((document.getElementById('cfg-threshold') as HTMLInputElement).value).toBe('3');
  });

  it('click 恢复默认但用户取消时不应加载默认配置', async () => {
    const host = createMockHost({ showConfirmDialog: vi.fn().mockResolvedValue(false) });
    const { manager } = createManager({ host });
    document.getElementById('btn-settings-reset')!.click();
    await Promise.resolve();
    expect(host.showToast).not.toHaveBeenCalled();
    expect(manager.isDirty()).toBe(false);
  });
});

// ─── initListeners · LLM 预设切换 ───────────────────────

describe('initListeners · LLM 预设切换', () => {
  it('选择预设应自动填充 provider/model/baseUrl', () => {
    const { manager } = createManager();
    // 先加载预设
    manager.loadLlmConfigToForm({
      configured: false,
      config: null,
      embedding: null,
      presets: { openai: { provider: 'openai', model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' } },
    });
    // 选择预设
    const preset = document.getElementById('cfg-llm-preset') as HTMLSelectElement;
    preset.value = 'openai';
    preset.dispatchEvent(new Event('change'));
    // 应自动填充
    expect((document.getElementById('cfg-llm-provider') as HTMLInputElement).value).toBe('openai');
    expect((document.getElementById('cfg-llm-model') as HTMLInputElement).value).toBe('gpt-4');
    expect((document.getElementById('cfg-llm-base-url') as HTMLInputElement).value).toBe('https://api.openai.com/v1');
  });

  it('选择空值预设不应填充', () => {
    const { manager } = createManager();
    manager.loadLlmConfigToForm({
      configured: false,
      config: null,
      embedding: null,
      presets: { openai: { provider: 'openai', model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' } },
    });
    const preset = document.getElementById('cfg-llm-preset') as HTMLSelectElement;
    preset.value = '';
    preset.dispatchEvent(new Event('change'));
    // 不应填充
    expect((document.getElementById('cfg-llm-provider') as HTMLInputElement).value).toBe('');
  });
});

// ─── initListeners · LLM 测试按钮 ───────────────────────

describe('initListeners · LLM 测试按钮', () => {
  it('click 测试按钮应触发 llmTestCallback', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onLlmTest(cb);
    document.getElementById('btn-llm-test')!.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ─── initListeners · 项目模式联动 ───────────────────────

describe('initListeners · 项目模式联动', () => {
  it('选择 focus 模式应启用专注项目下拉框', () => {
    createManager();
    const focusRadio = document.querySelector('input[name="project-mode"][value="focus"]') as HTMLInputElement;
    focusRadio.checked = true;
    focusRadio.dispatchEvent(new Event('change'));
    expect((document.getElementById('cfg-focus-project') as HTMLSelectElement).disabled).toBe(false);
  });

  it('选择 smart 模式应禁用专注项目下拉框', () => {
    createManager();
    // 先启用
    const focusRadio = document.querySelector('input[name="project-mode"][value="focus"]') as HTMLInputElement;
    focusRadio.checked = true;
    focusRadio.dispatchEvent(new Event('change'));
    // 再切换到 smart
    const smartRadio = document.querySelector('input[name="project-mode"][value="smart"]') as HTMLInputElement;
    smartRadio.checked = true;
    smartRadio.dispatchEvent(new Event('change'));
    expect((document.getElementById('cfg-focus-project') as HTMLSelectElement).disabled).toBe(true);
  });
});

// ─── initListeners · 角色模式 ───────────────────────────

describe('initListeners · 角色模式切换', () => {
  it('切换角色模式应触发 updatePersonaModeBadge + personaModeChangeCallback', () => {
    const { manager, host } = createManager();
    const cb = vi.fn();
    manager.onPersonaModeChange(cb);
    const manualRadio = document.querySelector('input[name="persona-mode"][value="manual"]') as HTMLInputElement;
    manualRadio.checked = true;
    manualRadio.dispatchEvent(new Event('change'));
    expect(host.updatePersonaModeBadge).toHaveBeenCalledWith('manual');
    expect(cb).toHaveBeenCalledWith('manual');
  });
});

// ─── initListeners · 主题切换 ───────────────────────────

describe('initListeners · 主题切换', () => {
  it('切换主题单选按钮应触发 host.setTheme', () => {
    const { host } = createManager();
    const darkRadio = document.querySelector('input[name="theme-mode"][value="dark"]') as HTMLInputElement;
    darkRadio.checked = true;
    darkRadio.dispatchEvent(new Event('change'));
    expect(host.setTheme).toHaveBeenCalledWith('dark');
  });

  it('切换到 auto 应触发 host.setTheme("auto")', () => {
    const { host } = createManager();
    const autoRadio = document.querySelector('input[name="theme-mode"][value="auto"]') as HTMLInputElement;
    autoRadio.checked = true;
    autoRadio.dispatchEvent(new Event('change'));
    expect(host.setTheme).toHaveBeenCalledWith('auto');
  });
});

// ─── initListeners · tab 切换 ───────────────────────────

describe('initListeners · tab 切换', () => {
  it('click tab 按钮应切换 active 状态 + 切换内容区', () => {
    createManager();
    const tabs = document.querySelectorAll<HTMLElement>('.settings-tab');
    const contents = document.querySelectorAll<HTMLElement>('.settings-tab-content');
    // 初始 LLM tab active
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(contents[0].classList.contains('active')).toBe(true);
    // click 精灵 tab
    tabs[1].click();
    expect(tabs[1].classList.contains('active')).toBe(true);
    expect(tabs[0].classList.contains('active')).toBe(false);
    expect(contents[1].classList.contains('active')).toBe(true);
    expect(contents[0].classList.contains('active')).toBe(false);
  });
});

// ─── updateAgentStatusIndicator ─────────────────────────

describe('updateAgentStatusIndicator', () => {
  it('ready 状态应添加 ready 类 + 更新文案', () => {
    const { manager } = createManager();
    manager.updateAgentStatusIndicator('ready');
    const indicator = document.getElementById('agent-status-indicator')!;
    expect(indicator.classList.contains('ready')).toBe(true);
    expect(indicator.querySelector('.agent-status-text')!.textContent).toBe('Agent 已就绪');
  });

  it('error 状态应添加 error 类 + 更新文案', () => {
    const { manager } = createManager();
    manager.updateAgentStatusIndicator('error');
    const indicator = document.getElementById('agent-status-indicator')!;
    expect(indicator.classList.contains('error')).toBe(true);
    expect(indicator.querySelector('.agent-status-text')!.textContent).toBe('Agent 未就绪');
  });

  it('unknown 状态应添加 unknown 类 + 更新文案', () => {
    const { manager } = createManager();
    manager.updateAgentStatusIndicator('unknown');
    const indicator = document.getElementById('agent-status-indicator')!;
    expect(indicator.classList.contains('unknown')).toBe(true);
    expect(indicator.querySelector('.agent-status-text')!.textContent).toBe('检测中...');
  });

  it('应支持自定义消息文案', () => {
    const { manager } = createManager();
    manager.updateAgentStatusIndicator('error', 'API Key 无效');
    expect(document.querySelector('.agent-status-text')!.textContent).toBe('API Key 无效');
  });

  it('indicator 不存在时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new SettingsPanelManager(createMockHost());
    expect(() => manager.updateAgentStatusIndicator('ready')).not.toThrow();
  });
});

// ─── loadLlmConfigToForm ────────────────────────────────

describe('loadLlmConfigToForm', () => {
  it('应加载 LLM 配置到表单字段', () => {
    const { manager } = createManager();
    const config: LlmConfigForm = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      temperature: 0.5,
    };
    manager.loadLlmConfigToForm({ configured: true, config, embedding: null, presets: {} });
    expect((document.getElementById('cfg-llm-provider') as HTMLInputElement).value).toBe('openai');
    expect((document.getElementById('cfg-llm-model') as HTMLInputElement).value).toBe('gpt-4');
    expect((document.getElementById('cfg-llm-base-url') as HTMLInputElement).value).toBe('https://api.openai.com/v1');
    expect((document.getElementById('cfg-llm-api-key') as HTMLInputElement).value).toBe('sk-test');
    expect((document.getElementById('cfg-llm-temperature') as HTMLInputElement).value).toBe('0.5');
  });

  it('应加载后台 Provider 配置 + 启用字段', () => {
    const { manager } = createManager();
    const config: LlmConfigForm = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      temperature: 0.7,
      background: { enabled: true, provider: 'anthropic', model: 'claude', baseUrl: 'https://api.anthropic.com', apiKey: 'sk-bg' },
    };
    manager.loadLlmConfigToForm({ configured: true, config, embedding: null, presets: {} });
    expect((document.getElementById('cfg-bg-enabled') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('cfg-bg-provider') as HTMLInputElement).value).toBe('anthropic');
    expect((document.getElementById('cfg-bg-provider') as HTMLInputElement).disabled).toBe(false);
  });

  it('应加载 Embedding 配置', () => {
    const { manager } = createManager();
    manager.loadLlmConfigToForm({
      configured: true,
      config: { provider: '', model: '', baseUrl: '', apiKey: '', temperature: 0.7 },
      embedding: { model: 'text-embedding-3', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-emb' },
      presets: {},
    });
    expect((document.getElementById('cfg-emb-enabled') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('cfg-emb-model') as HTMLInputElement).value).toBe('text-embedding-3');
  });

  it('应反匹配预设（provider+model 匹配时选中对应预设）', () => {
    const { manager } = createManager();
    manager.loadLlmConfigToForm({
      configured: true,
      config: { provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
      embedding: null,
      presets: { openai: { provider: 'openai', model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' } },
    });
    expect((document.getElementById('cfg-llm-preset') as HTMLSelectElement).value).toBe('openai');
  });
});

// ─── collectLlmConfigFromForm ───────────────────────────

describe('collectLlmConfigFromForm', () => {
  it('应收集 LLM 配置（含 trim）', () => {
    const { manager } = createManager();
    (document.getElementById('cfg-llm-provider') as HTMLInputElement).value = '  openai  ';
    (document.getElementById('cfg-llm-model') as HTMLInputElement).value = '  gpt-4  ';
    (document.getElementById('cfg-llm-api-key') as HTMLInputElement).value = '  sk-test  ';
    const result = manager.collectLlmConfigFromForm();
    expect(result.llm.provider).toBe('openai');
    expect(result.llm.model).toBe('gpt-4');
    expect(result.llm.apiKey).toBe('sk-test');
  });

  it('temperature 非法时应降级为 0.7', () => {
    const { manager } = createManager();
    (document.getElementById('cfg-llm-temperature') as HTMLInputElement).value = 'invalid';
    const result = manager.collectLlmConfigFromForm();
    expect(result.llm.temperature).toBe(0.7);
  });

  it('bg-enabled 未勾选时 background.enabled 应为 false', () => {
    const { manager } = createManager();
    const result = manager.collectLlmConfigFromForm();
    expect(result.llm.background?.enabled).toBe(false);
  });

  it('bg-enabled 勾选时应收集后台 Provider 配置', () => {
    const { manager } = createManager();
    (document.getElementById('cfg-bg-enabled') as HTMLInputElement).checked = true;
    (document.getElementById('cfg-bg-provider') as HTMLInputElement).value = 'anthropic';
    const result = manager.collectLlmConfigFromForm();
    expect(result.llm.background?.enabled).toBe(true);
    expect(result.llm.background?.provider).toBe('anthropic');
  });

  it('emb-enabled 勾选时应收集 Embedding 配置', () => {
    const { manager } = createManager();
    (document.getElementById('cfg-emb-enabled') as HTMLInputElement).checked = true;
    (document.getElementById('cfg-emb-model') as HTMLInputElement).value = 'text-embedding-3';
    const result = manager.collectLlmConfigFromForm();
    expect(result.embedding?.enabled).toBe(true);
    expect(result.embedding?.model).toBe('text-embedding-3');
  });

  it('emb-enabled 未勾选时 embedding 应为 null', () => {
    const { manager } = createManager();
    const result = manager.collectLlmConfigFromForm();
    expect(result.embedding).toBeNull();
  });
});

// ─── loadConfigToForm + collectConfigFromForm ───────────

describe('loadConfigToForm + collectConfigFromForm', () => {
  it('应加载精灵配置到表单 + 回收一致', () => {
    const { manager } = createManager();
    const config: SpriteConfigForm = {
      theme: 'light',
      silentMode: true,
      proactiveThreshold: 5,
      proactiveCooldownMs: 600_000,
      triggerIntervalMs: 7_200_000,
      fileWatcherEnabled: true,
      fileWatcherPaths: ['.', 'src'],
      fileWatcherDebounceMs: 2000,
      defaultPersona: 'coder',
      projectMode: 'smart',
      focusProjectPath: '',
    };
    manager.loadConfigToForm(config);
    expect((document.getElementById('cfg-silent') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('cfg-threshold') as HTMLInputElement).value).toBe('5');
    expect((document.getElementById('cfg-cooldown') as HTMLInputElement).value).toBe('10'); // 600000ms / 60000 = 10
    expect((document.getElementById('cfg-interval') as HTMLInputElement).value).toBe('120'); // 7200000ms / 60000 = 120
    expect((document.getElementById('cfg-watcher-paths') as HTMLInputElement).value).toBe('., src');
    expect((document.getElementById('cfg-default-persona') as HTMLInputElement).value).toBe('coder');

    // 回收
    const collected = manager.collectConfigFromForm();
    expect(collected.silentMode).toBe(true);
    expect(collected.proactiveThreshold).toBe(5);
    expect(collected.proactiveCooldownMs).toBe(600_000);
    expect(collected.triggerIntervalMs).toBe(7_200_000);
    expect(collected.fileWatcherPaths).toEqual(['.', 'src']);
    expect(collected.fileWatcherDebounceMs).toBe(2000);
    expect(collected.defaultPersona).toBe('coder');
  });

  it('focus 项目模式应启用专注项目下拉框', () => {
    const { manager } = createManager();
    manager.loadConfigToForm({
      theme: 'light',
      silentMode: false,
      proactiveThreshold: 3,
      proactiveCooldownMs: 300_000,
      triggerIntervalMs: 3_600_000,
      fileWatcherEnabled: false,
      fileWatcherPaths: ['.'],
      fileWatcherDebounceMs: 1000,
      defaultPersona: '',
      projectMode: 'focus',
      focusProjectPath: '/project/path',
    });
    expect((document.getElementById('cfg-focus-project') as HTMLSelectElement).disabled).toBe(false);
  });
});

// ─── showLlmTestResult ──────────────────────────────────

describe('showLlmTestResult', () => {
  it('成功应显示 check 图标 + 连接成功 + 绿色', () => {
    const { manager } = createManager();
    manager.showLlmTestResult({ success: true, error: null }, 150);
    const el = document.getElementById('llm-test-result')!;
    // SVG 图标 + 文本分离：textContent 不含图标
    expect(el.querySelector('use')?.getAttribute('href')).toBe('#icon-check');
    expect(el.textContent).toBe(' 连接成功（150ms）');
    expect(el.style.color).toBe('var(--green)');
  });

  it('失败应显示 close 图标 + 失败 + 排查建议 + 红色', () => {
    const { manager } = createManager();
    manager.showLlmTestResult({ success: false, error: 'API Key 无效' });
    const el = document.getElementById('llm-test-result')!;
    expect(el.querySelector('use')?.getAttribute('href')).toBe('#icon-close');
    expect(el.textContent).toContain('失败：API Key 无效');
    expect(el.textContent).toContain('排查建议');
    expect(el.style.color).toBe('var(--red)');
  });

  it('result 元素不存在时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new SettingsPanelManager(createMockHost());
    expect(() => manager.showLlmTestResult({ success: true, error: null })).not.toThrow();
  });
});

// ─── 回调注册 ────────────────────────────────────────────

describe('回调注册', () => {
  it('onConfigSave 应注册回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    document.getElementById('btn-settings-save')!.click();
    expect(cb).toHaveBeenCalled();
  });

  it('onLlmConfigSave 应注册回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onLlmConfigSave(cb);
    manager['llmFormDirty'] = true;
    document.getElementById('btn-settings-save')!.click();
    expect(cb).toHaveBeenCalled();
  });

  it('onPersonaModeChange 应注册回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onPersonaModeChange(cb);
    const radio = document.querySelector('input[name="persona-mode"][value="manual"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    expect(cb).toHaveBeenCalledWith('manual');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 后按钮 click 不应触发回调', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    manager.cleanup();
    document.getElementById('btn-settings-save')!.click();
    expect(cb).not.toHaveBeenCalled();
  });

  it('cleanup 后主题切换不应触发 host.setTheme', () => {
    const { manager, host } = createManager();
    manager.cleanup();
    const radio = document.querySelector('input[name="theme-mode"][value="dark"]') as HTMLInputElement;
    radio.checked = true;
    radio.dispatchEvent(new Event('change'));
    expect(host.setTheme).not.toHaveBeenCalled();
  });
});
