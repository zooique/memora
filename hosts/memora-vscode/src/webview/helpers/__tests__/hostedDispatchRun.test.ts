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
    currentSessionId: () => 'other-session',
    // acquire=true + holds=false ⇒ acquireDispatchWriteLease 拿到租约，refusal 为空
    acquireLock: async () => true,
    holdsLock: () => false,
    releaseLock: () => {},
    getAgent: async () => ({}) as never,
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
