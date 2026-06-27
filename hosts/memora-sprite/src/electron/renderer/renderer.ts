/**
 * 渲染进程入口 — 协调器
 *
 * 职责：
 * - 初始化 UI 管理器和各业务控制器
 * - 协调模块间依赖（IPC 监听器回调、控制器初始化顺序）
 * - 发送用户输入到主进程
 * - 页面卸载时清理资源
 *
 * 设计原则：
 * - 作为协调器，不包含具体业务逻辑（已拆分到各 controller 模块）
 * - 模块间通过回调解耦，避免循环依赖
 * - 保留 setupBusinessLogic（发送/停止/新建会话），因依赖 uiManager 和 sessionController
 */

import { UIManager } from './ui.js';
import { createSessionController } from './controllers/sessionController.js';
import { createMemoryController } from './controllers/memoryPanelController.js';
import { createPersonaController } from './controllers/personaPanelController.js';
import { createSettingsController } from './controllers/settingsController.js';
import { initIpcListeners } from './ipcListeners.js';
import { reportError } from './helpers/errorHelpers.js';
import { getLocalDate } from '../../sprite/constants.js';
import {
  createSilentRecoveryScheduler,
  showAgentInitError,
  showWelcomeMessage,
} from './initHelpers.js';

// P2-001 修复：删除重复的 declare global 和未使用的 ElectronAPI 导入。
// types.ts 已声明 window.electronAPI 全局类型，通过 ui.ts → types.js 间接加载。

// ─── 状态 ───────────────────────────────────────────────────

/** UI 管理器实例（模块级，DOMContentLoaded 后初始化） */
let uiManager: UIManager;

/** UX-PP-03 最后一条用户输入文本（用于流式错误重试） */
let lastUserInput: string = '';

/** 静默模式自动恢复时间（1 小时） */
const SILENT_RECOVERY_MS = 60 * 60 * 1000;

/** 静默模式定时恢复句柄（多次点击"静默 1 小时"时清理旧定时器，避免重复恢复） */
let silentRecoveryTimer: number | null = null;

/** Agent 初始化重试定时器句柄（beforeunload 时清理，避免操作已销毁的 DOM） */
let initRetryTimer: number | null = null;

/** Agent 就绪回调引用（初始化重试成功时复用，避免重复定义） */
let onAgentReadyCallback: (() => void) | null = null;

/** Bug 修复：Agent 就绪流程幂等标志，防止 IPC 事件与重试定时器竞态导致重复加载 */
let agentReadyHandled = false;

/** IX-03 记忆控制器实例（模块级，beforeunload 时清理脉冲定时器） */
let memoryControllerRef: ReturnType<typeof createMemoryController> | null = null;

