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

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { app, ipcMain, Notification, screen } from 'electron';
import { loadConfig, createProviderFromConfig, toError, logger } from 'memora';
import type { Agent } from 'memora';
import { WindowStateManager, DEFAULT_FLOAT_POSITION } from './windowState.js';
import { TrayManager } from './trayIcon.js';
import { WindowManager } from './windowManager.js';
import { ElectronInteraction } from './interaction.js';
import { registerIpcHandlers, type IpcContext } from './ipcHandlers.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
import { ELECTRON_DIR } from './utils/esmShim.js';
import {
  startSprite,
  reinitAgent,
  saveLlmConfig,
  isLlmConfigured,
  PROVIDER_PRESETS,
  DEFAULT_DATA_DIR,
} from '../index.js';
import { loadSpriteConfig, saveSpriteConfig, DEFAULT_SPRITE_CONFIG } from '../sprite/spriteConfig.js';
import type { Sprite, SpriteEventMap } from '../sprite/sprite.js';
import { AuditManager } from '../sprite/auditManager.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';

// ─── 应用路径 ──────────────────────────────────────────────

const RESOURCES_DIR = path.join(ELECTRON_DIR, '../../resources');
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

/** 初始化失败的具体错误信息（agentReady=false 时有效，用于区分配置缺失 vs 其他初始化错误） */
let initErrorDetail: string | null = null;

/** M1 写入确认：等待渲染进程响应的 Promise resolver 映射表（requestId → resolve） */
const pendingWriteConfirmations = new Map<string, (confirmed: boolean) => void>();

/** M2 审计日志：宿主单例（在 initializeApp 中创建） */
let auditManager: AuditManager | null = null;

/** 精灵事件订阅者列表（用于 Agent 重新初始化前取消订阅） */
const spriteEventUnsubscribers: Array<() => void> = [];

