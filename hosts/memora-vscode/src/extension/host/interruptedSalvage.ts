/**
 * 中断轮打捞与升级（崩溃残留轮 → 正常 stop turn）
 *
 * 为什么外置：同一段逻辑有两个消费者——① 视图生命周期（`chatPanel` 的 once-guard +
 * 会话日期取值 + 失败降级）；② 跨重启端到端验证（真杀进程后从磁盘恢复）。
 * 若 e2e 自己再写一遍「找残留 / 派生文本 / 逐轮 appendInterrupted」，验的就是复制品而非
 * 生产路径——**测过了不等于线上对**。故纯业务收敛到本模块，两条消费面共用一份实现
 * （视图层只保留生命周期与降级）。
 *
 * 语义定案（见 step-atomic-persistence.md）：中断轮 = 正常 turn（等同用户点「停止」）——
 * 可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。
 */

import type { Agent, IRoundStore } from '@zooique/memora';
import { deriveNarrateText } from '../../shared/narrateText.js';

/**
 * 内核收场面：从 `Agent['agentHistory']` 派生，**不手抄方法签名**。
 *
 * 为什么要派生而不是自己写一份 `appendInterrupted(roundId, opts?: {content?: string})`：
 * 手抄的签名在内核加参数后仍会「看起来兼容」（多出来的必填参数才会报错，改成可选/换语义
 * 则静默通过），而派生式在签名任何变动时立刻失配。内核未单独导出 `MessageHistory` 类型，
 * `Agent` 是公开面，故从它取。
 */
type AgentHistory = NonNullable<Agent['agentHistory']>;

/** 打捞所依赖的存储面（只读一个口；`IRoundStore` 上该成员是可选实现） */
export interface InterruptedSalvageDeps {
  store: Pick<IRoundStore, 'listInterruptedRecent'>;
  history: Pick<AgentHistory, 'appendInterrupted'>;
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
    // 文本派生走 shared 单点（webview 的中断轮「复制」用同一函数）：两处若各写一遍，
    // 「复制出来的文本」与「重启后恢复出来的文本」会分叉，且分叉时无任何报错
    await history.appendInterrupted(round.id, { content: deriveNarrateText(round.processEvents) });
  }
  return ordered.length;
}
