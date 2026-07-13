/**
 * 多 Provider 管理子系统辅助测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - renderProviderList：空状态、激活卡片、非激活卡片、XSS 安全
 * - renderBackgroundProviderSelect：默认选项、Provider 选项、恢复选择
 * - showProviderForm/hideProviderForm：新增模式、编辑模式、隐藏
 * - saveProvider：必填校验、别名格式、Temperature 范围、重复 key、成功、失败
 * - testProviderConnection：缺失字段、成功、失败、异常
 * - deleteProvider：激活 Provider 守卫、取消确认、成功、失败
 * - setActiveProvider：成功、失败、warning
 * - loadProviderList：成功、错误
 * - initProviderListeners：按钮点击、事件委托
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（构建表单 + 卡片列表）
 * - Mock window.electronAPI.*（IPC 方法）
 * - 使用真实 EventTracker（验证事件注册与清理）
 * - Mock SettingsPanelHost 回调
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadProviderList,
  renderProviderList,
  renderBackgroundProviderSelect,
  showProviderForm,
  hideProviderForm,
  saveProvider,
  testProviderConnection,
  deleteProvider,
  setActiveProvider,
  initProviderListeners,
  type ProviderManagementContext,
} from '../../../electron/renderer/helpers/providerManagement.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { SettingsPanelHost } from '../../../electron/renderer/panels/settingsPanelManager.js';
import type { LlmProviderConfig } from '../../../electron/renderer/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Provider 配置 */
function createProvider(overrides?: Partial<LlmProviderConfig>): LlmProviderConfig {
  return {
    key: 'test-provider',
    name: 'Test Provider',
    provider: 'openai',
    model: 'gpt-4',
    baseUrl: '',
    apiKey: 'sk-****',
    temperature: 0.7,
    ...overrides,
  };
}

/** 创建 Mock SettingsPanelHost */
function createMockHost(): ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>> {
  return {
    setTheme: vi.fn(),
    updatePersonaModeBadge: vi.fn(),
    showConfirmDialog: vi.fn(async () => true),
    showToast: vi.fn(),
    switchPanel: vi.fn(),
  } as unknown as ReturnType<typeof vi.fn> & Record<string, ReturnType<typeof vi.fn>>;
}

/** 创建完整的 DOM 结构（Provider 表单 + 列表容器） */
function setupDOM(): {
  providerListEl: HTMLElement;
  providerModalEl: HTMLElement;
  providerModalTitleEl: HTMLElement;
  providerAliasInput: HTMLInputElement;
  providerDisplayInput: HTMLInputElement;
  providerProviderInput: HTMLInputElement;
  providerModelInput: HTMLInputElement;
  providerBaseUrlInput: HTMLInputElement;
  providerApiKeyInput: HTMLInputElement;
  providerTemperatureInput: HTMLInputElement;
  btnAddProvider: HTMLButtonElement;
  backgroundProviderSelect: HTMLSelectElement;
  btnProviderSave: HTMLButtonElement;
  btnProviderCancel: HTMLButtonElement;
  btnProviderTest: HTMLButtonElement;
} {
  document.body.innerHTML = `
    <div id="provider-list"></div>
    <div id="provider-modal" class="hidden">
      <h3 id="provider-modal-title"></h3>
      <input id="cfg-provider-alias" />
      <div id="cfg-provider-alias-error" class="hidden"></div>
      <input id="cfg-provider-display" />
      <input id="cfg-provider-provider" />
      <div id="cfg-provider-provider-error" class="hidden"></div>
      <input id="cfg-provider-model" />
      <div id="cfg-provider-model-error" class="hidden"></div>
      <input id="cfg-provider-api-key" />
      <div id="cfg-provider-api-key-error" class="hidden"></div>
      <input id="cfg-provider-temperature" />
      <div id="cfg-provider-temperature-error" class="hidden"></div>
      <input id="cfg-provider-base-url" />
      <button id="btn-add-provider">添加 API</button>
      <select id="background-provider-select"></select>
      <button id="btn-provider-save">保存</button>
      <button id="btn-provider-cancel">取消</button>
      <button id="btn-provider-test">测试连接</button>
    </div>
  `;
  return {
    providerListEl: document.getElementById('provider-list') as HTMLElement,
    providerModalEl: document.getElementById('provider-modal') as HTMLElement,
    providerModalTitleEl: document.getElementById('provider-modal-title') as HTMLElement,
    providerAliasInput: document.getElementById('cfg-provider-alias') as HTMLInputElement,
    providerDisplayInput: document.getElementById('cfg-provider-display') as HTMLInputElement,
    providerProviderInput: document.getElementById('cfg-provider-provider') as HTMLInputElement,
    providerModelInput: document.getElementById('cfg-provider-model') as HTMLInputElement,
    providerBaseUrlInput: document.getElementById('cfg-provider-base-url') as HTMLInputElement,
    providerApiKeyInput: document.getElementById('cfg-provider-api-key') as HTMLInputElement,
    providerTemperatureInput: document.getElementById('cfg-provider-temperature') as HTMLInputElement,
    btnAddProvider: document.getElementById('btn-add-provider') as HTMLButtonElement,
    backgroundProviderSelect: document.getElementById('background-provider-select') as HTMLSelectElement,
    btnProviderSave: document.getElementById('btn-provider-save') as HTMLButtonElement,
    btnProviderCancel: document.getElementById('btn-provider-cancel') as HTMLButtonElement,
    btnProviderTest: document.getElementById('btn-provider-test') as HTMLButtonElement,
  };
}

