/**
 * 会话状态机单元测试
 *
 * 覆盖 SessionStateMachine 的三态流转逻辑：
 *   1. 合法状态转换（RUNNING ↔ PAUSED、RUNNING → ERROR → RUNNING）
 *   2. 非法转换防护（PAUSED→ERROR、ERROR→PAUSED 等）
 *   3. ERROR 恢复校验（error.recovered + cause 双重校验）
 *   4. pending 暂停请求管理（requestPause / consumePendingPause / cancelPendingPause）
 *   5. 便捷检查方法（canPause / canResume / isError / isPausePending）
 *   6. 强制重置 resetToRunning
 */
import { describe, it, expect } from 'vitest';
import { SessionStateMachine } from '@/agent/sessionStateMachine.js';
import type { SessionCheckpoint, StatusTransition } from '@/agent/types.js';

// ─── 辅助：创建最小检查点 ───────────────────────────

/** 创建带 error 信息的检查点 */
function makeErrorCheckpoint(cause: string, recovered = false): SessionCheckpoint {
  return {
    sessionId: 'test-session',
    schemaVersion: 1,
    status: 'error',
    error: { cause, at: Date.now(), recovered },
    mainGoal: 'test',
    currentGoal: 'test',
    goalChangeSeq: 1,
    plan: [],
    role: { name: 'assistant' },
    standard: { quality: '', constraints: [] },
    lastHeartbeat: Date.now(),
    
  };
}

/** 创建无 error 信息的检查点 */
function makeNoErrorCheckpoint(): SessionCheckpoint {
  return {
    sessionId: 'test-session',
    schemaVersion: 1,
    status: 'running',
    mainGoal: 'test',
    currentGoal: 'test',
    goalChangeSeq: 1,
    plan: [],
    role: { name: 'assistant' },
    standard: { quality: '', constraints: [] },
    lastHeartbeat: Date.now(),
    
  };
}

// ════════════════════════════════════════════════════════
// 1. 初始化
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — 初始化', () => {
  it('默认初始状态为 running', () => {
    const sm = new SessionStateMachine();
    expect(sm.status).toBe('running');
  });

  it('可指定初始状态', () => {
    const sm = new SessionStateMachine('paused');
    expect(sm.status).toBe('paused');
  });

  it('初始为 error 状态时 getter 正确返回', () => {
    const sm = new SessionStateMachine('error');
    expect(sm.status).toBe('error');
    expect(sm.errorInfo).toBeNull(); // 未设置 errorCause
    expect(sm.pauseInfo).toBeNull();
  });
});

// ════════════════════════════════════════════════════════
// 2. 合法状态转换
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — 合法转换', () => {
  it('RUNNING → PAUSED（用户暂停）', () => {
    const sm = new SessionStateMachine();
    const result = sm.pause('需要用户确认', 'user');

    expect(result.allowed).toBe(true);
    expect(result.from).toBe('running');
    expect(result.to).toBe('paused');
    expect(sm.status).toBe('paused');
    expect(sm.pauseInfo).toEqual({ reason: '需要用户确认', source: 'user' });
  });

  it('RUNNING → PAUSED（Agent 暂停）', () => {
    const sm = new SessionStateMachine();
    const result = sm.pause('工具调用等待中', 'agent');

    expect(result.allowed).toBe(true);
    expect(sm.pauseInfo?.source).toBe('agent');
  });

  it('RUNNING → PAUSED（系统暂停）', () => {
    const sm = new SessionStateMachine();
    const result = sm.pause('资源不足', 'system');

    expect(result.allowed).toBe(true);
    expect(sm.pauseInfo?.source).toBe('system');
  });

  it('PAUSED → RUNNING（恢复）', () => {
    const sm = new SessionStateMachine();
    sm.pause('等待用户', 'user');
    const result = sm.resume();

    expect(result.allowed).toBe(true);
    expect(result.from).toBe('paused');
    expect(result.to).toBe('running');
    expect(sm.status).toBe('running');
    expect(sm.pauseInfo).toBeNull(); // 暂停信息已清除
  });

  it('RUNNING → ERROR（触发异常）', () => {
    const sm = new SessionStateMachine();
    const result = sm.triggerError('LLM 超时');

    expect(result.allowed).toBe(true);
    expect(result.from).toBe('running');
    expect(result.to).toBe('error');
    expect(sm.status).toBe('error');
    expect(sm.errorInfo).toBe('LLM 超时');
  });

  it('ERROR → RUNNING（恢复校验通过）', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('LLM 超时');

    const checkpoint = makeErrorCheckpoint('LLM 超时', true);
    const result = sm.recover(checkpoint);

    expect(result.allowed).toBe(true);
    expect(result.from).toBe('error');
    expect(result.to).toBe('running');
    expect(sm.status).toBe('running');
    expect(sm.errorInfo).toBeNull(); // errorCause 已清除
  });

  it('完整生命周期：RUNNING → PAUSED → RUNNING → ERROR → RUNNING', () => {
    const sm = new SessionStateMachine();

    // 暂停
    sm.pause('等待用户', 'user');
    expect(sm.status).toBe('paused');

    // 恢复
    sm.resume();
    expect(sm.status).toBe('running');

    // 异常
    sm.triggerError('连接断开');
    expect(sm.status).toBe('error');

    // 恢复
    sm.recover(makeErrorCheckpoint('连接断开', true));
    expect(sm.status).toBe('running');
  });
});

