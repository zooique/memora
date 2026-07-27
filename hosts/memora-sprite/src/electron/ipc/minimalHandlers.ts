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
 * 通过 MinimalIpcState 对象共享可变状态，通过 MinimalIpcCallbacks 回调主进程函数。
 *
 * 不支持：对话、记忆、角色等需要 Agent 的功能。
 * 用户在设置面板配置 LLM 后，通过 llm-config-save 触发 reinitAgent，
 * 成功后注册完整 IPC 并通知渲染进程。
 */

import { ipcMain } from 'electron';
import { createProviderFromConfig, toError, logger } from 'memora';
import type { Config } from 'memora';
import { IPC_CHANNELS } from './channels.js';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { loadSpriteConfig, DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import { spriteConfigStore, resolveProviderConfig } from '../../storage/spriteConfigStore.js';
import { saveLlmConfig, reinitAgent, getLlmProviders, saveLlmProvider, deleteLlmProvider, setActiveLlmProvider, saveBackgroundProvider } from '../../index.js';
import { isValidContent, isNonEmptyString, isValidLlmConfigInput } from './inputValidation.js';
// 跨进程 LLM 错误分类器：将底层错误映射为用户友好提示（onboarding + 测试连接共用）
import { classifyLlmError } from '../../shared/llmErrorClassifier.js';
// AppRuntime / MinimalIpcState / MinimalIpcCallbacks 真理源在 ./types.ts
import type { MinimalIpcState, MinimalIpcCallbacks } from './types.js';

/**
 * 脱敏 API Key 供渲染进程显示
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

// ─── 共享函数 ──────────────────────────────────────────────

/**
 * 重新初始化 Agent 运行时
 *
 * 中断进行中的对话 → reinitAgent → 更新配置缓存 → setAppRuntime → setupAgentReady。
 * 供 LLM_CONFIG_SAVE 和 LLM_PROVIDER_SAVE（首次添加）复用，避免 reinit 逻辑重复。
 *
 * @param state 可变状态对象
 * @param callbacks 回调函数
 * @param cacheUpdate 配置缓存更新值（provider/model/baseUrl/apiKey）
 * @throws 重新初始化失败时抛出，调用方负责 catch 并设置 initErrorDetail
 */
async function reinitAgentRuntime(
  state: MinimalIpcState,
  callbacks: MinimalIpcCallbacks,
  cacheUpdate: { provider: string; model: string; baseUrl: string; apiKey: string },
): Promise<void> {
  // 1. 中断进行中的对话
  if (state.agentRuntime.currentAbortController) {
    state.agentRuntime.currentAbortController.abort();
    state.agentRuntime.currentAbortController = null;
  }

  // 2. 重新初始化 Agent（reinitAgent 内部 loadConfig 读取最新配置）
  const result = await reinitAgent(state.agentRuntime.closeSprite);
  state.currentDataDir = result.dataDir;
  // 更新配置缓存，用于下次比较
  state.agentRuntime.lastProvider = cacheUpdate.provider;
  state.agentRuntime.lastModel = cacheUpdate.model;
  state.agentRuntime.lastBaseUrl = cacheUpdate.baseUrl;
  state.agentRuntime.lastApiKey = cacheUpdate.apiKey;
  callbacks.setAppRuntime({
    agent: result.agent,
    sprite: result.sprite,
    sessionStore: result.sessionStore,
    close: result.close,
  });

  // 3. Agent 就绪后初始化（注册完整 IPC + 推送 AGENT_READY）
  callbacks.setupAgentReady(result.agent, result.sprite, state.currentDataDir);
}

/**
 * reinit 失败后的统一状态清理
 *
 * 重置 agentReady、清空运行时、记录错误详情。
 *
 * @param state 可变状态对象
 * @param callbacks 回调函数
 * @param errMessage 错误消息
 * @param prefix 错误前缀（用于 classifyInitError）
 */
function handleReinitFailure(
  state: MinimalIpcState,
  callbacks: MinimalIpcCallbacks,
  errMessage: string,
  prefix: string,
): void {
  state.agentReady = false;
  callbacks.setAppRuntime(null);
  state.initErrorDetail = callbacks.classifyInitError(errMessage, prefix);
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
      // 使用 DEFAULT_SPRITE_CONFIG 作为 fallback，避免空对象
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
      // 校验 LLM 配置参数：provider 类型 + apiKey 长度
      if (!isValidLlmConfigInput(llmConfig)) {
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
        // 错误消息经过 classifyLlmError 映射为用户友好提示（如 401 → "API Key 无效"）
        const rawMessage = toError(error).message;
        logger.warn({ err: rawMessage, provider: llmConfig.provider, model: llmConfig.model }, 'LLM 连接测试失败');
        return { success: false, error: classifyLlmError(rawMessage) };
      }
    },
  );

  // LLM 配置读取
  // 注：不再返回 presets 字段——内置预设易滞后于 Provider 新模型发布，
  //     UI 改为通用表单让用户手填所有字段（决策见 A4）
  ipcMain.handle(IPC_CHANNELS.LLM_CONFIG_GET, async () => {
    try {
      const configured = await spriteConfigStore.isConfigured();
      if (!configured) {
        return { configured: false, config: null };
      }
      const config: Config = await spriteConfigStore.load();
      const active = config.llm.active ?? Object.keys(config.llm.providers ?? {})[0] ?? 'default';
      const p = resolveProviderConfig(config, active) ?? resolveProviderConfig(config, 'default');
      return {
        configured: true,
        config: {
          provider: p?.provider ?? '',
          model: p?.model ?? '',
          baseUrl: p?.baseUrl ?? '',
          // 脱敏 apiKey，渲染进程只需知道"已配置"状态
          apiKey: maskApiKey(p?.apiKey ?? ''),
          temperature: p?.temperature ?? 0.7,
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
      };
    } catch (err) {
      // LLM 配置读取失败时返回未配置状态，记录警告便于排查
      logger.warn({ err: toError(err).message }, 'LLM 配置读取失败');
      return { configured: false, config: null };
    }
  });

  // LLM 配置保存 + 条件性重新初始化 Agent
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
      // 校验 LLM 配置参数：provider 类型 + apiKey 长度
      if (!isValidLlmConfigInput(llmConfig)) {
        return { success: false, error: '配置参数无效' };
      }
      try {
        // 1. 保存配置到文件
        await saveLlmConfig(llmConfig, embeddingConfig);

        // 2. 判断是否需要重新初始化 Agent
        // 仅当 provider/model/apiKey/baseUrl 变化时才重建，temperature 变化不需要
        const currentAgent = callbacks.getCurrentAgent();
        const needsReinit = !currentAgent ||
          llmConfig.provider !== (state.agentRuntime.lastProvider ?? '') ||
          llmConfig.model !== (state.agentRuntime.lastModel ?? '') ||
          llmConfig.baseUrl !== (state.agentRuntime.lastBaseUrl ?? '') ||
          llmConfig.apiKey !== (state.agentRuntime.lastApiKey ?? '');

        if (needsReinit) {
          await reinitAgentRuntime(state, callbacks, {
            provider: llmConfig.provider,
            model: llmConfig.model,
            baseUrl: llmConfig.baseUrl,
            apiKey: llmConfig.apiKey,
          });
        }

        return { success: true, error: null, reinit: needsReinit };
      } catch (error) {
        handleReinitFailure(state, callbacks, toError(error).message, '重新初始化失败');
        errorHandler.handle(error, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '保存 LLM 配置并重新初始化 Agent 失败',
        });
        return { success: false, error: toError(error).message };
      }
    },
  );

  // ─── 多 Provider 管理 IPC ──────────────────────────────

  // Provider 列表
  ipcMain.handle(IPC_CHANNELS.LLM_PROVIDER_LIST, async () => {
    try {
      return await getLlmProviders();
    } catch (err) {
      // ENOENT 是合法状态（首次启动/配置缺失），静默返回空列表不记 warn
      // 其他错误（权限/JSON 损坏等）仍记 warn 便于排查
      const errno = err as NodeJS.ErrnoException;
      if (errno.code !== 'ENOENT') {
        logger.warn({ err: toError(err).message }, '读取 LLM 提供商配置失败');
      }
      return { active: '', providers: [] };
    }
  });

  // Provider 保存（新增/更新）
  // 编辑场景下 apiKey 可为空（保留原值，由 saveLlmProvider 从旧 config 读取）
  ipcMain.handle(
    IPC_CHANNELS.LLM_PROVIDER_SAVE,
    async (
      _event,
      key: string,
      config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
      isEditing?: boolean,
    ) => {
      // 参数校验：key 必填；apiKey 仅新增模式必填（编辑模式允许空，保留原值）
      if (!isNonEmptyString(key) || !config) {
        return { success: false, error: '参数无效' };
      }
      if (!isEditing && !config.apiKey) {
        return { success: false, error: 'API Key 不能为空' };
      }
      try {
        await saveLlmProvider(key, config);
        // 首次添加 Provider 时 Agent 尚未初始化，需触发 reinit 使其就绪
        // saveLlmProvider 首次添加会自动设 active=key，reinitAgent loadConfig 即用此 Provider
        // 编辑模式（agentReady=true）不触发 reinit，仅持久化字段变更
        if (!state.agentReady) {
          // 新增模式首次添加时 config.apiKey 必非空（已校验）
          await reinitAgentRuntime(state, callbacks, {
            provider: config.provider,
            model: config.model,
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
          });
        }
        return { success: true, error: null };
      } catch (err) {
        // reinit 失败时重置运行时状态，确保 UI 能感知并提示
        if (!state.agentReady) {
          handleReinitFailure(state, callbacks, toError(err).message, '首次初始化失败');
        }
        errorHandler.handle(err, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '保存 Provider 并初始化 Agent 失败',
        });
        return { success: false, error: toError(err).message };
      }
    },
  );

  // Provider 删除
  ipcMain.handle(
    IPC_CHANNELS.LLM_PROVIDER_DELETE,
    async (_event, key: string) => {
      if (!isNonEmptyString(key)) {
        return { success: false, error: '参数无效' };
      }
      try {
        // 删除前记录当前 active，用于判断删除后是否需要运行时切换
        const configBefore: Config = await spriteConfigStore.load();
        const wasActive = configBefore.llm.active === key;

        await deleteLlmProvider(key);

        // 删除的是当前 active Provider 时，运行时切换到新 active（deleteLlmProvider 已自动选首个剩余）
        if (wasActive && state.agentReady) {
          // 中断进行中的对话：避免旧 Provider 流式输出残留到新 Provider（与 LLM_PROVIDER_SET_ACTIVE 行为一致）
          if (state.agentRuntime.currentAbortController) {
            state.agentRuntime.currentAbortController.abort();
            state.agentRuntime.currentAbortController = null;
          }

          const configAfter: Config = await spriteConfigStore.load();
          const newActive = configAfter.llm.active ?? '';
          if (newActive) {
            const providerConfig = resolveProviderConfig(configAfter, newActive);
            if (providerConfig) {
              const newProvider = createProviderFromConfig(newActive, {
                provider: providerConfig.provider,
                model: providerConfig.model,
                baseUrl: providerConfig.baseUrl || undefined,
                apiKey: providerConfig.apiKey || '',
              });
              const currentAgent = callbacks.getCurrentAgent();
              if (currentAgent) {
                currentAgent.setProvider(newProvider);
              }
            }
          }
        }

        return { success: true, error: null };
      } catch (err) {
        return { success: false, error: toError(err).message };
      }
    },
  );

  // 切换激活 Provider + 即时生效（运行时切换，不重新初始化 Agent）
  ipcMain.handle(
    IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE,
    async (_event, key: string) => {
      if (!isNonEmptyString(key)) {
        return { success: false, error: '参数无效' };
      }
      try {
        // 1. 持久化 active 到 config.json
        await setActiveLlmProvider(key);

        // 2. 中断进行中的对话（避免旧 Provider 流式输出残留）
        if (state.agentRuntime.currentAbortController) {
          state.agentRuntime.currentAbortController.abort();
          state.agentRuntime.currentAbortController = null;
        }

        // 3. 从配置读取新 Provider 的完整配置（含 apiKey）
        const config: Config = await spriteConfigStore.load();

        // 使用统一的向后兼容工具函数解析 Provider 配置
        const providerConfig = resolveProviderConfig(config, key);

        if (!providerConfig) {
          return { success: false, error: `Provider "${key}" 不存在` };
        }

        // 4. 创建新的前台 Provider 实例
        const newProvider = createProviderFromConfig(key, {
          provider: providerConfig.provider,
          model: providerConfig.model,
          baseUrl: providerConfig.baseUrl || undefined,
          apiKey: providerConfig.apiKey || '',
        });

        // 5. 运行时切换 Provider（不重新初始化 Agent）
        // 内核 Agent 已支持 setProvider() 运行时切换，只需替换 API 出口
        // getCurrentAgent 是 MinimalIpcCallbacks 的必选方法，无需可选链
        const currentAgent = callbacks.getCurrentAgent();
        if (!currentAgent) {
          // Agent 未就绪时无法运行时切换，但 active 已持久化，下次 reinit 会自动应用
          return { success: true, error: null, warning: 'Agent 尚未就绪，已保存为默认 Provider，将在下次初始化时生效' };
        }

        currentAgent.setProvider(newProvider);

        // 同步切换后台 Provider（如果配置了）
        if (config.llm.background) {
          const bgProvider = createProviderFromConfig('background', config.llm.background);
          currentAgent.setBackgroundProvider(bgProvider);
        } else {
          currentAgent.setBackgroundProvider(null);
        }

        // 同步更新 lastProvider 缓存，避免后续 saveLlmConfig 误判需要 reinit
        // 场景：用户运行时切换 Provider 后，再修改 temperature 等非关键字段时，
        // reinit 判断逻辑会比较 llmConfig.provider 与 state.agentRuntime.lastProvider，
        // 若缓存未同步，会误判为需要 reinit（实际 Agent 已切换完成）。
        state.agentRuntime.lastProvider = providerConfig.provider;
        state.agentRuntime.lastModel = providerConfig.model;
        state.agentRuntime.lastBaseUrl = providerConfig.baseUrl ?? '';
        state.agentRuntime.lastApiKey = providerConfig.apiKey ?? '';

        return { success: true, error: null };
      } catch (err) {
        state.agentReady = false;
        callbacks.setAppRuntime(null);
        state.initErrorDetail = callbacks.classifyInitError(toError(err).message, '切换 Provider 失败');
        errorHandler.handle(err, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '切换激活 Provider 失败',
        });
        return { success: false, error: toError(err).message };
      }
    },
  );

  // 保存后台 Provider 选择（角色自动匹配 LLM 辅助 + Insight 提取等后台任务）
  // 持久化到 config.json + 运行时注入 bgProvider 到 Agent
  ipcMain.handle(
    IPC_CHANNELS.LLM_BACKGROUND_PROVIDER_SAVE,
    async (_event, key: string) => {
      if (typeof key !== 'string') {
        return { success: false, error: '参数无效' };
      }
      try {
        // 1. 持久化 background 配置到 config.json
        await saveBackgroundProvider(key);

        // 2. 运行时注入 bgProvider 到 Agent（若 Agent 已就绪）
        const currentAgent = callbacks.getCurrentAgent();
        if (currentAgent) {
          const config: Config = await spriteConfigStore.load();
          if (config.llm.background) {
            const bgProvider = createProviderFromConfig('background', config.llm.background);
            currentAgent.setBackgroundProvider(bgProvider);
          } else {
            currentAgent.setBackgroundProvider(null);
          }
        }

        return { success: true, error: null };
      } catch (err) {
        errorHandler.handle(err, {
          code: ErrorCode.INITIALIZATION_FAILED,
          context: '保存后台 Provider 失败',
        });
        return { success: false, error: toError(err).message };
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

  // 项目列表：Agent 未就绪时返回空数组
  ipcMain.handle(IPC_CHANNELS.PROJECTS_LIST, async () => {
    return { projects: [] };
  });

  // 渲染进程通知主进程主题已变更，动态设置窗口背景色
  ipcMain.on(IPC_CHANNELS.THEME_CHANGED, (_event, theme: 'light' | 'dark') => {
    const bgColor = theme === 'dark' ? '#1e1e2e' : '#f0f0f2';
    state.windowService.windowManager?.updateBackgroundColor(bgColor);
  });

  // 渲染进程日志上报（转发到主进程 logger）
  // 渲染进程无 pino，通过 IPC 将错误/警告转发到主进程统一日志
  ipcMain.on(IPC_CHANNELS.RENDERER_LOG, (_event, payload: { level: 'warn' | 'error'; context: string; message: string }) => {
    const { level, context, message } = payload;
    // 校验日志参数类型和长度，防止超长日志撑大文件
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