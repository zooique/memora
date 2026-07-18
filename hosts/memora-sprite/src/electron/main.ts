/**
 * Memora Sprite — Electron 主进程
 *
 * 职责：
 * - 窗口生命周期管理（三态：托盘/浮动/完整）
 * - 系统托盘 + 右键菜单
 * - Agent + Sprite 实例管理（复用 startSprite 初始化）
 * - IPC 通道注册与路由
 * - 主进程直接消费 agent.chat() 的流式输出
 * - 会话历史恢复与推送
 * - 对话中断（AbortController）
 *
 * 两阶段初始化：
 *   阶段 1：窗口 + 托盘（始终成功）
 *   阶段 2：Agent + Sprite（可能因配置缺失失败，窗口仍可显示错误信息）
 *
 * 零内核改动：Sprite 和 Agent 完全不知道运行在 CLI 还是 Electron 模式
 */

// 必须在最早期设置 UTF-8 编码，确保所有后续模块的 console/pino 输出中文不乱码
// Windows 控制台默认使用 GBK（CP936），Electron 继承此设置，导致 UTF-8 JSON 日志乱码
// 通过 app.commandLine 追加 --console-utf8 标志，让 Electron 强制使用 UTF-8 编码
// 注意：import 语句在 ES 模块中会被提升到文件顶部，因此 app.commandLine.appendSwitch
//       必须紧跟在第一条 import 之后、任何其他模块加载之前执行
import { app, ipcMain, screen, globalShortcut, powerMonitor, clipboard, Notification } from 'electron';
app.commandLine.appendSwitch('console-utf8');

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { toError, logger, safeSetTimeout, clearSafeTimeout } from 'memora';
import type { Agent } from 'memora';
import { WindowStateManager, DEFAULT_FLOAT_POSITION, FLOAT_SIZE, FULL_SIZE } from './windows/windowState.js';
import { TrayManager } from './trayIcon.js';
import { WindowManager } from './windows/windowManager.js';
// 快速输入浮窗（Phase 1 骨架）
import { QuickInputWindow, createDefaultConfirmCallback } from './windows/quickInputWindow.js';
import { ElectronInteraction } from './interaction.js';
import { registerIpcHandlers, type IpcContext } from './ipc/handlers.js';
import { scheduleSilentRecovery } from './ipc/configHandlers.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';
import { ELECTRON_DIR } from './esmShim.js';
import { registerMinimalIpcHandlers } from './ipc/minimalHandlers.js';
// AppRuntime 类型真理源在 ipc/types.ts
import type { AppRuntime } from './ipc/types.js';
// 精灵事件桥 + Agent 监听器提取到独立模块
import { setupSpriteEventListeners } from './spriteEventBridge.js';
import { setupConfigSuggestionListener, setupWriteConfirmationListener, setupAuditListener } from './agentListeners.js';
import type { AgentListenerDeps } from './agentListeners.js';
import type { SpriteEventBridgeDeps } from './spriteEventBridge.js';
import {
  startSprite,
  isLlmConfigured,
  DEFAULT_DATA_DIR,
  DEFAULT_CONFIG_DIR,
} from '../index.js';
import { loadSpriteConfig, saveSpriteConfig } from '../sprite/spriteConfig.js';
import type { Sprite } from '../sprite/sprite.js';
import { AuditManager } from '../sprite/audit/auditManager.js';
import { UsageStatsCollector } from '../sprite/usage/usageStatsCollector.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import { ShortcutManager, SHORTCUT_ACTIONS, DEFAULT_SHORTCUT_CONFIG } from './shortcuts.js';
// Phase 3.1：剪贴板三重保护处理器
import { ClipboardHandler } from './clipboardHandler.js';
import type { ClipboardEventType } from './clipboardHandler.js';
// isSensitive 用于快速输入记忆沉淀前的敏感内容过滤（与 clipboardHandler 剪贴板预填过滤对齐）
import { isSensitive } from './clipboardHandler.js';

// ─── 应用路径 ──────────────────────────────────────────────

/**
 * 托盘图标路径（16x16 简洁圆形设计，品牌色渐变）
 * 使用专门为系统托盘优化的小图标，避免复杂细节在 16x16 下糊成一团
 */
const TRAY_ICON_PATH = path.join(ELECTRON_DIR, '..', 'build', 'icons', 'tray.png');

// ─── 主进程状态 ──────────────────────────────────────────────

/**
 * 主进程核心状态（集中管理，对齐 renderer.ts State 先例）
 *
 * 17 个可变状态集中到一个对象，提升状态可见性，消除 minimalIpcState 代理层
 * （appState 结构兼容 MinimalIpcState 接口，直接作为 MinimalIpcState 传入 minimalHandlers）。
 *
 * 初始化时序：
 *   - windowStateManager/windowManager/interaction 在 initializeApp 阶段 1 赋值（null! 表示使用前必定赋值）
 *   - trayManager/shortcutManager 在阶段 1 赋值（可能为 null：无托盘环境降级）
 *   - agent/sprite/sessionStore/closeSprite 由 setAppRuntime 集中赋值（阶段 2 / reinitAgent）
 *   - auditManager/clipboardHandler 在 setupAgentReady / 阶段 2 赋值
 *   - currentAbortController/agentReady/initErrorDetail/unreadCount/currentDataDir 运行时可变
 *   - pendingWriteConfirmations 为 const Map 引用（M1 写入确认映射表）
 *   - isQuitting 防止 before-quit 重复清理
 */
