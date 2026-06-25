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
import { app, ipcMain, screen, globalShortcut, powerMonitor, clipboard } from 'electron';
app.commandLine.appendSwitch('console-utf8');

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { toError, logger, safeSetTimeout, clearSafeTimeout } from 'memora';
import type { Agent } from 'memora';
import { WindowStateManager, DEFAULT_FLOAT_POSITION, FLOAT_SIZE } from './windows/windowState.js';
import { TrayManager } from './trayIcon.js';
import { WindowManager } from './windows/windowManager.js';
import { ElectronInteraction } from './interaction.js';
import { registerIpcHandlers, type IpcContext } from './ipc/handlers.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';
import { ELECTRON_DIR } from './esmShim.js';
// D-04 修复：最小化 IPC 处理器提取到独立模块
import { registerMinimalIpcHandlers, type MinimalIpcState } from './ipc/minimalHandlers.js';
// P2-DESIGN-4 修复：精灵事件桥 + Agent 监听器提取到独立模块
import { setupSpriteEventListeners } from './spriteEventBridge.js';
import { setupConfigSuggestionListener, setupWriteConfirmationListener, setupAuditListener } from './agentListeners.js';
import type { AgentListenerDeps } from './agentListeners.js';
import type { SpriteEventBridgeDeps } from './spriteEventBridge.js';
import {
  startSprite,
  DEFAULT_DATA_DIR,
  DEFAULT_CONFIG_DIR,
} from '../index.js';
import { loadSpriteConfig, saveSpriteConfig } from '../sprite/spriteConfig.js';
import type { Sprite } from '../sprite/sprite.js';
import { AuditManager } from '../sprite/audit/auditManager.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import { ShortcutManager, SHORTCUT_ACTIONS, DEFAULT_SHORTCUT_CONFIG } from './shortcuts.js';
// Phase 3.1：剪贴板三重保护处理器
import { ClipboardHandler } from './clipboardHandler.js';
import type { ClipboardEventType } from './clipboardHandler.js';

// ─── 应用路径 ──────────────────────────────────────────────

const RESOURCES_DIR = path.join(ELECTRON_DIR, '../../resources');
const TRAY_ICON_PATH = path.join(RESOURCES_DIR, 'tray-icon.png');

// ─── 主进程状态 ──────────────────────────────────────────────

let windowStateManager: WindowStateManager;
let windowManager: WindowManager;
let interaction: ElectronInteraction;
let trayManager: TrayManager | null = null;

/** Agent 运行时状态（4 个变量总是一起变化，通过 setAppRuntime 集中管理） */
// D-04 修复：AppRuntime 类型与 ipc/minimalHandlers.ts 共享定义
interface AppRuntime {
  agent: Agent;
  sprite: Sprite;
  sessionStore: SqliteSessionStore;
  close: () => Promise<void>;
}

/** Agent + Sprite 实例（由 startSprite 初始化，可能为 null——配置缺失时） */
let agent: Agent | null = null;
let sprite: Sprite | null = null;
let sessionStore: SqliteSessionStore | null = null;
/** 关闭函数（清理 Agent + Sprite 资源） */
let closeSprite: (() => Promise<void>) | null = null;

// ─── 全局异常兜底 ──────────────────────────────────────────
// P2-GLOBAL-01 注册全局未捕获异常处理器，防止异步错误导致进程静默崩溃
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
    agent = runtime.agent;
    sprite = runtime.sprite;
    sessionStore = runtime.sessionStore;
    closeSprite = runtime.close;
  } else {
    agent = null;
    sprite = null;
    sessionStore = null;
    closeSprite = null;
  }
}

/** 当前对话的 AbortController（用于中断流式输出） */
let currentAbortController: AbortController | null = null;

/** Agent 是否已就绪 */
let agentReady = false;

/** 初始化失败的具体错误信息（agentReady=false 时有效，用于区分配置缺失 vs 其他初始化错误） */
let initErrorDetail: string | null = null;

/** M1 写入确认：等待渲染进程响应的 Promise resolver 映射表（requestId → resolve） */
const pendingWriteConfirmations = new Map<string, (confirmed: boolean) => void>();

