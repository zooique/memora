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
import type { WorkProjectionPayload } from './ipcChannels.js';
import type { Sprite } from '../sprite/sprite.js';
import { DEFAULT_SPRITE_CONFIG } from '../sprite/spriteConfig.js';
import type { SpriteConfigKey } from '../sprite/spriteConfig.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import { getLocalDate } from '../sprite/constants.js';

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
  /**
   * P1 修复：Agent 是否就绪（reinitAgent 失败后为 false，拒绝新对话避免使用已关闭 Agent）
   * handleUserInput 入口检查此标志，未就绪时拒绝并提示用户重新配置
   */
  isAgentReady: () => boolean;
  /**
   * UX-PP-04 用户是否主动触发了中断（区分用户 Stop vs 系统错误）
   *
   * P2-AI-04 并发场景风险说明：
   * 此标志为共享布尔值，理论上在多请求并发时可能被误判（A 请求设置 true 后，
   * B 请求的 catch 块读取到 true 误以为是用户中断）。
   * 实际风险已由 P1-IPC-03 竞态保护缓解：handleUserInput 入口检查进行中对话，
   * 若有进行中对话则拒绝新请求，确保同一时刻最多只有一个活跃对话。
   * 因此 wasUserAborted 实际仅在单对话场景下使用，并发误判风险极低。
   * 若未来移除竞态保护，需改为 per-request 的中断标志（如 AbortController.reason）。
   */
  wasUserAborted: boolean;
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
 * 支持重复调用：reinitAgent 路径会在 Agent 重新初始化后再次调用本函数。
 * 先清理本函数注册的通道，避免重复注册 handle 或重复监听 on 事件。
 *
 * @param ctx IPC 上下文（Agent + Sprite + SessionStore + WindowManager 等）
 */