const appState = {
  // ─── 窗口/托盘基础设施（阶段 1 初始化） ───
  /** 窗口状态管理器（三态切换 + 持久化） */
  windowStateManager: null! as WindowStateManager,
  /** 窗口管理器（完整窗口 + 浮动窗口） */
  windowManager: null! as WindowManager,
  /** 交互层（ElectronInteraction，注入主窗口引用） */
  interaction: null! as ElectronInteraction,
  /** 系统托盘管理器（无托盘环境降级为 null） */
  trayManager: null as TrayManager | null,

  // ─── Agent 运行时（setAppRuntime 集中管理：4 个变量总是一起变化） ───
  // AppRuntime 类型从 ipc/minimalHandlers.ts 导入，消除重复定义
  /** Agent + Sprite 实例（由 startSprite 初始化，可能为 null——配置缺失时） */
  agent: null as Agent | null,
  sprite: null as Sprite | null,
  sessionStore: null as SqliteSessionStore | null,
  /** 关闭函数（清理 Agent + Sprite 资源） */
  closeSprite: null as (() => Promise<void>) | null,

  // ─── 流式/状态 ───
  /** 当前对话的 AbortController（用于中断流式输出） */
  currentAbortController: null as AbortController | null,
  /** Agent 是否已就绪 */
  agentReady: false as boolean,
  /** 初始化失败的具体错误信息（agentReady=false 时有效，区分配置缺失 vs 其他错误） */
  initErrorDetail: null as string | null,

  // ─── 功能模块 ───
  /** M1 写入确认：等待渲染进程响应的 Promise resolver 映射表（requestId → resolve） */
  pendingWriteConfirmations: new Map<string, (confirmed: boolean) => void>(),
  /** M2 审计日志：宿主单例（在 setupAgentReady 中创建） */
  auditManager: null as AuditManager | null,
  /** AUDIT-5-1 使用统计采集器：默认关闭，需显式开启（在 setupAgentReady 中创建） */
  usageStatsCollector: null as UsageStatsCollector | null,
  /** Phase 3.3 全局快捷键管理器（在 initializeApp 阶段 1 创建） */
  shortcutManager: null as ShortcutManager | null,
  /** Phase 3.1 剪贴板处理器（在 setupAgentReady 后创建，注入 emit 回调转发到渲染进程） */
  clipboardHandler: null as ClipboardHandler | null,
  /** 快速输入浮窗（Phase 1 骨架：懒创建，快捷键 Ctrl+Shift+I 触发显示） */
  quickInputWindow: null as QuickInputWindow | null,

  // ─── 其他 ───
  /** 当前数据目录（initializeApp 初始化，reinitAgent 后更新） */
  currentDataDir: DEFAULT_DATA_DIR as string,
  /** LLM 配置缓存（用于判断是否需要重新初始化 Agent） */
  lastProvider: null as string | null,
  lastModel: null as string | null,
  lastBaseUrl: null as string | null,
  lastApiKey: null as string | null,
  /** 未读消息计数（完整窗口隐藏时累积，展开完整窗口时清零） */
  unreadCount: 0 as number,
  /** 防止 before-quit 重复触发清理 */
  isQuitting: false as boolean,
};

// ─── 全局异常兜底 ──────────────────────────────────────────
// 注册全局未捕获异常处理器，防止异步错误导致进程静默崩溃
// 场景：fire-and-forget 的 Promise（如 void handleUserInput）、
//       async 回调（如 security.onWriteConfirmation）中的未捕获异常
process.on('unhandledRejection', (reason) => {
  errorHandler.handle(reason, { code: ErrorCode.UNKNOWN, context: '全局未捕获的 Promise rejection' });
});
process.on('uncaughtException', (error) => {
  errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '全局未捕获异常' });
});

/**
 * 设置 Agent 运行时状态（第三季：封装 4 变量集中赋值）
 *
 * agent/sprite/sessionStore/closeSprite 在 3 处总是一起变化：
 * initializeApp 成功 / reinitAgent 成功 / reinitAgent 失败。
 * 提取为集中赋值函数，避免 4 个独立赋值遗漏。
 *
 * @param runtime 运行时实例，传 null 清空所有引用
 */
function setAppRuntime(runtime: AppRuntime | null): void {
  if (runtime) {
    appState.agent = runtime.agent;
    appState.sprite = runtime.sprite;
    appState.sessionStore = runtime.sessionStore;
    appState.closeSprite = runtime.close;
  } else {
    appState.agent = null;
    appState.sprite = null;
    appState.sessionStore = null;
    appState.closeSprite = null;
  }
}

// 精灵事件订阅管理已移至 spriteEventBridge.ts

/** 增加未读计数并推送到浮动窗口 */
function incrementUnreadCount(): void {
  appState.unreadCount++;
  appState.windowManager?.getFloatWindow()?.setUnreadCount(appState.unreadCount);
}

/** 清零未读计数并推送到浮动窗口 + 完整窗口 */
function resetUnreadCount(): void {
  appState.unreadCount = 0;
  appState.windowManager?.getFloatWindow()?.setUnreadCount(0);
  const fullWindow = appState.windowManager?.getFullWindow();
  if (fullWindow && !fullWindow.isDestroyed()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, 0);
  }
}

/**
 * 浮动窗口位置显示器边界校验
 *
 * 多显示器场景下，用户可能在扩展显示器上使用浮动窗口，关闭应用后断开外接显示器，
 * 下次启动时持久化的位置已不在任何显示器的工作区内，导致浮动窗口不可见。
 *
 * 校验逻辑：
 * - 遍历所有显示器的工作区（workArea），判断位置是否在某个显示器内
 * - 若越界，复位到默认位置（DEFAULT_FLOAT_POSITION）
 * - 浮动窗口尺寸为 80x80，校验时以窗口右下角为基准，确保完整窗口可见
 *
 * @param position 持久化的浮动窗口位置
 * @returns 校验后的安全位置
 */
