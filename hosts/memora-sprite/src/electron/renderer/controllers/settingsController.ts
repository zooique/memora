/**
 * 设置控制器 — 设置面板业务逻辑
 *
 * 职责：
 * - 设置精灵配置保存回调（批量事务性更新）
 * - 设置 LLM 配置保存回调（触发主进程重新初始化 Agent）
 * - 设置 LLM 连接测试回调
 * - 设置取消回调（重新加载配置）
 * - 加载精灵配置和 LLM 配置到表单
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - 进行中反馈：保存/测试时禁用按钮防止重复点击
 * - 加载失败时显示错误横幅，提供重试按钮
 * - 程序化设置表单值后重置 dirty 标志
 */

import type { UIManager } from '../ui.js';
import type { SpriteConfigForm } from '../types.js';
import { createIpcErrorHandler, reportError } from '../helpers/errorHelpers.js';
import { MS_PER_HOUR } from '../../../sprite/constants.js';
// 从 shared/ 导入 DEFAULT_SHORTCUTS（单一真理源，消除与 spriteConfig.ts 的重复）
import { DEFAULT_SHORTCUTS } from '../../../shared/shortcutDefaults.js';

/** silentRecoveryCallback 位于 createSettingsController 闭包内 */

/**
 * 创建设置控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 设置控制器接口（设置回调、加载配置）
 */
