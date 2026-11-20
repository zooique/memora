/**
 * 托管派发受理测试（DISPATCH-USER-ECHO-1 后的分工）
 *
 * 真机缺陷：memora 宝往「正在看的工作会话」追加任务，任务正常开跑，但那条代发的提示词
 * **没有用户输入气泡**——直到切会话 / 重启触发 replay 才从落盘补出。根因不是发送端漏推：
 * 回声发生在轮建立之前，没有 roundId 归属，ready 重放（resetChatView）天然带不上它。
 *
 * 修复分工：
 *  - 本文件（派发层）：只钉「受理即把原文与 origin/senderName 放进 seed」，不再自行上屏；
 *  - 上屏时机在 consumeFlow 首个带 roundId 的 chunk（面板用例钉住，与轮同生）。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// hostedDispatchRun / hostedDispatchLock 顶层解构 vscode.l10n ⇒ mock 必须补 l10n，
// 否则 import 期访问未定义导出即 throw（记忆中的宿主 mock 命名空间坑）
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

import { HOSTED_SENDER_NAME } from '../../../shared/constants.js';
import { dispatchHostedInputWith, type HostedDispatchDeps } from '../hostedDispatchRun.js';
import type { FlowSeed } from '../sessionRuntime.js';

function makeDeps(overrides: Partial<HostedDispatchDeps> = {}): {
  deps: HostedDispatchDeps;
  starts: Array<{ sid: string; seed: FlowSeed }>;
  notes: string[];
} {
  const starts: Array<{ sid: string; seed: FlowSeed }> = [];
  const notes: string[] = [];
  const deps: HostedDispatchDeps = {
    isManaged: () => true,
    isStreaming: () => false,
    isTargetTakenOver: () => false,
    currentSessionId: () => 'other-session',
    // acquire=true + holds=false ⇒ acquireDispatchWriteLease 拿到租约，refusal 为空
    acquireLock: async () => true,
    holdsLock: () => false,
    releaseLock: () => {},
    getAgent: async () => ({}) as never,
    // D1：默认引用完整（探针返回空数组）；缺轮 / 读不全的负例在下方用例里单独覆盖
    roundIds: () => [],
    roundStore: () => ({ findMissingRounds: () => [] }) as never,
    markAgentDriven: () => {},
    rememberCreator: () => {},
    trackLease: () => {},
    startFlow: (sid, _factory, seed) => starts.push({ sid, seed }),
    // 派发交代上屏通道：默认收集正文，供断言文案真值
    note: (msg) => notes.push(msg.content),
    ...overrides,
  };
  return { deps, starts, notes };
}

describe('dispatchHostedInputWith · 派发受理与 seed 事实', () => {
  it('受理成功 → seed 带裸输入、origin=hosted、senderName；派发层不自行上屏', async () => {
    const { deps, starts, notes } = makeDeps();

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant-session',
      targetSessionId: 'target-session',
      text: '接着刚才的会话，追加任务 X',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目录统计',
    });

    expect(result.ok).toBe(true);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.sid).toBe('target-session');
    // 上屏与 live 投影共用的那一份事实：原文逐字、来源与发送者名随 seed 落地
    expect(starts[0]?.seed.userMessage?.content).toBe('接着刚才的会话，追加任务 X');
    expect(starts[0]?.seed.userMessage?.name).toBe(HOSTED_SENDER_NAME);
    expect(starts[0]?.seed.origin).toBe('hosted');
    // 派发交代：真值只来自会话标题 + 原文，不生成、不润色
    expect(notes[0]).toContain('派给《目录统计》');
    expect(notes[0]).toContain('接着刚才的会话，追加任务 X');
    // 成功收尾：只认受理、不冒充落盘；与失败收尾「没派出去」两态可辨
    expect(notes.join(' ')).toContain('已接单');
    expect(notes.join(' ')).not.toContain('没派出去');
  });

  it('user 回声不再由派发层提前推（轮建立前无归属，改由 consumeFlow 随轮上屏）', async () => {
    const { deps, starts } = makeDeps();

    await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target',
      text: '裸输入原文',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    // 派发层唯一副作用 = 起流；UI 上屏发生在流的首个 roundId 上（面板用例断言）
    expect(starts).toHaveLength(1);
    expect(starts[0]?.seed.userMessage?.content).toBe('裸输入原文');
  });

  it('被拒（目标在跑）→ 不起流（不留假气泡）', async () => {
    const { deps, starts, notes } = makeDeps({
      isStreaming: (sid) => sid === 'target-session',
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target-session',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result.ok).toBe(false);
    expect(starts).toHaveLength(0);
    // 失败收尾：同一气泡先说「要派给谁」，再补一句为什么没派成（两句连读像人话，只含既有文案）
    expect(notes[0]).toContain('派给《目标会话》');
    expect(notes[1]).toContain('没派出去：');
    // 反向：失败路径不得混入受理话术（两态必须可辨）
    expect(notes.join(' ')).not.toContain('已接单');
  });
});

/**
 * DISPATCH-TAKEOVER-GUARD-1：用户接管态派活门禁
 *
 * 真机推演反例：用户在工作会话手发一轮后软暂停（streaming=false），助手 send_to_session
 * 会绕过 E_BUSY，命中 agent.chat 的 autoResumeIfPaused 续跑用户暂停的轮（fail-open）。
 * 门禁须在接管态拒派，且不影响自建会话 / 已收场会话的正常派发。
 */
