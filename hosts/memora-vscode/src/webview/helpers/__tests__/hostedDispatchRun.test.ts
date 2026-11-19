/**
 * 托管派发即时上屏测试（2026-11-19 真机 DISPATCH-USER-ECHO-1）
 *
 * 真机缺陷：memora 宝往「正在看的工作会话」追加任务，任务正常开跑，但那条代发的提示词
 * **没有用户输入气泡**——直到切会话 / 重启触发 replay 才从落盘补出。根因：派发受理只把
 * userMessage 塞进 seed 落盘，缺了正常 sendInput 里的 `post({type:'user'})` 即时上屏；收场
 * turn_update 是 replay=false，webview 不重建气泡。
 *
 * 本测试钉住修复：受理成功即 post 一条 user 回声，text 取裸输入、带 origin/senderName。
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

import type { ExtensionToWebviewMessage } from '../../../shared/protocol.js';
import { dispatchHostedInputWith, type HostedDispatchDeps } from '../hostedDispatchRun.js';

type UserEcho = Extract<ExtensionToWebviewMessage, { type: 'user' }>;

function makeDeps(overrides: Partial<HostedDispatchDeps> = {}): {
  deps: HostedDispatchDeps;
  echoes: UserEcho[];
  starts: Array<{ sid: string; seed: { userMessage: { content: string } } }>;
} {
  const echoes: UserEcho[] = [];
  const starts: Array<{ sid: string; seed: { userMessage: { content: string } } }> = [];
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
    postUserEcho: (_sid, echo) => echoes.push(echo),
    startFlow: (sid, _factory, seed) =>
      starts.push({ sid, seed: seed as { userMessage: { content: string } } }),
    ...overrides,
  };
  return { deps, echoes, starts };
}

describe('dispatchHostedInputWith · 代发输入即时上屏', () => {
  it('受理成功 → post 一条 user 回声，text=裸输入、origin=hosted、senderName=Memora', async () => {
    const { deps, echoes } = makeDeps();

    const result = await dispatchHostedInputWith(
      deps,
      'assistant-session',
      'target-session',
      '接着刚才的会话，追加任务 X',
      'Memora',
    );

    expect(result.ok).toBe(true);
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({
      type: 'user',
      text: '接着刚才的会话，追加任务 X',
      origin: 'hosted',
      senderName: 'Memora',
    });
    expect(echoes[0]?.ts).toBeTypeOf('string');
  });

  it('user 回声投递到目标会话、text 与起流 seed.userMessage.content 逐字同值', async () => {
    const echoesBySid: Array<{ sid: string; echo: UserEcho }> = [];
    const { deps, starts } = makeDeps({
      postUserEcho: (sid, echo) => echoesBySid.push({ sid, echo }),
    });

    await dispatchHostedInputWith(deps, 'assistant', 'target', '裸输入原文', 'Memora');

    const seed = starts[0]?.seed;
    expect(echoesBySid).toHaveLength(1);
    expect(echoesBySid[0]?.sid).toBe('target');
    expect(echoesBySid[0]?.echo.text).toBe(seed?.userMessage.content);
    expect(echoesBySid[0]?.echo.text).toBe('裸输入原文');
  });

  it('被拒（目标在跑）→ 不上屏、不起流（不留假气泡）', async () => {
    const { deps, echoes, starts } = makeDeps({
      isStreaming: (sid) => sid === 'target-session',
    });

    const result = await dispatchHostedInputWith(
      deps,
      'assistant',
      'target-session',
      '任务',
      'Memora',
    );

    expect(result.ok).toBe(false);
    expect(echoes).toHaveLength(0);
    expect(starts).toHaveLength(0);
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
    const { deps, echoes, starts } = makeDeps({
      isTargetTakenOver: (sid) => sid === 'target-session',
      acquireLock: async (sid) => {
        acquired.push(sid);
        return true;
      },
      markAgentDriven: (sid) => marked.push(sid),
    });

    const result = await dispatchHostedInputWith(
      deps,
      'assistant',
      'target-session',
      '任务',
      'Memora',
    );

    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
    expect(echoes).toHaveLength(0);
    expect(starts).toHaveLength(0);
    expect(acquired).toHaveLength(0);
    expect(marked).toHaveLength(0);
  });

  it('目标非接管（自建会话 / 已收场）⇒ 正常受理，门禁不误伤设计内派发', async () => {
    const { deps, echoes, starts } = makeDeps({
      isTargetTakenOver: () => false,
    });

    const result = await dispatchHostedInputWith(deps, 'assistant', 'self-built', '任务', 'Memora');

    expect(result.ok).toBe(true);
    expect(echoes).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it('接管判据优先于判忙：接管中的目标即使 streaming=false 也拒（E_DENIED 非 E_BUSY）', async () => {
    const { deps } = makeDeps({
      isTargetTakenOver: () => true,
      isStreaming: () => false,
    });
    const result = await dispatchHostedInputWith(deps, 'assistant', 'target', '任务', 'Memora');
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
    const { deps, echoes, starts } = makeDeps({
      roundIds: (sid) => (sid === 'target-session' ? ['round-ok', 'round-gone'] : []),
      roundStore: () => ({ findMissingRounds: () => ['round-gone'] }) as never,
      releaseLock: (sid) => released.push(sid),
      markAgentDriven: (sid) => marked.push(sid),
    });

    const result = await dispatchHostedInputWith(
      deps,
      'assistant',
      'target-session',
      '任务',
      'Memora',
    );

    expect(result).toMatchObject({ ok: false, code: 'E_UNREADABLE' });
    expect(result.ok === false && result.message).toContain('round-gone');
    expect(echoes).toHaveLength(0);
    expect(starts).toHaveLength(0);
    expect(marked).toHaveLength(0);
    expect(released).toEqual(['target-session']);
  });

  it('rounds 目录不可读（探针抛错）⇒ 同样 E_UNREADABLE，不当成无缺失', async () => {
    const { deps, echoes, starts } = makeDeps({
      roundIds: () => ['round-x'],
      roundStore: () =>
        ({
          findMissingRounds: () => {
            throw new Error('EACCES: rounds');
          },
        }) as never,
    });

    const result = await dispatchHostedInputWith(deps, 'assistant', 'target', '任务', 'Memora');

    expect(result).toMatchObject({ ok: false, code: 'E_UNREADABLE' });
    expect(echoes).toHaveLength(0);
    expect(starts).toHaveLength(0);
  });

  it('引用完整（探针无缺失）⇒ 正常受理（自检不误伤）', async () => {
    const { deps, echoes, starts } = makeDeps({
      roundIds: () => ['round-ok'],
      roundStore: () => ({ findMissingRounds: () => [] }) as never,
    });

    const result = await dispatchHostedInputWith(deps, 'assistant', 'target', '任务', 'Memora');

    expect(result.ok).toBe(true);
    expect(echoes).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });
});
