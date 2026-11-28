/**
 * M3 审批裁决路由单测 —— 相位门 + 定址 + answerConfirm 投递
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §6.6（`confirm_answer { requestId, approved }`
 * → `write_confirm_answer` 同一处理函数）、§6.1（`stale_phase` / `no_session`）。
 *
 * 期望全部独立手写，不 import 实现的真值表当期望（两处一起改坏就全绿的陷阱）。
 */
import { describe, expect, it } from 'vitest';
import {
  routeConfirmAnswer,
  type ConfirmAnswerCommand,
  type RemoteConfirmPorts,
} from '../remoteCommandRouter.js';

const CMD: ConfirmAnswerCommand = { kind: 'confirm_answer', requestId: 'req-7', approved: true };

function makePorts(overrides: Partial<RemoteConfirmPorts> = {}): RemoteConfirmPorts {
  return {
    hasSession: (sid) => sid === 's1',
    phaseOf: () => 'confirm-pending',
    answerConfirm: () => true,
    ...overrides,
  };
}

describe('routeConfirmAnswer — M3 审批裁决路由', () => {
  it('confirm-pending 且 requestId 匹配 → 受理，answerConfirm 收到 sid/id/approved', () => {
    const calls: Array<[string, string, boolean]> = [];
    const decision = routeConfirmAnswer(
      CMD,
      's1',
      makePorts({
        answerConfirm: (sid, requestId, approved) => {
          calls.push([sid, requestId, approved]);
          return true;
        },
      }),
    );
    expect(decision).toEqual({ ok: true });
    expect(calls).toEqual([['s1', 'req-7', true]]);
  });

  it('拒绝回执（approved=false）原样透传，不被当成写坏', () => {
    let got: boolean | undefined;
    const decision = routeConfirmAnswer(
      { kind: 'confirm_answer', requestId: 'req-7', approved: false },
      's1',
      makePorts({
        answerConfirm: (_sid, _id, approved) => {
          got = approved;
          return true;
        },
      }),
    );
    expect(decision.ok).toBe(true);
    expect(got).toBe(false);
  });

  it('会话不存在 → no_session，且不调 answerConfirm', () => {
    let called = false;
    const decision = routeConfirmAnswer(
      CMD,
      'unknown',
      makePorts({
        answerConfirm: () => {
          called = true;
          return true;
        },
      }),
    );
    expect(decision).toEqual({ ok: false, code: 'no_session' });
    expect(called).toBe(false);
  });

  it('相位不在 confirm-pending → stale_phase（四相逐一），不调 answerConfirm', () => {
    for (const phase of ['idle', 'running', 'waiting-ask', 'waiting-pause'] as const) {
      let called = false;
      const decision = routeConfirmAnswer(
        CMD,
        's1',
        makePorts({
          phaseOf: () => phase,
          answerConfirm: () => {
            called = true;
            return true;
          },
        }),
      );
      expect(decision, `phase=${phase}`).toEqual({ ok: false, code: 'stale_phase' });
      expect(called, `phase=${phase}`).toBe(false);
    }
  });

  it('requestId 不匹配 / 迟到回执（answerConfirm=false）→ stale_phase', () => {
    const decision = routeConfirmAnswer(CMD, 's1', makePorts({ answerConfirm: () => false }));
    expect(decision).toEqual({ ok: false, code: 'stale_phase' });
  });
});
