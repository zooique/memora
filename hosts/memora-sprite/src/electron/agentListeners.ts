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
 */

import type { Agent } from 'memora';
import { logger } from 'memora';
import { MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
import type { WindowManager } from './windows/windowManager.js';
import type { AuditManager } from '../sprite/auditManager.js';

/**
 * Agent 监听器依赖
 *
 * 由 main.ts 注入，避免直接访问全局变量。
 */
export interface AgentListenerDeps {
  /** 窗口管理器（获取完整窗口引用） */
  windowManager: WindowManager;
  /** M1 写入确认：等待渲染进程响应的 Promise resolver 映射表（requestId → resolve） */
  pendingWriteConfirmations: Map<string, (confirmed: boolean) => void>;
}

/**
 * H1：注册配置建议回调
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
    // 复用可见性检查模式
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
 * @param activeAgent 已就绪的 Agent 实例
 * @param deps 依赖
 */
export function setupWriteConfirmationListener(activeAgent: Agent, deps: AgentListenerDeps): void {
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

    const fullWindow = deps.windowManager.getFullWindow();
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
        deps.pendingWriteConfirmations.delete(requestId);
        logger.warn({ requestId, path: info.targetPath }, '[写入确认] 超时未响应，自动拒绝');
        resolve(false);
      }, CONFIRMATION_TIMEOUT_MS);

      // 存入映射表（包装 resolve 以清理超时定时器）
      deps.pendingWriteConfirmations.set(requestId, (result: boolean) => {
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
