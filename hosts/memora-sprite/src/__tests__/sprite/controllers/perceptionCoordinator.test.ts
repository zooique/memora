/**
 * PerceptionCoordinator 单元测试 — 感知推导协调器全分支覆盖
 *
 * 覆盖范围：
 *   - 构造函数：依赖注入（4 个子控制器 + emitter + agent + proactiveEngine）
 *   - pushUserMessage：null/undefined/空字符串跳过 / 5 条上限 / shift 逻辑
 *   - refreshBeforeChat：6 类 prompt 累积注入 / 空 prompt 跳过 / 无 prompt 不注入 / 里程碑 / 跨会话
 *   - getSnapshot：null 返回条件 / 快照结构 / updateOptions 副作用（源文件 bug 标注）
 *   - calculateInteractionDays：空记忆 / 单条 / 多条
 *   - 事件发射：affectUpdated / rapportUpdated / contextUpdated / patternsUpdated
 *   - getCrossSessionContext（间接）：时间窗口 / 记忆过滤 / 摘要生成
 *   - ProactiveEngine 注入：setContextState / setRapportLevel / setAffectState / setPatterns
 *
 * 测试策略（对齐 affectController.test.ts / rapportController.test.ts 范式）：
 *   - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 *   - 通过 setLogger 注入 mock logger（避免 pino 日志输出污染测试）
 *   - 使用 vi.useFakeTimers 控制时间，确保跨会话时间窗口测试可复现
 *   - 禁止 @ts-ignore / as any，必要时用 `as unknown as Type` 单层断言
 *   - 使用 import type 分离类型导入
 *   - 中文测试用例描述（与项目风格一致）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerceptionCoordinator } from '../../../sprite/controllers/perceptionCoordinator.js';
import type { PerceptionEmitter, PerceptionCoordinatorOptions } from '../../../sprite/controllers/perceptionCoordinator.js';
import type { AffectState } from '../../../sprite/controllers/affectController.js';
import type { RapportController as RapportControllerType, RapportState } from '../../../sprite/controllers/rapportController.js';
import type { ContextAwareness as ContextAwarenessType, ContextState } from '../../../sprite/controllers/contextAwareness.js';
import type { PatternDetector as PatternDetectorType, DetectedPattern } from '../../../sprite/controllers/patternDetector.js';
import type { ProactiveEngine as ProactiveEngineType } from '../../../sprite/controllers/proactiveEngine.js';
import type { Agent, Memory, Persona } from 'memora';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';
import { MS_PER_HOUR, MS_PER_DAY } from '../../../sprite/constants.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 Mock ILogger（静默日志输出）
 *
 * 用于通过 setLogger() 注入，避免 pino 日志输出污染测试
 */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** 默认情感基调（用于 mock 返回值） */
const DEFAULT_AFFECT: AffectState = {
  warmth: 0.5,
  playfulness: 0.3,
  directness: 0.5,
  initiative: 0.5,
};

/** 默认默契度状态（用于 mock 返回值） */
const DEFAULT_RAPPORT: RapportState = {
  trust: 0.5,
  familiarity: 0.3,
  level: 'acquaintance',
  description: '相识阶段',
};

/** 默认对话上下文状态（用于 mock 返回值） */
const DEFAULT_CONTEXT: ContextState = {
  rhythm: 'normal',
  coherence: 'moderate',
  depth: 'moderate',
  dominantSource: 'chat',
  description: '正常节奏',
};

/**
 * 创建 4 个子控制器的 mock 对象
 *
 * 默认返回非空 prompt，测试可通过 mockReturnValue 覆盖
 *
 * @returns 包含 4 个子控制器 mock 的对象
 */