// ════════════════════════════════════════════════════════
// 3. 非法转换防护
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — 非法转换防护', () => {
  // 3.1 PAUSED 状态下不能 pause（已暂停）
  it('PAUSED 状态下 pause 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.pause('原因', 'user');
    const result = sm.pause('再次暂停', 'user');

    expect(result.allowed).toBe(false);
    expect(result.from).toBe('paused');
    expect(sm.status).toBe('paused'); // 状态不变
    expect(sm.pauseInfo?.reason).toBe('原因'); // 原暂停信息保留
  });

  // 3.2 PAUSED 状态下不能 triggerError
  it('PAUSED 状态下 triggerError 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.pause('暂停中', 'user');
    const result = sm.triggerError('新异常');

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('paused'); // 状态不变
  });

  // 3.3 ERROR 状态下不能 pause
  it('ERROR 状态下 pause 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('异常');
    const result = sm.pause('尝试暂停', 'user');

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('error');
  });

  // 3.4 ERROR 状态下不能 triggerError（叠加防护）
  it('ERROR 状态下 triggerError 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('第一个异常');
    const result = sm.triggerError('第二个异常');

    expect(result.allowed).toBe(false);
    expect(sm.errorInfo).toBe('第一个异常'); // 保留第一个 cause
  });

  // 3.5 PAUSED 状态下不能 recover（已是 running 反向）
  it('RUNNING 状态下 resume 返回不允许', () => {
    const sm = new SessionStateMachine();
    const result = sm.resume();

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('running');
  });

  // 3.6 ERROR 状态下不能 resume
  it('ERROR 状态下 resume 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('异常');
    const result = sm.resume();

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('error');
  });

  // 3.7 RUNNING 状态下不能 recover
  it('RUNNING 状态下 recover 返回不允许', () => {
    const sm = new SessionStateMachine();
    const result = sm.recover(makeNoErrorCheckpoint());

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('running');
  });

  // 3.8 PAUSED 状态下不能 recover
  it('PAUSED 状态下 recover 返回不允许', () => {
    const sm = new SessionStateMachine();
    sm.pause('暂停', 'user');
    const result = sm.recover(makeErrorCheckpoint('x', true));

    expect(result.allowed).toBe(false);
    expect(sm.status).toBe('paused');
  });
});

// ════════════════════════════════════════════════════════
// 4. ERROR 恢复校验（双重校验）
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — ERROR 恢复校验', () => {
  it('error.recovered 为 false 时拒绝恢复', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('LLM 超时');

    const checkpoint = makeErrorCheckpoint('LLM 超时', false);
    const result = sm.recover(checkpoint);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('尚未标记为已恢复');
    expect(sm.status).toBe('error');
  });

  it('error.recovered 为 true 但 cause 为空时拒绝恢复', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('未知错误');

    // 手工构造 cause 为空的检查点
    const checkpoint: SessionCheckpoint = {
      ...makeErrorCheckpoint('x', true),
      error: { cause: '', at: Date.now(), recovered: true },
    };
    const result = sm.recover(checkpoint);

    // 空字符串也是 falsy，应该被拒绝
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('异常原因缺失');
    expect(sm.status).toBe('error');
  });

  it('无 error 字段时拒绝恢复', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('异常');

    // 状态是 error，但检查点无 error 信息（不匹配）
    const checkpoint: SessionCheckpoint = {
      sessionId: 'test',
      schemaVersion: 1,
      status: 'error',
      mainGoal: 'test',
      currentGoal: 'test',
      goalChangeSeq: 1,
      plan: [],
      role: { name: 'assistant' },
      standard: { quality: '', constraints: [] },
      lastHeartbeat: Date.now(),
      
    };
    const result = sm.recover(checkpoint);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('尚未标记为已恢复');
  });

  it('error.recovered 为 true 且 cause 非空时允许恢复', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('LLM 超时');

    const checkpoint = makeErrorCheckpoint('LLM 超时', true);
    const result = sm.recover(checkpoint);

    expect(result.allowed).toBe(true);
    expect(sm.status).toBe('running');
  });
});

