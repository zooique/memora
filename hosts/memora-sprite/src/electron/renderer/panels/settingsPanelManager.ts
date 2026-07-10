/**
 * 设置面板管理器 — 设置面板 UI 逻辑独立子模块
 *
 * 职责：
 * - 管理设置面板所有 DOM 元素引用
 * - 初始化设置面板事件监听（tab 切换、表单变更、保存/取消、预设切换等）
 * - 加载/收集 LLM 配置和精灵配置表单数据
 * - 管理 API Key 显示/隐藏切换
 *
 * 设计原则：
 * - 遵循 ToastManager / ModalManager 的组合模式，UIManager 持有实例并委托
 * - 自管理事件监听器，提供 cleanup() 清理
 * - 跨模块关注点（setTheme / updatePersonaModeBadge / showConfirmDialog）通过 host 回调注入
 */

import { clearElement, getOptionalElement } from '../helpers/domHelpers.js';
import { setIcon } from '../helpers/icon.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { SafeTimerTracker } from '../helpers/safeTimer.js';
/** 从精灵零依赖常量模块导入，避免把 spriteConfig.ts 中的 Node.js 内置模块带入渲染进程 */
import { MS_PER_MINUTE, MS_PER_HOUR } from '../../../sprite/constants.js';
import type {
  SpriteConfigForm,
  ConfirmDialogOptions,
  ToastType,
} from '../types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 设置面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface SettingsPanelHost {
  /**
   * 设置主题（ADR-SP-008 主题切换）
   * 支持 'auto' 跟随系统主题
   */
  setTheme(theme: 'light' | 'dark' | 'auto'): void;
  /** 更新角色匹配模式标签 */
  updatePersonaModeBadge(mode: string): void;
  /** 显示确认对话框（取消按钮） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 显示 toast 通知（恢复默认按钮反馈） */
  showToast(message: string, type?: ToastType, duration?: number): void;
  /**
   * 切换到指定面板（"稍后配置"按钮使用）
   */
  switchPanel(panel: 'chat' | 'memories' | 'settings'): void;
  /**
   * 设置面板内 tab 切换回调（刷新对应 tab 的数据）
   *
   * 当用户切换到 profile / work / audit / skill tab 时触发，
   * 让宿主调用对应 PanelManager 的 load() 刷新数据。
   */
  onSettingsTabSwitch?(tab: string): void;
  /**
   * Provider 列表变更回调
   *
   * 当用户在设置面板中新增/编辑/删除/切换 Provider 后触发，
   * 让宿主通知 InputAreaManager 刷新输入框的 Provider 选择器，
   * 确保输入框显示的当前 Provider 与设置面板一致。
   */
  onProviderChanged?(): void;
}

// ─── 设置面板管理器类 ─────────────────────────────────────

export class SettingsPanelManager {
  // ─── 设置面板 DOM 元素 - Embedding 配置 ─────────────────
  private cfgEmbEnabled: HTMLInputElement | null;
  private cfgEmbModel: HTMLInputElement | null;
  private cfgEmbBaseUrl: HTMLInputElement | null;
  private cfgEmbApiKey: HTMLInputElement | null;

  // ─── 设置面板 DOM 元素 - 精灵配置 ───────────────────────
  private cfgSilent: HTMLInputElement | null;
  private cfgThreshold: HTMLInputElement | null;
  private cfgCooldown: HTMLInputElement | null;
  private cfgInterval: HTMLInputElement | null;
  private cfgWatcherEnabled: HTMLInputElement | null;
  private cfgWatcherPaths: HTMLInputElement | null;
  private cfgWatcherDebounce: HTMLInputElement | null;
  /** 缺口 II：文件监听忽略模式（glob 列表，逗号分隔输入） */
  private cfgWatcherIgnore: HTMLInputElement | null;
  private cfgDefaultPersona: HTMLInputElement | null;
  /** 项目模式：专注项目选择下拉框 */
  private cfgFocusProject: HTMLSelectElement | null;

  // ─── 设置面板 DOM 元素 - 快捷键配置（Phase 3.3） ─────────
  /** 快捷键总开关 */
  private cfgShortcutsEnabled: HTMLInputElement | null;
  /** 显示/隐藏窗口快捷键（捕获式输入） */
  private cfgShortcutToggleWindow: HTMLInputElement | null;
  /** 快速记录快捷键（捕获式输入） */
  private cfgShortcutQuickRecord: HTMLInputElement | null;
  /** 召回记忆快捷键（捕获式输入） */
  private cfgShortcutRecallMemory: HTMLInputElement | null;

  // ─── 设置面板 DOM 元素 - 多 Provider 管理 ─────────────
  private providerListEl: HTMLElement | null;
  private providerModalEl: HTMLElement | null;
  private providerModalTitleEl: HTMLElement | null;
  private providerAliasInput: HTMLInputElement | null;
  private providerDisplayInput: HTMLInputElement | null;
  private providerProviderInput: HTMLInputElement | null;
  private providerModelInput: HTMLInputElement | null;
  private providerBaseUrlInput: HTMLInputElement | null;
  private providerApiKeyInput: HTMLInputElement | null;
  private providerTemperatureInput: HTMLInputElement | null;
  private btnAddProvider: HTMLButtonElement | null;
  // 后台归档 Provider 选择框
  private backgroundProviderSelect: HTMLSelectElement | null;
  // 缓存 Provider 列表数据（编辑时用于填充表单字段，避免 DOM 解析丢失 temperature/apiKey）
  private cachedProviders: Array<{ key: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; temperature: number }> = [];
  private btnProviderSave: HTMLButtonElement | null;
  private btnProviderCancel: HTMLButtonElement | null;
  private btnProviderTest: HTMLButtonElement | null;

  // ─── 缓存 DOM 元素 - radio 按钮组（loadConfigToForm / collectConfigFromForm 中重复查询） ─
  /** 项目模式单选按钮组（NodeList 静态快照，构造时获取一次） */
  private projectModeRadios: NodeListOf<HTMLInputElement>;
  /** 角色匹配模式单选按钮组 */
  private personaModeRadios: NodeListOf<HTMLInputElement>;
  /** 主题模式单选按钮组 */
  private themeModeRadios: NodeListOf<HTMLInputElement>;
  /** 归档模式单选按钮组 */
  private archiveModeRadios: NodeListOf<HTMLInputElement>;

  // ─── 缓存 DOM 元素 - 重复查询的独立元素 ─
  /** Agent 状态指示器元素（updateAgentStatusIndicator 中查询） */
  private agentStatusEl: HTMLElement | null;
  /** 保存状态指示器元素（显示"保存中..."、"已保存"等状态） */
  private saveStatusEl: HTMLElement | null;
  /** 技能 - 列表容器（设置面板 skill tab，由 renderSkills 填充） */
  private skillsListEl: HTMLElement | null;
  /** 技能 - 区域容器（无技能时隐藏，有技能时显示） */
  private skillsSectionEl: HTMLElement | null;
  /** 技能 - 空状态占位元素（无技能时显示"拖入 .md 文件安装"提示） */
  private skillsEmptyEl: HTMLElement | null;

  // ─── 状态 ────────────────────────────────────────────────
  /** 设置表单是否有未保存修改（dirty 标志） */
  private settingsFormDirty = false;
  /** 当前角色匹配模式（由 UIManager 同步） */
  private currentPersonaMode = 'auto';
  /** 定时器跟踪器（用于防抖自动保存） */
  private timers = new SafeTimerTracker();
  /** 是否正在自动保存中 */
  private isAutoSaving = false;
  /** 是否正在程序化设置表单值（用于避免 loadConfigToForm 触发 dirty 标志） */
  private isLoadingConfig = false;

