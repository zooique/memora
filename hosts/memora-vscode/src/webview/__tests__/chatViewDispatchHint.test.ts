/**
 * 派活承诺对账提示（DISPATCH-CLAIM-HINT-1）——重放 / 实时 / 形态门控 / 幂等
 *
 * 被测事实：
 *   - 正文声称「已派给某会话」但本轮无业务受理回执 ⇒ 助手形态出现一句证据缺口提示；
 *   - 有成功回执 / 回执业务失败两类分别「不提示 / 提示」；
 *   - self 工作会话不插（与会话卡同构）；
 *   - 重放与实时共用同一谓词；同一轮多次 turn_update 只留一条。
 *
 * 断言语义固定为「证据缺口」，不得升级成「未完成 / 失败」——文案源键见
 * `dispatchReceiptHint.applyDispatchClaimHint`。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 提示元素选择器（与 helper 常量同值；测试侧写死以锁契约） */
const HINT_SELECTOR = '.round-group__dispatch-hint';

/** 提示文案（l10n 未加载翻译时返回英文源键） */
const HINT_TEXT = 'No session dispatch receipt found for this turn';

/**
 * 构造单轮 RoundView（最小形状，够 renderReplayRound 与实时投影消费）
 *
 * @param over 覆盖项：id / 正文 / 过程事件 / 状态
 */
function makeRound(over: {
  id: string;
  content: string;
  processEvents?: unknown[];
  status?: RoundView['status'];
}): RoundView {
  return {
    id: over.id,
    userMessage: {
      id: `${over.id}-user`,
      role: 'user',
      content: '把《井》扩写到 1000 字',
      timestamp: '2026-11-21T06:00:00.000Z',
    },
    assistantMessage: {
      id: `${over.id}-reply`,
      role: 'assistant',
      content: over.content,
      timestamp: '2026-11-21T06:00:02.000Z',
    },
    ...(over.processEvents ? { processEvents: over.processEvents as ProcessEvent[] } : {}),
    status: over.status ?? 'complete',
    createdAt: '2026-11-21T06:00:00.000Z',
    completedAt: '2026-11-21T06:00:02.000Z',
  };
}

/**
 * 分发一条重放快照（单轮 turn_update · replay:true）
 *
 * @param view 单轮视图
 */
function dispatchReplay(view: RoundView): void {
  dispatch({
    type: 'turn_update',
    rounds: [view],
    state: { phase: 'settled', roundId: view.id, status: view.status },
    replay: true,
  });
}

/** 成功的 send_to_session 回执事件（业务 ok=true 的真实摘要形态） */
function acceptedSendEvents(): unknown[] {
  return [
    {
      type: 'tool_start',
      seq: 0,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'c1',
        name: 'send_to_session',
        args: JSON.stringify({ sid: '2026-11-21-worker', text: '扩写到 1000 字' }),
      },
    },
    {
      type: 'tool_result',
      seq: 1,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'c1',
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "accepted": true\n}',
      },
    },
  ];
}

/** 业务失败的 send_to_session 回执事件（内核 ok=true + 摘要 ok=false） */
function rejectedSendEvents(): unknown[] {
  return [
    {
      type: 'tool_start',
      seq: 0,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'c2',
        name: 'send_to_session',
        args: JSON.stringify({ sid: '2026-11-21-worker', text: '扩写到 1000 字' }),
      },
    },
    {
      type: 'tool_result',
      seq: 1,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'c2',
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": false,\n  "code": "E_BUSY",\n  "message": "目标会话在跑"\n}',
      },
    },
  ];
}

describe('派活承诺对账提示（DISPATCH-CLAIM-HINT-1）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('重放 · 助手形态：正文声称已派 + 零回执 ⇒ 挂一条证据缺口提示', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'claim-only',
        // 复刻事故轮第一句（ab4125bc）
        content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
      }),
    );
    const group = document.querySelector<HTMLElement>('.round-group[data-round-id="claim-only"]');
    const hint = group?.querySelector<HTMLElement>(HINT_SELECTOR);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(HINT_TEXT);
    // 位置契约：容器直接子元素，且在 footer 之前（不随底栏 hover 隐藏）
    expect(hint!.parentElement).toBe(group);
    expect(group!.lastElementChild?.classList.contains('round-group__footer')).toBe(true);
  });

  it('重放 · 助手形态：正文声称已派 + 业务受理成功回执 ⇒ 不提示', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'claim-with-receipt',
        content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
        processEvents: acceptedSendEvents(),
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · 助手形态：内核 ok=true 但业务 ok=false（E_BUSY）⇒ 仍提示', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'claim-rejected',
        content: '扩写任务已派给小说会话。',
        processEvents: rejectedSendEvents(),
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).not.toBeNull();
  });

  it('重放 · 助手形态：正文没有派发措辞 ⇒ 不提示（词表是触发器，不是完成判据）', () => {
    mountChatView('assistant');
    dispatchReplay(makeRound({ id: 'no-claim', content: '已把三个版本的差异列在下面。' }));
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · self 形态：同一轮不插提示（与盖章会话卡同构）', () => {
    mountChatView('self');
    dispatchReplay(makeRound({ id: 'self-claim', content: '扩写任务已派给小说会话。' }));
    // 轮容器照常渲染，只是提示元素不插
    expect(document.querySelector('.round-group[data-round-id="self-claim"]')).not.toBeNull();
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('实时 · 助手形态：done 后 turn_update 落提示，重复 turn_update 只留一条', () => {
    mountChatView('assistant');
    const roundId = 'live-claim';
    // 走真实 live 序列：user → 骨架 → chunk → done（建容器）；宿主随后才发 turn_update
    dispatch({ type: 'user', text: '把《井》扩写到 1000 字', ts: '2026-11-21T06:00:00.000Z' });
    dispatch({
      type: 'process_event',
      event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
    });
    dispatch({
      type: 'chunk',
      content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
      ts: '2026-11-21T06:00:02.000Z',
      roundId,
    });
    dispatch({ type: 'done', roundId });
    // done 时助手形态没有 process_event ⇒ 提示只能在 turn_update 算
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();

    const turnUpdate = {
      type: 'turn_update' as const,
      rounds: [
        makeRound({
          id: roundId,
          content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
        }),
      ],
      state: { phase: 'settled' as const, roundId, status: 'complete' as const },
    };
    dispatch(turnUpdate);
    expect(document.querySelectorAll(HINT_SELECTOR)).toHaveLength(1);
    // 同一轮第二次投影（待发送队列同步等）→ 幂等：先撤后插，不叠加
    dispatch(turnUpdate);
    expect(document.querySelectorAll(HINT_SELECTOR)).toHaveLength(1);
  });
});
