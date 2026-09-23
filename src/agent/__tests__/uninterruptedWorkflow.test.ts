/**
 * 不中断工作模型集成测试
 *
 * 覆盖全部核心功能：
 *   - 三态状态机流转（SessionStateMachine）
 *   - 检查点内存态生命周期（SessionManager.createCheckpoint/getCheckpoint/settleCheckpoint；
 *     跨重启恢复链已随 2026-09-10 减法退役）
 *   - 工具幂等性与 outbox 模式（preExecutionCheck / logToolExecution 持久化）
 *   - 补偿机制（compensateTool/compensateAllNonIdempotent 降级后仅日志）
 *   - 执行计划管理（advancePlan/completePlanItem/isPlanAllBlocked）
 *   - 目标版本一致性校验（updateGoal → goalDriftDetected）
 *   - 端到端场景（Agent 门面完整工作流）
 *
 * 设计原则：
 *   - 使用 MockProvider 模拟 LLM，不依赖真实 API
 *   - 使用 tmpdir 做项目根目录，不污染真实 .memora/
 *   - 每个测试独立 tmp 目录
 *   - 遵循现有测试模式和命名规范
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import { BUILTIN_TOOL_IDEMPOTENCY } from '@/agent/builtinTools.js';
import { SessionManager } from '@/agent/managers/sessionManager.js';
import { SessionStateMachine } from '@/agent/sessionStateMachine.js';
import { GoalConsistencyChecker } from '@/agent/managers/goalConsistencyChecker.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import type {
  SessionCheckpoint,
  PlanItem,
  ToolExecutionRecord,
  PreExecutionResult,
} from '@/agent/types.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MockedFunction } from 'vitest';
import type { Round } from '@/memory/roundStore.js';
import { ASK_TIMEOUT_NOTICE } from '@/agent/seed/orchestrator.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider（模拟 LLM 响应，不依赖真实 API）
// ═══════════════════════════════════════════════════════════════

class MockProvider extends LlmProvider {
  readonly name = 'mock';

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const lastUser = [..._messages].reverse().find((m) => m.role === 'user');
    const reply = `Mock 响应：${lastUser?.content ?? '(empty)'}`;
    yield { content: reply };
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/**
 * 写入项目骨架文件，让 init() 能正常加载
 */
function seedProject(_projectPath: string, configDir: string, _dataDir: string): void {
  mkdirSync(join(configDir, 'personas'), { recursive: true });
  mkdirSync(join(configDir, 'rules'), { recursive: true });
  writeFileSync(
    join(configDir, 'personas', 'default.md'),
    '---\nid: persona:default\nsource: persona\nname: 默认人格\nscore: 1\n---\n\n你是一个测试助手。',
    'utf-8',
  );
}

/**
 * 创建 Agent 实例（使用 MockProvider）
 */
function makeAgent(
  projectPath: string,
  configDir: string,
  dataDir: string,
): Agent {
  return new Agent({
    projectPath,
    provider: new MockProvider(),
    configDir,
    dataDir,
    permission: 'owner',
    allowedPaths: [dataDir],
    messages: {
      abortedByUser: '用户取消了对话',
      maxIterationsReached: '\n\n[已达到最大迭代次数]',
      recentConversationLabel: '[最近对话]',
      userLabel: '用户',
      assistantLabel: '助手',
    },
  });
}

/**
 * 创建 Mock MessageHistory
 */
function createMockHistory(overrides: Partial<MessageHistory> = {}): MessageHistory {
  return {
    switchSession: vi.fn().mockReturnValue('2026-08-08-main'),
    forkSession: vi.fn().mockReturnValue({
      newSession: 'main-b1',
      date: '2026-08-08',
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-08-08T10:00:00Z' },
        { role: 'assistant', content: 'hi', timestamp: '2026-08-08T10:00:01Z' },
      ],
    }),
    loadSessionMessages: vi.fn().mockResolvedValue([]),
    currentSessionName: '2026-08-08-main',
    currentDateValue: '2026-08-08',
    currentSessionValue: 'main',
    ...overrides,
  } as unknown as MessageHistory;
}

/**
 * 创建 Mock AgentLoop
 */
function createMockLoop(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    restoreHistory: vi.fn(),
    getMessages: vi.fn().mockReturnValue([
      { role: 'system', content: 'system prompt' },
    ]),
    injectSystemMessage: vi.fn(),
    // 闭环节点锚点（TS-9）：检查点快照/恢复读写，mock 默认空轮
    getCurrentRoundId: vi.fn().mockReturnValue(''),
    setCurrentRoundId: vi.fn(),
    ...overrides,
  } as unknown as AgentLoop;
}

/**
 * 创建 Mock ISessionStore
 */
function createMockSessionStore(overrides: Partial<ISessionStore> = {}): ISessionStore {
  return {
    loadMessages: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as ISessionStore;
}

// ═══════════════════════════════════════════════════════════════
// 测试 1：三态状态机流转（SessionStateMachine）
// ═══════════════════════════════════════════════════════════════

describe('SessionStateMachine · 三态流转', () => {
  let sm: SessionStateMachine;

  beforeEach(() => {
    sm = new SessionStateMachine('running');
  });

  describe('初始状态', () => {
    it('默认初始状态应为 running', () => {
      const sm2 = new SessionStateMachine();
      expect(sm2.status).toBe('running');
    });

    it('构造时可指定初始状态', () => {
      const sm2 = new SessionStateMachine('paused');
      expect(sm2.status).toBe('paused');
    });
  });

  describe('RUNNING → PAUSED（暂停）', () => {
    it('user 来源暂停应成功', () => {
      const result = sm.pause('用户手动暂停', 'user');
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('paused');
      expect(result.reason).toContain('user');
    });

    it('agent 来源暂停应成功', () => {
      const result = sm.pause('需要澄清', 'agent');
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('paused');
      expect(result.reason).toContain('agent');
    });

    it('system 来源暂停应成功', () => {
      const result = sm.pause('系统维护', 'system');
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('paused');
      expect(result.reason).toContain('system');
    });

    it('暂停信息应正确记录 pauseInfo', () => {
      sm.pause('用户手动暂停', 'user');
      const info = sm.pauseInfo;
      expect(info).not.toBeNull();
      expect(info!.reason).toBe('用户手动暂停');
      expect(info!.source).toBe('user');
    });
  });

  describe('PAUSED → RUNNING（恢复）', () => {
    it('恢复应成功', () => {
      sm.pause('测试暂停');
      const result = sm.resume();
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('running');
    });

    it('恢复后 pauseInfo 应清空', () => {
      sm.pause('测试暂停');
      sm.resume();
      expect(sm.pauseInfo).toBeNull();
    });

    it('RUNNING 状态恢复应失败', () => {
      const result = sm.resume();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('仅 PAUSED');
    });

    it('ERROR 状态恢复应失败', () => {
      sm.triggerError('测试错误');
      const result = sm.resume();
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('仅 PAUSED');
    });
  });

  describe('RUNNING → ERROR（触发异常）', () => {
    it('触发异常应成功', () => {
      const result = sm.triggerError('LLM 超时');
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('error');
      expect(sm.errorInfo).toBe('LLM 超时');
    });

    it('PAUSED 状态触发异常应失败', () => {
      sm.pause('测试暂停');
      const result = sm.triggerError('异常');
      expect(result.allowed).toBe(false);
      expect(sm.status).toBe('paused');
      expect(result.reason).toContain('仅 RUNNING');
    });

    it('ERROR 状态叠加触发异常应失败', () => {
      sm.triggerError('错误1');
      const result = sm.triggerError('错误2');
      expect(result.allowed).toBe(false);
      expect(sm.errorInfo).toBe('错误1'); // 保留第一个 cause
    });
  });

  describe('ERROR → RUNNING（异常恢复）', () => {
    it('recovered 标记为 true 时应恢复成功', () => {
      sm.triggerError('LLM 超时');
      const checkpoint: SessionCheckpoint = {
        sessionId: 'test',
        status: 'error',
        error: { cause: 'LLM 超时', at: Date.now(), recovered: true },
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        lastHeartbeat: Date.now(),
      };
      const result = sm.recover(checkpoint);
      expect(result.allowed).toBe(true);
      expect(sm.status).toBe('running');
      expect(sm.errorInfo).toBeNull();
    });

    it('recovered 标记为 false 时应恢复失败', () => {
      sm.triggerError('LLM 超时');
      const checkpoint: SessionCheckpoint = {
        sessionId: 'test',
        status: 'error',
        error: { cause: 'LLM 超时', at: Date.now(), recovered: false },
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        lastHeartbeat: Date.now(),
      };
      const result = sm.recover(checkpoint);
      expect(result.allowed).toBe(false);
      expect(sm.status).toBe('error');
    });

    it('RUNNING 状态恢复应失败', () => {
      const checkpoint: SessionCheckpoint = {
        sessionId: 'test',
        status: 'running',
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        lastHeartbeat: Date.now(),
      };
      const result = sm.recover(checkpoint);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('仅 ERROR');
    });
  });

  describe('工具方法', () => {
    it('canPause 在 RUNNING 时应返回 true', () => {
      expect(sm.canPause()).toBe(true);
      expect(sm.canResume()).toBe(false);
      expect(sm.isError()).toBe(false);
    });

    it('canResume 在 PAUSED 时应返回 true', () => {
      sm.pause('测试');
      expect(sm.canPause()).toBe(false);
      expect(sm.canResume()).toBe(true);
      expect(sm.isError()).toBe(false);
    });

    it('isError 在 ERROR 时应返回 true', () => {
      sm.triggerError('测试');
      expect(sm.canPause()).toBe(false);
      expect(sm.canResume()).toBe(false);
      expect(sm.isError()).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试 2：SessionManager 检查点管理
// ═══════════════════════════════════════════════════════════════

describe('SessionManager · 检查点管理', () => {
  let history: MessageHistory;
  let loop: AgentLoop;
  let sessionStore: ISessionStore | undefined;
  let isChatBusy: MockedFunction<() => boolean>;
  let emitEvent: MockedFunction<(event: string, data: Record<string, unknown>) => void>;
  let manager: SessionManager;

  beforeEach(() => {
    history = createMockHistory();
    loop = createMockLoop();
    sessionStore = createMockSessionStore();
    isChatBusy = vi.fn().mockReturnValue(false);
    emitEvent = vi.fn();
    manager = new SessionManager(
      () => history,
      () => loop,
      sessionStore,
      isChatBusy,
      emitEvent,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createCheckpoint', () => {
    it('应创建包含所有必要字段的检查点', () => {
      const cp = manager.createCheckpoint('测试目标');
      expect(cp).toHaveProperty('sessionId');
      expect(cp).toHaveProperty('status');
      expect(cp).toHaveProperty('mainGoal');
      expect(cp).toHaveProperty('currentGoal');
      expect(cp).toHaveProperty('goalChangeSeq');
      expect(cp).toHaveProperty('plan');
      expect(cp).toHaveProperty('lastHeartbeat');
    });

    it('mainGoal 和 currentGoal 应等于传入值', () => {
      const cp = manager.createCheckpoint('写一个排序函数');
      expect(cp.mainGoal).toBe('写一个排序函数');
      expect(cp.currentGoal).toBe('写一个排序函数');
    });

    it('goalChangeSeq 应从 0 开始', () => {
      const cp = manager.createCheckpoint('测试目标');
      expect(cp.goalChangeSeq).toBe(0);
    });

    it('不传参创建检查点应使用已有值', () => {
      manager.createCheckpoint('初始目标');
      // 第二次创建检查点，不传参，应复用已有值
      const cp = manager.createCheckpoint();
      expect(cp.mainGoal).toBe('初始目标');
    });
  });

  describe('updateGoal', () => {
    it('应更新 currentGoal 并递增 goalChangeSeq', () => {
      manager.createCheckpoint('初始目标');
      manager.updateGoal('新目标');
      const cp = manager.getCheckpoint();
      expect(cp!.currentGoal).toBe('新目标');
      expect(cp!.goalChangeSeq).toBe(1);
    });

    it('目标一致时不应发射 goalDriftDetected 事件', () => {
      manager.createCheckpoint('写一个排序函数');
      manager.updateGoal('写一个排序函数');
      // 相同目标，不应发射漂移事件
      const driftCalls = emitEvent.mock.calls.filter((c) => c[0] === 'goalDriftDetected');
      expect(driftCalls).toHaveLength(0);
    });

    it('目标漂移时应发射 goalDriftDetected 事件', () => {
      manager.createCheckpoint('写一个排序函数，使用快速排序算法');
      manager.updateGoal('改为写一个网页爬虫，抓取新闻标题');
      const driftCalls = emitEvent.mock.calls.filter((c) => c[0] === 'goalDriftDetected');
      expect(driftCalls.length).toBeGreaterThanOrEqual(1);
      const driftData = driftCalls[0]![1] as Record<string, unknown>;
      expect(driftData.level).toBe('drift');
    });
  });

  describe('updatePlan / completePlanItem', () => {
    it('updatePlan 应更新检查点计划', () => {
      manager.createCheckpoint('测试');
      const plan: PlanItem[] = [
        { id: 'step1', description: '步骤1', status: 'pending', order: 0 },
        { id: 'step2', description: '步骤2', status: 'pending', order: 1 },
      ];
      manager.updatePlan(plan);
      expect(manager.getCheckpoint()!.plan).toHaveLength(2);
    });

    it('completePlanItem 应标记步骤为完成并记录 step 推进日志', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
      ]);
      manager.completePlanItem({ planItemId: 's1', summary: '测试 step' });
      const step = manager.getCheckpoint()!.plan[0]!;
      expect(step.status).toBe('done');
      expect(manager.getCheckpoint()!.planItemLog).toHaveLength(1);
      expect(manager.getCheckpoint()!.planItemLog![0]!.summary).toBe('测试 step');
    });

    it('completePlanItem 必须走 updatePlanItemStatus 唯一写点（不得直改 status）', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
      ]);
      // 契约级断言：直接锁住「写点收口」——未来若有人改回 step.status='done' 直改，此测试必红
      const spy = vi.spyOn(
        manager as unknown as { updatePlanItemStatus(id: string, s: string): boolean },
        'updatePlanItemStatus',
      );
      manager.completePlanItem({ planItemId: 's1', summary: '测试 step' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('s1', 'done');
      expect(manager.getCheckpoint()!.plan[0]!.status).toBe('done');
      spy.mockRestore();
    });

    it('无 planItemId 的 completePlanItem 仍记录 step 推进日志（收口不破无步骤路径）', () => {
      manager.createCheckpoint('测试');
      manager.completePlanItem({ summary: '自由对话迭代' });
      const cp = manager.getCheckpoint()!;
      expect(cp.planItemLog).toHaveLength(1);
      expect(cp.planItemLog![0]!.summary).toBe('自由对话迭代');
      // 无 planItemId 时不应触碰 plan 状态
      expect(cp.plan).toHaveLength(0);
    });

    it('isPlanAllBlocked 全 blocked 应返回 true（预判短路收窄拦点）', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'blocked', order: 0 },
        { id: 's2', description: '步骤2', status: 'blocked', order: 1 },
      ]);
      expect(manager.isPlanAllBlocked()).toBe(true);
    });

    it('isPlanAllBlocked 全 done 应返回 false（收窄后放行，继续=AI 产出）', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'done', order: 0 },
      ]);
      expect(manager.isPlanAllBlocked()).toBe(false);
    });

    it('isPlanAllBlocked 空计划应返回 false（普通问答暂停续跑放行）', () => {
      manager.createCheckpoint('测试');
      expect(manager.isPlanAllBlocked()).toBe(false);
    });

    it('getNextPendingStep 应返回下一个 pending 步骤', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'done', order: 0 },
        { id: 's2', description: '步骤2', status: 'pending', order: 1 },
        { id: 's3', description: '步骤3', status: 'pending', order: 2 },
      ]);
      const next = manager.getNextPendingStep();
      expect(next).not.toBeNull();
      expect(next!.id).toBe('s2');
    });

    it('getActiveStep 应返回当前活跃步骤', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
      ]);
      const active = manager.getActiveStep();
      expect(active).not.toBeNull();
      expect(active!.id).toBe('s1');
    });

    });

});