// ════════════════════════════════════════════════════════
// 5. pending 暂停请求管理
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — pending 暂停请求', () => {
  it('requestPause 在 RUNNING 状态下注册成功', () => {
    const sm = new SessionStateMachine();
    const ok = sm.requestPause('等待用户输入', 'user');

    expect(ok).toBe(true);
    expect(sm.isPausePending()).toBe(true);
    expect(sm.pendingPauseInfo).toEqual({ reason: '等待用户输入', source: 'user' });
  });

  it('requestPause 在非 RUNNING 状态下拒绝', () => {
    const sm = new SessionStateMachine();
    sm.pause('已暂停', 'user');
    const ok = sm.requestPause('二次请求', 'agent');

    expect(ok).toBe(false);
    expect(sm.isPausePending()).toBe(false);
  });

  it('requestPause 幂等：重复调用返回 false', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('原因', 'user');
    const ok = sm.requestPause('原因2', 'agent');

    expect(ok).toBe(false);
    // 仍保留第一次的原因
    expect(sm.pendingPauseInfo?.reason).toBe('原因');
  });

  it('consumePendingPause 消费并清除 pending', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('原因', 'agent');
    const consumed = sm.consumePendingPause();

    expect(consumed).toEqual({ reason: '原因', source: 'agent' });
    expect(sm.pendingPauseInfo).toBeNull();
    expect(sm.isPausePending()).toBe(false);
  });

  it('consumePendingPause 无 pending 时返回 null', () => {
    const sm = new SessionStateMachine();
    const consumed = sm.consumePendingPause();

    expect(consumed).toBeNull();
  });

  it('cancelPendingPause 清除 pending', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('原因', 'user');
    sm.cancelPendingPause();

    expect(sm.pendingPauseInfo).toBeNull();
    expect(sm.isPausePending()).toBe(false);
  });

  it('cancelPendingPause 无 pending 时不报错', () => {
    const sm = new SessionStateMachine();
    expect(() => sm.cancelPendingPause()).not.toThrow();
  });

  it('消费后可重新 requestPause', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('第一次', 'user');
    sm.consumePendingPause();

    const ok = sm.requestPause('第二次', 'agent');
    expect(ok).toBe(true);
    expect(sm.pendingPauseInfo?.reason).toBe('第二次');
  });

  it('取消后可重新 requestPause', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('第一次', 'user');
    sm.cancelPendingPause();

    const ok = sm.requestPause('第二次', 'system');
    expect(ok).toBe(true);
  });

  it('isPausePending 在暂停后返回 false（状态已变 paused）', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('原因', 'user');
    // 手动消费并直接 pause（模拟 loop 边界消费后立即暂停）
    sm.consumePendingPause();
    sm.pause('原因', 'user');

    // 此时 status=paused，isPausePending 应返回 false
    expect(sm.isPausePending()).toBe(false);
  });

  it('pending 暂停信息默认来源为 user', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('原因'); // 不传 source
    expect(sm.pendingPauseInfo?.source).toBe('user');
  });
});