// ─── 初始化 ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 UI 管理器
  uiManager = new UIManager();

  // 创建各业务控制器（接收 uiManager 实例，通过闭包绑定）
  const sessionController = createSessionController(uiManager);
  const memoryController = createMemoryController(uiManager);
  memoryControllerRef = memoryController;
  const personaController = createPersonaController(uiManager);
  const settingsController = createSettingsController(uiManager);

  // 设置业务逻辑回调
  setupBusinessLogic(uiManager, sessionController);
  memoryController.setupMemoryPanel();
  personaController.setupPersonaSelector();

  // ─── 初始化辅助函数（从 initHelpers.ts 导入，闭包访问 uiManager/controllers） ───

  /** 静默模式恢复定时器 ref（由 createSilentRecoveryScheduler 闭包持有） */
  const silentTimerRef = { current: silentRecoveryTimer };
  const scheduleSilentRecovery = createSilentRecoveryScheduler(uiManager, silentTimerRef);
  // 同步 timerRef 回模块级变量，供 beforeunload 清理
  const syncTimerRef = () => { silentRecoveryTimer = silentTimerRef.current; };
  const originalSchedule = scheduleSilentRecovery;
  const wrappedSchedule = (ms: number) => { originalSchedule(ms); syncTimerRef(); };

  // FD-10 注册静默恢复回调：启动时若静默模式未过期，重建本地定时器
  // QC-STATE-01 修复：改用控制器方法替代原模块级导出函数
  settingsController.setSilentRecoveryCallback(wrappedSchedule);

  settingsController.setupSettingsPanel();

  // P1 修复：提前赋值 onAgentReadyCallback，确保 Agent 在渲染进程启动前就已就绪时也能正确调用
  // 原代码通过 ?? 惰性赋值（在 onAgentReady IPC 回调中），当 IPC 事件已错过时 callback 为 null，
  // 导致 else 分支不调用 setAgentReady(true) 和 updateAgentStatus('ready')，
  // 用户无法发送消息且状态指示器停留在"正在初始化..."
  onAgentReadyCallback = () => {
    // Bug 修复：幂等保护，防止 IPC 事件与重试定时器竞态导致重复加载
    if (agentReadyHandled) return;
    agentReadyHandled = true;
    // UX-P2-03 标记 Agent 就绪，解除发送消息限制
    uiManager.setAgentReady(true);
    // P3-FLOW-10 同步设置面板状态指示器（修复：IPC 事件路径遗漏更新状态指示器）
    settingsController.updateAgentStatus('ready', 'Agent 已就绪');
    void sessionController.loadSessionHistory();
    // FD-A1 会话列表加载已移除（方案 B：时间流式 UI，不再需要会话切换下拉）
    void memoryController.loadMemoryList();
    void personaController.loadPersonaList();
    void memoryController.loadDashboard();
    // 首次使用流程：Agent 就绪后自动切换到对话面板，让用户立即开始对话
    void uiManager.switchPanel('chat');
    // P2 修复：首次配置完成后检查是否需要显示三态引导
    if (uiManager.shouldShowOnboarding()) {
      uiManager.showOnboardingDialog();
    }
  };

  // UX-FD-12 从 IPC 读取主题配置（真理源为 sprite.json），localStorage 仅作为内联脚本缓存
  // 内联脚本（index.html / float.html）已通过 localStorage 设置了 data-theme 属性（避免页面闪烁），
  // 此处以 sprite.json 为准进行修正，并处理首次迁移（localStorage → sprite.json）
  try {
    const { config } = await window.electronAPI.getConfig();
    if (config.theme) {
      // sprite.json 中有主题配置，以它为准（覆盖 localStorage 缓存，确保一致性）
      // P3-FLOW-12 config.theme 可能为 'auto'，由 ThemeManager 处理实际主题选择
      const currentMode = uiManager.getThemeMode();
      if (config.theme !== currentMode) {
        uiManager.setTheme(config.theme);
      }
    } else {
      // sprite.json 中无主题配置（v1→v2 迁移前或首次使用），从 localStorage 迁移
      try {
        const cachedTheme = localStorage.getItem('memora-theme');
        if (cachedTheme === 'dark' || cachedTheme === 'light') {
          // 迁移：将 localStorage 中的主题写入 sprite.json
          await window.electronAPI.updateConfig('theme', cachedTheme);
        }
      } catch {
        // localStorage 不可用时静默降级
      }
    }
  } catch {
    // IPC 不可用时静默降级，使用 localStorage 缓存的主题（内联脚本已设置）
  }

  // ADR-SP-008 同步设置面板单选按钮状态
  // P3-FLOW-12 使用 getThemeMode 同步三态单选按钮（light/dark/auto）
  uiManager.syncThemeRadios(uiManager.getThemeMode());

  uiManager.onThemeChange((theme, source) => {
    // QC-THEME-01 修复：区分"用户主动切换"与"系统主题变化"
    // source='user'：用户在设置面板主动切换，需持久化到 sprite.json（真理源）
    // source='system'：auto 模式下系统主题变化，仅同步浮动窗口，不覆盖 sprite.json 中的 'auto'
    if (source === 'user') {
      window.electronAPI.updateConfig('theme', theme);
    }
    // UX-P2-10 两种场景都需要通知主进程同步到浮动窗口，避免两个窗口主题不一致
    window.electronAPI.notifyThemeChanged(theme);
  });

  // UX-PP-05 流式错误重试：重新发送上一条用户消息
  // 提取为独立函数，供气泡内 onErrorRetry 复用（UX-PP-13 后 Toast 不再携带重试按钮）
  const retryLastUserInput = (): void => {
    if (!lastUserInput) return;
    // P2 修复：重试前检查流式状态，避免流式输出中重复发送
    if (uiManager.isStreaming()) {
      uiManager.showToast('请先停止当前回复再重试', 'warning');
      return;
    }
    // 重新显示用户消息并发送
    uiManager.appendMessage({
      role: 'user',
      content: lastUserInput,
    });
    window.electronAPI.sendUserInput(lastUserInput);
  };

  // 初始化 IPC 监听器（统一注册，通过回调解耦业务逻辑）
  initIpcListeners(uiManager, {
    // 精灵事件：记忆被注意 / 洞察获得 → 仪表盘计数 +1 动画 + 刷新仪表盘
    // QC-PERF-01：事件密集触发时使用防抖版 loadDashboard，避免频繁 IPC + DOM 操作
    onMemoryNoticed: () => {
      memoryController.pulseCounter('memory-count');
      void memoryController.loadDashboardDebounced();
    },
    onInsightGained: () => {
      memoryController.pulseCounter('insight-count');
      void memoryController.loadDashboardDebounced();
    },
    // Agent 就绪：加载初始数据 + 切换到对话面板
    onAgentReady: () => {
      // Bug 修复：IPC 事件到达时取消挂起的重试定时器，避免两条路径都触发
      if (initRetryTimer !== null) {
        window.clearTimeout(initRetryTimer);
        initRetryTimer = null;
      }
      // P1 修复：onAgentReadyCallback 已在初始化阶段提前赋值，直接调用即可
      onAgentReadyCallback?.();
    },
    // 对话结束：立即刷新仪表盘获取最新 LLM 指标，延迟二次刷新等待异步归档完成
    onConversationEnd: () => {
      // 立即刷新：LLM 调用次数、token 数、工具使用等指标在对话结束时已确定
      void memoryController.loadDashboard();
      // 延迟 1s 二次刷新：postProcess 中的记忆归档是异步 fire-and-forget 的，
      // 等待用户画像归档、Insight 提取等后台任务完成后再刷新一次
      window.setTimeout(() => {
        void memoryController.loadDashboard();
      }, 1000);
    },
  });

  // UX-PP-05 注册气泡内错误重试回调（复用 retryLastUserInput，供错误气泡内"重试"按钮调用）
  // UX-PP-13 后 Toast 不再携带重试按钮，气泡内重试为唯一主通道
  uiManager.onErrorRetry(retryLastUserInput);

  // 初始化主动提示 banner 按钮（查看/稍后/静默）
  uiManager.initProactiveBannerButtons({
    onView: () => {
      // 已在对话面板内，仅确保面板可见
      void uiManager.switchPanel('chat');
    },
    onLater: () => {
      // banner 已隐藏，无需额外操作
    },
    onSilent: () => {
      // 通知主进程进入静默模式
      void window.electronAPI.updateConfig('silentMode', true);
      // FD-10 持久化恢复时间，页面刷新后也能正确恢复
      const expiresAt = new Date(Date.now() + SILENT_RECOVERY_MS).toISOString();
      void window.electronAPI.updateConfig('silentModeExpiresAt', expiresAt);
      // IX-06 操作反馈走 toast（静默模式是用户主动触发的状态变更）
      uiManager.showToast('已进入静默模式，精灵 1 小时内不会主动提示（到期自动恢复）', 'info');
      // 设置本地定时器：1 小时后自动关闭静默模式（复用 wrappedSchedule 统一逻辑）
      wrappedSchedule(SILENT_RECOVERY_MS);
    },
    // P3-FLOW-08 不再提醒：进入静默模式并提示用户去设置调整阈值
    onDisable: () => {
      void window.electronAPI.updateConfig('silentMode', true);
      // 设置一个较长的恢复时间（24 小时），等效于"不再提醒"
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      void window.electronAPI.updateConfig('silentModeExpiresAt', expiresAt);
      uiManager.showToast('已关闭主动提示（24 小时内不再提醒）。如需恢复，请到设置面板调整主动提示阈值', 'info');
    },
  });

  // 召回记忆点击：跳转到记忆面板并显示详情
  uiManager.onMemoryRecallClick(async (memoryName) => {
    await uiManager.switchPanel('memories');
    // FD-ADD-RECALL-CONTEXT：预填搜索框 + 触发搜索，让弹窗背后的列表同步显示对应记忆
    // 用户关闭详情弹窗后，列表已过滤好，无需手动搜索
    const searchInput = document.getElementById('memory-search') as HTMLInputElement | null;
    if (searchInput) {
      searchInput.value = memoryName;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      const { memory } = await window.electronAPI.showMemory(memoryName);
      if (memory) {
        uiManager.showMemoryDetail(memory);
      }
    } catch (error) {
      // 记忆可能已删除，记录日志辅助排查
      reportError('memoryRecall', error);
    }
  });

  // FD-ADD-MEMORY-DISCUSS 记忆→对话双向流动：关闭详情弹窗 → 切换到对话面板 → 预填讨论提示
  uiManager.onMemoryDiscuss((memoryName) => {
    uiManager.hideModal('memory-detail-modal');
    // 先预填输入框，再切换面板（switchPanel('chat') 会自动聚焦输入框）
    uiManager.prefillChatInput(`关于「${memoryName}」…`);
    void uiManager.switchPanel('chat');
  });

  // ─── Phase 4.3 第二批：技能文件拖入安装初始化 ──────────────
  // 注册安装成功回调：刷新仪表盘技能列表 + 计数
  uiManager.onSkillInstalled(() => {
    void memoryController.loadDashboard();
  });
  // 初始化 dropzone 事件监听（dragover/drop/click/change）
  setupSkillDropzone(uiManager);

  // 加载 LLM 配置到设置面板（无论 Agent 是否就绪都加载）
  await settingsController.loadLlmConfig();

  // 检查 Agent 是否就绪
  try {
    const { ready, error } = await window.electronAPI.getAgentStatus();
    // P3-FLOW-10 更新设置面板 Agent 连接状态指示器
    settingsController.updateAgentStatus(ready ? 'ready' : 'error', error ?? undefined);
    if (!ready) {
      // 三种状态：配置缺失 / 初始化失败 / 初始化中
      // 初始化中（error 为 null）：Agent 正在启动，延迟重试而非显示错误
      if (!error) {
        settingsController.updateAgentStatus('unknown', '正在初始化...');
        // P1 修复：提取为可递归的重试函数，避免状态永久停留在"正在初始化..."
        // 原代码仅重试一次，若 retry.ready=false 且 retry.error=null 则什么都不做
        const MAX_INIT_RETRIES = 5; // 最多重试 5 次（共 10 秒）
        const retryAgentStatus = (attempt: number): void => {
          initRetryTimer = window.setTimeout(async () => {
            try {
              const retry = await window.electronAPI.getAgentStatus();
              if (retry.ready) {
                initRetryTimer = null;
                // onAgentReadyCallback 内部会更新状态指示器（幂等保护）
                onAgentReadyCallback?.();
              } else if (retry.error) {
                // 初始化失败，显示具体错误（复用 showAgentInitError 统一处理）
                initRetryTimer = null;
                showAgentInitError(uiManager, settingsController, retry.error);
              } else if (attempt < MAX_INIT_RETRIES) {
                // 仍在初始化中，继续重试
                retryAgentStatus(attempt + 1);
              } else {
                // 超过最大重试次数，显示超时错误
                initRetryTimer = null;
                settingsController.updateAgentStatus('error', 'Agent 初始化超时');
                uiManager.showToast('Agent 初始化超时，请尝试重启应用', 'error');
              }
            } catch (retryErr) {
              // 重试查询失败，未达上限时继续重试，debug 级别避免日志噪音
              reportError('init/agentStatusRetry', retryErr);
              if (attempt < MAX_INIT_RETRIES) {
                retryAgentStatus(attempt + 1);
              } else {
                initRetryTimer = null;
                settingsController.updateAgentStatus('error', 'Agent 状态查询失败');
              }
            }
          }, 2000);
        };
        retryAgentStatus(1);
        await settingsController.loadConfig();
        return;
      }
      // 区分错误来源：配置缺失 vs 初始化失败
      const isConfigMissing = error.includes('配置不完整') || error.includes('API Key');
      if (isConfigMissing) {
        // 首次启动引导：显示欢迎消息 + 跳转设置面板
        showWelcomeMessage(uiManager);
        void uiManager.switchPanel('settings');
        await settingsController.loadConfig();
      } else {
        // 初始化失败：显示错误 + 重试按钮 + 跳转设置面板（复用 showAgentInitError 统一处理）
        showAgentInitError(uiManager, settingsController, error);
      }
      return;
    }
  } catch (err) {
    // agent-status 通道异常（主进程未就绪或网络错误），降级为首次使用引导
    reportError('init/agent-status', err);
    // P3-FLOW-10 异常时状态指示器显示 unknown
    settingsController.updateAgentStatus('unknown', '检测中...');
    showWelcomeMessage(uiManager);
    void uiManager.switchPanel('settings');
    await settingsController.loadConfig();
    return;
  }

  // P1 修复：Agent 在渲染进程启动前就已就绪时，IPC 事件已错过，需在此主动触发就绪流程
  // onAgentReadyCallback 已在初始化阶段提前赋值（第 96 行），直接调用即可
  // （原 else 分支的防御性兜底已不需要，且原 else 分支遗漏 setAgentReady(true) 导致用户无法发送消息）
  onAgentReadyCallback();
  void settingsController.loadConfig();
  void memoryController.loadDashboard();
  // H2 预加载用户画像数据（用户切换到"画像"tab 时即可见）
  void settingsController.loadUserProfile();

  // 三态首次引导：Agent 就绪且首次使用时显示（介绍三态窗口模型 + 快捷键）
  // 使用 localStorage 标记，老用户不再显示
  if (uiManager.shouldShowOnboarding()) {
    uiManager.showOnboardingDialog();
  }
});