// ═══════════════════════════════════════════════════════════════
// 测试 3：工具幂等性与补偿机制
// ═══════════════════════════════════════════════════════════════

describe('SessionManager · 工具幂等性与补偿机制', () => {
  let history: MessageHistory;
  let loop: AgentLoop;
  let sessionStore: ISessionStore | undefined;
  let isChatBusy: MockedFunction<() => boolean>;
  let emitEvent: MockedFunction<(event: string, data: Record<string, unknown>) => void>;
  let manager: SessionManager;

  beforeEach(() => {
    history = createMockHistory();
    loop = createMockLoop();
    sessionStore = createMockSessionStore();
    isChatBusy = vi.fn().mockReturnValue(false);
    emitEvent = vi.fn();
    manager = new SessionManager(
      () => history,
      () => loop,
      sessionStore,
      isChatBusy,
      emitEvent,
    );
    // 创建检查点，确保 logToolExecution 有写入目标
    manager.createCheckpoint('测试目标');
  });

  describe('logToolExecution 持久化', () => {
    it('logToolExecution 应写入 completedToolCalls 且可被 getCheckpoint 读取', () => {
      const record: ToolExecutionRecord = {
        name: 'read_file',
        argsSignature: '{"path":"test.ts"}',
        executedAt: Date.now(),
        resultSummary: '文件内容',
        ok: true,
        idempotent: 'read-only',
      };
      manager.logToolExecution(record);
      const found = manager.getCheckpoint()?.completedToolCalls?.find(
        (r) => r.name === 'read_file' && r.argsSignature === '{"path":"test.ts"}',
      );
      expect(found).toBeDefined();
      expect(found!.resultSummary).toBe('文件内容');
    });

    it('参数签名不同应视为不同记录', () => {
      manager.logToolExecution({
        name: 'read_file',
        argsSignature: '{"path":"a.ts"}',
        executedAt: Date.now(),
        resultSummary: 'a',
        ok: true,
        idempotent: 'read-only',
      });
      const found = manager.getCheckpoint()?.completedToolCalls?.find(
        (r) => r.name === 'read_file' && r.argsSignature === '{"path":"b.ts"}',
      );
      expect(found).toBeUndefined();
    });
  });

  describe('compensateTool', () => {
    it('应生成包含工具名称的日志描述', () => {
      const record: ToolExecutionRecord = {
        name: 'write_file',
        argsSignature: '{"path":"test.ts"}',
        executedAt: Date.now(),
        resultSummary: '写入成功',
        ok: true,
        idempotent: 'non-idempotent',
      };
      const result = manager.compensateTool(record);
      expect(result).toContain('write_file');
      expect(result).toContain('需人工确认');
    });
  });

  describe('compensateAllNonIdempotent', () => {
    it('无非幂等工具时应返回空数组', () => {
      const results = manager.compensateAllNonIdempotent();
      expect(results).toEqual([]);
    });

    it('有非幂等工具时应返回日志描述列表', () => {
      manager.logToolExecution({
        name: 'read_file',
        argsSignature: '{}',
        executedAt: Date.now(),
        resultSummary: 'ok',
        ok: true,
        idempotent: 'idempotent',
      });
      manager.logToolExecution({
        name: 'write_file',
        argsSignature: '{"path":"a.ts"}',
        executedAt: Date.now(),
        resultSummary: 'ok',
        ok: true,
        idempotent: 'non-idempotent',
      });
      const results = manager.compensateAllNonIdempotent();
      expect(results).toHaveLength(1);
      expect(results[0]).toContain('write_file');
    });

    it('所有非幂等工具都应生成日志（不再检查 compensatedAt）', () => {
      manager.logToolExecution({
        name: 'write_file',
        argsSignature: '{"path":"a.ts"}',
        executedAt: Date.now(),
        resultSummary: 'ok',
        ok: true,
        idempotent: 'non-idempotent',
      });
      // 降级后不再过滤已补偿记录，每次调用都返回所有非幂等工具
      expect(manager.compensateAllNonIdempotent()).toHaveLength(1);
      expect(manager.compensateAllNonIdempotent()).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试 4：SessionManager 暂停/恢复/异常
// ═══════════════════════════════════════════════════════════════

describe('SessionManager · 暂停/恢复/异常', () => {
  let history: MessageHistory;
  let loop: AgentLoop;
  let sessionStore: ISessionStore | undefined;
  let isChatBusy: MockedFunction<() => boolean>;
  let emitEvent: MockedFunction<(event: string, data: Record<string, unknown>) => void>;
  let manager: SessionManager;

  beforeEach(() => {
    history = createMockHistory();
    loop = createMockLoop();
    sessionStore = createMockSessionStore();
    isChatBusy = vi.fn().mockReturnValue(false);
    emitEvent = vi.fn();
    manager = new SessionManager(
      () => history,
      () => loop,
      sessionStore,
      isChatBusy,
      emitEvent,
    );
  });

  describe('pause / resume', () => {
    it('pause 应暂停成功并发射事件', () => {
      const result = manager.pause('用户手动暂停', 'user');
      expect(result).toBe(true);
      expect(manager.status).toBe('paused');
      expect(emitEvent).toHaveBeenCalledWith('sessionPaused', expect.objectContaining({
        reason: '用户手动暂停',
        source: 'user',
      }));
    });

    it('pause 应自动创建检查点', () => {
      manager.pause('测试暂停');
      const cp = manager.getCheckpoint();
      expect(cp).not.toBeNull();
      expect(cp!.status).toBe('paused');
    });

    it('resume 应恢复成功并发射事件', () => {
      manager.pause('测试暂停');
      const result = manager.resume();
      expect(result).toBe(true);
      expect(manager.status).toBe('running');
      expect(emitEvent).toHaveBeenCalledWith('sessionResumed', expect.any(Object));
    });

    it('resume 后检查点状态应更新为 running', () => {
      manager.pause('测试暂停');
      manager.resume();
      const cp = manager.getCheckpoint();
      expect(cp!.status).toBe('running');
    });

    it('RUNNING 状态 resume 应返回 false', () => {
      const result = manager.resume();
      expect(result).toBe(false);
    });

    it('PAUSED 状态 pause 应返回 false', () => {
      manager.pause('测试暂停');
      const result = manager.pause('再次暂停', 'user');
      expect(result).toBe(false);
    });
  });

  describe('triggerError / recover', () => {
    it('triggerError 应触发异常并发射事件', () => {
      const result = manager.triggerError('LLM 超时');
      expect(result).toBe(true);
      expect(manager.status).toBe('error');
      expect(emitEvent).toHaveBeenCalledWith('sessionError', expect.objectContaining({
        cause: 'LLM 超时',
      }));
    });

    it('recover 应恢复成功并发射事件', () => {
      manager.triggerError('LLM 超时');
      // 先标记 recovered
      const cp = manager.getCheckpoint()!;
      cp.error!.recovered = true;
      const result = manager.recover();
      expect(result).toBe(true);
      expect(manager.status).toBe('running');
      expect(emitEvent).toHaveBeenCalledWith('sessionRecovered', expect.any(Object));
    });

    it('recover 未标记 recovered 应自动标记并返回 true', () => {
      manager.triggerError('LLM 超时');
      // SessionManager.recover() 自动标记 recovered=true 后调用 stateMachine.recover()
      const result = manager.recover();
      expect(result).toBe(true); // SessionManager 自动标记 recovered，故返回 true
    });

    it('RUNNING 状态 recover 应返回 false', () => {
      const result = manager.recover();
      expect(result).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试 5：目标一致性校验器（GoalConsistencyChecker）
// ═══════════════════════════════════════════════════════════════

describe('GoalConsistencyChecker · 目标一致性校验', () => {
  let checker: GoalConsistencyChecker;

  beforeEach(() => {
    checker = new GoalConsistencyChecker();
  });

  describe('extractConstraints', () => {
    it('应提取包含"必须"的约束', () => {
      const constraints = checker.extractConstraints('必须使用 TypeScript');
      expect(constraints).toContain('必须使用 TypeScript');
    });

    it('应提取包含"不能"的约束', () => {
      const constraints = checker.extractConstraints('不能使用 any 类型');
      expect(constraints).toContain('不能使用 any 类型');
    });

    it('应提取包含"需要"的约束', () => {
      const constraints = checker.extractConstraints('需要测试覆盖');
      expect(constraints).toContain('需要测试覆盖');
    });

    it('空输入应返回空数组', () => {
      expect(checker.extractConstraints('')).toEqual([]);
    });

    it('无关键词的输入应返回空数组', () => {
      const constraints = checker.extractConstraints('写一个排序函数');
      expect(constraints).toEqual([]);
    });
  });

  describe('checkConsistency', () => {
    it('完全相同目标应返回 same', () => {
      const result = checker.checkConsistency('写一个排序函数', '写一个排序函数');
      expect(result.level).toBe('same');
      expect(result.similarity).toBeGreaterThan(0.7);
    });

    it('目标漂移应返回 drift', () => {
      const result = checker.checkConsistency('写一个排序函数，使用快速排序算法', '改为写一个网页爬虫，抓取新闻标题');
      expect(result.level).toBe('drift');
      expect(result.similarity).toBeLessThan(0.4);
    });

    it('目标有变化但部分相似应返回 confirm', () => {
      const result = checker.checkConsistency(
        '写一个排序函数，必须使用快速排序算法',
        '写一个排序函数，改为使用归并排序算法',
      );
      expect(result.similarity).toBeGreaterThanOrEqual(0.4);
      expect(result.similarity).toBeLessThanOrEqual(0.7);
      expect(result.level).toBe('confirm');
    });

    it('mainGoal 为空时不应抛错', () => {
      const result = checker.checkConsistency('', '新目标');
      // computeSimilarity('', '新目标') 返回 0 → level 为 drift
      expect(result.level).toBe('drift');
      expect(result.similarity).toBe(0);
    });

    it('newGoal 为空时不应抛错', () => {
      const result = checker.checkConsistency('mainGoal', '');
      // computeSimilarity('mainGoal', '') 返回 0 → level 为 drift
      expect(result.level).toBe('drift');
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试 6：Agent 门面集成——不中断工作模型 API
// ═══════════════════════════════════════════════════════════════

describe('Agent 门面 · 不中断工作模型 API', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-uwf-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-uwf-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-uwf-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  describe('pause / resume', () => {
    it('pause 应暂停会话并发射事件', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      const events: string[] = [];
      agent.on('sessionPaused', () => events.push('sessionPaused'));

      const result = agent.pause('测试暂停', 'user');
      expect(result).toBe(true);
      expect(agent.sessionManager!.status).toBe('paused');
      expect(events).toContain('sessionPaused');
    });

    it('resume 应恢复会话并发射事件', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      agent.pause('测试暂停', 'user');

      const events: string[] = [];
      agent.on('sessionResumed', () => events.push('sessionResumed'));

      const result = agent.resume();
      expect(result).toBe(true);
      expect(agent.sessionManager!.status).toBe('running');
      expect(events).toContain('sessionResumed');
    });

    it('未初始化时调用 pause 应抛错', () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      expect(() => agent!.pause('test')).toThrow(/未初始化/);
    });

    it('空闲态（任务已结束）requestPause 守卫：申请作废，不翻 PAUSED 不落检查点（2026-09-07 收紧）', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      // 空闲态：无活跃执行流，isBusy=false → 守卫作废（此前直接翻 PAUSED + 落盘，
      // 会把已完成 turn 钉在 paused，后续新输入被宿主路由成 supplement。任务已结束=申请作废）

      const ok = agent.requestPause('空闲暂停', 'user');
      expect(ok).toBe(false);
      // 守卫不翻状态机（保持 running）、不残留 pending
      expect(agent.sessionManager!.status).toBe('running');
      expect(agent.sessionManager!.isPausePending()).toBe(false);

      // 状态未变无需 resume；再次申请仍作废（无悬挂副本锁死按钮）
      const ok2 = agent.requestPause('再次暂停', 'user');
      expect(ok2).toBe(false);
      expect(agent.sessionManager!.status).toBe('running');
    });

    it('用户主动暂停 lowRisk=true 不计入连续暂停配额（契约保留，改显式 pause 验证）', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(0);

      // 空闲守卫收敛后，用户"暂停已完成任务"不再翻状态机（作废）；
      // 用户主动暂停的 lowRisk 契约本体经显式 pause(lowRisk=true) 验证仍成立
      const ok = agent.pause('空闲暂停', 'user', true);
      expect(ok).toBe(true);
      expect(agent.sessionManager!.status).toBe('paused');
      // 契约：用户主动暂停不消耗连续暂停配额 → 计数保持 0（不挤占 Agent 澄清额度）
      expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(0);
    });
  });

  describe('canContinueWithoutInput（blocked 判据）', () => {
    it('全部 blocked 计划不应视为可续跑', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.getCheckpoint()!.plan.push(
        { id: 's1', description: '步骤1', status: 'blocked', order: 1 },
        { id: 's2', description: '步骤2', status: 'blocked', order: 2 },
      );
      // blocked 步骤不视为可续（仅 pending/active 可续）
      expect(agent.canContinueWithoutInput()).toBe(false);
    });

    it('存在 pending/active 步骤时应视为可续跑（防过度修复）', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.getCheckpoint()!.plan.push(
        { id: 's1', description: '步骤1', status: 'done', order: 1 },
        { id: 's2', description: '步骤2', status: 'pending', order: 2 },
      );
      expect(agent.canContinueWithoutInput()).toBe(true);
    });

    it('全部 done 计划不应视为可续跑', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.getCheckpoint()!.plan.push(
        { id: 's1', description: '步骤1', status: 'done', order: 1 },
      );
      expect(agent.canContinueWithoutInput()).toBe(false);
    });

    it('全 blocked 计划无输入续跑应提示阻塞而非"已完成"', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.getCheckpoint()!.plan.push(
        { id: 's1', description: '步骤1', status: 'blocked', order: 1 },
      );
      // 暂停使 resumeExecution 可进入（状态机需 paused 才继续）
      agent.pause('测试暂停', 'user');

      const chunks: Array<{ type: string; content?: string }> = [];
      for await (const chunk of agent.resumeExecution()) {
        chunks.push(chunk as { type: string; content?: string });
      }
      const text = chunks.filter((c) => c.type === 'text').map((c) => c.content).join('');
      // 全 blocked 计划应提示阻塞而非误报"已完成"
      expect(text).toContain('阻塞');
      expect(text).not.toContain('已完成');
    });

    it('错误态不应展示"继续"（error 守卫）', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.getCheckpoint()!.plan.push(
        { id: 's1', description: '步骤1', status: 'pending', order: 1 },
      );
      // 即便存在可推进的 pending 步骤，error 态也不应诱导用户点"继续"后静默无反应
      agent.triggerError('LLM 超时');
      expect(agent.sessionManager!.status).toBe('error');
      expect(agent.canContinueWithoutInput()).toBe(false);
    });
  });

  describe('triggerError / recover', () => {
    it('triggerError 应触发异常', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      const result = agent.triggerError('LLM 超时');
      expect(result).toBe(true);
      expect(agent.sessionManager!.status).toBe('error');
    });

    it('recover 应从异常恢复', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      agent.triggerError('LLM 超时');
      const cp = agent.getCheckpoint()!;
      cp.error!.recovered = true;

      const result = agent.recover();
      expect(result).toBe(true);
      expect(agent.sessionManager!.status).toBe('running');
    });
  });

  describe('resumeExecution 错误态非静默', () => {
    it('错误态续跑应 yield error chunk 且发射 sessionResumeFailed（非静默）', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      agent.createCheckpoint('测试目标');
      agent.triggerError('LLM 超时');
      expect(agent.sessionManager!.status).toBe('error');

      const events: unknown[] = [];
      agent.on('sessionResumeFailed', (data: unknown) => events.push(data));

      const chunks: Array<{ type: string }> = [];
      for await (const chunk of agent.resumeExecution()) {
        chunks.push(chunk as { type: string });
      }

      // 非静默：必须产出 error chunk 告知用户，状态保持 error（不误翻 running）
      expect(chunks.some((c) => c.type === 'error')).toBe(true);
      expect(agent.sessionManager!.status).toBe('error');
      // 必须通知宿主续跑失败，而非被 `status !== 'paused'` 的静默 return 吞没
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('createCheckpoint / getCheckpoint', () => {
    it('createCheckpoint 应创建检查点', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      const cp = agent.createCheckpoint('测试目标');
      expect(cp).not.toBeNull();
      expect(cp!.mainGoal).toBe('测试目标');
    });

    it('getCheckpoint 应返回当前检查点', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      expect(agent.getCheckpoint()).toBeNull();
      agent.createCheckpoint('测试目标');
      expect(agent.getCheckpoint()).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试 7：端到端场景——完整工作流
// ═══════════════════════════════════════════════════════════════

/**
 * 端到端场景用 Mock ISessionStore
 *
 * 注：原 `createPersistentSessionStore`（检查点持久化）已随跨重启恢复链退役（2026-09-10 减法）
 * 并入通用 `createMockSessionStore`。
 */
function createPersistentSessionStore(): ISessionStore {
  return createMockSessionStore();
}

describe('端到端场景 · 不中断工作模型完整流程', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;
  let sessionStore: ISessionStore;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-e2e-uwf-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-e2e-uwf-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-e2e-uwf-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);

    sessionStore = createPersistentSessionStore();
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  /**
   * 场景 A：暂停 → 恢复 → 继续对话
   *
   * 验证完整闭环：
   *   1. Agent init 后创建检查点
   *   2. 暂停会话（自动保存检查点）
   *   3. 检查检查点状态为 paused
   *   4. 恢复会话
   *   5. 检查检查点状态为 running
   *   6. 继续对话
   */
  it('场景 A：暂停 → 恢复 → 继续对话', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 1. 创建检查点
    const cp = agent.createCheckpoint('编写一个 CLI 工具');
    expect(cp).not.toBeNull();
    expect(cp!.mainGoal).toBe('编写一个 CLI 工具');

    // 2. 暂停会话
    const pauseResult = agent.pause('用户需要休息一下', 'user');
    expect(pauseResult).toBe(true);
    expect(agent.sessionManager!.status).toBe('paused');

    // 3. 检查检查点状态为 paused
    const pausedCp = agent.getCheckpoint();
    expect(pausedCp).not.toBeNull();
    expect(pausedCp!.status).toBe('paused');

    // 4. 恢复会话
    const resumeResult = agent.resume();
    expect(resumeResult).toBe(true);
    expect(agent.sessionManager!.status).toBe('running');

    // 5. 检查检查点状态为 running
    const resumedCp = agent.getCheckpoint();
    expect(resumedCp!.status).toBe('running');

    // 6. 继续对话
    const reply = await agent.chatSync('继续编写 CLI 工具');
    expect(reply).toContain('Mock 响应');
  });

  /**
   * 场景 B：异常 → 标记恢复 → 恢复
   *
   * 验证完整闭环：
   *   1. Agent init 后创建检查点
   *   2. 触发异常（触发 triggerError）
   *   3. 检查检查点 status=error 且 error.cause 存在
   *   4. 标记 error.recovered=true
   *   5. 调用 recover() 恢复
   *   6. 检查检查点 status=running 且 error 已清除
   */
  it('场景 B：异常 → 标记恢复 → 恢复', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 1. 创建检查点
    agent.createCheckpoint('处理文件');

    // 2. 触发异常
    const errorResult = agent.triggerError('LLM 请求超时');
    expect(errorResult).toBe(true);
    expect(agent.sessionManager!.status).toBe('error');

    // 3. 检查检查点状态
    const errorCp = agent.getCheckpoint();
    expect(errorCp).not.toBeNull();
    expect(errorCp!.status).toBe('error');
    expect(errorCp!.error).not.toBeUndefined();
    expect(errorCp!.error!.cause).toBe('LLM 请求超时');
    expect(errorCp!.error!.recovered).toBe(false);

    // 4. 标记异常已恢复
    errorCp!.error!.recovered = true;

    // 5. 恢复
    const recoverResult = agent.recover();
    expect(recoverResult).toBe(true);
    expect(agent.sessionManager!.status).toBe('running');

    // 6. 检查检查点状态
    const recoveredCp = agent.getCheckpoint();
    expect(recoveredCp!.status).toBe('running');
  });

  /**
   * 场景 D：工具执行记录持久化——logToolExecution 写入 completedToolCalls 供恢复排重
   *
   * 验证完整闭环：
   *   1. 模拟工具执行，记录到检查点
   *   2. 记录可被 getCheckpoint 读取（completedToolCalls 持久化）
   *   3. 相同 name+argsSignature 的记录可被定位（恢复时 outbox 排重的数据基础）
   */
  it('场景 D：工具执行记录持久化——logToolExecution 写入 completedToolCalls 供恢复排重', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 创建检查点
    agent.createCheckpoint('测试幂等性');

    // 模拟工具执行记录
    // 通过 sessionManager 的 logToolExecution 记录写工具（幂等键级别，恢复时排重用）
    agent.sessionManager!.logToolExecution({
      name: 'read_file',
      argsSignature: '{"path":"test.ts"}',
      executedAt: Date.now(),
      resultSummary: '文件内容：hello',
      ok: true,
      idempotent: 'read-only',
    });

    // 记录可被 getCheckpoint 读取（outbox 排重的数据基础，替代已删除的 hasToolExecuted）
    const cp = agent.getCheckpoint()!;
    const prevRecord = cp.completedToolCalls?.find(
      (r) => r.name === 'read_file' && r.argsSignature === '{"path":"test.ts"}',
    );
    expect(prevRecord).toBeDefined();
    expect(prevRecord!.resultSummary).toContain('hello');
    // 不同参数签名视为不同记录（排重粒度）
    const otherRecord = cp.completedToolCalls?.find(
      (r) => r.name === 'read_file' && r.argsSignature === '{"path":"other.ts"}',
    );
    expect(otherRecord).toBeUndefined();
  });

  /**
   * 场景 E：task_table_update 更新步骤必须标脏
   *
   * 旧缺陷：updatePlanItem 手写 lastHeartbeat 绕过 touchCheckpoint → checkpointDirty 未置位
   * → 计划状态变更的脏标记永不置位（settleCheckpoint 见脏才清脏，未置脏即静默早退）。
   *
   * 断言策略：直接 spy touchCheckpoint（运行时存在，TS private 仅编译期约束）。
   * 行为级断言（updatePlanItem 后触发 flush 看写盘）不可靠——chatSync 路径存在其他
   * touchCheckpoint（如 updateGoal），会干扰 dirty 的归属，导致变异验证误绿。
   * 契约级断言直接锁定「updatePlanItem 必须走标脏路径」。
   */
  it('场景 E：task_table_update 更新步骤必须标脏', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 创建检查点
    agent.createCheckpoint('测试目标');

    // 模拟已存在的任务表：直接塞一个 pending 步骤
    agent.getCheckpoint()!.plan.push({
      id: 'step-1',
      description: '测试步骤',
      status: 'pending',
      order: 1,
    });

    // spy touchCheckpoint（脏标记唯一置位点）
    const sm = agent.sessionManager!;
    const touchSpy = vi.spyOn(sm as unknown as { touchCheckpoint: () => void }, 'touchCheckpoint');

    // LLM 经 task_table_update 工具将步骤标记为 done
    const result = agent.tools!.planManager!.updatePlanItem('step-1', 'done');
    expect(result).toContain('已标记为 done');
    expect(agent.getCheckpoint()!.plan[0]!.status).toBe('done');

      // updatePlanItem 必须经标脏路径，touchCheckpoint 应被调用
      expect(touchSpy).toHaveBeenCalledTimes(1);
    });

  /**
   * 场景 G：turn 结束无条件清理任务表（任务表收紧为 turn 内能力，不跨 turn 残留）
   *
   * 新契约（2026-09-22）：chat() 流退出（turn 真正结束）时，无论步骤是否全部标记完成，
   * 都清空 checkpoint.plan 与 planItemLog —— 宏任务一个 turn 完不成则兜底丢弃，下个 turn 重新规划。
   * 本用例为端到端回归锁：即使存在 pending 步骤（未全 done），turn 结束后任务表也必须被清理。
   * planItemLog 关联 active 步骤的细节由 assembler.test「onPlanItemBoundary：写入当前 active 步骤的 planItemLog」
   * 直接覆盖（turn 中途观察；本测试跑完整轮后 plan 已被清，无法在 turn 后断言 planItemLog）。
   */
  it('场景 G：turn 结束无条件清理任务表（即使存在 pending 步骤）', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    agent.createCheckpoint('测试目标');
    const planItemId = 'step-active-1';
    agent.getCheckpoint()!.plan.push({
      id: planItemId,
      description: '当前执行步骤',
      status: 'active',
      order: 1,
    });
    // 加一个 pending step：即使 turn 结束未全 done，也必须兜底清空（不跨 turn 残留）
    agent.getCheckpoint()!.plan.push({
      id: 'step-pending-2',
      description: '后续步骤',
      status: 'pending',
      order: 2,
    });

    // 触发一轮对话 → turn 结束时兜底清理任务表
    await agent.chatSync('推进任务');

    // 新契约：turn 结束后任务表已清空（plan 与 planItemLog 均不残留）
    const cp = agent.getCheckpoint()!;
    expect(cp.plan).toHaveLength(0);
    expect(cp.planItemLog ?? []).toHaveLength(0);
  });

  /**
   * 场景 G2（2026-09-22 真实带伤回归锁）：resume 收尾路径漏清 plan。
   *
   * 复现：chat() 第一半以 pause 收场（pauseMeta 挂起、plan 保留）→ 用户点「继续」续跑，
   * 续跑以「含非 done 步、且未再次暂停」结束（如某步 task_table_update 标 blocked/active 后收尾，
   * 属 P3 硬约束允许的正当路径）。旧实现 resumeExecution.finally 走 autoClearPlanIfAllDone
   * （仅全 done 才清）→ plan 残留在 checkpoint → 下一个 chat() 开头无清理 → 真·跨 turn 残留。
   * 修复：resume.finally 改用 clearPlanOnTurnEnd（与 chat() 同构，暂停态 guard 保留、否则无条件清），
   * 两处 turn-end 清理收敛为单一收口点，plan 严格 turn 内、不跨 turn 残留。
   *
   * 突变验证：本用例在修复前的旧代码下 MUST FAIL（plan 残留 length=2），修复后才 PASS——
   * 证明它抓的是真实带伤，而非因错误原因通过。守卫确保走「未重暂停」收尾分支（否则 pauseMeta
   * guard 会保留，断言不成立）。
   */
  it('场景 G2：resume 收尾（非全 done 且未重暂停）无条件清理任务表，不跨 turn 残留', { timeout: 30000 }, async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    agent.createCheckpoint('测试目标');
    // 翻状态机为 paused（与 chat() 第一半 pause 收场等价），使 resumeExecution 可进入
    agent.pause('测试暂停', 'user');
    // 模拟 loop 在暂停时挂起的 pauseMeta（生产由 loop.requestPause 写入；resume() 开头会卸载）
    agent.sessionManager!.setPauseMeta({ reason: '测试暂停', source: 'user' });
    expect(agent.sessionManager!.status).toBe('paused');

    // 模拟 chat() 第一半 pause 收场后残留的 plan（含未完成的 active/pending 步，非全 done）
    agent.getCheckpoint()!.plan.push(
      { id: 'step-active-1', description: '当前执行步骤', status: 'active', order: 1 },
      { id: 'step-pending-2', description: '后续步骤', status: 'pending', order: 2 },
    );

    // 续跑：MockProvider 返回普通文本，不触发再次暂停 → resume 以「非全 done 且未重暂停」结束
    const chunks: Array<{ type: string }> = [];
    for await (const chunk of agent.resumeExecution()) {
      chunks.push(chunk as { type: string });
    }
    // 守卫：确认走的是「未重暂停」收尾分支（若被误判为暂停收场，则本用例未覆盖目标分支，断言无效）
    expect(chunks.some((c) => c.type === 'paused')).toBe(false);
    expect(agent.sessionManager!.status).toBe('running');

    // 核心断言：resume 收尾后任务表已清空（与 chat() 终态同构，不跨 turn 残留）
    const cp = agent.getCheckpoint()!;
    expect(cp.plan).toHaveLength(0);
    expect(cp.planItemLog ?? []).toHaveLength(0);
  });

  /**
   * 场景 F：暂停状态下 chat 自动恢复并继续（双通道模型 v2.0）
   *
   * 验证完整闭环：
   *   1. Agent init 后暂停会话
   *   2. 暂停状态下 chat 不再被拒绝——输入通道永不冻结，
   *      自动恢复工作通道 + 作为补充注入继续执行
   *   3. 状态机已自动恢复为 running
   */
  it('场景 F：暂停状态下 chat 自动恢复并继续（双通道 v2.0）', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 1. 暂停会话
    agent.pause('测试暂停', 'user');

    // 2. 暂停状态下 chat 自动恢复 + 继续（不再拒绝，输入通道永不冻结）
    const reply = await agent.chatSync('你好');
    expect(reply).toContain('Mock 响应');

    // 3. 状态机已自动恢复为 running（工作通道随输入重启）
    expect(agent.getCheckpoint()?.status).toBe('running');
  });

  /**
   * 场景 G：异常状态下 chat 被拒绝
   *
   * 验证完整闭环：
   *   1. Agent init 后触发异常
   *   2. 尝试 chat 应被拒绝
   *   3. 恢复后 chat 应正常
   */
  it('场景 G：异常状态下 chat 被拒绝', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 1. 触发异常
    agent.triggerError('LLM 超时');

    // 2. 异常状态下 chat 应被拒绝
    await expect(agent.chatSync('你好')).rejects.toThrow();

    // 3. 标记恢复并恢复
    const cp = agent.getCheckpoint()!;
    cp.error!.recovered = true;
    agent.recover();

    // 4. 恢复后 chat 应正常
    const reply = await agent.chatSync('继续对话');
    expect(reply).toContain('Mock 响应');
  });

  /**
   * 场景 H：多次暂停-恢复循环
   *
   * 验证完整闭环：
   *   1. Agent init 后创建检查点
   *   2. 暂停 → 恢复 → 暂停 → 恢复（多次循环）
   *   3. 每次循环后检查状态机状态正确
   *   4. 最终可以正常对话
   */
  it('场景 H：多次暂停-恢复循环', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 创建检查点
    agent.createCheckpoint('测试循环暂停恢复');

    // 执行 3 轮暂停-恢复循环
    for (let i = 0; i < 3; i++) {
      const pauseOk = agent.pause(`第 ${i + 1} 次暂停`, 'user');
      expect(pauseOk).toBe(true);
      expect(agent.sessionManager!.status).toBe('paused');

      const resumeOk = agent.resume();
      expect(resumeOk).toBe(true);
      expect(agent.sessionManager!.status).toBe('running');
    }

    // 循环后可以正常对话
    const reply = await agent.chatSync('继续对话');
    expect(reply).toContain('Mock 响应');
  });

  /**
   * 场景 E：补偿机制——非幂等工具恢复时日志（降级后仅日志）
   *
   * 验证降级后行为：
   *   1. 记录非幂等工具执行
   *   2. 通过 compensateAllNonIdempotent 生成日志描述
   *   3. 验证日志描述包含工具名称
   *   4. 不再检查 compensatedAt 标记
   */
  it('场景 E：补偿机制——非幂等工具恢复时日志（降级）', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new MockProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
    });
    await agent.init();

    // 创建检查点
    agent.createCheckpoint('测试补偿机制');

    // 记录非幂等工具执行
    agent.sessionManager!.logToolExecution({
      name: 'write_file',
      argsSignature: '{"path":"test.ts","content":"hello"}',
      executedAt: Date.now(),
      resultSummary: '写入成功',
      ok: true,
      idempotent: 'non-idempotent',
    });

    // 执行补偿（降级后仅日志）
    const compensationResults = agent.sessionManager!.compensateAllNonIdempotent();
    expect(compensationResults).toHaveLength(1);
    expect(compensationResults[0]).toContain('write_file');
    expect(compensationResults[0]).toContain('需人工确认');
  });
});

