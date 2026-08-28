/**
 * 不中断工作模型集成测试
 *
 * 覆盖全部核心功能：
 *   - 三态状态机流转（SessionStateMachine）
 *   - 检查点快照与恢复（SessionManager.createCheckpoint/restoreFromCheckpoint）
 *   - 工具幂等性与 outbox 模式（preExecutionCheck/hasToolExecuted）
 *   - 补偿机制（compensateTool/compensateAllNonIdempotent 降级后仅日志）
 *   - 执行计划管理（advancePlan/completeStep/isPlanStalled）
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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@/agent/agent.js';
import { SessionManager } from '@/agent/managers/sessionManager.js';
import { SessionStateMachine } from '@/agent/sessionStateMachine.js';
import { GoalConsistencyChecker } from '@/agent/managers/goalConsistencyChecker.js';
import { LlmProvider } from '@/llm/provider.js';
import { logger } from '@/logging/logger.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type {
  SessionCheckpoint,
  PlanStep,
  ToolExecutionRecord,
  PreExecutionResult,
} from '@/agent/types.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MockedFunction } from 'vitest';

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
    ...overrides,
  } as unknown as AgentLoop;
}

/**
 * 创建 Mock ISessionStore（支持检查点持久化）
 */
function createMockSessionStore(overrides: Partial<ISessionStore> = {}): ISessionStore {
  const store = new Map<string, string>();
  return {
    appendMessage: vi.fn(),
    loadMessages: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    saveCheckpoint: vi.fn((sessionId: string, json: string) => {
      store.set(sessionId, json);
    }),
    loadCheckpoint: vi.fn((sessionId: string) => {
      return store.get(sessionId) ?? null;
    }),
    deleteCheckpoint: vi.fn((sessionId: string) => {
      store.delete(sessionId);
    }),
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
        schemaVersion: 1,
        status: 'error',
        error: { cause: 'LLM 超时', at: Date.now(), recovered: true },
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
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
        schemaVersion: 1,
        status: 'error',
        error: { cause: 'LLM 超时', at: Date.now(), recovered: false },
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };
      const result = sm.recover(checkpoint);
      expect(result.allowed).toBe(false);
      expect(sm.status).toBe('error');
    });

    it('RUNNING 状态恢复应失败', () => {
      const checkpoint: SessionCheckpoint = {
        sessionId: 'test',
        schemaVersion: 1,
        status: 'running',
        mainGoal: 'test',
        currentGoal: 'test',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
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
      const cp = manager.createCheckpoint('测试目标', { name: 'developer' }, { quality: '高质量', constraints: ['无bug'] });
      expect(cp).toHaveProperty('sessionId');
      expect(cp).toHaveProperty('status');
      expect(cp).toHaveProperty('mainGoal');
      expect(cp).toHaveProperty('currentGoal');
      expect(cp).toHaveProperty('goalChangeSeq');
      expect(cp).toHaveProperty('plan');
      expect(cp).toHaveProperty('role');
      expect(cp).toHaveProperty('standard');
      expect(cp).toHaveProperty('resource');
      expect(cp).toHaveProperty('hotMemory');
      expect(cp).toHaveProperty('lastHeartbeat');
    });

    it('mainGoal 和 currentGoal 应等于传入值', () => {
      const cp = manager.createCheckpoint('写一个排序函数');
      expect(cp.mainGoal).toBe('写一个排序函数');
      expect(cp.currentGoal).toBe('写一个排序函数');
    });

    it('role 和 standard 应正确设置', () => {
      const cp = manager.createCheckpoint('测试', { name: 'reviewer', description: '代码审查' }, { quality: '无bug', constraints: ['ESLint 通过'] });
      expect(cp.role.name).toBe('reviewer');
      expect(cp.role.description).toBe('代码审查');
      expect(cp.standard.quality).toBe('无bug');
      expect(cp.standard.constraints).toContain('ESLint 通过');
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

    it('应发射 goalUpdated 事件', () => {
      manager.createCheckpoint('初始目标');
      manager.updateGoal('新目标');
      expect(emitEvent).toHaveBeenCalledWith('goalUpdated', expect.objectContaining({
        newGoal: '新目标',
        goalChangeSeq: 1,
      }));
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

  describe('updatePlan / completeRound', () => {
    it('updatePlan 应更新检查点计划', () => {
      manager.createCheckpoint('测试');
      const plan: PlanStep[] = [
        { id: 'step1', description: '步骤1', status: 'pending', order: 0 },
        { id: 'step2', description: '步骤2', status: 'pending', order: 1 },
      ];
      manager.updatePlan(plan);
      expect(manager.getCheckpoint()!.plan).toHaveLength(2);
    });

    it('completeRound 应标记步骤为完成并记录回合日志', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
      ]);
      manager.completeRound({ stepId: 's1', summary: '测试回合' });
      const step = manager.getCheckpoint()!.plan[0]!;
      expect(step.status).toBe('done');
      expect(manager.getCheckpoint()!.roundLog).toHaveLength(1);
      expect(manager.getCheckpoint()!.roundLog![0]!.summary).toBe('测试回合');
    });

    it('completeRound 必须走 updatePlanStepStatus 唯一写点（不得直改 status）', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
      ]);
      // 契约级断言：直接锁住「写点收口」——未来若有人改回 step.status='done' 直改，此测试必红
      const spy = vi.spyOn(
        manager as unknown as { updatePlanStepStatus(id: string, s: string): boolean },
        'updatePlanStepStatus',
      );
      manager.completeRound({ stepId: 's1', summary: '测试回合' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('s1', 'done');
      expect(manager.getCheckpoint()!.plan[0]!.status).toBe('done');
      spy.mockRestore();
    });

    it('无 stepId 的 completeRound 仍记录回合日志（收口不破无步骤路径）', () => {
      manager.createCheckpoint('测试');
      manager.completeRound({ summary: '自由对话回合' });
      const cp = manager.getCheckpoint()!;
      expect(cp.roundLog).toHaveLength(1);
      expect(cp.roundLog![0]!.summary).toBe('自由对话回合');
      // 无 stepId 时不应触碰 plan 状态
      expect(cp.plan).toHaveLength(0);
    });

    it('isPlanStalled 空计划应返回 true', () => {
      manager.createCheckpoint('测试');
      expect(manager.isPlanStalled()).toBe(true);
    });

    it('isPlanStalled 全部完成应返回 true', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'done', order: 0 },
      ]);
      expect(manager.isPlanStalled()).toBe(true);
    });

    it('isPlanStalled 有未完成步骤应返回 false', () => {
      manager.createCheckpoint('测试');
      manager.updatePlan([
        { id: 's1', description: '步骤1', status: 'active', order: 0 },
        { id: 's2', description: '步骤2', status: 'pending', order: 1 },
      ]);
      expect(manager.isPlanStalled()).toBe(false);
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

  describe('updateResource / updateStandard / updateRole', () => {
    it('updateResource 应更新资源状态', () => {
      manager.createCheckpoint('测试');
      manager.updateResource({ documents: ['doc1.md'], memories: ['mem:1'], context: '测试上下文' });
      const cp = manager.getCheckpoint()!;
      expect(cp.resource.documents).toContain('doc1.md');
      expect(cp.resource.context).toBe('测试上下文');
    });

    it('updateStandard 应更新执行标准', () => {
      manager.createCheckpoint('测试');
      manager.updateStandard({ quality: '高质量', constraints: ['测试覆盖'] });
      const cp = manager.getCheckpoint()!;
      expect(cp.standard.quality).toBe('高质量');
      expect(cp.standard.constraints).toContain('测试覆盖');
    });

    it('updateRole 应更新角色', () => {
      manager.createCheckpoint('测试');
      manager.updateRole({ name: 'developer', description: '开发工程师' });
      const cp = manager.getCheckpoint()!;
      expect(cp.role.name).toBe('developer');
      expect(cp.role.description).toBe('开发工程师');
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

  describe('logToolExecution / hasToolExecuted', () => {
    it('logToolExecution 应写入工具执行记录', () => {
      const record: ToolExecutionRecord = {
        name: 'read_file',
        argsSignature: '{"path":"test.ts"}',
        executedAt: Date.now(),
        resultSummary: '文件内容',
        ok: true,
      };
      manager.logToolExecution(record);
      expect(manager.hasToolExecuted('read_file', '{"path":"test.ts"}')).toBe(true);
    });

    it('hasToolExecuted 未执行时返回 false', () => {
      expect(manager.hasToolExecuted('read_file', '{"path":"nonexistent.ts"}')).toBe(false);
    });

    it('参数签名不同应视为不同调用', () => {
      manager.logToolExecution({
        name: 'read_file',
        argsSignature: '{"path":"a.ts"}',
        executedAt: Date.now(),
        resultSummary: 'a',
        ok: true,
      });
      expect(manager.hasToolExecuted('read_file', '{"path":"a.ts"}')).toBe(true);
      expect(manager.hasToolExecuted('read_file', '{"path":"b.ts"}')).toBe(false);
    });

    it('工具名不同即使参数相同也视为不同调用', () => {
      manager.logToolExecution({
        name: 'read_file',
        argsSignature: '{"path":"test.ts"}',
        executedAt: Date.now(),
        resultSummary: '内容',
        ok: true,
      });
      expect(manager.hasToolExecuted('write_file', '{"path":"test.ts"}')).toBe(false);
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

  describe('restoreFromCheckpoint 非幂等工具日志', () => {
    it('恢复时无非幂等工具应正常完成', async () => {
      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'paused',
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };
      const count = await manager.restoreFromCheckpoint(cp);
      expect(count).toBe(0);
      expect(loop.restoreHistory).toHaveBeenCalled();
    });

    it('恢复时含非幂等工具应记录日志（不再注入系统消息）', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');
      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'paused',
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        completedToolCalls: [
          {
            name: 'write_file',
            argsSignature: '{"path":"a.ts","content":"hello"}',
            executedAt: Date.now(),
            resultSummary: 'ok',
            ok: true,
            idempotent: 'non-idempotent',
          },
        ],
        lastHeartbeat: Date.now(),
      };
      await manager.restoreFromCheckpoint(cp);
      // 降级后不再注入系统消息，仅通过 logger.warn 记录
      expect(loop.injectSystemMessage).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ nonIdempotentCount: 1 }),
        expect.stringContaining('非幂等工具'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('restoreFromCheckpoint 恢复行为', () => {
    it('error 态检查点缺 error 字段时应降级为 running，不产生永久分叉', async () => {
      // 先让状态机残留 paused（模拟跨会话恢复时的残留状态）
      manager.pause('测试暂停', 'user');
      expect(manager.status).toBe('paused');

      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'error', // error 态但 error 字段缺失（旧版检查点 / 序列化丢字段）
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };
      await manager.restoreFromCheckpoint(cp);

      // 契约：恢复 error 检查点后，状态机与检查点 status 同步为 running，避免永久分叉
      expect(manager.status).toBe('running');
      expect(manager.getCheckpoint()!.status).toBe('running');
    });

    it('恢复 paused 检查点后应启动暂停超时定时器', async () => {
      const startSpy = vi.spyOn(
        manager as unknown as { startPauseTimeoutTimer: () => void },
        'startPauseTimeoutTimer',
      );

      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'paused',
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };
      await manager.restoreFromCheckpoint(cp);

      // 契约：恢复 paused 检查点须启动暂停超时定时器（否则本次运行期无超时检测）
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('loadSessionMessages 失败时应显式降级（catch 挂 handler）而非悬空 rejection', async () => {
      // mock 会话加载失败（磁盘损坏 / 会话不存在等）
      (history.loadSessionMessages as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('会话消息加载失败'),
      );
      const warnSpy = vi.spyOn(logger, 'warn');

      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'running',
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };
      await manager.restoreFromCheckpoint(cp);

      // 恢复主流程不受影响（热记忆已恢复、状态机已归位）
      expect(manager.status).toBe('running');
      // 让微任务队列排空，使 rejection 走完 handler 链
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(warnSpy).toHaveBeenCalled();
      expect(history.loadSessionMessages).toHaveBeenCalled();
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

  describe('暂停超时检测', () => {
    it('未超时的暂停不应触发超时逻辑', () => {
      // 直接创建 paused 状态的检查点（最近心跳）
      const cp: SessionCheckpoint = {
        sessionId: '2026-08-08-main',
        schemaVersion: 1,
        status: 'paused',
        mainGoal: '测试',
        currentGoal: '测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' },
        standard: { quality: '', constraints: [] },
        resource: { documents: [], memories: [], context: '' },
        hotMemory: [],
        lastHeartbeat: Date.now(), // 当前时间，不超时
      };
      // 通过 loadPersistedCheckpoint 间接测试 pauseTimedOut 检测
      // 存储检查点
      sessionStore!.saveCheckpoint!(cp.sessionId, JSON.stringify(cp));
      // 加载检查点，不应触发超时
      const loaded = manager.loadPersistedCheckpoint();
      // 不超时，应返回检查点
      // 注意：如果检查点状态为 paused，loadPersistedCheckpoint 会恢复暂停状态
      // 不超时场景下 checkpoint 不为 null
      // 但 loadPersistedCheckpoint 内部会调用 stateMachine.pause，所以 cp 应被设置
      // 由于 isPauseTimedOut 返回 false，checkpoint 保留
      // 不过 loadPersistedCheckpoint 中 pause 会创建新检查点...
      // 让我们验证行为：不超时则 checkPoint 被设置
      // 需要验证 checkPoint 不为 null 且状态机为 paused
      expect(loaded).not.toBeNull();
      // 但是 loadPersistedCheckpoint 返回的是 checkpoint 的引用，之后 pause 会创建新检查点覆盖
      // 所以我们验证状态机状态
      if (loaded) {
        expect(loaded.status).toBe('paused');
      }
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

    it('空闲态（无活跃流）点暂停应直接翻 PAUSED 且不残留 pending 状态', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      // 空闲态：无活跃执行流，isBusy 为 false → requestPause 走直接暂停路径

      const ok = agent.requestPause('空闲暂停', 'user');
      expect(ok).toBe(true);
      // SSOT 收口后：空闲态直接翻 PAUSED，不经过 pending 延迟
      expect(agent.sessionManager!.status).toBe('paused');
      // 空闲态直接翻 PAUSED，不残留 pending 状态
      expect(agent.sessionManager!.isPausePending()).toBe(false);

      // 幂等锁不残留：放弃后再次暂停仍生效（证明无悬挂副本锁死按钮）
      // resume() 恢复运行态并清 pauseMeta
      const resumed = agent.resume();
      expect(resumed).toBe(true);
      expect(agent.sessionManager!.status).toBe('running');
      const ok2 = agent.requestPause('再次暂停', 'user');
      expect(ok2).toBe(true);
      expect(agent.sessionManager!.status).toBe('paused');
    });

    it('用户空闲主动暂停（requestPause）应透传 lowRisk=true，不计入连续暂停配额', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();
      expect(agent.sessionManager!.getConsecutivePauseCount()).toBe(0);

      const ok = agent.requestPause('空闲暂停', 'user');
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

  describe('锁忙时的 auto-resume', () => {
    it('锁忙时 processEvent 抛错且状态机不被静默翻转', async () => {
      agent = makeAgent(tmpProject, tmpConfig, tmpData);
      await agent.init();

      // 暂停会话，状态机进入 PAUSED
      agent.pause('测试暂停', 'user');
      expect(agent.sessionManager!.status).toBe('paused');

      // 模拟 chat 锁被其他执行流占用
      (agent as unknown as { internals: { chatLockManager: { _chatBusy: boolean } } }).internals.chatLockManager._chatBusy = true;

      // 锁先校验再动作：acquireChatLock 失败时状态机保持 PAUSED，不被静默吞掉
      const gen = agent.processEvent({ type: 'chat', content: '你好' });
      await expect(async () => {
        // 迭代以驱动生成器执行（chunk 无消费者，仅触发函数体）
        for await (const chunk of gen) {
          void chunk;
        }
      }).rejects.toThrow(/对话繁忙/);

      // 状态机必须保持 PAUSED
      expect(agent.sessionManager!.status).toBe('paused');
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

      const cp = agent.createCheckpoint('测试目标', { name: 'developer' });
      expect(cp).not.toBeNull();
      expect(cp!.mainGoal).toBe('测试目标');
      expect(cp!.role.name).toBe('developer');
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
 * 带检查点持久化的 Mock ISessionStore
 */
function createPersistentSessionStore(): ISessionStore {
  const checkpointStore = new Map<string, string>();
  const messageStore = new Map<string, Array<{ role: string; content: string; timestamp: string }>>();

  return {
    appendMessage: vi.fn((date: string, session: string, message: { role: string; content: string; timestamp: string }) => {
      const key = `${date}-${session}`;
      const list = messageStore.get(key) ?? [];
      list.push(message);
      messageStore.set(key, list);
    }),
    loadMessages: vi.fn((date: string, session: string) => {
      return messageStore.get(`${date}-${session}`) ?? [];
    }),
    listSessions: vi.fn(() => Array.from(messageStore.keys())),
    saveCheckpoint: vi.fn((sessionId: string, json: string) => {
      checkpointStore.set(sessionId, json);
    }),
    loadCheckpoint: vi.fn((sessionId: string) => {
      return checkpointStore.get(sessionId) ?? null;
    }),
    deleteCheckpoint: vi.fn((sessionId: string) => {
      checkpointStore.delete(sessionId);
    }),
  } as unknown as ISessionStore;
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
    const cp = agent.createCheckpoint('编写一个 CLI 工具', { name: 'developer' });
    expect(cp).not.toBeNull();
    expect(cp!.mainGoal).toBe('编写一个 CLI 工具');
    expect(cp!.role.name).toBe('developer');

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
    agent.createCheckpoint('处理文件', { name: 'assistant' });

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
   * 场景 C：检查点持久化与恢复
   *
   * 验证完整闭环：
   *   1. Agent init 后创建检查点，写入 sessionStore
   *   2. close() 关闭 Agent
   *   3. 重新 init（新 Agent 实例，复用 sessionStore）
   *   4. loadPersistedCheckpoint 加载持久化检查点
   *   5. restoreFromCheckpoint 恢复热记忆
   *   6. 继续对话验证上下文完整
   */
  it('场景 C：检查点持久化与恢复', { timeout: 30000 }, async () => {
    // 第一轮：创建检查点并持久化
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

    // 先对话，产生热记忆
    const reply1 = await agent.chatSync('你好，帮我写一段代码');
    expect(reply1).toContain('Mock 响应');

    // 创建检查点（含热记忆）
    agent.createCheckpoint('编写代码', { name: 'developer' });
    const cp = agent.getCheckpoint()!;
    expect(cp.mainGoal).toBe('编写代码');
    expect(cp.role.name).toBe('developer');

    // 暂停会话，触发持久化
    agent.pause('暂停测试', 'user');
    expect(sessionStore.saveCheckpoint).toHaveBeenCalled();

    // 关闭 Agent
    await agent.close();
    agent = null;

    // 第二轮：新 Agent 实例，加载持久化检查点
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

    // 验证持久化检查点被加载
    // loadPersistedCheckpoint 在 init 中自动调用，恢复状态机
    expect(agent.sessionManager!.status).toBe('paused');

    // 恢复会话
    const resumeOk = agent.resume();
    expect(resumeOk).toBe(true);

    // 继续对话
    const reply2 = await agent.chatSync('继续编写代码');
    expect(reply2).toContain('Mock 响应');
  });

  /**
   * 场景 D：工具幂等性——outbox 模式跳过重复执行
   *
   * 验证完整闭环：
   *   1. 模拟工具执行，记录到检查点
   *   2. 恢复检查点后，相同工具调用应被 preExecutionCheck 跳过
   *   3. 验证工具未被重复执行
   */
  it('场景 D：工具幂等性——outbox 模式跳过重复执行', { timeout: 30000 }, async () => {
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
    // 通过 sessionManager 的 logToolExecution 记录幂等工具
    agent.sessionManager!.logToolExecution({
      name: 'read_file',
      argsSignature: '{"path":"test.ts"}',
      executedAt: Date.now(),
      resultSummary: '文件内容：hello',
      ok: true,
      idempotent: 'idempotent',
    });

    // 验证 hasToolExecuted 返回 true
    expect(agent.sessionManager!.hasToolExecuted('read_file', '{"path":"test.ts"}')).toBe(true);

    // 验证未执行过的工具返回 false
    expect(agent.sessionManager!.hasToolExecuted('read_file', '{"path":"other.ts"}')).toBe(false);

    // 验证 preExecutionCheck 逻辑（通过 agent 内部回调）
    // 直接调用 agent 的 preExecutionCheck 逻辑（通过 assembler 注入的）
    // 由于 agent 内部 intercept 了 preExecutionCheck，这里通过 sessionManager 验证
    const cp = agent.getCheckpoint()!;
    const prevRecord = cp.completedToolCalls?.find(
      (r) => r.name === 'read_file' && r.argsSignature === '{"path":"test.ts"}',
    );
    expect(prevRecord).toBeDefined();
    expect(prevRecord!.resultSummary).toContain('hello');
  });

  /**
   * 场景 E：task_table_update 更新步骤必须标脏
   *
   * 旧缺陷：updateStep 手写 lastHeartbeat 绕过 touchCheckpoint → checkpointDirty 未置位
   * → 计划状态变更永不落盘（flushCheckpoint 见脏才写，sessionManager.ts:418）。
   *
   * 断言策略：直接 spy touchCheckpoint（运行时存在，TS private 仅编译期约束）。
   * 行为级断言（updateStep 后触发 flush 看写盘）不可靠——chatSync 路径存在其他
   * touchCheckpoint（如 updateGoal），会干扰 dirty 的归属，导致变异验证误绿。
   * 契约级断言直接锁定「updateStep 必须走标脏路径」。
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
    agent.createCheckpoint('测试目标', { name: 'developer' });

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
    const result = agent.tools!.planManager!.updateStep('step-1', 'done');
    expect(result).toContain('已标记为 done');
    expect(agent.getCheckpoint()!.plan[0]!.status).toBe('done');

      // updateStep 必须经标脏路径，touchCheckpoint 应被调用
      expect(touchSpy).toHaveBeenCalledTimes(1);
    });

  /**
   * 场景 G：roundLog 关联 active 步骤
   *
   * 旧缺陷：loop.onRoundBoundary → completeRound 不传 stepId（恒 undefined）→
   * roundLog 与 plan 无法关联，「哪一回合推进了哪一步」不可追溯。
   * onRoundBoundary 取当前 active 步骤 ID 传入，roundLog 成为 plan 的时间轴投影。
   */
  it('场景 G：roundLog 应记录 active 步骤 ID', { timeout: 30000 }, async () => {
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
    const stepId = 'step-active-1';
    agent.getCheckpoint()!.plan.push({
      id: stepId,
      description: '当前执行步骤',
      status: 'active',
      order: 1,
    });

    // 触发一轮对话 → loop 迭代边界 → onRoundBoundary → completeRound
    await agent.chatSync('推进任务');

    const roundLog = agent.getCheckpoint()!.roundLog ?? [];
    expect(roundLog.length).toBeGreaterThan(0);
    // roundLog 的 stepId 应关联当前 active 步骤
    expect(roundLog[roundLog.length - 1]!.stepId).toBe(stepId);
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
    agent.createCheckpoint('测试循环暂停恢复', { name: 'developer' });

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
 * - 续跑必须至少跨越一次迭代边界才会 yield paused，单轮 MockProvider 无法覆盖该场景。
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
 * [ASK] 主动提问 → 回答 → 续跑 Provider（集成测试专用）
 *
 * 设计要点（对抗式复核）：
 * - 摘要生成器（RoundSummaryGenerator）用主 provider 生成摘要——识别系统标记
 *   '对话摘要生成器' 返回有效 JSON，同时累计 summaryRequestCount 作为「恒 1:1」断言依据。
 * - 主对话按「是否已输出过 [ASK]」分岔：首轮输出 [ASK] 挂起等待回答；续跑轮
 *   （上下文含问题 + 用户回答）正常作答，不再触发 [ASK]。
 * - 记录续跑轮收到的完整消息列表（resumeMessages），供断言续跑上下文含「问题 + 回答」。
 */
class AskThenResumeProvider extends LlmProvider {
  readonly name = 'mock-ask-resume';
  /** 摘要生成请求计数（RoundSummaryGenerator 调用次数 = 已产 round-summary 条数） */
  summaryRequestCount = 0;
  /** 首轮是否已输出 [ASK]（分岔：首轮挂起，续跑轮正常作答） */
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
    if (!this.asked) {
      this.asked = true;
      // 首轮：[ASK] 主动提问，问题全文入史后暂停等待用户回答
      yield { content: '在读取文件前需要确认：\n[ASK] 你想读哪个文件？' };
      yield { finishReason: 'stop' };
      return;
    }
    // 续跑轮：上下文应含「问题 + 用户回答」（用户回答已注入 messages），正常收尾
    this.resumeMessages = messages;
    yield { content: '好的，继续执行。' };
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
    // 直到 loop 在迭代边界真正挂起并产出 {type:'paused'} chunk 才翻 PAUSED。
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

    // 幂等锁若未在 finally 释放，此处将永久返回 false（暂停按钮全失效）
    agent.resume();
    expect(agent.requestPause('第三次暂停', 'user')).toBe(true);
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

    // 在流进行中设置暂停锁（不预先 requestPause，否则会在迭代边界先翻 PAUSED 而绕开错误路径）。
    // provider 在首句后立即崩溃：此时 handleIteration 仍处于 yield* provider.chat 内部，
    // 下一轮 pauseRequested 检查尚未执行，故状态机停留 running；错误由
    // consumeExecutionStream 的 catch 转为 error chunk，finally 清理挂起的暂停锁。
    // 若清理不在 finally，requestPause 将永久返回 false（暂停按钮全失效）。
    for await (const chunk of agent.chat('触发崩溃')) {
      if (chunk.type === 'text') agent.requestPause('崩溃前暂停', 'user');
    }

    expect(agent.requestPause('崩溃后的暂停', 'user')).toBe(true);
  });

  it('Agent 级集成：[ASK] 主动提问 → 暂停不产摘要 → 回答续跑 → 恒 1:1 摘要', { timeout: 30000 }, async () => {
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

    // ── (a)(b)：首轮 [ASK] 主动提问 ─────────────────────────────
    const pendingEvents: unknown[] = [];
    agent.on('questionPending', (data: unknown) => pendingEvents.push(data));

    const chunks: Array<{ type: string; content?: string; questions?: unknown }> = [];
    for await (const chunk of agent.chat('帮我读取一个文件')) {
      chunks.push(chunk as { type: string; content?: string; questions?: unknown });
    }

    // 结构化 question_pending 事件发射（宿主可渲染提问 UI）+ 流中 question_pending chunk
    expect(pendingEvents.length).toBe(1);
    expect(chunks.some((c) => c.type === 'question_pending')).toBe(true);
    // 会话进入 PAUSED（[ASK] 主动提问走软暂停，等待用户回答续跑）
    expect(agent.sessionManager!.status).toBe('paused');
    // (a) 问题全文入史：历史中 assistant 消息含 [ASK] 问题文本
    const historyText = agent
      .getMessages()
      .filter((m) => m.role === 'assistant')
      .map((m) => String(m.content))
      .join('\n');
    expect(historyText).toContain('[ASK] 你想读哪个文件？');
    // 暂停原因/来源落检查点（收口统一写：source='agent'，重启后宿主可展示"为什么暂停 + 问了什么"）
    const pauseMeta = agent.sessionManager!.getCheckpoint()!.pauseMeta;
    expect(pauseMeta).toBeDefined();
    expect(pauseMeta!.source).toBe('agent');
    // (b) 暂停轮不产摘要：回合未完成，摘要推迟到续跑最终轮
    expect(askProvider.summaryRequestCount).toBe(0);

    // ── (c)(d)：回答续跑 → 恒 1:1 摘要 ──────────────────────────
    for await (const chunk of agent.resumeExecution('我想读 probe.txt')) {
      chunks.push(chunk as { type: string; content?: string; questions?: unknown });
    }
    expect(agent.sessionManager!.status).toBe('running');

    // (c) 续跑上下文含「问题 + 回答」：LLM 下一轮可见自己问过什么 + 用户回答
    const resumeText = (askProvider.resumeMessages ?? [])
      .map((m) => String(m.content))
      .join('\n');
    expect(resumeText).toContain('[ASK] 你想读哪个文件？');
    expect(resumeText).toContain('我想读 probe.txt');

    // (d) 续跑最终轮恰好产 1 条 round-summary（恒 1:1：暂停轮 0 + 续跑轮 1）
    await vi.waitFor(() => expect(askProvider.summaryRequestCount).toBe(1), { timeout: 2000 });
  });
});

describe('SSOT 排雷防回归 · 死 command 分支', () => {
  let tmpProject: string;
  let tmpConfig: string;
  let tmpData: string;
  let agent: Agent | null = null;

  beforeEach(() => {
    tmpData = mkdtempSync(join(tmpdir(), 'memora-t13-data-'));
    tmpProject = mkdtempSync(join(tmpdir(), 'memora-t13-proj-'));
    tmpConfig = mkdtempSync(join(tmpdir(), 'memora-t13-cfg-'));
    seedProject(tmpProject, tmpConfig, tmpData);
  });

  afterEach(() => {
    agent = null;
    rmSync(tmpData, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpConfig, { recursive: true, force: true });
  });

  it('喂入 type:command 事件不应触发状态机翻转（死分支已删）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();
    expect(agent.sessionManager!.status).toBe('running');

    // command 事件经 agent.processEvent → loop.processEvent → onSessionEvent 回调。
    // 死分支（agent.handleSessionEvent 的 case 'command' 调 sm.pause / loop.handleCommand）
    // 已被删除，command 应降级为 default（chat），绝不应翻 PAUSED。
    let sawPauseChunk = false;
    for await (const chunk of agent.processEvent({ type: 'command', content: 'pause' })) {
      if (chunk.type === 'text' && chunk.content.includes('会话已暂停')) sawPauseChunk = true;
    }

    expect(agent.sessionManager!.status).toBe('running');
    expect(sawPauseChunk).toBe(false);
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

  it('状态机残留 paused 时恢复 error 检查点，应正确落到 error', async () => {
    const manager = new SessionManager(
      () => createMockHistory(),
      () => createMockLoop(),
      createMockSessionStore(),
      () => false,
      () => {},
    );

    // 制造残留：管理器的状态机先进入 paused（模拟上一个会话未正常复位）
    manager.pause('前一个会话的暂停', 'user');
    expect(manager.status).toBe('paused');

    const errorCheckpoint: SessionCheckpoint = {
      ...manager.createCheckpoint('目标')!,
      status: 'error',
      error: { cause: 'LLM 超时', at: Date.now(), recovered: false },
    };

    // resetToRunning() 先归零，再 triggerError，使残留 paused 也能正确落到 error
    await manager.restoreFromCheckpoint(errorCheckpoint);
    expect(manager.status).toBe('error');
  });

  it('P4 澄清暂停前应先应用已确定槽位（防解析成果随暂停丢失）', async () => {
    agent = makeAgent(tmpProject, tmpConfig, tmpData);
    await agent.init();

    // 手动创建检查点：新会话（无磁盘检查点）时 checkpoint 为 null，
    // processEvent 的 compose 分支（`if (checkpoint && this.composer)`）会被整体跳过，
    // 增量解析（含 P4 澄清）不生效——该边界为既有缺口（见日志），本测试聚焦澄清分支本身。
    agent.sessionManager!.createCheckpoint('', { name: 'initial-role', description: '初始角色' });
    expect(agent.sessionManager!.getCheckpoint()!.currentGoal).toBe('');

    // correction 事件：role 槽有显式增量（P1 确定），task 槽无 delta 且 currentGoal 为空
    // → task 走 P4 澄清（needClarify 非空）→ 命中暂停分支；
    // 暂停前先应用已确定槽位，使检查点已含 expert。
    const chunkTypes: string[] = [];
    for await (const chunk of agent.processEvent({
      type: 'correction',
      content: '切换为专家模式',
      delta: { role: { name: 'expert', description: '领域专家' } },
    })) {
      chunkTypes.push(chunk.type);
    }

    // 澄清暂停已发生
    expect(chunkTypes).toContain('done');
    expect(agent.sessionManager!.status).toBe('paused');

    // 核心断言：已确定槽位（role）必须在暂停前落检查点
    expect(agent.sessionManager!.getCheckpoint()!.role.name).toBe('expert');
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
      provider: new SingleToolThenTextProvider('read_file', '{"path":"probe.txt"}'),
      configDir: tmpConfig,
      dataDir: tmpData,
      permission: 'owner',
      allowedPaths: [tmpProject, tmpData],
      archiveMode: 'manual',
      // 宿主纯放行（无改写），是否跳过完全交给内部幂等检查
      preExecutionCheck: () => ({ skip: false }),
    });
    await agent.init();

    // 预置检查点 + 已完成的幂等工具记录（read_file 为 'idempotent' 级别）
    agent.createCheckpoint('测试放行后幂等');
    agent.sessionManager!.logToolExecution({
      name: 'read_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '幂等上次结果',
      ok: true,
      idempotent: 'idempotent',
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 宿主放行 → 内部幂等跳过：outbox 标记 + 上次结果
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('[SKIP:TOOL:IDEMPOTENT]');
    expect(results[0]!.summary).toContain('幂等上次结果');
  });

  it('向后兼容：未注入宿主回调时，内部幂等检查照常工作', { timeout: 30000 }, async () => {
    agent = new Agent({
      projectPath: tmpProject,
      provider: new SingleToolThenTextProvider('read_file', '{"path":"probe.txt"}'),
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
      name: 'read_file',
      argsSignature: '{"path":"probe.txt"}',
      executedAt: Date.now(),
      resultSummary: '现状幂等结果',
      ok: true,
      idempotent: 'idempotent',
    });

    const results: Array<{ ok: boolean; summary?: string }> = [];
    for await (const chunk of agent.chat('读取探针文件')) {
      if (chunk.type === 'tool_result') {
        results.push({ ok: chunk.ok, summary: chunk.summary });
      }
    }

    // 无宿主回调 → 幂等照常：outbox 标记 + 上次结果
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.summary).toContain('[SKIP:TOOL:IDEMPOTENT]');
    expect(results[0]!.summary).toContain('现状幂等结果');
  });
});
