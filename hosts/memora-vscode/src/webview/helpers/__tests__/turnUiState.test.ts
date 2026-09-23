/**
 * 骨架派生层单测（M3b-2b-1 / 2b-2a）
 *
 * 变异锚点（改坏 → 应转红的用例，逐条标注在对应断言旁）：
 *   M1 `deriveSessionUiState` 的 `waiting` 分支去掉 `pausePending` 判断（恒 'paused'）
 *      → 「申请在途 → thinking」转红（并连坐 chatView 的「申请在途」按钮用例）
 *   M2 `derivePausePending` 去掉 `pausePending === true` 判据
 *      → 「申请在途 → true」「已挂起（无 pausePending）→ false」之一转红
 *   M3 `deriveButtonSemantics` 的 `done` 分支 `disabled: !hasInput` 改成 `false`
 *      → 「done + 空输入 → 禁用」转红
 */

import { describe, expect, it } from 'vitest';
import type { PendingQuestionDto, TurnState } from '../../../shared/protocol.js';
import {
  deriveButtonSemantics,
  derivePausePending,
  deriveSessionUiState,
  skeletonFromTurnState,
  type SessionUiState,
  type SkeletonState,
} from '../turnUiState.js';

const QUESTION: PendingQuestionDto = { slot: 'q1', question: '选哪个？' };

describe('deriveSessionUiState（骨架状态 → 会话 UI 三态）', () => {
  it('running → thinking', () => {
    expect(deriveSessionUiState({ phase: 'running' })).toBe('thinking');
  });

  it('waiting(pause) → paused', () => {
    expect(deriveSessionUiState({ phase: 'waiting', reason: 'pause' })).toBe('paused');
  });

  it('waiting(ask) → paused（ask 与 pause 同形：宿主同走 pausedOnPurpose）', () => {
    expect(deriveSessionUiState({ phase: 'waiting', reason: 'ask' })).toBe('paused');
  });

  it('waiting(pause, pausePending) → thinking（申请在途 = 仍在运行）', () => {
    // M1 锚点：申请在途不是挂起——按钮只把「暂停」切成可反悔的「继续 ▶」，
    // 发送按钮职责不变（若映射 paused，发送文案会变成「停止生成（丢弃检查点）」= 行为变更）
    expect(deriveSessionUiState({ phase: 'waiting', reason: 'pause', pausePending: true })).toBe(
      'thinking',
    );
  });

  it('settled → done', () => {
    expect(deriveSessionUiState({ phase: 'settled' })).toBe('done');
  });

  it('idle → done（无进行中 turn = 可发送新提问）', () => {
    expect(deriveSessionUiState({ phase: 'idle' })).toBe('done');
  });
});

describe('derivePausePending（骨架状态 → 申请在途布尔量）', () => {
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
    expect(derivePausePending({ phase: 'waiting', reason: 'ask' })).toBe(false);
  });

  it('running / settled / idle → false', () => {
    expect(derivePausePending({ phase: 'running' })).toBe(false);
    expect(derivePausePending({ phase: 'settled' })).toBe(false);
    expect(derivePausePending({ phase: 'idle' })).toBe(false);
  });
});

describe('契约守卫：TurnState → SkeletonState 投影兼容（2b-2b 换源前置）', () => {
  it('完整 TurnState 的各分支均可赋值给 SkeletonState，且派生结果一致', () => {
    // 编译期守卫：若给 SkeletonState 的分支加了 TurnState 没有的必填字段，此处 tsc 报错
    const waiting: TurnState = {
      phase: 'waiting',
      reason: 'ask',
      questions: [QUESTION],
    };
    const running: TurnState = { phase: 'running', roundId: 'round-1' };
    const settled: TurnState = { phase: 'settled', roundId: 'round-1', status: 'complete' };
    const cases: [TurnState, SessionUiState][] = [
      [waiting, 'paused'],
      [running, 'thinking'],
      [settled, 'done'],
      [{ phase: 'idle' }, 'done'],
    ];
    for (const [full, expected] of cases) {
      const projected: SkeletonState = full; // 投影赋值（结构化类型，无断言）
      expect(deriveSessionUiState(projected)).toBe(expected);
    }
  });
});

describe('换真源：skeletonFromTurnState（TurnState 快照 → 容器，M3b-2b-2b）', () => {
  // 变异锚点（改坏 → 转红）：
  //   M6 把 idle 误判为 settled / running → 「idle → idle」转红
  //   M7 剥字段失败（如 running 残留 roundId、waiting 残 questions）→ toEqual 严格转红
  //   M8 丢 pausePending → 「申请在途」转红
  it('idle → idle', () => {
    expect(skeletonFromTurnState({ phase: 'idle' })).toEqual({ phase: 'idle' });
  });

  it('running（roundId 缺省——流起始投影）→ running', () => {
    // 2b-2b：宿主流起始投影 roundId 尚不可知，缺省如实（不造假占位）
    expect(skeletonFromTurnState({ phase: 'running' })).toEqual({ phase: 'running' });
  });

  it('running（带 roundId）→ running，剥掉骨架不消费的 roundId（M7 锚点）', () => {
    expect(skeletonFromTurnState({ phase: 'running', roundId: 'round-9' })).toEqual({
      phase: 'running',
    });
  });

  it('waiting(ask) → waiting(ask)，剥 questions（骨架不消费提问明细）', () => {
    expect(skeletonFromTurnState({ phase: 'waiting', reason: 'ask', questions: [QUESTION] })).toEqual(
      { phase: 'waiting', reason: 'ask' },
    );
  });

  it('waiting(pause) 无 pausePending → 原样（已挂起非申请在途）', () => {
    expect(skeletonFromTurnState({ phase: 'waiting', reason: 'pause' })).toEqual({
      phase: 'waiting',
      reason: 'pause',
    });
  });

  it('waiting(pause, pausePending) → 申请在途保留（M8 锚点）', () => {
    expect(
      skeletonFromTurnState({ phase: 'waiting', reason: 'pause', pausePending: true }),
    ).toEqual({ phase: 'waiting', reason: 'pause', pausePending: true });
  });

  it('settled（带 roundId/status）→ settled，剥投影外字段（M7 锚点）', () => {
    expect(
      skeletonFromTurnState({ phase: 'settled', roundId: 'round-1', status: 'complete' }),
    ).toEqual({ phase: 'settled' });
  });

  it('投影输出落入派生链不变量：deriveSessionUiState 全分支收敛（三态闭合）', () => {
    // skeletonFromTurnState 的输出**必须**能被既有派生链消费——换源不改派生判据
    const inputs: TurnState[] = [
      { phase: 'idle' },
      { phase: 'running' },
      { phase: 'waiting', reason: 'ask', questions: [QUESTION] },
      { phase: 'waiting', reason: 'pause' },
      { phase: 'waiting', reason: 'pause', pausePending: true },
      { phase: 'settled', roundId: 'round-1', status: 'complete' },
    ];
    const expected: SessionUiState[] = ['done', 'thinking', 'paused', 'paused', 'thinking', 'done'];
    inputs.forEach((full, i) => {
      expect(deriveSessionUiState(skeletonFromTurnState(full))).toBe(expected[i]);
    });
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
    // 申请在途不改变发送按钮职责（空=停止，有输入=补充）——与挂起态文案不同
    expect(empty.send.title).toBe('停止生成');
    expect(filled.send.title).toBe('发送补充（排队等 step 边界注入）');
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
