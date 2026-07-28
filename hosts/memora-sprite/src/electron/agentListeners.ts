/**
 * Agent 监听器 — 配置建议 + 写入确认 + 审计日志
 *
 * 职责：
 *   1. H1 配置建议回调（AutoConfigRefiner → SUGGESTION_PUSH 推送到渲染进程）
 *   2. M1 写入确认回调（SecurityGuard → WRITE_CONFIRMATION 推送 → 确认对话框）
 *   3. M2 审计日志订阅（SecurityGuard.onAudit → JSONL 持久化）
 *
 * 这些监听器在 Agent 初始化完成后注册，Agent 重新初始化时需重新注册
 * （旧 Agent 已 close，回调自动失效）。
 *
 * 设计说明：
 *   onConfigSuggestion / onWriteConfirmation 返回 void（内核未提供取消订阅机制），
 *   onAudit 返回 unsubscribe 函数但需 main.ts 协调 reinitAgent 时调用。
 *   当前设计依赖 Agent.close() 清理内部状态——close 后 security/config 实例失效，
 *   即使回调残留也无法执行有意义的操作（webContents.send 会被 isDestroyed 守卫拦截）。
 *   若未来内核支持所有回调的取消订阅，应在此处保存并返回 unsubscribe 函数。
 */

import type { Agent } from 'memora';
import { logger, safeSetTimeout, clearSafeTimeout } from 'memora';
import { MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';
// windowManager 字段使用 WindowManagerLike 接口而非 WindowManager 类，
// 切断 agentListeners.ts → windowManager.ts → esmShim.ts 的类型追踪链，
// 避免 preload（CJS 编译）追踪到 esmShim.ts（ESM 运行时）导致 import.meta.url 编译错误（TS1343）。
import type { WindowManagerLike } from './runtime/windowService.js';
import type { AuditManager } from '../sprite/audit/auditManager.js';
import { CONFIRMATION_TIMEOUT_MS } from '../sprite/constants.js';
// isFullWindowAccessible 用于写入确认的请求-响应场景（窗口不可见时快速失败）
// safeSendToWindow 用于配置建议的单向推送（渲染层缓存隐藏窗口的 IPC）
import { isFullWindowAccessible, safeSendToWindow } from './windows/windowUtils.js';

/**
 * Agent 监听器依赖
 *
 * 由 main.ts 注入，避免直接访问全局变量。
 */
export interface AgentListenerDeps {
  /** 窗口管理器（获取完整窗口引用） */
  windowManager: WindowManagerLike;
  /** M1 写入确认：等待渲染进程响应的 Promise resolver 映射表（requestId → resolve） */
  pendingWriteConfirmations: Map<string, (confirmed: boolean) => void>;
}

/**
 * 注册配置建议回调
 *
 * 当 AutoConfigRefiner 从对话中提取到配置建议时，内核通过 onConfigSuggestion 回调推送。
 * 此函数将建议通过 SUGGESTION_PUSH 通道转发到渲染进程，由 SuggestionCard 组件展示。
 *
 * 调用时机：Agent 初始化完成后（initAgentFromConfig 返回后）
 * 重新初始化时：先移除旧回调（通过 reinitAgent 重建 Agent 实现，旧 Agent 已 close）
 *
 * @param activeAgent 已就绪的 Agent 实例
 * @param deps 依赖
 */
export function setupConfigSuggestionListener(activeAgent: Agent, deps: AgentListenerDeps): void {
  const config = activeAgent.config;
  if (!config) {
    logger.warn('[setupConfigSuggestionListener] ConfigManager 未就绪，跳过配置建议回调注册');
    return;
  }

  config.onConfigSuggestion((suggestion) => {
    const fullWindow = deps.windowManager.getFullWindow();
    // 单向推送 + 渲染层缓存：webContents.send 向隐藏窗口发送不抛异常，
    // 渲染层在窗口隐藏时仍能接收并缓存建议，窗口可见时直接展示。
    // 仅需 null/destroyed 守卫（safeSendToWindow 内置），跳过 isVisible 避免建议永久丢失
    // （BUG-6 同类模式：AutoConfigRefiner 下次对话不一定再提取到相同建议）
    safeSendToWindow(fullWindow, MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH, {
      type: suggestion.type,
      name: suggestion.name,
      content: suggestion.content,
      confidence: suggestion.confidence,
      source: suggestion.source,
    });
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
 * @param activeAgent 已就绪的 Agent 实例
 * @param deps 依赖
 */
export function setupWriteConfirmationListener(activeAgent: Agent, deps: AgentListenerDeps): void {
  const security = activeAgent.security;
  if (!security) {
    logger.warn('[setupWriteConfirmationListener] SecurityGuard 未就绪，跳过写入确认回调注册');
    return;
  }

  // 注册窗口关闭监听器：窗口销毁时立即拒绝所有 pending 确认，
  // 避免 SecurityGuard 工具链阻塞 30s 等超时（窗口关闭后用户无法响应）
  const fullWindowForClose = deps.windowManager.getFullWindow();
  if (fullWindowForClose && !fullWindowForClose.isDestroyed()) {
    fullWindowForClose.on('closed', () => {
      if (deps.pendingWriteConfirmations.size === 0) return;
      logger.warn(
        { count: deps.pendingWriteConfirmations.size },
        '[写入确认] 完整窗口关闭，自动拒绝所有 pending 写入确认',
      );
      for (const resolver of deps.pendingWriteConfirmations.values()) {
        resolver(false);
      }
      deps.pendingWriteConfirmations.clear();
    });
  }

  // 写入确认超时（毫秒）：窗口关闭等异常情况下自动拒绝

  security.onWriteConfirmation(async (info) => {
    // 不需要确认时直接放行（owner 模式 + confirmWrites=false）
    if (!info.needsConfirm) {
      return true;
    }

    const fullWindow = deps.windowManager.getFullWindow();
    // 写入确认是请求-响应场景：窗口不可见时用户无法看到对话框，
    // 立即拒绝优于等待 30s 超时（安全优先 + 快速失败）。
    // 与 SUGGESTION_PUSH/SPRITE_EVENT 的单向推送不同——此处保留 isVisible 检查是必要的。
    if (!isFullWindowAccessible(fullWindow)) {
      // 窗口不可用时自动拒绝（安全优先）
      logger.warn({ path: info.targetPath }, '[写入确认] 窗口不可用，自动拒绝写入');
      return false;
    }

    // 生成唯一请求 ID
    const requestId = `wc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 创建 Promise 等待渲染进程响应
    const confirmed = await new Promise<boolean>((resolve) => {
      // 超时保护：30 秒后自动拒绝（使用 safeSetTimeout 便于统一追踪生命周期）
      const timeoutId = safeSetTimeout(() => {
        deps.pendingWriteConfirmations.delete(requestId);
        logger.warn({ requestId, path: info.targetPath }, '[写入确认] 超时未响应，自动拒绝');
        resolve(false);
      }, CONFIRMATION_TIMEOUT_MS);

      // 存入映射表（包装 resolve 以清理超时定时器）
      deps.pendingWriteConfirmations.set(requestId, (result: boolean) => {
        clearSafeTimeout(timeoutId);
        resolve(result);
      });

      // 推送到渲染进程（透传 diff 内容，供确认弹窗展示变更预览）
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION, {
        requestId,
        targetPath: info.targetPath,
        tool: info.tool,
        description: info.description,
        permission: info.permission,
        needsConfirm: info.needsConfirm,
        beforeContent: info.beforeContent,
        afterContent: info.afterContent,
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
 *
 * @param activeAgent 已就绪的 Agent 实例
 * @param activeAuditManager 审计日志管理器
 */
export function setupAuditListener(activeAgent: Agent, activeAuditManager: AuditManager): void {
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
