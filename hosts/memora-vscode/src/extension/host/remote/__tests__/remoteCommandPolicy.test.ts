/**
 * remoteCommandPolicy 单测（R0-a）—— 把准入真值表**逐格钉住**
 *
 * 本文件里的期望表是**独立手写**的（不复用实现里的 TABLE）：
 * 若测试也从实现读表，改错一格测试照样绿，钉住就失效。改实现前先改这里，两处不一致即红。
 */
import { describe, it, expect } from 'vitest';
import type { TurnState } from '../../../../shared/protocol.js';
import {
  REMOTE_COMMAND_CODES,
  REMOTE_COMMANDS,
  REMOTE_PHASES,
  evaluateRemoteCommand,
  evaluateTierGate,
  remotePhaseOf,
  type RemoteCommand,
  type RemoteCommandCode,
  type RemotePhase,
} from '../remoteCommandPolicy.js';
import type { RemoteDeviceTier } from '../remoteDevices.js';

/** 期望表的一格：'allow' 或固定错误码字面量 */
type ExpectedCell = 'allow' | RemoteCommandCode;

/**
 * 期望真值表（手写 · 与实现表逐格独立）
 *
 * 顺序与方案文档 §6.6 的命令清单一致；列顺序 = 本策略定义的五个相位。
 */
const EXPECTED: Record<RemoteCommand, Record<RemotePhase, ExpectedCell>> = {
  send: {
    idle: 'allow',
    running: 'busy',
    'waiting-ask': 'busy',
    'waiting-pause': 'busy',
    'confirm-pending': 'busy',
  },
  interject: {
    idle: 'stale_phase',
    running: 'allow',
    'waiting-ask': 'stale_phase',
    'waiting-pause': 'stale_phase',
    'confirm-pending': 'allow',
  },
  answer: {
    idle: 'stale_phase',
    running: 'stale_phase',
    'waiting-ask': 'allow',
    'waiting-pause': 'stale_phase',
    'confirm-pending': 'stale_phase',
  },
  resume: {
    idle: 'already_resumed',
    running: 'already_resumed',
    'waiting-ask': 'stale_phase',
    'waiting-pause': 'allow',
    'confirm-pending': 'already_resumed',
  },
  pause: {
    idle: 'stale_phase',
    running: 'allow',
    'waiting-ask': 'allow',
    'waiting-pause': 'allow',
    'confirm-pending': 'allow',
  },
  stop: {
    idle: 'allow',
    running: 'allow',
    'waiting-ask': 'allow',
    'waiting-pause': 'allow',
    'confirm-pending': 'allow',
  },
  confirm_answer: {
    idle: 'stale_phase',
    running: 'stale_phase',
    'waiting-ask': 'stale_phase',
    'waiting-pause': 'stale_phase',
    'confirm-pending': 'allow',
  },
  remove_pending_item: {
    idle: 'allow',
    running: 'allow',
    'waiting-ask': 'allow',
    'waiting-pause': 'allow',
    'confirm-pending': 'allow',
  },
  clear_pending_queue: {
    idle: 'allow',
    running: 'allow',
    'waiting-ask': 'allow',
    'waiting-pause': 'allow',
    'confirm-pending': 'allow',
  },
};

/** 固定错误码集合（方案 §6.1 的 cmd 侧六码）——写死期望值，防悄悄增删 */
const EXPECTED_CODES: readonly string[] = [
  'no_session',
  'stale_phase',
  'already_resumed',
  'busy',
  'in_flight',
  // 2026-11-26：权限档不足（§5.9 三档档位拒绝），方案 §6.1 已登记为 ch:'cmd' 的错误码
  'forbidden',
];

describe('remoteCommandPolicy — 错误码固定集合', () => {
  it('常量对象的值与方案文档 §6.1 的 cmd 侧六码逐字一致（不多不少）', () => {
    expect(Object.values(REMOTE_COMMAND_CODES).sort()).toEqual([...EXPECTED_CODES].sort());
  });
});

describe('remoteCommandPolicy — 相位 × 命令 真值表逐格钉住', () => {
  it('行/列全集与方案 §6.5 的命令清单、本策略的相位定义一致', () => {
    expect([...REMOTE_COMMANDS]).toEqual([
      'send',
      'interject',
      'answer',
      'resume',
      'pause',
      'stop',
      'confirm_answer',
      'remove_pending_item',
      'clear_pending_queue',
    ]);
    expect([...REMOTE_PHASES]).toEqual([
      'idle',
      'running',
      'waiting-ask',
      'waiting-pause',
      'confirm-pending',
    ]);
    // 期望表必须覆盖实现表的全部行列（漏一格即穷举不完整，后面逐格断言会静默跳过）
    expect(Object.keys(EXPECTED).sort()).toEqual([...REMOTE_COMMANDS].sort());
    for (const command of REMOTE_COMMANDS) {
      expect(Object.keys(EXPECTED[command]).sort()).toEqual([...REMOTE_PHASES].sort());
    }
  });

  // 逐格断言：9 命令 × 5 相位 = 45 格，一格一条（失败时直接点名哪一格）
  for (const command of REMOTE_COMMANDS) {
    for (const phase of REMOTE_PHASES) {
      const expected = EXPECTED[command][phase];
      it(`${command} @ ${phase} → ${expected}`, () => {
        const decision = evaluateRemoteCommand(command, phase);
        if (expected === 'allow') {
          expect(decision.allow).toBe(true);
          return;
        }
        expect(decision.allow).toBe(false);
        // 拒绝必须带固定码，且不得是调用点自造的字符串
        expect(decision.allow === false && decision.code).toBe(expected);
        expect(EXPECTED_CODES).toContain(decision.allow === false && decision.code);
      });
    }
  }
});

