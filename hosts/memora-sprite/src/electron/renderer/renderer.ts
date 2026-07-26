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
 * - 保留 setupBusinessLogic（发送/停止/会话管理），因依赖 State.uiManager 和 sessionController
 */

import { UIManager } from './ui.js';
import { createSessionController } from './controllers/sessionController.js';
import { createMemoryController } from './controllers/memoryController.js';
import { createPersonaController } from './controllers/personaController.js';
import { createSettingsController } from './controllers/settingsController.js';
import { initIpcListeners, consumeConflictTargetId } from './ipcListeners.js';
import { reportError } from './helpers/errorHelpers.js';
// setButtonLoading 按钮异步操作 loading 状态（B7：forkBtn 异步反馈）
import { setButtonLoading } from './helpers/domHelpers.js';
// formatErrorMessage 错误文案真理源（UX-14：替代 "XXX失败，请重试" 模板化文案）
import { formatErrorMessage } from '../../shared/errorMessages.js';
import { EventTracker } from './helpers/eventTracker.js';
// safeStorage 统一 localStorage 读写（ADR-017 枝叶层 2 次提取，字符串场景）
import { safeGet } from './helpers/safeStorage.js';
// timeRefresher 全局相对时间刷新器（窗口恢复焦点/可见时刷新所有 data-timestamp 元素）
import { timeRefresher } from './helpers/timeRefresher.js';
// 补全统计埋点（R1 激活率分母：用户发送对话时记录 chat-turn 事件）
import { getCompletionMetrics } from './helpers/completionMetrics.js';
import { getLocalDate, MS_PER_HOUR, MS_PER_DAY, TOAST_LONG_MS } from '../../sprite/constants.js';
import {
  createSilentRecoveryScheduler,
  showAgentInitError,
  showWelcomeMessage,
} from './initHelpers.js';

// types.ts 已声明 window.electronAPI 全局类型，通过 ui.ts → types.js 间接加载。

// ─── 状态（模块级变量封装为 State 对象） ───

/** 渲染进程核心状态（集中管理，避免全局作用域污染） */
const State = {
  /** UI 管理器实例（DOMContentLoaded 中初始化，beforeunload 前始终可用） */
  uiManager: null! as UIManager,
  /** 最后一条用户输入文本（用于流式错误重试） */
  lastUserInput: '' as string,
  /** 静默模式定时恢复句柄 */
  silentRecoveryTimer: null as number | null,
  /** Agent 初始化重试定时器句柄 */
  initRetryTimer: null as number | null,
  /** Agent 就绪回调引用 */
  onAgentReadyCallback: null as (() => void) | null,
  /** Agent 就绪流程幂等标志 */
  agentReadyHandled: false as boolean,
  /** 记忆控制器实例 */
  memoryController: null as ReturnType<typeof createMemoryController> | null,
  /**
   * 渲染进程级事件跟踪器（统一管理 renderer.ts 直接注册的事件监听器）
   *
   * 职责：跟踪 forkBtn/dropzone 等页面级元素的事件监听器，beforeunload 时统一清理。
   * 与 UIManager 内部的 private events 分离，避免破坏 UIManager 封装性。
   * 符合项目 EventTracker 统一抽象范式（所有面板均通过 EventTracker 注册事件）。
   */
  events: new EventTracker(),
};

/** 静默模式指示器定时器（新枝破土，模块级供 beforeunload 清理） */
let silentIndicatorTimer: ReturnType<typeof setInterval> | null = null;

/** 静默模式自动恢复时间（1 小时，使用 MS_PER_HOUR 常量统一时间单位） */
const SILENT_RECOVERY_MS = MS_PER_HOUR;

// ─── 初始化 ────────────────────────────────────────────────

/**
 * 渲染进程启动主流程（提取为独立 async 函数，便于统一捕获异常）
 *
 * 原内联在 DOMContentLoaded async 回调中，异常会变成 unhandled rejection 导致 UI 空白。
 * 提取后由 DOMContentLoaded 监听器调用，并通过 .catch() 兜底显示错误提示。
 */
