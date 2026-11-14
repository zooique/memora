/**
 * 主控停止会话（工具 `stop_work_session` 的实现域）
 *
 * 为什么外置：面板已贴 `max-lines` 基线，这段「门禁 → 复用用户停止 → 结果信封」是完整闭环，
 * 留在面板只会挤掉既有注释；按 B9-D 的既有拆法，实现收到 helpers，面板只留薄壳。
 *
 * 事实边界：
 *   - **复用用户停止的同一条实现**（面板注入 `handleStop`，即 `_runOps.handleStop`），
 *     不另造 abort / 收场 / 通知；
 *   - 只判「本窗口有没有活可停」，不做归属裁决——归属由工具层用创建者账本 + 历史判
 *     （面板没有重启后的历史上下文，在这里重判会与工具层漂移）；
 *   - 目标没有活实例 ⇒ `stopped:false`，**不**为了停而去装配一个新实例（那会凭空造出运行态）。
 */
import * as vscode from 'vscode';
import type { HostedStopResult } from '../../extension/host/workSessionTools.js';

// 本模块错误文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 停止依赖（全部由面板注入，本模块不持有任何实例） */
export interface HostedSessionStopDeps {
  /** 调用方是否托管（纵深防守：不只靠工具面缺席） */
  isManaged: (sessionId: string) => boolean;
  /** 既有停止实现（用户停止与代理停止的唯一入口） */
  handleStop: (sessionId: string) => Promise<boolean>;
}

/**
 * 停止目标会话的当前轮
 *
 * @param deps 面板注入的读口
 * @param callingSessionId 调用方（非托管 = E_DENIED）
 * @param targetSessionId 目标会话
 * @returns 结果信封（`stopped:false` = 目标已收场 / 本来没跑，不是错误）
 */
export async function stopHostedSession(
  deps: HostedSessionStopDeps,
  callingSessionId: string,
  targetSessionId: string,
): Promise<HostedStopResult> {
  if (!deps.isManaged(callingSessionId)) {
    return {
      ok: false,
      code: 'E_DENIED',
      message: l10n.t('Memora: only managed sessions can stop other sessions.'),
    };
  }
  try {
    // 复用用户停止路径；返回 false = 目标当前没有流 / 不是 paused
    return { ok: true, stopped: await deps.handleStop(targetSessionId) };
  } catch (err) {
    // 业务契约：不 throw（与派发 / 建会话一致，工具层要能读到可判读的结果）
    return {
      ok: false,
      code: 'E_HOST',
      message: err instanceof Error ? err.message : l10n.t('Memora: failed to stop the session.'),
    };
  }
}
