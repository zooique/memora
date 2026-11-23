/**
 * 待发（pending interject）队列的宿主侧操作：清空 / 删单条。
 *
 * 从 chatPanel 消息分发摘出（行数闸门倒逼 + 域 consolidation）：两分支原内嵌于
 * handleWebviewMessage，共用同一份「先读后变 → 丢弃信号帧 → 推新快照」契约却各写一遍，
 * 改契约要改两处易漏。归并后读写顺序与信号契约只此一处。
 *
 * 契约（webview 按「信号帧 → 快照帧」成对消耗，见 protocol.ts pending_discarded 注释）：
 *  1. 读：变之前从内核取被丢条目文本（webview diff 据此分流「消失 = 丢弃不上屏」）
 *  2. 变：调内核原子操作（宿主不维护镜像副本，SSOT = loop.pendingInterjections）
 *  3. 信号：postDiscarded 帧（仅在确实丢了条目时发；失败 = 队列未变 = 零信号）
 *  4. 快照：sync 紧跟信号帧推当前待发快照
 *
 * 本函数只编排顺序、不持有状态；所有副作用经 deps 窄口注入，便于单测与复用。
 */

/** clear_pending_queue / remove_pending_item 的 W→E 消息形状（与 protocol.ts 同构） */
export type PendingQueueMessage =
  { type: 'clear_pending_queue' } | { type: 'remove_pending_item'; index: number };

/** dispatchPendingQueueAction 所需的面板依赖（窄口：只暴露用到的能力，不外泄装配） */
export interface PendingQueueDeps {
  /** 读当前待发条目（变之前读，取被丢文本；内核返回只读数组，本函数只读取） */
  getPending: () => readonly string[];
  /** 原子清空全部，返回被清条数 */
  clearAll: () => number;
  /** 原子删单条（越界由内核判），返回是否成功 */
  removeOne: (index: number) => boolean;
  /** 清空成功的通知上屏（条数 > 0 时调） */
  postClearedNotice: (count: number) => void;
  /** 丢弃信号帧：携带被丢条目文本，须紧跟 sync 推快照 */
  postDiscarded: (items: readonly string[]) => void;
  /** 推当前待发快照（信号帧之后必调） */
  sync: () => void;
}

/**
 * 分发待发队列操作消息（清空 / 删单条）。
 * 行为契约见模块头；FIFO 时序（信号先于快照）由调用顺序保证。
 */
export function dispatchPendingQueueAction(msg: PendingQueueMessage, deps: PendingQueueDeps): void {
  if (msg.type === 'clear_pending_queue') {
    const before = deps.getPending(); // 先读：取被丢全部文本
    const cleared = deps.clearAll();
    if (cleared > 0) {
      deps.postClearedNotice(cleared);
      deps.postDiscarded(before);
    }
    deps.sync(); // 无论是否清到条目都推快照（队列已空也要让 webview 熄灭角标）
    return;
  }
  // remove_pending_item：先读后删，删除成功且被删文本存在才发丢弃信号
  const before = deps.getPending();
  const removed = before[msg.index];
  const ok = deps.removeOne(msg.index);
  if (ok && removed !== undefined) deps.postDiscarded([removed]);
  deps.sync();
}