// 注意：使用 const 数组 + clear() 方法清空，而非 let 重新赋值
// 因为 setupSpriteEventListeners 中使用 push 添加订阅

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
  // 浮动窗口尺寸（与 windowState.ts FLOAT_SIZE 一致）
  const FLOAT_WIDTH = 80;
  const FLOAT_HEIGHT = 80;

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
    // UX-PP-04 用户中断标志：区分用户 Stop vs 系统错误
    wasUserAborted: false,
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
    const spriteConfig = loadSpriteConfig(currentDataDir);

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
        saveSpriteConfig(currentDataDir, {
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

    // 注册最小化 IPC 处理器（必须在 createWindows 之前，确保渲染进程加载时 handler 已就绪）
    // 渲染进程 DOMContentLoaded 时立即发送 llm-config-get / agent-status 等 IPC 请求，
    // 若 handler 在阶段 2 才注册（原有逻辑），会产生竞态条件导致 "No handler registered" 错误。
    registerMinimalIpcHandlers();

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
        const bounds = fullWindow.getBounds();
        saveSpriteConfig(currentDataDir, {
          windowBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        });
      };
      fullWindow.on('resize', () => {
        if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
        boundsSaveTimer = setTimeout(saveBounds, 500);
      });
      fullWindow.on('move', () => {
        if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
        boundsSaveTimer = setTimeout(saveBounds, 500);
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
        saveSpriteConfig(currentDataDir, { showFloatBubble: checked });
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

    // 捕获已初始化的 sprite 引用，供后续回调闭包使用（避免非空断言）
    const activeSprite = sprite;

    // 注入交互层
    activeSprite.setInteraction(interaction);

    // 移除阶段 1 注册的 CONFIG_GET 最小化处理器（替换为完整处理器，使用 sprite.getConfig()）
    // 保留 AGENT_STATUS / LLM_CONFIG_* 处理器（Agent 就绪后设置面板仍需要这些通道）
    ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);

    // 注册完整 IPC 处理器（注入 Agent + Sprite + SessionStore）
    // 通过工厂函数构造，与 reinitAgent 路径共享同一份构造逻辑（DRY）
    const ipcContext = createIpcContext(agent, sprite, sessionStore);
    registerIpcHandlers(ipcContext);

    // 订阅精灵事件（主动提示分发）
    setupSpriteEventListeners();

    // H1：注册配置建议回调（AutoConfigRefiner → SUGGESTION_PUSH 推送）
    setupConfigSuggestionListener(agent);

    // M1：注册写入确认回调（SecurityGuard → WRITE_CONFIRMATION 推送 → 确认对话框）
    setupWriteConfirmationListener(agent);

    // M2：初始化审计日志管理器 + 订阅 SecurityGuard.onAudit
    auditManager = new AuditManager(currentDataDir);
    setupAuditListener(agent, auditManager);

    // 补充注入浮动窗口右键菜单回调（需要 Agent/Sprite 就绪后才能查询/切换静默模式）
    // 初始创建时仅注入了 onExpandToFull，此处补充 onHideToTray / onQuit / 静默模式回调
    // 静默模式回调通过工厂函数生成，与托盘注入共享同一份逻辑（DRY）
    windowManager.updateFloatCallbacks({
      // 浮动气泡右键"隐藏到托盘"：关闭浮动气泡（设置 showFloatBubble = false）
      onHideToTray: () => {
        windowStateManager.setShowFloatBubble(false);
        // 同步持久化 + 重建托盘菜单
        saveSpriteConfig(DEFAULT_DATA_DIR, { showFloatBubble: false });
        trayManager?.updateMenu();
      },
      onQuit: () => {
        windowManager.setQuitting(true);
        windowManager.closeAll();
        app.quit();
      },
      ...createSilentModeCallbacks(activeSprite),
    });

    // 补充注入托盘右键菜单静默模式回调（对齐方案 §5.5 托盘菜单设计）
    // TrayManager 在 Agent 初始化前创建，需延迟注入 onToggleSilent / isSilentMode
    trayManager?.updateCallbacks(createSilentModeCallbacks(activeSprite));

    agentReady = true;
    // 初始化成功后清空错误详情
    initErrorDetail = null;
    // 通知渲染进程 Agent 已就绪（触发加载会话历史、记忆列表等初始数据）
    const readyWindow = windowManager.getFullWindow();
    readyWindow?.webContents.send(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, { ready: true });
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
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    try {
      const defaultDataDir = DEFAULT_DATA_DIR;
      return { config: loadSpriteConfig(defaultDataDir) };
    } catch {
      // P2-011 修复：使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象
      // 违反 SpriteConfigForm 类型契约（与 P2-010 同类问题）
      return { config: { ...DEFAULT_SPRITE_CONFIG } };
    }
  });

  // Agent 状态查询
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async () => {
    return {
      ready: agentReady,
      // 区分三种状态：就绪 / 初始化失败（有具体错误）/ 初始化中（无错误详情）
      // 初始化中时不返回"配置不完整"默认消息，避免误导渲染进程
      error: agentReady ? null : initErrorDetail,
    };
  });

  // LLM 连接测试（保存前验证配置是否可用）
  // 创建临时 Provider，发送最小测试消息，消费首个 chunk 即判定连接成功
  ipcMain.handle(
    IPC_CHANNELS.LLM_CONFIG_TEST,
    async (
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
        const stream = provider.chat([{ role: 'user', content: 'ping' }], { stream: true });

        // AsyncIterable 需通过 [Symbol.asyncIterator]() 获取迭代器
        const iterator = stream[Symbol.asyncIterator]();
        const firstChunk = await iterator.next();
        if (firstChunk.done) {
          return { success: false, error: 'LLM 返回空响应，请检查模型名称是否正确' };
        }

        return { success: true, error: null };
      } catch (error) {
        return { success: false, error: toError(error).message };
      }
    },
  );

  // LLM 配置读取（从 ~/.memora-sprite/data/config.json）
  ipcMain.handle(IPC_CHANNELS.LLM_CONFIG_GET, async () => {
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
          // H6 返回后台 Provider 配置
          ...(config.llm.background ? {
            background: {
              enabled: true,
              provider: config.llm.background.provider,
              model: config.llm.background.model,
              baseUrl: config.llm.background.baseUrl ?? '',
              apiKey: config.llm.background.apiKey ?? '',
              temperature: config.llm.background.temperature,
            },
          } : {}),
        },
        embedding: config.embedding
          ? {
              model: config.embedding.model,
              baseUrl: config.embedding.baseUrl ?? '',
              apiKey: config.embedding.apiKey ?? '',
            }
          : null,
        presets: PROVIDER_PRESETS,
      };
    } catch {
      return { configured: false, config: null, presets: PROVIDER_PRESETS };
    }
  });

  // LLM 配置保存 + 重新初始化 Agent
  ipcMain.handle(
    IPC_CHANNELS.LLM_CONFIG_SAVE,
    async (
      _event,
      llmConfig: {
        provider: string;
        model: string;
        baseUrl: string;
        apiKey: string;
        temperature?: number;
      },
      embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
    ) => {
      try {
        // 1. 保存配置到文件
        await saveLlmConfig(llmConfig, embeddingConfig);

        // P2 修复：reinitAgent 前先中断进行中的对话，避免旧 Agent 在对话进行中被 close
        // 导致 AsyncGenerator 未正常退出、内部并发锁状态不一致
        if (currentAbortController) {
          currentAbortController.abort();
          currentAbortController = null;
        }

        // 2. 重新初始化 Agent（清理旧实例）
        const result = await reinitAgent(closeSprite);
        agent = result.agent;
        sprite = result.sprite;
        sessionStore = result.sessionStore;
        closeSprite = result.close;
        currentDataDir = result.dataDir;

        // 3. 注入交互层
        sprite.setInteraction(interaction);

        // 4. 移除最小化 IPC 中的 CONFIG_GET 处理器（避免重复注册）
        // 保留 AGENT_STATUS / LLM_CONFIG_* 处理器（设置面板复用）
        ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);

        // 5. 注册完整 IPC 处理器
        const ipcContext = createIpcContext(agent, sprite, sessionStore);
        registerIpcHandlers(ipcContext);

        // 6. 订阅精灵事件
        setupSpriteEventListeners();

        // H1：重新注册配置建议回调（新 Agent 实例）
        if (agent) {
          setupConfigSuggestionListener(agent);
          // M1：重新注册写入确认回调（新 Agent 实例）
          setupWriteConfirmationListener(agent);
          // M2：重新初始化审计管理器 + 订阅审计事件（新 Agent 实例）
          auditManager = new AuditManager(currentDataDir);
          setupAuditListener(agent, auditManager);
        }

        agentReady = true;
        // 重新初始化成功后清空错误详情
        initErrorDetail = null;

        // 7. 通知渲染进程 Agent 已就绪
        const fullWindow = windowManager.getFullWindow();
        if (fullWindow && !fullWindow.isDestroyed()) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, { ready: true });
        }

        return { success: true, error: null };
      } catch (error) {
        // P1 修复：reinitAgent 失败时旧 Agent 已关闭（prevClose 已执行），
        // 标记 agentReady=false 使 handleUserInput 拒绝新对话，避免使用已关闭 Agent 抛错。
        // 用户需在设置面板重新配置 LLM 并保存触发再次 reinitAgent。
        agentReady = false;
        // 清空旧实例引用：prevClose 已关闭旧 Agent，引用已失效
        // 避免旧 IPC handler 通过闭包访问已关闭的 Agent 对象（chat 方法行为异常）
        agent = null;
        sprite = null;
        sessionStore = null;
        closeSprite = null;
        // 使用统一分类函数，确保与 initializeApp 逻辑一致
        initErrorDetail = classifyInitError(toError(error).message, '重新初始化失败');
        errorHandler.handle(error, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '保存 LLM 配置并重新初始化 Agent 失败',
        });
        return { success: false, error: toError(error).message };
      }
    },
  );

  // M1：写入确认响应处理器（渲染进程 → 主进程）
  // 渲染进程用户确认/拒绝后，通过此通道传回结果，主进程 resolve 对应的 pending Promise
  ipcMain.handle(
    IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE,
    async (_event, requestId: string, confirmed: boolean) => {
      const resolve = pendingWriteConfirmations.get(requestId);
      if (resolve) {
        pendingWriteConfirmations.delete(requestId);
        resolve(confirmed);
      } else {
        logger.warn({ requestId }, '[写入确认] 收到未知 requestId 的响应（可能已超时）');
      }
    },
  );

  // M2：审计日志 IPC 处理器（渲染进程 → 主进程）
  ipcMain.handle(IPC_CHANNELS.AUDIT_LOG_LIST, async (_event, limit: unknown) => {
    if (!auditManager) return [];
    const limitNum = Number(limit);
    const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 50;
    return auditManager.readRecent(safeLimit);
  });

  ipcMain.handle(IPC_CHANNELS.AUDIT_LOG_CLEAR, async () => {
    if (auditManager) {
      await auditManager.clear();
    }
  });

  // FD-04 项目列表：Agent 未就绪时返回空数组（设置面板专注项目下拉框使用）
  // 完整 IPC 注册时会覆盖此降级 handler，使用 sprite.listProjects() 返回真实数据
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () => {
    return { projects: [] };
  });
}