/** 创建 ProviderManagementContext */
function createCtx(dom: ReturnType<typeof setupDOM>, cachedProviders: LlmProviderConfig[] = []): {
  ctx: ProviderManagementContext;
  host: ReturnType<typeof createMockHost>;
  events: EventTracker;
  setCachedProviders: ReturnType<typeof vi.fn>;
  getCachedProviders: ReturnType<typeof vi.fn>;
} {
  const host = createMockHost();
  const events = new EventTracker();
  const getCachedProviders = vi.fn(() => cachedProviders);
  const setCachedProviders = vi.fn((providers: LlmProviderConfig[]) => { cachedProviders = providers; });
  const ctx: ProviderManagementContext = {
    host: host as unknown as SettingsPanelHost,
    events,
    providerListEl: dom.providerListEl,
    providerModalEl: dom.providerModalEl,
    providerModalTitleEl: dom.providerModalTitleEl,
    providerAliasInput: dom.providerAliasInput,
    providerDisplayInput: dom.providerDisplayInput,
    providerProviderInput: dom.providerProviderInput,
    providerModelInput: dom.providerModelInput,
    providerBaseUrlInput: dom.providerBaseUrlInput,
    providerApiKeyInput: dom.providerApiKeyInput,
    providerTemperatureInput: dom.providerTemperatureInput,
    btnAddProvider: dom.btnAddProvider,
    backgroundProviderSelect: dom.backgroundProviderSelect,
    btnProviderSave: dom.btnProviderSave,
    btnProviderCancel: dom.btnProviderCancel,
    btnProviderTest: dom.btnProviderTest,
    getCachedProviders,
    setCachedProviders,
  };
  return { ctx, host, events, setCachedProviders, getCachedProviders };
}

