/**
 * 设置控制器 — 设置面板业务逻辑
 *
 * 职责：
 * - 设置精灵配置保存回调（QC-CONFIG-01：批量事务性更新）
 * - 设置 LLM 配置保存回调（触发主进程重新初始化 Agent）
 * - 设置 LLM 连接测试回调
 * - 设置取消回调（重新加载配置）
 * - 加载精灵配置和 LLM 配置到表单
 *
 * 设计原则：
 * - 接收 UIManager 实例，不持有模块级状态
 * - FD-08 进行中反馈：保存/测试时禁用按钮防止重复点击
 * - FD-A2 加载失败时显示错误横幅，提供重试按钮
 * - FD-07 程序化设置表单值后重置 dirty 标志
 */

import type { UIManager } from '../ui.js';
import type { SpriteConfigForm } from '../types.js';
import { createIpcErrorHandler, toError, reportError } from '../helpers/errorHelpers.js';
import { setButtonLoading } from '../helpers/domHelpers.js';

/** QC-STATE-01 silentRecoveryCallback 位于 createSettingsController 闭包内 */

/** 默认快捷键配置（cfg.shortcuts 缺失时的 fallback，与 DEFAULT_SPRITE_CONFIG.shortcuts 对齐） */
const DEFAULT_SHORTCUTS = {
  enabled: true,
  accelerators: {
    'toggle-window': 'Ctrl+Shift+Space',
    'quick-record': 'Ctrl+Shift+M',
    'recall-memory': 'Ctrl+Shift+R',
  },
};

/**
 * 创建设置控制器
 *
 * @param uiManager UI 管理器实例
 * @returns 设置控制器接口（设置回调、加载配置）
 */