// ─── 清理资源 ─────────────────────────────────────────────

// 页面卸载时清理资源：UI 监听器 + IPC 监听器
// IPC 监听器若不清理，重新加载页面时会累积，导致同一事件触发多次
window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  // UI-AUDIT-P0-2.3: 设置面板有未保存修改时，阻止页面关闭/刷新
  // 防止用户意外丢失 LLM 配置（含 API Key）等关键数据
  if (uiManager?.getCurrentPanel() === 'settings' && uiManager.isSettingsDirty()) {
    e.preventDefault();
    // 现代浏览器要求设置 returnValue 才能触发确认对话框
    e.returnValue = '';
  }

  uiManager?.cleanup();
  // 清理静默模式恢复定时器，避免定时器触发时操作已销毁的 DOM 或产生未捕获 rejection
  if (silentRecoveryTimer !== null) {
    window.clearTimeout(silentRecoveryTimer);
    silentRecoveryTimer = null;
  }
  // 清理 Agent 初始化重试定时器（与 silentRecoveryTimer 同模式）
  if (initRetryTimer !== null) {
    window.clearTimeout(initRetryTimer);
    initRetryTimer = null;
  }
  // IX-03 清理脉冲动画定时器（避免操作已销毁的 DOM）
  memoryControllerRef?.cleanup();
  memoryControllerRef = null;
  // 清理 IPC 监听器（防止内存泄漏与重复触发）
  window.electronAPI?.removeStreamListeners();
  window.electronAPI?.removeSpriteOutputListener();
  window.electronAPI?.removeSpriteEventListener();
  window.electronAPI?.removeSpriteErrorListener();
  window.electronAPI?.removeAppErrorListener();
  window.electronAPI?.removeAgentReadyListener();
  window.electronAPI?.removeFloatUnreadListener();
  window.electronAPI?.removeWindowStateChangedListener();
  // H1 清理配置建议推送监听器
  window.electronAPI?.removeSuggestionPushListener();
  // 剪枝：补充清理写入确认监听器（原遗漏，防止内存泄漏）
  window.electronAPI?.removeWriteConfirmationListener();
  // Phase 3.1：清理剪贴板三重保护监听器
  window.electronAPI?.removeClipboardChangedListener();
  window.electronAPI?.removeClipboardSensitiveIgnoredListener();
  window.electronAPI?.removeClipboardAnalysisReadyListener();
  window.electronAPI?.removeClipboardAnalysisRejectedListener();
  // Phase 3.3 第二批：清理全局快捷键触发监听器
  window.electronAPI?.removeQuickRecordTriggerListener();
  window.electronAPI?.removeRecallMemoryTriggerListener();
});

