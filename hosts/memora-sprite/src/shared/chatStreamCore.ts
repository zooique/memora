/**
 * 对话流式输出核心工具（跨宿主共享层）
 *
 * 职责：
 *   提供 Electron IPC 适配层（chatStreamHandler.ts）与 Web SSE 适配层（chatStreamRoutes.ts）
 *   共用的流式输出业务逻辑。
 *
 * 共享内容：
 *   1. STREAM_NO_PROGRESS_TIMEOUT_MS 无进展超时阈值常量
 *   2. createStreamTimeoutGuard 无进展超时状态机（管理 timer + streamTimedOut 标志）
 *   3. resetSessionIfNeeded 跨日/跨会话自动重置
 *
 * 不共享的内容（差异太大，强行抽象会引入接口爆炸）：
 *   - chunk 分发：IPC 推 webContents.send vs SSE 推 res.write，参数构造有细微差异
 *   - 错误处理：IPC 推 SPRITE_ERROR 弹窗 vs SSE 推 error 事件
 *   - finally 清理：Electron 有托盘/浮动窗口/未读计数，Web 有客户端断开检测
 *
 * 设计原则：
 *   - 嫁接而非并列（§2.2）：在现有逻辑上生长，两个适配层保留各自传输层差异
 *   - 单一真理源：超时阈值和跨日重置逻辑只在此处定义，适配层引用即可
 *
 * 集成点：
 *   - electron/ipc/chatStreamHandler.ts（Electron IPC 适配层）
 *   - web/routes/chatStreamRoutes.ts（Web SSE 适配层）
 */

import type { Agent } from 'memora';
import { getLocalDate } from '../sprite/constants.js';

// ─── 常量 ──────────────────────────────────────────────────

/**
 * 流式输出"无进展"超时阈值（毫秒）
 *
 * 主进程兜底：每个 chunk 到达即重置定时器，超过此时长无任何 chunk
 * 则判定为 generator 挂起（LLM 卡死 / postProcess 阻塞 / abort 未响应等），
 * 强制清理宿主状态并通知渲染层/客户端解锁，避免 AbortController 泄漏导致后续对话被竞态保护拒绝。
 *
 * 时长取舍：晚于渲染进程 30s 兜底（留出 abort 响应窗口），早于内核 3 分钟锁超时（CHAT_LOCK_TIMEOUT_MS = 180_000）。
 */
export const STREAM_NO_PROGRESS_TIMEOUT_MS = 60_000;

// ─── 无进展超时状态机 ─────────────────────────────────────

/**
 * 无进展超时状态机选项
 */
export interface StreamTimeoutGuardOptions {
  /**
   * 超时回调：超时触发时由适配层各自处理 abort + IPC/SSE 推送
   *
   * 设计为回调而非内置逻辑，是因为两个适配层的超时处理差异大：
   * - Electron：abortController.abort() + agent.forceReleaseChatLock()，IPC 推送在 finally 块统一发送
   * - Web：abortController.abort() + 直接 writeSSE(ERROR) + writeSSE(END) + res.end()（超时路径在定时器内完成清理）
   */
  onTimeout: () => void;
}

/**
 * 无进展超时状态机返回值
 */
export interface StreamTimeoutGuard {
  /** 重置定时器（chunk 到达或对话开始时调用） */
  reset: () => void;
  /** 查询是否已超时（catch/finally 块判断超时路径用） */
  isTimedOut: () => boolean;
  /** 清理定时器（finally 块调用，避免定时器泄漏） */
  cleanup: () => void;
}

/**
 * 创建无进展超时状态机
 *
 * 封装 streamTimedOut 标志 + streamTimeoutTimer 定时器的管理逻辑，
 * 消除两个适配层中重复的 resetStreamTimeout 函数。
 *
 * 状态机生命周期：
 *   create → reset（首次启动）→ reset（每个 chunk）→ cleanup（finally）
 *                                    ↓
 *                              超时触发 onTimeout
 *
 * @param options 超时回调选项
 * @returns 状态机接口（reset / isTimedOut / cleanup）
 */
export function createStreamTimeoutGuard(options: StreamTimeoutGuardOptions): StreamTimeoutGuard {
  // 超时标志：超时后设为 true，catch/finally 块据此跳过重复处理
  let streamTimedOut = false;
  // 定时器句柄：每次 reset 时清理旧定时器、启动新定时器
  let streamTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

  return {
    /** 重置定时器：清理旧的 + 启动新的 */
    reset(): void {
      if (streamTimeoutTimer !== null) clearTimeout(streamTimeoutTimer);
      streamTimeoutTimer = setTimeout(() => {
        // 幂等保护：已超时则跳过（防止定时器回调重复触发）
        if (streamTimedOut) return;
        streamTimedOut = true;
        streamTimeoutTimer = null;
        // 触发适配层各自的超时处理（abort + 推送）
        options.onTimeout();
      }, STREAM_NO_PROGRESS_TIMEOUT_MS);
    },
    /** 查询超时标志 */
    isTimedOut(): boolean {
      return streamTimedOut;
    },
    /** 清理定时器：finally 块调用，避免定时器泄漏 */
    cleanup(): void {
      if (streamTimeoutTimer !== null) {
        clearTimeout(streamTimeoutTimer);
        streamTimeoutTimer = null;
      }
    },
  };
}

// ─── 跨日/跨会话自动重置 ─────────────────────────────────

/**
 * 跨日/跨会话自动重置结果
 */
export type SessionResetResult =
  | { ok: true; reset: boolean }  // ok=true：检查完成；reset=true：执行了重置，false：无需重置
  | { ok: false; error: string }; // ok=false：SessionManager 未初始化，error 为错误提示

/**
 * 跨日/跨会话自动重置：确保新消息始终归当天 main 会话
 *
 * 两个适配层逻辑完全相同，提取为单一真理源。
 *
 * 重置流程：
 *   1. 检查 agent.agentHistory.currentDateValue 是否等于今天
 *   2. 不等则 switchSession('main') + restoreSession(todayDate, 'main')
 *   3. restoreSession 返回 0（无消息）时清理 agentLoop 历史上下文
 *
 * @param agent Agent 实例（提供 agentHistory / sessionManager / agentLoop）
 * @returns 重置结果（ok=false 时调用方应推送错误提示并中止对话）
 */
export async function resetSessionIfNeeded(agent: Agent): Promise<SessionResetResult> {
  const history = agent.agentHistory;
  if (!history) {
    // 无 agentHistory 时不需重置（内核未启用会话管理）
    return { ok: true, reset: false };
  }

  const todayDate = getLocalDate();
  if (history.currentDateValue === todayDate) {
    // 日期一致，无需重置
    return { ok: true, reset: false };
  }

  // 日期不一致：重置到当天 main 会话
  const sessionManager = agent.sessionManager;
  if (!sessionManager) {
    return { ok: false, error: '会话管理器未初始化，请稍后重试' };
  }

  // 先 switchSession 再 restoreSession，与其他路径一致
  sessionManager.switchSession('main');
  const restoredCount = await sessionManager.restoreSession(todayDate, 'main');
  // restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
  if (restoredCount === 0 && agent.agentLoop) {
    agent.agentLoop.restoreHistory([]);
  }

  return { ok: true, reset: true };
}
