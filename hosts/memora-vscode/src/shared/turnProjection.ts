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
  if (input.streaming) {
    // 有流在跑即 running（不要求 liveRoundId 证据——流起始投影时首个 chunk 未到、
    // roundId 尚不可知，如实缺省而非造假占位；`TurnState.running.roundId` 因此可选）。
    // ⚠ 顺序依赖：paused / pausePending 判定在前，此处只兜「既非挂起也非申请在途」
    // 的纯运行态；三角色（ask / pause / 申请在途）不在此分支。
    return { phase: 'running', roundId: input.liveRoundId };
  }
  if (input.lastRound && isRoundSettled(input.lastRound.status)) {
    return { phase: 'settled', roundId: input.lastRound.id, status: input.lastRound.status };
  }
  return { phase: 'idle' };
}

/**
 * 运行时当前轮的「未定型」形态（M3b-2a）：`userMessage` 可能尚不可知。
 *
 * 为什么需要它：`resumeExecution` 各形态**不开新轮**（续同一轮、不分裂），宿主手上没有该轮的
 * 开轮输入——只有落盘历史里有。故合并前允许 `userMessage` 缺省，由 `mergeLiveRound` 补；
 * 而 `toRoundView` 仍要求定型的 `LiveRoundState`（必填 userMessage）——**类型上区分
 * 「可能缺」与「已确保有」，不用 `as` 断言把不确定性抹掉**。
 */
export type PendingLiveRound = Omit<LiveRoundState, 'userMessage'> & {
  userMessage?: RoundView['userMessage'];
};

/**
 * 把运行时当前轮并入落盘历史（M3b-2a，2026-09-23）
 *
 * 合并规则（按 `id` 定位，不另立判据）：
 *   - 历史中已有同 id 轮 → **原位替换**为 live 版本（live 更完整：含尚未落盘的流式正文与增量过程事件）。
 *     原位而非追加，保证轮序不因合并而漂移。
 *   - 历史中无该轮 → 追加到末尾（新轮尚未落盘，如 `chat()` 开的新轮）。
 *   - **拿不到 `userMessage`**（既无显式 seed，历史中也没有该轮）→ 整轮不并入。
 *     这是 M3b-1 定下的「半残数据比不投更危险」的延续：缺开轮输入的轮渲染不出用户气泡，
 *     且会让「运行时投影」与「重放投影」在字段层面对不上。宁可少一轮，不投坏一轮。
 *
 * @param history 落盘历史轮（持久化的渲染真相源）
 * @param live 运行时当前轮（缺省 = 无 live，原样返回 history，零开销）
 */
export function mergeLiveRound(history: RoundView[], live?: PendingLiveRound): RoundView[] {
  if (!live) return history;
  const idx = history.findIndex((r) => r.id === live.roundId);
  const existing = idx >= 0 ? history[idx] : undefined;
  const userMessage = live.userMessage ?? existing?.userMessage;
  if (!userMessage) return history;
  const view = toRoundView({ ...live, userMessage }, existing?.status ?? 'pending');
  if (idx < 0) return [...history, view];
  const next = [...history];
  next[idx] = view;
  return next;
}