/**
 * 「工具步 → 工具步 → 纯文本」多轮 Provider
 *
 * 设计要点（对抗式复核，防续跑轮次错位）：
 * - 以「已产出的工具步数」(toolTurnsYielded) 而非「chat 被调用次数」决定再产工具调用。
 *   后处理归档（ArchiveCoordinator）也会调用 provider.chat，若按调用次数计数会被污染，
 *   导致 resume 时轮次错位、无法触发第二次暂停——本用例早期失败的真因即在此。
 * - 文本型 LLM 调用（归档 / 角色匹配等）只产文本，不消耗工具步预算。
 * - 续跑必须至少跨越一次 step 边界才会 yield paused，单轮 MockProvider 无法覆盖该场景。
 */
class ToolThenToolThenTextProvider extends LlmProvider {
  readonly name = 'mock-multi-turn';
  private toolTurnsYielded = 0;

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    // RoundSummaryGenerator（记忆即摘要）在 postProcess 用主 provider 生成摘要——
    // 识别摘要请求并返回有效 JSON，避免消耗主对话工具计数（否则污染后续续跑的 tool_call 序列，
    // 导致 resume 时提前进入文本分支、requestPause 不触发）。
    const sysContent = messages.find((m) => m.role === 'system')?.content;
    if (typeof sysContent === 'string' && sysContent.includes('对话摘要生成器')) {
      yield { content: JSON.stringify({ summary: '测试摘要', type: 'general' }) };
      yield { finishReason: 'stop' };
      return;
    }
    if (this.toolTurnsYielded < 2) {
      this.toolTurnsYielded += 1;
      yield {
        toolCalls: [
          {
            id: `call-${this.toolTurnsYielded}`,
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"probe.txt"}' },
          },
        ],
      };
      yield { finishReason: 'tool_calls' };
      return;
    }
    yield { content: '续跑完成' };
    yield { finishReason: 'stop' };
  }
}