/** M2 审计日志：宿主单例（在 initializeApp 中创建） */
let auditManager: AuditManager | null = null;

/** Phase 3.3 全局快捷键管理器（在 initializeApp 中创建） */
let shortcutManager: ShortcutManager | null = null;

/** Phase 3.1 剪贴板处理器（在 setupAgentReady 后创建，注入 emit 回调转发到渲染进程） */
let clipboardHandler: ClipboardHandler | null = null;

// P2-DESIGN-4 修复：精灵事件订阅管理已移至 spriteEventBridge.ts

/** 当前数据目录（initializeApp 初始化，reinitAgent 后更新） */
let currentDataDir: string = DEFAULT_DATA_DIR;

/** 未读消息计数（完整窗口隐藏时累积，展开完整窗口时清零） */
let unreadCount = 0;

/** 增加未读计数并推送到浮动窗口 */
function incrementUnreadCount(): void {
  unreadCount++;
  windowManager?.getFloatWindow()?.setUnreadCount(unreadCount);
}

/** 清零未读计数并推送到浮动窗口 + 完整窗口 */
function resetUnreadCount(): void {
  unreadCount = 0;
  windowManager?.getFloatWindow()?.setUnreadCount(0);
  const fullWindow = windowManager?.getFullWindow();
  if (fullWindow && !fullWindow.isDestroyed()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, 0);
  }
}