function clampFloatPositionToDisplay(position: { x: number; y: number }): { x: number; y: number } {
  // 浮动窗口尺寸（引用 windowState.ts 的 FLOAT_SIZE，避免硬编码重复）
  const FLOAT_WIDTH = FLOAT_SIZE.width;
  const FLOAT_HEIGHT = FLOAT_SIZE.height;

  // 遍历所有显示器，判断位置是否在某个显示器的工作区内
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x, y, width, height } = display.workArea;
    // 窗口左上角 + 尺寸需完全落在工作区内
    if (position.x >= x && position.x + FLOAT_WIDTH <= x + width
      && position.y >= y && position.y + FLOAT_HEIGHT <= y + height) {
      return position; // 位置合法，原样返回
    }
  }

  // 越界：复位到主显示器默认位置
  logger.warn(`浮动窗口位置越界 (${position.x}, ${position.y})，复位到默认位置`);
  return { ...DEFAULT_FLOAT_POSITION };
}

/**
 * 完整窗口边界显示器校验
 *
 * 多显示器场景下，用户可能在扩展显示器上使用完整窗口，关闭应用后断开外接显示器，
 * 下次启动时持久化的边界已不在任何显示器的工作区内，导致完整窗口不可见
 * （任务栏无入口、托盘点击"显示完整窗口"也无反应），用户以为应用未启动。
 *
 * 校验逻辑与 clampFloatPositionToDisplay 一致：
 * - 遍历所有显示器的 workArea，判断 bounds 是否完全落在某个显示器内
 * - 越界时复位到主显示器居中位置 + 默认尺寸（FULL_SIZE）
 *
 * @param bounds 持久化的完整窗口边界
 * @returns 校验后的安全边界
 */
function clampFullWindowBoundsToDisplay(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    const { x, y, width, height } = display.workArea;
    // 窗口左上角 + 尺寸需完全落在工作区内
    if (bounds.x >= x && bounds.x + bounds.width <= x + width
      && bounds.y >= y && bounds.y + bounds.height <= y + height) {
      return bounds; // 边界合法，原样返回
    }
  }

  // 越界：复位到主显示器居中位置 + 默认尺寸
  // 主显示器 = screen.getPrimaryDisplay()，确保用户能找到窗口
  const primaryDisplay = screen.getPrimaryDisplay();
  const { workArea } = primaryDisplay;
  // 居中放置：工作区中心 - 窗口尺寸一半
  const centeredX = Math.max(workArea.x, workArea.x + Math.floor((workArea.width - FULL_SIZE.width) / 2));
  const centeredY = Math.max(workArea.y, workArea.y + Math.floor((workArea.height - FULL_SIZE.height) / 2));
  logger.warn(`完整窗口边界越界 (${bounds.x}, ${bounds.y})，复位到主显示器居中位置`);
  return { x: centeredX, y: centeredY, width: FULL_SIZE.width, height: FULL_SIZE.height };
}

/**
 * 快捷键动作中文名映射（用于注册失败通知的可读性）
 *
 * action 是开放字符串（ADR-004 基元驱动），未在映射表中的 action 回退到原始字符串。
 */