function createMockSubControllers() {
  const affectController = {
    updateOptions: vi.fn(),
    deriveAffect: vi.fn(() => ({ ...DEFAULT_AFFECT })),
    buildAffectPrompt: vi.fn(() => '【互动基调指导】mock 情感提示'),
    /** 实例方法（STEP4-2：改 static 为实例方法，通过回调注入） */
    deriveAffectFromMessages: vi.fn(() => ({})),
    blendAffect: vi.fn((current: AffectState) => ({ ...current })),
    applyDelta: vi.fn((current: AffectState) => ({ ...current })),
  };

  const rapportController = {
    updateOptions: vi.fn(),
    deriveRapport: vi.fn(() => ({ ...DEFAULT_RAPPORT })),
    buildRapportPrompt: vi.fn(() => '【关系边界指导】mock 默契提示'),
  };

  const contextAwareness = {
    deriveContext: vi.fn(() => ({ ...DEFAULT_CONTEXT })),
    buildContextPrompt: vi.fn(() => '【对话上下文】mock 上下文提示'),
  };

  const patternDetector = {
    detectPatterns: vi.fn(() => [] as DetectedPattern[]),
    buildPatternPrompt: vi.fn(() => ''),
  };

  return { affectController, rapportController, contextAwareness, patternDetector };
}

/**
 * 创建 ProactiveEngine mock 对象
 *
 * @param overrides 部分行为覆盖（如 acceptanceRate / milestones）
 */
function createMockProactiveEngine(overrides: {
  acceptanceRate?: number;
  milestones?: string[];
} = {}): ProactiveEngineType {
  return {
    acceptanceRate: overrides.acceptanceRate ?? 0.5,
    setContextState: vi.fn(),
    setRapportLevel: vi.fn(),
    setAffectState: vi.fn(),
    setPatterns: vi.fn(),
    peekPendingMilestones: vi.fn(() => overrides.milestones ?? []),
  } as unknown as ProactiveEngineType;
}

/**
 * 创建 PerceptionEmitter mock 对象
 *
 * @returns 包含 4 个事件回调 mock 的对象
 */
function createMockEmitter(): PerceptionEmitter {
  return {
    affectUpdated: vi.fn(),
    rapportUpdated: vi.fn(),
    contextUpdated: vi.fn(),
    patternsUpdated: vi.fn(),
  };
}

/**
 * 创建 Agent mock 对象
 *
 * @param options 配置项：memoryList / lastInteractionAt / persona / callCount
 */
function createMockAgent(options: {
  memoryList?: Memory[];
  lastInteractionAt?: Date | null;
  persona?: Persona | null;
  callCount?: number;
} = {}): Agent {
  const memoryList = options.memoryList ?? [];
  return {
    memory: {
      list: vi.fn(() => memoryList),
    },
    persona: {
      getActive: vi.fn(() => options.persona ?? null),
    },
    getMetrics: vi.fn(() => ({
      llm: { callCount: options.callCount ?? 0 },
    })),
    lastInteractionAt: options.lastInteractionAt ?? null,
    injectAffect: vi.fn(),
  } as unknown as Agent;
}

/**
 * 创建测试用 Memory 对象
 *
 * @param overrides 部分字段覆盖
 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    content: '测试内容',
    source: 'chat',
    name: '测试记忆',
    createdAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    score: 0.5,
    ...overrides,
  };
}

/**
 * 创建完整的 PerceptionCoordinator 测试套件
 *
 * 组装所有 mock 依赖并实例化 coordinator
 *
 * @param agentOptions Agent mock 配置
 * @param engineOptions ProactiveEngine mock 配置
 */
function createCoordinator(agentOptions: Parameters<typeof createMockAgent>[0] = {}, engineOptions: Parameters<typeof createMockProactiveEngine>[0] = {}) {
  const subControllers = createMockSubControllers();
  const emitter = createMockEmitter();
  const agent = createMockAgent(agentOptions);
  const proactiveEngine = createMockProactiveEngine(engineOptions);

  const opts: PerceptionCoordinatorOptions = {
    agent,
    affectController: subControllers.affectController as unknown as AffectControllerType,
    rapportController: subControllers.rapportController as unknown as RapportControllerType,
    contextAwareness: subControllers.contextAwareness as unknown as ContextAwarenessType,
    patternDetector: subControllers.patternDetector as unknown as PatternDetectorType,
    proactiveEngine,
    emitter,
  };

  const coordinator = new PerceptionCoordinator(opts);
  return { coordinator, subControllers, emitter, agent, proactiveEngine };
}

