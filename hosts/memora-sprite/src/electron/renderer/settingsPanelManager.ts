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
 *
 * 提取自 ui.ts（P2-008：ui.ts 体积过大拆分），减少约 450 行。
 */

import { getOptionalElement } from './domHelpers.js';
/** 从精灵零依赖常量模块导入，避免把 spriteConfig.ts 中的 Node.js 内置模块带入渲染进程 */
import { MS_PER_MINUTE } from '../../sprite/constants.js';
import type {
  LlmConfigForm,
  EmbeddingConfigForm,
  LlmConfigSavePayload,
  SpriteConfigForm,
} from './types.js';

// ─── Host 接口（跨模块关注点注入） ────────────────────────

/** 设置面板管理器需要的宿主能力（跨模块关注点，由 UIManager 注入） */
export interface SettingsPanelHost {
  /** 设置主题（ADR-SP-008 主题切换） */
  setTheme(theme: 'light' | 'dark'): void;
  /** 更新角色匹配模式标签（IX-07） */
  updatePersonaModeBadge(mode: string): void;
  /** 显示确认对话框（FD-07 取消按钮） */
  showConfirmDialog(options: {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean>;
}

// ─── 设置面板管理器类 ─────────────────────────────────────

export class SettingsPanelManager {
  // ─── 设置面板 DOM 元素 - LLM 配置 ───────────────────────
  private cfgLlmPreset: HTMLSelectElement | null;
  private cfgLlmProvider: HTMLInputElement | null;
  private cfgLlmModel: HTMLInputElement | null;
  private cfgLlmBaseUrl: HTMLInputElement | null;
  private cfgLlmApiKey: HTMLInputElement | null;
  private cfgLlmTemperature: HTMLInputElement | null;

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
  private cfgDefaultPersona: HTMLInputElement | null;
  /** FD-04 项目模式：专注项目选择下拉框 */
  private cfgFocusProject: HTMLSelectElement | null;

  // ─── 状态 ────────────────────────────────────────────────
  /** FD-07 设置表单是否有未保存修改（dirty 标志） */
  private settingsFormDirty = false;
  /**
   * UX-P2-11 LLM 表单是否有未保存修改
   *
   * 独立于 settingsFormDirty，用于判断是否需要触发 LLM 配置保存。
   * 避免用户仅修改精灵配置时，因 LLM 字段未配置而弹出误导性 warning。
   */
  private llmFormDirty = false;
  /** LLM 预设（从主进程加载，避免硬编码） */
  private llmPresets: Record<string, { provider: string; model: string; baseUrl: string }> = {};
  /** 当前角色匹配模式（由 UIManager 同步） */
  private currentPersonaMode = 'auto';

  // ─── 回调 ────────────────────────────────────────────────
  private configSaveCallback: ((config: SpriteConfigForm) => void) | null = null;
  private configCancelCallback: (() => void) | null = null;
  private llmConfigSaveCallback: ((payload: LlmConfigSavePayload) => void) | null = null;
  /** LLM 连接测试回调 */
  private llmTestCallback: (() => void) | null = null;
  /** IX-07 角色匹配模式变更回调 */
  private personaModeChangeCallback: ((mode: string) => void) | null = null;

  // ─── 事件清理 ────────────────────────────────────────────
  private eventCleanupFunctions: Array<() => void> = [];

  constructor(private host: SettingsPanelHost) {
    // 设置面板 - LLM 配置
    this.cfgLlmPreset = getOptionalElement('cfg-llm-preset', 'select');
    this.cfgLlmProvider = getOptionalElement('cfg-llm-provider', 'input');
    this.cfgLlmModel = getOptionalElement('cfg-llm-model', 'input');
    this.cfgLlmBaseUrl = getOptionalElement('cfg-llm-base-url', 'input');
    this.cfgLlmApiKey = getOptionalElement('cfg-llm-api-key', 'input');
    this.cfgLlmTemperature = getOptionalElement('cfg-llm-temperature', 'input');

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
    this.cfgDefaultPersona = getOptionalElement('cfg-default-persona', 'input');
    this.cfgFocusProject = getOptionalElement('cfg-focus-project', 'select');
  }

  // ─── 事件监听器管理 ─────────────────────────────────────

  /** 添加事件监听器并记录清理函数 */
  private addEventListener(element: HTMLElement | Document, event: string, handler: EventListener): void {
    element.addEventListener(event, handler);
    this.eventCleanupFunctions.push(() => {
      element.removeEventListener(event, handler);
    });
  }

  /** 清理所有事件监听器 */
  cleanup(): void {
    this.eventCleanupFunctions.forEach((cleanup) => cleanup());
    this.eventCleanupFunctions = [];
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

    const btnSave = getOptionalElement('btn-settings-save', 'button');
    const btnCancel = getOptionalElement('btn-settings-cancel', 'button');
    const btnLlmTest = document.getElementById('btn-llm-test');

    // 设置面板核心元素缺失时静默降级
    if (!btnSave && !btnCancel) return;

    // API Key 显示/隐藏切换：LLM + Embedding
    this.initApiKeyToggle('btn-toggle-llm-key', 'cfg-llm-api-key');
    this.initApiKeyToggle('btn-toggle-emb-key', 'cfg-emb-api-key');

    // FD-07 监听设置面板所有表单元素的变更，标记 dirty
    const settingsPanel = document.getElementById('panel-settings');
    if (settingsPanel) {
      this.addEventListener(settingsPanel, 'input', () => {
        this.settingsFormDirty = true;
      });
      this.addEventListener(settingsPanel, 'change', () => {
        this.settingsFormDirty = true;
      });
    }

    // UX-P2-11 监听 LLM 表单字段变更，独立标记 llmFormDirty
    // 避免用户仅修改精灵配置时，LLM 保存逻辑被误触发导致误导性 warning
    const llmFields = [
      this.cfgLlmPreset,
      this.cfgLlmProvider,
      this.cfgLlmModel,
      this.cfgLlmBaseUrl,
      this.cfgLlmApiKey,
      this.cfgLlmTemperature,
      this.cfgEmbEnabled,
      this.cfgEmbModel,
      this.cfgEmbBaseUrl,
      this.cfgEmbApiKey,
    ];
    for (const field of llmFields) {
      if (field) {
        this.addEventListener(field, 'input', () => {
          this.llmFormDirty = true;
        });
        this.addEventListener(field, 'change', () => {
          this.llmFormDirty = true;
        });
      }
    }

    // 保存按钮：同时收集精灵配置和 LLM 配置
    if (btnSave) {
      this.addEventListener(btnSave, 'click', () => {
        this.settingsFormDirty = false;
        const spriteConfig = this.collectConfigFromForm();
        this.configSaveCallback?.(spriteConfig);
        // UX-P2-11 仅在 LLM 表单有修改时触发保存，避免未配置 LLM 时弹出误导性 warning
        if (this.llmFormDirty) {
          const llmConfig = this.collectLlmConfigFromForm();
          this.llmConfigSaveCallback?.(llmConfig);
          this.llmFormDirty = false;
        }
      });
    }

    // FD-07 取消按钮：有未保存修改时确认，避免误点丢失修改
    if (btnCancel) {
      this.addEventListener(btnCancel, 'click', async () => {
        if (this.settingsFormDirty) {
          const confirmed = await this.host.showConfirmDialog({
            title: '放弃修改',
            message: '有未保存的修改，确定要放弃吗？',
            confirmText: '放弃',
            danger: true,
          });
          if (!confirmed) {
            return;
          }
        }
        this.settingsFormDirty = false;
        this.configCancelCallback?.();
      });
    }

    // LLM 预设切换：自动填充 provider/model/baseUrl
    if (this.cfgLlmPreset) {
      this.addEventListener(this.cfgLlmPreset, 'change', () => {
        const presetKey = this.cfgLlmPreset!.value;
        if (presetKey) {
          this.applyLlmPreset(presetKey);
        }
      });
    }

    // LLM 连接测试按钮：调用主进程验证配置
    if (btnLlmTest) {
      this.addEventListener(btnLlmTest, 'click', () => {
        this.llmTestCallback?.();
      });
    }

    // FD-04 项目模式单选按钮：切换时启用/禁用专注项目下拉框
    const projectModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="project-mode"]');
    projectModeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        if (this.cfgFocusProject) {
          this.cfgFocusProject.disabled = radio.value !== 'focus';
        }
      });
    });

    // IX-07 角色匹配模式单选按钮：切换时实时更新标签 + 触发回调持久化
    const personaModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="persona-mode"]');
    personaModeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        const selectedMode = radio.value;
        this.currentPersonaMode = selectedMode;
        this.host.updatePersonaModeBadge(selectedMode);
        this.personaModeChangeCallback?.(selectedMode);
      });
    });

    // ADR-SP-008 主题切换单选按钮：切换时立即应用主题（无需等待保存按钮）
    const themeRadios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    themeRadios.forEach((radio) => {
      this.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          this.host.setTheme(radio.value === 'dark' ? 'dark' : 'light');
        }
      });
    });
  }

  // ─── 私有辅助方法 ───────────────────────────────────────

  /**
   * UI-UX-01 初始化设置面板 tab 切换
   *
   * 点击 tab 按钮时切换对应的内容区显示，
   * 保持 tab 按钮的 active 状态同步。
   */
  private initSettingsTabListeners(): void {
    const tabButtons = document.querySelectorAll<HTMLElement>('.settings-tab');
    const tabContents = document.querySelectorAll<HTMLElement>('.settings-tab-content');

    tabButtons.forEach((btn) => {
      this.addEventListener(btn, 'click', () => {
        const targetTab = btn.dataset.settingsTab;
        if (!targetTab) return;

        // 切换 tab 按钮 active 状态
        tabButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        // 切换内容区显示
        tabContents.forEach((content) => {
          if (content.dataset.settingsTab === targetTab) {
            content.classList.add('active');
          } else {
            content.classList.remove('active');
          }
        });
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

    this.addEventListener(btn, 'click', () => {
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
        btn.title = '隐藏 API Key';
      } else {
        input.type = 'password';
        btn.textContent = '👁';
        btn.title = '显示 API Key';
      }
    });
  }

  /** 应用 LLM 预设到表单 */
  private applyLlmPreset(key: string): void {
    const preset = this.llmPresets[key];
    if (preset && this.cfgLlmProvider && this.cfgLlmModel && this.cfgLlmBaseUrl) {
      this.cfgLlmProvider.value = preset.provider;
      this.cfgLlmModel.value = preset.model;
      this.cfgLlmBaseUrl.value = preset.baseUrl;
    }
  }

  // ─── 公共 API ───────────────────────────────────────────

  /**
   * FD-07 重置 dirty 标志
   *
   * 在 loadConfigToForm / loadLlmConfigToForm 后由 renderer.ts 调用，
   * 因为程序化设置表单值会触发 input/change 事件，需要重置 dirty 标志
   * 以避免"取消"按钮误判为有修改。
   */
  resetFormDirty(): void {
    this.settingsFormDirty = false;
    // UX-P2-11 同步重置 LLM 表单 dirty 标志
    this.llmFormDirty = false;
  }

  /** 加载 LLM 配置到表单 */
  loadLlmConfigToForm(data: {
    configured: boolean;
    config: LlmConfigForm | null;
    /** 主进程返回的 embedding（无 enabled 字段，由 configured 推断） */
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }): void {
    // 保存预设供 applyLlmPreset 使用（避免硬编码）
    this.llmPresets = data.presets ?? {};

    if (data.config) {
      if (this.cfgLlmProvider) this.cfgLlmProvider.value = data.config.provider;
      if (this.cfgLlmModel) this.cfgLlmModel.value = data.config.model;
      if (this.cfgLlmBaseUrl) this.cfgLlmBaseUrl.value = data.config.baseUrl;
      if (this.cfgLlmApiKey) this.cfgLlmApiKey.value = data.config.apiKey;
      if (this.cfgLlmTemperature) this.cfgLlmTemperature.value = String(data.config.temperature);

      // 反向匹配预设
      if (this.cfgLlmPreset) {
        const presetKey = Object.entries(data.presets).find(
          ([, p]) => p.provider === data.config?.provider && p.model === data.config.model,
        )?.[0];
        this.cfgLlmPreset.value = presetKey ?? '';
      }
    }

    if (data.embedding) {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = true;
      if (this.cfgEmbModel) this.cfgEmbModel.value = data.embedding.model;
      if (this.cfgEmbBaseUrl) this.cfgEmbBaseUrl.value = data.embedding.baseUrl;
      if (this.cfgEmbApiKey) this.cfgEmbApiKey.value = data.embedding.apiKey;
    } else {
      if (this.cfgEmbEnabled) this.cfgEmbEnabled.checked = false;
    }
  }

  /** 收集表单中的 LLM 配置 */
  collectLlmConfigFromForm(): LlmConfigSavePayload {
    const llm: LlmConfigForm = {
      provider: this.cfgLlmProvider?.value.trim() ?? '',
      model: this.cfgLlmModel?.value.trim() ?? '',
      baseUrl: this.cfgLlmBaseUrl?.value.trim() ?? '',
      apiKey: this.cfgLlmApiKey?.value.trim() ?? '',
      temperature: parseFloat(this.cfgLlmTemperature?.value ?? '0.7') || 0.7,
    };

    let embedding: EmbeddingConfigForm | null = null;
    if (this.cfgEmbEnabled?.checked) {
      embedding = {
        enabled: true,
        model: this.cfgEmbModel?.value.trim() ?? '',
        baseUrl: this.cfgEmbBaseUrl?.value.trim() ?? '',
        apiKey: this.cfgEmbApiKey?.value.trim() ?? '',
      };
    }

    return { llm, embedding };
  }

  /** 加载配置到表单 */
  loadConfigToForm(config: SpriteConfigForm): void {
    if (this.cfgSilent) this.cfgSilent.checked = config.silentMode;
    if (this.cfgThreshold) this.cfgThreshold.value = String(config.proactiveThreshold);
    if (this.cfgCooldown) this.cfgCooldown.value = String(Math.round(config.proactiveCooldownMs / MS_PER_MINUTE));
    if (this.cfgInterval) this.cfgInterval.value = String(Math.round(config.triggerIntervalMs / MS_PER_MINUTE));
    if (this.cfgWatcherEnabled) this.cfgWatcherEnabled.checked = config.fileWatcherEnabled;
    if (this.cfgWatcherPaths) this.cfgWatcherPaths.value = config.fileWatcherPaths.join(', ');
    if (this.cfgWatcherDebounce) this.cfgWatcherDebounce.value = String(config.fileWatcherDebounceMs);
    if (this.cfgDefaultPersona) this.cfgDefaultPersona.value = config.defaultPersona;

    // 角色匹配模式（单选按钮）
    const modeRadio = document.querySelector<HTMLInputElement>(
      `input[name="persona-mode"][value="${this.currentPersonaMode}"]`,
    );
    if (modeRadio) {
      modeRadio.checked = true;
    }

    // FD-04 项目模式（单选按钮 + 专注项目下拉框）
    const projectModeRadio = document.querySelector<HTMLInputElement>(
      `input[name="project-mode"][value="${config.projectMode}"]`,
    );
    if (projectModeRadio) {
      projectModeRadio.checked = true;
    }
    if (this.cfgFocusProject) {
      this.cfgFocusProject.disabled = config.projectMode !== 'focus';
    }
    // 专注项目路径在 loadProjects 后由 renderer.ts 设置选中项
  }

  /** FD-04 加载项目列表到专注项目下拉框 */
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
    const radio = document.querySelector<HTMLInputElement>(
      `input[name="persona-mode"][value="${mode}"]`,
    );
    if (radio) {
      radio.checked = true;
    }
  }

  /** 收集表单中的配置 */
  collectConfigFromForm(): SpriteConfigForm {
    const modeRadio = document.querySelector<HTMLInputElement>(
      'input[name="persona-mode"]:checked',
    );
    this.currentPersonaMode = modeRadio?.value ?? 'auto';

    // FD-04 收集项目模式
    const projectModeRadio = document.querySelector<HTMLInputElement>(
      'input[name="project-mode"]:checked',
    );
    const projectMode = projectModeRadio?.value === 'focus' ? 'focus' : 'smart';

    return {
      silentMode: this.cfgSilent?.checked ?? false,
      proactiveThreshold: parseInt(this.cfgThreshold?.value ?? '3', 10) || 3,
      proactiveCooldownMs: (parseInt(this.cfgCooldown?.value ?? '5', 10) || 5) * MS_PER_MINUTE,
      triggerIntervalMs: (parseInt(this.cfgInterval?.value ?? '60', 10) || 60) * MS_PER_MINUTE,
      fileWatcherEnabled: this.cfgWatcherEnabled?.checked ?? false,
      fileWatcherPaths: this.cfgWatcherPaths?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce?.value ?? '1000', 10) || 1000,
      defaultPersona: this.cfgDefaultPersona?.value.trim() ?? '',
      projectMode,
      focusProjectPath: projectMode === 'focus' ? (this.cfgFocusProject?.value ?? '') : '',
    };
  }

  /**
   * 显示 LLM 测试连接结果
   *
   * @param result 测试结果（success + error）
   * @param elapsedMs 测试耗时（毫秒），用于展示响应速度
   */
  showLlmTestResult(result: { success: boolean; error: string | null }, elapsedMs?: number): void {
    const resultEl = document.getElementById('llm-test-result');
    if (!resultEl) return;

    if (result.success) {
      const timeHint = elapsedMs !== undefined ? `（${elapsedMs}ms）` : '';
      resultEl.textContent = `✓ 连接成功${timeHint}`;
      resultEl.style.color = 'var(--green)';
    } else {
      // 失败时补充排查建议，引导用户修复而非仅显示错误
      const hint = '\n排查建议：检查 API Key 是否正确 / baseUrl 是否可达 / model 名称是否支持';
      resultEl.textContent = `✗ 失败：${result.error ?? '未知错误'}${hint}`;
      resultEl.style.color = 'var(--red)';
    }
  }

  /** 收集表单中的 LLM 配置（供测试连接复用） */
  getLlmConfigFromForm(): { provider: string; model: string; baseUrl: string; apiKey: string } {
    return {
      provider: this.cfgLlmProvider?.value.trim() ?? '',
      model: this.cfgLlmModel?.value.trim() ?? '',
      baseUrl: this.cfgLlmBaseUrl?.value.trim() ?? '',
      apiKey: this.cfgLlmApiKey?.value.trim() ?? '',
    };
  }

  // ─── 回调注册 ───────────────────────────────────────────

  onConfigSave(cb: (config: SpriteConfigForm) => void): void {
    this.configSaveCallback = cb;
  }
  onConfigCancel(cb: () => void): void {
    this.configCancelCallback = cb;
  }
  onLlmConfigSave(cb: (payload: LlmConfigSavePayload) => void): void {
    this.llmConfigSaveCallback = cb;
  }
  /** 注册 LLM 连接测试回调 */
  onLlmTest(cb: () => void): void {
    this.llmTestCallback = cb;
  }
  /** IX-07 注册角色匹配模式变更回调 */
  onPersonaModeChange(cb: (mode: string) => void): void {
    this.personaModeChangeCallback = cb;
  }

  /** 获取当前角色匹配模式（供 UIManager 同步到 persona badge） */
  getCurrentPersonaMode(): string {
    return this.currentPersonaMode;
  }
}