/**
 * P2-HIS-01 浮动窗口位置显示器边界校验
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
  logger.warn(`[P2-HIS-01] 浮动窗口位置越界 (${position.x}, ${position.y})，复位到默认位置`);
  return { ...DEFAULT_FLOAT_POSITION };
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
      trayManager?.setState(newSilent ? 'sleeping' : 'idle');
      // 重建托盘菜单以反映静默模式勾选状态
      trayManager?.updateMenu();
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
    windowStateManager,
    windowManager,
    trayManager,
    getAbortController: () => currentAbortController,
    setAbortController: (ctrl: AbortController | null) => {
      currentAbortController = ctrl;
    },
    // P1 修复：暴露 agentReady 状态，handleUserInput 据此拒绝 reinitAgent 失败后的对话请求
    isAgentReady: () => agentReady,
    getUnreadCount: () => unreadCount,
    incrementUnreadCount,
    resetUnreadCount,
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
 * 提取为共享函数避免两处 ~40 行重复逻辑漂移（P2-DESIGN-1 第一季）。
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
  // 1. 注册完整 IPC 处理器
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  const ipcContext = createIpcContext(activeAgent, activeSprite, activeSessionStore);
  registerIpcHandlers(ipcContext);

  // 3. 订阅精灵事件（主动提示分发）
  const spriteEventDeps: SpriteEventBridgeDeps = {
    sprite: activeSprite,
    windowManager,
    windowStateManager,
    trayManager,
    incrementUnreadCount,
  };
  setupSpriteEventListeners(spriteEventDeps);

  // 4. 注册配置建议 + 写入确认 + 审计日志监听器
  const agentListenerDeps: AgentListenerDeps = {
    windowManager,
    pendingWriteConfirmations,
  };
  setupConfigSuggestionListener(activeAgent, agentListenerDeps);
  setupWriteConfirmationListener(activeAgent, agentListenerDeps);
  auditManager = new AuditManager(dataDir);
  setupAuditListener(activeAgent, auditManager);

  // 5. 补充注入浮动窗口 + 托盘右键菜单回调（需要 Agent 就绪后才能查询静默模式）
  windowManager.updateFloatCallbacks({
    onHideToTray: () => {
      windowStateManager.setShowFloatBubble(false);
      saveSpriteConfig({ showFloatBubble: false });
      trayManager?.updateMenu();
    },
    onQuit: () => {
      windowManager.setQuitting(true);
      windowManager.closeAll();
      app.quit();
    },
    ...createSilentModeCallbacks(activeSprite),
  });
  trayManager?.updateCallbacks(createSilentModeCallbacks(activeSprite));

  // 6. 标记就绪 + 通知渲染进程
  agentReady = true;
  initErrorDetail = null;
  const readyWindow = windowManager.getFullWindow();
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
    const fullWindow = windowManager?.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      if (fullWindow.isMinimized()) fullWindow.restore();
      fullWindow.focus();
    }
  });

  // ── 阶段 1：创建窗口（始终成功） ──
  try {
    // 1. 加载精灵配置（从 dataDir/sprite.json，首次启动使用默认值）
    currentDataDir = DEFAULT_DATA_DIR;
    const spriteConfig = loadSpriteConfig();

    // 2. 初始化窗口状态管理器
    const rawFloatPosition =
      spriteConfig.floatIconPosition.x === -1
        ? DEFAULT_FLOAT_POSITION // 首次启动使用默认位置
        : spriteConfig.floatIconPosition;
    // P2-HIS-01 浮动窗口位置显示器边界校验
    // 多显示器断开外接时，持久化的位置可能位于已不存在的显示器区域内
    // 校验位置是否在某个显示器的工作区内，越界则复位到主显示器默认位置
    const floatPosition = clampFloatPositionToDisplay(rawFloatPosition);
    windowStateManager = new WindowStateManager({
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
    windowManager = new WindowManager(windowStateManager, {
      onExpandToFull: resetUnreadCount,
    });

    // D-04 修复：最小化 IPC 处理器已在模块加载时注册（见上文 minimalIpcState 定义处）
    // 不需要在此处再次调用 registerMinimalIpcHandlers()

    await windowManager.createWindows();

    // FD-05 恢复窗口边界（上次关闭时的位置和大小）
    const fullWindow = windowManager.getFullWindow();
    if (fullWindow && spriteConfig.windowBounds) {
      const { x, y, width, height } = spriteConfig.windowBounds;
      fullWindow.setBounds({ x, y, width, height });
    }

    // FD-05 监听窗口 resize/move 事件，持久化边界（防抖 500ms）
    if (fullWindow) {
      let boundsSaveTimer: ReturnType<typeof setTimeout> | null = null;
      const saveBounds = () => {
        // P2-CODE-2 修复：窗口可能已销毁，getBounds 前检查 isDestroyed
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
      // P2-CODE-2 修复：窗口销毁时清理防抖定时器，避免定时器触发时操作已销毁窗口
      fullWindow.on('closed', () => {
        if (boundsSaveTimer) {
          clearSafeTimeout(boundsSaveTimer);
          boundsSaveTimer = null;
        }
      });
    }

    // 4. 创建托盘
    const iconPath = await fs
      .access(TRAY_ICON_PATH)
      .then(() => TRAY_ICON_PATH)
      .catch(() => '');
    trayManager = new TrayManager(iconPath, {
      onShowFull: () => {
        windowStateManager.transition('full');
        // 从托盘展开完整窗口时清零未读计数
        resetUnreadCount();
      },
      onToggleFloatBubble: (checked: boolean) => {
        windowStateManager.setShowFloatBubble(checked);
        // 同步持久化到 spriteConfig
        saveSpriteConfig({ showFloatBubble: checked });
        // 重建托盘菜单以反映勾选状态
        trayManager?.updateMenu();
      },
      isFloatBubbleVisible: () => windowStateManager.getShowFloatBubble(),
      onHideToTray: () => windowStateManager.transition('tray'),
      onQuit: () => {
        windowManager.closeAll();
        app.quit();
      },
    });

    // 5. 初始化交互层
    interaction = new ElectronInteraction();
    const mainWindowForInteraction = windowManager.getFullWindow();
    if (mainWindowForInteraction) {
      interaction.setMainWindow(mainWindowForInteraction);
    }

    // 6. 窗口创建完成，显示初始状态对应的窗口
    // 使用 showInitial() 而非 transition()——transition 在 state 已等于 target 时早返回，
    // 会导致首次启动窗口不显示（构造函数已设置 defaultState）
    windowStateManager.showInitial();

    // 7. Phase 3.3 初始化全局快捷键
    // 在窗口创建后、Agent 初始化前注册，确保快捷键尽早可用
    // toggle-window 动作委托给 windowManager.toggleWindow()
    // quick-record / recall-memory 动作：先确保完整窗口可见，再推送触发事件到渲染进程
    shortcutManager = new ShortcutManager(globalShortcut, {
      config: spriteConfig.shortcuts ?? DEFAULT_SHORTCUT_CONFIG,
      handlers: {
        [SHORTCUT_ACTIONS.TOGGLE_WINDOW]: () => {
          windowManager.toggleWindow();
        },
        [SHORTCUT_ACTIONS.QUICK_RECORD]: () => {
          // 确保完整窗口可见（从托盘/浮动切换到完整窗口）
          windowManager.showFullWindow();
          const fullWindow = windowManager.getFullWindow();
          if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.focus();
            // 推送触发事件到渲染进程（聚焦输入框进入快速记录模式）
            fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_RECORD_TRIGGER);
          }
        },
        [SHORTCUT_ACTIONS.RECALL_MEMORY]: () => {
          // 确保完整窗口可见（从托盘/浮动切换到完整窗口）
          windowManager.showFullWindow();
          const fullWindow = windowManager.getFullWindow();
          if (fullWindow && !fullWindow.isDestroyed()) {
            fullWindow.focus();
            // 推送触发事件到渲染进程（切换到记忆面板）
            fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.RECALL_MEMORY_TRIGGER);
          }
        },
      },
    });
    shortcutManager.registerAll();
  } catch (error) {
    // 窗口创建失败是致命错误
    errorHandler.handle(error, {
      code: ErrorCode.WINDOW_CREATE_FAILED,
      context: '窗口创建失败',
    });
    app.quit();
    return;
  }

  // ── 阶段 2：初始化 Agent + Sprite（可能因配置缺失失败） ──
  try {
    // startSprite 配置缺失时统一抛错（无 skipWizard 选项）
    // Electron 模式：阶段 1 已注册 registerMinimalIpcHandlers，
    // 阶段 2 失败后渲染进程可显示设置面板引导用户配置
    const spriteResult = await startSprite();
    currentDataDir = spriteResult.dataDir;
    // 第三季：集中赋值 agent/sprite/sessionStore/closeSprite
    setAppRuntime({
      agent: spriteResult.agent,
      sprite: spriteResult.sprite,
      sessionStore: spriteResult.sessionStore,
      close: spriteResult.close,
    });

    // 第一季：Agent 就绪后初始化（共享函数，reinitAgent 路径复用）
    setupAgentReady(agent!, sprite!, sessionStore!, currentDataDir);

    // Phase 3.2：绑定在场状态控制器
    // powerMonitor 和 app 是 Electron 内置模块，在 main 进程可用
    // PresenceController 监听锁屏/挂起/解锁/恢复 + 窗口焦点变化
    // 用户回来时触发 ProactiveEngine.checkPending() 检查累积事件
    sprite?.bindPresence(powerMonitor, app);

    // Phase 3.1：集成剪贴板三重保护
    // ClipboardHandler 依赖注入 clipboard 模块，emit 回调将事件转发到渲染进程
    // 轮询检测剪贴板变化（仅哈希比较，不读取内容），用户主动调用 analyze() 时才读取内容
    clipboardHandler = new ClipboardHandler(clipboard, {
      emit: (event: ClipboardEventType, payload?: unknown) => {
        const fullWindow = windowManager.getFullWindow();
        if (!fullWindow || fullWindow.isDestroyed()) return;
        // 将 ClipboardHandler 事件映射到 IPC 推送通道
        switch (event) {
          case 'changed':
            // 剪贴板有变化，通知 UI 显示"分析"提示（不携带内容）
            fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_CHANGED);
            break;
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
      return clipboardHandler?.analyze() ?? false;
    });
    // 启动剪贴板变化检测轮询
    clipboardHandler.startPolling();

    // Phase 4.3：注册技能文件安装 IPC handler
    // 渲染进程拖入 .md 文件后调用，校验并写入 configDir/skills/
    ipcMain.handle(IPC_CHANNELS.SKILL_INSTALL, async (_event, fileName: string, content: string) => {
      const { installSkill } = await import('../sprite/skillInstaller.js');
      // configDir 默认为 ~/.memora-sprite/config/，与 Agent 初始化时一致
      const configDir = DEFAULT_CONFIG_DIR;
      const result = await installSkill(content, fileName, configDir);
      return result;
    });
  } catch (error) {
    // Agent 初始化失败——窗口已显示，向用户展示错误信息
    // 最小化 IPC 处理器已在阶段 1 注册，此处无需重复注册
    const errMessage = toError(error).message;
    // 使用统一分类函数，确保与 reinitAgent 逻辑一致
    initErrorDetail = classifyInitError(errMessage, '初始化失败');
    errorHandler.handle(error, {
      code: ErrorCode.INITIALIZATION_FAILED,
      context: 'Agent 初始化失败',
    });
  }
}

// ─── 最小化 IPC 处理器 ──────────────────────────────────────

// D-04 修复：最小化 IPC 处理器提取到 ipc/minimalHandlers.ts
// 通过 MinimalIpcState 代理对象链接 main.ts 模块级变量与 IPC 处理器

/** 最小化 IPC 状态代理（getter/setter 链接到 main.ts 模块级 let 变量） */
const minimalIpcState: MinimalIpcState = {
  get agentReady(): boolean { return agentReady; },
  set agentReady(v: boolean) { agentReady = v; },
  get initErrorDetail(): string | null { return initErrorDetail; },
  set initErrorDetail(v: string | null) { initErrorDetail = v; },
  get currentAbortController(): AbortController | null { return currentAbortController; },
  set currentAbortController(v: AbortController | null) { currentAbortController = v; },
  get currentDataDir(): string { return currentDataDir; },
  set currentDataDir(v: string) { currentDataDir = v; },
  get pendingWriteConfirmations(): Map<string, (confirmed: boolean) => void> {
    return pendingWriteConfirmations;
  },
  set pendingWriteConfirmations(v: Map<string, (confirmed: boolean) => void>) {
    // 注意：pendingWriteConfirmations 是 const Map，不替换引用，仅支持 getter
    // setter 为满足 MinimalIpcState 接口而存在，实际不会调用
    void v;
  },
  get closeSprite(): (() => Promise<void>) | null { return closeSprite; },
  set closeSprite(v: (() => Promise<void>) | null) { closeSprite = v; },
  get auditManager(): AuditManager | null { return auditManager; },
  set auditManager(v: AuditManager | null) { auditManager = v; },
  get windowManager(): WindowManager { return windowManager; },
  set windowManager(v: WindowManager) { windowManager = v; },
};

