/**
 * 派发前的写权核对（`send_to_session` 宿主侧唯一判据）
 *
 * 为什么必须核对：派发必然在目标会话里建新轮（内核 `appendUser` → `appendRoundId`），而会话
 * 文件的整写有 fail-closed 跨进程锁守卫。**不持锁就写**时内核只 warn 后丢掉引用——轮文件在、
 * 会话 `roundIds` 里没有它（孤儿轮），重启后这一轮从会话历史里消失（真机 2026-11-15）。
 *
 * 触发条件是具体的，不是偶发：目标会话文件**已存在**（重启前就有的会话）且本面板**未持锁**
 * （本进程没进过它、也不是它建的）；助手新建的会话因 `createSession` 已拿锁，所以只有
 * 「派给用户自建会话」会中招。
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 基线（只降不升），这段是自足的「拿锁 → 拒收」闭环，
 * 与 `hostedSessionCreate` 同一拆法——面板只留一行调用，不为过闸压平既有代码。
 */
import * as vscode from 'vscode';
import type { HostedDispatchResult } from '../../extension/host/workSessionTools.js';

// 本模块文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 派发前的写权依赖（只取「拿锁」一件；长锁归面板锁收尾器持有与归还） */
export interface DispatchWriteLockDeps {
  /** 取（或确认已持有）目标会话的跨进程写锁；false = 另一个窗口正持有 */
  acquire: (sessionId: string) => Promise<boolean>;
}

/**
 * 核对派发前的写权
 *
 * 成功即本面板长持有该会话锁（与 `createSession` / 进入会话同一把锁）；失败不排队，
 * 如实回 `E_LOCKED`——不假装受理，否则又是一条「发出去了但没落地」的假回执。
 *
 * @param deps 取锁读口
 * @param targetSessionId 目标会话
 * @returns `undefined` = 已持锁可继续派发；否则是如实拒收的回执
 */
export async function ensureDispatchWriteLock(
  deps: DispatchWriteLockDeps,
  targetSessionId: string,
): Promise<Extract<HostedDispatchResult, { ok: false }> | undefined> {
  if (await deps.acquire(targetSessionId)) return undefined;
  return {
    ok: false,
    code: 'E_LOCKED',
    message: l10n.t('Memora: another window is using the target session; the input was not sent.'),
  };
}
