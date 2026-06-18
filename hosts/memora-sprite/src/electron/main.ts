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

import { app, ipcMain, Notification } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { WindowStateManager } from './windowState.js';
import { TrayManager } from './trayIcon.js';
import { WindowManager } from './windowManager.js';
import { ElectronInteraction } from './interaction.js';
import { registerIpcHandlers, type IpcContext } from './ipcHandlers.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { startSprite, reinitAgent, saveLlmConfig, isLlmConfigured, PROVIDER_PRESETS } from '../index.js';
import { loadSpriteConfig } from '../sprite/spriteConfig.js';
import { loadConfig, createProviderFromConfig } from 'memora';
import type { Sprite } from '../sprite/sprite.js';
import type { SpriteEventMap } from '../sprite/sprite.js';
import type { Agent } from 'memora';
import type { SqliteSessionStore } from '../storage/sessionStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 应用路径 ──────────────────────────────────────────────

const RESOURCES_DIR = path.join(__dirname, '../../resources');
const TRAY_ICON_PATH = path.join(RESOURCES_DIR, 'tray-icon.png');

// ─── 主进程状态 ──────────────────────────────────────────────

let windowStateManager: WindowStateManager;
let windowManager: WindowManager;
let interaction: ElectronInteraction;
let trayManager: TrayManager | null = null;

/** Agent + Sprite 实例（由 startSprite 初始化，可能为 null——配置缺失时） */
let agent: Agent | null = null;
let sprite: Sprite | null = null;
let sessionStore: SqliteSessionStore | null = null;
/** 关闭函数（清理 Agent + Sprite 资源） */
let closeSprite: (() => Promise<void>) | null = null;

/** 当前对话的 AbortController（用于中断流式输出） */
let currentAbortController: AbortController | null = null;

/** Agent 是否已就绪 */
let agentReady = false;

/** 精灵事件取消订阅函数集合（Agent 重新初始化前调用，避免重复注册） */
let spriteEventUnsubscribers: Array<() => void> = [];

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
    fullWindow.webContents.send('float-unread', 0);
  }
}

// ─── 应用启动 ───────────────────────────────────────────────

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
    const defaultDataDir = path.join(homedir(), '.memora');
    const spriteConfig = loadSpriteConfig(defaultDataDir);
    const configPath = path.join(defaultDataDir, 'sprite.json');

    // 2. 初始化窗口状态管理器
    const floatPosition = spriteConfig.floatIconPosition.x === -1
      ? { x: 100, y: 100 }  // 首次启动使用默认位置
      : spriteConfig.floatIconPosition;
    windowStateManager = new WindowStateManager({
      defaultState: spriteConfig.windowState,
      floatPosition,
      configPath,
    });

    // 3. 创建窗口管理器并创建所有窗口
    windowManager = new WindowManager(windowStateManager, {
      onExpandToFull: resetUnreadCount,
    });
    await windowManager.createWindows();

    // 4. 创建托盘
    const iconPath = await fs.access(TRAY_ICON_PATH).then(() => TRAY_ICON_PATH).catch(() => '');
    trayManager = new TrayManager(iconPath, {
      onShowFloat: () => windowStateManager.transition('float'),
      onShowFull: () => {
        windowStateManager.transition('full');
        // 从托盘展开完整窗口时清零未读计数
        resetUnreadCount();
      },
      onHideToTray: () => windowStateManager.transition('tray'),
      onQuit: () => {
        windowManager.closeAll();
        app.quit();
      },
    });

    // 5. 初始化交互层
    interaction = new ElectronInteraction();
    const fullWindow = windowManager.getFullWindow();
    if (fullWindow) {
      interaction.setMainWindow(fullWindow);
    }

    // 6. 窗口创建完成，显示初始状态对应的窗口
    // 使用 showInitial() 而非 transition()——transition 在 state 已等于 target 时早返回，
    // 会导致首次启动窗口不显示（构造函数已设置 defaultState）
    windowStateManager.showInitial();
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
    // skipWizard: Electron 模式跳过 CLI 交互式引导
    const spriteResult = await startSprite({ skipWizard: true });
    agent = spriteResult.agent;
    sprite = spriteResult.sprite;
    sessionStore = spriteResult.sessionStore;
    closeSprite = spriteResult.close;

    // 注入交互层
    sprite.setInteraction(interaction);

    // 注册完整 IPC 处理器（注入 Agent + Sprite + SessionStore）
    const ipcContext: IpcContext = {
      agent,
      sprite,
      sessionStore,
      windowStateManager,
      windowManager,
      trayManager,
      getAbortController: () => currentAbortController,
      setAbortController: (ctrl: AbortController | null) => { currentAbortController = ctrl; },
      getUnreadCount: () => unreadCount,
      incrementUnreadCount,
      resetUnreadCount,
    };
    registerIpcHandlers(ipcContext);

    // 订阅精灵事件（主动提示分发）
    setupSpriteEventListeners();

    agentReady = true;
  } catch (error) {
    // Agent 初始化失败——窗口已显示，向用户展示错误信息
    errorHandler.handle(error, {
      code: ErrorCode.INITIALIZATION_FAILED,
      context: 'Agent 初始化失败（配置可能不完整）',
    });

    // 注册最小化 IPC 处理器（仅窗口控制 + 配置读写）
    registerMinimalIpcHandlers();
  }
}

