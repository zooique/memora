import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

/**
 * 插话入队回执（INTERJECT-LIVE-SYNC-1）：interject 已「先入队、后落盘」到 currentRoundId，
 * 本消息只是同一次落盘事实的投影——助手形态据此即时上屏，工作形态忽略（仍走队列消费）。
 */
export function interjectEcho(
  text: string,
  ts: string,
  roundId: string,
): ExtensionToWebviewMessage {
  return { type: 'user', text, ts, roundId, kind: 'supplement', echo: 'enqueued' };
}
