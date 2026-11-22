/**
 * 派活承诺对账提示（DISPATCH-CLAIM-HINT-1）——重放 / 实时 / 形态门控 / 幂等
 *
 * 被测事实：
 *   - 正文声称「已派给某会话」但本轮无业务受理回执 ⇒ 助手形态出现一句证据缺口提示；
 *   - 正文换了说法（「会话已开 / 回执成功」）但本轮零 tool_start ⇒ 同样提示；
 *   - 有成功回执 / 回执业务失败两类分别「不提示 / 提示」；
 *   - hosted 来源的零工具轮不提示（落定通知是常态，不是派活承诺）；
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
import { INTERNAL_SEED_SENDER } from '../../shared/constants.js';
import { shouldNudgeDispatchRepair } from '../helpers/dispatchReceiptHint.js';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 提示元素选择器（与 helper 常量同值；测试侧写死以锁契约） */
const HINT_SELECTOR = '.round-group__dispatch-hint';

/** 提示文案（l10n 未加载翻译时返回英文源键） */
const HINT_TEXT = 'No session dispatch receipt found for this turn';

/**
 * 构造单轮 RoundView（最小形状，够 renderReplayRound 与实时投影消费）
 *
 * @param over 覆盖项：id / 正文 / 过程事件 / 状态 / 来源
 */
