/**
 * 运行时 × 重放对拍测试（M3b-2b-3：消费 rounds + 对拍入库）
 *
 * 同一真实 fixture（round-1789565571934）走两条渲染路，断言 DOM 轮级语义等价：
 *   - 运行时流式路：`{type:'user'} + buildRealRoundTimeline({withStreaming, withDone})`
 *     （process_event / chunk / plan_update / done 消息流，模拟实时生成）
 *   - 重放消息路：`buildReplayTimeline(buildRoundView())`
 *     （由 rounds 形状 RoundView 派生的 user / replay_events / assistant 序列，模拟会话回放）
 *
 * §1 数据层证据：rounds（RoundView）形状能完整还原重放路渲染输入——
 *     buildReplayTimeline 是宿主 sendRoundView 语义的纯函数抽象（方案 2b-3 定义）。
 * §2 DOM 对拍：两路渲染后提取「轮级语义描述」（用户气泡 / AI 正文 / 工具行数 / 折叠块），
 *    断言等价——这是 M5 删旧前「重放由 rounds 驱动」可安全替换流式重建的地基。
 * §3 红线守护：非 complete 轮（isRoundSettled 分界）不派生 assistant 正文，
 *    对拍映射不进 `status` 语义漂移。
 *
 * plan 常驻条为**合理差异**（重放路不还原任务表看板，既有宿主行为），排除在对拍断言外。
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { RoundView } from '../../shared/protocol.js';
import {
  REAL_ROUND,
  ASSISTANT_REPLY_TEXT,
  expandEvents,
  buildRoundView,
  buildReplayTimeline,
  buildRealRoundTimeline,
  type TimelineMsg,
} from './fixtures/realRound-1789565571934.js';
import {
  mountChatView,
  dispatch,
  collectAllBodyText,
} from './helpers/chatViewTestEnv.js';

// 单用例真实事件量 ~1356 条，DOM 拼接耗时（与 chatView.test.ts R2/R3/R4 同量级）
const PARITY_TIMEOUT_MS = 30_000;

/**
 * 轮级语义描述：两路渲染后提取「可对拍的 DOM 语义」，与具体 DOM 形状解耦。
 *
 * 只抽取真正代表「这一轮渲染结果」的语义信号：
 *   userText        用户气泡全文（.msg.user .msg-body）
 *   assistantText   AI 正文全文（collectAllBodyText：去除段落换行的正文拼接）
 *   toolRowCount    工具行数（.round-block__tool[data-tool-call-id] 去重行）
 *                   —— 两路事件同源（expandEvents），工具行数必须一致
 *   hasRoundBlock   过程折叠块是否建立（任务过程收起的结构信号）
 */
interface RoundSemantics {
  userText: string;
  assistantText: string;
  toolRowCount: number;
  hasRoundBlock: boolean;
}

/** 从当前 webview DOM 提取轮级语义描述（每路用例挂载后调用一次） */
function extractRoundSemantics(): RoundSemantics {
  const user = document.querySelector('.msg.user .msg-body');
  const assistant = document.querySelector('.msg.assistant');
  const toolRows = document.querySelectorAll<HTMLElement>('.round-block__tool[data-tool-call-id]');
  return {
    userText: user?.textContent ?? '',
    assistantText: assistant ? collectAllBodyText(assistant) : '',
    toolRowCount: toolRows.length,
    hasRoundBlock: document.querySelector('.round-block') !== null,
  };
}

/** 按序分发一条时间线（多条消息逐一 dispatch，保持流式顺序） */
function dispatchAll(msgs: TimelineMsg[]): void {
  for (const msg of msgs) dispatch(msg);
}

