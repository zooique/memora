/**
 * live 轮投影（从会话运行态缓冲组装未落盘的流式轮）
 *
 * 三条护栏（与 postTurnUpdate 同一取舍）：
 *   ① 无缓冲（无流在跑 / 已收场清除）→ undefined，退化为纯历史重放；
 *   ② 缓冲归属会话 ≠ 目标会话（切走再切回旧会话）→ 不投影，防跨会话污染；
 *   ③ roundId 分界：当前 turn 尚无 chunk（roundId 未知）→ 无可投影轮。
 *
 * userMessage 取 seed（chat 开新轮）；resume 续跑轮缺省，由 mergeLiveRound 从落盘历史补，
 * 两边都拿不到则整轮不并入（半残数据不投）。
 */
import type { ProcessEvent } from '@zooique/memora';
import type { PendingLiveRound } from '../../shared/turnProjection.js';
import type { SessionRuntimeState } from './sessionRuntime.js';
import { mergeProcessEvents } from './processEventMerge.js';

/** 落盘事件日志的最小读口（step 边界 checkpoint 的事件） */
export interface EventLogReader {
  getById(roundId: string): { processEvents?: ProcessEvent[] } | null | undefined;
}

/**
 * 组装指定会话的 live 轮
 *
 * @param runtime 该会话的运行态（缓冲 / 种子 / 文本）
 * @param eventLog 落盘事件日志（缺省 = 无 checkpoint）
 * @param sessionId 目标会话（缓冲归属校验用）
 */
export function buildLiveTurn(
  runtime: SessionRuntimeState,
  eventLog: EventLogReader | undefined,
  sessionId: string,
): PendingLiveRound | undefined {
  const buf = runtime.liveBuffer;
  if (!buf || buf.sessionId !== sessionId) return undefined;
  const roundId = buf.currentRoundKey;
  if (!roundId) return undefined;
  // 落盘历史（step 边界 checkpoint 的部分事件）∪ 缓冲增量（seq 幂等去重保序）
  const prior = eventLog?.getById(roundId)?.processEvents ?? [];
  const buffered = buf.eventsByRound.get(roundId) ?? [];
  const merged = prior.length > 0 ? mergeProcessEvents(prior, buffered) : buffered;
  return {
    roundId,
    // 来源标记与开轮输入同源入 live 投影（resume 轮无 seed ⇒ 缺省，沿用盘上值）
    origin: buf.seedOrigin,
    userMessage: buf.seedUserMessage,
    processEvents: merged.length > 0 ? merged : undefined,
    streamingText: buf.textByRound.get(roundId),
  };
}