// ─── 业务逻辑设置（发送/停止/新建会话） ─────────────────────

/**
 * 设置发送消息、停止消息、新建会话回调
 *
 * 这三个回调依赖 uiManager 和 sessionController，保留在 renderer.ts 中
 * 避免引入额外的模块间依赖。
 */
function setupBusinessLogic(
  uiManager: UIManager,
  sessionController: ReturnType<typeof createSessionController>,
): void {
  // 设置发送消息回调
  uiManager.onSendMessage(async () => {
    const text = uiManager.getUserInput();
    if (!text) return;

    // UX-PP-03 存储最后用户输入，用于流式错误重试
    lastUserInput = text;

    // P2-FLOW-09 跨天检测：当前查看的是历史日期时，确认后切换到今天的 main 会话
    const currentId = sessionController.getCurrentSessionId();
    if (currentId) {
      const todayPrefix = getLocalDate();
      const sessionDate = currentId.slice(0, 10);
      if (sessionDate !== todayPrefix) {
        // 弹出确认对话框，用户取消则阻止发送，停留在历史会话视图
        const confirmed = await uiManager.showConfirmDialog({
          title: '切换到今天的对话',
          message: `当前查看的是 ${sessionDate} 的历史对话，发送消息将切换到今天的新对话。`,
          confirmText: '切换并发送',
          cancelText: '取消',
        });
        if (!confirmed) return; // 用户取消：阻止发送
        const todaySessionId = `${todayPrefix}-main`;
        await sessionController.switchSession(todaySessionId);
      }
    }

    // 显示用户消息
    uiManager.appendMessage({
      role: 'user',
      content: text,
    });

    // 发送到主进程
    window.electronAPI.sendUserInput(text);
  });

  // 空状态示例问题回调：点击示例问题等同于用户输入并发送
  uiManager.onSuggestionClick((text) => {
    // IX-01 流式防护：流式输出中点击示例问题等同于重复发送，应阻止
    if (uiManager.isStreaming()) {
      uiManager.showToast('精灵正在回复中，请等待回复完成或点击停止', 'warning');
      return;
    }
    // UX-PP-03 存储最后用户输入，用于流式错误重试
    lastUserInput = text;
    // 显示用户消息
    uiManager.appendMessage({
      role: 'user',
      content: text,
    });
    // 发送到主进程
    window.electronAPI.sendUserInput(text);
  });

  // 设置停止消息回调
  // QC-FLOW-04 修复：不调用 stopAllStreaming()——它会同步清空 streamingMessages Map，
  // 导致主进程 abort 后异步发送的 SPRITE_STREAM_ABORTED 找不到消息元素，
  // 中断标记无法嵌入气泡。正确流程：abortChat() → 主进程中断 generator →
  // SPRITE_STREAM_ABORTED → markStreamingAborted（正确嵌入标记 + 清理状态）→
  // SPRITE_STREAM_END → finishStreamingMessage（添加复制按钮等收尾）。
  // stopAllStreaming() 保留给渲染进程超时兜底（onStreamStuck）使用，不用在用户主动停止路径。
  uiManager.onStopMessage(async () => {
    await window.electronAPI.abortChat();
  });

  // UX-FD-07 日期导航跳转回调：点击日期项后跳转到该日期的对话
  uiManager.onDateNavJump(async (date: string) => {
    try {
      await sessionController.jumpToDate(date);
      // 跳转后刷新日期列表（更新 active 高亮）
      const dates = await sessionController.loadDateList();
      const currentDate = sessionController.getCurrentSessionId().split('-').slice(0, 3).join('-');
      uiManager.renderDateNavList(dates, currentDate);
    } catch (error) {
      // FD-CONVERGE-01 日期跳转失败时 toast 提示并保持当前视图，避免静默破坏 UI 状态
      reportError('dateNavJump', error);
      uiManager.showToast('日期跳转失败，请稍后重试', 'error');
    }
  });

  // UX-FD-07 日期导航下拉打开时加载日期列表
  uiManager.onDateNavOpen(async () => {
    try {
      const dates = await sessionController.loadDateList();
      const currentDate = sessionController.getCurrentSessionId().split('-').slice(0, 3).join('-');
      uiManager.renderDateNavList(dates, currentDate);
    } catch (error) {
      // FD-CONVERGE-01 日期列表加载失败时静默降级，不阻塞用户继续对话
      reportError('dateNavOpen', error);
    }
  });

  // FD-A1 会话切换/删除/重命名回调已移除（方案 B：时间流式 UI，不再需要会话切换下拉）
}

