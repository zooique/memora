/**
 * remoteCommandRouter 单测 —— 钉住三条不变量
 *
 *  ① 桥层只定址 + 映射错误码：会话不存在 → no_session，相位不符 → 对应固定码；
 *  ② 放行时载荷**零加工**（answers 位次 / 空串 / 长度不动，text 不 trim）；
 *  ③ 重复答复不靠额外去重判据：第一次答复后相位离开等待态，第二次自然落 stale_phase。
 */
import { describe, it, expect } from 'vitest';
import {
  routeRemoteCommand,
  type RemoteCommandPorts,
  type RemoteInputCommand,
  type RemoteInputMessage,
} from '../remoteCommandRouter.js';
import type { RemotePhase } from '../remoteCommandPolicy.js';

/** 可变的桩：相位可在用例中途改写，模拟「命令执行后相位跃迁」 */
function ports(overrides: Partial<RemoteCommandPorts> = {}) {
  const delivered: Array<{ sessionId: string; input: RemoteInputMessage }> = [];
  const state = { phase: 'waiting-ask' as RemotePhase, has: true };
  const value: RemoteCommandPorts = {
    hasSession: (sid: string) => (sid === 's-a' ? state.has : false),
    phaseOf: (sid: string) => (sid === 's-a' ? state.phase : 'idle'),
    deliverInput: (sessionId: string, input: RemoteInputMessage) => {
      delivered.push({ sessionId, input });
    },
    ...overrides,
  };
  return { value, delivered, state };
}

describe('routeRemoteCommand — 定址与错误码映射', () => {
  it('会话不存在 → no_session，且不投递', () => {
    const h = ports();
    expect(routeRemoteCommand({ kind: 'answer', answers: ['a'] }, 's-missing', h.value)).toEqual({
      ok: false,
      code: 'no_session',
    });
    expect(h.delivered).toHaveLength(0);
  });

  it.each<RemotePhase>(['idle', 'running', 'waiting-pause', 'confirm-pending'])(
    'answer @ 相位 %s → stale_phase，且不投递（裁决在 handleInput，桥层不绕过）',
    (phase) => {
      const h = ports();
      h.state.phase = phase;
      expect(routeRemoteCommand({ kind: 'answer', answers: ['a'] }, 's-a', h.value)).toEqual({
        ok: false,
        code: 'stale_phase',
      });
      expect(h.delivered).toHaveLength(0);
    },
  );

  it('waiting-ask → answer 放行且投到该会话', () => {
    const h = ports();
    expect(routeRemoteCommand({ kind: 'answer', answers: ['a'] }, 's-a', h.value)).toEqual({
      ok: true,
    });
    expect(h.delivered).toEqual([
      { sessionId: 's-a', input: { type: 'input', kind: 'answer', answers: ['a'] } },
    ]);
  });

  it('answers 原样透传：空串占位不被过滤、顺序不变（桥层零加工）', () => {
    const h = ports();
    const command: RemoteInputCommand = { kind: 'answer', answers: ['第一问', '', '第三问'] };
    routeRemoteCommand(command, 's-a', h.value);
    // 位次不变量：空串是内核契约的占位符，过滤会让后答错位
    expect(h.delivered[0].input).toEqual({
      type: 'input',
      kind: 'answer',
      answers: ['第一问', '', '第三问'],
    });
  });

  it('重复答复落入 stale_phase（相位跃迁即判据，不另建去重判据）', () => {
    const h = ports();
    expect(routeRemoteCommand({ kind: 'answer', answers: ['a'] }, 's-a', h.value)).toEqual({
      ok: true,
    });
    // 首次答复后，域内 pending 清空 ⇒ 宿主投影相位离开 waiting-ask
    h.state.phase = 'running';
    expect(routeRemoteCommand({ kind: 'answer', answers: ['a'] }, 's-a', h.value)).toEqual({
      ok: false,
      code: 'stale_phase',
    });
    expect(h.delivered).toHaveLength(1);
  });
});

describe('routeRemoteCommand — send / resume 落到同一条 input 路', () => {
  it('idle + send → 放行，input.kind=send 且 text 不 trim', () => {
    const h = ports();
    h.state.phase = 'idle';
    expect(routeRemoteCommand({ kind: 'send', text: '  你好  ' }, 's-a', h.value)).toEqual({
      ok: true,
    });
    expect(h.delivered[0].input).toEqual({ type: 'input', kind: 'send', text: '  你好  ' });
  });

  it('running + send → busy（相位层面拒绝，不投递）', () => {
    const h = ports();
    h.state.phase = 'running';
    expect(routeRemoteCommand({ kind: 'send', text: '继续' }, 's-a', h.value)).toEqual({
      ok: false,
      code: 'busy',
    });
    expect(h.delivered).toHaveLength(0);
  });

  it('waiting-pause + resume → 放行；idle + resume → already_resumed（幂等语义）', () => {
    const h = ports();
    h.state.phase = 'waiting-pause';
    expect(routeRemoteCommand({ kind: 'resume' }, 's-a', h.value)).toEqual({ ok: true });
    expect(h.delivered[0].input).toEqual({ type: 'input', kind: 'resume' });

    const again = ports();
    again.state.phase = 'idle';
    expect(routeRemoteCommand({ kind: 'resume' }, 's-a', again.value)).toEqual({
      ok: false,
      code: 'already_resumed',
    });
    expect(again.delivered).toHaveLength(0);
  });
});
