/**
 * IPC 处理器注册
 *
 * 注册所有 IPC 通道（见 ADR-SP-003 / 方案-Electron阶段二 §8.2）
 * 并连接 Agent + Sprite 实例，实现：
 * - 流式对话输出（agent.chat() AsyncGenerator → IPC）
 * - 对话中断（AbortController）
 * - 会话历史加载
 * - 记忆 CRUD
 * - 配置读写
 * - 角色切换
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import type { WindowStateManager } from './windowState.js';
import type { WindowManager } from './windowManager.js';
import type { TrayManager } from './trayIcon.js';
import type { Agent } from 'memora';
import type { Sprite } from '../sprite/sprite.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import { errorHandler, ErrorCode } from './errorHandler.js';

/**
 * IPC 处理器上下文
 *
 * 封装所有 IPC 处理器需要的依赖，由 main.ts 注入。
 * 仅在 Agent 就绪后注册完整 IPC（配置缺失时由 main.ts 注册最小化 IPC）。
 */
export interface IpcContext {
  /** Agent 实例（对话 + 记忆） */
  agent: Agent;
  /** Sprite 实例（精灵控制 + 配置 + 角色） */
  sprite: Sprite;
  /** 会话存储（历史消息加载） */
  sessionStore: SqliteSessionStore;
  /** 窗口状态管理器 */
  windowStateManager: WindowStateManager;
  /** 窗口管理器（获取窗口引用） */
  windowManager: WindowManager;
  /** 托盘管理器（主动提示时脉冲） */
  trayManager: TrayManager | null;
  /** 获取当前对话的 AbortController */
  getAbortController: () => AbortController | null;
  /** 设置当前对话的 AbortController */
  setAbortController: (ctrl: AbortController | null) => void;
  /** 获取当前未读计数（完整窗口隐藏时的消息数） */
  getUnreadCount: () => number;
  /** 增加未读计数并推送到浮动窗口 */
  incrementUnreadCount: () => void;
  /** 清零未读计数并推送到浮动窗口 + 完整窗口 */
  resetUnreadCount: () => void;
}

/**
 * 注册所有 IPC 处理器
 *
 * @param ctx IPC 上下文（Agent + Sprite + SessionStore + WindowManager 等）
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  // ─── 对话相关 ────────────────────────────────────────────

  /**
   * 用户输入处理 — 消费 agent.chat() AsyncGenerator
   *
   * 流式输出架构（方案 §6.2 排雷修正）：
   * 主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk，
   * 不走 IInteraction（IInteraction 仅负责非流式输出）。
   */
  ipcMain.on('user-input', (_event, text: string) => {
    void handleUserInput(text, ctx);
  });

  /** 中断当前对话 */
  ipcMain.handle('chat-abort', async () => {
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      ctrl.abort();
      ctx.setAbortController(null);
    }
    return { aborted: true };
  });

  /** 加载历史会话消息 */
  ipcMain.handle('session-load', async (_event, query: { date?: string; session?: string }) => {
    try {
      const sessions = ctx.sessionStore.listSessions();
      if (sessions.length === 0) {
        return { messages: [] };
      }

      // 优先使用查询参数，否则选择最近会话
      let target: string | undefined;
      if (query.date && query.session) {
        target = `${query.date}-${query.session}`;
      } else {
        const today = new Date().toISOString().slice(0, 10);
        target = sessions.find(s => s === `${today}-main`) ?? sessions[sessions.length - 1];
      }

      if (!target) {
        return { messages: [] };
      }

      const match = target.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (!match || !match[1] || !match[2]) {
        return { messages: [] };
      }

      const messages = ctx.sessionStore.loadMessages(match[1], match[2]);
      return { messages };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '加载会话历史失败' });
      return { messages: [] };
    }
  });

  // ─── 记忆相关 ────────────────────────────────────────────

  /** 列出记忆（可按 source 过滤） */
  ipcMain.handle('memories-list', async (_event, query: { source?: string }) => {
    try {
      const memories = ctx.sprite.listMemories(query?.source);
      return { memories };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出记忆失败' });
      return { memories: [] };
    }
  });

  /** 搜索记忆（混合搜索：关键词 + 向量召回） */
  ipcMain.handle('memories-search', async (_event, query: string) => {
    try {
      const hits = await ctx.sprite.searchMemories(query);
      return { hits };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '搜索记忆失败' });
      return { hits: [] };
    }
  });

  /** 查看单条记忆详情 */
  ipcMain.handle('memories-show', async (_event, id: string) => {
    try {
      const memory = ctx.sprite.showMemory(id);
      return { memory };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '查看记忆详情失败' });
      return { memory: null };
    }
  });

  /** 删除记忆 */
  ipcMain.handle('memories-delete', async (_event, id: string) => {
    try {
      const deleted = ctx.sprite.deleteMemory(id);
      return { deleted };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '删除记忆失败' });
      return { deleted: false };
    }
  });

  /** 添加记忆 */
  ipcMain.handle('memories-add', async (_event, data: { source: string; name: string; content: string }) => {
    try {
      const id = ctx.sprite.upsertMemory(data.source, data.name, data.content);
      return { id };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '添加记忆失败' });
      return { id: '' };
    }
  });

  // ─── 配置相关 ────────────────────────────────────────────

  /** 获取精灵配置 */
  ipcMain.handle('config-get', async () => {
    try {
      const config = ctx.sprite.getConfig();
      return { config };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.CONFIG_LOAD_FAILED, context: '获取配置失败' });
      return { config: {} };
    }
  });

  /** 更新配置项 */
  ipcMain.handle('config-update', async (_event, key: string, value: unknown) => {
    try {
      ctx.sprite.updateConfig(key as never, value);

      // 静默模式切换时同步托盘状态
      if (key === 'silentMode') {
        if (value === true) {
          ctx.trayManager?.setState('sleeping');
        } else {
          ctx.trayManager?.setState('idle');
        }
      }

      return { updated: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '更新配置失败' });
      return { updated: false };
    }
  });

  // ─── 角色相关 ────────────────────────────────────────────

  /** 列出所有角色 */
  ipcMain.handle('persona-list', async () => {
    try {
      const personas = ctx.sprite.listPersonas();
      return { personas };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出角色失败' });
      return { personas: [] };
    }
  });

  /** 切换角色 */
  ipcMain.handle('persona-switch', async (_event, name: string) => {
    try {
      const result = ctx.sprite.switchPersona(name);
      return { switched: result !== null, name: result };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '切换角色失败' });
      return { switched: false };
    }
  });

  /** 设置角色匹配模式 */
  ipcMain.handle('persona-mode', async (_event, mode: 'auto' | 'manual') => {
    try {
      const set = ctx.sprite.setPersonaMode(mode);
      return { set };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '设置角色模式失败' });
      return { set: false };
    }
  });

  // ─── 主动提示分发 ────────────────────────────────────────

  /** 渲染进程通知主动提示已显示，清除未读计数 */
  ipcMain.on('proactive-prompt-shown', () => {
    // 主动提示已显示，托盘切回 idle 状态
    ctx.trayManager?.setState('idle');
  });
}

