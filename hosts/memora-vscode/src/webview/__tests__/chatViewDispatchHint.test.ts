/**
 * 派发凭证行 / 补派判据（DISPATCH-RECEIPT-1 起）——重放 / 实时 / 形态门控 / 幂等 / 骨架比对
 *
 * 被测事实：
 *   - 本轮**有业务受理成功**的 send_to_session / create_session 回执 ⇒ 助手形态气泡下出现一行凭证；
 *   - 无回执的轮**一个字都不加**：DOM 骨架与一条普通对话轮逐节点一致（强断言，防「换了个 class 又长回来」）；
 *   - 业务失败（内核 ok + 摘要 ok=false）不产生凭证——受理失败不能盖章；
 *   - hosted / self 形态不产生凭证（凭证只归助手会话）；
 *   - 重放与实时共用同一投影函数；同一轮多次 turn_update 只留一条。
 *
 * 注意：本文件不再断言「未核到回执」提示——那条 DOM 投影已撤（提示是猜出来的告警，
 * 凭证才是事实呈现）。`shouldNudgeDispatchRepair`（补派轮判据）在本文件后半保持原样被覆盖。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import type { RoundView } from '../../shared/protocol.js';
import { INTERNAL_SEED_SENDER } from '../../shared/constants.js';
import { shouldNudgeDispatchRepair } from '../helpers/dispatchReceiptHint.js';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 凭证行选择器（与 helper 常量同值；测试侧写死以锁契约） */
const RECEIPT_SELECTOR = '.round-group__dispatch-receipt';

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

/**
 * 推一份会话快照（凭证的会话标题真源 = 宿主推来的 dispatchedSessions）
 *
 * @param sessions sid → 标题（报告 titleFor 解析用）
 */
