/**
 * ask 挂起批次的预告行收口与任务项归位（chatView 运行时渲染）
 *
 * 真机症状（任务表 × 工具模块）：第二个任务项推进时 LLM 调 ask_user 触发询问，
 * 运行时屏幕上有「询问用户（准备中）」的空折叠块（点开无内容）且同批工具调用散在
 * 任务项折叠块外；收尾全量重建后一切归位，但「询问用户」折叠块消失、只剩问答记录。
 *
 * 事实链（内核 `src/agent/loop.ts`）：ask_user 检出 → handleAskUser 整批挂起——
 * **本批任何工具都不发 tool_start/tool_result**（同批非 ask 调用补 [ASK_SUSPENDED]
 * 占位，不 yield chunk）。而「（准备中）」预告行（tool_pending，瞬态展示轨）只被
 * tool_start 升级或整树重建消费 ⇒ 挂起批次的预告行永远无人收口，运行时残留幽灵块，
 * 收尾重建天然消失——运行时与收尾不一致即由此而来。
 *
 * 本文件断言**期望行为**：提问挂起定型（提问 UI 渲染）即收口未升级预告行；
 * 任务项归位对真工具行成立；收尾后运行时不再多出幽灵工具块。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 分发一条运行时过程事件（process_event 单形态投影通道） */
function dispatchEv(event: Record<string, unknown>): void {
  dispatch({ type: 'process_event', event });
}

/** 起一轮：meta 建骨架 */
function startRound(): void {
  dispatchEv({
    type: 'meta',
    seq: 1,
    ts: '2026-09-28T11:00:01.000Z',
    payload: { role: 'AI', llm: 'm' },
  });
}

/** 任务项折叠边界（plan_item_boundary：以下内容归属该任务项） */
function planBoundary(seq: number, planItemId: string, title: string): Record<string, unknown> {
  return {
    type: 'plan_item_boundary',
    seq,
    ts: `2026-09-28T11:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { planItemId, title },
  };
}

/** 工具开始（toolCallId = 行配对键） */
function toolStart(seq: number, toolCallId: string, name: string): Record<string, unknown> {
  return {
    type: 'tool_start',
    seq,
    ts: `2026-09-28T11:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { toolCallId, name, args: '{"q":"1"}', stepIndex: 1 },
  };
}

/** 工具结果 */
function toolResult(seq: number, toolCallId: string, name: string): Record<string, unknown> {
  return {
    type: 'tool_result',
    seq,
    ts: `2026-09-28T11:00:${String(seq).padStart(2, '0')}.000Z`,
    payload: { toolCallId, name, ok: true, summary: 'done' },
  };
}

/** 工具意图预告（瞬态轨：不落 events、只等 tool_start 升级） */
function toolPending(toolCallId: string, name: string): Record<string, unknown> {
  return { type: 'tool_pending', toolCallId, name };
}

/** 提问等待态（ask 挂起定型的唯一消息面：turn_update state） */
function askWaiting(question: string): Record<string, unknown> {
  return {
    type: 'turn_update',
    rounds: [],
    state: {
      phase: 'waiting',
      reason: 'ask',
      questions: [{ slot: 'task', question, options: ['是', '否'] }],
    },
  };
}

/** 用户回答（QA 交互记录，进当前任务项组） */
function userAnswer(text: string, ts: string): Record<string, unknown> {
  return { type: 'user', text, ts, kind: 'question-answer', question: '确认执行？' };
}

/** 取未升级的「（准备中）」预告行 */
function pendingRows(): NodeListOf<Element> {
  return document.querySelectorAll('.round-block__tool.is-tool-pending');
}

/** 取工具行（含预告行） */
function toolRow(toolCallId: string): Element | null {
  return document.querySelector(`.round-block__tool[data-tool-call-id="${toolCallId}"]`);
}

