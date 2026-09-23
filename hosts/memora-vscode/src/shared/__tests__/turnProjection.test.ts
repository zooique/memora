import { describe, it, expect } from 'vitest';
import { toRoundView, deriveTurnState, mergeLiveRound, type LiveRoundState } from '../turnProjection.js';
import type { RoundView } from '../protocol.js';

/**
 * turn 投影层单测（M3a，2026-09-23）
 *
 * **变异验证锚点**：本测试存在的意义是让「状态折叠判据」不可被悄悄改坏——
 *  - 删掉 `deriveTurnState` 的 ask 分支 → 「ask 挂起」用例转红（退化成 pause）
 *  - 删掉 pausePending 分支 → 「申请在途」用例转红（退化成 running，用户点暂停无反馈）
 *  - 把 settled 判据改成 `status === 'complete'` → 「中断轮收场」用例转红（违反 SSOT）
 */

const userMsg = { id: 'msg-1', role: 'user' as const, content: '你好', timestamp: '2026-09-23T00:00:00.000Z' };

const live: LiveRoundState = {
  roundId: 'round-1',
  userMessage: userMsg,
  processEvents: [],
};

describe('toRoundView', () => {
  it('运行时当前轮投影为 RoundView，live=true 标记未收场', () => {
    const view = toRoundView(live);
    expect(view.live).toBe(true);
    expect(view.id).toBe('round-1');
    expect(view.userMessage.content).toBe('你好');
    expect(view.status).toBe('pending');
  });

  it('流式正文投影为末段 assistantMessage（运行时与重放同形状）', () => {
    const view = toRoundView({ ...live, streamingText: '正在回答' });
    expect(view.assistantMessage?.content).toBe('正在回答');
    expect(view.assistantMessage?.role).toBe('assistant');
  });

  it('无正文时 assistantMessage 缺省（不伪造空消息块）', () => {
    const view = toRoundView(live);
    expect(view.assistantMessage).toBeUndefined();
  });

  it('交互输入与过程事件原样透传（不做第二套形状）', () => {
    const view = toRoundView({
      ...live,
      interactiveInputs: [{ id: 'i-1', role: 'user', content: '补充一点', timestamp: 'ts', kind: 'supplement' }],
      processEvents: [{ type: 'tool_start', seq: 1, ts: 'ts', payload: { toolCallId: 't-1', name: 'read_file' } }],
    });
    expect(view.interactiveInputs).toHaveLength(1);
    expect(view.processEvents).toHaveLength(1);
  });
});

describe('deriveTurnState', () => {
  it('无信号 → idle', () => {
    expect(deriveTurnState({ streaming: false, paused: false })).toEqual({ phase: 'idle' });
  });

  it('流运行中 + 有 roundId → running', () => {
    expect(deriveTurnState({ streaming: true, paused: false, liveRoundId: 'round-9' })).toEqual({
      phase: 'running',
      roundId: 'round-9',
    });
  });

  it('流运行中 + roundId 未知（流起始投影，首个 chunk 未到）→ running（roundId 缺省如实）', () => {
    // 2b-2b 换源：宿主在 consumeFlow 起始（无 live）即要立起 running 骨架，
    // 此刻 chunk 未到无 roundId——判据从「streaming && liveRoundId」放宽为「streaming」，
    // 不造假占位（roundId 可选字段），防换源后起始 turn_update 误投 settled/idle 把按钮打成「发送」。
    expect(deriveTurnState({ streaming: true, paused: false })).toEqual({ phase: 'running' });
  });

  it('ask 挂起优先于 pause（同为 paused，有提问即 ask）', () => {
    expect(
      deriveTurnState({ streaming: false, paused: true, pendingQuestions: [{ slot: 's', question: '选哪个？' }] }),
    ).toEqual({ phase: 'waiting', reason: 'ask', questions: [{ slot: 's', question: '选哪个？' }] });
  });

  it('ask 提问在途但尚未 paused → 仍是 waiting(ask)（M5b-2 缺口修复：不依赖 paused）', () => {
    // ask_user 是「emit questionPending → 随后 yield paused chunk」，提问那一刻 sessionStatus≈running。
    // 判据从「paused && questions>0」放宽为「questions 非空即 ask」→ 补推的 turn_update 即时派生 waiting(ask)，
    // 提问卡渲染不延迟一个 chunk 边界。变异锚点：「questions 非空即 ask」若被改回依赖 paused，本例转红。
    expect(
      deriveTurnState({
        streaming: true,
        paused: false,
        liveRoundId: 'round-9',
        pendingQuestions: [{ slot: 's', question: '仍在流中就提问？' }],
      }),
    ).toEqual({ phase: 'waiting', reason: 'ask', questions: [{ slot: 's', question: '仍在流中就提问？' }] });
  });

  it('已挂起且无提问 → waiting(pause)', () => {
    expect(deriveTurnState({ streaming: false, paused: true })).toEqual({ phase: 'waiting', reason: 'pause' });
  });

  it('暂停申请在途（未到 step 边界）→ waiting(pause) + pausePending（站台等车）', () => {
    expect(deriveTurnState({ streaming: true, paused: false, pausePending: true, liveRoundId: 'round-9' })).toEqual({
      phase: 'waiting',
      reason: 'pause',
      pausePending: true,
    });
  });

  it('已完成轮 → settled（round 级 status 原样透出）', () => {
    expect(deriveTurnState({ streaming: false, paused: false, lastRound: { id: 'round-1', status: 'complete' } })).toEqual(
      { phase: 'settled', roundId: 'round-1', status: 'complete' },
    );
  });

  it('中断轮也算 settled（禁自写 status === complete，判据同 isRoundSettled）', () => {
    expect(
      deriveTurnState({ streaming: false, paused: false, lastRound: { id: 'round-2', status: 'interrupted' } }),
    ).toEqual({ phase: 'settled', roundId: 'round-2', status: 'interrupted' });
  });

  it('未收场轮（pending）不算 settled → idle（无流无挂起）', () => {
    expect(deriveTurnState({ streaming: false, paused: false, lastRound: { id: 'round-3', status: 'pending' } })).toEqual(
      { phase: 'idle' },
    );
  });
});