/**
 * 单工具调用后转为文本的 Mock Provider
 *
 * 首轮 LLM 调用返回一次 tool_call（name/args 可配置），后续轮次返回普通文本，
 * 模拟 LLM 在拿到工具结果后继续作答。
 * 用于验证执行前检查三态（放行/跳过/拒绝）对工具结果的影响。
 *
 * RoundSummaryGenerator（记忆即摘要）会用主 provider 生成摘要——识别摘要请求
 * 并返回有效 JSON，避免污染工具轮次计数（与 ToolThenToolThenTextProvider 同策略）。
 */
class SingleToolThenTextProvider extends LlmProvider {
  readonly name = 'mock-single-tool';
  private toolTurnYielded = false;

  constructor(
    private toolName: string,
    private toolArgs: string,
  ) {
    super();
  }

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const sysContent = messages.find((m) => m.role === 'system')?.content;
    if (typeof sysContent === 'string' && sysContent.includes('对话摘要生成器')) {
      yield { content: JSON.stringify({ summary: '测试摘要', type: 'general' }) };
      yield { finishReason: 'stop' };
      return;
    }
    if (!this.toolTurnYielded) {
      this.toolTurnYielded = true;
      yield {
        toolCalls: [
          {
            id: 'call-precheck-1',
            type: 'function',
            function: { name: this.toolName, arguments: this.toolArgs },
          },
        ],
      };
      yield { finishReason: 'tool_calls' };
      return;
    }
    yield { content: '工具结果已处理' };
    yield { finishReason: 'stop' };
  }
}