// ─── Phase 4.3 第二批：技能文件拖入安装 dropzone 初始化 ──────

/**
 * 初始化技能拖入安装区域的事件监听
 *
 * 绑定以下事件：
 * - dragenter/dragover：添加 .is-dragover 类，反馈可接收
 * - dragleave/drop：移除 .is-dragover 类
 * - drop：提取 File[] 调用 uiManager.handleSkillDrop
 * - click：触发文件选择对话框（uiManager.handleSkillFileSelect）
 * - change：文件选择后触发，提取 File[] 调用 uiManager.handleSkillDrop
 * - keydown：Enter/Space 触发点击（支持键盘可访问性，tabindex=0）
 *
 * @param uiManager UI 管理器实例
 */
function setupSkillDropzone(uiManager: UIManager): void {
  const dropzone = document.getElementById('skill-dropzone');
  const fileInput = document.getElementById('skill-file-input') as HTMLInputElement | null;
  if (!dropzone) {
    // dropzone 不存在时静默降级（HTML 可能被裁剪）
    return;
  }

  // dragenter/dragover：阻止默认行为（禁止浏览器打开文件）+ 添加高亮类
  const handleDragOver = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('is-dragover');
  };

  // dragleave：移除高亮类（仅当离开 dropzone 本身时触发，避免子元素切换抖动）
  const handleDragLeave = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // relatedTarget 为 null 或不在 dropzone 内时才移除高亮
    const related = e.relatedTarget as Node | null;
    if (!related || !dropzone.contains(related)) {
      dropzone.classList.remove('is-dragover');
    }
  };

  // drop：提取文件 + 移除高亮 + 调用安装
  const handleDrop = (e: DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('is-dragover');
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      // FileList 转为数组传递
      const fileArray = Array.from(files);
      void uiManager.handleSkillDrop(fileArray);
    }
  };

  // click：触发文件选择对话框
  const handleClick = (): void => {
    uiManager.handleSkillFileSelect();
  };

  // keydown：Enter/Space 触发点击（键盘可访问性）
  const handleKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      uiManager.handleSkillFileSelect();
    }
  };

  // change：文件选择后触发
  const handleFileChange = (): void => {
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const fileArray = Array.from(fileInput.files);
      void uiManager.handleSkillDrop(fileArray);
      // 清空 input.value 允许重复选择同一文件（否则 change 事件不触发）
      fileInput.value = '';
    }
  };

  // 注册事件监听器（beforeunload 时由 uiManager.cleanup 统一清理？）
  // 注意：dropzone 事件不通过 EventTracker 管理，因为 setupSkillDropzone 在
  // DOMContentLoaded 内调用，且 dropzone 元素随页面卸载自动销毁。
  // 若未来需要更精细的清理，可改为 EventTracker 模式。
  dropzone.addEventListener('dragenter', handleDragOver);
  dropzone.addEventListener('dragover', handleDragOver);
  dropzone.addEventListener('dragleave', handleDragLeave);
  dropzone.addEventListener('drop', handleDrop);
  dropzone.addEventListener('click', handleClick);
  dropzone.addEventListener('keydown', handleKeydown);
  if (fileInput) {
    fileInput.addEventListener('change', handleFileChange);
  }
}