export function createSettingsController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /** 静默恢复回调位于闭包内，避免模块级状态违反"不持有模块级状态"原则 */
  let silentRecoveryCallback: ((remainingMs: number) => void) | null = null;

  /** 注册静默恢复回调（由 renderer.ts 调用） */
  function setSilentRecoveryCallback(cb: (remainingMs: number) => void): void {
    silentRecoveryCallback = cb;
  }

  /**
   * 设置设置面板回调
   *
   * 包含精灵配置保存、LLM 配置保存、LLM 连接测试、取消。
   */
  function setupSettingsPanel(): void {
    uiManager.onConfigSave(async (config: SpriteConfigForm) => {
      try {
        // 单次 IPC 批量更新（事务性：原子性 + 单次持久化 + 副作用去重）
        const result = await window.electronAPI.updateConfigBatch({
          silentMode: config.silentMode,
          proactiveThreshold: config.proactiveThreshold,
          proactiveCooldownMs: config.proactiveCooldownMs,
          triggerIntervalMs: config.triggerIntervalMs,
          fileWatcherEnabled: config.fileWatcherEnabled,
          fileWatcherPaths: config.fileWatcherPaths,
          // fileWatcherIgnore 纳入批量更新
          fileWatcherIgnore: config.fileWatcherIgnore,
          fileWatcherDebounceMs: config.fileWatcherDebounceMs,
          defaultPersona: config.defaultPersona,
          // 项目模式：路径与模式在同一事务内更新，避免中间态
          focusProjectPath: config.focusProjectPath,
          projectMode: config.projectMode,
        });

        if (!result.updated) {
          // 事务回滚：主进程未应用任何更新，提示具体错误
          uiManager.showToast(`保存失败：${result.error ?? '未知错误'}`, 'error');
        } else {
          uiManager.showToast('精灵配置已保存', 'success');
        }
      } catch (error) {
        handleIpcError('onConfigSave', error, '保存精灵配置失败');
      }
    });

    // ADR-015 归档模式即时切换：radio change 时立即持久化 + 应用到 Agent
    // 与主题一样即时生效，不走保存按钮（避免用户忘记保存导致归档模式与预期不一致）
    uiManager.onArchiveModeChange(async (mode) => {
      try {
        await window.electronAPI.updateConfig('archiveMode', mode);
        uiManager.showToast(`归档模式已切换为：${mode === 'full' ? '全自动' : mode === 'insights-only' ? '仅洞察自动' : '全手动'}`, 'success');
      } catch (error) {
        reportError('onArchiveModeChange', error);
        uiManager.showToast('切换归档模式失败，请重试', 'error');
        // 失败时重新加载表单，恢复 radio 到实际状态
        void loadConfig();
      }
    });

    // 写操作通过回调注入：回调仅负责 IPC 调用 + 错误处理；列表刷新由 PanelManager 自行 load()
    uiManager.setClearAuditLogCallback(async () => {
      try {
        await window.electronAPI.clearAuditLog();
      } catch (error) {
        handleIpcError('clearAuditLog', error, '清空审计日志失败');
      }
    });

    uiManager.setConfirmProfileCallback(async (id: string) => {
      try {
        await window.electronAPI.confirmUserProfile(id);
        // 确认后重新加载画像列表，确保 UI 反映最新状态
        await uiManager.loadUserProfile();
      } catch (error) {
        handleIpcError('confirmUserProfile', error, '确认用户画像失败');
      }
    });

    uiManager.setRejectProfileCallback(async (id: string) => {
      try {
        await window.electronAPI.rejectUserProfile(id);
        // 拒绝后重新加载画像列表，确保 UI 反映最新状态
        await uiManager.loadUserProfile();
      } catch (error) {
        handleIpcError('rejectUserProfile', error, '拒绝用户画像失败');
      }
    });
  }

  /** 加载精灵配置到表单 */
  async function loadConfig(): Promise<void> {
    try {
      const { config: cfg } = await window.electronAPI.getConfig();

      // 防御性检查：config 为 null/undefined 时使用空对象，避免解构 cfg.theme 等时报错
      // 场景：Agent 未完全就绪时 getConfig 可能返回 { config: null }
      const safeCfg = cfg ?? {};

      const formConfig: SpriteConfigForm = {
        // 主题字段：safeCfg.theme 可选（SpriteConfig），fallback 到 'light'。
        // 主题即时生效（renderer.ts onThemeChange 单独持久化），此处仅回显到表单单选按钮
        theme: safeCfg.theme === 'dark' ? 'dark' : 'light',
        // ADR-015 归档模式：safeCfg.archiveMode 可选（SpriteConfig），fallback 到 'full'。
        // 归档模式即时生效（onArchiveModeChange 单独持久化），此处仅回显到表单单选按钮
        archiveMode: safeCfg.archiveMode ?? 'full',
        silentMode: Boolean(safeCfg.silentMode),
        proactiveThreshold: Number(safeCfg.proactiveThreshold) || 3,
        proactiveCooldownMs: Number(safeCfg.proactiveCooldownMs) || 300_000,
        triggerIntervalMs: Number(safeCfg.triggerIntervalMs) || MS_PER_HOUR,
        fileWatcherEnabled: Boolean(safeCfg.fileWatcherEnabled),
        fileWatcherPaths: Array.isArray(safeCfg.fileWatcherPaths) ? safeCfg.fileWatcherPaths : ['.'],
        fileWatcherDebounceMs: Number(safeCfg.fileWatcherDebounceMs) || 1000,
        /** 文件监听忽略模式（glob 列表，可选） */
        fileWatcherIgnore: Array.isArray(safeCfg.fileWatcherIgnore) ? safeCfg.fileWatcherIgnore : ['**/node_modules/**', '**/.git/**'],
        defaultPersona: String(safeCfg.defaultPersona ?? ''),
        // 项目模式字段
        projectMode: safeCfg.projectMode === 'focus' ? 'focus' : 'smart',
        focusProjectPath: String(safeCfg.focusProjectPath ?? ''),
        // Phase 3.3 快捷键配置：safeCfg.shortcuts 已由主进程保证完整（SpriteConfigForm 必填）
        shortcuts: safeCfg.shortcuts ?? DEFAULT_SHORTCUTS,
      };

      uiManager.loadConfigToForm(formConfig);
      // 加载成功时隐藏之前的错误横幅
      uiManager.hideSettingsError();

      // 静默模式恢复检查：若 expiresAt 已过期，自动关闭静默模式
      if (safeCfg.silentMode && safeCfg.silentModeExpiresAt) {
        const expiresAt = new Date(safeCfg.silentModeExpiresAt).getTime();
        // 无效日期（NaN）时视为已过期，避免 setTimeout(fn, NaN) 立即触发错误关闭静默模式
        if (Number.isNaN(expiresAt) || Date.now() >= expiresAt) {
          await window.electronAPI.updateConfig('silentMode', false);
          await window.electronAPI.updateConfig('silentModeExpiresAt', null);
          uiManager.showToast('静默模式已到期自动恢复', 'info');
        } else {
          // 未过期：通知 renderer 重建本地恢复定时器（剩余时间）
          silentRecoveryCallback?.(expiresAt - Date.now());
        }
      }

      // 加载项目列表到专注项目下拉框
      try {
        const { projects } = await window.electronAPI.listProjects();
        uiManager.loadProjectsToForm(projects, formConfig.focusProjectPath);
      } catch (error) {
        reportError('loadConfig-projects', error);
      }

      // 程序化设置表单值会触发 input/change 事件，重置 dirty 标志
      uiManager.resetSettingsFormDirty();
    } catch (error) {
      reportError('loadConfig', error);
      // 显示错误状态，用户可点击重试
      uiManager.showSettingsError('加载精灵配置失败，请检查日志或点击重试', () => {
        void loadConfig();
      });
    }
  }

  /**
   * 加载 LLM 配置（Provider 列表 + Embedding 配置）
   *
   * Provider 列表由 SettingsPanelManager.loadProviderList 内部在 initListeners 时加载，
   * 此处仅负责加载 Embedding 配置到表单。
   */
  async function loadLlmConfig(): Promise<void> {
    try {
      const data = await window.electronAPI.getLlmConfig();
      // Provider 列表由 SettingsPanelManager 自行加载，此处仅加载 Embedding 配置
      uiManager.loadEmbeddingConfig(data);
      uiManager.hideSettingsError();
      uiManager.resetSettingsFormDirty();
    } catch (error) {
      reportError('loadLlmConfig', error);
      uiManager.showSettingsError('加载 LLM 配置失败，请检查日志或点击重试', () => {
        void loadLlmConfig();
      });
    }
  }

  /**
   * 加载用户画像到设置面板
   *
   * 调用 uiManager.loadUserProfile 代理到 ProfilePanelManager，
   * 从主进程拉取已确认 + 待确认画像条目并渲染到"画像"tab。
   * 失败时由 ProfilePanelManager 内部处理错误提示，不阻塞其他面板功能。
   */
  async function loadUserProfile(): Promise<void> {
    try {
      await uiManager.loadUserProfile();
    } catch (error) {
      reportError('loadUserProfile', error);
    }
  }

  /**
   * 加载作品投影数据到设置面板
   *
   * 调用 uiManager.loadWorkProjections 代理到 WorkProjectionPanelManager，
   * 从主进程拉取所有作品投影条目并渲染到"作品"tab。
   * 失败时由 WorkProjectionPanelManager 内部处理错误提示，不阻塞其他面板功能。
   */
  async function loadWorkProjections(): Promise<void> {
    try {
      await uiManager.loadWorkProjections();
    } catch (error) {
      reportError('loadWorkProjections', error);
    }
  }

  /**
   * M2 加载审计日志数据到设置面板
   *
   * 调用 uiManager.loadAuditLog 代理到 AuditPanelManager，
   * 从主进程拉取最近的审计条目并渲染到"审计"tab。
   * 失败时由 AuditPanelManager 内部处理错误提示，不阻塞其他面板功能。
   */
  async function loadAuditLog(): Promise<void> {
    try {
      await uiManager.loadAuditLog();
    } catch (error) {
      reportError('loadAuditLog', error);
    }
  }

  /**
   * 更新 Agent 连接状态指示器
   *
   * 委托给 SettingsPanelManager 更新设置面板顶部的状态指示器。
   *
   * @param status Agent 连接状态（ready/error/unknown）
   * @param message 可选的状态描述文本
   */
  function updateAgentStatus(status: 'ready' | 'error' | 'unknown', message?: string): void {
    uiManager.updateAgentStatusIndicator(status, message);
  }

  return {
    setupSettingsPanel,
    loadConfig,
    loadLlmConfig,
    loadUserProfile,
    loadWorkProjections,
    loadAuditLog,
    updateAgentStatus,
    /** 暴露静默恢复回调注册方法，代替模块级导出函数 */
    setSilentRecoveryCallback,
  };
}