// ─── 流式对话处理 ─────────────────────────────────────────

/**
 * 处理用户输入 — 消费 agent.chat() AsyncGenerator 并推送流式 chunk
 *
 * 实现方案 §6.2 流式输出架构：
 * - 主进程直接消费 agent.chat() 的 AsyncGenerator
 * - 通过 sprite-stream-start / sprite-stream-chunk / sprite-stream-end 通道推送
 * - 支持 AbortController 中断
 */
async function handleUserInput(text: string, ctx: IpcContext): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  const messageId = randomUUID();
  fullWindow.webContents.send('sprite-stream-start', { messageId });

  // 完整窗口不可见时增加未读计数（推送到浮动窗口徽章）
  // 对齐方案 §12 验证标准第 11 项：浮动窗口未读计数
  if (!fullWindow.isVisible()) {
    ctx.incrementUnreadCount();
  }

  // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
  ctx.trayManager?.setState('active');

  // 创建 AbortController 供中断使用
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  try {
    for await (const chunk of ctx.agent.chat(text, abortController.signal)) {
      // 检查窗口是否仍然可用
      if (fullWindow.isDestroyed()) break;

      if (chunk.type === 'text') {
        fullWindow.webContents.send('sprite-stream-chunk', {
          messageId,
          text: chunk.content,
        });
      } else if (chunk.type === 'done') {
        fullWindow.webContents.send('sprite-stream-end', { messageId });
      } else if (chunk.type === 'aborted') {
        fullWindow.webContents.send('sprite-stream-end', { messageId });
        fullWindow.webContents.send('sprite-output', {
          text: `[已中断：${chunk.reason}]`,
          kind: 'system',
        });
      }
    }
  } catch (error) {
    if (!fullWindow.isDestroyed()) {
      fullWindow.webContents.send('sprite-error', {
        text: `对话出错：${(error as Error).message}`,
      });
      fullWindow.webContents.send('sprite-stream-end', { messageId });
    }
    errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
  } finally {
    ctx.setAbortController(null);
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
  }
}

/** 发送精灵事件到渲染进程（供主进程调用） */
export function emitSpriteEvent(
  win: BrowserWindow,
  event: string,
  payload: unknown,
  silent: boolean,
): void {
  if (!win.isDestroyed()) {
    win.webContents.send('sprite-event', { type: event, payload, silent });
  }
}
