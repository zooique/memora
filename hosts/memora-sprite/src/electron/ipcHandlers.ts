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

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { toError } from 'memora';
import type { Agent } from 'memora';
import type { WindowStateManager } from './windowState.js';
import type { WindowManager } from './windowManager.js';
import type { TrayManager } from './trayIcon.js';
import { errorHandler, ErrorCode } from './errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
import type { Sprite } from '../sprite/sprite.js';
import { DEFAULT_SPRITE_CONFIG } from '../sprite/spriteConfig.js';
import type { SpriteConfig, SpriteConfigKey } from '../sprite/spriteConfig.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';

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
 * IPC handler 错误兜底包装
 *
 * 统一 try-catch 模板：执行业务逻辑，失败时走 errorHandler + 返回降级值。
 * 适用于"简单查询/操作 + 固定降级返回值"的 handler（占 IPC 处理器的大多数）。
 *
 * 不适用场景（保持手写 try-catch）：
 * - try 内有副作用逻辑（如 CONFIG_UPDATE 需同步托盘状态）
 * - catch 返回值含 error.message（如 SESSION_NEW 需返回错误详情给 UI）
 * - try 内业务逻辑复杂含多分支（如 SESSION_LOAD 会话选择）
 * - 返回值结构复杂（如 DASHBOARD_GET 聚合多字段）
 *
 * @param context 错误上下文描述（人类可读，用于日志）
 * @param fallback 失败时返回的降级值（与 fn 返回值同类型）
 * @param fn 业务逻辑，返回最终响应体（同步或异步均可）
 * @param code 错误代码，默认 UNKNOWN
 * @returns fn 的返回值，或失败时的 fallback
 */
