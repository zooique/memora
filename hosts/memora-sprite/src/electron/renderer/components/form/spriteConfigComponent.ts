/**
 * SpriteConfigComponent - 设置面板精灵配置子组件
 *
 * 封装精灵配置相关的 DOM 元素引用、表单读写和状态指示器更新，
 * 降低 SettingsPanelManager 的字段数量与职责复杂度。
 *
 * 设计原则：
 * - 构造函数只做 DOM 查询，不做副作用
 * - 提供 getValidationFields() 供 Manager 统一校验
 * - collectFromForm() 返回 Partial<SpriteConfigForm>，Manager 合并完整对象
 *
 * 属 AUDIT-H5 SettingsPanelManager 职责拆分产物。
 */

import { getOptionalElement } from '../../helpers/domHelpers.js';
import type { EventTracker } from '../../helpers/eventTracker.js';
import type { SpriteConfigForm } from '../../types.js';
import { MS_PER_MINUTE } from '../../../../sprite/constants.js';

export class SpriteConfigComponent {
  // ─── DOM 元素引用 - 基础精灵配置 ────────────────────────
  private cfgSilent: HTMLInputElement | null;
  private cfgThreshold: HTMLInputElement | null;
  private cfgCooldown: HTMLInputElement | null;
  private cfgInterval: HTMLInputElement | null;
  private cfgWatcherEnabled: HTMLInputElement | null;
  private cfgWatcherPaths: HTMLInputElement | null;
  private cfgWatcherDebounce: HTMLInputElement | null;
  /** 文件监听忽略模式（glob 列表，逗号分隔输入） */
  private cfgWatcherIgnore: HTMLInputElement | null;
  /** 项目模式：专注项目选择下拉框 */
  private cfgFocusProject: HTMLSelectElement | null;
  /** 使用统计开关（隐私合规，默认关闭） */
  private cfgUsageStats: HTMLInputElement | null;

  // ─── 缓存 DOM 元素 - radio 按钮组 ──────────────────────
  /** 项目模式单选按钮组（NodeList 静态快照，构造时获取一次） */
  private projectModeRadios: NodeListOf<HTMLInputElement>;
  /** 主题模式单选按钮组 */
  private themeModeRadios: NodeListOf<HTMLInputElement>;
  /** 归档模式单选按钮组 */
  private archiveModeRadios: NodeListOf<HTMLInputElement>;

  // ─── 缓存 DOM 元素 - 状态指示器 ─────────────────────────
  /** Agent 状态指示器元素（updateAgentStatusIndicator 中查询） */
  private agentStatusEl: HTMLElement | null;

  constructor() {
    // 基础精灵配置
    this.cfgSilent = getOptionalElement('cfg-silent', 'input');
    this.cfgThreshold = getOptionalElement('cfg-threshold', 'input');
    this.cfgCooldown = getOptionalElement('cfg-cooldown', 'input');
    this.cfgInterval = getOptionalElement('cfg-interval', 'input');
    this.cfgWatcherEnabled = getOptionalElement('cfg-watcher-enabled', 'input');
    this.cfgWatcherPaths = getOptionalElement('cfg-watcher-paths', 'input');
    this.cfgWatcherDebounce = getOptionalElement('cfg-watcher-debounce', 'input');
    this.cfgWatcherIgnore = getOptionalElement('cfg-watcher-ignore', 'input');
    this.cfgFocusProject = getOptionalElement('cfg-focus-project', 'select');
    this.cfgUsageStats = getOptionalElement('cfg-usage-stats', 'input');

    // radio 按钮组
    this.projectModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="project-mode"]');
    this.themeModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    this.archiveModeRadios = document.querySelectorAll<HTMLInputElement>('input[name="archive-mode"]');

