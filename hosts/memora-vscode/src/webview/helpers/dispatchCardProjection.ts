/**
 * 盖章会话卡投影状态（DISPATCH-CARD-INLINE-1）——chatView 域外置
 *
 * 持有三份渲染状态 + 幂等投影，chatView 只在 4 个事件点接线（快照到达 / 每轮重放 / 重放前复位 / 重投影）。
 * 存在性来自 session_activity 快照（真源），触发轮锚点由 webview 现场解析：
 *   - replay：每轮 processEvents 里的 create_session / send_to_session 成功事件，**后到覆盖**
 *     （DISPATCH-CARD-POS-1：锚点 = 该 sid 最后一次成功盖章轮 = 最新 turn，卡随追加的下一次派发
 *     下移；「直接回答不派活」触发 replay 时不再跳回最早触发轮 = 真机置顶 bug 的根治）；
 *   - 实时：不登记（当下对话即流尾，卡落流尾 = 正确实时表现；重启 replay 再精确归位）。
 *
 * 无 DOM 全局依赖（messages 容器由 project 注入），符合 helpers 落点纪律；零协议/落盘改动。
 */
import type { ProcessEvent } from '@zooique/memora';
import { dispatchedSidsFromEvents } from './processEventText.js';
import { renderDispatchCards, type DispatchedSessionView } from './dispatchSessionCard.js';

export interface DispatchCardProjection {
  /** 收到 session_activity 快照：更新存在性/旋转真源并重投影 */
  setSnapshot(
    sessions: readonly DispatchedSessionView[] | undefined,
    runningIds: readonly string[],
  ): void;
  /** replay 每轮：解析本轮盖章事件，登记 sid → 轮 id（后到覆盖 = 最新盖章轮） */
  noteRound(roundId: string | undefined, events: readonly ProcessEvent[]): void;
  /** replay 前复位锚点（跨会话/重建失效） */
  reset(): void;
  /** 用当前状态投影卡片到消息流（仅助手形态生效） */
  project(messages: HTMLElement): void;
}

export function createDispatchCardProjection(
  isAssistantForm: () => boolean,
): DispatchCardProjection {
  let sessions: DispatchedSessionView[] = [];
  let running: string[] = [];
  const anchors = new Map<string, string>();
  return {
    setSnapshot(next, runningIds) {
      sessions = [...(next ?? [])];
      running = [...runningIds];
    },
    noteRound(roundId, events) {
      if (!roundId || events.length === 0) return;
      for (const sid of dispatchedSidsFromEvents(events)) {
        anchors.set(sid, roundId); // 后到覆盖 = 最新盖章轮（DISPATCH-CARD-POS-1）
      }
    },
    reset() {
      anchors.clear();
    },
    project(messages) {
      if (!isAssistantForm()) return;
      renderDispatchCards(messages, sessions, running, anchors);
    },
  };
}