async function safeHandle<T>(
  context: string,
  fallback: T,
  fn: () => T | Promise<T>,
  code: ErrorCode = ErrorCode.UNKNOWN,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    errorHandler.handle(error, { code, context });
    return fallback;
  }
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
  ipcMain.on(IPC_CHANNELS.USER_INPUT, (_event, text: string) => {
    void handleUserInput(text, ctx);
  });

  /** 中断当前对话 */
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async () => {
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      ctrl.abort();
      ctx.setAbortController(null);
    }
    return { aborted: true };
  });

  /** 加载历史会话消息 */
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_event, query: { date?: string; session?: string }) => {
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
      // 仅暴露渲染进程需要的字段，保持 preload 契约与 IPC 通道类型一致
      return {
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '加载会话历史失败' });
      return { messages: [] };
    }
  });

  // ─── 记忆相关 ────────────────────────────────────────────

  /** 列出记忆（可按 source 过滤） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_LIST, async (_event, query: { source?: string }) =>
    safeHandle('列出记忆失败', { memories: [] }, () => ({ memories: ctx.sprite.listMemories(query?.source) })),
  );

  /** 搜索记忆（混合搜索：关键词 + 向量召回） */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SEARCH, async (_event, query: string) =>
    safeHandle('搜索记忆失败', { hits: [] }, async () => ({ hits: await ctx.sprite.searchMemories(query) })),
  );

  /** 查看单条记忆详情 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_SHOW, async (_event, id: string) =>
    safeHandle('查看记忆详情失败', { memory: null }, () => ({ memory: ctx.sprite.showMemory(id) })),
  );

  /** 删除记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_DELETE, async (_event, id: string) =>
    safeHandle('删除记忆失败', { deleted: false }, () => ({ deleted: ctx.sprite.deleteMemory(id) })),
  );

  /** 添加记忆 */
  ipcMain.handle(IPC_CHANNELS.MEMORIES_ADD, async (_event, data: { source: string; name: string; content: string }) =>
    safeHandle('添加记忆失败', { id: '' }, () => ({ id: ctx.sprite.upsertMemory(data.source, data.name, data.content) })),
  );

  // ─── 配置相关 ────────────────────────────────────────────

  /** 获取精灵配置 */
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () =>
    // fallback 空对象需要类型断言以匹配 getConfig() 返回的 Readonly<Required<SpriteConfig>>
    safeHandle('获取配置失败', { config: {} as Readonly<Required<SpriteConfig>> }, () => ({ config: ctx.sprite.getConfig() }), ErrorCode.CONFIG_LOAD_FAILED),
  );

  /**
   * 校验配置键是否属于 SpriteConfig
   */
  function isSpriteConfigKey(key: string): key is SpriteConfigKey {
    return key in DEFAULT_SPRITE_CONFIG;
  }

  /** 更新配置项 */
  ipcMain.handle(IPC_CHANNELS.CONFIG_UPDATE, async (_event, key: string, value: unknown) => {
    try {
      if (!isSpriteConfigKey(key)) {
        return { success: false, error: `非法配置键：${key}` };
      }
      ctx.sprite.updateConfig(key, value);

      // 静默模式切换时同步托盘状态 + 重建菜单（确保勾选状态一致）
      if (key === 'silentMode') {
        if (value === true) {
          ctx.trayManager?.setState('sleeping');
        } else {
          ctx.trayManager?.setState('idle');
        }
        // 重建托盘菜单以反映静默模式勾选状态（通过设置面板/IPC 切换时菜单不会自动更新）
        ctx.trayManager?.updateMenu();
      }

      return { updated: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '更新配置失败' });
      return { updated: false };
    }
  });

  // ─── 角色相关 ────────────────────────────────────────────

  /** 列出所有角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_LIST, async () =>
    safeHandle('列出角色失败', { personas: [] }, () => ({ personas: ctx.sprite.listPersonas() })),
  );

  /** 切换角色 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_SWITCH, async (_event, name: string) =>
    safeHandle('切换角色失败', { switched: false, name: null }, () => {
      const result = ctx.sprite.switchPersona(name);
      return { switched: result !== null, name: result };
    }),
  );

  /** 设置角色匹配模式 */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE, async (_event, mode: 'auto' | 'manual') =>
    safeHandle('设置角色模式失败', { set: false }, () => ({ set: ctx.sprite.setPersonaMode(mode) })),
  );

  /** IX-07 查询当前角色匹配模式（对齐 CLI /mode 查询能力） */
  ipcMain.handle(IPC_CHANNELS.PERSONA_MODE_GET, async () =>
    safeHandle('查询角色模式失败', { mode: 'auto' }, () => ({ mode: ctx.sprite.personaMode })),
  );

  // ─── 主动提示分发 ────────────────────────────────────────

  /** 渲染进程通知主动提示已显示，清除未读计数 */
  ipcMain.on(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN, () => {
    // 主动提示已显示，托盘切回 idle 状态
    ctx.trayManager?.setState('idle');
  });

  // ─── 项目管理（FD-04 项目模式） ──────────────────────────

  /** 列出已注册项目（供 UI 专注模式选择器使用） */
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () =>
    safeHandle('获取项目列表失败', { projects: [] }, () => ({ projects: ctx.sprite.listProjects() })),
  );

  // ─── 仪表盘（FD-03 UI 完整仪表盘） ──────────────────────

  /**
   * 获取完整仪表盘数据
   *
   * 对齐 CLI /dashboard 命令，提供：
   * - 记忆总数 + 按来源分组
   * - 累积事件数 + 主动提示阈值
   * - 已注册触发器列表
   * - 关联推荐记忆
   */
  ipcMain.handle(IPC_CHANNELS.DASHBOARD_GET, () => {
    try {
      const data = ctx.sprite.dashboard();
      return {
        total: data.total,
        bySource: data.bySource,
        suggestions: data.suggestions,
        pendingNotices: ctx.sprite.pendingCount,
        proactiveThreshold: ctx.sprite.proactiveThreshold,
        registeredTriggers: ctx.sprite.registeredTriggers,
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '获取仪表盘数据失败' });
      return {
        total: 0,
        bySource: {},
        suggestions: [],
        pendingNotices: 0,
        proactiveThreshold: 3,
        registeredTriggers: [],
      };
    }
  });

  // ─── 会话管理（FD-05 新建会话） ──────────────────────────

  /**
   * 新建会话
   *
   * 生成基于时间戳的会话名（session-HHmmss），调用 agent.switchSession 切换。
   * 旧会话数据保留在 SessionStore 中，不删除。
   */
  ipcMain.handle(IPC_CHANNELS.SESSION_NEW, async () => {
    try {
      const now = new Date();
      // 会话名格式：session-HHmmss（如 session-143052）
      const sessionName = `session-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
      ctx.agent.switchSession(sessionName);
      return { success: true, sessionName };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '新建会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // FD-A1 列出所有会话
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    try {
      const sessions = ctx.sessionStore.listSessions();
      // 解析会话名，提取日期和名称用于 UI 展示
      const parsed = sessions.map((s) => {
        const parts = s.split('-');
        // 格式：YYYY-MM-DD-name（如 2026-06-20-main, 2026-06-20-session-143052）
        if (parts.length >= 3) {
          return { id: s, date: parts[0] + '-' + parts[1] + '-' + parts[2], name: parts.slice(3).join('-') || 'main' };
        }
        return { id: s, date: s, name: s };
      });
      return { sessions: parsed };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出会话失败' });
      return { sessions: [] };
    }
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
  fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, { messageId });

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
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, {
          messageId,
          text: chunk.content,
        });
      } else if (chunk.type === 'done') {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
      } else if (chunk.type === 'aborted') {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, {
          text: `[已中断：${chunk.reason}]`,
          kind: 'system',
        });
      }
    }
  } catch (error) {
    if (!fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
        text: `对话出错：${toError(error).message}`,
      });
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
    }
    errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
  } finally {
    ctx.setAbortController(null);
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
  }
}
