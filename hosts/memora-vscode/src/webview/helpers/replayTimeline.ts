/**
 * 重放时间线交织 — 纯函数（CHATVIEW-SLIM-2 同族零状态批，自 chatView.ts 外置）
 *
 * 域职责：把单轮投影（`RoundView`）的「前序 assistant 段」与「交互输入行」合成一条按时间
 * 升序的时间线，供重放顺序落到消息流——还原打断点 / 提问点的真实时序。
 *
 * **边界**：纯函数，不触达 DOM、不读写 chatView 状态。需要 `document` 或外部状态的一律
 * 不属于这里（→ `scripts/chatView` 或 `scripts/processFlowCells`）。
 *
 * 纯搬迁，零行为变化（函数体与排序判据自 `chatView.renderReplayRound` 原样迁出）。
 *
 * @module replayTimeline
 */
import type { RoundView } from '../../shared/protocol.js';

/** 时间线条目：一段正文（seg）或一条闭环内交互记录（问答行的四种 kind） */
export interface ReplayTimelineItem {
  kind: 'seg' | 'question-answer' | 'supplement' | 'timeout' | 'unanswered';
  content: string;
  ts?: string;
  question?: string;
  options?: string[];
  id?: string;
}

/**
 * 单轮投影 → 按时间升序的时间线条目
 *
 * 排序键 = 条目自身 timestamp（缺失按空串，稳定落在最前）；**不按类型分桶**——「先正文后
 * 问答」的人为分桶会打乱打断点 / 提问点的真实先后。
 *
 * @param r 单轮投影（重放真源）
 * @returns 时间线条目（未过滤空 content，调用方按需跳过）
 */
export function buildReplayTimeline(r: RoundView): ReplayTimelineItem[] {
  return [
    ...(r.assistantLog ?? []).map((m) => ({
      kind: 'seg' as const,
      content: m.content,
      ts: m.timestamp,
    })),
    ...(r.interactiveInputs ?? []).map((i) => ({
      kind: i.kind,
      content: i.content,
      ts: i.timestamp,
      question: i.question,
      options: i.options,
      id: i.id,
    })),
  ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
}