    // 状态指示器
    this.agentStatusEl = document.getElementById('agent-status-indicator');
  }

  /**
   * 加载精灵配置到表单
   *
   * @param config 精灵配置对象
   */
  loadToForm(config: SpriteConfigForm): void {
    if (this.cfgSilent) this.cfgSilent.checked = config.silentMode;
    if (this.cfgThreshold) this.cfgThreshold.value = String(config.proactiveThreshold);
    if (this.cfgCooldown) this.cfgCooldown.value = String(Math.round(config.proactiveCooldownMs / MS_PER_MINUTE));
    if (this.cfgInterval) this.cfgInterval.value = String(Math.round(config.triggerIntervalMs / MS_PER_MINUTE));
    if (this.cfgWatcherEnabled) this.cfgWatcherEnabled.checked = config.fileWatcherEnabled;
    if (this.cfgWatcherPaths) this.cfgWatcherPaths.value = config.fileWatcherPaths.join(', ');
    if (this.cfgWatcherDebounce) this.cfgWatcherDebounce.value = String(config.fileWatcherDebounceMs);
    if (this.cfgWatcherIgnore) this.cfgWatcherIgnore.value = (config.fileWatcherIgnore ?? []).join(', ');
    // 使用统计开关（隐私合规，默认关闭）
    if (this.cfgUsageStats) this.cfgUsageStats.checked = config.usageStatsEnabled;

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
  }

  /**
   * 从表单收集精灵配置相关字段
   *
   * @returns 部分精灵配置对象（不包含 shortcuts，由 ShortcutConfigComponent 收集）
   */
  collectFromForm(): Partial<SpriteConfigForm> {
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
      fileWatcherIgnore: this.cfgWatcherIgnore?.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0) ?? [],
      fileWatcherDebounceMs: parseInt(this.cfgWatcherDebounce?.value ?? '1000', 10) || 1000,
      defaultPersona: '',
      projectMode,
      focusProjectPath: projectMode === 'focus' ? (this.cfgFocusProject?.value ?? '') : '',
      usageStatsEnabled: this.cfgUsageStats?.checked ?? false,
    };
  }

  /**
   * 加载项目列表到专注项目下拉框
   *
   * @param projects 项目列表
   * @param selectedPath 当前选中的项目路径
   */
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
   * 注册所有 radio 按钮变更事件监听器（通过 EventTracker 统一管理，支持 cleanup 清理）
   *
   * 包含：项目模式（启用/禁用专注项目下拉框）、主题模式（即时应用主题）、
   * 归档模式（即时应用归档模式）。
   * 使用 EventTracker 注册，确保 cleanup() 时能正确移除监听器。
   *
   * @param events 事件跟踪器（由 SettingsPanelManager 传入，统一清理）
   * @param callbacks 各模式变更回调
   */
  registerRadioEvents(
    events: EventTracker,
    callbacks: {
      onProjectModeChange: (value: string) => void;
      onThemeModeChange: (value: string) => void;
      onArchiveModeChange: (mode: 'full' | 'insights-only' | 'manual') => void;
    },
  ): void {
    // 项目模式：切换时启用/禁用专注项目下拉框
    this.projectModeRadios.forEach((radio) => {
      events.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          callbacks.onProjectModeChange(radio.value);
        }
      });
    });

    // 主题模式：切换时立即应用主题
    this.themeModeRadios.forEach((radio) => {
      events.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          const value = radio.value;
          if (value === 'light' || value === 'dark' || value === 'auto') {
            callbacks.onThemeModeChange(value);
          }
        }
      });
    });

    // 归档模式：切换时即时应用
    this.archiveModeRadios.forEach((radio) => {
      events.addEventListener(radio, 'change', () => {
        if (radio.checked) {
          const value = radio.value;
          if (value === 'full' || value === 'insights-only' || value === 'manual') {
            callbacks.onArchiveModeChange(value);
          }
        }
      });
    });
  }

  /**
   * 获取或禁用专注项目下拉框
   *
   * @param disabled 是否禁用
   */
  setFocusProjectDisabled(disabled: boolean): void {
    if (this.cfgFocusProject) {
      this.cfgFocusProject.disabled = disabled;
    }
  }

  /**
   * 获取校验字段映射列表
   *
   * 供 Manager 统一校验所有 DOM 元素是否存在。
   * 格式：[字段名, 元素引用, 期望 ID]
   */
  getValidationFields(): Array<[string, HTMLElement | null, string]> {
    return [
      ['cfgSilent', this.cfgSilent, 'cfg-silent'],
      ['cfgThreshold', this.cfgThreshold, 'cfg-threshold'],
      ['cfgCooldown', this.cfgCooldown, 'cfg-cooldown'],
      ['cfgInterval', this.cfgInterval, 'cfg-interval'],
      ['cfgWatcherEnabled', this.cfgWatcherEnabled, 'cfg-watcher-enabled'],
      ['cfgWatcherPaths', this.cfgWatcherPaths, 'cfg-watcher-paths'],
      ['cfgWatcherDebounce', this.cfgWatcherDebounce, 'cfg-watcher-debounce'],
      ['cfgWatcherIgnore', this.cfgWatcherIgnore, 'cfg-watcher-ignore'],
      ['cfgFocusProject', this.cfgFocusProject, 'cfg-focus-project'],
      ['cfgUsageStats', this.cfgUsageStats, 'cfg-usage-stats'],
    ];
  }
}