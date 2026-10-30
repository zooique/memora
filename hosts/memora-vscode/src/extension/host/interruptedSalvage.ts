/**
 * 中断轮打捞与升级（崩溃残留轮 → 正常 stop turn）
 *
 * 为什么外置：同一段逻辑有两个消费者——① 视图生命周期（`chatPanel` 的 once-guard +
 * 会话日期取值 + 失败降级）；② 跨重启端到端验证（真杀进程后从磁盘恢复）。
 * 若 e2e 自己再写一遍「过滤 narrate / 按 seq 拼接 / 逐轮 appendInterrupted」，
 * 验的就是复制品而非生产路径——**测过了不等于线上对**。故纯业务收敛到本模块，
 * 两条消费面共用一份实现（视图层只保留生命周期与降级）。
 *
 * 语义定案（见 step-atomic-persistence.md）：中断轮 = 正常 turn（等同用户点「停止」）——
 * 可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。
 */

import type { IRoundStore, ProcessEvent, Round } from '@zooique/memora';

/**
 * 从轮的过程事件里派生「已产出的助手文本」。
 *
 * 口径：只取 `narrate` 事件、按 seq 升序、原样拼接（顺带保留段间原有空白）。
 * 纯工具阶段崩溃（无叙述）⇒ 返回空串，调用方据此不写 assistantMessage，
 * 仍按 stop 语义收场（内核 `appendInterrupted` 支撑该形态）。
 */
export function deriveInterruptedContent(round: Round): string {
  return (round.processEvents ?? [])
    .filter((e): e is Extract<ProcessEvent, { type: 'narrate' }> => e.type === 'narrate')
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.payload.content)
    .join('');
}

/** 内核收场面（只声明用到的成员，便于测试注入桩；真源仍是 `Agent.agentHistory`） */
export interface InterruptedHistory {
  appendInterrupted(roundId: string, opts?: { content?: string }): Promise<void>;
}

/** 打捞所依赖的存储面（只读一个口；`IRoundStore` 上该成员是可选实现） */
export interface InterruptedSalvageDeps {
  store: Pick<IRoundStore, 'listInterruptedRecent'>;
  history: InterruptedHistory;
  /** YYYY-MM-DD；宿主只持当前会话日期，故打捞面按它过滤 */
  sessionDate: string;
}

/**
 * 打捞并升级：找到 → 按 createdAt 升序 → 逐轮派生文本 → 交内核收场。
 *
 * @returns 本次升级（或幂等跳过）的轮数；0 = 无残留
 */
export async function salvageInterruptedRounds(deps: InterruptedSalvageDeps): Promise<number> {
  const { store, history, sessionDate } = deps;
  const interrupted = store.listInterruptedRecent?.(sessionDate) ?? [];
  if (interrupted.length === 0) return 0;
  // 按 createdAt 升序登记（保序入 roundIds，恢复后对话时序正确）
  const ordered = [...interrupted].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const round of ordered) {
    await history.appendInterrupted(round.id, { content: deriveInterruptedContent(round) });
  }
  return ordered.length;
}