// ─── 精灵事件监听（主动提示分发） ─────────────────────────

/**
 * 向完整窗口发送精灵事件（若窗口可见）
 *
 * 提取自 setupSpriteEventListeners 中 3 处重复的"检查 fullWindow 可见性 → 发送 SPRITE_EVENT"模式。
 * 仅在完整窗口存在且可见时发送，避免窗口隐藏或销毁时调用 webContents.send 抛错。
 *
 * @param type 事件类型（对应 SpriteEventMap 的 key）
 * @param payload 事件载荷
 * @param silent 是否静默（默认 true，仅 proactivePrompt 为 false）
 */
function sendSpriteEventIfVisible(
  type: string,
  payload: Record<string, unknown>,
  silent = true,
): void {
  const fullWindow = windowManager.getFullWindow();
  // 同时检查 isVisible 和 !isMinimized：macOS 上最小化的窗口 isVisible 可能仍为 true
  if (
    fullWindow &&
    !fullWindow.isDestroyed() &&
    fullWindow.isVisible() &&
    !fullWindow.isMinimized()
  ) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, {
      type,
      payload,
      silent,
    });
  }
}

/**
 * QC-R2-01 通用精灵事件注册 helper
 *
 * 统一"定义回调 → sprite.on 注册 → 推送取消订阅"模式，
 * 消除 setupSpriteEventListeners 中 4 处重复的 3 行模板代码。
 *
 * 类型安全：通过泛型 K 约束 eventName 必须是 SpriteEventMap 的合法键，
 * handler 的参数类型自动推导为 SpriteEventMap[K]。
 *
 * @param eventName 事件名（对应 SpriteEventMap 的 key）
 * @param handler 事件回调
 */