function mountSessionSnapshot(
  sessions: Array<{ sid: string; title: string; via: 'delegate' | 'create' }>,
): void {
  dispatch({
    type: 'session_activity',
    runningIds: [],
    pendingIds: [],
    badgeCount: 0,
    dispatchedSessions: sessions,
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

/** 成功的 create_session 回执（sid 只在 summary 里） */
function acceptedCreateEvents(): unknown[] {
  return [
    {
      type: 'tool_start',
      seq: 0,
      ts: '2026-11-21T06:00:01.000Z',
      payload: {
        toolCallId: 'c3',
        name: 'create_session',
        args: JSON.stringify({ text: '开一个小说会话' }),
      },
    },
    {
      type: 'tool_result',
      seq: 1,
      ts: '2026-11-21T06:00:01.500Z',
      payload: {
        toolCallId: 'c3',
        name: 'create_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "sid": "2026-11-21-new"\n}',
      },
    },
  ];
}

/**
 * 取标签骨架：只保留标签名 + class（不含文本、id、任何 data-*）
 *
 * 用来证明「无回执的轮」与普通对话轮结构逐节点一致——比「不含某个 class」更强。
 *
 * @param el 轮容器或消息容器
 */
function tagSkeleton(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Element): void => {
    const cls = node.getAttribute('class') ?? '';
    parts.push(`<${node.tagName.toLowerCase()}|${cls}>`);
    Array.from(node.children).forEach(walk);
  };
  walk(el);
  return parts.join('');
}

/**
 * 取某轮容器的「去掉凭证行后」骨架（凭证是唯一允许的差异）
 *
 * @param roundId 轮 id
 */
function skeletonWithoutReceipt(roundId: string): string {
  const group = document.querySelector<HTMLElement>(`.round-group[data-round-id="${roundId}"]`)!;
  const clone = group.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(RECEIPT_SELECTOR).forEach((n) => n.remove());
  return tagSkeleton(clone);
}

describe('派发凭证（DISPATCH-RECEIPT-1）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('重放 · 无回执 ⇒ 凭证行不存在，且骨架与普通对话轮逐节点一致', () => {
    mountChatView('assistant');
    // 两轮同一份 replay 快照（replay 会清屏，分两次 dispatch 只剩最后一轮）
    dispatch({
      type: 'turn_update',
      rounds: [
        // 复刻事故轮落盘形态：正文声称已派，零工具
        makeRound({
          id: 'claim-only',
          content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
        }),
        makeRound({ id: 'plain-chat', content: '5 + 9 = 14。', userContent: '5+9 等于几？' }),
      ],
      state: { phase: 'settled', roundId: 'plain-chat', status: 'complete' },
      replay: true,
    });
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();
    // 强断言：两轮的标签骨架完全一致（只差 data-round-id，不在骨架内）
    expect(skeletonWithoutReceipt('claim-only')).toBe(skeletonWithoutReceipt('plain-chat'));
  });

  it('重放 · send_to_session 受理成功 ⇒ 出现凭证行，文案含目标会话名', () => {
    mountChatView('assistant');
    mountSessionSnapshot([{ sid: '2026-11-21-worker', title: '小说会话', via: 'delegate' }]);
    dispatchReplay(
      makeRound({
        id: 'accepted',
        content: '扩写任务已派给小说会话。',
        processEvents: acceptedSendEvents(),
      }),
    );
    const line = document.querySelector<HTMLElement>(RECEIPT_SELECTOR);
    expect(line).not.toBeNull();
    expect(line!.textContent).toBe('Dispatched to “小说会话” · receipt confirmed');
    // 位置契约：容器直接子元素、footer 之前（常显，不随底栏 hover 隐藏）
    const group = document.querySelector<HTMLElement>('.round-group[data-round-id="accepted"]')!;
    expect(line!.parentElement).toBe(group);
    expect(group.lastElementChild?.classList.contains('round-group__footer')).toBe(true);
  });

  it('重放 · create_session 受理成功 ⇒ 文案是「已新建会话」', () => {
    mountChatView('assistant');
    mountSessionSnapshot([{ sid: '2026-11-21-new', title: '测试小说', via: 'create' }]);
    dispatchReplay(
      makeRound({
        id: 'created',
        content: '新会话已创建。',
        processEvents: acceptedCreateEvents(),
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)!.textContent).toBe(
      'Created session “测试小说” · receipt confirmed',
    );
  });

  it('重放 · 业务失败（ok:false / E_BUSY）⇒ 不出现凭证（受理失败不能盖章）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'rejected',
        content: '扩写任务已派给小说会话。',
        processEvents: rejectedSendEvents(),
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();
  });

  it('重放 · 快照里没有该 sid ⇒ 降级显示 sid，不编造标题也不隐藏', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'no-title',
        content: '扩写任务已派给小说会话。',
        processEvents: acceptedSendEvents(),
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)!.textContent).toBe(
      'Dispatched to “2026-11-21-worker” · receipt confirmed',
    );
  });

  it('重放 · 同一轮两次派发 ⇒ 只一行，总数前置 + 命名第一条（不做成清单）', () => {
    mountChatView('assistant');
    const two = [
      ...acceptedSendEvents(),
      {
        type: 'tool_start',
        seq: 2,
        ts: '2026-11-21T06:00:02.000Z',
        payload: {
          toolCallId: 'c4',
          name: 'send_to_session',
          args: JSON.stringify({ sid: '2026-11-21-second', text: '第二件事' }),
        },
      },
      {
        type: 'tool_result',
        seq: 3,
        ts: '2026-11-21T06:00:02.500Z',
        payload: {
          toolCallId: 'c4',
          name: 'send_to_session',
          ok: true,
          summary: '{\n  "ok": true\n}',
        },
      },
    ];
    dispatchReplay(makeRound({ id: 'twice', content: '两件事都派了。', processEvents: two }));
    expect(document.querySelectorAll(RECEIPT_SELECTOR)).toHaveLength(1);
    // 无快照 ⇒ 第一条降级显示 sid；计数取 items.length（不出现「等 N 个」歧义）
    expect(document.querySelector<HTMLElement>(RECEIPT_SELECTOR)!.textContent).toBe(
      'Dispatched to 2 sessions (incl. “2026-11-21-worker”) · receipt confirmed',
    );
  });

  it('重放 · 多派且首条标题取不到 ⇒ 首条降级 sid，总数照报（不编造、不隐藏）', () => {
    mountChatView('assistant');
    // 快照只有第二条的标题：首条仍必须以 sid 出场，且总数不能因此缩成 1
    mountSessionSnapshot([{ sid: '2026-11-21-second', title: '第二会话', via: 'delegate' }]);
    const two = [
      ...acceptedSendEvents(),
      {
        type: 'tool_start',
        seq: 2,
        ts: '2026-11-21T06:00:02.000Z',
        payload: {
          toolCallId: 'c4',
          name: 'send_to_session',
          args: JSON.stringify({ sid: '2026-11-21-second', text: '第二件事' }),
        },
      },
      {
        type: 'tool_result',
        seq: 3,
        ts: '2026-11-21T06:00:02.500Z',
        payload: { toolCallId: 'c4', name: 'send_to_session', ok: true, summary: '{"ok":true}' },
      },
    ];
    dispatchReplay(makeRound({ id: 'fallback', content: '两件事都派了。', processEvents: two }));
    expect(document.querySelector<HTMLElement>(RECEIPT_SELECTOR)!.textContent).toBe(
      'Dispatched to 2 sessions (incl. “2026-11-21-worker”) · receipt confirmed',
    );
  });

  it('重放 · 同轮新建两个会话 ⇒ 文案是「2 个会话 · 已新建」', () => {
    mountChatView('assistant');
    mountSessionSnapshot([
      { sid: '2026-11-21-new', title: '测试小说', via: 'create' },
      { sid: '2026-11-21-new2', title: '第二本小说', via: 'create' },
    ]);
    const twoCreates = [
      ...acceptedCreateEvents(),
      {
        type: 'tool_start',
        seq: 2,
        ts: '2026-11-21T06:00:02.000Z',
        payload: {
          toolCallId: 'c5',
          name: 'create_session',
          args: JSON.stringify({ text: '再开一个会话' }),
        },
      },
      {
        type: 'tool_result',
        seq: 3,
        ts: '2026-11-21T06:00:02.500Z',
        payload: {
          toolCallId: 'c5',
          name: 'create_session',
          ok: true,
          summary: '{\n  "ok": true,\n  "sid": "2026-11-21-new2"\n}',
        },
      },
    ];
    dispatchReplay(
      makeRound({ id: 'two-creates', content: '两个会话都建好了。', processEvents: twoCreates }),
    );
    expect(document.querySelector<HTMLElement>(RECEIPT_SELECTOR)!.textContent).toBe(
      'Created 2 sessions (incl. “测试小说”) · receipt confirmed',
    );
  });

  it('重放 · 同轮「新建 + 派给」混合 ⇒ 用「已派给」而非「已新建」（混合轮不说谎）', () => {
    mountChatView('assistant');
    mountSessionSnapshot([
      { sid: '2026-11-21-new', title: '测试小说', via: 'create' },
      { sid: '2026-11-21-second', title: '第二会话', via: 'delegate' },
    ]);
    const mixed = [
      ...acceptedCreateEvents(),
      {
        type: 'tool_start',
        seq: 2,
        ts: '2026-11-21T06:00:02.000Z',
        payload: {
          toolCallId: 'c6',
          name: 'send_to_session',
          args: JSON.stringify({ sid: '2026-11-21-second', text: '第二件事' }),
        },
      },
      {
        type: 'tool_result',
        seq: 3,
        ts: '2026-11-21T06:00:02.500Z',
        payload: { toolCallId: 'c6', name: 'send_to_session', ok: true, summary: '{"ok":true}' },
      },
    ];
    dispatchReplay(makeRound({ id: 'mixed', content: '一建一派。', processEvents: mixed }));
    expect(document.querySelector<HTMLElement>(RECEIPT_SELECTOR)!.textContent).toBe(
      'Dispatched to 2 sessions (incl. “测试小说”) · receipt confirmed',
    );
  });

  it('重放 · 有工具动作但无派发回执 ⇒ 无凭证', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'tool-only',
        content: '已把三个版本的差异列在下面。',
        processEvents: readonlyToolEvents(),
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();
  });

  it('重放 · 换说法 + 零工具 ⇒ 无凭证（话术不产生证据）', () => {
    mountChatView('assistant');
    dispatchReplay(
      makeRound({
        id: 'new-wording',
        content: '测试会话已开：「白话方案设计师 ask 测试」（挂在角色包下，回执成功）。',
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();
  });

  it('重放 · hosted 轮有真实回执 ⇒ 同样出凭证（事实优先于形态）', () => {
    mountChatView('assistant');
    mountSessionSnapshot([{ sid: '2026-11-21-worker', title: '小说会话', via: 'delegate' }]);
    dispatchReplay(
      makeRound({
        id: 'hosted-receipt',
        content: '落定汇报：已写入第三章。',
        origin: 'hosted',
        processEvents: acceptedSendEvents(),
      }),
    );
    expect(document.querySelector(RECEIPT_SELECTOR)).not.toBeNull();
  });

  it('重放 · self 形态 ⇒ 有回执也不出凭证（与盖章卡同构）', () => {
    mountChatView('self');
    dispatchReplay(
      makeRound({
        id: 'self-receipt',
        content: '扩写任务已派给小说会话。',
        processEvents: acceptedSendEvents(),
      }),
    );
    expect(document.querySelector('.round-group[data-round-id="self-receipt"]')).not.toBeNull();
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();
  });

  it('实时 · 有回执 ⇒ done 后 turn_update 落凭证，重复 turn_update 只留一条', () => {
    mountChatView('assistant');
    const roundId = 'live-receipt';
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
    // 实时阶段过程事件未落齐 ⇒ 凭证只能在 turn_update 算
    expect(document.querySelector(RECEIPT_SELECTOR)).toBeNull();

    const turnUpdate = {
      type: 'turn_update' as const,
      rounds: [
        makeRound({
          id: roundId,
          content: '扩写任务已派给小说会话：把《井》扩写到 1000 字。',
          processEvents: acceptedSendEvents(),
        }),
      ],
      state: { phase: 'settled' as const, roundId, status: 'complete' as const },
    };
    dispatch(turnUpdate);
    expect(document.querySelectorAll(RECEIPT_SELECTOR)).toHaveLength(1);
    // 同一轮第二次投影 → 幂等：先撤后插，不叠加
    dispatch(turnUpdate);
    expect(document.querySelectorAll(RECEIPT_SELECTOR)).toHaveLength(1);
  });
});

/**
 * 完成门判据（DISPATCH-REPAIR-1）——本批**未改一行**，保留原覆盖证明补派轮仍活着
 *
 * 与凭证同源：同一触发谓词 + 同一回执判据；额外排除内部种子轮（防自唤成环）与
 * hosted 来源轮。只判断「要不要起一轮补派」，不判断「模型一定会补」。
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