/** Mock window.electronAPI */
function mockElectronAPI(overrides?: Record<string, ReturnType<typeof vi.fn>>): void {
  const api = {
    listLlmProviders: vi.fn(async () => ({ active: 'test-provider', providers: [createProvider()] })),
    saveLlmProvider: vi.fn(async () => ({ success: true, error: null })),
    deleteLlmProvider: vi.fn(async () => ({ success: true, error: null })),
    setActiveLlmProvider: vi.fn(async () => ({ success: true, error: null, warning: undefined })),
    testLlmConfig: vi.fn(async () => ({ success: true, error: null })),
    rendererLog: vi.fn(),
    ...overrides,
  };
  Object.defineProperty(window, 'electronAPI', {
    value: api,
    configurable: true,
    writable: true,
  });
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  mockElectronAPI();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. renderProviderList ─────────────────────────────

describe('renderProviderList', () => {
  it('空列表应显示空状态提示', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    renderProviderList(ctx, '', []);
    const hint = dom.providerListEl.querySelector('.settings-hint');
    expect(hint?.textContent).toContain('暂未配置任何 API');
  });

  it('激活 Provider 卡片应包含 active 类和当前徽章', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const provider = createProvider({ key: 'active', name: 'Active' });
    renderProviderList(ctx, 'active', [provider]);
    const card = dom.providerListEl.querySelector('.provider-card') as HTMLElement;
    expect(card.classList.contains('active')).toBe(true);
    expect(card.dataset.providerKey).toBe('active');
    const badge = card.querySelector('.provider-active-badge');
    expect(badge?.textContent).toBe('当前');
  });

  it('非激活 Provider 卡片应包含设为当前/编辑/删除按钮', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const provider = createProvider({ key: 'inactive', name: 'Inactive' });
    renderProviderList(ctx, 'other', [provider]);
    const card = dom.providerListEl.querySelector('.provider-card') as HTMLElement;
    expect(card.classList.contains('active')).toBe(false);
    const activateBtn = card.querySelector('[data-action="activate"]') as HTMLButtonElement;
    const editBtn = card.querySelector('[data-action="edit"]') as HTMLButtonElement;
    const deleteBtn = card.querySelector('[data-action="delete"]') as HTMLButtonElement;
    expect(activateBtn).toBeTruthy();
    expect(editBtn).toBeTruthy();
    expect(deleteBtn).toBeTruthy();
    expect(activateBtn.dataset.key).toBe('inactive');
  });

  it('激活 Provider 不应有设为当前/删除按钮', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const provider = createProvider({ key: 'active' });
    renderProviderList(ctx, 'active', [provider]);
    const card = dom.providerListEl.querySelector('.provider-card') as HTMLElement;
    expect(card.querySelector('[data-action="activate"]')).toBeNull();
    expect(card.querySelector('[data-action="delete"]')).toBeNull();
    // 编辑按钮仍存在
    expect(card.querySelector('[data-action="edit"]')).toBeTruthy();
  });

  it('Provider 名称应使用 textContent（XSS 安全）', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const provider = createProvider({ name: '<script>alert(1)</script>' });
    renderProviderList(ctx, '', [provider]);
    const nameSpan = dom.providerListEl.querySelector('.provider-name') as HTMLElement;
    // textContent 自动转义，不会解析为 HTML
    expect(nameSpan.textContent).toBe('<script>alert(1)</script>');
    expect(dom.providerListEl.querySelector('script')).toBeNull();
  });

  it('多个 Provider 应渲染多个卡片', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const providers = [
      createProvider({ key: 'p1', name: 'Provider 1' }),
      createProvider({ key: 'p2', name: 'Provider 2' }),
      createProvider({ key: 'p3', name: 'Provider 3' }),
    ];
    renderProviderList(ctx, 'p2', providers);
    const cards = dom.providerListEl.querySelectorAll('.provider-card');
    expect(cards.length).toBe(3);
    // p2 应是激活的
    expect(cards[1].classList.contains('active')).toBe(true);
  });

  it('providerListEl 为 null 应静默返回', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    // 覆盖为 null
    (ctx as { providerListEl: HTMLElement | null }).providerListEl = null;
    expect(() => renderProviderList(ctx, '', [])).not.toThrow();
  });
});

// ─── 2. renderBackgroundProviderSelect ─────────────────