const SHORTCUT_ACTION_LABELS: Record<string, string> = {
  [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: '唤起/隐藏精灵窗口',
  [SHORTCUT_ACTIONS.QUICK_RECORD]: '快速记录',
  [SHORTCUT_ACTIONS.RECALL_MEMORY]: '召回记忆',
  [SHORTCUT_ACTIONS.QUICK_INPUT]: '快速输入浮窗',
};

/**
 * 通知用户快捷键注册失败
 *
 * 系统通知模式（与 spriteEventBridge proactivePrompt 通知一致）：
 * - 单条失败：直接列出"动作名（accelerator）"
 * - 多条失败：列出前 2 条 + "等 N 个快捷键"
 * - 0 条失败：不通知
 *
 * 通知点击行为：无（仅信息提示，用户需自行到设置面板修改快捷键）
 *
 * @param failures 注册失败列表（action + accelerator）
 */
function notifyShortcutRegistrationFailures(
  failures: ReadonlyArray<{ action: string; accelerator: string }>,
): void {
  if (failures.length === 0) return;
  if (!Notification.isSupported()) {
    // 系统不支持通知时降级为日志，确保可观测
    logger.warn({ failures }, '快捷键注册失败（系统不支持通知，仅记录日志）');
    return;
  }

  // 拼接失败快捷键的可读描述：动作中文名（accelerator）
  const items = failures.map(
    (f) => `${SHORTCUT_ACTION_LABELS[f.action] ?? f.action}（${f.accelerator}）`,
  );
  // 多条失败时只列前 2 条 + "等 N 个"，避免通知过长
  const body =
    items.length <= 2
      ? items.join('、')
      : `${items.slice(0, 2).join('、')} 等 ${items.length} 个快捷键`;

  const notification = new Notification({
    title: '快捷键被占用',
    body: `以下快捷键可能被其他应用占用：${body}。请到设置面板修改。`,
  });
  notification.show();
}

/**
 * 构建静默模式切换回调
 *
 * windowManager 和 trayManager 都需要注入 onToggleSilent / isSilentMode 回调，
 * 两者逻辑完全相同——切换配置 + 同步托盘状态 + 重建菜单。
 * 提取为工厂函数避免重复定义（DRY）。
 *
 * @param activeSprite 已就绪的 Sprite 实例（闭包捕获，避免非空断言）
 */
function createSilentModeCallbacks(activeSprite: Sprite): {
  onToggleSilent: (newSilent: boolean) => void;
  isSilentMode: () => boolean;
} {
  return {
    onToggleSilent: (newSilent: boolean) => {
      activeSprite.updateConfig('silentMode', newSilent);
      // 同步托盘状态（与 ipcHandlers.ts config-update 逻辑一致）
      appState.trayManager?.setState(newSilent ? 'sleeping' : 'idle');
      // 重建托盘菜单以反映静默模式勾选状态
      appState.trayManager?.updateMenu();
    },
    isSilentMode: () => activeSprite.getConfig().silentMode,
  };
}

/**
 * 构建 IPC 处理器上下文
 *
 * initializeApp 阶段 2 和 reinitAgent 路径都需要构造 IpcContext 注册完整 IPC。
 * 两者仅 agent/sprite/sessionStore 不同（来自不同的初始化结果），其余字段完全相同。
 * 提取为工厂函数避免 12 个字段的重复构造（DRY）。
 *
 * @param activeAgent 已就绪的 Agent 实例
 * @param activeSprite 已就绪的 Sprite 实例
 * @param activeSessionStore 已就绪的会话存储
 */
function createIpcContext(
  activeAgent: Agent,
  activeSprite: Sprite,
  activeSessionStore: SqliteSessionStore,
): IpcContext {
  return {
    agent: activeAgent,
    sprite: activeSprite,
    sessionStore: activeSessionStore,
    windowStateManager: appState.windowStateManager,
    windowManager: appState.windowManager,
    trayManager: appState.trayManager,
    // Phase 3.3：注入快捷键管理器供 configHandlers 触发热更新（可能为 null）
    shortcutManager: appState.shortcutManager,
    getAbortController: () => appState.currentAbortController,
    setAbortController: (ctrl: AbortController | null) => {
      appState.currentAbortController = ctrl;
    },
    // 暴露 agentReady 状态，handleUserInput 据此拒绝 reinitAgent 失败后的对话请求
    isAgentReady: () => appState.agentReady,
    getUnreadCount: () => appState.unreadCount,
    incrementUnreadCount,
    resetUnreadCount,
    usageStatsCollector: appState.usageStatsCollector,
  };
}

// ─── 错误分类辅助函数 ────────────────────────────────────────

/**
 * 将初始化错误信息分类为"配置缺失"或"初始化失败"
 *
 * 统一 initializeApp 和 reinitAgent 的错误分类逻辑，
 * 避免两处判断不一致导致渲染进程无法正确显示错误类型。
 *
 * @param errMessage 原始错误消息
 * @param prefix 错误前缀（initializeApp 用"初始化失败"，reinitAgent 用"重新初始化失败"）
 */
function classifyInitError(errMessage: string, prefix: string): string {
  // 配置缺失：LLM apiKey 为空
  return errMessage.includes('API Key 未配置') || errMessage.includes('配置不完整')
    ? '配置不完整，请在设置面板中配置 LLM 提供商和 API Key'
    : `${prefix}：${errMessage}`;
}

// ─── 应用启动 ───────────────────────────────────────────────

/**
 * Agent 就绪后初始化（共享函数）
 *
 * initializeApp 阶段 2 和 reinitAgent 成功后都需要执行相同的初始化步骤：
 * 注入交互层 → 注册完整 IPC → 订阅事件 → 注册监听器 → 更新回调 → 通知渲染进程。
 *
 * 提取为共享函数避免两处 ~40 行重复逻辑漂移。
 *
 * @param activeAgent 已就绪的 Agent 实例
 * @param activeSprite 已就绪的 Sprite 实例
 * @param activeSessionStore 已就绪的会话存储
 * @param dataDir 数据目录（用于审计管理器初始化）
 */
function setupAgentReady(
  activeAgent: Agent,
  activeSprite: Sprite,
  activeSessionStore: SqliteSessionStore,
  dataDir: string,
): void {
  // 0. 创建使用统计采集器（需在 IpcContext 创建前就绪，供 systemHandlers 访问）
  appState.usageStatsCollector = new UsageStatsCollector(dataDir);
  // 使用统计加载失败不阻塞启动，但需可观测（避免静默丢失统计基线）
  appState.usageStatsCollector.load().catch((err) => {
    logger.warn({ err }, '使用统计加载失败，将从头开始累积');
  });
  appState.usageStatsCollector.startAutoFlush();
  // AUDIT-5-4 隐私合规：根据配置开启采集（默认关闭）
  const usageStatsConfig = loadSpriteConfig();
  appState.usageStatsCollector.setEnabled(usageStatsConfig.usageStatsEnabled ?? false);

  // 1. 注册完整 IPC 处理器
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  const ipcContext = createIpcContext(activeAgent, activeSprite, activeSessionStore);
  registerIpcHandlers(ipcContext);

  // 3. 订阅精灵事件（主动提示分发）
  const spriteEventDeps: SpriteEventBridgeDeps = {
    sprite: activeSprite,
    windowManager: appState.windowManager,
    windowStateManager: appState.windowStateManager,
    trayManager: appState.trayManager,
    incrementUnreadCount,
  };
  setupSpriteEventListeners(spriteEventDeps);

  // 4. 注册配置建议 + 写入确认 + 审计日志监听器
  const agentListenerDeps: AgentListenerDeps = {
    windowManager: appState.windowManager,
    pendingWriteConfirmations: appState.pendingWriteConfirmations,
  };
  setupConfigSuggestionListener(activeAgent, agentListenerDeps);
  setupWriteConfirmationListener(activeAgent, agentListenerDeps);
  appState.auditManager = new AuditManager(dataDir);
  setupAuditListener(activeAgent, appState.auditManager);

  // 5. 补充注入浮动窗口 + 托盘右键菜单回调（需要 Agent 就绪后才能查询静默模式）
  appState.windowManager.updateFloatCallbacks({
    onHideToTray: () => {
      appState.windowStateManager.setShowFloatBubble(false);
      saveSpriteConfig({ showFloatBubble: false });
      appState.trayManager?.updateMenu();
    },
    onQuit: () => {
      appState.windowManager.setQuitting(true);
      appState.windowManager.closeAll();
      app.quit();
    },
    ...createSilentModeCallbacks(activeSprite),
  });
  appState.trayManager?.updateCallbacks(createSilentModeCallbacks(activeSprite));

  // 6. 绑定在场状态控制器（移入 setupAgentReady 确保 reinitAgent 后也重新绑定）
  // powerMonitor 和 app 是 Electron 内置模块，在 main 进程可用
  // PresenceController 监听锁屏/挂起/解锁/恢复 + 窗口焦点变化
  // 用户回来时触发 ProactiveEngine.checkPending() 检查累积事件
  activeSprite.bindPresence(powerMonitor, app);

  // 启动时检查静默模式是否已过期 + 启动主进程恢复定时器
  // 主进程兜底：托盘模式下渲染层不运行，原渲染层 setTimeout 会丢失
  const startConfig = activeSprite.getConfig();
  if (startConfig.silentMode && startConfig.silentModeExpiresAt) {
    const expiresAtMs = new Date(startConfig.silentModeExpiresAt).getTime();
    if (Number.isNaN(expiresAtMs) || Date.now() >= expiresAtMs) {
      // 已过期：立即关闭静默模式
      activeSprite.updateConfig('silentMode', false);
      activeSprite.updateConfig('silentModeExpiresAt', null);
      appState.trayManager?.setState('idle');
      appState.trayManager?.updateMenu();
    } else {
      // 未过期：启动主进程定时器，到期后自动恢复
      scheduleSilentRecovery(ipcContext);
    }
  }

  // 7. 标记就绪 + 通知渲染进程
  appState.agentReady = true;
  appState.initErrorDetail = null;
  const readyWindow = appState.windowManager.getFullWindow();
  readyWindow?.webContents.send(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, { ready: true });
}

async function initializeApp(): Promise<void> {
  // 安全：单实例锁
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const fullWindow = appState.windowManager?.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      if (fullWindow.isMinimized()) fullWindow.restore();
      fullWindow.focus();
    }
  });

  // ── 阶段 0：预检 LLM 配置 ──
  // 在窗口创建前检查，确保渲染进程加载时 initErrorDetail 已就绪
  // 避免渲染进程 getAgentStatus() 读到 null（时序竞争）
  const llmConfiguredEarly = await isLlmConfigured();
  if (!llmConfiguredEarly) {
    appState.initErrorDetail = classifyInitError('配置不完整，请在设置面板中配置 LLM 提供商和 API Key', '初始化失败');
  }

  // ── 阶段 1：创建窗口（始终成功） ──
  try {
    // 1. 加载精灵配置（从 dataDir/sprite.json，首次启动使用默认值）
    appState.currentDataDir = DEFAULT_DATA_DIR;
    const spriteConfig = loadSpriteConfig();

    // 2. 初始化窗口状态管理器
    const rawFloatPosition =
      spriteConfig.floatIconPosition.x === -1
        ? DEFAULT_FLOAT_POSITION // 首次启动使用默认位置
        : spriteConfig.floatIconPosition;
    // 浮动窗口位置显示器边界校验
    // 多显示器断开外接时，持久化的位置可能位于已不存在的显示器区域内
    // 校验位置是否在某个显示器的工作区内，越界则复位到主显示器默认位置
    const floatPosition = clampFloatPositionToDisplay(rawFloatPosition);
    appState.windowStateManager = new WindowStateManager({
      defaultState: spriteConfig.windowState,
      floatPosition,
      showFloatBubble: spriteConfig.showFloatBubble,
      // 持久化委托给 saveSpriteConfig（避免与 spriteConfig.ts 重复写文件）
      onSaveState: (data) => {
        saveSpriteConfig({
          windowState: data.windowState,
          floatIconPosition: data.floatPosition,
          showFloatBubble: data.showFloatBubble,
        });
      },
    });

    // 3. 创建窗口管理器并创建所有窗口
    appState.windowManager = new WindowManager(appState.windowStateManager, {
      onExpandToFull: resetUnreadCount,
    });

    // 不需要在此处再次调用 registerMinimalIpcHandlers()

    await appState.windowManager.createWindows();

    // 恢复窗口边界（上次关闭时的位置和大小）
    // 多显示器断开外接时，持久化的边界可能位于已不存在的显示器区域内
    // 校验边界是否在某个显示器的工作区内，越界则复位到主显示器居中位置
    const fullWindow = appState.windowManager.getFullWindow();
    if (fullWindow && spriteConfig.windowBounds) {
      const safeBounds = clampFullWindowBoundsToDisplay(spriteConfig.windowBounds);
      fullWindow.setBounds(safeBounds);
    }

    // 监听窗口 resize/move 事件，持久化边界（防抖 500ms）
    if (fullWindow) {
      let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
      const saveBounds = () => {
        // 窗口可能已销毁，getBounds 前检查 isDestroyed
        if (fullWindow.isDestroyed()) return;
        const bounds = fullWindow.getBounds();
        saveSpriteConfig({
          windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      };
      fullWindow.on('resize', () => {
        if (boundsSaveTimer) clearSafeTimeout(boundsSaveTimer);
        boundsSaveTimer = safeSetTimeout(saveBounds, 500);
      });
      fullWindow.on('move', () => {
        if (boundsSaveTimer) clearSafeTimeout(boundsSaveTimer);
        boundsSaveTimer = safeSetTimeout(saveBounds, 500);
      });
      // 窗口销毁时清理防抖定时器，避免定时器触发时操作已销毁窗口
      fullWindow.on('closed', () => {
        if (boundsSaveTimer) {
          clearSafeTimeout(boundsSaveTimer);
          boundsSaveTimer = null;
        }
      });
    }

    // 4. 创建托盘
    // 包裹 try/catch，无系统托盘环境（headless Linux/某些 Wayland 会话/远程桌面）
    // 下 new Tray() 会抛异常，此处降级为 null（无托盘模式），应用仍可正常运行窗口模式
    const iconPath = await fs
      .access(TRAY_ICON_PATH)
      .then(() => TRAY_ICON_PATH)
      .catch(() => '');
    try {
      appState.trayManager = new TrayManager(iconPath, {
        onShowFull: () => {
          appState.windowStateManager.transition('full');
          // 从托盘展开完整窗口时清零未读计数
          resetUnreadCount();
        },
        onToggleFloatBubble: (checked: boolean) => {
          appState.windowStateManager.setShowFloatBubble(checked);
          // 同步持久化到 spriteConfig
          saveSpriteConfig({ showFloatBubble: checked });
          // 重建托盘菜单以反映勾选状态
          appState.trayManager?.updateMenu();
        },
        isFloatBubbleVisible: () => appState.windowStateManager.getShowFloatBubble(),
        onHideToTray: () => appState.windowStateManager.transition('tray'),
        onQuit: () => {
          appState.windowManager.closeAll();
          app.quit();
        },
      });
    } catch (error) {
      // 降级为无托盘模式：应用仍可通过窗口和快捷键正常使用
      errorHandler.handle(error, {
        code: ErrorCode.UNKNOWN,
        context: '托盘创建失败，降级为无托盘模式',
      });
      appState.trayManager = null;
    }

    // 5. 初始化交互层
    appState.interaction = new ElectronInteraction();
    const mainWindowForInteraction = appState.windowManager.getFullWindow();
    if (mainWindowForInteraction) {
      appState.interaction.setMainWindow(mainWindowForInteraction);
    }

    // 6. 窗口创建完成，显示初始状态对应的窗口
    // 使用 showInitial() 而非 transition()——transition 在 state 已等于 target 时早返回，
    // 会导致首次启动窗口不显示（构造函数已设置 defaultState）
    appState.windowStateManager.showInitial();

    // 7. Phase 3.3 初始化全局快捷键
    // 在窗口创建后、Agent 初始化前注册，确保快捷键尽早可用
    // toggle-window 动作委托给 windowManager.toggleWindow()
    // quick-record / recall-memory 动作：先确保完整窗口可见，再推送触发事件到渲染进程
    appState.shortcutManager = new ShortcutManager(globalShortcut, {
      config: spriteConfig.shortcuts ?? DEFAULT_SHORTCUT_CONFIG,
      handlers: {
        [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: () => {
          appState.windowManager.toggleWindow();
        },
        [SHORTCUT_ACTIONS.QUICK_RECORD]: () => {
          // 确保完整窗口可见（从托盘/浮动切换到完整窗口）
          appState.windowManager.showFullWindow();
          const fullWindow = appState.windowManager.getFullWindow();
          if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.focus();
            // 推送触发事件到渲染进程（聚焦输入框进入快速记录模式）
            fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_RECORD_TRIGGER);
          }
        },
        [SHORTCUT_ACTIONS.RECALL_MEMORY]: () => {
          // 确保完整窗口可见（从托盘/浮动切换到完整窗口）
          appState.windowManager.showFullWindow();
          const fullWindow = appState.windowManager.getFullWindow();
          if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.focus();
            // 推送触发事件到渲染进程（切换到记忆面板）
            fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.RECALL_MEMORY_TRIGGER);
          }
        },
        [SHORTCUT_ACTIONS.QUICK_INPUT]: () => {
          // 显示快速输入浮窗（独立于完整窗口，不切换窗口状态机）
          // quickInputWindow 在 setupAgentReady 后创建（依赖 clipboardHandler 注入确认回调）
          if (appState.quickInputWindow) {
            appState.quickInputWindow.show();
          }
        },
      },
    });
    appState.shortcutManager.registerAll();
    // 通知用户快捷键注册失败（被其他应用占用）
    // ADR-SP-017 §快捷键管理器 设计原则第 4 条：注册失败时提示用户
    // 否则用户按了没反应会困惑，无法定位是快捷键被占用还是应用未响应
    notifyShortcutRegistrationFailures(appState.shortcutManager.getRegistrationFailures());
  } catch (error) {
    // 窗口创建失败是致命错误
    errorHandler.handle(error, {
      code: ErrorCode.WINDOW_CREATE_FAILED,
      context: '窗口创建失败',
    });
    app.quit();
    return;
  }

  // ── 阶段 2：初始化 Agent + Sprite（可能因配置缺失跳过） ──

  // 先注册不依赖 Agent 的资源（剪贴板保护/快速输入浮窗/技能安装）
  // 无论 LLM 配置是否存在都执行，用户在配置 API 前仍可使用快速输入浮窗的粘贴功能
  // 回调中通过可选链（?.）安全降级：无 Agent 时记忆写入和润色跳过
  setupAgentIndependentResources();

  try {
    // 预检结果已在阶段 0 设置（initErrorDetail），此处复用避免重复读取
    if (!llmConfiguredEarly) {
      return;
    }

    // 有配置：走完整 Agent 初始化流程
    // startSprite 内部 loadConfig 读取配置，失败时抛 SpriteError(CONFIG_LOAD_FAILED)
    const spriteResult = await startSprite();
    appState.currentDataDir = spriteResult.dataDir;
    // 第三季：集中赋值 agent/sprite/sessionStore/closeSprite
    setAppRuntime({
      agent: spriteResult.agent,
      sprite: spriteResult.sprite,
      sessionStore: spriteResult.sessionStore,
      close: spriteResult.close,
    });

    // 第一季：Agent 就绪后初始化（共享函数，reinitAgent 路径复用）
    // bindPresence 已移入 setupAgentReady，确保 reinitAgent 后也重新绑定
    setupAgentReady(appState.agent!, appState.sprite!, appState.sessionStore!, appState.currentDataDir);
  } catch (error) {
    // Agent 初始化失败——窗口已显示，向用户展示错误信息
    // 最小化 IPC 处理器已在阶段 1 注册，此处无需重复注册
    const errMessage = toError(error).message;
    // 使用统一分类函数，确保与 reinitAgent 逻辑一致
    appState.initErrorDetail = classifyInitError(errMessage, '初始化失败');
    errorHandler.handle(error, {
      code: ErrorCode.INITIALIZATION_FAILED,
      context: 'Agent 初始化失败',
    });
  }
}

