/**
 * 运行时 × 重放对拍测试（M3b-2b-3：消费 rounds + 对拍入库；M5b-3 重放真源切 turn_update.rounds）
 *
 * 同一真实 fixture（round-1789565571934）走两条渲染路，断言 DOM 轮级语义等价：
 *   - 运行时流式路：`{type:'user'} + buildRealRoundTimeline({withStreaming, withDone})`
 *     （process_event / chunk / plan_update / done 消息流，模拟实时生成）
 *   - 重放回合快照路：`buildReplayTurnUpdate(buildRoundView())`
 *     （单条 turn_update，replay:true + rounds 承载——M5b-3 后重放真源，替代旧 user / replay_events /
 *       assistant 消息风暴；webview 端 renderReplayFromRounds 整批重建）
 *
 * §1 数据层证据：rounds（RoundView）形状即重放渲染输入，replayTurnUpdate 只加协议壳（replay 标记）——
 *     宿主 postTurnUpdate(undefined, true) 投递的就是这份 rounds（方案 M5b-3 定义）。
 * §2 轮级语义对拍（4 字段）：两路渲染后提取「轮级语义描述」（用户气泡 / AI 正文 / 工具行数 / 折叠块），
 *     断言等价——这是 M5b-3 删旧后「重放由 rounds 驱动」可安全替换流式重建的地基。
 * §3 红线守护：非 complete 轮（status=pending）不派生 assistant 正文。
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
  buildReplayTurnUpdate,
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

/**
 * 交互输入行提取（§4 live×replay 同形对拍）：从 DOM 抽「你补充 / 你答 / 未回答」行描述。
 *
 * 两路（运行时 appendInteractiveInput / 重放 renderReplayRound）共用 renderQaItem，行结构：
 * `.round-block__input` > `.round-block__input-row`(.round-block__input-tag + .round-block__input-text)。
 * 只抽主行（tag + content），忽略 question-answer/timeout 的嵌套「问」回顾行（其 tag 为「问」，
 * 与主行 tag「你答」不同类，避免误抽）。
 */
interface InteractiveRow {
  tag: string;
  content: string;
}
function extractInteractiveRows(root: ParentNode = document): InteractiveRow[] {
  return Array.from(root.querySelectorAll('.round-block__input')).map((row) => {
    const main = row.querySelector('.round-block__input-row');
    const tag = main?.querySelector('.round-block__input-tag')?.textContent ?? '';
    const content = main?.querySelector('.round-block__input-text')?.textContent ?? '';
    return { tag, content };
  });
}

/** 按序分发一条时间线（多条消息逐一 dispatch，保持流式顺序） */
function dispatchAll(msgs: TimelineMsg[]): void {
  for (const msg of msgs) dispatch(msg);
}

