/**
 * 盖章会话卡投影状态（DISPATCH-CARD-INLINE-1）——chatView 域外置
 *
 * 持有三份渲染状态 + 幂等投影，chatView 只在 4 个事件点接线（快照到达 / 每轮重放 / 重放前复位 / 重投影）。
 * 存在性来自 session_activity 快照（真源），触发轮锚点由 webview 现场解析：
 *   - replay：每轮 processEvents 里的 create_session / send_to_session 成功事件；
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
  /** replay 每轮：解析本轮盖章事件，登记 sid → 轮 id（首次盖章 = 触发轮） */
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
        if (!anchors.has(sid)) anchors.set(sid, roundId); // 首次盖章 = 触发轮
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