export function createSettingsController(uiManager: UIManager) {
  /** IPC 错误处理函数（绑定 uiManager） */
  const handleIpcError = createIpcErrorHandler(uiManager);

  /** QC-STATE-01 静默恢复回调位于闭包内，避免模块级状态违反"不持有模块级状态"原则 */
  let silentRecoveryCallback: ((remainingMs: number) => void) | null = null;

  /** FD-10 注册静默恢复回调（由 renderer.ts 调用） */
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
      // FD-08 进行中反馈：禁用保存按钮防止重复点击
      setButtonLoading('btn-settings-save', true, '保存中...');
      try {
        // QC-CONFIG-01：单次 IPC 批量更新（事务性：原子性 + 单次持久化 + 副作用去重）
        // 替代原 10 次串行 updateConfig 调用，避免半更新状态和 N 次 writeFileSync
        const result = await window.electronAPI.updateConfigBatch({
          silentMode: config.silentMode,
          proactiveThreshold: config.proactiveThreshold,
          proactiveCooldownMs: config.proactiveCooldownMs,
          triggerIntervalMs: config.triggerIntervalMs,
          fileWatcherEnabled: config.fileWatcherEnabled,
          fileWatcherPaths: config.fileWatcherPaths,
          fileWatcherDebounceMs: config.fileWatcherDebounceMs,
          defaultPersona: config.defaultPersona,
          // FD-04 项目模式：路径与模式在同一事务内更新，避免中间态
          focusProjectPath: config.focusProjectPath,
          projectMode: config.projectMode,
        });

        if (result.updated) {
          // IX-06 操作反馈走 toast，不污染对话历史
          uiManager.showToast('精灵配置已保存', 'success');
        } else {
          // 事务回滚：主进程未应用任何更新，提示具体错误
          uiManager.showToast(`保存失败：${result.error ?? '未知错误'}`, 'error');
        }
      } catch (error) {
        handleIpcError('onConfigSave', error, '保存精灵配置失败');
      } finally {
        // FD-08 恢复按钮状态
        setButtonLoading('btn-settings-save', false);
      }
    });

    // LLM 配置保存：调用 saveLlmConfig 触发主进程重新初始化 Agent
    uiManager.onLlmConfigSave(async (payload) => {
      // 校验必填字段
      if (!payload.llm.provider || !payload.llm.model || !payload.llm.apiKey) {
        uiManager.showToast('LLM 配置不完整：提供商、模型、API Key 为必填项', 'warning');
        return;
      }

      // FD-08 进行中反馈：禁用保存按钮防止重复点击
      setButtonLoading('btn-settings-save', true, '初始化中...');
      try {
        // IX-06 进行中反馈走 toast（不自动消失，等结果出来后由成功/失败 toast 替换）
        // P2-FLOW-11 优化文案：明确告知用户正在初始化（耗时操作），避免用户以为卡住
        uiManager.showToast('正在保存配置并初始化 Agent（可能需要数秒）...', 'info', 0);

        const embeddingConfig = payload.embedding?.enabled
          ? {
              model: payload.embedding.model,
              baseUrl: payload.embedding.baseUrl || undefined,
              apiKey: payload.embedding.apiKey || undefined,
            }
          : undefined;

        const { success, error } = await window.electronAPI.saveLlmConfig(
          {
            provider: payload.llm.provider,
            model: payload.llm.model,
            baseUrl: payload.llm.baseUrl,
            apiKey: payload.llm.apiKey,
            temperature: payload.llm.temperature,
          },
          embeddingConfig,
        );

        if (success) {
          uiManager.showToast('LLM 配置已保存，Agent 已就绪', 'success');
        } else {
          uiManager.showToast(`初始化失败：${error}`, 'error');
          // 重新初始化失败后，主进程 agentReady=false，但渲染进程 isAgentReady 可能仍为 true
          // 主动查询 Agent 状态并同步，避免用户尝试对话时调用已关闭的 Agent
          try {
            const { ready, error: statusError } = await window.electronAPI.getAgentStatus();
            uiManager.setAgentReady(ready);
            updateAgentStatus(ready ? 'ready' : 'error', statusError ?? error ?? undefined);
          } catch (statusErr) {
            // 查询状态失败时也标记为未就绪，记录错误便于排查
            reportError('settingsController/agentStatus', statusErr);
            uiManager.setAgentReady(false);
            updateAgentStatus('error', error ?? undefined);
          }
        }
      } catch (error) {
        handleIpcError('onLlmConfigSave', error, '保存 LLM 配置失败');
      } finally {
        // FD-08 恢复按钮状态
        setButtonLoading('btn-settings-save', false);
      }
    });

    uiManager.onConfigCancel(() => {
      // 取消时重新加载配置
      void loadConfig();
      void loadLlmConfig();
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

    // LLM 连接测试：调用主进程验证配置，显示结果
    uiManager.onLlmTest(async () => {
      const config = uiManager.getLlmConfigFromForm();
      if (!config.provider || !config.model || !config.apiKey) {
        uiManager.showLlmTestResult({
          success: false,
          error: '提供商、模型、API Key 为必填项',
        });
        return;
      }

      // FD-08 进行中反馈：禁用测试按钮防止重复点击
      setButtonLoading('btn-llm-test', true, '测试中...');
      // 显示"测试中..."状态
      uiManager.showLlmTestResult({ success: false, error: '测试中...' });
      const startTime = Date.now();

      try {
        const result = await window.electronAPI.testLlmConfig(config);
        const elapsed = Date.now() - startTime;
        uiManager.showLlmTestResult(result, elapsed);
      } catch (error) {
        uiManager.showLlmTestResult({
          success: false,
          error: toError(error).message,
        });
      } finally {
        // FD-08 恢复按钮状态
        setButtonLoading('btn-llm-test', false);
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
        // UX-FD-12 主题字段：safeCfg.theme 可选（SpriteConfig），fallback 到 'light'。
        // 主题即时生效（renderer.ts onThemeChange 单独持久化），此处仅回显到表单单选按钮
        theme: safeCfg.theme === 'dark' ? 'dark' : 'light',
        // ADR-015 归档模式：safeCfg.archiveMode 可选（SpriteConfig），fallback 到 'full'。
        // 归档模式即时生效（onArchiveModeChange 单独持久化），此处仅回显到表单单选按钮
        archiveMode: safeCfg.archiveMode ?? 'full',
        silentMode: Boolean(safeCfg.silentMode),
        proactiveThreshold: Number(safeCfg.proactiveThreshold) || 3,
        proactiveCooldownMs: Number(safeCfg.proactiveCooldownMs) || 300_000,
        triggerIntervalMs: Number(safeCfg.triggerIntervalMs) || 3_600_000,
        fileWatcherEnabled: Boolean(safeCfg.fileWatcherEnabled),
        fileWatcherPaths: Array.isArray(safeCfg.fileWatcherPaths) ? safeCfg.fileWatcherPaths : ['.'],
        fileWatcherDebounceMs: Number(safeCfg.fileWatcherDebounceMs) || 1000,
        /** 缺口 II：文件监听忽略模式（glob 列表，可选） */
        fileWatcherIgnore: Array.isArray(safeCfg.fileWatcherIgnore) ? safeCfg.fileWatcherIgnore : ['**/node_modules/**', '**/.git/**'],
        defaultPersona: String(safeCfg.defaultPersona ?? ''),
        // FD-04 项目模式字段
        projectMode: safeCfg.projectMode === 'focus' ? 'focus' : 'smart',
        focusProjectPath: String(safeCfg.focusProjectPath ?? ''),
        // Phase 3.3 快捷键配置：safeCfg.shortcuts 已由主进程保证完整（SpriteConfigForm 必填）
        shortcuts: safeCfg.shortcuts ?? DEFAULT_SHORTCUTS,
      };

      uiManager.loadConfigToForm(formConfig);
      // FD-A2 加载成功时隐藏之前的错误横幅
      uiManager.hideSettingsError();

      // FD-10 静默模式恢复检查：若 expiresAt 已过期，自动关闭静默模式
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

      // FD-04 加载项目列表到专注项目下拉框
      try {
        const { projects } = await window.electronAPI.listProjects();
        uiManager.loadProjectsToForm(projects, formConfig.focusProjectPath);
      } catch (error) {
        reportError('loadConfig-projects', error);
      }

      // FD-07 程序化设置表单值会触发 input/change 事件，重置 dirty 标志
      uiManager.resetSettingsFormDirty();
    } catch (error) {
      reportError('loadConfig', error);
      // FD-A2 显示错误状态，用户可点击重试
      uiManager.showSettingsError('加载精灵配置失败，请检查日志或点击重试', () => {
        void loadConfig();
      });
    }
  }

  /** 加载 LLM 配置到表单 */
  async function loadLlmConfig(): Promise<void> {
    try {
      const data = await window.electronAPI.getLlmConfig();
      uiManager.loadLlmConfigToForm(data);
      // FD-A2 加载成功时隐藏之前的错误横幅
      uiManager.hideSettingsError();
      // FD-07 程序化设置表单值会触发 input/change 事件，重置 dirty 标志
      uiManager.resetSettingsFormDirty();
    } catch (error) {
      reportError('loadLlmConfig', error);
      // FD-A2 显示错误状态，用户可点击重试
      uiManager.showSettingsError('加载 LLM 配置失败，请检查日志或点击重试', () => {
        void loadLlmConfig();
      });
    }
  }

  /**
   * H2 加载用户画像到设置面板
   *
   * 调用 uiManager.loadUserProfile 代理到 ProfilePanelManager，
   * 从主进程拉取已确认 + 待确认画像条目并渲染到"画像"tab。
   * 失败时由 ProfilePanelManager 内部处理错误提示，不阻塞其他面板功能。
   */
  async function loadUserProfile(): Promise<void> {
    try {
      await uiManager.loadUserProfile();
      // H3 画像加载完成后更新学习进度卡片
      uiManager.updateLearningProgress();
    } catch (error) {
      reportError('loadUserProfile', error);
    }
  }

  /**
   * H3 加载作品投影数据到设置面板
   *
   * 调用 uiManager.loadWorkProjections 代理到 WorkProjectionPanelManager，
   * 从主进程拉取所有作品投影条目并渲染到"作品"tab。
   * 失败时由 WorkProjectionPanelManager 内部处理错误提示，不阻塞其他面板功能。
   */
  async function loadWorkProjections(): Promise<void> {
    try {
      await uiManager.loadWorkProjections();
      // H3 作品投影加载完成后更新学习进度卡片
      uiManager.updateLearningProgress();
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
   * P3-FLOW-10 更新 Agent 连接状态指示器
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
    /** QC-STATE-01 暴露静默恢复回调注册方法，替代原模块级导出函数 */
    setSilentRecoveryCallback,
  };
}