/**
 * mergeLiveRound（M3b-2a，2026-09-23）：运行时当前轮并入落盘历史
 *
 * **变异验证锚点**（每条用例都对应一条可被改坏的判据）：
 *  - 删 `if (!userMessage) return history` → 「两边都拿不到」转红（会投出缺开轮输入的轮）
 *  - 「原位替换」改成 `filter + append` → 「原位替换」转红（同 id 轮被挪到末尾、轮序漂移）
 *  - `live.userMessage ?? existing?.userMessage` 顺序反向 → 「seed 优先」转红
 *  - 去掉 `toRoundView({ ...live, userMessage })` 里的 userMessage 覆盖 → 「resume 场景」转红
 */
describe('mergeLiveRound', () => {
  const otherUser = {
    id: 'msg-2',
    role: 'user' as const,
    content: '第二个问题',
    timestamp: '2026-09-23T01:00:00.000Z',
  };
  /** RoundView 必填四件套：id / userMessage / status / createdAt（refCount 未被 Pick） */
  const historyRound = (id: string, over: Partial<RoundView> = {}): RoundView => ({
    id,
    userMessage: userMsg,
    status: 'complete',
    createdAt: '2026-09-23T00:00:00.000Z',
    ...over,
  });

  it('无 live 轮 → 原样返回历史（零开销路径，连数组都不重建）', () => {
    const history = [historyRound('round-1')];
    expect(mergeLiveRound(history)).toBe(history);
  });

  it('历史无该轮 → 追加末尾（chat 开的新轮尚未落盘）', () => {
    const history = [historyRound('round-1')];
    const merged = mergeLiveRound(history, { roundId: 'round-2', userMessage: otherUser });
    expect(merged.map((r) => r.id)).toEqual(['round-1', 'round-2']);
    expect(merged[1]!.live).toBe(true);
    expect(merged[1]!.status).toBe('pending');
  });

  it('历史已有该轮 → 原位替换而非追加（防重复条目 + 轮序不漂移）', () => {
    const history = [historyRound('round-1'), historyRound('round-2'), historyRound('round-3')];
    const merged = mergeLiveRound(history, {
      roundId: 'round-2',
      userMessage: otherUser,
      streamingText: '半截正文',
    });
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.id)).toEqual(['round-1', 'round-2', 'round-3']);
    expect(merged[1]!.live).toBe(true);
    expect(merged[1]!.assistantMessage?.content).toBe('半截正文');
  });

  it('resume 场景：live 无 userMessage → 取历史同 id 轮的（续同一轮不分裂）', () => {
    const history = [historyRound('round-1', { status: 'pending', userMessage: otherUser })];
    const merged = mergeLiveRound(history, { roundId: 'round-1', streamingText: '续跑中' });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.userMessage.content).toBe('第二个问题');
    expect(merged[0]!.status).toBe('pending');
    expect(merged[0]!.live).toBe(true);
  });

  it('两边都拿不到 userMessage → 整轮不并入（半残数据不投）', () => {
    const history = [historyRound('round-1')];
    const merged = mergeLiveRound(history, { roundId: 'round-404', streamingText: '无人认领' });
    expect(merged).toBe(history);
  });

  it('有 seed 时优先用 seed（不沿用历史里可能过期的 userMessage）', () => {
    const history = [historyRound('round-1', { userMessage: otherUser })];
    const merged = mergeLiveRound(history, { roundId: 'round-1', userMessage: userMsg });
    expect(merged[0]!.userMessage.id).toBe('msg-1');
  });

  it('历史轮状态原样保留（合并是投影，不改写轮状态）', () => {
    const history = [historyRound('round-1', { status: 'interrupted' })];
    const merged = mergeLiveRound(history, { roundId: 'round-1', userMessage: userMsg });
    expect(merged[0]!.status).toBe('interrupted');
  });

  it('过程事件按 live 传入透传（与重放同形状，不做第二套）', () => {
    const merged = mergeLiveRound([], {
      roundId: 'round-9',
      userMessage: userMsg,
      processEvents: [{ type: 'tool_start', seq: 1, ts: 'ts', payload: { toolCallId: 't-1', name: 'read_file' } }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.processEvents).toHaveLength(1);
  });
});
