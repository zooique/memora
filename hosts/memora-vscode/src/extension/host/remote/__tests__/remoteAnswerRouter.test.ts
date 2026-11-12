/**
 * remoteAnswerRouter 单测（R0-c 的 ask 半边）
 *
 * 钉住三条不变量：
 *  ① 桥层只定址 + 映射错误码：会话不存在 → no_session，相位不符 → stale_phase；
 *  ② 放行时 answers **原样透传**（位次 / 空串 / 长度零加工 —— 加工即第二套判据）；
 *  ③ 重复答复不靠额外去重判据：第一次答复后相位离开 waiting-ask，第二次自然落 stale_phase。
 */
import { describe, it, expect } from 'vitest';
import { routeRemoteAnswer, type RemoteAnswerPorts } from '../remoteAnswerRouter.js';
import type { RemotePhase } from '../remoteCommandPolicy.js';

/** 可变的桩：相位可在用例中途改写，模拟「答复后相位跃迁」 */
function ports(overrides: Partial<RemoteAnswerPorts> = {}) {
  const delivered: Array<{ sessionId: string; answers: readonly string[] }> = [];
  const state = { phase: 'waiting-ask' as RemotePhase, has: true };
  const value = {
    hasSession: (sid: string) => (sid === 's-a' ? state.has : false),
    phaseOf: (sid: string) => (sid === 's-a' ? state.phase : 'idle'),
    deliverAnswer: (sessionId: string, answers: readonly string[]) => {
      delivered.push({ sessionId, answers });
    },
    ...overrides,
  };
  return { value, delivered, state };
}

describe('routeRemoteAnswer — 定址与错误码映射', () => {
  it('会话不存在 → no_session，且不投递', () => {
    const h = ports();
    expect(routeRemoteAnswer('s-missing', ['a'], h.value)).toEqual({
      ok: false,
      code: 'no_session',
    });
    expect(h.delivered).toHaveLength(0);
  });

  it.each<RemotePhase>(['idle', 'running', 'waiting-pause', 'confirm-pending'])(
    '相位 %s → stale_phase，且不投递（裁决在 handleInput，桥层不绕过）',
    (phase) => {
      const h = ports();
      h.state.phase = phase;
      expect(routeRemoteAnswer('s-a', ['a'], h.value)).toEqual({
        ok: false,
        code: 'stale_phase',
      });
      expect(h.delivered).toHaveLength(0);
    },
  );

  it('waiting-ask → ok 且投递到该会话', () => {
    const h = ports();
    expect(routeRemoteAnswer('s-a', ['a'], h.value)).toEqual({ ok: true });
    expect(h.delivered).toEqual([{ sessionId: 's-a', answers: ['a'] }]);
  });

  it('answers 原样透传：空串占位不被过滤、顺序不变、同一引用（桥层零加工）', () => {
    const h = ports();
    const answers = ['第一问', '', '第三问'];
    routeRemoteAnswer('s-a', answers, h.value);
    // 位次不变量：空串是内核契约的占位符，过滤会让后答错位
    expect(h.delivered[0].answers).toEqual(['第一问', '', '第三问']);
    expect(h.delivered[0].answers).toBe(answers);
  });

  it('重复答复落入 stale_phase（相位跃迁即判据，不另建去重判据）', () => {
    const h = ports();
    expect(routeRemoteAnswer('s-a', ['a'], h.value)).toEqual({ ok: true });
    // 首次答复后，域内 pending 清空 ⇒ 宿主投影相位离开 waiting-ask
    h.state.phase = 'running';
    expect(routeRemoteAnswer('s-a', ['a'], h.value)).toEqual({
      ok: false,
      code: 'stale_phase',
    });
    expect(h.delivered).toHaveLength(1);
  });
});