describe('renderBackgroundProviderSelect', () => {
  it('应包含默认选项"与实时对话相同"', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    renderBackgroundProviderSelect(ctx, []);
    const options = dom.backgroundProviderSelect.querySelectorAll('option');
    expect(options.length).toBe(1);
    expect(options[0].value).toBe('');
    expect(options[0].textContent).toBe('与实时对话相同');
  });

  it('应渲染所有 Provider 选项', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const providers = [
      createProvider({ key: 'p1', name: 'P1', provider: 'openai', model: 'gpt-4' }),
      createProvider({ key: 'p2', name: 'P2', provider: 'deepseek', model: 'deepseek-chat' }),
    ];
    renderBackgroundProviderSelect(ctx, providers);
    const options = dom.backgroundProviderSelect.querySelectorAll('option');
    expect(options.length).toBe(3); // 默认 + 2 Provider
    expect(options[1].value).toBe('p1');
    expect(options[1].textContent).toBe('P1 (openai · gpt-4)');
    expect(options[2].value).toBe('p2');
  });

  it('刷新后应恢复用户之前的选择', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const providers = [createProvider({ key: 'p1' }), createProvider({ key: 'p2' })];
    renderBackgroundProviderSelect(ctx, providers);
    dom.backgroundProviderSelect.value = 'p2';
    // 再次渲染（模拟列表刷新）
    renderBackgroundProviderSelect(ctx, providers);
    expect(dom.backgroundProviderSelect.value).toBe('p2');
  });

  it('之前的选择不在新列表中应不恢复', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    const providers = [createProvider({ key: 'p1' }), createProvider({ key: 'p2' })];
    renderBackgroundProviderSelect(ctx, providers);
    dom.backgroundProviderSelect.value = 'p2';
    // 新列表不包含 p2
    renderBackgroundProviderSelect(ctx, [createProvider({ key: 'p1' })]);
    expect(dom.backgroundProviderSelect.value).toBe('');
  });

  it('backgroundProviderSelect 为 null 应静默返回', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    (ctx as { backgroundProviderSelect: HTMLSelectElement | null }).backgroundProviderSelect = null;
    expect(() => renderBackgroundProviderSelect(ctx, [])).not.toThrow();
  });
});

// ─── 3. showProviderForm / hideProviderForm ────────────

describe('showProviderForm', () => {
  it('新增模式应清空所有字段并设置标题', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    showProviderForm(ctx, '');
    expect(dom.providerModalTitleEl.textContent).toBe('添加 API');
    expect(dom.providerAliasInput.value).toBe('');
    expect(dom.providerAliasInput.disabled).toBe(false);
    expect(dom.providerDisplayInput.value).toBe('');
    expect(dom.providerProviderInput.value).toBe('');
    expect(dom.providerModelInput.value).toBe('');
    expect(dom.providerApiKeyInput.value).toBe('');
    expect(dom.providerTemperatureInput.value).toBe('');
  });

  it('编辑模式应从缓存填充字段并禁用别名输入', () => {
    const dom = setupDOM();
    const cached = createProvider({
      key: 'test-key', name: 'Test', provider: 'openai',
      model: 'gpt-4', baseUrl: 'https://api.openai.com',
      apiKey: 'sk-1234****5678', temperature: 0.5,
    });
    const { ctx } = createCtx(dom, [cached]);
    showProviderForm(ctx, 'test-key');
    expect(dom.providerModalTitleEl.textContent).toBe('编辑 API');
    expect(dom.providerAliasInput.value).toBe('test-key');
    expect(dom.providerAliasInput.disabled).toBe(true);
    expect(dom.providerDisplayInput.value).toBe('Test');
    expect(dom.providerProviderInput.value).toBe('openai');
    expect(dom.providerModelInput.value).toBe('gpt-4');
    expect(dom.providerBaseUrlInput.value).toBe('https://api.openai.com');
    expect(dom.providerApiKeyInput.value).toBe('sk-1234****5678');
    expect(dom.providerTemperatureInput.value).toBe('0.5');
  });

  it('编辑模式缓存中找不到 Provider 应降级使用默认值', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom, []);
    showProviderForm(ctx, 'missing-key');
    expect(dom.providerModalTitleEl.textContent).toBe('编辑 API');
    expect(dom.providerAliasInput.value).toBe('missing-key');
    // displayInput 降级为 key
    expect(dom.providerDisplayInput.value).toBe('missing-key');
    // 其他字段为空
    expect(dom.providerProviderInput.value).toBe('');
    expect(dom.providerModelInput.value).toBe('');
  });

  it('应移除 hidden 类显示弹窗', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(true);
    showProviderForm(ctx, '');
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(false);
    expect(dom.providerModalEl.dataset.editKey).toBe('');
  });

  it('编辑模式应设置 editKey', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    showProviderForm(ctx, 'edit-key');
    expect(dom.providerModalEl.dataset.editKey).toBe('edit-key');
  });

  it('providerModalEl 为 null 应静默返回', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    (ctx as { providerModalEl: HTMLElement | null }).providerModalEl = null;
    expect(() => showProviderForm(ctx, '')).not.toThrow();
  });
});