function registerSpriteEvent<K extends keyof SpriteEventMap>(
  eventName: K,
  handler: (e: SpriteEventMap[K]) => void,
): void {
  if (!sprite) return;
  sprite.on(eventName, handler);
  spriteEventUnsubscribers.push(() => sprite?.off(eventName, handler));
}

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
  registerSpriteEvent('proactivePrompt', ({ prompt, silent }) => {
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
    if (!silent) {
      sendSpriteEventIfVisible('proactivePrompt', { prompt, silent }, silent);

      // P2-FLOW-12 浮动窗口主动提示未读徽章
      // 完整窗口不可见时，用户无法看到 banner，需在浮动窗口徽章上累积未读计数
      // 用户展开完整窗口时，resetUnreadCount 会清零徽章
      const fullWindow = windowManager?.getFullWindow();
      if (fullWindow && !fullWindow.isVisible()) {
        incrementUnreadCount();
      }
    }
  });

  // 记忆新增 → 仪表盘计数 +1
  registerSpriteEvent('memoryNoticed', () => {
    sendSpriteEventIfVisible('memoryNoticed', {});
  });

  // 洞察提取 → 仪表盘计数 +1
  registerSpriteEvent('insightGained', () => {
    sendSpriteEventIfVisible('insightGained', {});
  });

  // 角色切换 → 顶栏角色标签更新
  registerSpriteEvent('personaChanged', ({ from, to }) => {
    sendSpriteEventIfVisible('personaChanged', { from, to });
    // 角色切换不影响托盘状态（托盘状态由流式输出/静默模式/主动提示驱动）
  });

  // L5：项目切换 → 渲染层通知
  registerSpriteEvent('projectSwitched', ({ from, to, projectName }) => {
    sendSpriteEventIfVisible('projectSwitched', { from, to, projectName });
  });

  // L5：技能匹配 → 渲染层通知
  registerSpriteEvent('skillMatched', ({ skill, score }) => {
    sendSpriteEventIfVisible('skillMatched', { skill, score });
  });

  // L5：记忆召回 → 渲染层通知（每次对话触发，按需展示"想起 X 条"）
  registerSpriteEvent('memoryRecalled', ({ count, query }) => {
    sendSpriteEventIfVisible('memoryRecalled', { count, query });
  });

  // L5：衰减完成 → 渲染层通知（24h 节流避免每小时噪音）
  // 注意：节流由渲染层控制（renderer 维护上次显示时间戳），主进程不节流
  // —— 保证事件流纯净，过滤逻辑在 UI 层更可控
  registerSpriteEvent('decayCompleted', ({ decayedCount }) => {
    sendSpriteEventIfVisible('decayCompleted', { decayedCount });
  });
}

