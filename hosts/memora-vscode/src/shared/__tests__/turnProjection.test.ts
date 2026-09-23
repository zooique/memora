import { describe, it, expect } from 'vitest';
import { toRoundView, deriveTurnState, type LiveRoundState } from '../turnProjection.js';

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

  it('ask 挂起优先于 pause（同为 paused，有提问即 ask）', () => {
    expect(
      deriveTurnState({ streaming: false, paused: true, pendingQuestions: [{ slot: 's', question: '选哪个？' }] }),
    ).toEqual({ phase: 'waiting', reason: 'ask', questions: [{ slot: 's', question: '选哪个？' }] });
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