/**
 * 注册不依赖 Agent 的资源
 *
 * 包括：剪贴板三重保护、快速输入浮窗、技能安装 IPC handler。
 * 这些资源不依赖 Agent 实例，回调中通过可选链（?.）安全降级。
 * 无论 LLM 配置是否存在都执行，用户在配置 API 前仍可使用快速输入浮窗的粘贴功能。
 * 配置成功后 reinitAgent 走 setupAgentReady，无需重建这些资源。
 */
function setupAgentIndependentResources(): void {
  // Phase 3.1：集成剪贴板三重保护
  // ClipboardHandler 依赖注入 clipboard 模块，emit 回调将事件转发到渲染进程
  // 轮询检测剪贴板变化（仅哈希比较，不读取内容），用户主动调用 analyze() 时才读取内容
  appState.clipboardHandler = new ClipboardHandler(clipboard, {
    emit: (event: ClipboardEventType, payload?: unknown) => {
      const fullWindow = appState.windowManager.getFullWindow();
      if (!fullWindow || fullWindow.isDestroyed()) return;
      // 将 ClipboardHandler 事件映射到 IPC 推送通道
      switch (event) {
        case 'changed': {
          // 读取剪贴板构造 {preview, length} payload，渲染层据此加入待处理列表 + 角标 +1
          // clipboardHandler 已通过哈希比较确认剪贴板有变化，此处读取的是最新内容
          const text = clipboard.readText();
          // 空内容（如复制图片时 readText 返回空串）跳过通知，避免空条目进入待处理列表
          if (text.length === 0) break;
          const changedPayload = {
            preview: text.slice(0, 100),
            length: text.length,
          };
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_CHANGED, changedPayload);
          break;
        }
        case 'sensitive-ignored':
          // 敏感内容已静默忽略，通知 UI 记录日志（携带 type）
          fullWindow.webContents.send(
            MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_SENSITIVE_IGNORED,
            payload,
          );
          break;
        case 'analysis-ready':
          // 内容已通过检测，通知 UI 展示确认对话框（携带 content）
          fullWindow.webContents.send(
            MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_READY,
            payload,
          );
          break;
        case 'analysis-rejected':
          // 内容被输入护栏拦截，通知 UI 提示原因（携带 reason）
          fullWindow.webContents.send(
            MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_REJECTED,
            payload,
          );
          break;
      }
    },
  });
  // 注册 IPC 处理器：渲染进程调用 clipboard-analyze 触发主动分析
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_ANALYZE, () => {
    return appState.clipboardHandler?.analyze() ?? false;
  });
  // 启动剪贴板变化检测轮询
  appState.clipboardHandler.startPolling();

  // 快速输入浮窗：注入 clipboardHandler 用于确认时抑制三重保护
  // 在 clipboardHandler 创建后实例化，确保 onConfirm 回调能调用 suppressNextChange()
  // onAfterConfirm 用于记忆沉淀：确认成功后异步写入 source:'quick-input' 记忆
  appState.quickInputWindow = new QuickInputWindow({
    onConfirm: createDefaultConfirmCallback(appState.clipboardHandler),
    onAfterConfirm: (text) => {
      try {
        // 敏感内容过滤（与 clipboardHandler 剪贴板预填过滤对齐）
        // 用户手动输入的 Token/密码/私钥等不应持久化到记忆数据库
        const sensitiveResult = isSensitive(text);
        if (sensitiveResult.sensitive) {
          // 命中敏感模式：跳过记忆沉淀，仅记日志（type 用于追溯命中模式）
          logger.warn({ type: sensitiveResult.type }, '快速输入内容命中敏感模式，已跳过记忆沉淀');
          return;
        }
        // name 用内容前 30 字符（与剪贴板记忆范式一致），upsertMemory 按 (source, name) 去重
        const name = text.slice(0, 30).replace(/\s+/g, ' ').trim() || '快速输入';
        // 无 Agent 时 sprite 为 null，可选链安全降级（跳过记忆写入）
        appState.sprite?.upsertMemory('quick-input', name, text);
      } catch (error) {
        // 记忆写入失败仅记日志，不影响用户已拿到的剪贴板内容
        logger.warn({ error }, '快速输入记忆写入失败');
      }
    },
    onPolish: async (text) => {
      // 调用内核 TextPolishManager（agent.polish getter），
      // 润色失败时返回原文（降级，不阻塞用户操作）
      // 无 Agent 时 polisher 为 undefined，返回原文不阻塞用户操作
      const polisher = appState.agent?.polish;
      if (!polisher) return { polished: text, changed: false };
      try {
        return await polisher.polish(text);
      } catch (error) {
        logger.warn({ error }, '快速输入润色失败');
        return { polished: text, changed: false };
      }
    },
  });
  // Phase 4：注入剪贴板三重保护抑制函数（自动粘贴流程的 suppressNextChange 需要）
  appState.quickInputWindow.setSuppressNextChange(
    () => appState.clipboardHandler?.suppressNextChange(),
  );
  // 预加载 nut-js（fire-and-forget）：消除首次快捷键唤起浮窗时的动态 import 延迟
  appState.quickInputWindow.preloadInputInjector();

  // Phase 4.3：注册技能文件安装 IPC handler
  // 渲染进程拖入 .md 文件后调用，校验并写入 configDir/skills/
  ipcMain.handle(IPC_CHANNELS.SKILL_INSTALL, async (_event, fileName: string, content: string) => {
    const { installSkill } = await import('../sprite/skillInstaller.js');
    // configDir 默认为 ~/.memora-sprite/config/，与 Agent 初始化时一致
    const configDir = DEFAULT_CONFIG_DIR;
    const result = await installSkill(content, fileName, configDir);
    // 事件驱动重载：技能文件写入后立即热重载，当前会话生效（无需重启 Agent）
    // 无 Agent 时跳过热重载（hotReloaded 保持 undefined），用户配置后 reinitAgent 会读取已安装的技能
    if (result.success && appState.agent) {
      try {
        await appState.agent.reloadConfig('skill');
        // 热重载成功：技能当前会话立即生效
        result.hotReloaded = true;
      } catch (err) {
        // 热重载失败（如对话繁忙 chatBusyError）：文件已写入磁盘，下次重启 Agent 时生效
        // 不阻塞安装结果返回，但需将失败原因透传给 UI，让用户知道当前会话未生效
        const errMsg = toError(err).message;
        result.hotReloaded = false;
        result.hotReloadError = errMsg;
        errorHandler.handle(err, { code: ErrorCode.UNKNOWN, context: '技能热重载失败' });
      }
    }
    return result;
  });
}

