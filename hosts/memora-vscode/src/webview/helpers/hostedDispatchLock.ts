/**
 * 派发写权租约（`send_to_session` 宿主侧唯一判据 + 归还时机）
 *
 * 为什么必须核对：派发必然在目标会话里建新轮（内核 `appendUser` → `appendRoundId`），而会话
 * 文件的整写有 fail-closed 跨进程锁守卫。**不持锁就写**时内核只 warn 后丢掉引用——轮文件在、
 * 会话 `roundIds` 里没有它（孤儿轮），重启后这一轮从会话历史里消失（真机 2026-11-15）。
 *
 * 触发条件是具体的，不是偶发：目标会话文件**已存在**（重启前就有的会话）且本面板**未持锁**
 * （本进程没进过它、也不是它建的）；助手新建的会话因 `createSession` 已拿锁，所以只有
 * 「派给用户自建会话」会中招。
 *
 * 归还时机（本模块的另一半，别只拿不放）：
 * - 「本租约代拿」= 派发前本来**没**持锁。派发前已持锁的会话（用户进过 / 本窗口建的）不归本
 *   租约所有，归还由面板销毁与实例关闭负责（面板的既有长锁语义，本模块不碰）。
 * - 代拿的那把在**派发轮收场**时归还（面板 `runFlow` 收尾调用 `releaseIfIdle`）：既盖住建轮
 *   那一下的 `appendRoundId` 写盘，也不把目标会话长期占成「本窗口专用」。
 * - 收场时若用户正在该会话里看（`inUse`）⇒ 不归还：那一刻它已算「进入过的会话」，
 *   继续持有是面板既有语义；若仍在跑流（异常时序）⇒ 同样保留，避免写到一半丢锁。
 * - 异常路径：装配 / 对齐 / 复判失败在起流之前 ⇒ 面板 catch 里直接 `releaseIfIdle`；
 *   轮内抛错 ⇒ 走 `runFlow` 收尾同一入口；窗口关闭 ⇒ 面板销毁按持有集统一归还（流中延后到
 *   收场），进程被杀 ⇒ 文件锁随进程释放。
 *
 * 为什么外置：`chatPanel.ts` 贴 `max-lines` 基线（只降不升），这段是自足的「拿锁 → 归还」闭环，
 * 与 `hostedSessionCreate` 同一拆法——面板只留注入依赖的调用，不为过闸压平既有代码。
 */
import * as vscode from 'vscode';
import type { HostedDispatchResult } from '../../extension/host/workSessionTools.js';

// 本模块文案走 l10n（与面板同一套键面）
const { l10n } = vscode;

/** 派发写权的读口（全部由面板注入，本模块不持有任何实例） */
export interface DispatchWriteLockDeps {
  /** 取（或确认已持有）目标会话的跨进程写锁；false = 另一个窗口正持有 */
  acquire: (sessionId: string) => Promise<boolean>;
  /** 本面板当前是否已长持有该会话锁（决定「这把锁归不归本次派发」） */
  holds: (sessionId: string) => boolean;
  /** 归还本面板长持有的该会话锁 */
  release: (sessionId: string) => void;
  /**
   * 该会话此刻是否仍在用（用户正在看 / 仍在跑流）
   *
   * 在用 ⇒ 收尾不归还：它已是「进入过的会话」，长锁由面板销毁 / 实例关闭负责，
   * 派发不该把它中途放掉。
   */
  inUse: (sessionId: string) => boolean;
}

/** 派发写权租约 */
export interface DispatchWriteLease {
  /** 拒收回执（`undefined` = 已持锁，可继续派发） */
  refusal?: Extract<HostedDispatchResult, { ok: false }>;
  /**
   * 收尾归还（幂等，可多次调用）
   *
   * 只在「本租约代拿、且目标会话已不在用」时真正归还；派发前就持有的锁一概不动。
   */
  releaseIfIdle: () => void;
}

/**
 * 拒收回执（唯一措辞来源）
 *
 * 必须带**可操作的下一步**：模型据此改动作，而不是只看到一个码去猜（是要换会话还是等一会儿）。
 */
function lockedRefusal(): Extract<HostedDispatchResult, { ok: false }> {
  return {
    ok: false,
    code: 'E_LOCKED',
    message: l10n.t(
      'Memora: another window is using the target session; the input was not sent. Send it later, or switch to another session.',
    ),
  };
}

/**
 * 取派发写权，拿到一个「收尾自动归还」的租约
 *
 * @param deps 取锁 / 持锁 / 归还 / 占用 读口
 * @param targetSessionId 目标会话
 * @returns 租约：`refusal` 非空 = 拒收（不起流）；否则派发轮收场时调 `releaseIfIdle`
 */
export async function acquireDispatchWriteLease(
  deps: DispatchWriteLockDeps,
  targetSessionId: string,
): Promise<DispatchWriteLease> {
  // 派发前已持锁 = 用户进过 / 本窗口建的会话：这把锁不归本次派发，收尾也不归还
  const ownedBefore = deps.holds(targetSessionId);
  if (!(await deps.acquire(targetSessionId)))
    return { refusal: lockedRefusal(), releaseIfIdle() {} };
  /** 幂等标记（收尾可能被 catch 与流尾各调一次） */
  let released = false;
  return {
    releaseIfIdle: () => {
      if (released || ownedBefore) return;
      if (deps.inUse(targetSessionId)) return;
      released = true;
      deps.release(targetSessionId);
    },
  };
}
