/**
 * turn 投影层纯函数 —— 运行时 / 重放共用同一形状
 *
 * 设计源：docs/方案-turn运行时与会话渲染SSOT收口-20260923.md（M3a）
 *
 * 职责边界（只做投影，不做编排）：
 *   - `toRoundView`：把运行时累积的「当前轮」投影为 `RoundView`（与落盘 Round 同形状）。
 *   - `deriveTurnState`：把宿主侧散落的状态信号（`_streaming` / paused / pausePending /
 *     pendingQuestions / 最近轮）**折叠为单一 `TurnState` 枚举**——这是「五条状态消息」的收口点。
 * 本文件不含任何 postMessage / DOM / 内核调用，纯函数便于单测与变异验证。
 */

import { isRoundSettled, type RoundStatus } from '@zooique/memora';
import type { PendingQuestionDto, RoundView, TurnState } from './protocol.js';

/**
 * 运行时「当前轮」累积态（宿主侧持有；对应内核一轮问答闭环的生长中状态）
 *
 * 与落盘 `Round` 的差别只有 `streamingText`（流式正文尚未落盘为 assistantMessage）。
 */
export interface LiveRoundState {
  /** 本轮 roundId（内核 chunk 携带，与落盘 Round.id 同源） */
  roundId: string;
  /** 本轮用户输入（宿主在发送时即已知，无需等内核回传） */
  userMessage: RoundView['userMessage'];
  /** 问答闭环内交互输入（补充 / 提问回答，按时间序追加） */
  interactiveInputs?: RoundView['interactiveInputs'];
  /** 过程事件（流式期间逐步累积，与落盘 processEvents 同形） */
  processEvents?: RoundView['processEvents'];
  /** 流式正文（尚未落盘；收场后由内核写入 assistantMessage） */
  streamingText?: string;
}

/**
 * 运行时当前轮 → `RoundView`（`live: true`）
 *
 * 流式正文作为末段 `assistantMessage` 投影，使运行时与重放**共用同一个渲染入参形状**；
 * 收场后落盘版本（`live` 缺省）自然替换它。
 */
export function toRoundView(live: LiveRoundState, status: RoundStatus = 'pending'): RoundView {
  const hasText = (live.streamingText ?? '').length > 0;
  return {
    id: live.roundId,
    userMessage: live.userMessage,
    interactiveInputs: live.interactiveInputs,
    assistantLog: undefined,
    status,
    createdAt: live.userMessage.timestamp,
    completedAt: undefined,
    processEvents: live.processEvents,
    assistantMessage: hasText
      ? { id: `live-${live.roundId}`, role: 'assistant', content: live.streamingText!, timestamp: live.userMessage.timestamp }
      : undefined,
    live: true,
  };
}

/** 状态折叠入参（宿主侧现有信号的**只读快照**，不含任何判据） */
export interface TurnStateInput {
  /** 是否有流在运行（宿主 `_streaming`） */
  streaming: boolean;
  /** 会话状态机是否已真正挂起（内核 `sessionManager.status === 'paused'`） */
  paused: boolean;
  /** 暂停申请在途（step 边界未到，尚未真正挂起） */
  pausePending?: boolean;
  /** 在途提问（ask_user 待答；非空即 ask 挂起） */
  pendingQuestions?: readonly PendingQuestionDto[];
  /** 运行时当前轮（running 态需要 roundId） */
  liveRoundId?: string;
  /** 最近一轮（settled 态需要 roundId + status） */
  lastRound?: { id: string; status: RoundStatus };
}

/**
 * 折叠为单一 `TurnState`（替代 status / paused / pause_pending / need_clarify 五条信号）
 *
 * 判定顺序（**刻意的**，改动前先看单测）：
 *  ① ask 挂起 → ② 已挂起 pause → ③ 暂停申请在途（「站台等车」= 用户心智上的已暂停）
 *  → ④ 运行中 → ⑤ 已收场 → ⑥ 空闲
 *
 * 收场判据**直接引用内核 `isRoundSettled`**（唯一真理源），本文件不复制判据——
 * 复制一份 `status === 'complete' || status === 'interrupted'` 就是第二套判据。
 */
export function deriveTurnState(input: TurnStateInput): TurnState {
  const questions = input.pendingQuestions ?? [];
  if (input.paused && questions.length > 0) {
    return { phase: 'waiting', reason: 'ask', questions: [...questions] };
  }
  if (input.paused) {
    return { phase: 'waiting', reason: 'pause' };
  }
  if (input.pausePending) {
    return { phase: 'waiting', reason: 'pause', pausePending: true };
  }
  if (input.streaming && input.liveRoundId) {
    return { phase: 'running', roundId: input.liveRoundId };
  }
  if (input.lastRound && isRoundSettled(input.lastRound.status)) {
    return { phase: 'settled', roundId: input.lastRound.id, status: input.lastRound.status };
  }
  return { phase: 'idle' };
}