// ─── 最小化 IPC 处理器 ──────────────────────────────────────

// 消除 MinimalIpcState 代理层，appState 结构兼容 MinimalIpcState 接口，
// 直接传入即可（结构子类型：appState 是 MinimalIpcState 的超集，TS 自动兼容）。
// minimalHandlers 通过 state.xxx 读写直接作用于 appState，无需 getter/setter 代理。

// 调用提取后的函数（在 initializeApp 阶段 1 中调用）
registerMinimalIpcHandlers(appState, {
  setAppRuntime,
  setupAgentReady,
  classifyInitError,
  getCurrentAgent: () => appState.agent,
  getCurrentSprite: () => appState.sprite,
});

// ─── 应用生命周期 ─────────────────────────────────────────

// initializeApp 内部两阶段均有 try-catch，但阶段 2 的 catch 块调用 registerMinimalIpcHandlers()
// 若该函数抛错会变成 unhandled rejection，追加 .catch 兜底
app.whenReady().then(initializeApp).catch((error) => {
  errorHandler.handle(error, {
    code: ErrorCode.UNKNOWN,
    context: '应用启动失败（initializeApp 未捕获异常）',
  });
});

app.on('window-all-closed', () => {
  // 不退出——托盘常驻
});

app.on('activate', () => {
  appState.windowStateManager?.transition('full');
});

