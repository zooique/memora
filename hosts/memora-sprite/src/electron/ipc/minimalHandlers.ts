/**
 * 最小化 IPC 处理器
 *
 * 职责：Agent 未就绪时提供最小化的 IPC 通道，仅支持：
 * - 精灵配置读写（CONFIG_GET）
 * - Agent 状态查询（AGENT_STATUS）
 * - LLM 连接测试（LLM_CONFIG_TEST）
 * - LLM 配置读写（LLM_CONFIG_GET / LLM_CONFIG_SAVE）
 * - 写入确认响应（WRITE_CONFIRMATION_RESPONSE）
 * - 审计日志（AUDIT_LOG_LIST / AUDIT_LOG_CLEAR）
 * - 项目列表降级（PROJECTS_LIST）
 * - 主题变更回调（THEME_CHANGED）
 *
 * D-04 修复：从 main.ts 提取，减少主文件行数（776 → ~560 行）。
 * 通过 MinimalIpcState 对象共享可变状态，通过 MinimalIpcCallbacks 回调主进程函数。
 *
 * 不支持：对话、记忆、角色等需要 Agent 的功能。
 * 用户在设置面板配置 LLM 后，通过 llm-config-save 触发 reinitAgent，
 * 成功后注册完整 IPC 并通知渲染进程。
 */

import { ipcMain } from 'electron';
import { createProviderFromConfig, toError, logger } from 'memora';
import type { Agent, Config } from 'memora';
import { IPC_CHANNELS } from './channels.js';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { loadSpriteConfig, DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { Sprite } from '../../sprite/sprite.js';
import type { AuditManager } from '../../sprite/audit/auditManager.js';
import type { WindowManager } from '../windows/windowManager.js';
import type { SqliteSessionStore } from '../../storage/sessionStore.js';
import { spriteConfigStore } from '../../storage/spriteConfigStore.js';
import { saveLlmConfig, reinitAgent, PROVIDER_PRESETS } from '../../index.js';
import { isValidContent } from './inputValidation.js';

/**
 * 安全审计 P4 修复：脱敏 API Key 供渲染进程显示
 *
 * 仅保留前 3 位 + 后 4 位，中间用 **** 替代。
 * 渲染进程只需知道"已配置"状态，不需要完整密钥。
 */
function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return key ? '****' : '';
  }
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

// ─── 类型定义 ──────────────────────────────────────────────

/** Agent 运行时状态（与 main.ts AppRuntime 对齐） */
export interface AppRuntime {
  agent: Agent;
  sprite: Sprite;
  sessionStore: SqliteSessionStore;
  close: () => Promise<void>;
}

/**
 * 最小化 IPC 处理器需要的可变状态
 *
 * 设计：main.ts 持有此对象引用，IPC 处理器内部通过闭包捕获。
 * main.ts 修改对象属性后，IPC 处理器立即可见。
 */
export interface MinimalIpcState {
  agentReady: boolean;
  initErrorDetail: string | null;
  currentAbortController: AbortController | null;
  currentDataDir: string;
  pendingWriteConfirmations: Map<string, (confirmed: boolean) => void>;
  closeSprite: (() => Promise<void>) | null;
  auditManager: AuditManager | null;
  windowManager: WindowManager | undefined;
}

/**
 * 最小化 IPC 处理器需要的回调函数
 *
 * 这些函数是 main.ts 的局部函数，无法通过 import 获取，需通过回调注入。
 */
export interface MinimalIpcCallbacks {
  /** 集中赋值 agent/sprite/sessionStore/closeSprite */
  setAppRuntime: (runtime: AppRuntime | null) => void;
  /** Agent 就绪后初始化（注册完整 IPC + 事件监听） */
  setupAgentReady: (agent: Agent, sprite: Sprite, sessionStore: SqliteSessionStore, dataDir: string) => void;
  /** 统一错误分类 */
  classifyInitError: (errMessage: string, prefix: string) => string;
}

// ─── 注册函数 ──────────────────────────────────────────────

/**
 * 注册 Agent 未就绪时的最小化 IPC 处理器
 *
 * @param state - 可变状态对象（main.ts 持有引用，IPC 处理器通过闭包访问）
 * @param callbacks - 回调函数（main.ts 的局部函数，注入方式传递）
 */