// ════════════════════════════════════════════════════════
// 6. 便捷检查方法
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — 便捷检查方法', () => {
  it('canPause 仅在 RUNNING 时为 true', () => {
    const sm = new SessionStateMachine();
    expect(sm.canPause()).toBe(true);

    sm.pause('暂停', 'user');
    expect(sm.canPause()).toBe(false);

    sm.resume();
    sm.triggerError('异常');
    expect(sm.canPause()).toBe(false);
  });

  it('canResume 仅在 PAUSED 时为 true', () => {
    const sm = new SessionStateMachine();
    expect(sm.canResume()).toBe(false);

    sm.pause('暂停', 'user');
    expect(sm.canResume()).toBe(true);

    sm.resume();
    expect(sm.canResume()).toBe(false);
  });

  it('isError 仅在 ERROR 时为 true', () => {
    const sm = new SessionStateMachine();
    expect(sm.isError()).toBe(false);

    sm.triggerError('异常');
    expect(sm.isError()).toBe(true);

    sm.recover(makeErrorCheckpoint('异常', true));
    expect(sm.isError()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════
// 7. resetToRunning（强制重置）
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — resetToRunning', () => {
  it('从 PAUSED 强制重置', () => {
    const sm = new SessionStateMachine();
    sm.pause('暂停原因', 'user');
    sm.resetToRunning();

    expect(sm.status).toBe('running');
    expect(sm.pauseInfo).toBeNull();
  });

  it('从 ERROR 强制重置', () => {
    const sm = new SessionStateMachine();
    sm.triggerError('异常原因');
    sm.resetToRunning();

    expect(sm.status).toBe('running');
    expect(sm.errorInfo).toBeNull();
  });

  it('从 RUNNING 重置保持不变', () => {
    const sm = new SessionStateMachine();
    sm.resetToRunning();
    expect(sm.status).toBe('running');
  });

  it('重置后所有 getter 清零', () => {
    const sm = new SessionStateMachine();
    sm.pause('暂停', 'user');
    sm.triggerError('异常'); // 非法但可设状态
    sm.resetToRunning();

    expect(sm.status).toBe('running');
    expect(sm.pauseInfo).toBeNull();
    expect(sm.errorInfo).toBeNull();
    expect(sm.pendingPauseInfo).toBeNull();
  });

  it('T4 收口：pending 在途时 resetToRunning 应清除 pendingPause（突变靶标：删 resetToRunning 内清 pending → 本测试红）', () => {
    const sm = new SessionStateMachine();
    expect(sm.requestPause('申请暂停', 'user')).toBe(true); // 在途申请注册成功（流中场景）
    expect(sm.isPausePending()).toBe(true);

    sm.resetToRunning(); // 强制重置（暂停超时/放弃检查点等清理路径）

    expect(sm.isPausePending()).toBe(false);
    expect(sm.pendingPauseInfo).toBeNull();
  });

  it('T4 收口：resetToRunning 后 requestPause 可再次接受（原残留会让幂等检查永久拒绝，暂停按钮全失效）', () => {
    const sm = new SessionStateMachine();
    sm.requestPause('第一次申请', 'user');
    sm.resetToRunning();
    // 修复前：pendingPauseReason 残留 → 此行返回 false（测试红）
    expect(sm.requestPause('第二次申请', 'user')).toBe(true);
    expect(sm.isPausePending()).toBe(true);
    // 不影响后续正常消费
    expect(sm.consumePendingPause()).toEqual({ reason: '第二次申请', source: 'user' });
    expect(sm.isPausePending()).toBe(false);
  });
});

// ════════════════════════════════════════════════════════
// 8. 返回值结构一致性
// ════════════════════════════════════════════════════════

describe('SessionStateMachine — StatusTransition 返回值', () => {
  it('所有合法转换返回 allowed=true', () => {
    const sm = new SessionStateMachine();

    const transitions: StatusTransition[] = [
      sm.pause('暂停', 'user'),
    ];
    sm.resume();
    transitions.push(sm.resume() as unknown as StatusTransition);

    // 直接 resume 会失败（已在 running），测试 triggerError
    const sm2 = new SessionStateMachine();
    transitions.push(sm2.triggerError('异常'));

    // 所有 allowed=true 的应包含 from/to/reason/allowed
    for (const t of transitions) {
      if (t.allowed) {
        expect(t).toHaveProperty('from');
        expect(t).toHaveProperty('to');
        expect(t).toHaveProperty('reason');
        expect(t).toHaveProperty('allowed');
      }
    }
  });

  it('所有非法转换返回 allowed=false 且包含原状态', () => {
    const sm = new SessionStateMachine();

    // 在 running 上做非法操作
    const invalid1 = sm.resume();
    expect(invalid1.allowed).toBe(false);
    expect(invalid1.from).toBe('running');

    // 在 paused 上做非法操作
    sm.pause('暂停', 'user');
    const invalid2 = sm.triggerError('异常');
    expect(invalid2.allowed).toBe(false);
    expect(invalid2.from).toBe('paused');
  });
});
