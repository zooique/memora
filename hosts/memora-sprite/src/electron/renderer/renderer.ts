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
import { createSessionController } from './sessionController.js';
import { createMemoryController } from './memoryController.js';
import { createPersonaController } from './personaController.js';
import { createSettingsController, setSilentRecoveryCallback } from './settingsController.js';
import { initIpcListeners } from './ipcListeners.js';
import { reportError } from './errorHelpers.js';
import { getLocalDate } from '../../sprite/constants.js';

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

// ─── 初始化 ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 UI 管理器
  uiManager = new UIManager();

  // 创建各业务控制器（接收 uiManager 实例，通过闭包绑定）
  const sessionController = createSessionController(uiManager);
  const memoryController = createMemoryController(uiManager);
  const personaController = createPersonaController(uiManager);
  const settingsController = createSettingsController(uiManager);

  // 设置业务逻辑回调
  setupBusinessLogic(uiManager, sessionController);
  memoryController.setupMemoryPanel();
  personaController.setupPersonaSelector();
  // FD-10 注册静默恢复回调：启动时若静默模式未过期，重建本地定时器
  setSilentRecoveryCallback((remainingMs: number) => {
    if (silentRecoveryTimer !== null) window.clearTimeout(silentRecoveryTimer);
    silentRecoveryTimer = window.setTimeout(() => {
      silentRecoveryTimer = null;
      void window.electronAPI.updateConfig('silentMode', false).then(() => {
        void window.electronAPI.updateConfig('silentModeExpiresAt', null);
        uiManager.showToast('静默模式已到期自动恢复', 'info');
      }).catch((err: unknown) => {
        reportError('silentRecovery', err);
      });
    }, remainingMs);
  });

  settingsController.setupSettingsPanel();

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

  uiManager.onThemeChange((theme) => {
    // UX-FD-12 持久化主题到 sprite.json（真理源），替换 localStorage 唯一真理源
    window.electronAPI.updateConfig('theme', theme);
    // UX-P2-10 通知主进程同步到浮动窗口，避免两个窗口主题不一致
    window.electronAPI.notifyThemeChanged(theme);
    console.debug(`[theme] 主题已切换为: ${theme}`);
  });

  // 初始化 IPC 监听器（统一注册，通过回调解耦业务逻辑）
  initIpcListeners(uiManager, {
    // 精灵事件：记忆被注意 / 洞察获得 → 仪表盘计数 +1 动画 + 刷新仪表盘
    onMemoryNoticed: () => {
      memoryController.pulseCounter('memory-count');
      // FD-03 记忆变化后刷新仪表盘（累积事件数可能变化）
      void memoryController.loadDashboard();
    },
    onInsightGained: () => {
      memoryController.pulseCounter('insight-count');
      // FD-03 洞察变化后刷新仪表盘
      void memoryController.loadDashboard();
    },
    // Agent 就绪：加载初始数据 + 切换到对话面板
    onAgentReady: () => {
      // UX-P2-03 标记 Agent 就绪，解除发送消息限制
      uiManager.setAgentReady(true);
      void sessionController.loadSessionHistory();
      // FD-A1 Gap 1 修复：Agent 就绪后加载会话列表（第 162 行调用时 Agent 未就绪，静默失败）
      void sessionController.loadSessionList();
      void memoryController.loadMemoryList();
      void personaController.loadPersonaList();
      void memoryController.loadDashboard();
      // 首次使用流程：Agent 就绪后自动切换到对话面板，让用户立即开始对话
      uiManager.switchPanel('chat');
      // P2 修复：首次配置完成后检查是否需要显示三态引导
      // 初始化流程中 Agent 未就绪时提前 return，三态引导检查不会执行；
      // 此处 Agent 就绪后补检，确保首次用户能看到窗口模型引导
      if (uiManager.shouldShowOnboarding()) {
        uiManager.showOnboardingDialog();
      }
    },
    // UX-PP-03 流式错误重试：重新发送上一条用户消息
    onSpriteErrorRetry: () => {
      if (lastUserInput) {
        // 重新显示用户消息并发送
        uiManager.appendMessage({
          role: 'user',
          content: lastUserInput,
        });
        window.electronAPI.sendUserInput(lastUserInput);
      }
    },
  });

  // 初始化主动提示 banner 按钮（查看/稍后/静默）
  uiManager.initProactiveBannerButtons({
    onView: () => {
      // 已在对话面板内，仅确保面板可见
      uiManager.switchPanel('chat');
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
      // 清理旧的恢复定时器，避免多次点击产生重复恢复
      if (silentRecoveryTimer !== null) {
        window.clearTimeout(silentRecoveryTimer);
      }
      // 设置本地定时器：1 小时后自动关闭静默模式
      // FD-10 定时器到期后同步清除持久化的 expiresAt
      silentRecoveryTimer = window.setTimeout(() => {
        silentRecoveryTimer = null;
        void window.electronAPI.updateConfig('silentMode', false).then(() => {
          void window.electronAPI.updateConfig('silentModeExpiresAt', null);
          uiManager.showToast('静默模式已到期自动恢复，精灵可正常主动提示', 'info');
        }).catch((err: unknown) => {
          reportError('silentRecovery', err);
        });
      }, SILENT_RECOVERY_MS);
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
    uiManager.switchPanel('memories');
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

  // 加载 LLM 配置到设置面板（无论 Agent 是否就绪都加载）
  await settingsController.loadLlmConfig();

  // 检查 Agent 是否就绪
  try {
    const { ready, error } = await window.electronAPI.getAgentStatus();
    // P3-FLOW-10 更新设置面板 Agent 连接状态指示器
    settingsController.updateAgentStatus(ready ? 'ready' : 'error', error ?? undefined);
    if (!ready) {
      // 区分错误来源：配置缺失 vs 初始化失败（如 native 模块加载失败、数据库错误等）
      // 避免误导用户以为 LLM 配置缺失，实际可能是 better-sqlite3 ABI 不匹配等问题
      const isConfigMissing = !error || error.includes('配置不完整') || error.includes('API Key');
      if (isConfigMissing) {
        // 首次启动引导：显示欢迎消息 + 自动跳转到设置面板
        // P3-FLOW-02 文案优化：提示用户先测试连接，避免配置错误导致初始化失败
        uiManager.appendMessage({
          role: 'system',
          content: '🎉 欢迎使用 Memora Sprite！\n\n首次使用需要配置 LLM 提供商和 API Key。\n已为您打开设置面板，请填写 LLM 配置后点击「测试连接」验证配置有效，再点击「保存」即可开始对话。\n\n推荐使用 DeepSeek（性价比高）或 OpenAI GPT-4o-mini。',
        });
      } else {
        // 初始化失败：显示具体错误信息，帮助用户定位问题
        // 常见原因：better-sqlite3 ABI 不匹配（需 electron-rebuild）、数据库 schema 损坏等
        uiManager.appendMessage({
          role: 'system',
          content: `⚠️ Agent 初始化失败\n\n错误信息：${error}\n\n可能的原因：\n• better-sqlite3 原生模块未正确编译（尝试运行 npm run rebuild）\n• 数据库文件损坏（可备份后删除 ~/.memora/memora.db 重试）\n• LLM 配置有误（请在设置面板检查并重新保存）\n\n请在设置面板重新保存 LLM 配置以触发重新初始化。`,
        });
      }
      // 自动切换到设置面板
      uiManager.switchPanel('settings');
      // 仍加载精灵配置，让用户能在设置面板中配置
      await settingsController.loadConfig();
      return;
    }
  } catch (err) {
    // agent-status 通道异常（主进程未就绪或网络错误），降级为首次使用引导
    console.warn('[init] 查询 Agent 状态失败，降级为首次使用引导:', err);
    // P3-FLOW-10 异常时状态指示器显示 unknown
    settingsController.updateAgentStatus('unknown', '检测中...');
    uiManager.appendMessage({
      role: 'system',
      content: '🎉 欢迎使用 Memora Sprite！\n\n首次使用需要配置 LLM 提供商和 API Key。\n已为您打开设置面板，请填写 LLM 配置后点击「测试连接」验证配置有效，再点击「保存」即可开始对话。\n\n推荐使用 DeepSeek（性价比高）或 OpenAI GPT-4o-mini。',
    });
    uiManager.switchPanel('settings');
    await settingsController.loadConfig();
    return;
  }

  // 加载初始数据
  await sessionController.loadSessionHistory();
  // FD-A1 加载会话列表（用于切换历史会话）
  void sessionController.loadSessionList();
  void memoryController.loadMemoryList();
  void personaController.loadPersonaList();
  void settingsController.loadConfig();
  void memoryController.loadDashboard();

  // 三态首次引导：Agent 就绪且首次使用时显示（介绍三态窗口模型 + 快捷键）
  // 使用 localStorage 标记，老用户不再显示
  if (uiManager.shouldShowOnboarding()) {
    uiManager.showOnboardingDialog();
  }
});

// ─── 清理资源 ─────────────────────────────────────────────

// 页面卸载时清理资源：UI 监听器 + IPC 监听器
// IPC 监听器若不清理，重新加载页面时会累积，导致同一事件触发多次
window.addEventListener('beforeunload', () => {
  uiManager?.cleanup();
  // 清理静默模式恢复定时器，避免定时器触发时操作已销毁的 DOM 或产生未捕获 rejection
  if (silentRecoveryTimer !== null) {
    window.clearTimeout(silentRecoveryTimer);
    silentRecoveryTimer = null;
  }
  // 清理 IPC 监听器（防止内存泄漏与重复触发）
  window.electronAPI?.removeStreamListeners();
  window.electronAPI?.removeSpriteOutputListener();
  window.electronAPI?.removeSpriteEventListener();
  window.electronAPI?.removeSpriteErrorListener();
  window.electronAPI?.removeAppErrorListener();
  window.electronAPI?.removeAgentReadyListener();
  window.electronAPI?.removeFloatUnreadListener();
  window.electronAPI?.removeWindowStateChangedListener();
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

    // FD-06 跨天续聊检测：当前会话日期与今天不一致时，自动切换到今天的同名会话
    const currentId = sessionController.getCurrentSessionId();
    if (currentId) {
      const todayPrefix = getLocalDate(); // UX-PP-07 本地日期，非 UTC
      const sessionDate = currentId.slice(0, 10); // 前 10 字符为日期
      if (sessionDate !== todayPrefix) {
        // 提取会话名（去除日期前缀和连字符）
        const sessionName = currentId.slice(11); // 跳过 YYYY-MM-DD-
        const todaySessionId = `${todayPrefix}-${sessionName}`;
        uiManager.showToast('已跨天，自动切换到今天的新会话', 'info');
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
  uiManager.onStopMessage(async () => {
    await window.electronAPI.abortChat();
    uiManager.stopAllStreaming();
  });

  // FD-05 新建会话回调
  // 设计：精灵默认推荐"一个对话走到底"（上下文只用前三轮），
  // 但用户可能需要主动切换会话以开启全新上下文。
  // 此处通过确认对话框防止误操作，新会话创建后清空对话区并显示系统消息。
  uiManager.onNewSession(async () => {
    // 防止流式输出中创建新会话（避免上下文混乱）
    if (uiManager.isStreaming()) {
      // IX-06 操作反馈走 toast
      uiManager.showToast('精灵正在回复中，请等待回复完成或点击停止后再新建会话', 'warning');
      return;
    }

    // 确认对话框：清空当前对话区是不可逆的（但历史保留在 SessionStore）
    // 使用自定义确认弹窗替代 window.confirm，提供一致的视觉体验
    const confirmed = await uiManager.showConfirmDialog({
      title: '开始新会话',
      message: '当前对话将保留在历史中，可随时切换回来查看。',
      confirmText: '开始新会话',
    });
    if (!confirmed) {
      return;
    }

    try {
      const result = await window.electronAPI.newSession();
      if (result.success) {
        // 清空对话区并显示新会话提示（新会话提示是对话内容，保留在 #messages）
        uiManager.clearMessages();
        uiManager.appendMessage({
          role: 'system',
          content: `✨ 新会话已开始（${result.sessionName ?? ''}）`,
        });
        // FD-A1 Gap 2 修复：新建会话后刷新会话列表，使新会话出现在下拉中
        void sessionController.loadSessionList();
      } else {
        // IX-06 失败反馈走 toast
        uiManager.showToast(`新建会话失败：${result.error ?? '未知错误'}`, 'error');
      }
    } catch (error) {
      reportError('onNewSession', error);
      uiManager.showToast(`新建会话失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
    }
  });

  // FD-A1 会话切换回调
  uiManager.setSessionSwitchCallback((sessionId: string) => {
    void sessionController.switchSession(sessionId);
  });

  // FD-09 会话删除回调
  uiManager.setSessionDeleteCallback((sessionId: string) => {
    void sessionController.deleteSession(sessionId);
  });

  // FD-09 会话重命名回调
  uiManager.setSessionRenameCallback((sessionId: string) => {
    void sessionController.renameSession(sessionId);
  });
}