/**
 * ask_user 主动提问 → 回答 → 续跑 Provider（集成测试专用）
 *
 * 设计要点（对抗式复核）：
 * - 摘要生成器（RoundSummaryGenerator）用主 provider 生成摘要——识别系统标记
 *   '对话摘要生成器' 返回有效 JSON，同时累计 summaryRequestCount 作为「恒 1:1」断言依据。
 * - 主对话按「是否已发出过 ask_user」分岔：首轮调 ask_user 工具挂起等待回答；续跑轮
 *   （上下文含 assistant.tool_calls + 用户回答 tool 结果）正常作答，不再提问。
 * - 记录续跑轮收到的完整消息列表（resumeMessages），供断言续跑上下文含「问题 + 回答」。
 */
class AskThenResumeProvider extends LlmProvider {
  readonly name = 'mock-ask-resume';
  /** 摘要生成请求计数（RoundSummaryGenerator 调用次数 = 已产 round-summary 条数） */
  summaryRequestCount = 0;
  /** 首轮是否已发出 ask_user（分岔：首轮挂起，续跑轮正常作答） */
  private asked = false;
  /** 续跑轮（第二轮主对话）收到的完整消息列表，供断言上下文含问题 + 回答 */
  resumeMessages: Message[] | null = null;

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const sysContent = messages.find((m) => m.role === 'system')?.content;
    // 摘要生成器调用：计数 + 返回有效 JSON（不消耗主对话分岔状态）
    if (typeof sysContent === 'string' && sysContent.includes('对话摘要生成器')) {
      this.summaryRequestCount += 1;
      yield { content: JSON.stringify({ summary: '测试摘要', type: 'general' }) };
      yield { finishReason: 'stop' };
      return;
    }
    // 会话命名助手调用（SessionNamer fire-and-forget，无 system 消息）：返回标题 JSON，
    // 不消耗主对话「是否已 ask_user」分岔状态——否则注入 sessionStore 的测试里
    // 首条消息异步命名会抢先吞掉首次提问（TS-9 集成测试实测差异点）
    const firstUser = messages.find((m) => m.role === 'user')?.content;
    if (typeof firstUser === 'string' && firstUser.startsWith('你是会话命名助手。')) {
      yield { content: JSON.stringify({ title: '测试会话' }) };
      yield { finishReason: 'stop' };
      return;
    }
    if (!this.asked) {
      this.asked = true;
      // 首轮：ask_user 主动提问（工具调用结构完整落地，挂起等用户回答；答后经 answerQuestion 回填）
      yield {
        content: '在读取文件前需要确认：',
        toolCalls: [
          {
            id: 'ask-1',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({
                question: '你想读哪个文件？',
                options: ['probe.txt', 'config.json'],
              }),
            },
          },
        ],
      };
      yield { finishReason: 'stop' };
      return;
    }
    // 续跑轮：上下文应含「assistant.tool_calls(ask_user) + 用户回答 tool 结果」（答案已回填），正常收尾
    this.resumeMessages = messages;
    yield { content: '好的，继续执行。' };
    yield { finishReason: 'stop' };
  }
}

/**
 * plan + ask_user 组合（缝隙 A 防回归，2026-09-07）Provider：
 * - 首轮调 ask_user 工具挂起（在既有 plan 之上提问，不预写任务表——plan 由测试直接
 *   push 进 checkpoint，聚焦「提问迭代与 step 日志归属」的交互语义）；
 * - 续跑轮（上下文含 [ASK_ANSWER] 回答 tool 结果）纯文本收尾（不调工具）——
 *   形态②（PLAN-SYNC-1 ①）下边界只写 planItemLog、不推进：提问步 S1 保持 active 不被自动 done
 *   （若旧码在提问轮已提前 done 步，则续跑轮会错完成下一步 → 转红）。
 * 复用 AskThenResumeProvider 的 summarizer / sessionNamer 分岔守卫（不消耗主对话分岔状态）。
 */
class AskInPlanProvider extends LlmProvider {
  readonly name = 'mock-ask-in-plan';
  /** 首轮是否已发出 ask_user（分岔：首轮挂起，续跑轮纯文本收尾） */
  private asked = false;

  async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    const sysContent = messages.find((m) => m.role === 'system')?.content;
    if (typeof sysContent === 'string' && sysContent.includes('对话摘要生成器')) {
      yield { content: JSON.stringify({ summary: '测试摘要', type: 'general' }) };
      yield { finishReason: 'stop' };
      return;
    }
    const firstUser = messages.find((m) => m.role === 'user')?.content;
    if (typeof firstUser === 'string' && firstUser.startsWith('你是会话命名助手。')) {
      yield { content: JSON.stringify({ title: '测试会话' }) };
      yield { finishReason: 'stop' };
      return;
    }
    if (!this.asked) {
      this.asked = true;
      yield {
        content: '在继续前需要确认：',
        toolCalls: [
          {
            id: 'ask-plan-1',
            type: 'function',
            function: {
              name: 'ask_user',
              arguments: JSON.stringify({ question: '确认继续吗？' }),
            },
          },
        ],
      };
      yield { finishReason: 'stop' };
      return;
    }
    // 续跑轮：纯文本收尾（不调工具）——「提问步」的产出交付，应归当前（提问）步完成
    yield { content: '确认收到，本步工作完成。' };
    yield { finishReason: 'stop' };
  }
}