export function registerIpcHandlers(ctx: IpcContext): void {
  // reinitAgent 路径可能重复调用本函数，先清理本函数自身注册的通道。
  // ipcMain.handle 重复注册会抛错；ipcMain.on 重复监听会导致同一事件触发多次。
  const handleChannels = [
    IPC_CHANNELS.CHAT_ABORT,
    IPC_CHANNELS.SESSION_LOAD,
    IPC_CHANNELS.SESSION_NEW,
    IPC_CHANNELS.SESSION_LIST,
    // P1 修复：遗漏这三个通道会导致 reinitAgent 时 ipcMain.handle 重复注册抛错
    // "Attempted to register a second handler"，用户保存 LLM 配置后应用不可用
    IPC_CHANNELS.SESSION_SWITCH,
    IPC_CHANNELS.SESSION_DELETE,
    IPC_CHANNELS.SESSION_RENAME,
    IPC_CHANNELS.MEMORIES_LIST,
    IPC_CHANNELS.MEMORIES_SEARCH,
    IPC_CHANNELS.MEMORIES_SHOW,
    IPC_CHANNELS.MEMORIES_DELETE,
    IPC_CHANNELS.MEMORIES_ADD,
    IPC_CHANNELS.CONFIG_GET,
    IPC_CHANNELS.CONFIG_UPDATE,
    IPC_CHANNELS.PERSONA_LIST,
    IPC_CHANNELS.PERSONA_SWITCH,
    IPC_CHANNELS.PERSONA_MODE,
    IPC_CHANNELS.PERSONA_MODE_GET,
    IPC_CHANNELS.PROJECTS_LIST,
    IPC_CHANNELS.DASHBOARD_GET,
    // H1：配置建议（接受/拒绝）
    IPC_CHANNELS.SUGGESTION_ACCEPT,
    IPC_CHANNELS.SUGGESTION_REJECT,
    // H2：用户画像管理
    IPC_CHANNELS.USER_PROFILE_LIST,
    IPC_CHANNELS.USER_PROFILE_CONFIRM,
    IPC_CHANNELS.USER_PROFILE_REJECT,
    // H3：作品投影查看
    IPC_CHANNELS.WORK_PROJECTION_LIST,
    IPC_CHANNELS.WORK_PROJECTION_SHOW,
  ] as const;
  const onChannels = [IPC_CHANNELS.USER_INPUT, IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN, IPC_CHANNELS.THEME_CHANGED] as const;

  for (const channel of handleChannels) {
    // removeHandler 对未注册通道是 no-op，安全用于幂等注册
    ipcMain.removeHandler(channel);
  }
  for (const channel of onChannels) {
    // 这些 on 通道仅由本函数注册，移除全部监听器是安全的
    ipcMain.removeAllListeners(channel);
  }

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
    // UX-PP-04 标记用户主动中断，确保 catch 块也能发送系统消息
    ctx.wasUserAborted = true;
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      ctrl.abort();
      ctx.setAbortController(null);
    }
    return { aborted: true };
  });

  /** 加载历史会话消息 */
  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_event, query: { date?: string; session?: string; limit?: number; offset?: number }) => {
    try {
      // UX-PP-08 有明确查询参数时直接构造目标，跳过 listSessions 冗余调用
      let target: string | undefined;
      if (query.date && query.session) {
        target = `${query.date}-${query.session}`;
      } else {
        // 无查询参数时：列出所有会话，智能选择最近会话
        const sessions = ctx.sessionStore.listSessions();
        if (sessions.length === 0) {
          return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
        }
        const today = getLocalDate(); // UX-PP-07 本地日期，非 UTC
        target = sessions.find(s => s === `${today}-main`) ?? sessions[sessions.length - 1];
      }

      if (!target) {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }

      const match = target.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
      if (!match || !match[1] || !match[2]) {
        return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
      }

      // UX-FD-07 分页加载：limit 和 offset 来自 query（默认 50 条）
      const pageSize = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const total = ctx.sessionStore.countMessages(match[1], match[2]);
      const messages = ctx.sessionStore.loadMessagesPaginated(match[1], match[2], pageSize, offset);
      // UX-P2-06 保留 timestamp 字段，UX-P2-07 返回 loadedSessionId 供渲染进程正确高亮当前会话
      return {
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
        loadedSessionId: target,
        // UX-FD-07 分页信息
        total,
        hasMore: offset + messages.length < total,
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '加载会话历史失败' });
      return { messages: [], loadedSessionId: '', total: 0, hasMore: false };
    }
  });

  /** UX-P1-04 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  ipcMain.handle(IPC_CHANNELS.SESSION_SWITCH, async (_event, query: { date: string; session: string }) => {
    try {
      if (!ctx.agent) {
        return { success: false, messages: [], error: 'Agent 未初始化' };
      }

      // P2 修复：切换会话前检查是否有进行中对话，有则拒绝
      // 避免旧对话的后续消息持久化到新会话，导致会话内容串扰
      if (ctx.getAbortController()) {
        return { success: false, messages: [], error: '有进行中的对话，请等待完成或中断后再切换会话' };
      }

      // 1. 切换 Agent 内部会话标识（更新 currentSession，后续 chat() 写入新会话）
      ctx.agent.switchSession(query.session);
      // 2. 恢复目标会话的历史消息到 AgentLoop 工作记忆（供 LLM 上下文使用）
      await ctx.agent.restoreSession(query.date, query.session);
      // 3. 加载会话消息供 UI 渲染（保留 timestamp）
      const messages = ctx.sessionStore.loadMessages(query.date, query.session);
      return {
        success: true,
        messages: messages.map((msg) => ({ role: msg.role, content: msg.content, timestamp: msg.timestamp })),
      };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '切换会话失败' });
      return { success: false, messages: [], error: toError(error).message };
    }
  });

  // FD-09 删除会话
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, sessionId: string) => {
    try {
      if (!ctx.agent) {
        return { success: false, error: 'Agent 未初始化' };
      }

      const deleted = ctx.sessionStore.deleteSession(sessionId);
      if (!deleted) {
        return { success: false, error: '会话不存在或删除失败' };
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '删除会话失败' });
      return { success: false, error: toError(error).message };
    }
  });

  // FD-09 重命名会话
  ipcMain.handle(IPC_CHANNELS.SESSION_RENAME, async (_event, sessionId: string, newName: string) => {
    try {
      if (!ctx.agent) {
        return { success: false, error: 'Agent 未初始化' };
      }

      if (!newName || !newName.trim()) {
        return { success: false, error: '会话名不能为空' };
      }

      const renamed = ctx.sessionStore.renameSession(sessionId, newName.trim());
      if (!renamed) {
        return { success: false, error: '会话不存在或重命名失败' };
      }

      return { success: true };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '重命名会话失败' });
      return { success: false, error: toError(error).message };
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
    // P2-010 修复：使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象类型断言。
    // 原方案 {} as Readonly<Required<SpriteConfig>> 会欺骗类型系统，渲染进程访问
    // config.silentMode 等字段时得到 undefined，可能引发运行时错误。
    safeHandle('获取配置失败', { config: DEFAULT_SPRITE_CONFIG }, () => ({ config: ctx.sprite.getConfig() }), ErrorCode.CONFIG_LOAD_FAILED),
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
          const date = parts[0] + '-' + parts[1] + '-' + parts[2];
          const name = parts.slice(3).join('-') || 'main';
          // UX-PP-05 获取首条用户消息作为预览
          const preview = ctx.sessionStore.getFirstUserMessage(s);
          // P3-FLOW-04 获取消息数量用于会话列表项展示
          const messageCount = ctx.sessionStore.countMessages(date, name);
          return { id: s, date, name, preview, messageCount };
        }
        return { id: s, date: s, name: s, preview: '', messageCount: 0 };
      });
      return { sessions: parsed };
    } catch (error) {
      errorHandler.handle(error, { code: ErrorCode.UNKNOWN, context: '列出会话失败' });
      return { sessions: [] };
    }
  });

  /**
   * UX-P2-10 主题变更通知
   *
   * 完整窗口切换主题后通知主进程，主进程广播到浮动窗口，
   * 确保两个窗口主题一致。
   */
  ipcMain.on(IPC_CHANNELS.THEME_CHANGED, (_event, theme: 'light' | 'dark') => {
    const floatWindow = ctx.windowManager.getFloatWindow();
    floatWindow?.broadcastTheme(theme);
  });

  // ─── H1：配置建议（AutoConfigRefiner 闭环） ──────────────

  /**
   * 接受配置建议 — 调用 confirmConfigSuggestion 持久化到配置文件
   *
   * 持久化路径：
   *   - rule → projectPath/.memora/rules/{name}.md
   *   - persona → projectPath/.memora/personas/{name}.md
   *   - skill → projectPath/.memora/skills/{name}.md
   * 下次启动时由 MemoryLoader 自动扫描加载到 SQLite。
   */
  ipcMain.handle(
    IPC_CHANNELS.SUGGESTION_ACCEPT,
    async (_event, suggestion: { type: 'rule' | 'persona' | 'skill'; name: string; content: string; confidence: number; source?: string }) => {
      return safeHandle(
        'SUGGESTION_ACCEPT',
        { success: false, error: '未知错误' },
        async () => {
          const config = ctx.agent.config;
          if (!config) {
            return { success: false, error: '配置管理器未就绪' };
          }
          await config.confirmConfigSuggestion(suggestion);
          return { success: true };
        },
        ErrorCode.UNKNOWN,
      );
    },
  );

  /**
   * 拒绝配置建议 — 仅记录日志，不持久化
   *
   * 用户拒绝后该建议被丢弃，不会再次出现（除非下次对话再次提取到相同建议）。
   */
  ipcMain.handle(
    IPC_CHANNELS.SUGGESTION_REJECT,
    async (_event, _suggestion: { type: 'rule' | 'persona' | 'skill'; name: string; content: string; confidence: number; source?: string }) => {
      // 拒绝仅记录日志，无副作用
      return { success: true };
    },
  );

  // ─── H2：用户画像（UserProfile 闭环） ────────────────────

  /**
   * 列出所有画像条目（含已确认 + 待确认）
   *
   * 已确认条目：持久化在 SQLite（source='profile'），进程重启后保留
   * 待确认条目：仅存内存缓存，进程重启后丢失
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_LIST, async () => {
    return safeHandle(
      'USER_PROFILE_LIST',
      { entries: [] as Array<{ id: string; category: string; value: string; source: string; weight: number; confirmed: boolean; updatedAt: string }> },
      () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { entries: [] };
        }
        // 合并已确认 + 待确认条目
        const confirmed = profile.getConfirmed();
        const pending = profile.getPending();
        const entries = [...confirmed, ...pending].map((e) => ({
          id: e.id,
          category: e.category,
          value: e.value,
          source: e.source,
          weight: e.weight,
          confirmed: e.confirmed,
          updatedAt: e.updatedAt,
        }));
        return { entries };
      },
      ErrorCode.UNKNOWN,
    );
  });

  /**
   * 确认待确认画像条目 — 写入存储 + 标记 confirmed
   *
   * 确认后条目持久化到 SQLite（source='profile'），后续 buildSystemPrompt 会包含。
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_CONFIRM, async (_event, id: string) => {
    return safeHandle(
      'USER_PROFILE_CONFIRM',
      { success: false, error: '未知错误' },
      async () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { success: false, error: '用户画像管理器未就绪' };
        }
        await profile.confirm(id);
        return { success: true };
      },
      ErrorCode.UNKNOWN,
    );
  });

  /**
   * 拒绝画像条目 — 从缓存删除，已确认的也从存储删除
   *
   * 拒绝后条目不再出现在 systemPrompt 中，也不会被召回。
   */
  ipcMain.handle(IPC_CHANNELS.USER_PROFILE_REJECT, async (_event, id: string) => {
    return safeHandle(
      'USER_PROFILE_REJECT',
      { success: false, error: '未知错误' },
      async () => {
        const profile = ctx.agent.userProfile;
        if (!profile) {
          return { success: false, error: '用户画像管理器未就绪' };
        }
        await profile.reject(id);
        return { success: true };
      },
      ErrorCode.UNKNOWN,
    );
  });

  // ─── 作品投影（H3：WorkProjectionManager 查看） ──────────

  /**
   * 列出所有作品投影
   *
   * 投影由 Agent 读取文件时自动生成（read_file 工具内置 ensureProjection 调用），
   * 此通道仅提供查看能力，不触发生成。
   */
  ipcMain.handle(IPC_CHANNELS.WORK_PROJECTION_LIST, async () => {
    return safeHandle(
      'WORK_PROJECTION_LIST',
      [] as WorkProjectionPayload[],
      async () => {
        const works = ctx.agent.works;
        if (!works) return [];
        const entries = await works.loadAll();
        // 映射为 IPC 传输形态（与 WorkProjectionEntry 对齐）
        return entries.map((e) => ({
          id: e.id,
          sourcePath: e.sourcePath,
          fileHash: e.fileHash,
          summary: e.summary,
          structure: e.structure,
          keyDecisions: e.keyDecisions,
          updatedAt: e.updatedAt,
        }));
      },
      ErrorCode.UNKNOWN,
    );
  });

  /**
   * 查看单个作品投影详情
   *
   * 通过文件路径查询已有投影，不触发生成（如需生成需先通过 Agent 读取文件）。
   */
  ipcMain.handle(IPC_CHANNELS.WORK_PROJECTION_SHOW, async (_event, filePath: string) => {
    return safeHandle(
      'WORK_PROJECTION_SHOW',
      null as WorkProjectionPayload | null,
      async () => {
        const works = ctx.agent.works;
        if (!works) return null;
        const entry = await works.getProjection(filePath);
        if (!entry) return null;
        return {
          id: entry.id,
          sourcePath: entry.sourcePath,
          fileHash: entry.fileHash,
          summary: entry.summary,
          structure: entry.structure,
          keyDecisions: entry.keyDecisions,
          updatedAt: entry.updatedAt,
        };
      },
      ErrorCode.UNKNOWN,
    );
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

  // P1 修复：Agent 未就绪时拒绝（reinitAgent 失败后旧 Agent 已关闭，新对话会抛错）
  if (!ctx.isAgentReady()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
      text: 'Agent 未就绪，请在设置面板中重新配置 LLM 后重试',
    });
    return;
  }

  // P1 修复：竞态保护——已有进行中的对话时拒绝，避免 Agent 并发锁抛"对话繁忙"错误。
  // 用户中断后立即发送新消息时，旧 chat() 的 AsyncGenerator 尚未退出 finally 块，
  // abortController 仍非空，此时新 chat() 会触发 Agent 内部并发锁。
  if (ctx.getAbortController()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
      text: '上一条消息仍在处理中，请等待完成或点击停止后再发送',
    });
    return;
  }

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
    // UX-P1-01 累积完整文本，每次 chunk 发送累积值（而非 delta），避免渲染层只显示最后一个 chunk
    let accumulatedText = '';
    for await (const chunk of ctx.agent.chat(text, abortController.signal)) {
      // 检查窗口是否仍然可用
      if (fullWindow.isDestroyed()) break;

      if (chunk.type === 'text') {
        // 累积 delta 后发送完整文本，渲染层清空重渲染也不会丢失内容
        accumulatedText += chunk.content;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, {
          messageId,
          text: accumulatedText,
        });
      } else if (chunk.type === 'recall') {
        // MS-12 召回透明度：推送召回记忆摘要到渲染层，在消息底部展示
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL, {
          messageId,
          memories: chunk.memories,
        });
      } else if (chunk.type === 'tool_start') {
        // UX-P1-02 工具调用开始：推送工具名和参数，UI 渲染工具调用卡片
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START, {
          messageId,
          name: chunk.name,
          args: chunk.args,
        });
      } else if (chunk.type === 'tool_result') {
        // UX-P1-02 工具调用结果：推送工具名、成功状态和摘要，UI 更新工具卡片状态
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, {
          messageId,
          name: chunk.name,
          ok: chunk.ok,
          summary: chunk.summary,
        });
      } else if (chunk.type === 'thinking') {
        // UX-P2-01 思考阶段指示：推送阶段名称，UI 显示"正在回忆.../处理.../归档..."
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: chunk.phase,
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
      // UX-PP-04 用户主动中断时，catch 块也需发送系统消息告知用户
      if (ctx.wasUserAborted) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, {
          text: '[已中断：用户手动停止]',
          kind: 'system',
        });
      }
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
        text: `对话出错：${toError(error).message}`,
      });
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
    }
    errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
  } finally {
    ctx.setAbortController(null);
    // UX-PP-04 重置用户中断标志
    ctx.wasUserAborted = false;
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
  }
}