// ─── 测试套件 ────────────────────────────────────────────

describe('PerceptionCoordinator', () => {
  let mockLogger: ILogger;

  beforeEach(() => {
    mockLogger = createMockLogger();
    setLogger(mockLogger);
    // 控制时间，确保跨会话时间窗口测试可复现
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-28T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── 1. 构造函数 ──────────────────────────────────────

  describe('构造函数', () => {
    it('应正确接受所有依赖注入（4 子控制器 + emitter + agent + proactiveEngine）', () => {
      const { coordinator, subControllers, emitter, agent, proactiveEngine } = createCoordinator();

      // 验证 coordinator 实例存在
      expect(coordinator).toBeInstanceOf(PerceptionCoordinator);
      // 验证所有依赖都被传入（通过 refreshBeforeChat 间接验证各依赖被调用）
      coordinator.refreshBeforeChat();

      expect(subControllers.affectController.updateOptions).toHaveBeenCalled();
      expect(subControllers.rapportController.updateOptions).toHaveBeenCalled();
      expect(subControllers.contextAwareness.deriveContext).toHaveBeenCalled();
      expect(subControllers.patternDetector.detectPatterns).toHaveBeenCalled();
      expect(emitter.affectUpdated).toHaveBeenCalled();
      expect(emitter.rapportUpdated).toHaveBeenCalled();
      expect(emitter.contextUpdated).toHaveBeenCalled();
      expect(proactiveEngine.setContextState).toHaveBeenCalled();
      expect(agent.injectAffect).toHaveBeenCalled();
    });
  });

  // ─── 2. pushUserMessage ──────────────────────────────

  describe('pushUserMessage', () => {
    it('null 输入应跳过（不加入缓存）', () => {
      const { coordinator, subControllers } = createCoordinator();
      coordinator.pushUserMessage(null);

      // 通过 refreshBeforeChat 间接验证：recentUserMessages 为空时不调用 deriveAffectFromMessages
      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.refreshBeforeChat();
      expect(spy).not.toHaveBeenCalled();
    });

    it('undefined 输入应跳过', () => {
      const { coordinator, subControllers } = createCoordinator();
      coordinator.pushUserMessage(undefined);

      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.refreshBeforeChat();
      expect(spy).not.toHaveBeenCalled();
    });

    it('空字符串应跳过（!input 为 true）', () => {
      const { coordinator, subControllers } = createCoordinator();
      coordinator.pushUserMessage('');

      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.refreshBeforeChat();
      expect(spy).not.toHaveBeenCalled();
    });

    it('超过 5 条时应移除最旧的（shift 逻辑）', () => {
      const { coordinator, subControllers } = createCoordinator();
      // 推入 6 条消息
      coordinator.pushUserMessage('msg1');
      coordinator.pushUserMessage('msg2');
      coordinator.pushUserMessage('msg3');
      coordinator.pushUserMessage('msg4');
      coordinator.pushUserMessage('msg5');
      coordinator.pushUserMessage('msg6');

      // 间谍 deriveAffectFromMessages 以捕获传入的消息数组
      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.refreshBeforeChat();

      // 应只保留最近 5 条（msg2-msg6），msg1 被移除
      expect(spy).toHaveBeenCalledTimes(1);
      const passedMessages = spy.mock.calls[0]![0];
      expect(passedMessages).toHaveLength(5);
      expect(passedMessages).toEqual(['msg2', 'msg3', 'msg4', 'msg5', 'msg6']);
    });

    it('正好 5 条时不触发 shift', () => {
      const { coordinator, subControllers } = createCoordinator();
      coordinator.pushUserMessage('a');
      coordinator.pushUserMessage('b');
      coordinator.pushUserMessage('c');
      coordinator.pushUserMessage('d');
      coordinator.pushUserMessage('e');

      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.refreshBeforeChat();

      const passedMessages = spy.mock.calls[0]![0];
      expect(passedMessages).toHaveLength(5);
      expect(passedMessages).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  // ─── 3. refreshBeforeChat ─────────────────────────────

  describe('refreshBeforeChat', () => {
    it('应累积所有非空 prompt 并一次性注入 injectAffect', () => {
      const { coordinator, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.refreshBeforeChat();

      // injectAffect 应被调用一次，包含所有子控制器 prompt
      expect(agent.injectAffect).toHaveBeenCalledTimes(1);
      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      // 应包含情感、默契、上下文三类 prompt
      expect(injected).toContain('mock 情感提示');
      expect(injected).toContain('mock 默契提示');
      expect(injected).toContain('mock 上下文提示');
    });

    it('各子控制器返回空 prompt 时应跳过对应部分', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      // 让所有 prompt 构建方法返回空字符串
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      // 无里程碑、无跨会话，所有 prompt 为空 → 不应调用 injectAffect
      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('无任何 prompt 时不应调用 injectAffect', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      // 所有 prompt 都为空
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');
      subControllers.patternDetector.buildPatternPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('里程碑 prompt 应被注入（有里程碑时）', () => {
      const { coordinator, agent, proactiveEngine } = createCoordinator(
        { memoryList: [makeMemory()] },
        { milestones: ['积累了上百条记忆'] },
      );

      // 让子控制器 prompt 为空，只测里程碑
      coordinator.refreshBeforeChat();

      expect(proactiveEngine.peekPendingMilestones).toHaveBeenCalled();
      expect(agent.injectAffect).toHaveBeenCalledTimes(1);
      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('【里程碑时刻】');
      expect(injected).toContain('积累了上百条记忆');
    });

    it('无里程碑时不注入里程碑 prompt', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      // milestones 默认为空数组
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      // 无任何 prompt → 不调用 injectAffect
      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('跨会话上下文 prompt 应在间隔 > 1 小时时注入', () => {
      // lastInteractionAt 设为 2 小时前
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory({ createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString() })],
        lastInteractionAt: lastInteraction,
      });

      // 让其他 prompt 为空，只测跨会话
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      expect(agent.injectAffect).toHaveBeenCalledTimes(1);
      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('【跨会话上下文】');
      expect(injected).toContain('2 小时');
    });

    it('间隔 < 1 小时不生成跨会话上下文', () => {
      // lastInteractionAt 设为 30 分钟前
      const lastInteraction = new Date(Date.now() - 30 * 60 * 1000);
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
        lastInteractionAt: lastInteraction,
      });

      // 让其他 prompt 为空
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      // 跨会话返回空 → 无任何 prompt → 不调用 injectAffect
      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('lastInteractionAt 为 null 时不生成跨会话上下文（首次交互）', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
        lastInteractionAt: null,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('应将感知数据注入 ProactiveEngine（setContextState / setRapportLevel / setAffectState）', () => {
      const { coordinator, proactiveEngine } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.refreshBeforeChat();

      // context 应被注入
      expect(proactiveEngine.setContextState).toHaveBeenCalledTimes(1);
      // rapport 应被注入（lastRapport 在 deriveAndInjectRapport 中缓存）
      expect(proactiveEngine.setRapportLevel).toHaveBeenCalledTimes(1);
      // affect 应被注入（lastAffect 在 deriveAndInjectAffect 中缓存）
      expect(proactiveEngine.setAffectState).toHaveBeenCalledTimes(1);
    });

    it('应将 patterns 注入 ProactiveEngine（setPatterns）', () => {
      const mockPatterns: DetectedPattern[] = [
        { type: 'recurring_topic', summary: '测试模式', confidence: 0.8, relatedMemoryIds: [] },
      ];
      const { coordinator, subControllers, proactiveEngine } = createCoordinator({
        memoryList: [makeMemory()],
      });
      subControllers.patternDetector.detectPatterns.mockReturnValue(mockPatterns);

      coordinator.refreshBeforeChat();

      expect(proactiveEngine.setPatterns).toHaveBeenCalledWith(mockPatterns);
    });

    // refreshBeforeChat 三个推导步骤独立 try/catch，单点抛错不阻塞其他推导
    it('deriveAndInjectAffect 抛错时应降级（不抛出，不阻塞里程碑和跨会话上下文）', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });
      subControllers.affectController.deriveAffect.mockImplementation(() => {
        throw new Error('mock 情感推导失败');
      });

      // 错误被捕获，不向上传播
      expect(() => coordinator.refreshBeforeChat()).not.toThrow();
      // 情感推导失败，但 injectAffect 仍应被调用（可能注入里程碑或跨会话上下文）
      // 此处无里程碑无跨会话，prompts 为空，injectAffect 不调用
      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('getMilestonePrompt 抛错时应降级（不阻塞跨会话上下文注入）', () => {
      const { coordinator, subControllers, agent, proactiveEngine } = createCoordinator({
        memoryList: [makeMemory()],
      });
      // 让 affectController 返回有效 prompt，但 proactiveEngine.peekPendingMilestones 抛错
      subControllers.affectController.buildAffectPrompt.mockReturnValue('PROMPT_AFFECT');
      proactiveEngine.peekPendingMilestones.mockImplementation(() => {
        throw new Error('mock 里程碑读取失败');
      });

      expect(() => coordinator.refreshBeforeChat()).not.toThrow();
      // 情感 prompt 仍应被注入（里程碑失败不影响）
      const injected = agent.injectAffect.mock.calls[0]?.[0] as string;
      expect(injected).toContain('PROMPT_AFFECT');
    });

    it('getCrossSessionContext 抛错时应降级（不阻塞情感和里程碑注入）', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });
      subControllers.affectController.buildAffectPrompt.mockReturnValue('PROMPT_AFFECT');
      // 让 agent.lastInteractionAt 抛错（通过 getter 定义抛错）
      Object.defineProperty(agent, 'lastInteractionAt', {
        get() { throw new Error('mock lastInteractionAt 读取失败'); },
        configurable: true,
      });

      expect(() => coordinator.refreshBeforeChat()).not.toThrow();
      // 情感 prompt 仍应被注入
      const injected = agent.injectAffect.mock.calls[0]?.[0] as string;
      expect(injected).toContain('PROMPT_AFFECT');
    });

    it('prompts 应以 \\n\\n 分隔拼接后注入', () => {
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      // 让三个子控制器返回不同 prompt，无里程碑无跨会话
      subControllers.affectController.buildAffectPrompt.mockReturnValue('PROMPT_A');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('PROMPT_B');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('PROMPT_C');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      // perceptionPrompt = [A, B, C].filter(Boolean).join('\n\n')
      expect(injected).toBe('PROMPT_A\n\nPROMPT_B\n\nPROMPT_C');
    });
  });

  // ─── 4. getSnapshot ───────────────────────────────────

  describe('getSnapshot', () => {
    it('agent.memory 为 null 时返回 null', () => {
      const { coordinator, agent } = createCoordinator();
      // 模拟 agent.memory 为 null（Agent 未就绪）
      Object.defineProperty(agent, 'memory', { value: null, configurable: true });

      const result = coordinator.getSnapshot();
      expect(result).toBeNull();
    });

    it('记忆列表为空时返回 null', () => {
      const { coordinator } = createCoordinator({
        memoryList: [],
      });

      const result = coordinator.getSnapshot();
      expect(result).toBeNull();
    });

    it('返回结构包含 affect / rapport / context / patterns 四个字段', () => {
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
      });
      const mockPatterns: DetectedPattern[] = [
        { type: 'recurring_topic', summary: '测试模式', confidence: 0.7, relatedMemoryIds: ['m1'] },
      ];
      subControllers.patternDetector.detectPatterns.mockReturnValue(mockPatterns);

      const result = coordinator.getSnapshot();

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('affect');
      expect(result).toHaveProperty('rapport');
      expect(result).toHaveProperty('context');
      expect(result).toHaveProperty('patterns');
      // 验证返回的是 mock 值
      expect(result!.affect).toEqual(DEFAULT_AFFECT);
      expect(result!.rapport).toEqual(DEFAULT_RAPPORT);
      expect(result!.context).toEqual(DEFAULT_CONTEXT);
      expect(result!.patterns).toEqual(mockPatterns);
    });

    // header 注释从"无副作用"改为"不修改 Coordinator 自身状态"
    // getSnapshot 会调用 affectController.updateOptions / rapportController.updateOptions
    // 修改子控制器配置（这是有意设计，让快照反映最新配置参数）
    it('调用 affectController.updateOptions（刷新子控制器配置）', () => {
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.getSnapshot();

      // getSnapshot 应调用 affectController.updateOptions（副作用）
      expect(subControllers.affectController.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptanceRate: 0.5, // 来自 proactiveEngine.acceptanceRate
        }),
      );
    });

    it('调用 rapportController.updateOptions（刷新子控制器配置）', () => {
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.getSnapshot();

      expect(subControllers.rapportController.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          acceptanceRate: 0.5,
        }),
      );
    });

    it('应将 persona.getActive() 传入 affectController.updateOptions', () => {
      const mockPersona: Persona = {
        name: 'test-persona',
        id: 'persona:test',
        keywords: ['test'],
        content: '测试角色',
        filePath: '/test.md',
        traits: { playfulness: 0.8 },
      };
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
        persona: mockPersona,
      });

      coordinator.getSnapshot();

      expect(subControllers.affectController.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPersona: mockPersona,
        }),
      );
    });

    it('persona 为 null 时 affectController.updateOptions 接收 null', () => {
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
        persona: null,
      });

      coordinator.getSnapshot();

      expect(subControllers.affectController.updateOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          currentPersona: null,
        }),
      );
    });

    it('recentUserMessages 非空时应调用 AffectController.deriveAffectFromMessages', () => {
      const { coordinator, subControllers } = createCoordinator({
        memoryList: [makeMemory()],
      });
      coordinator.pushUserMessage('你好');

      const spy = vi.spyOn(subControllers.affectController, 'deriveAffectFromMessages');
      coordinator.getSnapshot();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(['你好']);
    });

    it('不发射任何事件（与 refreshBeforeChat 不同，getSnapshot 是读路径）', () => {
      const { coordinator, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.getSnapshot();

      // getSnapshot 不应发射事件
      expect(emitter.affectUpdated).not.toHaveBeenCalled();
      expect(emitter.rapportUpdated).not.toHaveBeenCalled();
      expect(emitter.contextUpdated).not.toHaveBeenCalled();
      expect(emitter.patternsUpdated).not.toHaveBeenCalled();
    });

    it('不调用 agent.injectAffect（读路径无注入副作用）', () => {
      const { coordinator, agent } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.getSnapshot();

      expect(agent.injectAffect).not.toHaveBeenCalled();
    });
  });

  // ─── 5. calculateInteractionDays ─────────────────────

  describe('calculateInteractionDays', () => {
    it('空记忆列表返回 0', () => {
      const { coordinator } = createCoordinator();
      expect(coordinator.calculateInteractionDays([])).toBe(0);
    });

    it('今天创建的记忆返回 0', () => {
      const { coordinator } = createCoordinator();
      const memories = [makeMemory({ createdAt: new Date().toISOString() })];
      expect(coordinator.calculateInteractionDays(memories)).toBe(0);
    });

    it('返回最早记忆距今的天数', () => {
      const { coordinator } = createCoordinator();
      // 3 天前 + 1 天前
      const memories = [
        makeMemory({ createdAt: new Date(Date.now() - 3 * MS_PER_DAY).toISOString() }),
        makeMemory({ createdAt: new Date(Date.now() - 1 * MS_PER_DAY).toISOString() }),
      ];
      expect(coordinator.calculateInteractionDays(memories)).toBe(3);
    });

    it('应取最早的 createdAt 计算（不是最新的）', () => {
      const { coordinator } = createCoordinator();
      const memories = [
        makeMemory({ createdAt: new Date(Date.now() - 10 * MS_PER_DAY).toISOString() }),
        makeMemory({ createdAt: new Date(Date.now() - 5 * MS_PER_DAY).toISOString() }),
        makeMemory({ createdAt: new Date(Date.now() - 1 * MS_PER_DAY).toISOString() }),
      ];
      // 最早的记忆是 10 天前
      expect(coordinator.calculateInteractionDays(memories)).toBe(10);
    });
  });

  // ─── 6. 事件发射 ──────────────────────────────────────

  describe('事件发射', () => {
    it('refreshBeforeChat 应发射 affectUpdated 事件', () => {
      const { coordinator, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.refreshBeforeChat();

      expect(emitter.affectUpdated).toHaveBeenCalledTimes(1);
      // 事件 payload 应为 AffectState 对象
      const payload = emitter.affectUpdated.mock.calls[0]![0];
      expect(payload).toEqual(DEFAULT_AFFECT);
    });

    it('refreshBeforeChat 应发射 rapportUpdated 事件', () => {
      const { coordinator, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.refreshBeforeChat();

      expect(emitter.rapportUpdated).toHaveBeenCalledTimes(1);
      const payload = emitter.rapportUpdated.mock.calls[0]![0];
      expect(payload).toEqual(DEFAULT_RAPPORT);
    });

    it('refreshBeforeChat 应发射 contextUpdated 事件', () => {
      const { coordinator, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });

      coordinator.refreshBeforeChat();

      expect(emitter.contextUpdated).toHaveBeenCalledTimes(1);
      const payload = emitter.contextUpdated.mock.calls[0]![0];
      expect(payload).toEqual(DEFAULT_CONTEXT);
    });

    it('patternsUpdated 有模式时发射完整 patterns 载荷', () => {
      const mockPatterns: DetectedPattern[] = [
        { type: 'recurring_topic', summary: '高频模式', confidence: 0.9, relatedMemoryIds: [] },
      ];
      const { coordinator, subControllers, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });
      subControllers.patternDetector.detectPatterns.mockReturnValue(mockPatterns);

      coordinator.refreshBeforeChat();

      expect(emitter.patternsUpdated).toHaveBeenCalledTimes(1);
      expect(emitter.patternsUpdated).toHaveBeenCalledWith({ patterns: mockPatterns });
    });

    it('无模式时仍发射 patternsUpdated（空 patterns 载荷，供 UI 清空陈旧显示）', () => {
      const { coordinator, emitter } = createCoordinator({
        memoryList: [makeMemory()],
      });
      // detectPatterns 默认返回空数组

      coordinator.refreshBeforeChat();

      expect(emitter.patternsUpdated).toHaveBeenCalledTimes(1);
      expect(emitter.patternsUpdated).toHaveBeenCalledWith({ patterns: [] });
    });
  });

  // ─── 7. getCrossSessionContext（通过 refreshBeforeChat 间接测试） ──

  describe('getCrossSessionContext（间接测试）', () => {
    it('间隔 >= 1 小时且有记忆时应生成跨会话上下文', () => {
      // 2 小时前
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      // 记忆在 1 小时前创建（在 gapMs + 2h 窗口内）
      const memories = [
        makeMemory({
          source: 'profile',
          name: '用户偏好',
          content: '用户喜欢简洁的回复',
          createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString(),
        }),
      ];
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      // 屏蔽其他 prompt
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      expect(agent.injectAffect).toHaveBeenCalledTimes(1);
      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('【跨会话上下文】');
      expect(injected).toContain('2 小时');
      // source='profile' → label='用户信息'
      expect(injected).toContain('用户信息');
      expect(injected).toContain('用户偏好');
      // content 前 80 字应作为预览
      expect(injected).toContain('用户喜欢简洁的回复');
    });

    it('间隔 >= 24 小时时应显示"天"单位', () => {
      // 25 小时前
      const lastInteraction = new Date(Date.now() - 25 * MS_PER_HOUR);
      const memories = [
        makeMemory({ createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString() }),
      ];
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      // 25 小时 → Math.round(25/24) = 1 天
      expect(injected).toContain('1 天');
    });

    it('source=insight 时 label 应为"洞察"', () => {
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      const memories = [
        makeMemory({
          source: 'insight',
          name: '关键洞察',
          content: '用户在测试',
          createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString(),
        }),
      ];
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('洞察');
    });

    it('source 非 profile/insight 时 label 应为"记忆"', () => {
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      const memories = [
        makeMemory({
          source: 'chat',
          name: '对话记录',
          content: '普通对话',
          createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString(),
        }),
      ];
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('[记忆]');
    });

    it('间隔 >= 1 小时但记忆为空时不生成跨会话上下文', () => {
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: [], // 无记忆
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      // 无记忆 → 跨会话返回空 → 无 prompt → 不调用 injectAffect
      expect(agent.injectAffect).not.toHaveBeenCalled();
    });

    it('content 超过 80 字时应截断为前 80 字', () => {
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      const longContent = '这是一段非常长的内容'.repeat(20); // 远超 80 字
      const memories = [
        makeMemory({
          source: 'chat',
          name: '长记录',
          content: longContent,
          createdAt: new Date(Date.now() - MS_PER_HOUR).toISOString(),
        }),
      ];
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      // 应只包含前 80 字
      expect(injected).toContain(longContent.substring(0, 80));
      // 不应包含第 81 字及之后的内容
      expect(injected).not.toContain(longContent.substring(0, 81));
    });

    it('取最近 5 条记忆作为关键记忆', () => {
      const lastInteraction = new Date(Date.now() - 2 * MS_PER_HOUR);
      // 创建 7 条记忆，全部在窗口内
      const memories = Array.from({ length: 7 }, (_, i) =>
        makeMemory({
          name: `记忆${i}`,
          content: `内容${i}`,
          createdAt: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(), // 逐条更早
        }),
      );
      const { coordinator, subControllers, agent } = createCoordinator({
        memoryList: memories,
        lastInteractionAt: lastInteraction,
      });

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      // 应包含前 5 条记忆（slice(0, 5)）
      expect(injected).toContain('记忆0');
      expect(injected).toContain('记忆4');
      // 不应包含第 6、7 条
      expect(injected).not.toContain('记忆5');
      expect(injected).not.toContain('记忆6');
    });
  });

  // ─── 8. 里程碑提示格式 ────────────────────────────────

  describe('getMilestonePrompt（通过 refreshBeforeChat 间接测试）', () => {
    it('多个里程碑应全部列出', () => {
      const milestones = ['里程碑A', '里程碑B', '里程碑C'];
      const { coordinator, subControllers, agent } = createCoordinator(
        { memoryList: [makeMemory()] },
        { milestones },
      );

      // 屏蔽其他 prompt
      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('里程碑A');
      expect(injected).toContain('里程碑B');
      expect(injected).toContain('里程碑C');
      expect(injected).toContain('里程碑时刻');
    });

    it('里程碑 prompt 包含自然提及的引导语', () => {
      const { coordinator, subControllers, agent } = createCoordinator(
        { memoryList: [makeMemory()] },
        { milestones: ['测试里程碑'] },
      );

      subControllers.affectController.buildAffectPrompt.mockReturnValue('');
      subControllers.rapportController.buildRapportPrompt.mockReturnValue('');
      subControllers.contextAwareness.buildContextPrompt.mockReturnValue('');

      coordinator.refreshBeforeChat();

      const injected = agent.injectAffect.mock.calls[0]![0] as string;
      expect(injected).toContain('自然地提及或庆祝');
      expect(injected).toContain('不要刻意生硬');
    });
  });
});