describe('SSOT 排雷防回归 · 暂停链路', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-ssot-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-ssot-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-ssot-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
    // read_file 探针文件，让内置工具走成功路径（失败亦可，仅需产出 tool_result）
    writeFileSync(join(tmpData, 'probe.txt'), '探针内容', 'utf-8');
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  function makeMultiTurnAgent(): Agent {
    return new Agent({
      projectPath: tmpProject,
      provider: new ToolThenToolThenTextProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      // 关闭自动归档：归档 LLM 调用会污染工具步计数，干扰续跑轮次（见 ToolThenToolThenTextProvider 注释）
      archiveMode: 'manual',
    });
  }

  /** 驱动首轮对话并在工具步后请求暂停，返回是否观察到 paused chunk */
  async function pauseDuringFirstTurn(a: Agent): Promise<boolean> {
    let sawPaused = false;
    for await (const chunk of a.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        a.requestPause('第一次暂停', 'user');
      }
      if (chunk.type === 'paused') sawPaused = true;
    }
    return sawPaused;
  }

  it('D1 回归：流中 requestPause 不立即翻状态机（延迟到 loop 边界挂起才翻）', { timeout: 30000 }, async () => {
    agent = makeMultiTurnAgent();
    await agent.init();

    // 在流进行中（isBusy=true）申请暂停，应走延迟路径：状态机保持 RUNNING，
    // 直到 loop 在 step 边界真正挂起并产出 {type:'paused'} chunk 才翻 PAUSED。
    // 若回归为"申请即暂停"，此处会立即翻 PAUSED，破坏内核事实驱动延迟翻转（D1）。
    let statusRightAfterRequestPause = '';
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        agent.requestPause('流中暂停', 'user');
        statusRightAfterRequestPause = agent.sessionManager!.status;
      }
      if (chunk.type === 'paused') break;
    }

    expect(statusRightAfterRequestPause).toBe('running');
    // 最终由 loop 边界挂起翻转
    expect(agent.sessionManager!.status).toBe('paused');
  });

  it('流中用户暂停（延迟翻转挂起）应透传 lowRisk=true，不计入连续暂停配额', { timeout: 30000 }, async () => {
    agent = makeMultiTurnAgent();
    await agent.init();
    expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(0);

    // 流中（工具步后）用户请求暂停 → 走延迟翻转路径，consumeExecutionStream :1117 真正挂起
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') agent.requestPause('流中暂停', 'user');
      if (chunk.type === 'paused') break;
    }
    expect(agent.sessionManager!.status).toBe('paused');
    // 契约：流中用户暂停与空闲暂停同一 lowRisk 契约（:1117 透传 true），计数保持 0
      expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(0);
    });

    it('首轮无预建 checkpoint 的流中暂停，pauseMeta 必须落到检查点（防静默丢失）', { timeout: 30000 }, async () => {
      agent = makeMultiTurnAgent();
      await agent.init();
      // 关键：不预建 checkpoint，直接走流中暂停路径（真实内核路径，宿主未兜底）。
      // pauseMeta 由暂停收口（consumeExecutionStream）在 pause() 建检查点之后写入，
      // 若「无 checkpoint」时 pauseMeta 静默丢弃，本用例将失败。
      let sawPaused = false;
      for await (const chunk of agent.chat('读取探针文件')) {
        if (chunk.type === 'tool_result') agent.requestPause('首轮流中暂停', 'user');
        if (chunk.type === 'paused') sawPaused = true;
      }
      expect(sawPaused).toBe(true);
      const cp = agent.sessionManager!.getCheckpoint();
      expect(cp).not.toBeNull();
      // 契约：首轮暂停时 pauseMeta 必须已写入，而非静默丢失
      expect(cp!.pauseMeta).toBeDefined();
      expect(cp!.pauseMeta!.reason).toBeDefined();
    });

  it('续跑过程中请求暂停，状态机应翻 paused', { timeout: 30000 }, async () => {
    agent = makeMultiTurnAgent();
    await agent.init();

    expect(await pauseDuringFirstTurn(agent)).toBe(true);
    expect(agent.sessionManager!.status).toBe('paused');

    // 续跑中再次暂停：resumeExecution 必须透传 paused chunk 并同步翻状态机
    let sawPausedOnResume = false;
    for await (const chunk of agent.resumeExecution('续跑：继续读取文件')) {
      if (chunk.type === 'tool_result') agent.requestPause('续跑中第二次暂停', 'user');
      if (chunk.type === 'paused') sawPausedOnResume = true;
    }

    expect(sawPausedOnResume).toBe(true);
    expect(agent.sessionManager!.status).toBe('paused');
  });

  it('续跑中暂停后检查点 status 应同步为 paused（防三方分叉）', { timeout: 30000 }, async () => {
    agent = makeMultiTurnAgent();
    await agent.init();

    await pauseDuringFirstTurn(agent);
    for await (const chunk of agent.resumeExecution('续跑：继续读取文件')) {
      if (chunk.type === 'tool_result') agent.requestPause('续跑中第二次暂停', 'user');
    }

    // pauseMeta 由暂停收口写入，状态机与检查点必须与之一致
    expect(agent.sessionManager!.getCheckpoint()!.status).toBe('paused');
  });

  it('续跑结束后暂停幂等锁应已释放，可再次 requestPause', { timeout: 30000 }, async () => {
    agent = makeMultiTurnAgent();
    await agent.init();

    await pauseDuringFirstTurn(agent);
    for await (const chunk of agent.resumeExecution('续跑：继续读取文件')) {
      if (chunk.type === 'tool_result') agent.requestPause('续跑中第二次暂停', 'user');
    }

    // 幂等锁若未在 finally 释放，此处将永久返回 false（暂停按钮全失效）——
    // 守卫区分：流结束空闲态 requestPause 作废（false）但 isPausePending 无残留、可 resume，
    // 证明非锁残留（2026-09-07 空闲守卫收紧后不再翻 PAUSED）
    agent.resume();
    expect(agent.sessionManager!.isPausePending()).toBe(false);
    expect(agent.sessionManager!.status).toBe('running');
    expect(agent.requestPause('第三次暂停', 'user')).toBe(false);
    expect(agent.sessionManager!.isPausePending()).toBe(false);
  });

  it('流抛出非 abort 错误后，暂停幂等锁仍应释放', { timeout: 30000 }, async () => {
    class ExplodingProvider extends LlmProvider {
      readonly name = 'exploding';
      async *chat(_m: Message[], _o?: ChatOptions): AsyncIterable<LlmChunk> {
        yield { content: '半句话' };
        throw new Error('模拟 LLM provider 崩溃');
      }
    }
    agent = new Agent({
      projectPath: tmpProject,
      provider: new ExplodingProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // 在流进行中设置暂停锁（不预先 requestPause，否则会在 step 边界先翻 PAUSED 而绕开错误路径）。
    // provider 在首句后立即崩溃：此时 handleIteration 仍处于 yield* provider.chat 内部，
    // 下一轮 pauseRequested 检查尚未执行，故状态机停留 running；错误由
    // consumeExecutionStream 的 catch 转为 error chunk，finally 清理挂起的暂停锁。
    // 若清理不在 finally，requestPause 将永久返回 false（暂停按钮全失效）。
    for await (const chunk of agent.chat('触发崩溃')) {
      if (chunk.type === 'text') agent.requestPause('崩溃前暂停', 'user');
    }

    expect(agent.sessionManager!.isPausePending()).toBe(false);
    // 崩溃后空闲态 requestPause 守卫作废（流已结束），但非锁残留（isPausePending 已清空）
    expect(agent.requestPause('崩溃后的暂停', 'user')).toBe(false);
    expect(agent.sessionManager!.isPausePending()).toBe(false);
    expect(agent.sessionManager!.status).toBe('running');
  });

  it('Agent 级集成：ask_user 主动提问 → 暂停不产摘要 → 回答续跑 → 恒 1:1 摘要', { timeout: 30000 }, async () => {
    const askProvider = new AskThenResumeProvider();
    agent = new Agent({
      projectPath: tmpProject,
      provider: askProvider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();

    // ── (a)(b)：首轮 ask_user 主动提问 ─────────────────────────
    const pendingEvents: unknown[] = [];
    agent.on('questionPending', (data: unknown) => pendingEvents.push(data));

    const chunks: Array<{ type: string; content?: string; questions?: unknown }> = [];
    for await (const chunk of agent.chat('帮我读取一个文件')) {
      chunks.push(chunk as { type: string; content?: string; questions?: unknown });
    }

    // 结构化 question_pending 事件发射（宿主可渲染提问 UI）+ 流中 question_pending chunk
    expect(pendingEvents.length).toBe(1);
    expect(chunks.some((c) => c.type === 'question_pending')).toBe(true);
    // 会话进入 PAUSED（主动提问走软暂停，等待用户回答续跑）
    expect(agent.sessionManager!.status).toBe('paused');
    // (a) 工具调用结构完整入史：assistant.tool_calls 含 ask_user（修复前被「撕掉」只剩文本）
    const historyToolCalls = agent
      .getMessages()
      .flatMap((m) => m.toolCalls ?? [])
      .map((tc) => tc.function.name);
    expect(historyToolCalls).toContain('ask_user');
    // 暂停原因/来源落检查点（收口统一写：source='agent'，重启后宿主可展示"为什么暂停 + 问了什么"）
    const pauseMeta = agent.sessionManager!.getCheckpoint()!.pauseMeta;
    expect(pauseMeta).toBeDefined();
    expect(pauseMeta!.source).toBe('agent');
    // (b) 暂停轮不产摘要：回合未完成，摘要推迟到续跑最终轮
    expect(askProvider.summaryRequestCount).toBe(0);

    // ── (c)(d)：回答续跑 → 恒 1:1 摘要 ──────────────────────────
    // 双轨道：answerQuestion 结构化回填 tool 结果 + resumeExecution(回答, 'question-answer')
    // 记录回答为闭环节点交互输入并走完整续跑主流程
    expect(agent.answerQuestion(['我想读 probe.txt'])).toBe(true);
    for await (const chunk of agent.resumeExecution('我想读 probe.txt', undefined, 'question-answer')) {
      chunks.push(chunk as { type: string; content?: string; questions?: unknown });
    }
    expect(agent.sessionManager!.status).toBe('running');

    // (c) 续跑上下文含「问题 + 回答」：LLM 下一轮可见自己问过的工具调用 + 用户回答（tool 结果）
    const resumeToolCalls = (askProvider.resumeMessages ?? [])
      .flatMap((m) => m.toolCalls ?? [])
      .map((tc) => tc.function.name);
    expect(resumeToolCalls).toContain('ask_user');
    const resumeToolResults = (askProvider.resumeMessages ?? [])
      .filter((m) => m.role === 'tool')
      .map((m) => String(m.content))
      .join('\n');
    expect(resumeToolResults).toContain('[ASK_ANSWER] 用户回答：我想读 probe.txt');

    // (d) 续跑最终轮恰好产 1 条 round-summary（恒 1:1：暂停轮 0 + 续跑轮 1）
    await vi.waitFor(() => expect(askProvider.summaryRequestCount).toBe(1), { timeout: 2000 });
  });

  // ─── 缝隙 A（2026-09-07）：plan + ask_user 组合（提问轮不消耗 step）──────────────────
  // 旧缺陷：onPlanItemBoundary（:955）先于 handleToolCalls 的 ask_user 挂起检出触发 → 提问迭代
  // 先把当前 active step 自动 done、推进到下一步，再挂起等答案——回答续跑后问答产出被
  // 归到「下一步」，提问步无继续表达通道（与用户暂停在迭代边界挂起、不推进 step 不对称）。
  // 修复：含 ask_user 将挂起的迭代不触发 step 边界日志（willSuspendForAsk 排除）；
  // 形态②（PLAN-SYNC-1 ①）后 onPlanItemBoundary 本就不推进（唯一写者 = task_table_update），
  // 故问答对恒归当前步；以下两用例为回归锁（突变靶：删除边界排除条件 → 双双转红）。

  it('缝隙 A：提问挂起不消耗当前 step（S1 保持 active、S2 不被提前激活）', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new AskInPlanProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();
    // 预置任务表（仿场景 G 直接 push plan：S1 active + S2 pending）
    agent.createCheckpoint('任务目标');
    agent.getCheckpoint()!.plan.push(
      { id: 'ask-plan-s1', description: '步骤一：读取', status: 'active', order: 1 },
      { id: 'ask-plan-s2', description: '步骤二：汇报', status: 'pending', order: 2 },
    );

    for await (const _chunk of agent.chat('执行任务')) {
      void _chunk; // 仅消费流：首轮 ask_user 提问挂起
    }
    expect(agent.sessionManager!.status).toBe('paused');
    // 提问挂起是 agent 主动软暂停：pauseMeta 落检查点（source='agent'）
    expect(agent.getCheckpoint()!.pauseMeta?.source).toBe('agent');
    const after = agent.getCheckpoint()!.plan;
    // 修复语义：提问步仍 active，下一步未被提前激活（旧码 S1=done/S2=active → 转红）
    expect(after.find((s) => s.id === 'ask-plan-s1')!.status).toBe('active');
    expect(after.find((s) => s.id === 'ask-plan-s2')!.status).toBe('pending');
  });

  it('缝隙 A：回答续跑后 turn 收尾即清空任务表（提问步 pause 时未被自动完成）', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new AskInPlanProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
    });
    await agent.init();
    agent.createCheckpoint('任务目标');
    agent.getCheckpoint()!.plan.push(
      { id: 'ask-plan-s1', description: '步骤一：读取', status: 'active', order: 1 },
      { id: 'ask-plan-s2', description: '步骤二：汇报', status: 'pending', order: 2 },
    );

    for await (const _chunk of agent.chat('执行任务')) {
      void _chunk; // 仅消费流：首轮提问挂起
    }
    expect(agent.sessionManager!.status).toBe('paused');
    // 提问挂起是 agent 主动软暂停：pauseMeta 落检查点（source='agent'）
    expect(agent.getCheckpoint()!.pauseMeta?.source).toBe('agent');
    // pause 时不变量：提问步仍 active、下一步未被提前激活（修复语义，与续跑后清空不冲突）
    const atPause = agent.getCheckpoint()!.plan;
    expect(atPause.find((s) => s.id === 'ask-plan-s1')!.status).toBe('active');
    expect(atPause.find((s) => s.id === 'ask-plan-s2')!.status).toBe('pending');

    // 双轨道（对齐 TS-9）：answerQuestion 回填 + resumeExecution('question-answer') 续跑
    expect(agent.answerQuestion(['确认'])).toBe(true);
    for await (const _chunk of agent.resumeExecution('确认', undefined, 'question-answer')) {
      void _chunk; // 仅消费流：续跑轮纯文本收尾（无工具）
    }
    const cp = agent.getCheckpoint()!;
    // 2026-09-22 闭环修正：resume 收尾 = turn 结束 → 任务表无条件清空（plan 严格 turn 内，
    // 下个 turn 由 LLM 重新规划）。旧实现 autoClearPlanIfAllDone 仅全 done 才清，
    // 导致此处非全 done 残留 → 跨 turn 污染；修正后统一走 clearPlanOnTurnEnd。
    expect(cp.plan).toHaveLength(0);
    expect(cp.planItemLog ?? []).toHaveLength(0);
  });
});