describe('运行时 × 重放对拍（round-1789565571934 同一 fixture 两路渲染）', () => {
  it('§1 数据层证据：rounds 形状可完整还原重放路渲染输入（RoundView → user/replay_events/assistant）', () => {
    // buildReplayTimeline 是宿主 sendRoundView 语义的纯函数抽象：能由 RoundView 重建
    // 重放消息序列，即证明「消费 rounds」是自足的（宿主寄出 rounds 即可还原全部渲染输入）。
    const roundView = buildRoundView();
    const timeline = buildReplayTimeline(roundView);

    // 用户消息：携带 roundId（重放需要锚定轮归属）
    expect(timeline[0]).toMatchObject({
      type: 'user',
      text: REAL_ROUND.userText,
      roundId: REAL_ROUND.id,
      ts: REAL_ROUND.createdAt,
    });

    // 过程事件：processEvents 即展开后的真实事件序（seq 3..1358 严格连续，1356 条）
    const replayEv = timeline[1] as { type: 'replay_events'; roundId: string; events: unknown[] };
    expect(replayEv.type).toBe('replay_events');
    expect(replayEv.roundId).toBe(REAL_ROUND.id);
    expect(replayEv.events).toEqual(expandEvents());
    expect(replayEv.events).toHaveLength(REAL_ROUND.lastSeq - REAL_ROUND.firstSeq + 1);

    // assistant 最终回答：仅 complete 轮挂正文（与 isRoundSettled 分界同语义）
    expect(timeline[2]).toMatchObject({
      type: 'assistant',
      text: ASSISTANT_REPLY_TEXT,
      roundId: REAL_ROUND.id,
      ts: REAL_ROUND.completedAt,
    });
    expect(timeline).toHaveLength(3);
  });

  it('§2 对拍：运行时流式路与重放路渲染出等价轮级语义（DOM 两路 deepEqual）', { timeout: PARITY_TIMEOUT_MS }, () => {
    // ── 路 A：运行时流式（真实生成）──
    // 用户气泡在真实运行时由 webview 本地渲染（send 提交后 append），故补发 user 消息对齐重放路。
    mountChatView();
    dispatchAll([
      { type: 'user', text: REAL_ROUND.userText, ts: REAL_ROUND.createdAt },
      ...buildRealRoundTimeline({ withStreaming: true, withDone: true }),
    ]);
    const streamSemantics = extractRoundSemantics();
    const streamAssistant = document.querySelector('.msg.assistant');
    const streamBody = streamAssistant?.querySelector<HTMLElement>('.msg-body');
    // 收口后光标消失（done 已收尾，非在途）
    expect(streamBody?.classList.contains('is-streaming')).toBe(false);

    // ── 路 B：重放（由 rounds 形状派生）──
    mountChatView();
    dispatchAll(buildReplayTimeline());
    const replaySemantics = extractRoundSemantics();

    // 轮级语义等价：用户气泡、AI 正文、工具行数、折叠块结构两路一致
    expect(replaySemantics).toEqual(streamSemantics);
    // 内容性防空转：正文确实是该轮回答，不是空串/占位
    expect(replaySemantics.assistantText).toContain(ASSISTANT_REPLY_TEXT);
    expect(replaySemantics.userText).toBe(REAL_ROUND.userText);
    // 真实事件量守恒：7 对工具（task_table_write ×1 + task_table_update ×4 + search_memories ×1 + list_dir ×1）
    expect(replaySemantics.toolRowCount).toBe(7);
  });

  it('§3 红线守护：非 complete 轮不派生 assistant 正文（重放映射不破坏 isRoundSettled 分界）', () => {
    // 中断/在途轮（status ≠ complete）：rounds 形状里无末段回答可派生，
    // buildReplayTimeline 必须不发 assistant 消息——重放路保持「无正文」而非伪造答复。
    const pendingView: RoundView = { ...buildRoundView(), status: 'pending' as const, assistantMessage: undefined };
    const timeline = buildReplayTimeline(pendingView);
    expect(timeline.every((m) => m.type !== 'assistant')).toBe(true);
    expect(timeline.map((m) => m.type)).toEqual(['user', 'replay_events']);
  });
});