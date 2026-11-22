/**
 * 盖章会话卡投影状态（DISPATCH-CARD-TURN-1）——chatView 域外置
 *
 * 持有快照 + turn 级卡片身份表 + 幂等投影，chatView 只在 5 个事件点接线（快照到达 /
 * 每轮重放 / 实时过程事件 / 重放前复位 / 重投影）。
 *
 * 身份 = `(sid, roundId)`：同一会话被派活多次 ⇒ 多张卡，各自钉在触发轮；
 * **不做后到覆盖**（那是已被改判的 DISPATCH-CARD-POS-1 旧口径）。存在性/展示名仍来自
 * `session_activity` 快照；轮锚点由 webview 从 replay 的 processEvents 或实时
 * `process_event.roundId` 现场解析（宿主派发受理当下拿不到 roundId，不新增落盘字段）。
 *
 * 无 DOM 全局依赖（messages 容器由 project 注入），符合 helpers 落点纪律。
 */
import type { ProcessEvent } from '@zooique/memora';
import { dispatchedSidTextsFromEvents } from './processEventText.js';
import {
  renderDispatchCards,
  type DispatchedSessionView,
  type DispatchCardEntry,
} from './dispatchSessionCard.js';

export interface DispatchCardProjection {
  /** 收到 session_activity 快照：更新存在性/旋转真源并重投影 */
  setSnapshot(
    sessions: readonly DispatchedSessionView[] | undefined,
    runningIds: readonly string[],
  ): void;
  /** 登记一轮的派活事件；返回是否新增了卡片身份（供实时路径决定是否重投影） */
  noteRound(roundId: string | undefined, events: readonly ProcessEvent[]): boolean;
  /** 复位 turn 身份表（跨会话/重放重建失效） */
  reset(): void;
  /** 用当前状态投影卡片到消息流（仅助手形态生效） */
  project(messages: HTMLElement): void;
  /** sid → 会话标题（凭证条用；取自已推的会话快照，取不到返回 undefined，不编造） */
  titleFor(sid: string): string | undefined;
}

/** 身份键带长度前缀，避免 sid/roundId 含分隔符时串键 */
function entryKey(sid: string, roundId: string): string {
  return `${sid.length}:${sid}:${roundId}`;
}

export function createDispatchCardProjection(
  isAssistantForm: () => boolean,
): DispatchCardProjection {
  let sessions: DispatchedSessionView[] = [];
  let running: string[] = [];
  let entries: DispatchCardEntry[] = [];
  const seen = new Set<string>();
  // 实时路径逐条事件到达，而 sid 解析要 tool_start + tool_result 成对；按轮攒齐再解析。
  const eventsByRound = new Map<string, ProcessEvent[]>();
  const seqByRound = new Map<string, Set<number>>();
  return {
    setSnapshot(next, runningIds) {
      sessions = [...(next ?? [])];
      running = [...runningIds];
    },
    noteRound(roundId, events) {
      if (!roundId || events.length === 0) return false;
      const list = eventsByRound.get(roundId) ?? [];
      const seqs = seqByRound.get(roundId) ?? new Set<number>();
      for (const ev of events) {
        if (seqs.has(ev.seq)) continue;
        seqs.add(ev.seq);
        list.push(ev);
      }
      eventsByRound.set(roundId, list);
      seqByRound.set(roundId, seqs);
      let added = false;
      for (const { sid, text } of dispatchedSidTextsFromEvents(list)) {
        const key = entryKey(sid, roundId);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ sid, roundId, text });
        added = true;
      }
      return added;
    },
    reset() {
      entries = [];
      seen.clear();
      eventsByRound.clear();
      seqByRound.clear();
    },
    titleFor(sid) {
      // 标题真源 = 宿主推来的会话快照（与卡片同源）；快照未到或会话已删 ⇒ undefined，由调用方决定降级
      return sessions.find((s) => s.sid === sid)?.title;
    },
    project(messages) {
      if (!isAssistantForm()) return;
      renderDispatchCards(messages, sessions, running, entries);
    },
  };
}