async function bootstrapRenderer(): Promise<void> {
  // 初始化 UI 管理器
  State.uiManager = new UIManager();

  // 启动全局相对时间刷新器：窗口恢复焦点/可见时刷新所有 data-timestamp 元素，
  // 解决"复制后很长时间仍显示'刚刚'"的问题。beforeunload 时统一清理。
  timeRefresher.start();

  // 创建各业务控制器（接收 State.uiManager 实例，通过闭包绑定）
  const sessionController = createSessionController(State.uiManager);
  // 注入会话 ID 提供者，供 ChatPanelManager 的一键归档按钮使用
  State.uiManager.setCurrentSessionIdProvider(() => sessionController.getCurrentSessionId());
  const memoryController = createMemoryController(State.uiManager);
  State.memoryController = memoryController;
  const personaController = createPersonaController(State.uiManager);
  const settingsController = createSettingsController(State.uiManager);

  // 设置业务逻辑回调
  setupBusinessLogic(State.uiManager, sessionController);
  memoryController.setupMemoryPanel();
  personaController.setupPersonaSelector();
  // 设置面板 setup 提前到与其他面板同一位置，避免前置异常导致设置面板无事件监听
  // setupSettingsPanel 仅注册 UI 事件回调（onConfigSave 等），不依赖 setSilentRecoveryCallback
  settingsController.setupSettingsPanel();

  // 精灵设定面板 - 持久化回调注册（与 settingsController.setupSettingsPanel 同模式）
  // 角色匹配模式 / 默认角色即时持久化，不走保存按钮（与主题、归档模式同模式）
  // R4 迁移后 personaMode 持久化统一由 settingsManagerPanel.onPersonaModeChange 负责，
  // personaController 已退出该职责（仅保留 onPersonaSwitch + loadPersonaList），避免双面板竞争。
  State.uiManager.settingsManagerPanel.onPersonaModeChange(async (mode) => {
    // 回调触发时 settingsManagerPanel 已乐观更新 currentPersonaMode + badge 为新模式，
    // 需在 IPC 调用前保存旧模式用于失败回滚（乐观更新 + 失败回滚模式）
    const previousMode = mode === 'manual' ? 'auto' : 'manual';
    try {
      const { set } = await window.electronAPI.setPersonaMode(mode);
      if (set) {
        // IPC 成功：badge 已在 radio change 时乐观更新，此处保持幂等同步
        State.uiManager.updatePersonaModeBadge(mode);
        State.uiManager.showToast(`角色匹配模式已切换为：${mode === 'auto' ? '自动' : '手动'}`, 'success');
      } else {
        // IPC 拒绝切换：回滚 radio + badge 到旧模式（badge 回滚不可遗漏，否则顶栏与 radio 不一致）
        State.uiManager.updatePersonaModeBadge(previousMode);
        State.uiManager.settingsManagerPanel.setPersonaMode(previousMode);
        State.uiManager.showToast('角色匹配模式切换失败', 'error');
      }
    } catch (error) {
      // IPC 异常：回滚 radio + badge 到旧模式
      State.uiManager.updatePersonaModeBadge(previousMode);
      State.uiManager.settingsManagerPanel.setPersonaMode(previousMode);
      reportError('sprite-settings.onPersonaModeChange', error);
      State.uiManager.showToast(formatErrorMessage('设置角色模式', error), 'error');
    }
  });
  State.uiManager.settingsManagerPanel.onDefaultPersonaChange(async (value) => {
    try {
      await window.electronAPI.updateConfig('defaultPersona', value);
    } catch (error) {
      reportError('sprite-settings.onDefaultPersonaChange', error);
      State.uiManager.showToast(formatErrorMessage('保存默认角色', error), 'error');
    }
  });

  // 面板切换时刷新数据
  State.uiManager.onPanelSwitch((panel) => {
    if (panel === 'memories') {
      // 切换到记忆面板时刷新记忆列表
      void memoryController.loadMemoryList();
    } else if (panel === 'settings') {
      // 切换到设置面板时重新加载配置表单，确保与主进程数据一致
      void settingsController.loadConfig();
      void settingsController.loadLlmConfig();
    } else if (panel === 'sprite-settings') {
      // 切换到精灵设定面板时加载三类设定文件列表 + 同步角色匹配模式/默认角色
      // 列表与状态分离加载：列表由 loadAll 内部并行加载，状态由 syncSpriteSettingsState 同步
      void State.uiManager.settingsManagerPanel.loadAll();
      void syncSpriteSettingsState();
    } else if (panel === 'dashboard') {
      // 切换到仪表盘面板时刷新仪表盘数据（健康诊断 + 感知 + 运行指标）
      void memoryController.loadDashboard();
    } else if (panel === 'perception') {
      // 切换到感知面板时重新加载感知快照（确保显示最新情感/默契度/上下文数据）
      void memoryController.loadPerception();
    } else if (panel === 'clipboard') {
      // 切换到剪贴板面板时标记所有条目为已查看（角标清零）
      State.uiManager.clipboardManager.markAllViewed();
    }
  });

  // CommandPaletteManager 已纳入 UIManager 组合体系（构造函数创建 + init + cleanup）
  // 不再在 renderer.ts 中单独 new，避免生命周期脱管导致的全局 keydown 监听器泄漏

  // ─── 初始化辅助函数（从 initHelpers.ts 导入，闭包访问 State.uiManager/controllers） ───

  /** 静默模式恢复定时器 ref（由 createSilentRecoveryScheduler 闭包持有） */
  const silentTimerRef = { current: State.silentRecoveryTimer };
  const scheduleSilentRecovery = createSilentRecoveryScheduler(State.uiManager, silentTimerRef);
  // 同步 timerRef 回模块级变量，供 beforeunload 清理
  const syncTimerRef = () => { State.silentRecoveryTimer = silentTimerRef.current; };
  const originalSchedule = scheduleSilentRecovery;
  const wrappedSchedule = (ms: number) => { originalSchedule(ms); syncTimerRef(); };

  // 注册静默恢复回调：启动时若静默模式未过期，重建本地定时器
  settingsController.setSilentRecoveryCallback(wrappedSchedule);

  // setupSettingsPanel 已提前到第 82 行与其他面板 setup 同一位置

  // 提前赋值 State.onAgentReadyCallback，确保 Agent 在渲染进程启动前就已就绪时也能正确调用
  /**
   * 设置静默模式倒计时指示器（新枝破土）
   *
   * 在聊天工具栏中显示静默模式状态和距到期剩余时间，
   * 填补完整窗口内用户无法感知静默状态的操作流中断。
   */
  function setupSilentModeIndicator(): void {
    const indicator = document.getElementById('silent-mode-indicator');
    if (!indicator) return;

    const refresh = () => {
      window.electronAPI.getConfig().then(({ config }) => {
        // 未开启静默：隐藏
        if (!config.silentMode) {
          indicator.classList.add('hidden');
          return;
        }

        // 有过期时间且未过期：显示倒计时
        if (config.silentModeExpiresAt) {
          const expiresAt = new Date(config.silentModeExpiresAt).getTime();
          const remaining = expiresAt - Date.now();
          if (!Number.isNaN(remaining) && remaining > 0) {
            const expireTime = new Date(expiresAt);
            const timeStr = `${String(expireTime.getHours()).padStart(2, '0')}:${String(expireTime.getMinutes()).padStart(2, '0')}`;
            const minutes = Math.ceil(remaining / 60000);
            indicator.textContent = minutes <= 1 ? '静默中 · 即将恢复' : `静默中 · 将于 ${timeStr} 恢复`;
            indicator.classList.remove('hidden');
            return;
          }
        }

        // 已开启但无过期时间或已过期：只显示状态
        indicator.textContent = '静默中';
        indicator.classList.remove('hidden');
      }).catch(() => {
        // IPC 失败时隐藏指示器（降级）
        indicator.classList.add('hidden');
      });
    };

    refresh();
    // 5 秒轮询：平衡即时反馈与 IPC 开销（静默模式是低频手动开关，此频率足够）
    silentIndicatorTimer = silentIndicatorTimer ?? setInterval(refresh, 5_000);
  }

  State.onAgentReadyCallback = () => {
    // 幂等保护，防止 IPC 事件与重试定时器竞态导致重复加载
    if (State.agentReadyHandled) return;
    State.agentReadyHandled = true;
    // 标记 Agent 就绪，解除发送消息限制
    State.uiManager.setAgentReady(true);
    // 同步设置面板状态指示器
    settingsController.updateAgentStatus('ready', '精灵已就绪');
    void sessionController.loadSessionHistory();
    // 加载有对话记录的日期列表（供日期导航下拉列表使用）
    void sessionController.loadDateList();

    // 会话加载完成后，显示一键归档按钮（非 full 模式）
    State.uiManager.showArchiveButton();
    void memoryController.loadMemoryList();
    void personaController.loadPersonaList();
    void memoryController.loadDashboard();
    // 启动摘要（迭代一：Welcome Back Digest）
    void loadStartupSummary();
    setupSilentModeIndicator();
    // 首次使用流程：Agent 就绪后自动切换到对话面板，让用户立即开始对话
    void State.uiManager.switchPanel('chat');
    // 检查是否需要显示多步骤引导（未配置 Provider 的新用户）
    void checkAndShowOnboarding();
  };

  /**
   * 检查是否需要显示引导并显示（已配置用户跳过）
   *
   * 先查询 Provider 列表，若已有配置则跳过引导。
   */
  async function checkAndShowOnboarding(): Promise<void> {
    try {
      const { providers } = await window.electronAPI.listLlmProviders();
      const hasProviders = providers && providers.length > 0;
      // 同步更新 hasProviders 状态（供 emitSendMessage 区分"未配置"与"初始化中"）
      State.uiManager.setHasProviders(hasProviders);
      if (State.uiManager.shouldShowOnboarding(hasProviders)) {
        State.uiManager.showOnboardingDialog();
      }
    } catch (error) {
      // 查询失败时仍显示引导（不阻塞用户）
      reportError('checkAndShowOnboarding', error);
      State.uiManager.setHasProviders(false);
      if (State.uiManager.shouldShowOnboarding(false)) {
        State.uiManager.showOnboardingDialog();
      }
    }
  }

  /**
   * 加载启动摘要（迭代一：Welcome Back Digest）
   *
   * 调用 Sprite.getStartupSummary() IPC 获取聚合数据，
   * 在对话区顶部展示摘要卡片。
   */
  async function loadStartupSummary(): Promise<void> {
    try {
      const summary = await window.electronAPI.getStartupSummary();
      if (summary) {
        State.uiManager.showStartupSummary(summary);
      }
    } catch (error) {
      // 摘要加载失败静默降级，不影响主流程
      reportError('loadStartupSummary', error);
    }
  }

  /**
   * 同步精灵设定面板的角色匹配模式 + 默认角色输入框
   *
   * 切换到精灵设定面板时调用，确保面板显示的 personaMode / defaultPersona
   * 与主进程 spriteConfig 一致（避免用户在外部修改后看到陈旧状态）。
   *
   * 设计选择：每次切换都重新查询而非缓存，因为：
   * 1. IPC 调用量小（两次轻量级查询）
   * 2. 避免缓存失效问题（用户可能在设置面板或其他入口修改了配置）
   * 3. 与 settingsController.loadConfig 同模式（每次切换都重新加载）
   */
  async function syncSpriteSettingsState(): Promise<void> {
    // 同步角色匹配模式（独立 IPC，与 spriteConfig 解耦）
    try {
      const { mode } = await window.electronAPI.getPersonaMode();
      State.uiManager.settingsManagerPanel.setPersonaMode(mode as 'auto' | 'manual');
    } catch (error) {
      reportError('syncSpriteSettingsState-mode', error);
    }
    // 同步默认角色（从 spriteConfig 读取，与 settingsController.loadConfig 同源）
    try {
      const { config } = await window.electronAPI.getConfig();
      if (config) {
        State.uiManager.settingsManagerPanel.setDefaultPersona(String(config.defaultPersona ?? ''));
      }
    } catch (error) {
      reportError('syncSpriteSettingsState-defaultPersona', error);
    }
  }

  // IPC 监听器提前注册——在 controllers 创建 + onAgentReadyCallback 赋值后立即注册，
  // 避免主进程在 DOMContentLoaded 中段（主题读取/回调注册期间）推送的事件丢失。
  // 所有回调依赖（memoryController/settingsController/sessionController）均已在上文创建。
  initIpcListeners(State.uiManager, {
    // 精灵事件：记忆被注意 / 洞察获得 → 仪表盘计数 +1 动画 + 刷新仪表盘
    // 事件密集触发时使用防抖版 loadDashboard，避免频繁 IPC + DOM 操作
    // pulseCounter 的 DOM ID 对应 index.html 中仪表盘统计卡片（dashboard-total-memories / dashboard-total-insights）
    // 用户停留在记忆面板时同步触发列表防抖刷新，让新记忆即时可见
    onMemoryNoticed: () => {
      memoryController.pulseCounter('dashboard-total-memories');
      void memoryController.loadDashboardDebounced();
      if (State.uiManager.getCurrentPanel() === 'memories') {
        memoryController.loadMemoryListDebounced();
      }
    },
    onInsightGained: () => {
      memoryController.pulseCounter('dashboard-total-insights');
      void memoryController.loadDashboardDebounced();
    },
    // Agent 就绪：加载初始数据 + 切换到对话面板
    onAgentReady: () => {
      // IPC 事件到达时取消挂起的重试定时器，避免两条路径都触发
      if (State.initRetryTimer !== null) {
        window.clearTimeout(State.initRetryTimer);
        State.initRetryTimer = null;
      }
      // State.onAgentReadyCallback 已在初始化阶段提前赋值，直接调用即可
      State.onAgentReadyCallback?.();
    },
    // 对话结束：立即刷新仪表盘获取最新 LLM 指标，延迟二次刷新等待异步归档完成
    onConversationEnd: () => {
      // 立即刷新：LLM 调用次数、token 数、工具使用等指标在对话结束时已确定
      void memoryController.loadDashboard();
      // Token 用量指示器（输入区中部，流式结束后自动刷新）
      State.uiManager.refreshTokenUsage();
      // 刷新日期导航：新消息发送后，"今天"的消息数需要实时更新
      void sessionController.loadDateList();
      // 延迟 1s 二次刷新：postProcess 中的记忆归档是异步 fire-and-forget 的，
      // 等待用户画像归档、Insight 提取等后台任务完成后再刷新一次
      window.setTimeout(() => {
        void memoryController.loadDashboard();
      }, 1000);
    },
    // 情感基调更新 → 仪表盘四维进度条
    onAffectUpdated: (payload) => {
      memoryController.updateAffectDisplay(payload);
    },
    // Phase 3：默契度更新 → 仪表盘默契度卡片
    onRapportUpdated: (payload) => {
      memoryController.updateRapportDisplay(payload);
    },
    // Phase 4：对话上下文更新 → 仪表盘上下文卡片
    onContextUpdated: (payload) => {
      memoryController.updateContextDisplay(payload);
    },
    // 用户模式更新 → 洞察面板
    onPatternsUpdated: (payload) => {
      memoryController.updatePatternsDisplay(payload);
    },
    // Phase 3.2：在场状态更新 → 状态指示器
    onPresenceChanged: (payload) => {
      memoryController.updatePresenceDisplay(payload);
    },
    // 作品投影更新 → 刷新作品投影面板
    onWorkProjectionUpdated: (_payload) => {
      void settingsController.loadWorkProjections();
    },
    // 会话分叉完成 → 切换到新会话（payload.to 为完整的新会话 ID）
    // 内核 forkSession 已切换 Agent 内部状态，switchSession 会幂等同步并加载消息
    onSessionForked: async (payload) => {
      await sessionController.switchSession(payload.to);
    },
    // 角色切换 → 刷新顶栏 + 下拉菜单 active + 感知面板（如打开）
    // auto 自动匹配与手动切换走同一事件链路，统一在此处理 UI 副作用
    // 不发 toast：手动切换的 toast 由 personaController.setupPersonaSelector 负责（success 级别反馈用户主动操作）；
    //             auto 模式属于系统行为，频繁 toast 会打扰用户，仅通过 UI 变化（顶栏 + 下拉 active）反馈
    onPersonaChanged: (_payload) => {
      // 重新拉取角色列表：更新顶栏角色名 + 下拉菜单 active 标记 + 模式 badge
      void personaController.loadPersonaList();
      // 感知面板可见时同步刷新（perceptionCoordinator.refreshBeforeChat 已在主进程基于新角色 traits 重推导）
      // 2.1：感知面板迁至信息侧栏，可见性由 PanelRouter.isAuxTabVisible 判断（侧栏展开 + 感知 tab 激活）
      if (State.uiManager.panelRouter.isAuxTabVisible('perception')) {
        void memoryController.loadPerception();
      }
    },
    // 设定文件变更 → 精灵设定面板按 type 分发刷新对应列表
    // 触发源：本面板 CRUD（saveRule/deleteSkill 等）或外部文件系统编辑
    onConfigFilesChanged: (payload) => {
      // 广播到达后直接按 type 分发刷新对应列表（refreshByType 内部按 type 调用 loadXxxList）
      // 不再经过 handleConfigFilesChanged → configFilesChangedCallback 中间层，调用链路最短
      void State.uiManager.settingsManagerPanel.refreshByType(payload.type);
      // persona 列表变更时，同步刷新对话输入框的角色下拉菜单
      // 下拉菜单默认只订阅 personaChanged（角色切换）事件，角色"创建/删除"不触发切换事件，
      // 需在此补刷新，否则对话中新建的角色不会出现在下拉菜单中（设定面板已刷新但下拉菜单未刷新）
      if (payload.type === 'persona') {
        void personaController.loadPersonaList();
      }
    },
  });

  // 从 IPC 读取主题配置（真理源为 sprite.json），localStorage 仅作为内联脚本缓存
  // 内联脚本（index.html / float.html）已通过 localStorage 设置了 data-theme 属性（避免页面闪烁），
  // 此处以 sprite.json 为准进行修正，并处理首次迁移（localStorage → sprite.json）
  try {
    const { config } = await window.electronAPI.getConfig();
      // 防御性检查：config 为 null/undefined 时跳过主题初始化（Agent 未就绪等场景）
      if (config && config.theme) {
        // sprite.json 中有主题配置，以它为准（覆盖 localStorage 缓存，确保一致性）
        // config.theme 可能为 'auto'，由 ThemeManager 处理实际主题选择
        // 即使值相同也调用 setTheme()，确保 DOM 状态正确初始化（data-theme 属性）
        State.uiManager.setTheme(config.theme);
      } else {
      // sprite.json 中无主题配置（v1→v2 迁移前或首次使用），从 localStorage 迁移
      // safeGet 内部已 try-catch localStorage 不可用场景，外层 try-catch 仍保留以捕获 updateConfig IPC 失败
      try {
        const cachedTheme = safeGet('memora-theme', '');
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
  // 使用 getThemeMode 同步三态单选按钮（light/dark/auto）
  State.uiManager.syncThemeRadios(State.uiManager.getThemeMode());

  State.uiManager.onThemeChange((theme, source) => {
    // 区分"用户主动切换"与"系统主题变化"
    // source='user'：用户在设置面板主动切换，需持久化到 sprite.json（真理源）
    // source='system'：auto 模式下系统主题变化，仅同步浮动窗口，不覆盖 sprite.json 中的 'auto'
    if (source === 'user') {
      window.electronAPI.updateConfig('theme', theme);
    }
    // 两种场景都需要通知主进程同步到浮动窗口，避免两个窗口主题不一致
    window.electronAPI.notifyThemeChanged(theme);
    // 主题切换后重绘 Canvas 图表（Canvas 2D 不自动响应 CSS 变量变化）
    State.uiManager.repaintCanvasOnThemeChange();
  });

  // 流式错误重试：重新发送上一条用户消息
  // 提取为独立函数，供气泡内 onErrorRetry 复用（Toast 不再携带重试按钮）
  const retryLastUserInput = (): void => {
    if (!State.lastUserInput) return;
    // 重试前检查流式状态，避免流式输出中重复发送
    if (State.uiManager.isStreaming()) {
      State.uiManager.showToast('请先停止当前回复再重试', 'warning');
      return;
    }
    // 重新显示用户消息并发送
    State.uiManager.appendMessage({
      role: 'user',
      content: State.lastUserInput,
    });
    // R1 度量埋点：记录对话轮次（激活率分母，覆盖重试路径）
    getCompletionMetrics().recordChatTurn();
    window.electronAPI.sendUserInput(State.lastUserInput);
  };

  // IPC 监听器已提前到 onAgentReadyCallback 赋值后注册（见上文），此处无需重复注册

  // 注册气泡内错误重试回调（复用 retryLastUserInput，供错误气泡内"重试"按钮调用）
  // Toast 不再携带重试按钮，气泡内重试为唯一主通道
  State.uiManager.onErrorRetry(retryLastUserInput);

  // 初始化主动提示 banner 按钮（查看/稍后/静默）
  State.uiManager.initProactiveBannerButtons({
    onView: (triggers) => {
      // 用户点击"查看"→ 记录接受事件，接受率提升影响主动度
      window.electronAPI.proactiveAccept();

      // 根据 triggers 类型跳转到相应面板展示详情
      // 优先级：冲突 > 角色 > 洞察 > 记忆 > 里程碑 > 模式 > 召回 > 建议 > 对话
      // 跳转目标对齐场景闭环设计.md 场景 4 完成判定：
      //   记忆→记忆面板，洞察→仪表盘，角色→设置
      if (triggers.includes('conflict')) {
        // 冲突检测 → 切换到记忆面板并打开冲突记忆详情
        const conflictTargetId = consumeConflictTargetId();
        if (conflictTargetId) {
          void State.uiManager.switchPanel('memory');
          void State.memoryController?.openMemoryDetail(conflictTargetId);
        }
      } else if (triggers.includes('persona')) {
        // 角色切换 → 跳转到设置面板的角色管理区域
        void State.uiManager.switchPanel('settings');
      } else if (triggers.includes('insight')) {
        // 有新洞察 → 跳转到仪表盘查看最近洞察列表（renderRecentInsights 区块）
        void State.uiManager.panelRouter.openAuxSidebar('dashboard');
      } else if (triggers.includes('memory')) {
        // 有新记忆 → 跳转到记忆面板查看
        void State.uiManager.switchPanel('memory');
      } else if (triggers.includes('milestone')) {
        // 里程碑 → 跳转到仪表盘查看成就
        void State.uiManager.panelRouter.openAuxSidebar('dashboard');
      } else if (triggers.includes('pattern')) {
        // 模式检测 → 跳转到仪表盘查看模式
        void State.uiManager.panelRouter.openAuxSidebar('dashboard');
      } else if (triggers.includes('recalled')) {
        // 欢迎回来记忆召回 → 跳转到记忆面板查看召回的记忆
        void State.uiManager.switchPanel('memory');
      } else if (triggers.includes('suggestion')) {
        // 智能建议（健康度/回顾/画像）→ 跳转到仪表盘查看建议详情
        void State.uiManager.panelRouter.openAuxSidebar('dashboard');
      } else {
        // 默认：确保对话面板可见
        void State.uiManager.switchPanel('chat');
      }
    },
    onLater: () => {
      // 用户点击"稍后"→ 记录拒绝事件，触发自适应冷却
      window.electronAPI.proactiveReject();
      // banner 已隐藏，无需额外操作
    },
    onSilent: () => {
      // 用户点击"静默"→ 记录拒绝事件
      window.electronAPI.proactiveReject();
      // 通知主进程进入静默模式
      void window.electronAPI.updateConfig('silentMode', true).catch((e: unknown) => reportError('onSilent-updateConfig', e));
      // 持久化恢复时间，页面刷新后也能正确恢复
      const expiresAt = new Date(Date.now() + SILENT_RECOVERY_MS).toISOString();
      void window.electronAPI.updateConfig('silentModeExpiresAt', expiresAt).catch((e: unknown) => reportError('onSilent-updateConfigExpiresAt', e));
      // 操作反馈走 toast（静默模式是用户主动触发的状态变更）
      State.uiManager.showToast('已进入静默模式，精灵 1 小时内不会主动提示（到期自动恢复）', 'info');
      // 设置本地定时器：1 小时后自动关闭静默模式（复用 wrappedSchedule 统一逻辑）
      wrappedSchedule(SILENT_RECOVERY_MS);
    },
    // 不再提醒：进入静默模式并提示用户去设置调整阈值（二次确认，避免误触永久静默）
    onDisable: async () => {
      // 二次确认：此操作 24 小时内不再提醒，需手动去设置恢复，属较重操作
      const confirmed = await State.uiManager.showConfirmDialog({
        title: '关闭主动提示',
        message: '关闭后精灵 24 小时内不再主动提示。如需恢复，请到设置面板调整主动提示阈值。确认关闭？',
        confirmText: '关闭提示',
        cancelText: '取消',
        danger: true,
      });
      if (!confirmed) return;
      // 用户点击"不再提醒"→ 记录拒绝事件
      window.electronAPI.proactiveReject();
      void window.electronAPI.updateConfig('silentMode', true).catch((e: unknown) => reportError('onDisable-updateConfig', e));
      // 设置一个较长的恢复时间（24 小时），等效于"不再提醒"
      const expiresAt = new Date(Date.now() + MS_PER_DAY).toISOString();
      void window.electronAPI.updateConfig('silentModeExpiresAt', expiresAt).catch((e: unknown) => reportError('onDisable-updateConfigExpiresAt', e));
      State.uiManager.showToast('已关闭主动提示（24 小时内不再提醒）。如需恢复，请到设置面板调整主动提示阈值', 'info');
    },
  });

  // 召回记忆点击：跳转到记忆面板并显示详情（使用完整记忆ID精准跳转）
  State.uiManager.onMemoryRecallClick(async (memoryId) => {
    await State.uiManager.switchPanel('memories');
    // 预填搜索框为记忆名称，让弹窗背后列表同步（静态元素，instanceof 校验）
    const searchInput = document.getElementById('memory-search');
    if (searchInput instanceof HTMLInputElement) {
      // memoryId 格式为 "source:name"，冒号后的部分是记忆名称
      const namePart = memoryId.includes(':') ? memoryId.slice(memoryId.indexOf(':') + 1) : memoryId;
      searchInput.value = namePart;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      const { memory } = await window.electronAPI.showMemory(memoryId);
      if (memory) {
        State.uiManager.showMemoryDetail(memory);
      }
    } catch (error) {
      // 记忆可能已删除，记录日志辅助排查
      reportError('memoryRecall', error);
    }
  });

  // 记忆→对话双向流动：关闭详情弹窗 → 切换到对话面板 → 预填讨论提示
  State.uiManager.onMemoryDiscuss((memoryName) => {
    State.uiManager.hideModal('memory-detail-modal');
    // 先预填输入框，再切换面板（switchPanel('chat') 会自动聚焦输入框）
    State.uiManager.prefillChatInput(`关于「${memoryName}」…`);
    void State.uiManager.switchPanel('chat');
  });

  // ─── 技能文件拖入安装初始化 ──────────────
  // 注册安装成功回调：刷新仪表盘技能列表 + 计数
  // 注：dropzone 事件监听已迁移到设定面板 settingsManagerPanel.initSkillDropzone（sprite-skill-dropzone）
  State.uiManager.onSkillInstalled(() => {
    void memoryController.loadDashboard();
  });

  // loadLlmConfig（加载 Embedding 配置）与 getAgentStatus 无依赖关系，并行执行减少首屏阻塞
  // Provider 列表由 SettingsPanelManager.initListeners 内部调用 loadProviderList 自行加载
  try {
    const [, agentStatusResult] = await Promise.all([
      settingsController.loadLlmConfig(),
      window.electronAPI.getAgentStatus(),
    ]);
    const { ready, error } = agentStatusResult;

    // 更新设置面板 Agent 连接状态指示器
    settingsController.updateAgentStatus(ready ? 'ready' : 'error', error ?? undefined);
    if (!ready) {
      // 三种状态：配置缺失 / 初始化失败 / 初始化中
      // 初始化中（error 为 null）：Agent 正在启动，延迟重试而非显示错误
      if (!error) {
        settingsController.updateAgentStatus('unknown', '正在初始化...');
        // 提取为可递归的重试函数，避免状态永久停留在"正在初始化..."
        const MAX_INIT_RETRIES = 5; // 最多重试 5 次（共 10 秒）
        const retryAgentStatus = (attempt: number): void => {
          State.initRetryTimer = window.setTimeout(async () => {
            try {
              const retry = await window.electronAPI.getAgentStatus();
              if (retry.ready) {
                State.initRetryTimer = null;
                // State.onAgentReadyCallback 内部会更新状态指示器（幂等保护）
                State.onAgentReadyCallback?.();
              } else if (retry.error) {
                // 初始化失败，显示具体错误（复用 showAgentInitError 统一处理）
                State.initRetryTimer = null;
                showAgentInitError(State.uiManager, settingsController, retry.error);
              } else if (attempt < MAX_INIT_RETRIES) {
                // 仍在初始化中，继续重试
                retryAgentStatus(attempt + 1);
              } else {
                // 超过最大重试次数，显示超时错误
                State.initRetryTimer = null;
                settingsController.updateAgentStatus('error', '精灵初始化超时');
                State.uiManager.showToast('精灵初始化超时，请尝试重启应用', 'error');
              }
            } catch (retryErr) {
              // 重试查询失败，未达上限时继续重试，debug 级别避免日志噪音
              reportError('init/agentStatusRetry', retryErr);
              if (attempt < MAX_INIT_RETRIES) {
                retryAgentStatus(attempt + 1);
              } else {
                State.initRetryTimer = null;
                settingsController.updateAgentStatus('error', '精灵状态查询失败');
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
        // 首次启动：onboarding 接管引导（含 API Key 配置、Provider 注册链接、默认模型自动填充）
        if (State.uiManager.shouldShowOnboarding(false)) {
          State.uiManager.showOnboardingDialog();
        } else {
          // 老用户配置缺失（如 config.json 被删除）：回退到欢迎消息 + 设置面板
          showWelcomeMessage(State.uiManager);
          void State.uiManager.switchPanel('settings');
        }
        await settingsController.loadConfig();
      } else {
        // 初始化失败：显示错误 + 重试按钮 + 跳转设置面板（复用 showAgentInitError 统一处理）
        showAgentInitError(State.uiManager, settingsController, error);
      }
      return;
    }
  } catch (err) {
    // agent-status 通道异常（主进程未就绪或网络错误），降级为首次使用引导
    reportError('init/agent-status', err);
    // 异常时状态指示器显示 unknown
    settingsController.updateAgentStatus('unknown', '检测中...');
    showWelcomeMessage(State.uiManager);
    void State.uiManager.switchPanel('settings');
    await settingsController.loadConfig();
    return;
  }

  // Agent 在渲染进程启动前就已就绪时，IPC 事件已错过，需在此主动触发就绪流程
  // State.onAgentReadyCallback 已在初始化阶段提前赋值，直接调用即可
  State.onAgentReadyCallback();
  void settingsController.loadConfig();
  void memoryController.loadDashboard();
  // 预加载用户画像数据（用户切换到"画像"tab 时即可见）
  void settingsController.loadUserProfile();
  // 预加载作品投影数据（用户切换到"作品"tab 时即可见）
  void settingsController.loadWorkProjections();
  // M2 预加载审计日志数据（用户切换到"审计"tab 时即可见）
  void settingsController.loadAuditLog();
}

// DOMContentLoaded 调用 bootstrapRenderer，统一捕获初始化异常避免 UI 空白
document.addEventListener('DOMContentLoaded', () => {
  bootstrapRenderer().catch((err: unknown) => {
    reportError('bootstrapRenderer', err);
    // UIManager 已构造时用其 toast 展示；未构造时已渲染错误卡片到 document.body
    if (State.uiManager) {
      try {
        State.uiManager.showToast('应用初始化失败，请重启或查看日志', 'error', TOAST_LONG_MS);
      } catch {
        // UIManager 半初始化，忽略二次错误（错误卡片已显示）
      }
    }
  });
});

// ─── 清理资源 ─────────────────────────────────────────────

// 页面卸载时清理资源：UI 监听器 + IPC 监听器
// IPC 监听器若不清理，重新加载页面时会累积，导致同一事件触发多次
window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
  // 设置面板有未保存修改时，阻止页面关闭/刷新
  // 防止用户意外丢失 LLM 配置（含 API Key）等关键数据
  if (State.uiManager?.getCurrentPanel() === 'settings' && State.uiManager.isSettingsDirty()) {
    e.preventDefault();
    // 现代浏览器要求设置 returnValue 才能触发确认对话框
    e.returnValue = '';
  }

  State.uiManager?.cleanup();
  // 清理渲染进程级事件监听器（forkBtn/dropzone 等，EventTracker 统一管理）
  State.events.cleanup();
  // 清理全局相对时间刷新器（移除 focus/visibilitychange 监听 + clearInterval）
  timeRefresher.stop();
  // 清理静默模式恢复定时器，避免定时器触发时操作已销毁的 DOM 或产生未捕获 rejection
  if (State.silentRecoveryTimer !== null) {
    window.clearTimeout(State.silentRecoveryTimer);
    State.silentRecoveryTimer = null;
  }
  // 清理静默模式指示器定时器（新枝破土）
  if (silentIndicatorTimer !== null) {
    window.clearInterval(silentIndicatorTimer);
    silentIndicatorTimer = null;
  }
  // 清理 Agent 初始化重试定时器（与 State.silentRecoveryTimer 同模式）
  if (State.initRetryTimer !== null) {
    window.clearTimeout(State.initRetryTimer);
    State.initRetryTimer = null;
  }
  // 清理脉冲动画定时器（避免操作已销毁的 DOM）
  State.memoryController?.cleanup();
  State.memoryController = null;
  // 清理 IPC 监听器（防止内存泄漏与重复触发）
  window.electronAPI.removeStreamListeners();
  window.electronAPI.removeSpriteOutputListener();
  window.electronAPI.removeSpriteEventListener();
  window.electronAPI.removeSpriteErrorListener();
  window.electronAPI.removeAppErrorListener();
  window.electronAPI.removeAgentReadyListener();
  window.electronAPI.removeFloatUnreadListener();
  window.electronAPI.removeWindowStateChangedListener();
  // 清理配置建议推送监听器
  window.electronAPI.removeSuggestionPushListener();
  // 剪枝：补充清理写入确认监听器（原遗漏，防止内存泄漏）
  window.electronAPI.removeWriteConfirmationListener();
  // Phase 3.1：清理剪贴板三重保护监听器
  window.electronAPI.removeClipboardChangedListener();
  window.electronAPI.removeClipboardSensitiveIgnoredListener();
  window.electronAPI.removeClipboardAnalysisReadyListener();
  window.electronAPI.removeClipboardAnalysisRejectedListener();
  // Phase 3.3 第二批：清理全局快捷键触发监听器
  window.electronAPI.removeQuickRecordTriggerListener();
  window.electronAPI.removeRecallMemoryTriggerListener();
});

// ─── 业务逻辑设置（发送/停止/会话管理） ─────────────────────

/**
 * 设置发送消息、停止消息、会话管理回调（日期跳转/删除等）
 *
 * 这些回调依赖 State.uiManager 和 sessionController，保留在 renderer.ts 中
 * 避免引入额外的模块间依赖。
 */
function setupBusinessLogic(
  _uiManager: UIManager,
  sessionController: ReturnType<typeof createSessionController>,
): void {
  // 设置发送消息回调
  State.uiManager.onSendMessage(async () => {
    const text = State.uiManager.getUserInput();
    if (!text) return;

    // 存储最后用户输入，用于流式错误重试
    State.lastUserInput = text;

    // 跨天检测：当前查看的是历史日期时，自动静默切换到今天的 main 会话
    // 设计决策：跨天只是存储层细节，无需打扰用户确认，直接切换即可
    const currentId = sessionController.getCurrentSessionId();
    if (currentId) {
      const todayPrefix = getLocalDate();
      const sessionDate = currentId.slice(0, 10);
      if (sessionDate !== todayPrefix) {
        const todaySessionId = `${todayPrefix}-main`;
        await sessionController.switchSession(todaySessionId);
      }
    }

    // 显示用户消息
    State.uiManager.appendMessage({
      role: 'user',
      content: text,
    });

    // R1 度量埋点：记录对话轮次（激活率分母，覆盖主发送路径）
    getCompletionMetrics().recordChatTurn();
    // 发送到主进程
    window.electronAPI.sendUserInput(text);
  });

  // 空状态示例问题回调：点击示例问题等同于用户输入并发送
  State.uiManager.onSuggestionClick(async (text) => {
    // 流式防护：流式输出中点击示例问题等同于重复发送，应阻止
    if (State.uiManager.isStreaming()) {
      State.uiManager.showToast('精灵正在回复中，请等待回复完成或点击停止', 'warning');
      return;
    }
    // Agent 就绪守卫：与 emitSendMessage 一致，避免示例问题绕过校验导致消息残留 + 错误
    if (!State.uiManager.isAgentReady()) {
      State.uiManager.showToast('精灵未就绪，请先在设置面板配置 LLM', 'warning');
      void State.uiManager.switchPanel('settings');
      return;
    }
    // 存储最后用户输入，用于流式错误重试
    State.lastUserInput = text;

    // 跨天检测：查看历史日期时静默切换到今天 main 会话
    const currentId = sessionController.getCurrentSessionId();
    if (currentId) {
      const todayPrefix = getLocalDate();
      const sessionDate = currentId.slice(0, 10);
      if (sessionDate !== todayPrefix) {
        const todaySessionId = `${todayPrefix}-main`;
        await sessionController.switchSession(todaySessionId);
      }
    }

    // 显示用户消息
    State.uiManager.appendMessage({
      role: 'user',
      content: text,
    });
    // R1 度量埋点：记录对话轮次（激活率分母，覆盖示例问题路径）
    getCompletionMetrics().recordChatTurn();
    // 发送到主进程
    window.electronAPI.sendUserInput(text);
  });

  // 设置停止消息回调
  // 不调用 stopAllStreaming()——它会同步清空 streamingMessages Map，
  // 导致主进程 abort 后异步发送的 SPRITE_STREAM_ABORTED 找不到消息元素，
  // 中断标记无法嵌入气泡。正确流程：abortChat() → 主进程中断 generator →
  // SPRITE_STREAM_ABORTED → markStreamingAborted（正确嵌入标记 + 清理状态）→
  // SPRITE_STREAM_END → finishStreamingMessage（添加复制按钮等收尾）。
  // stopAllStreaming() 保留给渲染进程超时兜底（onStreamStuck）使用，不用在用户主动停止路径。
  State.uiManager.onStopMessage(async () => {
    await window.electronAPI.abortChat();
  });

  // 会话分叉按钮：从当前对话分叉出独立分支（基于当前上下文新建会话）
  const forkBtn = document.getElementById('btn-fork-session');
  if (forkBtn) {
    // 通过 State.events 统一注册，beforeunload 时自动清理（EventTracker 范式）
    State.events.addEventListener(forkBtn, 'click', () => {
      // B7：异步操作期间禁用按钮 + 显示"分叉中…"，防止重复点击（forkSession 内部已捕获错误并 toast）
      setButtonLoading('btn-fork-session', true, '分叉中…');
      void sessionController.forkSession().finally(() => {
        setButtonLoading('btn-fork-session', false);
      });
    });
  }

  // 日期导航跳转回调：日历选择器选中日期后跳转
  State.uiManager.onDateNavJump(async (date: string) => {
    try {
      await sessionController.jumpToDate(date);
      // 跳转成功后设置日期选择器显示当前日期
      State.uiManager.setDateNavCurrentDate(date);
    } catch (error) {
      reportError('dateNavJump', error);
      State.uiManager.showToast('日期跳转失败，请稍后重试', 'error');
    }
  });

  // 日期导航删除回调：删除指定日期的对话记录（需二次确认）
  State.uiManager.onDateNavDelete(async (date: string) => {
    // 流式输出期间禁止删除
    if (State.uiManager.isStreaming()) {
      State.uiManager.showToast('精灵正在回复中，请等待完成后再删除', 'warning');
      return;
    }
    // 二次确认弹窗（danger 样式，红色确认按钮）
    const confirmed = await State.uiManager.showConfirmDialog({
      title: '删除对话记录',
      message: `确定要删除 ${date} 的全部对话记录吗？此操作不可撤销。`,
      confirmText: '删除',
      cancelText: '取消',
      danger: true,
    });
    if (!confirmed) return;
    try {
      const success = await sessionController.deleteSession(date);
      // 删除成功后刷新日期列表
      if (success) {
        await sessionController.loadDateList();
      }
    } catch (error) {
      reportError('dateNavDelete', error);
      State.uiManager.showToast(formatErrorMessage('删除对话记录', error), 'error');
    }
  });

  // 回到今天回调：切换到今天的会话并加载消息
  State.uiManager.onBackToToday(async () => {
    try {
      const today = getLocalDate();
      await sessionController.switchSession(`${today}-main`);
      await sessionController.loadSessionHistory();
    } catch (error) {
      reportError('backToToday', error);
      State.uiManager.showToast(formatErrorMessage('回到今天', error), 'error');
    }
  });

  // 搜索结果点击回调：跳转到对应日期的会话并加载消息
  // 搜索结果携带 date 和 session，拼成 sessionId 后复用 switchSession 跳转
  State.uiManager.onSearchResultClick(async (date: string, session: string) => {
    try {
      // 先切换到对话面板（用户可能在记忆/设置面板触发搜索）
      await State.uiManager.switchPanel('chat');
      await sessionController.switchSession(`${date}-${session}`);
    } catch (error) {
      reportError('searchResultClick', error);
      State.uiManager.showToast(formatErrorMessage('跳转到搜索结果', error), 'error');
    }
  });
}