// 调用提取后的函数（在 initializeApp 阶段 1 中调用）
registerMinimalIpcHandlers(minimalIpcState, {
  setAppRuntime,
  setupAgentReady,
  classifyInitError,
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
  windowStateManager?.transition('full');
});

/** 防止 before-quit 重复触发清理 */
let isQuitting = false;

app.on('before-quit', async (e) => {
  // 防止重复清理
  if (isQuitting) return;
  isQuitting = true;

  // 标记窗口管理器正在退出，允许窗口真正关闭（而非 preventDefault 转为浮动）
  windowManager?.setQuitting(true);

  // 阻止立即退出，先清理资源
  e.preventDefault();

  try {
    // P2 修复：先中断进行中的对话，避免 agent.close() 在对话进行中调用
    // 导致 AsyncGenerator 未正常退出、资源泄漏或状态不一致
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }
    // Phase 3.3：注销全局快捷键，避免退出后残留占用
    shortcutManager?.unregisterAll();
    shortcutManager = null;
    // Phase 3.1：停止剪贴板轮询，清理定时器
    clipboardHandler?.stopPolling();
    clipboardHandler = null;
    if (closeSprite) {
      await closeSprite();
    }
    // P2-E1 修复：显式销毁托盘，清理 pulseTimer（setInterval）避免退出前再触发 setToolTip
    trayManager?.destroy();
  } catch (error) {
    errorHandler.handle(error, {
      code: ErrorCode.UNKNOWN,
      context: '应用关闭清理失败',
    });
  } finally {
    app.exit(0);
  }
});