describe('SSOT 排雷防回归 · lowRisk 契约与状态恢复', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-ssot2-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-ssot2-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-ssot2-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  it('Agent.pause 门面必须转发 lowRisk 到 SessionManager（防契约窄化）', async () => {
    // 注释 (:902) 承诺：澄清问题全为低风险时不计入连续暂停计数。
    // 门面窄化会让 lowRisk 从公共 API 静默不可达——若 Agent.pause 丢弃该参数
    // （始终传 false），下方低风险用例将错误地计数，本用例随之失败。
    // 注：结构性 `.length` 断言在此无效（source 形参带默认值，函数 .length 恒为 1），
    // 故以行为断言锁死契约，与下方 lowRisk 计数用例互为表里。
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    const before = agent.sessionManager!.getConsecutivePauseCount();
    agent.pause('低风险澄清', 'agent', true);
    expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(before);
  });

  it('低风险暂停不应计入连续暂停计数', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const before = agent.sessionManager!.getConsecutivePauseCount();
    agent.pause('低风险澄清', 'agent', true);
    expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(before);
  });

  it('高风险暂停仍应计数（防过度修复）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    const before = agent.sessionManager!.getConsecutivePauseCount();
    agent.pause('高风险决策确认', 'agent');
    expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(before + 1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 工具执行前检查三态（统一执行前检查点 · 宿主审批通道）
// ═══════════════════════════════════════════════════════════════

describe('工具执行前检查三态（宿主审批通道）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-precheck-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-precheck-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-precheck-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
    // 探针文件写入项目根（read_file 相对项目根解析）：
    //   probe.txt —— LLM 原始参数指向的文件
    //   rewritten.txt —— 宿主改写参数（overrideArgs）指向的文件（内容可区分，用于证明改写生效）
    writeFileSync(join(tmpProject, 'probe.txt'), '原始文件内容', 'utf-8');
    writeFileSync(join(tmpProject, 'rewritten.txt'), '改写后的文件内容', 'utf-8');
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  /**
   * 驱动单工具对话，返回 tool_result chunks（三态断言的数据源）
   *
   * 经 Agent 门面注入宿主 preExecutionCheck（与内部幂等检查组合为单一检查点），
   * 完整走 chat 流验证三态在真实执行链路上的落地。
   */
  async function runSingleToolChat(
    opts: { preExecutionCheck?: (name: string, args: string) => PreExecutionResult },
    toolName = 'read_file',
    toolArgs = '{"path":"probe.txt"}',
  ): Promise<Array<{ name: string; ok: boolean; summary?: string }>> {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider(toolName, toolArgs),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      // 关闭自动归档：避免归档 LLM 调用污染工具轮次计数
      archiveMode: 'manual',
      preExecutionCheck: opts.preExecutionCheck,
    });
    await agent.init();
    const results: Array<{ name: string; ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ name: chunk.name, ok: chunk.ok, summary: chunk.summary });
      }
    }
    return results;
  }

  it('拒绝：denied=true 阻止工具执行，LLM 收到 PERMISSION_DENIED', { timeout: 30000 }, async () => {
    const results = await runSingleToolChat({
      preExecutionCheck: (name) =>
        name === 'read_file'
          ? { skip: true, denied: true, reason: '只读范围外的文件不可访问' }
          : { skip: false },
    });

    // 单一 tool_result，且为拒绝错误（ok=false，不可重试错误码 + 拒绝原因）
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('read_file');
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.summary).toContain('[ERR:TOOL:PERMISSION_DENIED]');
    expect(results[0]!.summary).toContain('只读范围外的文件不可访问');
  });

  it('跳过：skip=true 不执行工具，LLM 直接拿到已有结果', { timeout: 30000 }, async () => {
    const results = await runSingleToolChat({
      preExecutionCheck: () => ({ skip: true, previousResult: '宿主缓存的已有结果' }),
    });

    // skip 返回的 previousResult 原样透传（ok=true，非错误）
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('宿主缓存的已有结果');
  });

  it('放行+改写参数：skip=false 且 overrideArgs 以改写后的参数执行', { timeout: 30000 }, async () => {
    const results = await runSingleToolChat({
      // 宿主放行，并把路径从 probe.txt 改写为 rewritten.txt
      preExecutionCheck: () => ({ skip: false, overrideArgs: '{"path":"rewritten.txt"}' }),
    });

    // 工具以改写参数实际执行：读到 rewritten.txt 的内容，而非 probe.txt 的内容
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('改写后的文件内容');
    expect(results[0]!.summary).not.toContain('原始文件内容');
  });

  it('组合-拒绝短路：即使工具已执行过（幂等可跳），宿主 denied 仍优先', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider('read_file', '{"path":"probe.txt"}'),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
      preExecutionCheck: () => ({ skip: true, denied: true, reason: '宿主临时禁令' }),
    });
    await agent.init();

    // 预置检查点 + 已完成的幂等工具记录：内部幂等本应跳过，但宿主 denied 必须优先短路
    // （logToolExecution 在 checkpoint 为 null 时静默返回，必须先建检查点）
    agent.createCheckpoint('测试拒绝短路');
    agent.sessionManager!.logToolExecution({
      name: 'read_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '已有记录',
      ok: true,
      idempotent: 'idempotent',
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 拒绝短路幂等：返回 PERMISSION_DENIED 而非 outbox 跳过标记
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.summary).toContain('[ERR:TOOL:PERMISSION_DENIED]');
    expect(results[0]!.summary).toContain('宿主临时禁令');
  });

  it('组合-放行后幂等生效：宿主 skip=false 放行，内部幂等仍按 outbox 语义跳过', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider('write_file', '{"path":"probe.txt"}'),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
      // 宿主纯放行（无改写），是否跳过完全交给内部幂等检查
      preExecutionCheck: () => ({ skip: false }),
    });
    await agent.init();

    // 预置检查点 + 已完成的幂等工具记录（write_file 为 'idempotent-key' 级别，可跳过）
    agent.createCheckpoint('测试放行后幂等');
    agent.sessionManager!.logToolExecution({
      name: 'write_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '幂等上次结果',
      ok: true,
      idempotent: BUILTIN_TOOL_IDEMPOTENCY.write_file,
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('写入探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 宿主放行 → 内部幂等键跳过：outbox 标记 + 上次结果
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('[SKIP:TOOL:IDEMPOTENT]');
    expect(results[0]!.summary).toContain('幂等上次结果');
  });

  it('向后兼容：未注入宿主回调时，内部幂等检查照常工作', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider('write_file', '{"path":"probe.txt"}'),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
      // 不注入 preExecutionCheck：完全降级为现状（仅内部幂等检查）
    });
    await agent.init();

    agent.createCheckpoint('测试向后兼容');
    agent.sessionManager!.logToolExecution({
      name: 'write_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '现状幂等结果',
      ok: true,
      idempotent: BUILTIN_TOOL_IDEMPOTENCY.write_file,
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('写入探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 无宿主回调 → 幂等键照常：outbox 标记 + 上次结果
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('[SKIP:TOOL:IDEMPOTENT]');
    expect(results[0]!.summary).toContain('现状幂等结果');
  });

  it('delete_file 二次闭环不被幂等跳过（目标态可被 write_file 重建 → 跳过会残留临时脚本）', { timeout: 30000 }, async () => {
    // 磁盘预置待清理文件：模拟同会话内第二次「写 → 执行 → 删」闭环时重建的同名临时脚本
    writeFileSync(join(tmpProject, 'probe.txt'), '临时脚本内容', 'utf-8');
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider('delete_file', '{"path":"probe.txt"}'),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
    });
    await agent.init();

    // 预置：上一轮已成功删除过同路径（第一次闭环的执行记录）
    agent.createCheckpoint('测试 delete_file 不跳过');
    agent.sessionManager!.logToolExecution({
      name: 'delete_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '✅ 已删除：probe.txt',
      ok: true,
      idempotent: BUILTIN_TOOL_IDEMPOTENCY.delete_file,
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('清理临时脚本')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 核心：必须真实执行，而非命中 outbox 跳过（跳过会让 LLM 收到假的「已删除」而文件仍在）
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).not.toContain('[SKIP:TOOL:IDEMPOTENT]');
    // 目标态达成：文件确实被删除（闭环不留痕）
    expect(existsSync(join(tmpProject, 'probe.txt'))).toBe(false);
  });

  it('IDM-1 端到端：write→read→write→read 中第二次 read 返回当前内容而非陈旧跳过结果', { timeout: 30000 }, async () => {
    // 序列 Provider：依次发出 write(v1) → read → write(v2) → read，最后文本。
    // 不读消息、仅按步推进——用于构造「同会话内读同一文件且中间被写覆盖」的闭环。
    class SequenceToolProvider extends LlmProvider {
      readonly name = 'mock-seq';
      private steps = [
        { name: 'write_file', args: JSON.stringify({ path: 'data.txt', content: 'v1-初始内容' }) },
        { name: 'read_file', args: JSON.stringify({ path: 'data.txt' }) },
        { name: 'write_file', args: JSON.stringify({ path: 'data.txt', content: 'v2-被覆盖后的最新内容' }) },
        { name: 'read_file', args: JSON.stringify({ path: 'data.txt' }) },
      ];
      private i = 0;

      async *chat(messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
        const sys = messages.find((m) => m.role === 'system')?.content;
        if (typeof sys === 'string' && sys.includes('对话摘要生成器')) {
          yield { content: JSON.stringify({ summary: 'x', type: 'general' }) };
          yield { finishReason: 'stop' };
          return;
        }
        if (this.i < this.steps.length) {
          const s = this.steps[this.i]!;
          this.i += 1;
          yield {
            toolCalls: [{ id: 'c' + this.i, type: 'function', function: { name: s.name, arguments: s.args } }],
          };
          yield { finishReason: 'tool_calls' };
          return;
        }
        yield { content: '完成' };
        yield { finishReason: 'stop' };
      }
    }

    // 预置 v1 在盘（模拟会话开始前文件已存在）
    writeFileSync(join(tmpProject, 'data.txt'), 'v1-初始内容', 'utf-8');
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SequenceToolProvider(),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
    });
    await agent.init();
    agent.createCheckpoint('测试 IDM-1 陈旧读');

    const reads: string[] = [];
    for await (const chunk of agent.chat('开始')) {
      if (chunk.type === 'tool_result' && chunk.name === 'read_file') {
        reads.push(chunk.summary ?? '');
      }
    }

    // 两次 read_file 都必须真实执行（read-only 永不跳过），而非命中首次的陈旧 outbox 缓存：
    //   - 第一次读到 v1（盘上预置内容）
    //   - 第二次读到 v2（中间 write_file 已覆盖）
    // 若 read_file 仍被标为可跳过（IDM-1 未修复），第二次 read 会回喂首次的 v1 摘要 → 本例红。
    expect(reads).toHaveLength(2);
    expect(reads[0]).toContain('v1-初始内容');
    expect(reads[1]).toContain('v2-被覆盖后的最新内容');
    // 磁盘最终态为 v2（write 真实生效、read 未被假跳过）
    expect(existsSync(join(tmpProject, 'data.txt'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// TS-9 · 问答闭环内交互输入归属（提问→补充→续跑 不分裂，含断电优先重启裁决）
// ═══════════════════════════════════════════════════════════════

describe('TS-9 · 问答闭环内交互输入归属（同一闭环节点不分裂）', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;
  // 真实内存 Round Store：闭环节点物理真相源（断言 interactiveInputs 归属的唯一入口）
  let roundStore: InMemoryRoundStore;
  // 真实内存 Session Store：检查点持久化 + roundIds 会话登记（重启复现依赖）
  let sessionStore: InMemorySessionStore;
  // 与 AskThenResumeProvider 同步的提问-续跑 provider（首轮 ask_user 主动提问 → 续跑正常作答）
  let askProvider: AskThenResumeProvider;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-ts9-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-ts9-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-ts9-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
    roundStore = new InMemoryRoundStore();
    sessionStore = new InMemorySessionStore(roundStore);
    askProvider = new AskThenResumeProvider();
  });

  afterEach(async () => {
    if (agent) {
      try {
        await agent.close();
      } catch {
        // 忽略关闭错误
      }
      agent = null;
    }
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
    rmSync(tmpData, { recursive: true, force: true });
  });

  /** 创建注入 roundStore/sessionStore 的 Agent（两者同源关联，round 归属可观测） */
  function makeTs9Agent(): Agent {
    return new Agent({
      projectPath: tmpProject,
      provider: askProvider,
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpData],
      sessionStore,
      roundStore,
      // 关闭自动归档：避免后台摘要/归档 LLM 调用干扰交互时序断言
      archiveMode: 'manual',
    });
  }

  /** 取出当前闭环节点（roundStore 中唯一 Round；不分裂断言的核心判据） */
  function currentClosure(): Round {
    const rounds = roundStore.listAll();
    expect(rounds).toHaveLength(1);
    return rounds[0]!;
  }

  it('主动提问回答 → 流中暂停补充 → 续跑：三类交互输入归属同一闭环节点（round 不分裂）', { timeout: 30000 }, async () => {
    agent = makeTs9Agent();
    await agent.init();

    // ── (1) 首轮：LLM 主动提问（ask_user 工具）→ 暂停，prepare 已分配闭环节点 roundId ──
    for await (const _chunk of agent.chat('帮我读取一个文件')) {
      void _chunk; // 仅消费流，断言看状态机与 RoundStore
    }
    expect(agent.sessionManager!.status).toBe('paused');
    // 闭环节点锚点 = roundStore 唯一 Round 的 id（锚点真理源 = loop.currentRoundId，checkpoint 不存副本）
    const anchorRoundId = currentClosure().id;
    expect(anchorRoundId).toBeTruthy();
    // round 尚未完成（暂停轮不落 ask_user 的 tool 结果段），但闭环节点已建立
    let closure = currentClosure();
    expect(closure.id).toBe(anchorRoundId);

    // ── (2) 用户回答主动提问（answerQuestion 回填 + 带回答续跑）→ 归属同一闭环节点 ──
    expect(agent.answerQuestion(['我想读 probe.txt'])).toBe(true);
    for await (const _chunk of agent.resumeExecution('我想读 probe.txt', undefined, 'question-answer')) {
      void _chunk; // 仅消费流
    }
    expect(agent.sessionManager!.status).toBe('running');
    closure = currentClosure();
    expect(closure.id).toBe(anchorRoundId);
    expect(closure.interactiveInputs).toHaveLength(1);
    expect(closure.interactiveInputs![0]!.kind).toBe('question-answer');
    expect(closure.interactiveInputs![0]!.content).toBe('我想读 probe.txt');
    // G26：提问原文与候选选项随回答落盘（answerQuestion 快照 → runResume → appendUser），回放可还原问答对
    expect(closure.interactiveInputs![0]!.question).toBe('你想读哪个文件？');
    expect(closure.interactiveInputs![0]!.options).toEqual(['probe.txt', 'config.json']);
    // 回答完整落盘：assistantMessage 为续跑最终回答
    expect(closure.status).toBe('complete');
    expect(closure.assistantMessage?.content).toContain('继续执行');

    // ── (3) 用户补充（supplement）→ 归属同一闭环节点 ──
    // 暂停后补充路由前置：模拟「已暂停 → 发补充」——空闲 requestPause 已收敛为作废守卫
    // （2026-09-07，任务结束的暂停申请即作废），此处用显式 pause 构造暂停态
    expect(agent.pause('暂停后补充', 'user', true)).toBe(true);
    expect(agent.sessionManager!.status).toBe('paused');
    for await (const _chunk of agent.resumeExecution('补充：请同时读取测试配置', undefined, 'supplement')) {
      void _chunk; // 仅消费流
    }
    expect(agent.sessionManager!.status).toBe('running');
    closure = currentClosure();
    expect(closure.id).toBe(anchorRoundId);
    expect(closure.interactiveInputs).toHaveLength(2);
    expect(closure.interactiveInputs![1]!.kind).toBe('supplement');
    expect(closure.interactiveInputs![1]!.content).toBe('补充：请同时读取测试配置');

    // (4) 会话登记也只有一个闭环节点（roundIds 不因交互输入新增）
    const sessionId = agent.sessionManager!.getCheckpoint()!.sessionId;
    expect(sessionStore.getRoundIds(sessionId)).toEqual([anchorRoundId]);
    // (5) checkpoint 暂停态收口：回答/pause 硬恢复后 pausedAt 已清除，status 同步 running
    const cp = agent.sessionManager!.getCheckpoint()!;
    expect(cp.status).toBe('running');
    expect(cp).not.toHaveProperty('pausedAt');
  });

  it('断电优先：重启不恢复暂停态，重启后输入新开 turn（原闭环节点不被续写）', { timeout: 30000 }, async () => {
    // ── 第一段：提问 → 回答 → 暂停（闭环节点锚点 = roundStore 唯一 Round）──
    agent = makeTs9Agent();
    await agent.init();
    for await (const _chunk of agent.chat('帮我读取一个文件')) {
      void _chunk; // 仅消费流
    }
    expect(agent.sessionManager!.status).toBe('paused');
    const anchorRoundId = currentClosure().id;
    expect(anchorRoundId).toBeTruthy();
    // 回答主动提问（结构化回填 + 带回答续跑）
    expect(agent.answerQuestion(['我想读 probe.txt'])).toBe(true);
    for await (const _chunk of agent.resumeExecution('我想读 probe.txt', undefined, 'question-answer')) {
      void _chunk; // 仅消费流
    }
    // 暂停态关闭：闭环节点仍锚定同一 Round（roundStore 唯一节点）
    // 显式 pause（空闲 requestPause 已收敛为作废守卫，2026-09-07）
    expect(agent.pause('重启前暂停', 'user', true)).toBe(true);
    expect(currentClosure().id).toBe(anchorRoundId);
    // 原闭环节点此刻：1 条交互输入（question-answer）
    expect(currentClosure().interactiveInputs).toHaveLength(1);
    // 会话标识在重启前取证：减法后重启不再加载持久化检查点，届时无从取 sessionId
    const sessionId = agent.sessionManager!.getCheckpoint()!.sessionId;
    await agent.close();
    agent = null;

    // ── 第二段：重启（新 Agent 实例，同 sessionStore/roundStore）──
    agent = makeTs9Agent();
    await agent.init();

    // 断电优先裁决（2026-09-10）：进程死亡即非自愿中断——重启**不回填 paused**，也不再加载
    // 持久化检查点（自愿介入要求内存态连续，故一律降级为「收场重开」）。
    expect(agent.sessionManager!.status).toBe('running');
    // 减法定案（2026-09-10）：跨重启恢复链整体退役，SessionCheckpoint 降级为同进程内存态
    // → 重启后 **不加载**任何持久化检查点（上下文连续性一律靠 Round 物理记录，不靠检查点）。
    expect(agent.sessionManager!.getCheckpoint()).toBeNull();

    // 重启后输入 → **新开 turn**（不再续写原闭环节点：上下文已不连续，续写会毒化闭环节点语义）
    for await (const _chunk of agent.chat('重启后补充：换个方案')) {
      void _chunk; // 仅消费流
    }
    const rounds = roundStore.listAll();
    expect(rounds).toHaveLength(2); // 原闭环节点 + 新 turn，各自独立
    const original = rounds.find((r) => r.id === anchorRoundId)!;
    // 原闭环节点原样保留：1 条交互输入、question/options 随轮持久化（G26）
    expect(original.interactiveInputs).toHaveLength(1);
    expect(original.interactiveInputs![0]!.question).toBe('你想读哪个文件？');
    expect(original.interactiveInputs![0]!.options).toEqual(['probe.txt', 'config.json']);
    // 新 turn 不携原闭环节点的交互输入（未续写）
    const fresh = rounds.find((r) => r.id !== anchorRoundId)!;
    expect(fresh.interactiveInputs ?? []).toHaveLength(0);
    // 会话登记含原节点 + 新节点（原节点未被替换）
    expect(sessionStore.getRoundIds(sessionId)).toContain(anchorRoundId);
    expect(sessionStore.getRoundIds(sessionId)).toContain(fresh.id);
  });

  it('ask 提问超时未答 → cancelAsk + resumeExecution(timeout)：落「未回答」交互记录（带 question）、LLM 收到 [ASK_ABORTED] 自决、round 不分裂', { timeout: 30000 }, async () => {
    agent = makeTs9Agent();
    await agent.init();

    // ── (1) 首轮：LLM 主动提问（ask_user 工具）→ 暂停 ──
    for await (const _chunk of agent.chat('帮我读取一个文件')) {
      void _chunk;
    }
    expect(agent.sessionManager!.status).toBe('paused');
    const anchorRoundId = currentClosure().id;

    // ── (2) 宿主超时保底（2026-09-08）：cancelAsk（[ASK_ABORTED] 占位 + 快照转存）→ 无输入续跑 ──
    agent.cancelAsk(); // 消费在途提问（注入 [ASK_ABORTED] 占位 + 转存提问快照供落盘）
    agent.cancelAsk(); // 幂等：pendingAsk 已清 → no-op 不抛（重复触发无害）
    for await (const _chunk of agent.resumeExecution(undefined, undefined, 'timeout')) {
      void _chunk;
    }
    expect(agent.sessionManager!.status).toBe('running');

    // ── (3) 落盘断言：kind=timeout + 超时通知正文 + G26 question/options 随记录 ──
    const closure = currentClosure();
    expect(closure.id).toBe(anchorRoundId); // round 不分裂
    expect(closure.interactiveInputs).toHaveLength(1);
    expect(closure.interactiveInputs![0]!.kind).toBe('timeout');
    expect(closure.interactiveInputs![0]!.content).toBe(ASK_TIMEOUT_NOTICE);
    expect(closure.interactiveInputs![0]!.question).toBe('你想读哪个文件？');
    expect(closure.interactiveInputs![0]!.options).toEqual(['probe.txt', 'config.json']);

    // ── (4) LLM 自决依据：续跑轮上下文含 [ASK_ABORTED] 占位 tool result（用户未回答真相，不伪装选择）──
    const resumeMsgs = askProvider.resumeMessages;
    expect(resumeMsgs).not.toBeNull();
    const toolResults = resumeMsgs!.filter((m) => m.role === 'tool');
    const askResult = toolResults.find((m) => String(m.content).includes('[ASK_ABORTED]'));
    expect(askResult).toBeTruthy();
    expect(String(askResult!.content)).toContain('用户未回答该提问');
    // 绝无「用户选择了某选项」的伪造注入
    expect(String(askResult!.content)).not.toContain('[ASK_ANSWER]');
  });
});