describe('hideProviderForm', () => {
  it('应添加 hidden 类隐藏弹窗并清空 editKey', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    showProviderForm(ctx, 'test');
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(false);
    hideProviderForm(ctx);
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(true);
    expect(dom.providerModalEl.dataset.editKey).toBe('');
  });

  it('providerModalEl 为 null 应静默返回', () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    (ctx as { providerModalEl: HTMLElement | null }).providerModalEl = null;
    expect(() => hideProviderForm(ctx)).not.toThrow();
  });
});

// ─── 4. saveProvider ───────────────────────────────────

describe('saveProvider', () => {
  it('缺少别名应显示字段错误', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerAliasInput.getAttribute('aria-invalid')).toBe('true');
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('缺少提供商应显示字段错误', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    dom.providerAliasInput.value = 'test';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerProviderInput.getAttribute('aria-invalid')).toBe('true');
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('缺少模型应显示字段错误', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'test';
    dom.providerProviderInput.value = 'openai';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerModelInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('缺少 API Key 应显示字段错误', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'test';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    await saveProvider(ctx);
    expect(dom.providerApiKeyInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('别名格式不合法应显示错误', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    dom.providerAliasInput.value = '中文别名';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerAliasInput.getAttribute('aria-invalid')).toBe('true');
    const errorEl = document.getElementById('cfg-provider-alias-error');
    expect(errorEl?.textContent).toContain('仅支持英文');
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('别名超 50 字符应显示错误', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'a'.repeat(51);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerAliasInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('Temperature 超范围应显示错误', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'test';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    dom.providerTemperatureInput.value = '3';
    await saveProvider(ctx);
    expect(dom.providerTemperatureInput.getAttribute('aria-invalid')).toBe('true');
    const errorEl = document.getElementById('cfg-provider-temperature-error');
    expect(errorEl?.textContent).toContain('0-2');
  });

  it('Temperature 为负数应显示错误', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'test';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    dom.providerTemperatureInput.value = '-0.5';
    await saveProvider(ctx);
    expect(dom.providerTemperatureInput.getAttribute('aria-invalid')).toBe('true');
  });

  it('新增模式重复别名应显示错误', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({
        active: 'existing',
        providers: [createProvider({ key: 'existing' })],
      })),
    });
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'existing';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(dom.providerAliasInput.getAttribute('aria-invalid')).toBe('true');
    const errorEl = document.getElementById('cfg-provider-alias-error');
    expect(errorEl?.textContent).toContain('已存在');
  });

  it('成功保存应显示 toast 并隐藏弹窗', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    showProviderForm(ctx, ''); // 显示弹窗（会清空字段）
    // 在 showProviderForm 之后设置输入值
    dom.providerAliasInput.value = 'new-provider';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(host.showToast).toHaveBeenCalledWith('服务商保存成功');
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(true);
  });

  it('保存失败应显示错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      saveLlmProvider: vi.fn(async () => ({ success: false, error: '保存失败原因' })),
    });
    const { ctx, host } = createCtx(dom);
    dom.providerAliasInput.value = 'new-provider';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await saveProvider(ctx);
    expect(host.showToast).toHaveBeenCalledWith('保存失败原因', 'error');
  });

  it('保存按钮应禁用并在完成后恢复', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerAliasInput.value = 'new-provider';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    const originalText = dom.btnProviderSave.textContent;
    await saveProvider(ctx);
    expect(dom.btnProviderSave.disabled).toBe(false);
    expect(dom.btnProviderSave.textContent).toBe(originalText);
  });

  it('编辑模式不检查重复别名', async () => {
    const dom = setupDOM();
    const listCall = vi.fn(async () => ({
      active: 'existing',
      providers: [createProvider({ key: 'existing' })],
    }));
    mockElectronAPI({ listLlmProviders: listCall });
    const { ctx, host } = createCtx(dom);
    dom.providerAliasInput.value = 'existing';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    // 设置 editKey 表示编辑模式
    dom.providerModalEl.dataset.editKey = 'existing';
    await saveProvider(ctx);
    // 编辑模式跳过重复检查，但 loadProviderList 仍会调用 listLlmProviders
    // 因此 listLlmProviders 应仅被调用 1 次（来自 loadProviderList），而非 2 次
    expect(listCall).toHaveBeenCalledTimes(1);
    expect(host.showToast).toHaveBeenCalledWith('服务商保存成功');
  });
});