function makeRound(over: {
  id: string;
  content: string;
  processEvents?: unknown[];
  status?: RoundView['status'];
  origin?: RoundView['origin'];
  /** 用户原文覆盖（零工具分支的意图门；缺省为扩写请求） */
  userContent?: string;
}): RoundView {
  return {
    id: over.id,
    userMessage: {
      id: `${over.id}-user`,
      role: 'user',
      content: over.userContent ?? '把《井》扩写到 1000 字',
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
    origin: over.origin ?? 'user',
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

/** 一次只读查询的 tool_start（进了工具闭环，但没有派发回执） */
function readonlyToolEvents(): unknown[] {
  return [
    {
      type: 'tool_start',
      seq: 0,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'c-read',
        name: 'list_work_sessions',
        args: '{}',
      },
    },
  ];
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

  it('重放 · 助手形态：有工具动作 + 正文没有派发措辞 ⇒ 不提示', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'no-claim-with-tool',
        content: '已把三个版本的差异列在下面。',
        processEvents: readonlyToolEvents(),
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · 助手形态：换说法 + 零 tool_start ⇒ 提示（词表外的复发形态）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'zero-tool-new-wording',
        // 复刻复发轮 e4a18b0d：词表三词一个都不命中
        content: '测试会话已开：「白话方案设计师 ask 测试」（挂在角色包下，回执成功）。',
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).not.toBeNull();
  });

  it('重放 · 助手形态：纯聊天零工具 ⇒ 不提示（零工具不是承诺）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'pure-chat-zero-tool',
        content: '5 + 9 = 14。',
        userContent: '5+9 等于几？',
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · 助手形态：零工具 + 用户要求新开会话 ⇒ 提示（意图门）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'zero-tool-intent',
        content: '已经安排好了，稍等。',
        userContent: '再新开一个会话，启动测试',
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).not.toBeNull();
  });

  it('重放 · 助手形态：调了别的工具但声称会话已建 ⇒ 提示（创建断言分支）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'create-claim-with-tool',
        content: '新会话「测试」已创建。',
        processEvents: readonlyToolEvents(),
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).not.toBeNull();
  });

  it('重放 · 助手形态：已创建文件 ≠ 会话创建 ⇒ 不提示', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'create-file-not-session',
        content: '已创建文件 stories/井.md。',
        processEvents: readonlyToolEvents(),
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · 助手形态：hosted 零工具轮 ⇒ 不提示（落定通知是常态）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'hosted-notice',
        content: '有一条托管会话刚落定，结果如下。',
        origin: 'hosted',
      }),
    );
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · self 形态：同一轮不插提示（与盖章会话卡同构）', () => {
    mountChatView('self');
    dispatchReplay(makeRound({ id: 'self-claim', content: '扩写任务已派给小说会话。' }));
    // 轮容器照常渲染，只是提示元素不插
    expect(document.querySelector('.round-group[data-round-id="self-claim"]')).not.toBeNull();
    expect(document.querySelector(HINT_SELECTOR)).toBeNull();
  });

  it('重放 · self 形态：零工具轮同样不插（自助模式逻辑零改动）', () => {
    mountChatView('self');
    dispatchReplay(makeRound({ id: 'self-zero-tool', content: '测试会话已开，回执成功。' }));
    expect(document.querySelector('.round-group[data-round-id="self-zero-tool"]')).not.toBeNull();
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

/**
 * 完成门判据（DISPATCH-REPAIR-1）
 *
 * 与提示同源：同一触发谓词（派发话术 OR 零 tool_start）+ 同一回执判据；额外排除
 * 内部种子轮（防补派检查自唤成环）与 hosted 来源轮。只判断「要不要起一轮补派」，
 * 不判断「模型一定会补」——它是概率修复，不是保证。
 */
describe('完成门判据：何时自动起一轮补派检查', () => {
  /** 一次真实形状的成功派发事件对 */
  const acceptedEvents = [
    {
      type: 'tool_start',
      seq: 1,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'send-ok',
        name: 'send_to_session',
        args: JSON.stringify({ sid: '2026-11-14-session-x', text: '继续写' }),
      },
    },
    {
      type: 'tool_result',
      seq: 2,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'send-ok',
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "accepted": true\n}',
      },
    },
  ] as unknown as ProcessEvent[];

  /** 一次真实形状的业务失败派发（内核 ok=true，业务 ok=false） */
  const busyEvents = [
    acceptedEvents[0],
    {
      type: 'tool_result',
      seq: 3,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'send-ok',
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": false,\n  "code": "E_BUSY"\n}',
      },
    },
  ] as unknown as ProcessEvent[];

  /** 判据输入底座：正常用户轮 + 完成 + 声称已派 */
  const base = {
    status: 'complete',
    assistantMessage: { content: '扩写任务已派给小说会话。' },
    userMessage: { name: 'memora宝' },
    origin: 'user' as const,
    processEvents: [] as ProcessEvent[],
  };

  it('声称已派 + 零回执 ⇒ 触发', () => {
    expect(shouldNudgeDispatchRepair(base)).toBe(true);
  });

  it('有业务受理回执 ⇒ 不触发', () => {
    expect(shouldNudgeDispatchRepair({ ...base, processEvents: acceptedEvents })).toBe(false);
  });

  it('业务失败回执（E_BUSY）⇒ 触发', () => {
    expect(shouldNudgeDispatchRepair({ ...base, processEvents: busyEvents })).toBe(true);
  });

  it('内部种子轮 ⇒ 不触发（补派检查不得自唤成环）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        userMessage: { name: INTERNAL_SEED_SENDER },
      }),
    ).toBe(false);
  });

  it('非 complete（中断 / 软暂停）⇒ 不触发', () => {
    expect(shouldNudgeDispatchRepair({ ...base, status: 'interrupted' })).toBe(false);
  });

  it('有工具动作 + 正文没有派发措辞 ⇒ 不触发', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '我把文件写好了。' },
        processEvents: readonlyToolEvents() as ProcessEvent[],
      }),
    ).toBe(false);
  });

  it('纯聊天零工具 ⇒ 不触发（零工具不是承诺）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '5 + 9 = 14。' },
        userMessage: { name: 'memora宝', content: '5+9 等于几？' },
      }),
    ).toBe(false);
  });

  it('零工具 + 用户要求新开会话 ⇒ 触发（意图门）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '已经安排好了，稍等。' },
        userMessage: { name: 'memora宝', content: '再新开一个会话，启动测试' },
      }),
    ).toBe(true);
  });

  it('调了别的工具但声称会话已建 ⇒ 触发（创建断言分支）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '新会话「测试」已创建。' },
        processEvents: readonlyToolEvents() as ProcessEvent[],
      }),
    ).toBe(true);
  });

  it('换说法 + 零 tool_start + 用户轮 ⇒ 触发（复发形态）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '测试会话已开，回执成功。' },
      }),
    ).toBe(true);
  });

  it('hosted 来源的零工具轮 ⇒ 不触发（落定通知不得起补派）', () => {
    expect(
      shouldNudgeDispatchRepair({
        ...base,
        assistantMessage: { content: '测试会话已开，回执成功。' },
        origin: 'hosted',
      }),
    ).toBe(false);
  });

  it('origin 缺省（旧数据）按用户轮解释 ⇒ 触发', () => {
    const legacy = { ...base };
    delete (legacy as { origin?: string }).origin;
    expect(
      shouldNudgeDispatchRepair({
        ...legacy,
        assistantMessage: { content: '测试会话已开，回执成功。' },
      }),
    ).toBe(true);
  });
});