describe('remoteCommandPolicy — 档位 × 命令 准入表逐格钉住', () => {
  /**
   * 期望档位表（手写 · 与实现独立）
   *
   * 依据方案 §5.9：档位累积，approve ⊃ send ⊃ observe。
   * `observe` 只读 ⇒ 一条命令都不许；`send` 管执行控制面与自建内容编辑；
   * `approve` 额外管两类作答（ask / 执行类审批）。
   */
  const EXPECTED_TIER: Record<RemoteDeviceTier, readonly RemoteCommand[]> = {
    observe: [],
    send: [
      'send',
      'interject',
      'pause',
      'stop',
      'resume',
      'remove_pending_item',
      'clear_pending_queue',
    ],
    approve: [
      'send',
      'interject',
      'answer',
      'resume',
      'pause',
      'stop',
      'confirm_answer',
      'remove_pending_item',
      'clear_pending_queue',
    ],
  };

  it('档位全集与设备表的合法集合一致，且期望表覆盖九条命令', () => {
    expect(Object.keys(EXPECTED_TIER).sort()).toEqual(['approve', 'observe', 'send']);
    for (const tier of ['observe', 'send', 'approve'] as const) {
      expect([...EXPECTED_TIER[tier]].sort()).toEqual(
        REMOTE_COMMANDS.filter((command) => EXPECTED_TIER[tier].includes(command)).sort(),
      );
    }
    // 九条命令必须被某个档位覆盖（漏一条 = 该命令永远发不出去）
    const covered = new Set(Object.values(EXPECTED_TIER).flat());
    expect([...covered].sort()).toEqual([...REMOTE_COMMANDS].sort());
  });

  // 3 档 × 9 命令 = 27 格，一格一条
  for (const tier of ['observe', 'send', 'approve'] as const) {
    for (const command of REMOTE_COMMANDS) {
      const allowed = EXPECTED_TIER[tier].includes(command);
      it(`${tier} × ${command} → ${allowed ? 'allow' : 'forbidden'}`, () => {
        const decision = evaluateTierGate(tier, command);
        if (allowed) {
          expect(decision.allow).toBe(true);
          return;
        }
        expect(decision.allow).toBe(false);
        expect(decision.allow === false && decision.code).toBe(REMOTE_COMMAND_CODES.FORBIDDEN);
      });
    }
  }

  it('放行结果复用同一对象（防止调用点以为拿到了可变的第二份判定）', () => {
    expect(evaluateTierGate('approve', 'answer')).toBe(evaluateTierGate('send', 'send'));
  });
});

describe('remoteCommandPolicy — TurnState → 远程相位折算', () => {
  it('idle / settled 都折算为 idle（本表只关心有无进行中的轮次）', () => {
    expect(remotePhaseOf({ phase: 'idle' }, false)).toBe('idle');
    expect(remotePhaseOf({ phase: 'settled', roundId: 'r1', status: 'complete' }, false)).toBe(
      'idle',
    );
  });

  it('running 折算为 running（roundId 有无都不影响相位）', () => {
    expect(remotePhaseOf({ phase: 'running', roundId: 'r1' }, false)).toBe('running');
    expect(remotePhaseOf({ phase: 'running' }, false)).toBe('running');
  });

  it('waiting 按 reason 分列 ask / pause（pausePending 同属 waiting-pause）', () => {
    const ask: TurnState = { phase: 'waiting', reason: 'ask', questions: [] };
    const pause: TurnState = { phase: 'waiting', reason: 'pause' };
    const pausePending: TurnState = { phase: 'waiting', reason: 'pause', pausePending: true };
    expect(remotePhaseOf(ask, false)).toBe('waiting-ask');
    expect(remotePhaseOf(pause, false)).toBe('waiting-pause');
    expect(remotePhaseOf(pausePending, false)).toBe('waiting-pause');
  });

  it('confirmPending 优先级最高：running / waiting-ask 均折算为 confirm-pending', () => {
    // 审批是安全边界：待裁决期间远程只能走 confirm_answer，其余命令按 confirm-pending 列判
    expect(remotePhaseOf({ phase: 'running', roundId: 'r1' }, true)).toBe('confirm-pending');
    expect(remotePhaseOf({ phase: 'waiting', reason: 'ask', questions: [] }, true)).toBe(
      'confirm-pending',
    );
    expect(remotePhaseOf({ phase: 'idle' }, true)).toBe('confirm-pending');
  });
});