/**
 * H1：注册配置建议回调
 *
 * 当 AutoConfigRefiner 从对话中提取到配置建议时，内核通过 onConfigSuggestion 回调推送。
 * 此函数将建议通过 SUGGESTION_PUSH 通道转发到渲染进程，由 SuggestionCard 组件展示。
 *
 * 调用时机：Agent 初始化完成后（initAgentFromConfig 返回后）
 * 重新初始化时：先移除旧回调（通过 reinitAgent 重建 Agent 实现，旧 Agent 已 close）
 */
function setupConfigSuggestionListener(activeAgent: Agent): void {
  const config = activeAgent.config;
  if (!config) {
    logger.warn('[setupConfigSuggestionListener] ConfigManager 未就绪，跳过配置建议回调注册');
    return;
  }

  config.onConfigSuggestion((suggestion) => {
    const fullWindow = windowManager.getFullWindow();
    // 复用 sendSpriteEventIfVisible 的可见性检查模式
    if (
      fullWindow &&
      !fullWindow.isDestroyed() &&
      fullWindow.isVisible() &&
      !fullWindow.isMinimized()
    ) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH, {
        type: suggestion.type,
        name: suggestion.name,
        content: suggestion.content,
        confidence: suggestion.confidence,
        source: suggestion.source,
      });
    } else {
      // 窗口不可见时记录日志（建议已生成但用户看不到，下次对话可能再次提取）
      logger.info(
        { name: suggestion.name, type: suggestion.type },
        '[配置建议] 窗口不可见，建议未推送（用户下次对话可能再次提取）',
      );
    }
  });

  logger.info('[setupConfigSuggestionListener] 配置建议回调已注册');
}