// ─── 最小化 IPC 处理器 ──────────────────────────────────────

/**
 * Agent 未就绪时的最小 IPC 处理器
 *
 * 仅支持：窗口控制 + 精灵配置读写 + LLM 配置读写 + Agent 状态查询 + 重新初始化
 * 不支持：对话、记忆、角色等需要 Agent 的功能
 *
 * 用户在设置面板配置 LLM 后，通过 llm-config-save 触发 reinitAgent，
 * 成功后注册完整 IPC 并通知渲染进程。
 */
function registerMinimalIpcHandlers(): void {
  // 精灵配置读写（直接操作文件，不需要 Agent）
  ipcMain.handle('config-get', async () => {
    try {
      const defaultDataDir = path.join(homedir(), '.memora');
      return { config: loadSpriteConfig(defaultDataDir) };
    } catch {
      return { config: {} };
    }
  });

  // Agent 状态查询
  ipcMain.handle('agent-status', async () => {
    return { ready: agentReady, error: agentReady ? null : '配置不完整，请在设置面板中配置 LLM 提供商和 API Key' };
  });

  // LLM 连接测试（保存前验证配置是否可用）
  // 创建临时 Provider，发送最小测试消息，消费首个 chunk 即判定连接成功
  ipcMain.handle('llm-config-test', async (
    _event,
    llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string },
  ) => {
    try {
      // 1. 创建临时 Provider（不保存配置，不初始化 Agent）
      const provider = createProviderFromConfig('test', {
        provider: llmConfig.provider,
        model: llmConfig.model,
        baseUrl: llmConfig.baseUrl || undefined,
        apiKey: llmConfig.apiKey,
      });

      // 2. 发送最小测试消息，消费首个 chunk 验证连接
      const stream = provider.chat([
        { role: 'user', content: 'ping' },
      ], { stream: true });

      // AsyncIterable 需通过 [Symbol.asyncIterator]() 获取迭代器
      const iterator = stream[Symbol.asyncIterator]();
      const firstChunk = await iterator.next();
      if (firstChunk.done) {
        return { success: false, error: 'LLM 返回空响应，请检查模型名称是否正确' };
      }

      return { success: true, error: null };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // LLM 配置读取（从 ~/.memora/config.json）
  ipcMain.handle('llm-config-get', async () => {
    try {
      const configured = await isLlmConfigured();
      if (!configured) {
        return { configured: false, config: null, presets: PROVIDER_PRESETS };
      }
      // 读取已保存的配置
      const config = await loadConfig();
      return {
        configured: true,
        config: {
          provider: config.llm.provider,
          model: config.llm.model,
          baseUrl: config.llm.baseUrl ?? '',
          apiKey: config.llm.apiKey ?? '',
          temperature: config.llm.temperature,
        },
        embedding: config.embedding ? {
          model: config.embedding.model,
          baseUrl: config.embedding.baseUrl ?? '',
          apiKey: config.embedding.apiKey ?? '',
        } : null,
        presets: PROVIDER_PRESETS,
      };
    } catch {
      return { configured: false, config: null, presets: PROVIDER_PRESETS };
    }
  });

  // LLM 配置保存 + 重新初始化 Agent
  ipcMain.handle('llm-config-save', async (
    _event,
    llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
    embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  ) => {
    try {
      // 1. 保存配置到文件
      await saveLlmConfig(llmConfig, embeddingConfig);

      // 2. 重新初始化 Agent（清理旧实例）
      const result = await reinitAgent(closeSprite);
      agent = result.agent;
      sprite = result.sprite;
      sessionStore = result.sessionStore;
      closeSprite = result.close;

      // 3. 注入交互层
      sprite.setInteraction(interaction);

      // 4. 移除最小化 IPC 中的 LLM 配置处理器（避免重复注册）
      ipcMain.removeHandler('llm-config-get');
      ipcMain.removeHandler('llm-config-save');
      ipcMain.removeHandler('llm-config-test');
      ipcMain.removeHandler('agent-status');
      ipcMain.removeHandler('config-get');

      // 5. 注册完整 IPC 处理器
      const ipcContext: IpcContext = {
        agent,
        sprite,
        sessionStore,
        windowStateManager,
        windowManager,
        trayManager,
        getAbortController: () => currentAbortController,
        setAbortController: (ctrl: AbortController | null) => { currentAbortController = ctrl; },
        getUnreadCount: () => unreadCount,
        incrementUnreadCount,
        resetUnreadCount,
      };
      registerIpcHandlers(ipcContext);

      // 6. 订阅精灵事件
      setupSpriteEventListeners();

      agentReady = true;

      // 7. 通知渲染进程 Agent 已就绪
      const fullWindow = windowManager.getFullWindow();
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.send('agent-ready', { ready: true });
      }

      return { success: true, error: null };
    } catch (error) {
      errorHandler.handle(error, {
        code: ErrorCode.INITIALIZATION_FAILED,
        context: '保存 LLM 配置并重新初始化 Agent 失败',
      });
      return { success: false, error: (error as Error).message };
    }
  });
}

// ─── 精灵事件监听（主动提示分发） ─────────────────────────

/**
 * 订阅精灵事件，实现方案 §6.6 主动提示分发逻辑：
 * - 托盘脉冲（始终执行）
 * - 系统通知（非静默模式）
 * - 窗口内提示（非静默 + 窗口可见）
 *
 * 取消订阅机制：Agent 重新初始化前调用 unsubscribeSpriteEvents()，
 * 避免旧 sprite 实例的监听器残留导致同一事件触发多次。
 */
function setupSpriteEventListeners(): void {
  if (!sprite) return;

  // 先取消旧订阅（防止 reinitAgent 时重复注册）
  unsubscribeSpriteEvents();

  // 主动提示：托盘脉冲 + 系统通知 + 窗口内提示
  const onProactivePrompt: (e: SpriteEventMap['proactivePrompt']) => void = ({ prompt, silent }) => {
    // 始终执行：托盘切换为 active 状态（蓝色 + 脉冲）
    trayManager?.setState('active');

    // 非静默模式：系统通知（检查系统是否支持，避免不支持时崩溃）
    if (!silent && Notification.isSupported()) {
      const notification = new Notification({
        title: 'Memora 精灵',
        body: prompt,
      });
      notification.on('click', () => {
        windowStateManager.transition('full');
      });
      notification.show();
    }

    // 非静默模式 + 完整窗口可见：窗口内提示
    const fullWindow = windowManager.getFullWindow();
    const isFullVisible = fullWindow?.isVisible() && !fullWindow?.isMinimized();
    if (!silent && isFullVisible && fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send('sprite-event', {
        type: 'proactivePrompt',
        payload: { prompt, silent },
        silent,
      });
    }
  };
  sprite.on('proactivePrompt', onProactivePrompt);
  spriteEventUnsubscribers.push(() => sprite?.off('proactivePrompt', onProactivePrompt));

  // 记忆新增 → 仪表盘计数 +1
  const onMemoryNoticed: (e: SpriteEventMap['memoryNoticed']) => void = () => {
    const fullWindow = windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) {
      fullWindow.webContents.send('sprite-event', {
        type: 'memoryNoticed',
        payload: {},
        silent: true,
      });
    }
  };
  sprite.on('memoryNoticed', onMemoryNoticed);
  spriteEventUnsubscribers.push(() => sprite?.off('memoryNoticed', onMemoryNoticed));

  // 洞察提取 → 仪表盘计数 +1
  const onInsightGained: (e: SpriteEventMap['insightGained']) => void = () => {
    const fullWindow = windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) {
      fullWindow.webContents.send('sprite-event', {
        type: 'insightGained',
        payload: {},
        silent: true,
      });
    }
  };
  sprite.on('insightGained', onInsightGained);
  spriteEventUnsubscribers.push(() => sprite?.off('insightGained', onInsightGained));

  // 角色切换 → 顶栏角色标签更新
  const onPersonaChanged: (e: SpriteEventMap['personaChanged']) => void = ({ from, to }) => {
    const fullWindow = windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed() && fullWindow.isVisible()) {
      fullWindow.webContents.send('sprite-event', {
        type: 'personaChanged',
        payload: { from, to },
        silent: true,
      });
    }
    // 角色切换不影响托盘状态（托盘状态由流式输出/静默模式/主动提示驱动）
  };
  sprite.on('personaChanged', onPersonaChanged);
  spriteEventUnsubscribers.push(() => sprite?.off('personaChanged', onPersonaChanged));
}

/** 取消所有精灵事件订阅（Agent 重新初始化前调用） */
function unsubscribeSpriteEvents(): void {
  for (const unsubscribe of spriteEventUnsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      // 旧 sprite 实例可能已关闭，忽略取消订阅错误
      console.error('[unsubscribeSpriteEvents] 取消订阅失败:', error);
    }
  }
  spriteEventUnsubscribers = [];
}

// ─── 应用生命周期 ─────────────────────────────────────────

app.whenReady().then(initializeApp);

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
    if (closeSprite) {
      await closeSprite();
    }
  } catch (error) {
    errorHandler.handle(error, {
      code: ErrorCode.UNKNOWN,
      context: '应用关闭清理失败',
    });
  } finally {
    app.exit(0);
  }
});