export function registerMinimalIpcHandlers(
  state: MinimalIpcState,
  callbacks: MinimalIpcCallbacks,
): void {
  // 精灵配置读写（直接操作文件，不需要 Agent）
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    try {
      return { config: loadSpriteConfig() };
    } catch (err) {
      // P2-011 修复：使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象
      logger.warn({ err: toError(err).message }, '精灵配置加载失败，返回默认配置');
      return { config: { ...DEFAULT_SPRITE_CONFIG } };
    }
  });

  // Agent 状态查询
  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, async () => {
    return {
      ready: state.agentReady,
      error: state.agentReady ? null : state.initErrorDetail,
    };
  });

  // LLM 连接测试（保存前验证配置是否可用）
  ipcMain.handle(
    IPC_CHANNELS.LLM_CONFIG_TEST,
    async (
      _event,
      llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string },
    ) => {
      // 安全审计 P4 修复：校验 LLM 配置参数长度，防止超大值传入
      if (!llmConfig || typeof llmConfig.provider !== 'string' || !isValidContent(llmConfig.apiKey, 1000)) {
        return { success: false, error: '配置参数无效' };
      }
      try {
        const provider = createProviderFromConfig('test', {
          provider: llmConfig.provider,
          model: llmConfig.model,
          baseUrl: llmConfig.baseUrl || undefined,
          apiKey: llmConfig.apiKey,
        });

        const stream = provider.chat([{ role: 'user', content: 'ping' }], { stream: true });
        const iterator = stream[Symbol.asyncIterator]();
        const firstChunk = await iterator.next();
        if (firstChunk.done) {
          return { success: false, error: 'LLM 返回空响应，请检查模型名称是否正确' };
        }

        return { success: true, error: null };
      } catch (error) {
        // LLM 连接测试失败时返回错误给 UI，同时记录警告便于排查
        logger.warn({ err: toError(error).message, provider: llmConfig.provider, model: llmConfig.model }, 'LLM 连接测试失败');
        return { success: false, error: toError(error).message };
      }
    },
  );

  // LLM 配置读取
  ipcMain.handle(IPC_CHANNELS.LLM_CONFIG_GET, async () => {
    try {
      const configured = await spriteConfigStore.isConfigured();
      if (!configured) {
        return { configured: false, config: null, presets: PROVIDER_PRESETS };
      }
      const config: Config = await spriteConfigStore.load();
      return {
        configured: true,
        config: {
          provider: config.llm.provider,
          model: config.llm.model,
          baseUrl: config.llm.baseUrl ?? '',
          // 安全审计 P4 修复：脱敏 apiKey，渲染进程只需知道"已配置"状态
          apiKey: maskApiKey(config.llm.apiKey ?? ''),
          temperature: config.llm.temperature,
          ...(config.llm.background ? {
            background: {
              enabled: true,
              provider: config.llm.background.provider,
              model: config.llm.background.model,
              baseUrl: config.llm.background.baseUrl ?? '',
              apiKey: maskApiKey(config.llm.background.apiKey ?? ''),
              temperature: config.llm.background.temperature,
            },
          } : {}),
        },
        embedding: config.embedding
          ? {
              model: config.embedding.model,
              baseUrl: config.embedding.baseUrl ?? '',
              apiKey: maskApiKey(config.embedding.apiKey ?? ''),
            }
          : null,
        presets: PROVIDER_PRESETS,
      };
    } catch (err) {
      // LLM 配置读取失败时返回未配置状态，记录警告便于排查
      logger.warn({ err: toError(err).message }, 'LLM 配置读取失败');
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
      // 安全审计 P4 修复：校验 LLM 配置参数长度，防止超大值传入
      if (!llmConfig || typeof llmConfig.provider !== 'string' || !isValidContent(llmConfig.apiKey, 1000)) {
        return { success: false, error: '配置参数无效' };
      }
      try {
        // 1. 保存配置到文件
        await saveLlmConfig(llmConfig, embeddingConfig);

        // 2. 中断进行中的对话
        if (state.currentAbortController) {
          state.currentAbortController.abort();
          state.currentAbortController = null;
        }

        // 3. 重新初始化 Agent
        const result = await reinitAgent(state.closeSprite);
        state.currentDataDir = result.dataDir;
        callbacks.setAppRuntime({
          agent: result.agent,
          sprite: result.sprite,
          sessionStore: result.sessionStore,
          close: result.close,
        });

        // 4. Agent 就绪后初始化
        callbacks.setupAgentReady(result.agent, result.sprite, result.sessionStore, state.currentDataDir);

        return { success: true, error: null };
      } catch (error) {
        state.agentReady = false;
        callbacks.setAppRuntime(null);
        state.initErrorDetail = callbacks.classifyInitError(toError(error).message, '重新初始化失败');
        errorHandler.handle(error, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '保存 LLM 配置并重新初始化 Agent 失败',
        });
        return { success: false, error: toError(error).message };
      }
    },
  );

  // M1：写入确认响应处理器
  ipcMain.handle(
    IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE,
    async (_event, requestId: string, confirmed: boolean) => {
      const resolve = state.pendingWriteConfirmations.get(requestId);
      if (resolve) {
        state.pendingWriteConfirmations.delete(requestId);
        resolve(confirmed);
      } else {
        logger.warn({ requestId }, '[写入确认] 收到未知 requestId 的响应（可能已超时）');
      }
    },
  );

  // M2：审计日志 IPC 处理器
  ipcMain.handle(IPC_CHANNELS.AUDIT_LOG_LIST, async (_event, limit: unknown) => {
    if (!state.auditManager) return [];
    const limitNum = Number(limit);
    const safeLimit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 50;
    return state.auditManager.readRecent(safeLimit);
  });

  ipcMain.handle(IPC_CHANNELS.AUDIT_LOG_CLEAR, async () => {
    if (state.auditManager) {
      await state.auditManager.clear();
    }
  });

  // FD-04 项目列表：Agent 未就绪时返回空数组
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () => {
    return { projects: [] };
  });

  // P2-9 渲染进程通知主进程主题已变更，动态设置窗口背景色
  ipcMain.on(IPC_CHANNELS.THEME_CHANGED, (_event, theme: 'light' | 'dark') => {
    const bgColor = theme === 'dark' ? '#1e1e2e' : '#f0f0f2';
    state.windowManager?.updateBackgroundColor(bgColor);
  });

  // FOUNDATION-SEAL Phase 4：渲染进程日志上报（转发到主进程 logger）
  // 渲染进程无 pino，通过 IPC 将错误/警告转发到主进程统一日志
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, payload: { level: 'warn' | 'error'; context: string; message: string }) => {
    const { level, context, message } = payload;
    // 安全审计 P5 修复：校验日志参数类型和长度，防止超长日志撑大文件
    if (typeof context !== 'string' || typeof message !== 'string' || !isValidContent(message, 10000)) {
      return;
    }
    if (level === 'error') {
      logger.error({ context, source: 'renderer' }, message);
    } else {
      logger.warn({ context, source: 'renderer' }, message);
    }
  });
}