app.on('before-quit', async (e) => {
  // 防止重复清理
  if (appState.isQuitting) return;
  appState.isQuitting = true;

  // 标记窗口管理器正在退出，允许窗口真正关闭（而非 preventDefault 转为浮动）
  appState.windowManager?.setQuitting(true);

  // 阻止立即退出，先清理资源
  e.preventDefault();

  try {
    // 先中断进行中的对话，避免 agent.close() 在对话进行中调用
    // 导致 AsyncGenerator 未正常退出、资源泄漏或状态不一致
    if (appState.currentAbortController) {
      appState.currentAbortController.abort();
      appState.currentAbortController = null;
    }
    // Phase 3.3：注销全局快捷键，避免退出后残留占用
    appState.shortcutManager?.unregisterAll();
    appState.shortcutManager = null;
    // Phase 3.1：停止剪贴板轮询，清理定时器
    appState.clipboardHandler?.stopPolling();
    appState.clipboardHandler = null;
    // 销毁快速输入浮窗，清理 IPC handler 和定时器
    appState.quickInputWindow?.destroy();
    appState.quickInputWindow = null;
    // AUDIT-5-2：使用统计退出时写入 + 停止定时器
    appState.usageStatsCollector?.stopAutoFlush();
    await appState.usageStatsCollector?.flush();
    appState.usageStatsCollector = null;
    if (appState.closeSprite) {
      await appState.closeSprite();
    }
    // 显式销毁托盘，清理 pulseTimer（setInterval）避免退出前再触发 setToolTip
    appState.trayManager?.destroy();
  } catch (error) {
    errorHandler.handle(error, {
      code: ErrorCode.UNKNOWN,
      context: '应用关闭清理失败',
    });
  } finally {
    app.exit(0);
  }
});