// ─── 5. testProviderConnection ─────────────────────────

describe('testProviderConnection', () => {
  it('缺少必填字段应提示错误', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    dom.providerProviderInput.value = '';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await testProviderConnection(ctx);
    expect(host.showToast).toHaveBeenCalledWith('请填写提供商、模型和 API Key', 'error');
  });

  it('连接成功应显示成功 toast', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await testProviderConnection(ctx);
    expect(host.showToast).toHaveBeenCalledWith('连接成功', 'success');
  });

  it('连接失败应显示错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      testLlmConfig: vi.fn(async () => ({ success: false, error: '无效的 API Key' })),
    });
    const { ctx, host } = createCtx(dom);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await testProviderConnection(ctx);
    expect(host.showToast).toHaveBeenCalledWith('无效的 API Key', 'error');
  });

  it('异常应显示网络错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      testLlmConfig: vi.fn(async () => { throw new Error('Network error'); }),
    });
    const { ctx, host } = createCtx(dom);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await testProviderConnection(ctx);
    expect(host.showToast).toHaveBeenCalledWith('测试异常，请检查网络', 'error');
  });

  it('测试按钮应禁用并在完成后恢复', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    const originalText = dom.btnProviderTest.textContent;
    await testProviderConnection(ctx);
    expect(dom.btnProviderTest.disabled).toBe(false);
    expect(dom.btnProviderTest.textContent).toBe(originalText);
  });

  it('btnProviderTest 为 null 应静默返回', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    (ctx as { btnProviderTest: HTMLButtonElement | null }).btnProviderTest = null;
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    await expect(testProviderConnection(ctx)).resolves.toBeUndefined();
  });
});

// ─── 6. deleteProvider ─────────────────────────────────

describe('deleteProvider', () => {
  it('删除激活 Provider 应被拒绝', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({
        active: 'active-key',
        providers: [createProvider({ key: 'active-key' })],
      })),
    });
    const { ctx, host } = createCtx(dom);
    await deleteProvider(ctx, 'active-key');
    expect(host.showToast).toHaveBeenCalledWith('不能删除当前激活的服务商，请先切换到其他服务商', 'error');
  });

  it('用户取消确认应不删除', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    host.showConfirmDialog = vi.fn(async () => false);
    await deleteProvider(ctx, 'test-provider');
    expect(window.electronAPI.deleteLlmProvider).not.toHaveBeenCalled();
  });

  it('确认删除成功应显示 toast', async () => {
    const dom = setupDOM();
    // mock active 为其他 Provider，使 'test-provider' 可被删除
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({
        active: 'other-provider',
        providers: [createProvider({ key: 'test-provider' })],
      })),
    });
    const { ctx, host } = createCtx(dom);
    await deleteProvider(ctx, 'test-provider');
    expect(host.showToast).toHaveBeenCalledWith('服务商已删除');
  });

  it('删除失败应显示错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({
        active: 'other-provider',
        providers: [createProvider({ key: 'test-provider' })],
      })),
      deleteLlmProvider: vi.fn(async () => ({ success: false, error: '删除失败' })),
    });
    const { ctx, host } = createCtx(dom);
    await deleteProvider(ctx, 'test-provider');
    expect(host.showToast).toHaveBeenCalledWith('删除失败', 'error');
  });

  it('确认弹窗应包含 danger 标记', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({
        active: 'other-provider',
        providers: [createProvider({ key: 'test-provider' })],
      })),
    });
    const { ctx, host } = createCtx(dom);
    await deleteProvider(ctx, 'test-provider');
    expect(host.showConfirmDialog).toHaveBeenCalledWith({
      title: '删除 Provider',
      message: '确定删除 Provider "test-provider"？',
      confirmText: '删除',
      danger: true,
    });
  });
});