/**
 * M1：注册写入确认回调
 *
 * 当 SecurityGuard 检测到写入操作需要二次确认时，通过此回调将确认请求
 * 推送到渲染进程展示确认对话框，等待用户决策后返回结果。
 *
 * 流程：
 *   1. SecurityGuard.requestWriteConfirmation() 调用此回调
 *   2. 生成唯一 requestId，存入 pendingWriteConfirmations Map
 *   3. 通过 WRITE_CONFIRMATION 通道推送到渲染进程
 *   4. 渲染进程显示确认对话框，用户点击确认/取消
 *   5. 渲染进程通过 WRITE_CONFIRMATION_RESPONSE 传回结果
 *   6. resolve pending Promise，返回给 SecurityGuard
 *
 * 超时保护：30 秒未收到渲染进程响应时自动拒绝（防止窗口关闭等异常情况
 * 导致 Promise 永久挂起）。
 *
 * 调用时机：Agent 初始化完成后（initAgentFromConfig 返回后）
 */
function setupWriteConfirmationListener(activeAgent: Agent): void {
  const security = activeAgent.security;
  if (!security) {
    logger.warn('[setupWriteConfirmationListener] SecurityGuard 未就绪，跳过写入确认回调注册');
    return;
  }

  // 写入确认超时时间（毫秒）：窗口关闭等异常情况下自动拒绝
  const CONFIRMATION_TIMEOUT_MS = 30_000;

  security.onWriteConfirmation(async (info) => {
    // 不需要确认时直接放行（owner 模式 + confirmWrites=false）
    if (!info.needsConfirm) {
      return true;
    }

    const fullWindow = windowManager.getFullWindow();
    if (!fullWindow || fullWindow.isDestroyed()) {
      // 窗口不可用时自动拒绝（安全优先）
      logger.warn({ path: info.targetPath }, '[写入确认] 窗口不可用，自动拒绝写入');
      return false;
    }

    // 生成唯一请求 ID
    const requestId = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 创建 Promise 等待渲染进程响应
    const confirmed = await new Promise<boolean>((resolve) => {
      // 超时保护：30 秒后自动拒绝
      const timeoutId = setTimeout(() => {
        pendingWriteConfirmations.delete(requestId);
        logger.warn({ requestId, path: info.targetPath }, '[写入确认] 超时未响应，自动拒绝');
        resolve(false);
      }, CONFIRMATION_TIMEOUT_MS);

      // 存入映射表（包装 resolve 以清理超时定时器）
      pendingWriteConfirmations.set(requestId, (result: boolean) => {
        clearTimeout(timeoutId);
        resolve(result);
      });

      // 推送到渲染进程
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION, {
        requestId,
        targetPath: info.targetPath,
        tool: info.tool,
        description: info.description,
        permission: info.permission,
        needsConfirm: info.needsConfirm,
      });
    });

    return confirmed;
  });

  logger.info('[setupWriteConfirmationListener] 写入确认回调已注册');
}

/**
 * M2：订阅 SecurityGuard.onAudit → JSONL 持久化
 *
 * 所有通过 SecurityGuard 断言的路径访问事件都会被记录为审计日志，
 * 写入 dataDir/audit.log（JSONL 格式）。写入为 fire-and-forget，
 * 写失败记一条 stderr 消息，不阻塞主流程。
 */
function setupAuditListener(activeAgent: Agent, activeAuditManager: AuditManager): void {
  const security = activeAgent.security;
  if (!security) {
    logger.warn('[setupAuditListener] SecurityGuard 未就绪，跳过审计日志');
    return;
  }
  security.onAudit((event) => {
    activeAuditManager.record(event);
  });
  logger.info('[setupAuditListener] 审计日志回调已注册');
}

/** 取消所有精灵事件订阅（Agent 重新初始化前调用） */
function unsubscribeSpriteEvents(): void {
  for (const unsubscribe of spriteEventUnsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      // 旧 sprite 实例可能已关闭，忽略取消订阅错误
      logger.warn({ error: toError(error) }, '[unsubscribeSpriteEvents] 取消订阅失败');
    }
  }
  spriteEventUnsubscribers.length = 0;
}

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