describe('dispatchHostedInputWith · 用户接管态派活门禁', () => {
  it('目标用户接管中 ⇒ E_DENIED，不上屏、不起流、不拿锁、不登记驱动', async () => {
    const acquired: string[] = [];
    const marked: string[] = [];
    const { deps, starts, notes } = makeDeps({
      isTargetTakenOver: (sid) => sid === 'target-session',
      acquireLock: async (sid) => {
        acquired.push(sid);
        return true;
      },
      markAgentDriven: (sid) => marked.push(sid),
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target-session',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
    expect(starts).toHaveLength(0);
    expect(acquired).toHaveLength(0);
    expect(marked).toHaveLength(0);
    // E_DENIED 收尾（与 E_BUSY/E_LOCKED/E_UNREADABLE 同口径）：先派给谁、再为什么没派成。
    // 漏掉这句 = 助手窗留下「派给《X》」却无下文的假交代（审查真伤）。
    expect(notes[0]).toContain('派给《目标会话》');
    expect(notes[1]).toContain('没派出去：');
    // 反向：失败路径不得混入受理话术（两态必须可辨）
    expect(notes.join(' ')).not.toContain('已接单');
  });

  it('调用方非托管 ⇒ E_DENIED 也补失败收尾（不留半句假交代）', async () => {
    const { deps, starts, notes } = makeDeps({ isManaged: () => false });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'self-session',
      targetSessionId: 'target-session',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
    expect(starts).toHaveLength(0);
    expect(notes[1]).toContain('没派出去：');
  });

  it('目标非接管（自建会话 / 已收场）⇒ 正常受理，门禁不误伤设计内派发', async () => {
    const { deps, starts } = makeDeps({
      isTargetTakenOver: () => false,
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'self-built',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '自建会话',
    });

    expect(result.ok).toBe(true);
    expect(starts).toHaveLength(1);
  });

  it('接管判据优先于判忙：接管中的目标即使 streaming=false 也拒（E_DENIED 非 E_BUSY）', async () => {
    const { deps } = makeDeps({
      isTargetTakenOver: () => true,
      isStreaming: () => false,
    });
    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });
    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
  });
});

/**
 * D1（ROUND-CACHE-NOINVALIDATE-1）：派发受理前的轮引用完整性自检
 *
 * 真机复现：盘上移走目标会话引用的轮文件后，派发仍 accepted:true 并落新轮，
 * 留下永久悬空引用。闸必须是「拿锁并重读会话文件之后」的盘上目录核对，
 * 且拒收时不上屏、不起流、当场归还租约。
 */
describe('dispatchHostedInputWith · 轮引用完整性自检（D1）', () => {
  it('引用缺轮 ⇒ E_UNREADABLE，不上屏、不起流、不登记驱动、归还租约', async () => {
    /** 被归还的会话（断言租约没有漏在本面板） */
    const released: string[] = [];
    /** 被登记驱动的会话（拒收路径必须为空） */
    const marked: string[] = [];
    const { deps, starts } = makeDeps({
      roundIds: (sid) => (sid === 'target-session' ? ['round-ok', 'round-gone'] : []),
      roundStore: () => ({ findMissingRounds: () => ['round-gone'] }) as never,
      releaseLock: (sid) => released.push(sid),
      markAgentDriven: (sid) => marked.push(sid),
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target-session',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_UNREADABLE' });
    expect(result.ok === false && result.message).toContain('round-gone');
    expect(starts).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(released).toEqual(['target-session']);
  });

  it('rounds 目录不可读（探针抛错）⇒ 同样 E_UNREADABLE，不当成无缺失', async () => {
    const { deps, starts } = makeDeps({
      roundIds: () => ['round-x'],
      roundStore: () =>
        ({
          findMissingRounds: () => {
            throw new Error('EACCES: rounds');
          },
        }) as never,
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_UNREADABLE' });
    expect(starts).toHaveLength(0);
  });

  it('引用完整（探针无缺失）⇒ 正常受理（自检不误伤）', async () => {
    const { deps, starts } = makeDeps({
      roundIds: () => ['round-ok'],
      roundStore: () => ({ findMissingRounds: () => [] }) as never,
    });

    const result = await dispatchHostedInputWith(deps, {
      callingSessionId: 'assistant',
      targetSessionId: 'target',
      text: '任务',
      senderName: HOSTED_SENDER_NAME,
      targetTitle: '目标会话',
    });

    expect(result.ok).toBe(true);
    expect(starts).toHaveLength(1);
  });
});