  // ─── 回调 ────────────────────────────────────────────────
  private configSaveCallback: ((config: SpriteConfigForm) => void) | null = null;
  /** 角色匹配模式变更回调 */
  private personaModeChangeCallback: ((mode: string) => void) | null = null;
  /** ADR-015 归档模式变更回调（radio change 时即时触发，与主题一样即时生效） */
  private archiveModeChangeCallback: ((mode: 'full' | 'insights-only' | 'manual') => void) | null = null;

  // ─── 事件清理 ────────────────────────────────────────────
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 防抖后的自动保存函数 */
  private debouncedAutoSave: (() => void) | null = null;

  constructor(private host: SettingsPanelHost) {
    // 设置面板 - Embedding 配置
    this.cfgEmbEnabled = getOptionalElement('cfg-emb-enabled', 'input');
    this.cfgEmbModel = getOptionalElement('cfg-emb-model', 'input');
    this.cfgEmbBaseUrl = getOptionalElement('cfg-emb-base-url', 'input');
    this.cfgEmbApiKey = getOptionalElement('cfg-emb-api-key', 'input');

    // 设置面板 - 精灵配置
    this.cfgSilent = getOptionalElement('cfg-silent', 'input');
    this.cfgThreshold = getOptionalElement('cfg-threshold', 'input');
    this.cfgCooldown = getOptionalElement('cfg-cooldown', 'input');
    this.cfgInterval = getOptionalElement('cfg-interval', 'input');
    this.cfgWatcherEnabled = getOptionalElement('cfg-watcher-enabled', 'input');
    this.cfgWatcherPaths = getOptionalElement('cfg-watcher-paths', 'input');
    this.cfgWatcherDebounce = getOptionalElement('cfg-watcher-debounce', 'input');
    // 缺口 II：文件监听忽略模式输入框
    this.cfgWatcherIgnore = getOptionalElement('cfg-watcher-ignore', 'input');
    this.cfgDefaultPersona = getOptionalElement('cfg-default-persona', 'input');
    this.cfgFocusProject = getOptionalElement('cfg-focus-project', 'select');

    // 设置面板 - 快捷键配置（Phase 3.3）
    this.cfgShortcutsEnabled = getOptionalElement('cfg-shortcuts-enabled', 'input');
    this.cfgShortcutToggleWindow = getOptionalElement('cfg-shortcut-toggle-window', 'input');
    this.cfgShortcutQuickRecord = getOptionalElement('cfg-shortcut-quick-record', 'input');
    this.cfgShortcutRecallMemory = getOptionalElement('cfg-shortcut-recall-memory', 'input');

    // 缓存 radio 按钮组（loadConfigToForm / collectConfigFromForm / initListeners 中重复查询）
    this.projectModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="project-mode"]');
    this.personaModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="persona-mode"]');
    this.themeModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    this.archiveModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="archive-mode"]');

    // 缓存重复查询的独立元素
    this.agentStatusEl = document.getElementById('agent-status-indicator');
    /** 保存状态指示器元素 */
    this.saveStatusEl = document.getElementById('save-status-indicator');
    // 技能管理 tab 的 DOM 元素（renderSkills 填充，从 dashboardPanelManager 迁入）
    this.skillsListEl = document.getElementById('skills-list');
    this.skillsSectionEl = document.getElementById('skills-section');
    this.skillsEmptyEl = document.getElementById('skills-empty');

    // 多 Provider 管理元素
    this.providerListEl = document.getElementById('provider-list');
    this.providerModalEl = document.getElementById('provider-modal');
    this.providerModalTitleEl = document.getElementById('provider-modal-title');
    this.providerAliasInput = getOptionalElement('cfg-provider-alias', 'input');
    this.providerDisplayInput = getOptionalElement('cfg-provider-display', 'input');
    this.providerProviderInput = getOptionalElement('cfg-provider-provider', 'input');
    this.providerModelInput = getOptionalElement('cfg-provider-model', 'input');
    this.providerBaseUrlInput = getOptionalElement('cfg-provider-base-url', 'input');
    this.providerApiKeyInput = getOptionalElement('cfg-provider-api-key', 'input');
    this.providerTemperatureInput = getOptionalElement('cfg-provider-temperature', 'input');
    this.btnAddProvider = getOptionalElement('btn-add-provider', 'button');
    this.backgroundProviderSelect = getOptionalElement('cfg-background-provider', 'select');
    this.btnProviderSave = getOptionalElement('btn-provider-save', 'button');
    this.btnProviderCancel = getOptionalElement('btn-provider-cancel', 'button');
    this.btnProviderTest = getOptionalElement('btn-provider-test', 'button');

    // 构造完成后统一校验所有字段，HTML ID 拼错时一次性 console.error 报告
    // 避免静默降级导致用户配置静默失效（保存时表单值为 undefined，主进程收到空配置）
    this.validateSettingsElements();
  }

  /**
   * 校验设置面板所有可选元素是否成功获取
   *
   * 收集所有 null 字段，统一 console.error 报告（包含字段名和期望 ID），
   * 让开发者快速定位 HTML 与 TS 不同步问题。
   *
   * 不抛异常（设置面板是非核心功能，缺失时降级而非阻断整个 UI），
   * 但通过显式错误日志让问题在开发阶段被发现，避免生产环境静默失效。
   */
  private validateSettingsElements(): void {
    // 字段映射：[字段名, 元素引用, 期望 ID]
    const fields: Array<[string, HTMLElement | null, string]> = [
      ['cfgEmbEnabled', this.cfgEmbEnabled, 'cfg-emb-enabled'],
      ['cfgEmbModel', this.cfgEmbModel, 'cfg-emb-model'],
      ['cfgEmbBaseUrl', this.cfgEmbBaseUrl, 'cfg-emb-base-url'],
      ['cfgEmbApiKey', this.cfgEmbApiKey, 'cfg-emb-api-key'],
      ['cfgSilent', this.cfgSilent, 'cfg-silent'],
      ['cfgThreshold', this.cfgThreshold, 'cfg-threshold'],
      ['cfgCooldown', this.cfgCooldown, 'cfg-cooldown'],
      ['cfgInterval', this.cfgInterval, 'cfg-interval'],
      ['cfgWatcherEnabled', this.cfgWatcherEnabled, 'cfg-watcher-enabled'],
      ['cfgWatcherPaths', this.cfgWatcherPaths, 'cfg-watcher-paths'],
      ['cfgWatcherDebounce', this.cfgWatcherDebounce, 'cfg-watcher-debounce'],
      ['cfgWatcherIgnore', this.cfgWatcherIgnore, 'cfg-watcher-ignore'],
      ['cfgDefaultPersona', this.cfgDefaultPersona, 'cfg-default-persona'],
      ['cfgFocusProject', this.cfgFocusProject, 'cfg-focus-project'],
      ['cfgShortcutsEnabled', this.cfgShortcutsEnabled, 'cfg-shortcuts-enabled'],
      ['cfgShortcutToggleWindow', this.cfgShortcutToggleWindow, 'cfg-shortcut-toggle-window'],
      ['cfgShortcutQuickRecord', this.cfgShortcutQuickRecord, 'cfg-shortcut-quick-record'],
      ['cfgShortcutRecallMemory', this.cfgShortcutRecallMemory, 'cfg-shortcut-recall-memory'],
    ];
    // 收集缺失字段
    const missing = fields.filter(([, el]) => el === null).map(([name, , id]) => `${name} (#${id})`);
    if (missing.length > 0) {
      // 一次性报告所有缺失字段，便于开发者一次性定位
      console.error(
        `[SettingsPanelManager] ${missing.length} 个设置面板字段未找到，相关配置将静默失效：\n  - ${missing.join('\n  - ')}\n请检查 index.html 中对应的 ID 是否拼写正确或被移除。`,
      );
    }
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 清理所有事件监听器 */
  cleanup(): void {
    // 清理所有事件监听器（通过 EventTracker 统一管理）
    this.events.cleanup();
    // 清理所有定时器（包括防抖自动保存）
    this.timers.cleanup();
  }

  // ─── 初始化 ─────────────────────────────────────────────

  /**
   * 初始化设置面板所有事件监听器
   *
   * 包含：tab 切换、API Key 切换、表单 dirty 追踪、
   * 保存/取消按钮、预设切换、LLM 测试、项目模式、角色模式、主题切换。
   */
  initListeners(): void {
    // UI-UX-01 设置面板 tab 切换
    this.initSettingsTabListeners();

    const btnReset = getOptionalElement('btn-settings-reset', 'button');

    // "稍后配置"按钮：首次配置时提供退出路径
    const btnSkip = getOptionalElement('btn-settings-skip', 'button');
    if (btnSkip) {
      this.events.addEventListener(btnSkip, 'click', () => {
        // 跳过配置，回到对话面板（用户可随时通过侧边栏回到设置）
        this.settingsFormDirty = false; // 不保存，清除 dirty 标记
        this.host.switchPanel('chat');
      });
    }

    // API Key 显示/隐藏切换：Provider 表单 + Embedding
    this.initApiKeyToggle('btn-toggle-provider-key', 'cfg-provider-api-key');
    this.initApiKeyToggle('btn-toggle-emb-key', 'cfg-emb-api-key');

    // 创建防抖自动保存函数（500ms 延迟，避免频繁 IPC 调用）
    // 使用 debounceWithGuard 避免竞态条件：当 isAutoSaving 为 true 时跳过定时器创建，
    // 由 autoSaveConfig 的 finally 块检查 settingsFormDirty 并触发后续保存
    this.debouncedAutoSave = this.timers.debounceWithGuard(() => {
      this.autoSaveConfig();
    }, 500, () => !this.isAutoSaving);

    // 监听设置面板所有表单元素的变更，触发自动保存
    const settingsPanel = document.getElementById('panel-settings');
    if (settingsPanel) {
      this.events.addEventListener(settingsPanel, 'input', () => {
        if (this.isLoadingConfig) return;
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      });
      this.events.addEventListener(settingsPanel, 'change', () => {
        if (this.isLoadingConfig) return;
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      });
    }

    // 恢复默认按钮：将精灵配置重置为默认值（不影响 LLM 配置）
    if (btnReset) {
      this.events.addEventListener(btnReset, 'click', () => {
        void (async () => {
          const confirmed = await this.host.showConfirmDialog({
            title: '恢复默认设置',
            message: '将精灵配置恢复为默认值（LLM 配置不受影响），确定继续吗？',
            confirmText: '恢复默认',
            danger: true,
          });
          if (!confirmed) return;
          // 加载默认配置到表单（不立即保存，用户需点击保存按钮持久化）
          this.loadConfigToForm({
            theme: 'light',
            silentMode: false,
            proactiveThreshold: 3,
            proactiveCooldownMs: 300_000,
            triggerIntervalMs: MS_PER_HOUR,
            fileWatcherEnabled: false,
            fileWatcherPaths: ['.'],
            fileWatcherDebounceMs: 1000,
            defaultPersona: '',
            projectMode: 'smart',
            focusProjectPath: '',
            // ADR-015 归档模式默认 full
            archiveMode: 'full',
            // Phase 3.3 快捷键默认值（与 DEFAULT_SPRITE_CONFIG.shortcuts 一致）
            shortcuts: {
              enabled: true,
              accelerators: {
                'toggle-window': 'Ctrl+Shift+Space',
                'quick-record': 'Ctrl+Shift+M',
                'recall-memory': 'Ctrl+Shift+R',
              },
            },
          });
          this.settingsFormDirty = true;
          this.host.showToast('已恢复默认设置，将自动保存', 'info');
        })();
      });
    }

    // 项目模式单选按钮：切换时启用/禁用专注项目下拉框
    this.projectModeRadios.forEach((radio) => {
      this.events.addEventListener(radio, 'change', () => {
        if (this.cfgFocusProject) {
          this.cfgFocusProject.disabled = radio.value !== 'focus';
        }
      });
    });

    // 角色匹配模式单选按钮：切换时实时更新标签 + 触发回调持久化
    this.personaModeRadios.forEach((radio) => {
      this.events.addEventListener(radio, 'change', () => {
        const selectedMode = radio.value;
        this.currentPersonaMode = selectedMode;
        this.host.updatePersonaModeBadge(selectedMode);
        this.personaModeChangeCallback?.(selectedMode);
      });
    });

    // ADR-SP-008 主题切换单选按钮：切换时立即应用主题（无需等待保存按钮）
    this.themeModeRadios.forEach((radio) => {
      this.events.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          // 支持 'auto' 跟随系统主题
          const value = radio.value;
          if (value === 'light' || value === 'dark' || value === 'auto') {
            this.host.setTheme(value);
          }
        }
      });
    });

    // ADR-015 归档模式切换：切换时即时应用（与主题一样即时生效，无需等保存按钮）
    this.archiveModeRadios.forEach((radio) => {
      this.events.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          const value = radio.value;
          if (value === 'full' || value === 'insights-only' || value === 'manual') {
            this.archiveModeChangeCallback?.(value);
          }
        }
      });
    });

    // Phase 3.3：初始化快捷键捕获式输入（三个动作 + 冲突检测）
    this.initShortcutCapture();

    // 多 Provider 管理：事件监听器 + 初始加载列表
    this.initProviderListeners();
    this.loadProviderList();
  }

  // ─── 私有辅助方法 ───────────────────────────────────────

  /**
   * UI-UX-01 初始化设置面板 tab 切换
   *
   * 点击 tab 按钮时切换对应的内容区显示，
   * 保持 tab 按钮的 active 状态同步。
   * 切换到 profile / work / audit / skill tab 时触发宿主回调刷新数据。
   */
  private initSettingsTabListeners(): void {
    const tabButtons = document.querySelectorAll<HTMLElement>('.settings-tab');
    const tabContents = document.querySelectorAll<HTMLElement>('.settings-tab-content');

    // 补全 ARIA tab 语义（button 已具备原生语义，叠加 role="tab" + aria-selected）
    // 让屏幕阅读器在 tablist 上下文中正确朗读"已选/未选"状态
    tabButtons.forEach((btn) => {
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
    });
    tabContents.forEach((content) => {
      content.setAttribute('role', 'tabpanel');
    });

    tabButtons.forEach((btn) => {
      this.events.addEventListener(btn, 'click', () => {
        const targetTab = btn.dataset.settingsTab;
        if (!targetTab) return;

        // 切换 tab 按钮 active 状态 + 同步 aria-selected
        tabButtons.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        // 切换内容区显示
        tabContents.forEach((content) => {
          if (content.dataset.settingsTab === targetTab) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        });

        // 触发宿主回调：刷新对应 tab 的数据
        this.host.onSettingsTabSwitch?.(targetTab);
      });
    });
  }

  // ─── Phase 3.3 快捷键捕获式输入 ─────────────────────────

  /**
   * 初始化快捷键捕获式输入
   *
   * 为三个快捷键输入框注册 focus/blur/keydown 监听器：
   * - focus：进入捕获状态，显示"按下组合键..."提示
   * - keydown：解析组合键为 Electron accelerator 格式，Esc 取消，Backspace 清除
   * - blur：退出捕获状态，恢复默认提示
   *
   * 冲突检测：捕获成功后检查与其他动作的快捷键是否重复，重复时提示警告并不填入。
   */
  private initShortcutCapture(): void {
    const inputs: Array<{ input: HTMLInputElement | null; action: string }> = [
      { input: this.cfgShortcutToggleWindow, action: 'toggle-window' },
      { input: this.cfgShortcutQuickRecord, action: 'quick-record' },
      { input: this.cfgShortcutRecallMemory, action: 'recall-memory' },
    ];

    for (const { input } of inputs) {
      if (!input) continue;

      /** 捕获状态标志（focus 时置 true，blur/cancel/capture 时置 false） */
      let capturing = false;
      /** 进入捕获前的原值（Esc 取消时恢复） */
      let originalValue = '';

      this.events.addEventListener(input, 'focus', () => {
        capturing = true;
        originalValue = input.value;
        input.classList.add('capturing');
        input.placeholder = '按下组合键…（Esc 取消，Backspace 清除）';
      });

      this.events.addEventListener(input, 'blur', () => {
        if (capturing) {
          capturing = false;
          input.classList.remove('capturing');
          input.placeholder = '点击捕获组合键';
        }
      });

      this.events.addEventListener(input, 'keydown', (e: Event) => {
        // EventListener 签名要求 (e: Event)，keydown 事件实际为 KeyboardEvent，窄化转换
        const ke = e as KeyboardEvent;
        if (!capturing) return;
        // 阻止默认行为（如 Tab 切换焦点、空格滚动页面）
        ke.preventDefault();
        ke.stopPropagation();

        const result = this.keyEventToAccelerator(ke);
        // null 表示不支持的键，继续等待用户按下有效组合键
        if (result === null) return;

        // Esc 取消：恢复原值并退出捕获
        if (result === '__cancel__') {
          input.value = originalValue;
          input.blur();
          return;
        }

        // Backspace（无修饰键）清除快捷键
        if (result === '__clear__') {
          input.value = '';
          input.blur();
          this.settingsFormDirty = true;
          this.debouncedAutoSave?.();
          return;
        }

        // 冲突检测：检查与其他动作的快捷键是否重复
        if (this.isShortcutConflict(result, input)) {
          this.host.showToast(`快捷键 ${result} 与其他动作冲突，请使用其他组合`, 'warning');
          return; // 不填入，继续等待
        }

        // 捕获成功：填入并退出捕获状态
        input.value = result;
        input.blur();
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      });
    }
  }

  /**
   * 将 KeyboardEvent 解析为 Electron accelerator 格式字符串
   *
   * Electron accelerator 格式：修饰键 + 主键，如 "Ctrl+Shift+Space"。
   * 修饰键顺序：Ctrl → Cmd → Alt → Shift（与 Electron 文档一致）。
   *
   * 特殊返回值：
   * - '__cancel__'：Esc 键，表示取消捕获
   * - '__clear__'：Backspace（无修饰键），表示清除快捷键
   * - null：不支持的键（如单独的修饰键、无法识别的键），继续等待
   *
   * @param e 键盘事件
   * @returns accelerator 字符串、特殊标记或 null
   */
  private keyEventToAccelerator(e: KeyboardEvent): string | '__cancel__' | '__clear__' | null {
    // Esc 取消捕获
    if (e.key === 'Escape') return '__cancel__';

    // Backspace（无修饰键）清除快捷键
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      return '__clear__';
    }

    // 收集修饰键（顺序：Ctrl → Cmd → Alt → Shift）
    /** 修饰键列表（按 Electron accelerator 规范顺序） */
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Cmd');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    // 单独的修饰键不构成有效快捷键，继续等待
    if (parts.length === 0) return null;

    // 主键映射表（e.key → Electron accelerator 键名）
    const keyMap: Record<string, string> = {
      ' ': 'Space',
      ArrowUp: 'Up',
      ArrowDown: 'Down',
      ArrowLeft: 'Left',
      ArrowRight: 'Right',
      Enter: 'Return',
      Tab: 'Tab',
      Home: 'Home',
      End: 'End',
      PageUp: 'PageUp',
      PageDown: 'PageDown',
      Insert: 'Insert',
      Delete: 'Delete',
    };

    /** 主键名（Electron accelerator 格式） */
    let key = keyMap[e.key];
    if (!key) {
      // 字母键转大写（accelerator 规范：A-Z）
      if (/^[a-z]$/i.test(e.key)) {
        key = e.key.toUpperCase();
      } else if (/^F\d{1,2}$/i.test(e.key)) {
        // 功能键 F1-F24 转大写
        key = e.key.toUpperCase();
      } else if (/^\d$/.test(e.key)) {
        // 数字键 0-9
        key = e.key;
      } else {
        // 不支持的键，继续等待
        return null;
      }
    }

    parts.push(key);
    return parts.join('+');
  }

  /**
   * 检查快捷键是否与其他动作冲突
   *
   * 遍历三个快捷键输入框（排除当前输入框），检查是否有相同的 accelerator。
   * 空字符串不视为冲突（允许未设置的快捷键）。
   *
   * @param accelerator 待检查的 accelerator 字符串
   * @param excludeInput 当前输入框（排除自身）
   * @returns true 表示与其他动作冲突
   */
  private isShortcutConflict(accelerator: string, excludeInput: HTMLInputElement): boolean {
    const inputs = [
      this.cfgShortcutToggleWindow,
      this.cfgShortcutQuickRecord,
      this.cfgShortcutRecallMemory,
    ];
    return inputs.some(
      (inp) => inp !== null && inp !== excludeInput && inp.value === accelerator,
    );
  }

  /**
   * 初始化 API Key 显示/隐藏切换
   *
   * 点击眼睛图标在 password 和 text 之间切换输入框类型，
   * 方便用户确认输入的 Key 是否正确。
   *
   * @param toggleBtnId 切换按钮 ID
   * @param inputId 输入框 ID
   */
  private initApiKeyToggle(toggleBtnId: string, inputId: string): void {
    const btn = document.getElementById(toggleBtnId);
    const input = document.getElementById(inputId);
    if (!(btn instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) return;

    // 使用 SVG 图标替代 emoji，颜色状态由 data-visible 属性 + CSS 控制
    const renderIcon = (visible: boolean) => {
      btn.dataset.visible = visible ? 'true' : 'false';
      setIcon(btn, 'icon-eye', 'icon-sm');
    };
    renderIcon(false);

    this.events.addEventListener(btn, 'click', () => {
      if (input.type === 'password') {
        input.type = 'text';
        renderIcon(true);
        btn.title = '隐藏 API Key';
      } else {
        input.type = 'password';
        renderIcon(false);
        btn.title = '显示 API Key';
      }
    });
  }

  // ─── 公共 API ───────────────────────────────────────────

  /**
   * 重置 dirty 标志
   *
   * 在 loadConfigToForm / loadLlmConfigToForm 后由 renderer.ts 调用，
   * 因为程序化设置表单值会触发 input/change 事件，需要重置 dirty 标志
   * 以避免"取消"按钮误判为有修改。
   */
  resetFormDirty(): void {
    this.settingsFormDirty = false;
  }

  /**
   * 检查设置面板是否有未保存修改
   *
   * 供 UIManager.switchPanel() 在面板切换前调用，
   * 避免用户修改设置后点击导航离开导致修改丢失。
   */
  isDirty(): boolean {
    return this.settingsFormDirty;
  }

  /**
   * 更新 Agent 连接状态指示器
   *
   * 在设置面板顶部显示 Agent 当前连接状态，帮助用户快速识别配置是否生效。
   * 三种状态：
   * - ready（绿色）：Agent 已就绪，可正常对话
   * - error（红色）：Agent 未就绪，通常因 LLM 配置缺失或初始化失败
   * - unknown（灰色）：检测中，通常出现在应用启动初期
   *
   * @param status Agent 连接状态
   * @param message 可选的状态描述文本（未提供时使用默认文案）
   */
  updateAgentStatusIndicator(status: 'ready' | 'error' | 'unknown', message?: string): void {
    const indicator = this.agentStatusEl;
    if (!indicator) return;

    // 更新状态类名（移除旧状态类，添加新状态类）
    indicator.classList.remove('ready', 'error', 'unknown');
    indicator.classList.add(status);

    // 更新状态文本
    const textEl = indicator.querySelector('.agent-status-text');
    if (textEl) {
      const defaultText = status === 'ready' ? 'Agent 已就绪' : status === 'error' ? 'Agent 未就绪' : '检测中...';
      textEl.textContent = message ?? defaultText;
    }
  }

  /**
   * 加载 Embedding 配置到表单
   *
   * 从主进程返回的 LLM 配置数据中提取 Embedding 部分，填充到 Embedding 表单字段。
   * Provider 配置由 loadProviderList 独立管理，此方法仅处理 Embedding。
   */
  loadEmbeddingConfig(data: {
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
  }): void {
    if (data.embedding) {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = true;
      if (this.cfgEmbModel) this.cfgEmbModel.value = data.embedding.model;
      if (this.cfgEmbBaseUrl) this.cfgEmbBaseUrl.value = data.embedding.baseUrl;
      if (this.cfgEmbApiKey) this.cfgEmbApiKey.value = data.embedding.apiKey;
    } else {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = false;
    }
  }

  // ─── 多 Provider 管理 ────────────────────────────────────

  /**
   * 加载 Provider 列表并渲染
   *
   * 从主进程获取所有 Provider 配置，渲染为卡片列表。
   * 设置面板初次显示时调用。
   */
  async loadProviderList(): Promise<void> {
    if (!this.providerListEl) return;
    try {
      const data = await window.electronAPI.listLlmProviders();
      this.cachedProviders = data.providers; // 缓存供编辑时使用
      this.renderProviderList(data.active, data.providers);
      this.renderBackgroundProviderSelect(data.providers);
      // 通知宿主 Provider 列表已变更，让 InputAreaManager 刷新输入框选择器
      this.host.onProviderChanged?.();
    } catch (error) {
      // 加载失败时清空列表并提示用户（避免用户误以为"没有 Provider"）
      clearElement(this.providerListEl);
      console.error('[SettingsPanelManager] 加载 Provider 列表失败:', error);
      this.host.showToast('加载 Provider 列表失败，请稍后重试', 'error');
    }
  }

  /**
   * 渲染后台归档 Provider 选择框
   *
   * 使用 createElement + textContent 构建 option，避免 innerHTML 拼接用户输入
   * （provider name/model 来自用户表单输入，存在 XSS 风险）。
   */
  private renderBackgroundProviderSelect(providers: Array<{ key: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; temperature: number }>): void {
    if (!this.backgroundProviderSelect) return;

    // 保存当前选中值，重建后恢复（避免列表刷新丢失用户选择）
    const currentValue = this.backgroundProviderSelect.value;

    clearElement(this.backgroundProviderSelect);

    // 默认选项：与实时对话相同
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '与实时对话相同';
    this.backgroundProviderSelect.appendChild(defaultOption);

    // Provider 选项（textContent 自动转义，无 XSS 风险）
    for (const p of providers) {
      const opt = document.createElement('option');
      opt.value = p.key;
      opt.textContent = `${p.name} (${p.provider} · ${p.model})`;
      this.backgroundProviderSelect.appendChild(opt);
    }

    // 恢复用户之前的选择（若新列表中仍存在该 key）
    if (providers.some((p) => p.key === currentValue)) {
      this.backgroundProviderSelect.value = currentValue;
    }
  }

  /**
   * 渲染 Provider 卡片列表
   *
   * 使用 createElement + textContent 构建卡片，避免 innerHTML 拼接用户输入
   * （provider name/provider/model/key 来自用户表单输入，存在 XSS 风险）。
   * 事件委托在 initProviderListeners 中一次性绑定，此方法仅负责渲染 DOM。
   */
  private renderProviderList(active: string, providers: Array<{ key: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; temperature: number }>): void {
    if (!this.providerListEl) return;

    // 清空旧列表
    clearElement(this.providerListEl);

    // 空状态提示
    if (providers.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'settings-hint';
      hint.textContent = '暂未配置任何 API，点击下方按钮添加。';
      this.providerListEl.appendChild(hint);
      return;
    }

    // 使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const fragment = document.createDocumentFragment();

    for (const p of providers) {
      const isActive = p.key === active;

      const card = document.createElement('div');
      card.className = `provider-card${isActive ? ' active' : ''}`;
      card.dataset.providerKey = p.key;

      // ─── Provider 信息区（名称 + 详情） ──────────────
      const info = document.createElement('div');
      info.className = 'provider-info';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'provider-name';
      nameSpan.textContent = p.name;
      info.appendChild(nameSpan);

      const detailSpan = document.createElement('span');
      detailSpan.className = 'provider-detail';
      detailSpan.textContent = `${p.provider} · ${p.model}`;
      info.appendChild(detailSpan);

      card.appendChild(info);

      // ─── 激活徽章（仅当前 Provider 显示） ────────────
      if (isActive) {
        const badge = document.createElement('span');
        badge.className = 'provider-active-badge';
        badge.textContent = '当前';
        card.appendChild(badge);
      }

      // ─── 操作按钮区 ──────────────────────────────────
      const actions = document.createElement('div');
      actions.className = 'provider-actions';

      // 非激活 Provider 显示"设为当前"按钮
      if (!isActive) {
        const activateBtn = document.createElement('button');
        activateBtn.className = 'provider-btn';
        activateBtn.dataset.action = 'activate';
        activateBtn.dataset.key = p.key;
        activateBtn.textContent = '设为当前';
        actions.appendChild(activateBtn);
      }

      // 编辑按钮（所有 Provider 都有）
      const editBtn = document.createElement('button');
      editBtn.className = 'provider-btn';
      editBtn.dataset.action = 'edit';
      editBtn.dataset.key = p.key;
      editBtn.textContent = '编辑';
      actions.appendChild(editBtn);

      // 删除按钮（非激活 Provider 才显示，激活 Provider 不允许删除）
      if (!isActive) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'provider-btn provider-btn-delete';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.dataset.key = p.key;
        deleteBtn.textContent = '删除';
        actions.appendChild(deleteBtn);
      }

      card.appendChild(actions);
      fragment.appendChild(card);
    }

    this.providerListEl.appendChild(fragment);
  }

  /**
   * 显示 Provider 编辑弹窗
   */
  private showProviderForm(key: string = ''): void {
    if (!this.providerModalEl) return;

    if (key) {
      // 编辑模式：从缓存中查找 Provider 数据（含 temperature 和脱敏 apiKey）
      const cached = this.cachedProviders.find((p) => p.key === key);
      if (this.providerModalTitleEl) this.providerModalTitleEl.textContent = '编辑 API';

      if (this.providerAliasInput) {
        this.providerAliasInput.value = key;
        this.providerAliasInput.disabled = true;
      }
      if (this.providerDisplayInput) this.providerDisplayInput.value = cached?.name ?? key;
      if (this.providerProviderInput) this.providerProviderInput.value = cached?.provider ?? '';
      if (this.providerModelInput) this.providerModelInput.value = cached?.model ?? '';
      if (this.providerBaseUrlInput) this.providerBaseUrlInput.value = cached?.baseUrl ?? '';
      // 编辑时显示脱敏后的 API Key（前4后4），而非清空
      if (this.providerApiKeyInput) this.providerApiKeyInput.value = cached?.apiKey ?? '';
      if (this.providerTemperatureInput) this.providerTemperatureInput.value = String(cached?.temperature ?? 0.7);
    } else {
      // 新增模式：清空所有字段
      if (this.providerModalTitleEl) this.providerModalTitleEl.textContent = '添加 API';
      if (this.providerAliasInput) { this.providerAliasInput.value = ''; this.providerAliasInput.disabled = false; }
      if (this.providerDisplayInput) this.providerDisplayInput.value = '';
      if (this.providerProviderInput) this.providerProviderInput.value = '';
      if (this.providerModelInput) this.providerModelInput.value = '';
      if (this.providerBaseUrlInput) this.providerBaseUrlInput.value = '';
      if (this.providerApiKeyInput) this.providerApiKeyInput.value = '';
      if (this.providerTemperatureInput) this.providerTemperatureInput.value = '';
    }

    this.providerModalEl.classList.remove('hidden');
    this.providerModalEl.dataset.editKey = key;
  }

  /**
   * 隐藏 Provider 编辑弹窗
   */
  private hideProviderForm(): void {
    if (!this.providerModalEl) return;
    this.providerModalEl.classList.add('hidden');
    this.providerModalEl.dataset.editKey = '';
  }

  /**
   * 保存 Provider（新增/更新）
   *
   * 校验：必填字段 + 别名格式（仅允许字母数字.-_） + 重复 key 检测
   */
  private async saveProvider(): Promise<void> {
    const alias = this.providerAliasInput?.value.trim();
    const provider = this.providerProviderInput?.value.trim();
    const model = this.providerModelInput?.value.trim();
    const baseUrl = this.providerBaseUrlInput?.value.trim() || '';
    const apiKey = this.providerApiKeyInput?.value.trim();
    // 读取 temperature：空值表示使用默认值，不传 temperature 字段
    const tempRaw = this.providerTemperatureInput?.value.trim();
    const temperature = tempRaw ? parseFloat(tempRaw) : undefined;

    // 必填字段校验
    if (!alias || !provider || !model || !apiKey) {
      this.host.showToast('请填写所有必填字段（别名、提供商、模型、API Key）', 'error');
      return;
    }

    // 别名格式校验：仅允许 ASCII 字母数字 . - _，长度 ≤ 50
    // Provider 别名作为持久化 key（文件名/IPC 标识），限制 ASCII 避免 path traversal
    if (!/^[a-zA-Z0-9._-]{1,50}$/.test(alias)) {
      this.host.showToast('别名仅支持英文、数字、点、短横线、下划线，最长50字符', 'error');
      return;
    }

    // Temperature 范围校验：0-2（与 HTML input min/max 一致，防止绕过 HTML 校验）
    if (temperature !== undefined && (Number.isNaN(temperature) || temperature < 0 || temperature > 2)) {
      this.host.showToast('Temperature 必须在 0-2 之间', 'error');
      return;
    }

    // 重复 key 检测：新增时检查别名是否已存在
    const isEditing = (this.providerModalEl?.dataset.editKey ?? '') !== '';
    if (!isEditing) {
      try {
        const data = await window.electronAPI.listLlmProviders();
        if (data.providers.some((p) => p.key === alias)) {
          this.host.showToast(`别名 "${alias}" 已存在，请更换`, 'error');
          return;
        }
      } catch (error) {
        // 获取列表失败不阻塞保存，由主进程处理重复，但记录日志便于排查
        console.error('[SettingsPanelManager] 保存前检查重复别名失败:', error);
      }
    }

    // 必填字段校验后 alias 已确保非空，此处类型收窄
    const result = await window.electronAPI.saveLlmProvider(alias as string, { provider, model, baseUrl, apiKey, temperature });
    if (result.success) {
      this.host.showToast('Provider 保存成功');
      this.hideProviderForm();
      await this.loadProviderList();
    } else {
      this.host.showToast(result.error ?? '保存失败', 'error');
    }
  }

  /**
   * 测试 Provider 连接——从表单读取配置，调用 testLlmConfig 验证
   *
   * 复用已有 LLM_CONFIG_TEST 通道，无需新增 IPC。
   * 测试时禁用按钮防止重复点击，完成后恢复。
   */
  private async testProviderConnection(): Promise<void> {
    const provider = this.providerProviderInput?.value.trim();
    const model = this.providerModelInput?.value.trim();
    const baseUrl = this.providerBaseUrlInput?.value.trim() || '';
    const apiKey = this.providerApiKeyInput?.value.trim();

    if (!provider || !model || !apiKey) {
      this.host.showToast('请填写提供商、模型和 API Key', 'error');
      return;
    }

    const btn = this.btnProviderTest;
    if (!btn) return;

    // 禁用按钮防止重复点击
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '测试中...';

    try {
      const result = await window.electronAPI.testLlmConfig({
        provider,
        model,
        baseUrl: baseUrl || '',
        apiKey,
      });

      if (result.success) {
        this.host.showToast('连接成功', 'success');
      } else {
        this.host.showToast(result.error ?? '连接失败', 'error');
      }
    } catch (err) {
      console.error('LLM 连接测试异常:', err);
      this.host.showToast('测试异常，请检查网络', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  /**
   * 删除 Provider
   *
   * 前端保护：已隐藏激活 Provider 的删除按钮，此方法作为运行时兜底。
   */
  private async deleteProvider(key: string): Promise<void> {
    // 运行时兜底：禁止删除当前激活的 Provider
    try {
      const data = await window.electronAPI.listLlmProviders();
      if (data.active === key) {
        this.host.showToast('不能删除当前激活的 Provider，请先切换到其他 Provider', 'error');
        return;
      }
    } catch (error) {
      // 获取激活状态失败时不阻塞删除，但记录日志便于排查（主进程仍有兜底校验）
      console.error('[SettingsPanelManager] 删除前获取 Provider 列表失败:', error);
    }

    // 使用项目统一的 showConfirmDialog（支持主题/焦点/键盘），替代原生 confirm()
    const confirmed = await this.host.showConfirmDialog({
      title: '删除 Provider',
      message: `确定删除 Provider "${key}"？`,
      confirmText: '删除',
      danger: true,
    });
    if (!confirmed) return;

    const result = await window.electronAPI.deleteLlmProvider(key);
    if (result.success) {
      this.host.showToast('Provider 已删除');
      await this.loadProviderList();
    } else {
      this.host.showToast(result.error ?? '删除失败', 'error');
    }
  }

  /**
   * 切换激活 Provider
   */
  private async setActiveProvider(key: string): Promise<void> {
    const result = await window.electronAPI.setActiveLlmProvider(key);
    if (result.success) {
      this.host.showToast('已切换 Provider');
      await this.loadProviderList();
    } else {
      this.host.showToast(result.error ?? '切换失败', 'error');
    }
  }

  /**
   * 初始化 Provider 管理事件监听器
   *
   * 包含：
   * - 添加/保存/取消/测试按钮的 click 监听
   * - Provider 卡片列表的事件委托（activate/edit/delete）
   *
   * 事件委托一次性绑定到 providerListEl，避免每次 renderProviderList 重新绑定
   * 导致监听器累积泄漏。通过 EventTracker 统一管理，cleanup 时自动清理。
   */
  private initProviderListeners(): void {
    // 所有 Provider 管理按钮均为可选元素，若缺失则静默降级
    if (!this.btnAddProvider && !this.btnProviderSave && !this.btnProviderCancel && !this.btnProviderTest) {
      return;
    }
    if (this.btnAddProvider) {
      this.events.addEventListener(this.btnAddProvider, 'click', () => {
        this.showProviderForm('');
      });
    }
    if (this.btnProviderSave) {
      this.events.addEventListener(this.btnProviderSave, 'click', async () => {
        await this.saveProvider();
      });
    }
    if (this.btnProviderCancel) {
      this.events.addEventListener(this.btnProviderCancel, 'click', () => {
        this.hideProviderForm();
      });
    }
    // Provider 连接测试：从表单读取当前配置，调用 testLlmConfig 验证
    if (this.btnProviderTest) {
      this.events.addEventListener(this.btnProviderTest, 'click', async () => {
        await this.testProviderConnection();
      });
    }

    // Provider 卡片列表事件委托（一次性绑定，替代原 bindProviderCardActions 的每次渲染重绑）
    // 通过 closest 定位点击的按钮，根据 data-action 分发到对应处理方法
    if (this.providerListEl) {
      this.events.addEventListener(this.providerListEl, 'click', async (e: Event) => {
        const target = e.target as HTMLElement;
        const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
        if (!btn) return;

        const action = btn.dataset.action;
        const key = btn.dataset.key;
        if (!key) return;

        if (action === 'activate') {
          await this.setActiveProvider(key);
        } else if (action === 'edit') {
          this.showProviderForm(key);
        } else if (action === 'delete') {
          await this.deleteProvider(key);
        }
      });
    }
  }

  /** 加载配置到表单 */
  loadConfigToForm(config: SpriteConfigForm): void {
    this.isLoadingConfig = true;
    try {
      if (this.cfgSilent) this.cfgSilent.checked = config.silentMode;
      if (this.cfgThreshold) this.cfgThreshold.value = String(config.proactiveThreshold);
      if (this.cfgCooldown) this.cfgCooldown.value = String(Math.round(config.proactiveCooldownMs / MS_PER_MINUTE));
      if (this.cfgInterval) this.cfgInterval.value = String(Math.round(config.triggerIntervalMs / MS_PER_MINUTE));
      if (this.cfgWatcherEnabled) this.cfgWatcherEnabled.checked = config.fileWatcherEnabled;
      if (this.cfgWatcherPaths) this.cfgWatcherPaths.value = config.fileWatcherPaths.join(', ');
      if (this.cfgWatcherDebounce) this.cfgWatcherDebounce.value = String(config.fileWatcherDebounceMs);
      // 缺口 II：加载文件监听忽略模式（glob 列表 → 逗号分隔字符串）
      if (this.cfgWatcherIgnore) this.cfgWatcherIgnore.value = (config.fileWatcherIgnore ?? []).join(', ');
      if (this.cfgDefaultPersona) this.cfgDefaultPersona.value = config.defaultPersona;

      // 角色匹配模式（单选按钮）
      const modeRadio = Array.from(this.personaModeRadios).find(
        (r) => r.value === this.currentPersonaMode,
      );
      if (modeRadio) {
        modeRadio.checked = true;
      }

      // ADR-015 同步归档模式 radio（即时生效字段，仅回显选中状态）
      this.archiveModeRadios.forEach((radio) => {
        radio.checked = radio.value === config.archiveMode;
      });

      // 项目模式（单选按钮 + 专注项目下拉框）
      const projectModeRadio = Array.from(this.projectModeRadios).find(
        (r) => r.value === config.projectMode,
      );
      if (projectModeRadio) {
        projectModeRadio.checked = true;
      }
      if (this.cfgFocusProject) {
        this.cfgFocusProject.disabled = config.projectMode !== 'focus';
      }
      // 专注项目路径在 loadProjects 后由 renderer.ts 设置选中项

      // Phase 3.3 快捷键配置（总开关 + 三个动作的 accelerator）
      if (this.cfgShortcutsEnabled) {
        this.cfgShortcutsEnabled.checked = config.shortcuts.enabled;
      }
      if (this.cfgShortcutToggleWindow) {
        this.cfgShortcutToggleWindow.value = config.shortcuts.accelerators['toggle-window'] ?? '';
      }
      if (this.cfgShortcutQuickRecord) {
        this.cfgShortcutQuickRecord.value = config.shortcuts.accelerators['quick-record'] ?? '';
      }
      if (this.cfgShortcutRecallMemory) {
        this.cfgShortcutRecallMemory.value = config.shortcuts.accelerators['recall-memory'] ?? '';
      }
    } finally {
      this.isLoadingConfig = false;
    }
  }

  /** 加载项目列表到专注项目下拉框 */
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    if (!this.cfgFocusProject) return;

    // 保留第一个占位选项
    while (this.cfgFocusProject.options.length > 1) {
      this.cfgFocusProject.remove(1);
    }
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = `${p.name} (${p.path})`;
      this.cfgFocusProject.appendChild(opt);
    }
    this.cfgFocusProject.value = selectedPath;
  }

  /** 设置角色匹配模式（供 renderer.ts 调用） */
  setPersonaMode(mode: string): void {
    this.currentPersonaMode = mode;
    const radio = Array.from(this.personaModeRadios).find(
      (r) => r.value === mode,
    );
    if (radio) {
      radio.checked = true;
    }
  }

  /** 收集表单中的配置 */
  collectConfigFromForm(): SpriteConfigForm {
    const modeRadio = Array.from(this.personaModeRadios).find((r) => r.checked);
    this.currentPersonaMode = modeRadio?.value ?? 'auto';

    // 收集项目模式
    const projectModeRadio = Array.from(this.projectModeRadios).find((r) => r.checked);
    const projectMode = projectModeRadio?.value === 'focus' ? 'focus' : 'smart';

    // 收集主题（主题即时生效，onConfigSave 不保存 theme，此处仅满足类型契约）
    const themeRadio = Array.from(this.themeModeRadios).find((r) => r.checked);
    const theme = themeRadio?.value === 'dark' ? 'dark' : 'light';

    // ADR-015 收集归档模式（即时生效，此处仅满足类型契约，实际持久化在 onArchiveModeChange）
    const archiveModeChecked = Array.from(this.archiveModeRadios).find((r) => r.checked);
    const archiveMode = (archiveModeChecked?.value as 'full' | 'insights-only' | 'manual') ?? 'full';

    return {
      theme,
      archiveMode,
      silentMode: this.cfgSilent?.checked ?? false,
      proactiveThreshold: parseInt(this.cfgThreshold?.value ?? '3', 10) || 3,
      proactiveCooldownMs: (parseInt(this.cfgCooldown?.value ?? '5', 10) || 5) * MS_PER_MINUTE,
      triggerIntervalMs: (parseInt(this.cfgInterval?.value ?? '60', 10) || 60) * MS_PER_MINUTE,
      fileWatcherEnabled: this.cfgWatcherEnabled?.checked ?? false,
      fileWatcherPaths: this.cfgWatcherPaths?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      // 缺口 II：收集文件监听忽略模式（逗号分隔字符串 → glob 列表，与 fileWatcherPaths 对称处理）
      fileWatcherIgnore: this.cfgWatcherIgnore?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce?.value ?? '1000', 10) || 1000,
      defaultPersona: this.cfgDefaultPersona?.value.trim() ?? '',
      projectMode,
      focusProjectPath: projectMode === 'focus' ? (this.cfgFocusProject?.value ?? '') : '',
      // Phase 3.3 快捷键配置（总开关 + 三个动作的 accelerator）
      shortcuts: {
        enabled: this.cfgShortcutsEnabled?.checked ?? true,
        accelerators: {
          'toggle-window': this.cfgShortcutToggleWindow?.value.trim() ?? '',
          'quick-record': this.cfgShortcutQuickRecord?.value.trim() ?? '',
          'recall-memory': this.cfgShortcutRecallMemory?.value.trim() ?? '',
        },
      },
    };
  }

  // ─── 回调注册 ───────────────────────────────────────────

  onConfigSave(cb: (config: SpriteConfigForm) => void): void {
    this.configSaveCallback = cb;
  }
  /** 注册角色匹配模式变更回调 */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.personaModeChangeCallback = cb;
  }
  /** ADR-015 注册归档模式变更回调（radio change 时即时触发持久化 + 应用到 Agent） */
  onArchiveModeChange(cb: (mode: 'full' | 'insights-only' | 'manual') => void): void {
    this.archiveModeChangeCallback = cb;
  }

  /** 获取当前角色匹配模式（供 UIManager 同步到 persona badge） */
  getCurrentPersonaMode(): string {
    return this.currentPersonaMode;
  }

  /**
   * 自动保存配置
   *
   * 用户修改设置后，500ms 内无操作则自动保存到主进程。
   * 已排除的字段：theme（主题即时生效，单独持久化）、archiveMode（即时生效，单独持久化）、
   * personaMode（即时生效，单独持久化）。
   */
  private async autoSaveConfig(): Promise<void> {
    if (this.isAutoSaving) return;
    this.isAutoSaving = true;

    try {
      const spriteConfig = this.collectConfigFromForm();
      const validationError = this.validateConfig(spriteConfig);
      if (validationError) {
        this.host.showToast(validationError, 'error');
        this.updateSaveStatus('error');
        return;
      }

      this.updateSaveStatus('saving');
      this.configSaveCallback?.(spriteConfig);
      this.settingsFormDirty = false;
      this.updateSaveStatus('saved');
    } catch (error) {
      console.error('[SettingsPanelManager] 自动保存配置失败:', error);
      this.host.showToast('保存失败，请重试', 'error');
      this.updateSaveStatus('error');
    } finally {
      this.isAutoSaving = false;
      // 如果在保存期间用户继续修改了设置，触发新一轮保存
      if (this.settingsFormDirty) {
        this.debouncedAutoSave?.();
      }
    }
  }

  /**
   * 验证配置表单值是否合法
   *
   * @param config 表单配置
   * @returns 验证错误信息，如果验证通过返回 null
   */
  private validateConfig(config: SpriteConfigForm): string | null {
    // 主动提示阈值：1-10 之间的正整数
    if (!Number.isInteger(config.proactiveThreshold) || config.proactiveThreshold < 1 || config.proactiveThreshold > 10) {
      return '主动提示阈值必须是 1-10 之间的整数';
    }

    // 冷却时间：1-60 分钟
    const cooldownMinutes = config.proactiveCooldownMs / MS_PER_MINUTE;
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 60) {
      return '冷却时间必须是 1-60 之间的整数（分钟）';
    }

    // 触发间隔：1-1440 分钟（24小时）
    const intervalMinutes = config.triggerIntervalMs / MS_PER_MINUTE;
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      return '触发间隔必须是 1-1440 之间的整数（分钟）';
    }

    // 文件监听防抖：100-60000 毫秒
    if (!Number.isInteger(config.fileWatcherDebounceMs) || config.fileWatcherDebounceMs < 100 || config.fileWatcherDebounceMs > 60000) {
      return '文件监听防抖必须是 100-60000 之间的整数（毫秒）';
    }

    return null;
  }

  /**
   * 更新保存状态指示器显示
   *
   * 使用 SVG sprite 图标（icon-hourglass/icon-check/icon-close）替代 emoji 字符，
   * 与全应用图标体系统一。图标引用为项目内部硬编码字符串，无 XSS 风险。
   *
   * @param status 保存状态：idle（空闲）、saving（保存中）、saved（已保存）、error（出错）
   */
  private updateSaveStatus(status: 'idle' | 'saving' | 'saved' | 'error'): void {
    if (!this.saveStatusEl) return;

    const iconEl = this.saveStatusEl.querySelector('.save-status-icon');
    const textEl = this.saveStatusEl.querySelector('.save-status-text');
    if (!iconEl || !textEl) return;

    // 移除所有状态类
    this.saveStatusEl.classList.remove('saving', 'saved', 'error', 'idle');

    switch (status) {
      case 'saving':
        this.saveStatusEl.classList.add('saving');
        // 沙漏图标，CSS .save-status-indicator.saving 下带旋转动画
        iconEl.innerHTML = '<svg class="icon"><use href="#icon-hourglass"/></svg>';
        textEl.textContent = '保存中…';
        break;
      case 'saved':
        this.saveStatusEl.classList.add('saved');
        // 勾选图标（绿色，CSS .save-status-indicator.saved 控制颜色）
        iconEl.innerHTML = '<svg class="icon"><use href="#icon-check"/></svg>';
        textEl.textContent = '已保存';
        // 3秒后恢复为空闲状态
        this.timers.setTimeout(() => {
          this.updateSaveStatus('idle');
        }, 3000);
        break;
      case 'error':
        this.saveStatusEl.classList.add('error');
        // 关闭 X 图标（红色，CSS .save-status-indicator.error 控制颜色）
        iconEl.innerHTML = '<svg class="icon"><use href="#icon-close"/></svg>';
        textEl.textContent = '保存失败';
        // 3秒后恢复为空闲状态
        this.timers.setTimeout(() => {
          this.updateSaveStatus('idle');
        }, 3000);
        break;
      default:
        this.saveStatusEl.classList.add('idle');
        // 空闲状态清空图标和文字（指示器整体隐藏由 CSS .idle 控制）
        iconEl.innerHTML = '';
        textEl.textContent = '';
    }
  }

  /**
   * 渲染已加载技能列表（设置面板 skill tab）
   *
   * 消费内核 agent.skills.list，在设置面板的"技能"tab 展示当前加载的技能。
   * 每个技能项展示名称、关键词标签和来源层级（project/agent）。
   * 无技能时隐藏列表区域，显示空状态占位。
   *
   * 从 dashboardPanelManager 迁入：技能列表 DOM 本就在设置面板 skill tab 内，
   * 渲染逻辑应归属于 SettingsPanelManager，职责对齐。
   *
   * @param skills 技能列表（由 DASHBOARD_GET 返回，含 name/keywords/description/layer）
   */
  renderSkills(
    skills: Array<{
      name: string;
      keywords: string[];
      description: string;
      layer: string;
    }>,
  ): void {
    const listEl = this.skillsListEl;
    const sectionEl = this.skillsSectionEl;
    const emptyEl = this.skillsEmptyEl;
    if (!listEl || !sectionEl) return;

    // 无技能：隐藏列表，显示空状态占位
    if (skills.length === 0) {
      sectionEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    clearElement(listEl);

    // 使用 DocumentFragment 批量插入，避免循环中逐个 appendChild 触发重排
    const fragment = document.createDocumentFragment();

    for (const skill of skills) {
      const li = document.createElement('li');
      li.className = 'skill-item';
      li.title = skill.description || skill.name;

      // 技能名称
      const nameSpan = document.createElement('span');
      nameSpan.className = 'skill-name';
      nameSpan.textContent = skill.name;

      // 来源层级标签（project/agent）
      const layerSpan = document.createElement('span');
      layerSpan.className = `skill-layer skill-layer-${skill.layer}`;
      layerSpan.textContent = skill.layer === 'agent' ? '全局' : '项目';

      // 名称和层级标签始终展示
      li.appendChild(nameSpan);
      li.appendChild(layerSpan);
      // 关键词标签（最多展示 5 个，避免过长）
      if (skill.keywords.length > 0) {
        const kwSpan = document.createElement('span');
        kwSpan.className = 'skill-keywords';
        kwSpan.textContent = skill.keywords.slice(0, 5).join(' · ');
        li.appendChild(kwSpan);
      }

      fragment.appendChild(li);
    }

    listEl.appendChild(fragment);
    sectionEl.classList.remove('hidden');
    // 有技能时隐藏空状态占位
    if (emptyEl) emptyEl.classList.add('hidden');
  }
}
