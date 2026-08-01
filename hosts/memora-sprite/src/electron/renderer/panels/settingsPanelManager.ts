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
 * - AUDIT-H5：Embedding/快捷键/精灵配置三个职责域已提取到独立 Component，
 *   SettingsPanelManager 作为编排者持有组件实例并委托具体操作
 */

import { getOptionalElement, setButtonLoadingEl } from '../helpers/domHelpers.js';
import { reportError } from '../helpers/errorHelpers.js';
// formatErrorMessage 错误文案真理源（UX-14：替代 "保存失败，请重试" 模板化文案）
import { formatErrorMessage } from '../../../shared/errorMessages.js';
import { setIcon } from '../helpers/icon.js';
import { EventTracker } from '../helpers/eventTracker.js';
import { SafeTimerTracker } from '../helpers/safeTimer.js';
/** 从精灵零依赖常量模块导入，避免把 spriteConfig.ts 中的 Node.js 内置模块带入渲染进程 */
import { MS_PER_MINUTE } from '../../../sprite/constants.js';
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
// AUDIT-H5：三个职责域提取到独立 Component
import { EmbeddingConfigComponent } from '../components/form/embeddingConfigComponent.js';
import { ShortcutConfigComponent } from '../components/form/shortcutConfigComponent.js';
import type { ShortcutConfigHost } from '../components/form/shortcutConfigComponent.js';
import { SpriteConfigComponent } from '../components/form/spriteConfigComponent.js';

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
  // ─── 子组件（AUDIT-H5 职责拆分） ─────────────────────────
  /** Embedding 配置子组件（封装 Embedding 表单 DOM 操作） */
  private readonly embeddingConfig: EmbeddingConfigComponent;
  /** 快捷键配置子组件（封装快捷键表单 DOM 操作 + 捕获输入） */
  private readonly shortcutConfig: ShortcutConfigComponent;
  /** 精灵配置子组件（封装精灵配置表单 DOM 操作 + 状态指示器） */
  private readonly spriteConfig: SpriteConfigComponent;

  // ─── 设置面板 DOM 元素 - 多 Provider 管理 ─────────────
  private providerListEl: HTMLElement | null;
  private providerModalEl: HTMLElement | null;
  private providerModalTitleEl: HTMLElement | null;
  private providerAliasInput: HTMLInputElement | null;
  private providerDisplayInput: HTMLInputElement | null;
  private providerModelInput: HTMLInputElement | null;
  private providerBaseUrlInput: HTMLInputElement | null;
  private providerApiKeyInput: HTMLInputElement | null;
  private providerTemperatureInput: HTMLInputElement | null;
  private providerModeButtons: NodeListOf<HTMLButtonElement> | null;
  private btnAddProvider: HTMLButtonElement | null;
  // 后台归档 Provider 选择框
  private backgroundProviderSelect: HTMLSelectElement | null;
  // 缓存 Provider 列表数据（编辑时用于填充表单字段，避免 DOM 解析丢失 temperature/apiKey）
  private cachedProviders: LlmProviderConfig[] = [];
  private btnProviderSave: HTMLButtonElement | null;
  private btnProviderCancel: HTMLButtonElement | null;
  private btnProviderTest: HTMLButtonElement | null;

  // ─── 缓存 DOM 元素 - 重复查询的独立元素 ─
  /** 保存状态指示器元素（显示"保存中..."、"已保存"等状态） */
  private saveStatusEl: HTMLElement | null;

  // ─── 状态 ────────────────────────────────────────────────
  /** 设置表单是否有未保存修改（dirty 标志） */
  private settingsFormDirty = false;
  /** 定时器跟踪器（用于防抖自动保存） */
  private timers = new SafeTimerTracker();
  /** 是否正在自动保存中 */
  private isAutoSaving = false;
  /** 是否正在程序化设置表单值（用于避免 loadConfigToForm 触发 dirty 标志） */
  private isLoadingConfig = false;

  // ─── 回调 ────────────────────────────────────────────────
  // 回调返回 Promise<boolean>，true=保存成功，false=保存失败（IPC 错误或事务回滚）
  private configSaveCallback: ((config: SpriteConfigForm) => Promise<boolean>) | null = null;
  /** ADR-015 归档模式变更回调（radio change 时即时触发，与主题一样即时生效） */
  private archiveModeChangeCallback: ((mode: 'full' | 'insights-only' | 'manual') => void) | null = null;

  // ─── 事件清理 ────────────────────────────────────────────
  /** 事件监听器跟踪器（统一管理事件监听器的注册与清理，避免内存泄漏） */
  private events = new EventTracker();
  /** 防抖后的自动保存函数 */
  private debouncedAutoSave: (() => void) | null = null;

  constructor(private host: SettingsPanelHost) {
    // AUDIT-H5：创建三个子组件，各自封装对应的 DOM 元素查询
    this.embeddingConfig = new EmbeddingConfigComponent();
    this.shortcutConfig = new ShortcutConfigComponent();
    this.spriteConfig = new SpriteConfigComponent();

    // 多 Provider 管理元素
    this.providerListEl = document.getElementById('provider-list');
    this.providerModalEl = document.getElementById('provider-modal');
    this.providerModalTitleEl = document.getElementById('provider-modal-title');
    this.providerAliasInput = getOptionalElement('cfg-provider-alias', 'input');
    this.providerDisplayInput = getOptionalElement('cfg-provider-display', 'input');
    this.providerModelInput = getOptionalElement('cfg-provider-model', 'input');
    this.providerBaseUrlInput = getOptionalElement('cfg-provider-base-url', 'input');
    this.providerApiKeyInput = getOptionalElement('cfg-provider-api-key', 'input');
    this.providerTemperatureInput = getOptionalElement('cfg-provider-temperature', 'input');
    this.providerModeButtons = document.querySelectorAll<HTMLButtonElement>('.cfg-provider-mode-btn');
    this.btnAddProvider = getOptionalElement('btn-add-provider', 'button');
    this.backgroundProviderSelect = getOptionalElement('cfg-background-provider', 'select');
    this.btnProviderSave = getOptionalElement('btn-provider-save', 'button');
    this.btnProviderCancel = getOptionalElement('btn-provider-cancel', 'button');
    this.btnProviderTest = getOptionalElement('btn-provider-test', 'button');

    // 保存状态指示器
    this.saveStatusEl = document.getElementById('save-status-indicator');

    // 构造完成后统一校验所有字段，HTML ID 拼错时一次性 reportError 报告
    // 填充应用版本号到"关于"分区（由 windowManager additionalArguments 注入）
    const appVersionEl = document.getElementById('app-version');
    if (appVersionEl) {
      appVersionEl.textContent = window.electronAPI.appVersion;
    }
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
   *
   * AUDIT-H5：子组件的字段由各自组件的 getValidationFields() 提供，
   * Manager 汇总所有校验结果一次性报告。
   */
  private validateSettingsElements(): void {
    // 从三个子组件收集字段
    const fields: Array<[string, HTMLElement | null, string]> = [
      ...this.embeddingConfig.getValidationFields(),
      ...this.spriteConfig.getValidationFields(),
      ...this.shortcutConfig.getValidationFields(),
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
    /** 检查更新按钮（设置 → 帮助 → 关于分区） */
    const btnCheckUpdate = getOptionalElement('btn-check-update', 'button');

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
            triggerIntervalMs: MS_PER_MINUTE,
            fileWatcherEnabled: false,
            fileWatcherPaths: ['.'],
            fileWatcherDebounceMs: 1000,
            defaultPersona: '',
            projectMode: 'smart',
            focusProjectPath: '',
            // ADR-015 归档模式默认 full
            archiveMode: 'full',
            // 使用统计默认关闭（隐私合规，需用户显式开启）
            usageStatsEnabled: false,
            // Phase 3.3 快捷键默认值（与 DEFAULT_SPRITE_CONFIG.shortcuts 一致）
            shortcuts: {
              enabled: true,
              accelerators: {
                'toggle-window': 'Ctrl+Shift+Space',
                'quick-record': 'Ctrl+Shift+M',
                'recall-memory': 'Ctrl+Shift+R',
                'quick-input': 'Ctrl+Shift+C',
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
          // B7：异步操作期间禁用按钮 + 显示"释放中…"，防止重复点击触发多次 IPC
          setButtonLoadingEl(btnForceRelease, true, '释放中…');
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
          } finally {
            setButtonLoadingEl(btnForceRelease, false);
          }
        })();
      });
    }

    // 查看更新按钮：点击直接跳转到 GitHub Releases 页面（绕过 api.github.com fetch）
    // 原因：企业代理/隐私环境下 fetch GitHub API 失败（TLS 证书或网络拦截），
    // 此方案不调 API，让用户自己在浏览器中比较当前版本与最新版本号。
    // 主进程 checkUpdate IPC（fetch + 版本比对 + dialog）保留备用——
    // 未来如恢复使用仅需将本点击回调切回 checkUpdate，无需改 IPC/主进程。
    if (btnCheckUpdate) {
      this.events.addEventListener(btnCheckUpdate, 'click', () => {
        void window.electronAPI.openReleasesUrl().catch((err: unknown) => {
          reportError('openReleasesUrl', err);
          this.host.showToast('打开更新页面失败', 'error');
        });
      });
    }

    // AUDIT-H5：项目模式/主题/归档模式单选按钮绑定委托给 SpriteConfigComponent
    // 通过 EventTracker 注册，确保 cleanup() 时能正确移除监听器
    this.spriteConfig.registerRadioEvents(this.events, {
      // 项目模式切换：启用/禁用专注项目下拉框
      onProjectModeChange: (value) => {
        this.spriteConfig.setFocusProjectDisabled(value !== 'focus');
      },
      // 主题模式切换：立即应用主题（无需等待保存按钮）
      onThemeModeChange: (value) => {
        if (value === 'light' || value === 'dark' || value === 'auto') {
          this.host.setTheme(value);
        }
      },
      // 归档模式切换：即时应用（与主题一样即时生效，无需等保存按钮）
      onArchiveModeChange: (value) => {
        this.archiveModeChangeCallback?.(value);
      },
    });

    // AUDIT-H5：快捷键捕获式输入委托给 ShortcutConfigComponent
    this.shortcutConfig.initShortcutCapture(this.events, {
      onDirtyChange: () => {
        this.settingsFormDirty = true;
        this.debouncedAutoSave?.();
      },
      showToast: (message, type, duration) => this.host.showToast(message, type, duration),
    } satisfies ShortcutConfigHost);

    // 多 Provider 管理：事件监听器 + 初始加载列表
    this.initProviderListeners();
    this.loadProviderList();

    // 隐私与数据：导出/清除使用统计按钮
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
   * 委托给 SpriteConfigComponent 处理 DOM 更新。
   * 三种状态：
   * - ready（绿色）：Agent 已就绪，可正常对话
   * - error（红色）：Agent 未就绪，通常因 LLM 配置缺失或初始化失败
   * - unknown（灰色）：检测中，通常出现在应用启动初期
   *
   * @param status Agent 连接状态
   * @param message 可选的状态描述文本（未提供时使用默认文案）
   */
  updateAgentStatusIndicator(status: 'ready' | 'error' | 'unknown', message?: string): void {
    this.spriteConfig.updateAgentStatusIndicator(status, message);
  }

  /**
   * 加载 Embedding 配置到表单
   *
   * 委托给 EmbeddingConfigComponent 处理 DOM 更新。
   * Provider 配置由 loadProviderList 独立管理，此方法仅处理 Embedding。
   */
  loadEmbeddingConfig(data: {
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
  }): void {
    this.embeddingConfig.loadEmbeddingConfig(data);
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
      providerModelInput: this.providerModelInput,
      providerBaseUrlInput: this.providerBaseUrlInput,
      providerApiKeyInput: this.providerApiKeyInput,
      providerTemperatureInput: this.providerTemperatureInput,
      providerModeButtons: this.providerModeButtons,
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
   * 绑定「隐私与数据」分区的按钮事件
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
      // AUDIT-H5：委托给子组件处理各自的 DOM 更新
      this.spriteConfig.loadToForm(config);
      this.shortcutConfig.loadToForm(config.shortcuts);
    } finally {
      this.isLoadingConfig = false;
    }
  }

  /** 加载项目列表到专注项目下拉框 */
  loadProjectsToForm(projects: Array<{ name: string; path: string }>, selectedPath: string): void {
    this.spriteConfig.loadProjectsToForm(projects, selectedPath);
  }

  /** 收集表单中的配置 */
  collectConfigFromForm(): SpriteConfigForm {
    // AUDIT-H5：从各子组件收集配置，合并为完整 SpriteConfigForm
    const spritePart = this.spriteConfig.collectFromForm();
    const shortcuts = this.shortcutConfig.collectFromForm();

    return {
      // spriteConfig 提供的字段
      theme: spritePart.theme ?? 'light',
      archiveMode: spritePart.archiveMode ?? 'full',
      silentMode: spritePart.silentMode ?? false,
      proactiveThreshold: spritePart.proactiveThreshold ?? 3,
      proactiveCooldownMs: spritePart.proactiveCooldownMs ?? 300_000,
      triggerIntervalMs: spritePart.triggerIntervalMs ?? 3600_000,
      fileWatcherEnabled: spritePart.fileWatcherEnabled ?? false,
      fileWatcherPaths: spritePart.fileWatcherPaths ?? [],
      fileWatcherIgnore: spritePart.fileWatcherIgnore ?? [],
      fileWatcherDebounceMs: spritePart.fileWatcherDebounceMs ?? 1000,
      defaultPersona: spritePart.defaultPersona ?? '',
      projectMode: spritePart.projectMode ?? 'smart',
      focusProjectPath: spritePart.focusProjectPath ?? '',
      usageStatsEnabled: spritePart.usageStatsEnabled ?? false,
      // shortcutConfig 提供的字段
      shortcuts,
    };
  }

  // ─── 回调注册 ───────────────────────────────────────────

  onConfigSave(cb: (config: SpriteConfigForm) => Promise<boolean>): void {
    this.configSaveCallback = cb;
  }
  /** ADR-015 注册归档模式变更回调（radio change 时即时触发持久化 + 应用到 Agent） */
  onArchiveModeChange(cb: (mode: 'full' | 'insights-only' | 'manual') => void): void {
    this.archiveModeChangeCallback = cb;
  }

  /**
   * 自动保存配置
   *
   * 用户修改设置后，500ms 内无操作则自动保存到主进程。
   * 已排除的字段：theme（主题即时生效，单独持久化）、archiveMode（即时生效，单独持久化）、
   * personaMode（由精灵设定面板独立持久化）。
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
      this.host.showToast(formatErrorMessage('保存', error), 'error');
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
        // UX-16：3 秒后恢复为空闲状态（足以感知反馈，避免指示器长期占用视觉空间）
        this.timers.setTimeout(() => {
          this.updateSaveStatus('idle');
        }, 3000);
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
}