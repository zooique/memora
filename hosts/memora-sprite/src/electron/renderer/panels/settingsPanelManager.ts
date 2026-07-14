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

import { clearElement, getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';
import { reportError } from '../helpers/errorHelpers.js';
import { setIcon } from '../helpers/icon.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { SafeTimerTracker } from '../helpers/safeTimer.js';
/** 从精灵零依赖常量模块导入，避免把 spriteConfig.ts 中的 Node.js 内置模块带入渲染进程 */
import { MS_PER_MINUTE, MS_PER_HOUR } from '../../../sprite/constants.js';
import type {
  SpriteConfigForm,
  ConfirmDialogOptions,
  ToastType,
  LlmProviderConfig,
} from '../types.js';
// 多 Provider 管理子系统（CRUD + 渲染 + 事件委托）提取到独立 helper
import {
  loadProviderList as loadProviderListHelper,
  initProviderListeners as initProviderListenersHelper,
} from '../helpers/providerManagement.js';
import type { ProviderManagementContext } from '../helpers/providerManagement.js';
// 快捷键捕获子系统（捕获式输入 + 冲突检测）提取到独立 helper
import { initShortcutCapture as initShortcutCaptureHelper } from '../helpers/shortcutCapture.js';
import type { ShortcutCaptureContext, ShortcutInputBinding } from '../helpers/shortcutCapture.js';

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
   * 显示模态弹窗（委托 ModalManager.showModal，启用焦点陷阱 + 保存焦点 + 聚焦首元素）
   */
  showModal(modalId: string): void;
  /**
   * 隐藏模态弹窗（配合 showModal 使用，恢复焦点）
   */
  hideModal(modalId: string): void;
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
  /** 文件监听忽略模式（glob 列表，逗号分隔输入） */
  private cfgWatcherIgnore: HTMLInputElement | null;
  private cfgDefaultPersona: HTMLInputElement | null;
  /** 项目模式：专注项目选择下拉框 */
  private cfgFocusProject: HTMLSelectElement | null;
  /** 使用统计开关（AUDIT-5-4 隐私合规） */
  private cfgUsageStats: HTMLInputElement | null;

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
  private cachedProviders: LlmProviderConfig[] = [];
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
  // 回调返回 Promise<boolean>，true=保存成功，false=保存失败（IPC 错误或事务回滚）
  private configSaveCallback: ((config: SpriteConfigForm) => Promise<boolean>) | null = null;
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
    this.cfgWatcherIgnore = getOptionalElement('cfg-watcher-ignore', 'input');
    this.cfgDefaultPersona = getOptionalElement('cfg-default-persona', 'input');
    this.cfgFocusProject = getOptionalElement('cfg-focus-project', 'select');
    this.cfgUsageStats = getOptionalElement('cfg-usage-stats', 'input');

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

    // 构造完成后统一校验所有字段，HTML ID 拼错时一次性 reportError 报告
    // 避免静默降级导致用户配置静默失效（保存时表单值为 undefined，主进程收到空配置）
    this.validateSettingsElements();
  }

  /**
   * 校验设置面板所有可选元素是否成功获取
   *
   * 收集所有 null 字段，统一 reportError 报告（包含字段名和期望 ID），
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
      ['cfgUsageStats', this.cfgUsageStats, 'cfg-usage-stats'],
      ['cfgShortcutsEnabled', this.cfgShortcutsEnabled, 'cfg-shortcuts-enabled'],
      ['cfgShortcutToggleWindow', this.cfgShortcutToggleWindow, 'cfg-shortcut-toggle-window'],
      ['cfgShortcutQuickRecord', this.cfgShortcutQuickRecord, 'cfg-shortcut-quick-record'],
      ['cfgShortcutRecallMemory', this.cfgShortcutRecallMemory, 'cfg-shortcut-recall-memory'],
    ];
    // 收集缺失字段
    const missing = fields.filter(([, el]) => el === null).map(([name, , id]) => `${name} (#${id})`);
    if (missing.length > 0) {
      // 一次性报告所有缺失字段，便于开发者一次性定位
      reportError(
        'SettingsPanelManager 字段校验',
        new Error(`${missing.length} 个设置面板字段未找到，相关配置将静默失效：\n  - ${missing.join('\n  - ')}\n请检查 index.html 中对应的 ID 是否拼写正确或被移除。`),
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
    /** 强制释放对话锁按钮（应急恢复，与"恢复默认"同属危险操作区） */
    const btnForceRelease = getOptionalElement('btn-force-release-lock', 'button');

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
            // AUDIT-5-4 使用统计默认关闭（隐私合规，需用户显式开启）
            usageStatsEnabled: false,
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

    // 强制释放对话锁按钮：应急恢复（LLM 挂起但未触发 60s 超时时手动解锁）
    if (btnForceRelease) {
      this.events.addEventListener(btnForceRelease, 'click', () => {
        void (async () => {
          // 二次确认：强制释放可能导致原 generator 在后台继续运行，
          // 虽内核 token 机制保证新调用安全，但仍属非常规操作
          const confirmed = await this.host.showConfirmDialog({
            title: '强制释放对话锁',
            message: '当对话卡死且停止按钮无效时使用。强制释放后可立即发起新对话，但原对话的后续输出将被丢弃。继续吗？',
            confirmText: '强制释放',
            danger: true,
          });
          if (!confirmed) return;
          try {
            const { released } = await window.electronAPI.forceReleaseChatLock();
            if (released) {
              this.host.showToast('对话锁已强制释放，可立即发起新对话', 'success');
            } else {
              this.host.showToast('当前无对话锁占用，无需释放', 'info');
            }
          } catch (error) {
            reportError('forceReleaseChatLock', error);
            this.host.showToast('强制释放失败，请稍后重试或重启应用', 'error');
          }
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

    // AUDIT-5-4 隐私与数据：导出/清除使用统计按钮
    this.bindUsageStatsButtons();
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

  // ─── Phase 3.3 快捷键捕获式输入（委托到 shortcutCapture helper） ───

  /**
   * 初始化快捷键捕获式输入（委托到 helper）
   *
   * 捕获逻辑、accelerator 解析、冲突检测已提取到 shortcutCapture.ts，
   * 此处仅构建 context 并委托。helper 通过 ctx.events 注册监听器，
   * cleanup 由主类统一管理。
   */
  private initShortcutCapture(): void {
    initShortcutCaptureHelper(this.buildShortcutCaptureContext());
  }

  /**
   * 构建快捷键捕获子系统的依赖注入容器
   *
   * 将 SettingsPanelManager 的快捷键输入框 DOM 元素、事件跟踪器和宿主回调
   * 通过 context 暴露给 shortcutCapture helper，保持状态所有权在
   * SettingsPanelManager，同时让 helper 能以纯函数方式访问状态和注册回调。
   */
  private buildShortcutCaptureContext(): ShortcutCaptureContext {
    // 过滤掉 null 元素（HTML ID 拼写错误时降级，validateSettingsElements 已报告）
    const inputs: ShortcutInputBinding[] = [
      { input: this.cfgShortcutToggleWindow, action: 'toggle-window' },
      { input: this.cfgShortcutQuickRecord, action: 'quick-record' },
      { input: this.cfgShortcutRecallMemory, action: 'recall-memory' },
    ].filter((b): b is ShortcutInputBinding => b.input !== null);

    return {
      inputs,
      events: this.events,
      // 捕获/清除成功：标记表单为 dirty 并触发防抖自动保存
      onCapture: () => {
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      },
      onClear: () => {
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      },
      // 冲突：显示警告 toast，helper 不会将值填入输入框
      onConflict: (_action, accelerator) => {
        this.host.showToast(`快捷键 ${accelerator} 与其他动作冲突，请使用其他组合`, 'warning');
      },
    };
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
      const defaultText = status === 'ready' ? '精灵已就绪' : status === 'error' ? '精灵未就绪' : '检测中...';
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

  // ─── 多 Provider 管理（委托到 providerManagement helper） ───

  /**
   * 加载 Provider 列表并渲染
   *
   * 从主进程获取所有 Provider 配置，渲染为卡片列表。
   * 设置面板初次显示时调用。
   */
  async loadProviderList(): Promise<void> {
    return loadProviderListHelper(this.buildProviderContext());
  }

  /**
   * 初始化 Provider 管理事件监听器（委托到 helper）
   *
   * 包含：
   * - 添加/保存/取消/测试按钮的 click 监听
   * - Provider 卡片列表的事件委托（activate/edit/delete）
   *
   * 事件委托一次性绑定到 providerListEl，避免每次 renderProviderList 重新绑定
   * 导致监听器累积泄漏。通过 EventTracker 统一管理，cleanup 时自动清理。
   */
  private initProviderListeners(): void {
    initProviderListenersHelper(this.buildProviderContext());
  }

  /**
   * 构建多 Provider 管理子系统的依赖注入容器
   *
   * 将 SettingsPanelManager 的 Provider 相关 DOM 元素、cachedProviders 状态
   * 和宿主回调通过 context 暴露给 providerManagement helper，保持状态所有权
   * 在 SettingsPanelManager，同时让 helper 能以纯函数方式访问状态和注册回调。
   */
  private buildProviderContext(): ProviderManagementContext {
    return {
      host: this.host,
      events: this.events,
      providerListEl: this.providerListEl,
      providerModalEl: this.providerModalEl,
      providerModalTitleEl: this.providerModalTitleEl,
      providerAliasInput: this.providerAliasInput,
      providerDisplayInput: this.providerDisplayInput,
      providerProviderInput: this.providerProviderInput,
      providerModelInput: this.providerModelInput,
      providerBaseUrlInput: this.providerBaseUrlInput,
      providerApiKeyInput: this.providerApiKeyInput,
      providerTemperatureInput: this.providerTemperatureInput,
      btnAddProvider: this.btnAddProvider,
      backgroundProviderSelect: this.backgroundProviderSelect,
      btnProviderSave: this.btnProviderSave,
      btnProviderCancel: this.btnProviderCancel,
      btnProviderTest: this.btnProviderTest,
      getCachedProviders: () => this.cachedProviders,
      setCachedProviders: (providers) => { this.cachedProviders = providers; },
    };
  }

  /**
   * 绑定「隐私与数据」分区的按钮事件（AUDIT-5-4）
   *
   * - 导出统计：调用主进程导出 JSON 文件，成功后 toast 提示文件路径
   * - 清除数据：二次确认后调用主进程清空计数器，避免误操作
   *
   * 个人项目场景，按钮均直接复用主进程既有 IPC 通道，无需新增。
   */
  private bindUsageStatsButtons(): void {
    const btnExport = getOptionalElement('btn-usage-stats-export', 'button');
    const btnClear = getOptionalElement('btn-usage-stats-clear', 'button');

    if (btnExport) {
      this.events.addEventListener(btnExport, 'click', async () => {
        setButtonLoadingEl(btnExport, true, '导出中…');
        try {
          const filePath = await window.electronAPI.usageStatsExport();
          if (filePath) {
            this.host.showToast(`已导出到 ${filePath}`, 'success');
          } else {
            this.host.showToast('采集器未就绪或无数据可导出', 'info');
          }
        } catch (error) {
          reportError('导出使用统计', error);
          this.host.showToast('导出失败，请稍后重试', 'error');
        } finally {
          setButtonLoadingEl(btnExport, false);
        }
      });
    }

    if (btnClear) {
      this.events.addEventListener(btnClear, 'click', async () => {
        // 等待用户确认+执行清除期间禁用按钮，避免重复触发确认弹窗
        setButtonLoadingEl(btnClear, true, '清除中…');
        try {
          const confirmed = await this.host.showConfirmDialog({
            title: '清除使用统计',
            message: '将清空所有计数器并重置统计起始时间，此操作不可撤销，确定继续吗？',
            confirmText: '清除',
            danger: true,
          });
          if (!confirmed) return;
          await window.electronAPI.usageStatsClear();
          this.host.showToast('已清除使用统计数据', 'success');
        } catch (error) {
          reportError('清除使用统计', error);
          this.host.showToast('清除失败，请稍后重试', 'error');
        } finally {
          setButtonLoadingEl(btnClear, false);
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
      if (this.cfgWatcherIgnore) this.cfgWatcherIgnore.value = (config.fileWatcherIgnore ?? []).join(', ');
      if (this.cfgDefaultPersona) this.cfgDefaultPersona.value = config.defaultPersona;
      // AUDIT-5-4 使用统计开关（隐私合规，默认关闭）
      if (this.cfgUsageStats) this.cfgUsageStats.checked = config.usageStatsEnabled;

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
      // 收集文件监听忽略模式（逗号分隔字符串 → glob 列表，与 fileWatcherPaths 对称处理）
      fileWatcherIgnore: this.cfgWatcherIgnore?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce?.value ?? '1000', 10) || 1000,
      defaultPersona: this.cfgDefaultPersona?.value.trim() ?? '',
      projectMode,
      focusProjectPath: projectMode === 'focus' ? (this.cfgFocusProject?.value ?? '') : '',
      // AUDIT-5-4 使用统计开关（隐私合规，默认关闭）
      usageStatsEnabled: this.cfgUsageStats?.checked ?? false,
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

  onConfigSave(cb: (config: SpriteConfigForm) => Promise<boolean>): void {
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
      // await 回调获取保存结果，回调内部已处理 toast 反馈，此处仅根据返回值更新状态指示器
      const success = (await this.configSaveCallback?.(spriteConfig)) ?? true;
      if (success) {
        this.settingsFormDirty = false;
        this.updateSaveStatus('saved');
      } else {
        this.updateSaveStatus('error');
      }
    } catch (error) {
      reportError('SettingsPanelManager', error);
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

    const iconEl = this.saveStatusEl.querySelector<HTMLElement>('.save-status-icon');
    const textEl = this.saveStatusEl.querySelector<HTMLElement>('.save-status-text');
    if (!iconEl || !textEl) return;

    // UX-0713-L7：切换状态前移除可能存在的重试按钮（避免跨状态残留）
    this.saveStatusEl.querySelector('.save-status-retry-btn')?.remove();

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
        setIcon(iconEl, 'icon-check');
        textEl.textContent = '已保存';
        // 8 秒后恢复为空闲状态（让用户有充足时间感知反馈）
        this.timers.setTimeout(() => {
          this.updateSaveStatus('idle');
        }, 8000);
        break;
      case 'error':
        this.saveStatusEl.classList.add('error');
        // 关闭 X 图标（红色，CSS .save-status-indicator.error 控制颜色）
        setIcon(iconEl, 'icon-close');
        textEl.textContent = '保存失败';
        // 追加重试按钮，让用户可主动恢复
        const retryBtn = document.createElement('button');
        retryBtn.className = 'save-status-retry-btn';
        retryBtn.textContent = '重试';
        retryBtn.title = '重新保存';
        // 通过 EventTracker 绑定事件，cleanup 时统一清理（避免内存泄漏）
        this.events.addEventListener(retryBtn, 'click', () => {
          void this.autoSaveConfig();
        });
        this.saveStatusEl.appendChild(retryBtn);
        // 错误状态不自动消失，需要用户采取行动（点击重试或修改表单触发新一轮保存）
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
