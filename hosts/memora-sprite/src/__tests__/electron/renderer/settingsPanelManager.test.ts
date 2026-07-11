/**
 * 设置面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - initListeners：tab 切换 / API Key 切换 / dirty 追踪 /
 *   保存按钮 / 取消按钮（dirty 确认）/ 恢复默认 /
 *   项目模式联动 / 角色模式 / 主题切换 / 稍后配置
 * - updateAgentStatusIndicator：三态 + null 降级
 * - loadConfigToForm：加载精灵配置 + 项目模式 + 专注项目联动
 * - collectConfigFromForm：收集精灵配置 + 项目模式 + 主题
 * - renderSkills：空列表隐藏 / 非空渲染 / 关键词标签 / 层级标签（从 dashboardPanelManager 迁入）
 * - 回调注册：onConfigSave / onConfigCancel / onPersonaModeChange
 * - cleanup：事件监听器解绑
 *
 * 说明：单模型 LLM 表单已移除（loadLlmConfigToForm 为 no-op、collectLlmConfigFromForm 返回 null），
 * 相关测试已删除。Provider 列表管理由独立的 loadProviderList 管理，不在本测试覆盖范围内。
 *
 * Mock 策略：
 * - Mock SettingsPanelHost 接口（setTheme/updatePersonaModeBadge/showConfirmDialog/showToast/switchPanel）
 * - 真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SettingsPanelManager, type SettingsPanelHost } from '../../../electron/renderer/panels/settingsPanelManager.js';
import type { SpriteConfigForm } from '../../../electron/renderer/types.js';

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

/** 设置面板完整 DOM 结构（Provider 表单 + Embedding + 精灵配置 + 快捷键 + 按钮 + 单选按钮） */
const SETTINGS_HTML = `
  <div id="panel-settings">
    <!-- Provider 表单（多 Provider 管理；API Key 切换测试使用） -->
    <input id="cfg-provider-alias" type="text" />
    <input id="cfg-provider-display" type="text" />
    <input id="cfg-provider-provider" type="text" />
    <input id="cfg-provider-model" type="text" />
    <input id="cfg-provider-base-url" type="text" />
    <input id="cfg-provider-api-key" type="password" />
    <input id="cfg-provider-temperature" type="number" value="0.7" />
    <button id="btn-toggle-provider-key">👁</button>

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
    <input id="cfg-watcher-ignore" type="text" />
    <input id="cfg-default-persona" type="text" />
    <select id="cfg-focus-project"><option value="">选择项目</option></select>

    <!-- 快捷键配置（Phase 3.3） -->
    <input id="cfg-shortcuts-enabled" type="checkbox" />
    <input id="cfg-shortcut-toggle-window" type="text" />
    <input id="cfg-shortcut-quick-record" type="text" />
    <input id="cfg-shortcut-recall-memory" type="text" />

    <!-- 按钮 -->
    <button id="btn-settings-reset">恢复默认</button>
    <button id="btn-settings-skip">稍后配置</button>

    <!-- 单选按钮组 -->
    <input type="radio" name="persona-mode" value="auto" checked />
    <input type="radio" name="persona-mode" value="manual" />
    <input type="radio" name="project-mode" value="smart" checked />
    <input type="radio" name="project-mode" value="focus" />
    <input type="radio" name="theme-mode" value="light" checked />
    <input type="radio" name="theme-mode" value="dark" />
    <input type="radio" name="theme-mode" value="auto" />
    <input type="radio" name="archive-mode" value="full" checked />
    <input type="radio" name="archive-mode" value="insights-only" />
    <input type="radio" name="archive-mode" value="manual" />

    <!-- 状态显示 -->
    <div id="agent-status-indicator"><span class="agent-status-text">检测中...</span></div>
    <!-- 保存状态指示器（初始 idle 隐藏） -->
    <div id="save-status-indicator" class="save-status-indicator idle">
      <span class="save-status-icon"></span>
      <span class="save-status-text"></span>
    </div>

    <!-- 技能管理 tab DOM（renderSkills 从 dashboardPanelManager 迁入） -->
    <div id="skills-section" class="skill-section hidden">
      <ul id="skills-list" class="skills-list"></ul>
    </div>
    <div id="skills-empty" class="profile-empty">暂无已安装技能</div>

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
    const input = document.getElementById('cfg-provider-api-key') as HTMLInputElement;
    const btn = document.getElementById('btn-toggle-provider-key') as HTMLButtonElement;
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

  it('resetFormDirty 应清除 dirty 标志', () => {
    const { manager } = createManager();
    manager['settingsFormDirty'] = true;
    manager.resetFormDirty();
    expect(manager.isDirty()).toBe(false);
  });
});

// ─── initListeners · 保存按钮 ────────────────────────────

describe('initListeners · 自动保存', () => {
  it('表单输入应触发自动保存 + 清除 dirty', async () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    // 先标记 dirty
    manager['settingsFormDirty'] = true;
    const input = document.getElementById('cfg-threshold') as HTMLInputElement;
    input.value = '5';
    // 事件需要冒泡到父元素 #panel-settings
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ silentMode: expect.any(Boolean) }));
    // dirty 应被清除
    expect(manager.isDirty()).toBe(false);
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
    expect(host.showToast).toHaveBeenCalledWith('已恢复默认设置，将自动保存', 'info');
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

// ─── initListeners · tab 合并（7 tab 完整结构）───────────

describe('initListeners · tab 合并', () => {
  // 7 tab 完整 DOM（对齐 index.html：嵌入已合并到大模型、作品已合并到画像与作品）
  const TABS_HTML = `
    <div id="panel-settings">
      <div class="settings-tabs">
        <button class="settings-tab active" data-settings-tab="llm">大模型</button>
        <button class="settings-tab" data-settings-tab="sprite">精灵</button>
        <button class="settings-tab" data-settings-tab="project">项目</button>
        <button class="settings-tab" data-settings-tab="profile">画像与作品</button>
        <button class="settings-tab" data-settings-tab="audit">审计</button>
        <button class="settings-tab" data-settings-tab="skill">技能</button>
        <button class="settings-tab" data-settings-tab="help">帮助</button>
      </div>
      <div class="settings-tab-content active" data-settings-tab="llm"></div>
      <div class="settings-tab-content" data-settings-tab="sprite"></div>
      <div class="settings-tab-content" data-settings-tab="project"></div>
      <div class="settings-tab-content" data-settings-tab="profile"></div>
      <div class="settings-tab-content" data-settings-tab="audit"></div>
      <div class="settings-tab-content" data-settings-tab="skill"></div>
      <div class="settings-tab-content" data-settings-tab="help"></div>
    </div>
  `;

  it('7 tab 完整结构下应能正确切换任意 tab', () => {
    createManager({ html: TABS_HTML });
    const tabs = document.querySelectorAll<HTMLElement>('.settings-tab');
    const contents = document.querySelectorAll<HTMLElement>('.settings-tab-content');
    expect(tabs.length).toBe(7);
    expect(contents.length).toBe(7);

    // 依次点击每个 tab，验证 active 状态切换
    tabs.forEach((tab, idx) => {
      tab.click();
      expect(tab.classList.contains('active')).toBe(true);
      expect(contents[idx].classList.contains('active')).toBe(true);
      // 其他 tab 应取消 active
      tabs.forEach((other, otherIdx) => {
        if (otherIdx !== idx) {
          expect(other.classList.contains('active')).toBe(false);
          expect(contents[otherIdx].classList.contains('active')).toBe(false);
        }
      });
    });
  });

  it('切换到画像与作品 tab 应触发 onSettingsTabSwitch("profile") 回调', () => {
    const onSettingsTabSwitch = vi.fn();
    const host = createMockHost({ onSettingsTabSwitch });
    createManager({ host, html: TABS_HTML });

    const profileTab = document.querySelector<HTMLElement>('.settings-tab[data-settings-tab="profile"]')!;
    profileTab.click();

    expect(onSettingsTabSwitch).toHaveBeenCalledWith('profile');
  });

  it('切换到审计 tab 应触发 onSettingsTabSwitch("audit") 回调', () => {
    const onSettingsTabSwitch = vi.fn();
    const host = createMockHost({ onSettingsTabSwitch });
    createManager({ host, html: TABS_HTML });

    const auditTab = document.querySelector<HTMLElement>('.settings-tab[data-settings-tab="audit"]')!;
    auditTab.click();

    expect(onSettingsTabSwitch).toHaveBeenCalledWith('audit');
  });

  it('切换 tab 应同步 aria-selected 属性', () => {
    createManager({ html: TABS_HTML });
    const tabs = document.querySelectorAll<HTMLElement>('.settings-tab');

    // 初始第一个 tab aria-selected=true
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');

    // 点击画像与作品 tab
    tabs[3].click();
    expect(tabs[3].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
  });

  it('切换 tab 应同步 role=tab 和 role=tabpanel 属性', () => {
    createManager({ html: TABS_HTML });
    const tabs = document.querySelectorAll<HTMLElement>('.settings-tab');
    const contents = document.querySelectorAll<HTMLElement>('.settings-tab-content');

    tabs.forEach((tab) => {
      expect(tab.getAttribute('role')).toBe('tab');
    });
    contents.forEach((content) => {
      expect(content.getAttribute('role')).toBe('tabpanel');
    });
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

// ─── loadConfigToForm + collectConfigFromForm ───────────

describe('loadConfigToForm + collectConfigFromForm', () => {
  it('应加载精灵配置到表单 + 回收一致', () => {
    const { manager } = createManager();
    const config: SpriteConfigForm = {
      theme: 'light',
      archiveMode: 'full',
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
      shortcuts: {
        enabled: true,
        accelerators: {
          'toggle-window': 'Ctrl+Shift+Space',
          'quick-record': 'Ctrl+Shift+M',
          'recall-memory': 'Ctrl+Shift+R',
        },
      },
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
      archiveMode: 'full',
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
      shortcuts: {
        enabled: true,
        accelerators: {
          'toggle-window': 'Ctrl+Shift+Space',
          'quick-record': 'Ctrl+Shift+M',
          'recall-memory': 'Ctrl+Shift+R',
        },
      },
    });
    expect((document.getElementById('cfg-focus-project') as HTMLSelectElement).disabled).toBe(false);
  });
});

// ─── 回调注册 ────────────────────────────────────────────

describe('回调注册', () => {
  it('onConfigSave 应注册回调（表单输入触发自动保存）', async () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    const input = document.getElementById('cfg-threshold') as HTMLInputElement;
    input.value = '5';
    // 事件需要冒泡到父元素 #panel-settings
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 600));
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
  it('cleanup 后表单输入不应触发自动保存', async () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onConfigSave(cb);
    manager.cleanup();
    const input = document.getElementById('cfg-threshold') as HTMLInputElement;
    input.value = '5';
    // 事件需要冒泡到父元素 #panel-settings
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 600));
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

// ─── renderSkills（从 dashboardPanelManager 迁入） ──────

describe('renderSkills', () => {
  it('空技能列表应隐藏 section 并显示空状态', () => {
    const { manager } = createManager();
    manager.renderSkills([]);
    expect(document.getElementById('skills-section')!.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('skills-empty')!.classList.contains('hidden')).toBe(false);
  });

  it('应渲染技能列表项（名称 + 层级 + 关键词）', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 'code-review', keywords: ['review', 'lint'], description: '代码审查', layer: 'agent' },
    ]);
    const item = document.querySelector('#skills-list .skill-item') as HTMLElement;
    expect(item).not.toBeNull();
    expect(item.querySelector('.skill-name')!.textContent).toBe('code-review');
    expect(item.querySelector('.skill-layer')!.textContent).toBe('全局');
    expect(item.querySelector('.skill-keywords')!.textContent).toContain('review');
    // 有技能时 section 显示、空状态隐藏
    expect(document.getElementById('skills-section')!.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('skills-empty')!.classList.contains('hidden')).toBe(true);
  });

  it('项目层级应显示"项目"标签', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's', keywords: [], description: '', layer: 'project' },
    ]);
    expect(document.querySelector('.skill-layer')!.textContent).toBe('项目');
  });

  it('无关键词时不应渲染关键词标签', () => {
    const { manager } = createManager();
    manager.renderSkills([{ name: 's', keywords: [], description: '', layer: 'agent' }]);
    expect(document.querySelector('.skill-keywords')).toBeNull();
  });

  it('关键词超过 5 个应只展示前 5 个', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's', keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], description: '', layer: 'agent' },
    ]);
    const kw = document.querySelector('.skill-keywords')!.textContent!;
    expect(kw.split(' · ').length).toBe(5);
  });

  it('应使用 title 属性携带技能描述（悬停提示）', () => {
    const { manager } = createManager();
    manager.renderSkills([
      { name: 's', keywords: [], description: '详细描述', layer: 'agent' },
    ]);
    const item = document.querySelector('.skill-item') as HTMLElement;
    expect(item.title).toBe('详细描述');
  });
});
