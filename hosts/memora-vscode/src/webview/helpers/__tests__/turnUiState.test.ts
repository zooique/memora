/**
 * 骨架派生层单测（M3b-2b-1）
 *
 * 变异锚点（改坏 → 应转红的用例，逐条标注在对应断言旁）：
 *   M1 `deriveSessionUiState` 的 `waiting` 分支改回 `'thinking'`
 *      → 「waiting(pause) → paused」「waiting(ask) → paused」转红
 *   M2 `derivePausePending` 去掉 `pausePending === true` 判据
 *      → 「申请在途 → true」「已挂起（无 pausePending）→ false」之一转红
 *   M3 `deriveButtonSemantics` 的 `done` 分支 `disabled: !hasInput` 改成 `false`
 *      → 「done + 空输入 → 禁用」转红
 *   M4 `thinking` 分支的 `hasInput` 两支文案互换
 *      → 「thinking + 有输入 → 发送补充」转红
 */

import { describe, expect, it } from 'vitest';
import type { PendingQuestionDto } from '../../../shared/protocol.js';
import {
  deriveButtonSemantics,
  derivePausePending,
  deriveSessionUiState,
  type SessionUiState,
} from '../turnUiState.js';

const QUESTION: PendingQuestionDto = { slot: 'q1', question: '选哪个？' };

describe('deriveSessionUiState（TurnState → 会话 UI 三态）', () => {
  it('running → thinking', () => {
    expect(deriveSessionUiState({ phase: 'running', roundId: 'round-1' })).toBe('thinking');
  });

  it('waiting(pause) → paused', () => {
    // M1 锚点
    expect(deriveSessionUiState({ phase: 'waiting', reason: 'pause' })).toBe('paused');
  });

  it('waiting(ask) → paused（ask 与 pause 同形：宿主同走 pausedOnPurpose）', () => {
    // M1 锚点
    expect(
      deriveSessionUiState({ phase: 'waiting', reason: 'ask', questions: [QUESTION] }),
    ).toBe('paused');
  });

  it('waiting(pause, pausePending) → paused（申请在途也是挂起形态）', () => {
    expect(deriveSessionUiState({ phase: 'waiting', reason: 'pause', pausePending: true })).toBe(
      'paused',
    );
  });

  it('settled → done', () => {
    expect(
      deriveSessionUiState({ phase: 'settled', roundId: 'round-1', status: 'complete' }),
    ).toBe('done');
  });

  it('idle → done（无进行中 turn = 可发送新提问）', () => {
    expect(deriveSessionUiState({ phase: 'idle' })).toBe('done');
  });
});

describe('derivePausePending（TurnState → 申请在途布尔量）', () => {
  it('waiting{pausePending:true} → true', () => {
    // M2 锚点
    expect(derivePausePending({ phase: 'waiting', reason: 'pause', pausePending: true })).toBe(
      true,
    );
  });

  it('waiting(已挂起，无 pausePending) → false', () => {
    // M2 锚点
    expect(derivePausePending({ phase: 'waiting', reason: 'pause' })).toBe(false);
  });

  it('waiting(ask) → false（提问不是暂停申请）', () => {
    expect(
      derivePausePending({ phase: 'waiting', reason: 'ask', questions: [QUESTION] }),
    ).toBe(false);
  });

  it('running / settled / idle → false', () => {
    expect(derivePausePending({ phase: 'running', roundId: 'round-1' })).toBe(false);
    expect(
      derivePausePending({ phase: 'settled', roundId: 'round-1', status: 'interrupted' }),
    ).toBe(false);
    expect(derivePausePending({ phase: 'idle' })).toBe(false);
  });
});

describe('deriveButtonSemantics（按钮语义矩阵）', () => {
  it('thinking + 空输入：暂停可用、发送按钮 = 停止', () => {
    const spec = deriveButtonSemantics({
      sessionUiState: 'thinking',
      pausePending: false,
      hasInput: false,
    });
    expect(spec.pause).toEqual({
      icon: 'pause',
      title: '暂停生成',
      ariaLabel: '暂停生成',
    });
    expect(spec.send).toEqual({
      loading: true,
      title: '停止生成',
      ariaLabel: '停止生成',
      disabled: false,
    });
  });

  it('thinking + 有输入：发送按钮 = 补充排队，暂停按钮仍为 pause', () => {
    // M4 锚点
    const spec = deriveButtonSemantics({
      sessionUiState: 'thinking',
      pausePending: false,
      hasInput: true,
    });
    expect(spec.send).toEqual({
      loading: false,
      title: '发送补充（排队等 step 边界注入）',
      ariaLabel: '发送补充',
      disabled: false,
    });
    expect(spec.pause?.icon).toBe('pause');
  });

  it('thinking + 申请在途：暂停按钮即时切「继续 ▶」可反悔（与输入内容无关）', () => {
    const empty = deriveButtonSemantics({
      sessionUiState: 'thinking',
      pausePending: true,
      hasInput: false,
    });
    const filled = deriveButtonSemantics({
      sessionUiState: 'thinking',
      pausePending: true,
      hasInput: true,
    });
    expect(empty.pause).toEqual({
      icon: 'play',
      title: '继续（点击取消暂停申请）',
      ariaLabel: '继续（取消暂停申请）',
    });
    expect(filled.pause).toEqual(empty.pause);
    // 申请在途不改变发送按钮职责（空=停止，有输入=补充）
    expect(empty.send.loading).toBe(true);
    expect(filled.send.loading).toBe(false);
  });

  it('paused + 空输入：暂停按钮 = 继续生成，发送按钮 = 硬停止', () => {
    const spec = deriveButtonSemantics({
      sessionUiState: 'paused',
      pausePending: false,
      hasInput: false,
    });
    expect(spec.pause).toEqual({ icon: 'play', title: '继续生成', ariaLabel: '继续生成' });
    expect(spec.send).toEqual({
      loading: true,
      title: '停止生成（丢弃检查点）',
      ariaLabel: '停止生成',
      disabled: false,
    });
  });

  it('paused + 有输入：暂停按钮 = 发送补充并继续（一按钮承载续跑+补充）', () => {
    const spec = deriveButtonSemantics({
      sessionUiState: 'paused',
      pausePending: false,
      hasInput: true,
    });
    expect(spec.pause).toEqual({
      icon: 'play',
      title: '发送补充并继续',
      ariaLabel: '发送补充并继续',
    });
  });

  it('done + 空输入：暂停按钮隐藏（null）、发送按钮禁用', () => {
    // M3 锚点
    const spec = deriveButtonSemantics({
      sessionUiState: 'done',
      pausePending: false,
      hasInput: false,
    });
    expect(spec.pause).toBeNull();
    expect(spec.send).toEqual({
      loading: false,
      title: '发送 (Enter)',
      ariaLabel: '发送',
      disabled: true,
    });
  });

  it('done + 有输入：发送按钮启用', () => {
    const spec = deriveButtonSemantics({
      sessionUiState: 'done',
      pausePending: false,
      hasInput: true,
    });
    expect(spec.pause).toBeNull();
    expect(spec.send.disabled).toBe(false);
  });

  it('不变量：disabled 只可能出现在 done + 空输入（其余 11 格恒可用）', () => {
    const states: SessionUiState[] = ['thinking', 'paused', 'done'];
    for (const sessionUiState of states) {
      for (const pausePending of [false, true]) {
        for (const hasInput of [false, true]) {
          const spec = deriveButtonSemantics({ sessionUiState, pausePending, hasInput });
          expect(spec.send.disabled).toBe(sessionUiState === 'done' && !hasInput);
        }
      }
    }
  });
});
