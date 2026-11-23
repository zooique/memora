/**
 * 中断轮打捞与升级（崩溃残留轮 → 正常 stop turn）
 *
 * 为什么外置：同一段逻辑有两个消费者——① 视图生命周期（`chatPanel` 的 once-guard +
 * 会话日期取值 + 失败降级）；② 跨重启端到端验证（真杀进程后从磁盘恢复）。
 * 若 e2e 自己再写一遍「找残留 / 派生文本 / 逐轮 appendInterrupted」，验的就是复制品而非
 * 生产路径——**测过了不等于线上对**。故纯业务收敛到本模块，两条消费面共用一份实现
 * （视图层只保留生命周期与降级）。
 *
 * 语义定案（见 step-atomic-persistence.md）：中断轮 = 正常 turn（**生命周期**等同用户点「停止」，
 * 成因不等同——见下方 `markSalvaged`）——可删、入会话 roundIds、作后续上下文，**不是**半成品草稿/孤儿。
 */

import type { Agent, IRoundStore, ProcessEvent, Round } from '@zooique/memora';
import { deriveNarrateText } from '../../shared/narrateText.js';
import type { FreshRoundReadable } from './workspaceRoundStore.js';

/**
 * 内核收场面：从 `Agent['agentHistory']` 派生，**不手抄方法签名**。
 *
 * 为什么要派生而不是自己写一份 `appendInterrupted(roundId, opts?: {content?: string})`：
 * 手抄的签名在内核加参数后仍会「看起来兼容」（多出来的必填参数才会报错，改成可选/换语义
 * 则静默通过），而派生式在签名任何变动时立刻失配。内核未单独导出 `MessageHistory` 类型，
 * `Agent` 是公开面，故从它取。
 */
type AgentHistory = NonNullable<Agent['agentHistory']>;

/** 打捞所依赖的存储面（只读一个口 + 收场前补标记要读改写；`IRoundStore` 上 list 为可选实现） */
export interface InterruptedSalvageDeps {
  store: Pick<IRoundStore, 'listInterruptedRecent' | 'getById' | 'save'>;
  history: Pick<AgentHistory, 'appendInterrupted'>;
  /** YYYY-MM-DD **本地日期**（会话 ID 日期前缀即本地日期）；打捞按本地日区间过滤，口径见 IRoundStore */
  sessionDate: string;
}

/**
 * 崩溃恢复的停止原因：内核 `AbortStopReason` 早已预留 `'interrupted'`（流式中断），
 * 本打捞正是它等的那个产生点——**不新增枚举值**，只启用已声明的语义。
 *
 * 跨层契约（改前先读）：`'interrupted'` 的**唯一生产者就是这里**，宿主据此把它映射成
 * 「异常退出后恢复」（`shared/interruptReason.ts`）。若内核将来新增流式中断产生点，
 * 必须**先分化枚举**再启用——否则所有流式中断都会被标成「进程异常退出后恢复」，
 * 在事实层编造原因（内核侧同一约定见 `src/agent/types.ts` 的 `AbortStopReason`）。
 */
const SALVAGE_STOP_REASON = 'interrupted' as const;

/**
 * 给残留轮补写「异常退出后恢复」标记（读改写，收场前完成）
 *
 * 为什么由打捞进程写：死掉的进程当然写不了；但重启后的宿主**知道**自己正在收场一个
 * 没跑完的轮——这是可测事实，不是猜测。补一条 `aborted` 事件后，`deriveInterruptReason`
 * 才能把「崩溃恢复」与「用户停 / 异常 / 真没原因」分开（事实层零新增字段）。
 *
 * @param round 盘上读到的残留轮
 * @returns 补好事件的轮；已有终止事件（非崩溃残留）时原样返回（幂等，不重复补）
 */
function markSalvaged(round: Round): Round {
  const events = round.processEvents ?? [];
  // 已有终止证据 ⇒ 该轮不是「进程没来得及写」，不冒充崩溃恢复
  if (events.some((e) => e.type === 'aborted' || e.type === 'error')) return round;
  const seq = events.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  /** 恢复标记事件：stopReason 是结构化判据，reason 仅供无 stopReason 的旧消费方兜底 */
  const event: ProcessEvent = {
    type: 'aborted',
    seq,
    ts: new Date().toISOString(),
    payload: { reason: 'host-restart-salvage', stopReason: SALVAGE_STOP_REASON },
  };
  return { ...round, processEvents: [...events, event] };
}

/**
 * 打捞并升级：找到 → 按 createdAt 升序 → 补恢复标记 → 逐轮派生文本 → 交内核收场。
 *
 * 标记必须先于 `appendInterrupted` 落盘：内核收场是 store-first 读改写（会原样保留
 * `processEvents`），先写标记才不会被收场快照覆盖。
 *
 * @returns 本次处理的候选轮数（含幂等跳过、以及盘上已消失而跳过者）
 */
export async function salvageInterruptedRounds(deps: InterruptedSalvageDeps): Promise<number> {
  const { store, history, sessionDate } = deps;
  const interrupted = store.listInterruptedRecent?.(sessionDate) ?? [];
  if (interrupted.length === 0) return 0;
  // 按 createdAt 升序登记（保序入 roundIds，恢复后对话时序正确）
  const ordered = [...interrupted].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const round of ordered) {
    // 收场前补标记：正文必须取**盘上现值**——`getById` 可能返回本进程旧缓存快照，用旧快照
    // 整轮 `save` 会把列表之后新落盘的事件写丢（= 改写历史，口径见 `FreshRoundReadable`）。
    // 没有该能力的替身 store 才退回 `getById`（生产 `WorkspaceRoundStore` 恒有）。
    const freshReadable = store as Partial<FreshRoundReadable>;
    // 盘上已消失（getByIdFresh 给 null）⇒ 不得回退旧缓存：那会把已删轮复活
    const fresh = freshReadable.getByIdFresh
      ? freshReadable.getByIdFresh(round.id)
      : store.getById(round.id);
    // 列表与盘上之间已被删 / 回收：无正文可标记，也不整轮回写；本就不该再收场
    if (!fresh) continue;
    const marked = markSalvaged(fresh);
    if (marked !== fresh) store.save(marked);
    // 文本派生走 shared 单点（webview 的中断轮「复制」用同一函数）：两处若各写一遍，
    // 「复制出来的文本」与「重启后恢复出来的文本」会分叉，且分叉时无任何报错。
    // 取 `marked`：与刚落盘的内容同源（含刚补的标记、且是盘上现值，不是列表快照）。
    await history.appendInterrupted(round.id, { content: deriveNarrateText(marked.processEvents) });
  }
  return ordered.length;
}