// ─── 7. setActiveProvider ──────────────────────────────

describe('setActiveProvider', () => {
  it('切换成功应显示成功 toast', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    await setActiveProvider(ctx, 'new-provider');
    expect(host.showToast).toHaveBeenCalledWith('已切换 Provider', 'success');
  });

  it('切换成功带 warning 应显示 warning toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      setActiveLlmProvider: vi.fn(async () => ({
        success: true, error: null, warning: '需要重启生效',
      })),
    });
    const { ctx, host } = createCtx(dom);
    await setActiveProvider(ctx, 'new-provider');
    expect(host.showToast).toHaveBeenCalledWith('需要重启生效', 'warning');
  });

  it('切换失败应显示错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      setActiveLlmProvider: vi.fn(async () => ({
        success: false, error: '切换失败原因', warning: undefined,
      })),
    });
    const { ctx, host } = createCtx(dom);
    await setActiveProvider(ctx, 'new-provider');
    expect(host.showToast).toHaveBeenCalledWith('切换失败原因', 'error');
  });
});

// ─── 8. loadProviderList ───────────────────────────────

describe('loadProviderList', () => {
  it('成功加载应渲染列表并缓存 Provider', async () => {
    const dom = setupDOM();
    const providers = [createProvider({ key: 'p1' }), createProvider({ key: 'p2' })];
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => ({ active: 'p1', providers })),
    });
    const { ctx, setCachedProviders, host } = createCtx(dom);
    await loadProviderList(ctx);
    expect(setCachedProviders).toHaveBeenCalledWith(providers);
    expect(dom.providerListEl.querySelectorAll('.provider-card').length).toBe(2);
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('加载失败应渲染错误占位符 + 重试按钮并显示错误 toast', async () => {
    const dom = setupDOM();
    mockElectronAPI({
      listLlmProviders: vi.fn(async () => { throw new Error('加载失败'); }),
    });
    const { ctx, host } = createCtx(dom);
    await loadProviderList(ctx);
    expect(host.showToast).toHaveBeenCalledWith('加载服务商列表失败，请稍后重试', 'error');
    // UX-0712-9：catch 分支渲染错误占位符 + 重试按钮，而非清空列表
    const errorHint = dom.providerListEl.querySelector('.provider-load-error');
    expect(errorHint).toBeTruthy();
    expect(errorHint?.querySelector('p')?.textContent).toBe('加载服务商列表失败');
    const retryBtn = errorHint?.querySelector('button');
    expect(retryBtn).toBeTruthy();
    expect(retryBtn?.textContent).toBe('重试');
  });

  it('providerListEl 为 null 应静默返回', async () => {
    const dom = setupDOM();
    const { ctx } = createCtx(dom);
    (ctx as { providerListEl: HTMLElement | null }).providerListEl = null;
    await expect(loadProviderList(ctx)).resolves.toBeUndefined();
  });

  it('加载成功应调用 onProviderChanged 回调', async () => {
    const dom = setupDOM();
    const { ctx, host } = createCtx(dom);
    host.onProviderChanged = vi.fn();
    await loadProviderList(ctx);
    expect(host.onProviderChanged).toHaveBeenCalled();
  });
});

// ─── 9. initProviderListeners ──────────────────────────