describe('运行时 × 重放对拍（round-1789565571934 同一 fixture 两路渲染）', () => {
  it('§1 数据层证据：rounds 形状即重放渲染输入（turn_update.replay + rounds 承载，M5b-3 无消息风暴）', () => {
    // buildReplayTurnUpdate 是宿主 replayHistory→postTurnUpdate(undefined,true) 的纯函数抽象：
    // 重放 = 单条 turn_update（replay:true）承载全量 rounds——webview 端 renderReplayFromRounds
    // 据此整批重建，证明「消费 rounds」是自足的（无 user/replay_events/assistant 消息风暴依赖）。
    const roundView = buildRoundView();
    const tu = buildReplayTurnUpdate(roundView);

    // 协议壳：type + replay 标记 + rounds 与 state
    expect(tu.type).toBe('turn_update');
    expect((tu as unknown as { replay: unknown }).replay).toBe(true);
    expect((tu as unknown as { rounds: RoundView[] }).rounds).toEqual([roundView]);
    expect((tu as unknown as { state: unknown }).state).toMatchObject({
      phase: 'settled',
      roundId: REAL_ROUND.id,
      status: 'complete',
    });

    // rounds 形状反映真实轮：用户输入 + 过程事件（与流式路同源 expandEvents）+ 最终回答
    expect(roundView.id).toBe(REAL_ROUND.id);
    expect(roundView.userMessage?.content).toBe(REAL_ROUND.userText);
    expect(roundView.processEvents).toEqual(expandEvents());
    expect(roundView.assistantMessage?.content).toBe(ASSISTANT_REPLY_TEXT);
  });

  it('§2 对拍：运行时流式路与重放路渲染出等价轮级语义（4 字段轮级语义对拍）', { timeout: PARITY_TIMEOUT_MS }, () => {
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

    // ── 路 B：重放（单条 turn_update.rounds 整批重建）──
    mountChatView();
    dispatch(buildReplayTurnUpdate());
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
    // 中断/在途轮（status ≠ complete）：rounds 形状里无末段回答可派生，renderReplayFromRounds 必须
    // 不渲染 assistant 正文块——重放路保持「无正文」而非伪造答复。
    // ⚠️ 过程折叠区依赖 assistant 正文锚点（ensureRoundBlock 的 host=activeAssistantEl 为空即不建），
    //    故悬置轮同时无折叠区/工具行——与旧 replay_events 分支同语义（replay 折叠区附在助手块后，
    //    无正文块则不建），非 M5b-3 回归。
    const pendingView: RoundView = { ...buildRoundView(), status: 'pending' as const, assistantMessage: undefined };
    mountChatView();
    dispatch(buildReplayTurnUpdate(pendingView));

    const semantics = extractRoundSemantics();
    expect(document.querySelector('.msg.assistant')).toBeNull();
    expect(semantics.assistantText).toBe('');
    // 用户气泡仍渲染，仅剥夺正文
    expect(semantics.userText).toBe(REAL_ROUND.userText);
    // 无正文锚点 → round-block 与工具行一并缺席（既定形态，见上注释）
    expect(semantics.hasRoundBlock).toBe(false);
    expect(semantics.toolRowCount).toBe(0);
  });

  it('§4 交互输入行 live×replay 同形对拍：supplement/question-answer 两路渲染「你补充/你答」一致', { timeout: PARITY_TIMEOUT_MS }, () => {
    // 守「live 交互行 == replay 交互行」同形（§2 只守轮级 4 字段，本例守交互行）。
    // 两路共用 renderQaItem（运行时 appendInteractiveInput / 重放 renderReplayRound 均调它），
    // 本例锁定同一内容在两路产出同形行——若任一路改渲染函数即破。
    const SUPPLEMENT = '补充：成本标准改 <¥0.5';
    const ANSWER = '选方案 A';
    const QUESTION = '选哪个方案？';
    const TS_S = '2026-09-07T11:00:00.000Z';
    const TS_A = '2026-09-07T12:00:00.000Z';
    const expected = [
      { tag: '你补充', content: SUPPLEMENT },
      { tag: '你答', content: ANSWER },
    ];
    const sortRows = (rows: InteractiveRow[]) =>
      [...rows].sort((a, b) => a.tag.localeCompare(b.tag) || a.content.localeCompare(b.content));

    // ── 路 A：运行时流式（暂停态补充 + 提问回答，真实生成路）──
    mountChatView();
    const liveMessages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '正文', roundId: 'r1' });
    dispatch({ type: 'paused' });
    dispatch({ type: 'user', text: SUPPLEMENT, ts: TS_S, kind: 'supplement' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'paused' });
    dispatch({ type: 'user', text: ANSWER, ts: TS_A, kind: 'question-answer', roundId: 'r1', question: QUESTION, options: ['方案 A', '方案 B'] });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '收尾', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    const liveRows = extractInteractiveRows(liveMessages);

    // ── 路 B：重放（单条 turn_update.rounds 承载 interactiveInputs）──
    mountChatView();
    const replayMessages = document.getElementById('messages') as HTMLElement;
    const roundView: RoundView = {
      ...buildRoundView(),
      interactiveInputs: [
        { id: 'i-s', role: 'user', content: SUPPLEMENT, timestamp: TS_S, kind: 'supplement' },
        { id: 'i-a', role: 'user', content: ANSWER, timestamp: TS_A, kind: 'question-answer', question: QUESTION, options: ['方案 A', '方案 B'] },
      ],
    };
    dispatch(buildReplayTurnUpdate(roundView));
    const replayRows = extractInteractiveRows(replayMessages);

    // 两路各自渲染正确（防空转）+ 两路同形（live==replay 对称守卫）
    expect(sortRows(liveRows)).toEqual(sortRows(expected));
    expect(sortRows(replayRows)).toEqual(sortRows(expected));
    expect(sortRows(liveRows)).toEqual(sortRows(replayRows));
  });
});