describe('chatView ask 挂起批次：预告行收口 + 任务项归位', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 完整真机序列：任务项2 边界 → 真工具（更新任务表）→ ask 批次预告 → 提问 → 问答 → 续跑 → 后续真工具 */
  function replayRealSequence(): void {
    mountChatView();
    startRound();
    dispatchEv(planBoundary(2, 'item-2', '执行第二步'));
    // 真工具（已执行批次）：tool_start + tool_result 齐全
    dispatchEv(toolStart(3, 'call_t', 'task_table_update'));
    dispatchEv(toolResult(4, 'call_t', 'task_table_update'));
    // ask 批次：LLM 流式出 tool_call → 预告行（顶层瞬态消息，非 process_event）；
    // 内核检出 ask 后整批挂起，tool_start 永不到达
    dispatch(toolPending('call_ask', 'ask_user'));
    dispatch(toolPending('call_x', 'read_file'));
    // 提问挂起定型（ask UI 渲染）
    dispatch(askWaiting('确认执行？'));
    // 用户作答 → 续跑 meta（宿主每个 runFlow 重发 meta）
    dispatch(userAnswer('是', '2026-09-28T11:01:00.000Z'));
    dispatchEv({
      type: 'meta',
      seq: 9,
      ts: '2026-09-28T11:01:01.000Z',
      payload: { role: 'AI', llm: 'm' },
    });
    // 续跑后的真工具（模型重新发起，tool_start/tool_result 齐全）
    dispatchEv(toolStart(10, 'call_y', 'read_file'));
    dispatchEv(toolResult(11, 'call_y', 'read_file'));
  }

  it('收口只作用于未升级预告行：ask 渲染时刻已升级工具行保持同一节点', () => {
    mountChatView();
    startRound();
    dispatchEv(planBoundary(2, 'item-2', '执行第二步'));
    dispatchEv(toolStart(3, 'call_t', 'task_table_update'));
    dispatchEv(toolResult(4, 'call_t', 'task_table_update'));
    dispatch(toolPending('call_ask', 'ask_user'));
    const before = toolRow('call_t');
    expect(before).not.toBeNull();
    // ask 渲染只触发收口、不触发 renderProcessFlow —— 该窗口内节点身份即误删的显影剂
    // （误删已升级行会被后续重渲染自愈重建，只有此刻断言抓得到）
    dispatch(askWaiting('确认执行？'));
    expect(toolRow('call_t')).toBe(before);
  });

  it('反向守卫：收口只清存量预告行，续跑后新到的预告行照常渲染', () => {
    replayRealSequence();
    // 作答续跑后的下一次 LLM 调用仍在流式出参数 → 新预告行必须可见（不得被收口误伤）
    dispatch(toolPending('call_z', 'write_file'));
    const row = toolRow('call_z');
    expect(row).not.toBeNull();
    expect(row!.classList.contains('is-tool-pending')).toBe(true);
  });

  it('提问挂起定型后，挂起批次的「（准备中）」预告行全部收口（运行时不留幽灵折叠块）', () => {
    replayRealSequence();
    // 挂起批次永不发 tool_start ⇒ 预告行不会升级——提问 UI 渲染即为收口信号
    expect(pendingRows()).toHaveLength(0);
    // ask 本身也不残留工具折叠块（其记录 = 提问/你答交互行，与收尾重建一致）
    expect(toolRow('call_ask')).toBeNull();
  });

  it('同批被 [ASK_SUSPENDED] 占位的非 ask 工具同样不留预告行', () => {
    replayRealSequence();
    expect(toolRow('call_x')).toBeNull();
  });

  it('续跑后的真工具行归位在任务项折叠块内（与收尾一致）', () => {
    replayRealSequence();
    const row = toolRow('call_y');
    expect(row).not.toBeNull();
    expect(row!.closest('.round-block__plan-item')).not.toBeNull();
  });

  it('基准：挂起前的真工具行在任务项折叠块内', () => {
    replayRealSequence();
    const row = toolRow('call_t');
    expect(row).not.toBeNull();
    expect(row!.closest('.round-block__plan-item')).not.toBeNull();
  });

  it('收尾（done）后：任务项归位保持，且运行时不再多出任何预告行', () => {
    replayRealSequence();
    dispatch({ type: 'done', roundId: 'r1', ts: '2026-09-28T11:02:00.000Z', status: 'ok' });
    expect(pendingRows()).toHaveLength(0);
    expect(toolRow('call_y')?.closest('.round-block__plan-item')).not.toBeNull();
    expect(toolRow('call_t')?.closest('.round-block__plan-item')).not.toBeNull();
  });
});