describe('initProviderListeners', () => {
  it('点击添加按钮应显示新增表单', () => {
    const dom = setupDOM();
    const { ctx, events } = createCtx(dom);
    initProviderListeners(ctx);
    dom.btnAddProvider.click();
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(false);
    expect(dom.providerModalTitleEl.textContent).toBe('添加 API');
    events.cleanup();
  });

  it('点击取消按钮应隐藏弹窗', () => {
    const dom = setupDOM();
    const { ctx, events } = createCtx(dom);
    initProviderListeners(ctx);
    showProviderForm(ctx, '');
    dom.btnProviderCancel.click();
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(true);
    events.cleanup();
  });

  it('点击保存按钮应触发 saveProvider', async () => {
    const dom = setupDOM();
    const { ctx, events, host } = createCtx(dom);
    initProviderListeners(ctx);
    dom.providerAliasInput.value = 'test';
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    dom.btnProviderSave.click();
    // 等待异步操作完成
    await vi.waitFor(() => {
      expect(host.showToast).toHaveBeenCalledWith('服务商保存成功');
    });
    events.cleanup();
  });

  it('点击测试连接按钮应触发 testProviderConnection', async () => {
    const dom = setupDOM();
    const { ctx, events, host } = createCtx(dom);
    initProviderListeners(ctx);
    dom.providerProviderInput.value = 'openai';
    dom.providerModelInput.value = 'gpt-4';
    dom.providerApiKeyInput.value = 'sk-xxx';
    dom.btnProviderTest.click();
    await vi.waitFor(() => {
      expect(host.showToast).toHaveBeenCalledWith('连接成功', 'success');
    });
    events.cleanup();
  });

  it('点击编辑按钮应显示编辑表单', () => {
    const dom = setupDOM();
    const { ctx, events } = createCtx(dom);
    initProviderListeners(ctx);
    // 渲染卡片列表
    renderProviderList(ctx, '', [createProvider({ key: 'edit-target' })]);
    const editBtn = dom.providerListEl.querySelector('[data-action="edit"]') as HTMLButtonElement;
    editBtn.click();
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(false);
    expect(dom.providerModalTitleEl.textContent).toBe('编辑 API');
    expect(dom.providerAliasInput.value).toBe('edit-target');
    events.cleanup();
  });

  it('点击设为当前按钮应触发 setActiveProvider', async () => {
    const dom = setupDOM();
    const { ctx, events, host } = createCtx(dom);
    initProviderListeners(ctx);
    renderProviderList(ctx, 'other', [createProvider({ key: 'activate-target' })]);
    const activateBtn = dom.providerListEl.querySelector('[data-action="activate"]') as HTMLButtonElement;
    activateBtn.click();
    await vi.waitFor(() => {
      expect(host.showToast).toHaveBeenCalledWith('已切换 Provider', 'success');
    });
    events.cleanup();
  });

  it('点击删除按钮应触发 deleteProvider', async () => {
    const dom = setupDOM();
    const { ctx, events, host } = createCtx(dom);
    initProviderListeners(ctx);
    renderProviderList(ctx, 'other', [createProvider({ key: 'delete-target' })]);
    const deleteBtn = dom.providerListEl.querySelector('[data-action="delete"]') as HTMLButtonElement;
    deleteBtn.click();
    await vi.waitFor(() => {
      expect(host.showToast).toHaveBeenCalledWith('服务商已删除');
    });
    events.cleanup();
  });

  it('cleanup 应移除所有事件监听器', () => {
    const dom = setupDOM();
    const { ctx, events } = createCtx(dom);
    initProviderListeners(ctx);
    events.cleanup();
    // cleanup 后点击按钮不应触发
    dom.btnAddProvider.click();
    expect(dom.providerModalEl.classList.contains('hidden')).toBe(true);
  });

  it('所有按钮为 null 应静默返回', () => {
    const dom = setupDOM();
    const { ctx, events } = createCtx(dom);
    (ctx as { btnAddProvider: HTMLButtonElement | null }).btnAddProvider = null;
    (ctx as { btnProviderSave: HTMLButtonElement | null }).btnProviderSave = null;
    (ctx as { btnProviderCancel: HTMLButtonElement | null }).btnProviderCancel = null;
    (ctx as { btnProviderTest: HTMLButtonElement | null }).btnProviderTest = null;
    expect(() => initProviderListeners(ctx)).not.toThrow();
    events.cleanup();
  });
});
