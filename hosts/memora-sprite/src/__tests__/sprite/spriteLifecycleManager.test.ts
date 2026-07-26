/**
 * SpriteLifecycleManager 单元测试
 *
 * 覆盖范围：
 * - 构造函数 + start/stop 生命周期（triggerBus/agent 事件订阅/回收站定时器）
 * - handleTrigger 主路径（fileWatcher/timer 分发 + tracer span + 异常兜底）
 * - generateSmartSuggestions 间接测试（重复/过时/画像缺失三分支 + 异常静默）
 * - tryUpdateWorkProjection 异步（reason 正则匹配 + works 投影更新 + 异常 catch）
 * - 10 种 Agent 事件转发（memoryAdded/insightExtracted/conflictDetected/.../archiveFailed）
 * - purgeExpiredMemories（回收站清理 + threshold 计算 + 异常 catch）
 * - registerFileWatcher / rebuildFileWatcher（路径解析 + 触发器重建 + running 守卫）
 *
 * Mock 策略：
 * - vi.mock 拦截 node:fs（existsSync）+ node:fs/promises（readFile），保留其他原始导出
 * - LifecycleDeps 全部字段使用 mock 对象注入
 * - setLogger 注入 mock logger，验证 warn/info 降级日志
 * - agent.on/off 记录 handler 引用，手动触发事件测试转发链路
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, ITracer } from 'memora';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';
import { SpriteLifecycleManager } from '../../sprite/spriteLifecycleManager.js';
import type { LifecycleDeps, SpriteEventEmitter } from '../../sprite/spriteLifecycleManager.js';
import type { TriggerBus } from '../../sprite/triggers.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfig } from '../../sprite/spriteConfig.js';
import type { HealthDashboard, DuplicateGroup, StaleMemory } from '../../sprite/controllers/memoryHealth.js';
import type { DashboardData } from '../../sprite/controllers/memoryController.js';
import type { ProactiveEngine } from '../../sprite/controllers/proactiveEngine.js';
import type { PerceptionCoordinator } from '../../sprite/controllers/perceptionCoordinator.js';
import type { MemoryController } from '../../sprite/controllers/memoryController.js';
import { MS_PER_DAY } from '../../sprite/constants.js';
import { resolve } from 'node:path';
// 类型命名空间：用于 vi.mock 中保留原始模块导出类型
// （eslint consistent-type-imports 规则禁止 typeof import() 语法）
import type * as nodeFs from 'node:fs';
import type * as nodeFsPromises from 'node:fs/promises';

// ─── Mock node:fs / node:fs/promises（保留原始导出，仅替换需要控制的函数） ───

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof nodeFs;
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as typeof nodeFsPromises;
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// ─── Mock 工厂 ──────────────────────────────────────────

type AgentEventHandler = (e: unknown) => void;

/** 创建 Mock ILogger（通过 setLogger 注入，验证降级日志） */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** 创建空健康度仪表盘（默认安全状态：无重复/无过时/无画像缺失） */
function createEmptyHealth(): HealthDashboard {
  return {
    scores: { overall: 100, uniqueness: 100, freshness: 100, completeness: 100 },
    duplicates: [],
    staleMemories: [],
    lowQualityCount: 0,
    totalMemories: 0,
    healthLabel: 'excellent',
    healthDescription: '记忆库健康',
  };
}

/** 创建空仪表盘数据 */
function createEmptyDashboard(): DashboardData {
  return {
    total: 0,
    bySource: {},
    suggestions: [],
    relationCount: 0,
    conflictCount: 0,
  };
}

/** Mock span 对象类型 */
interface MockSpan {
  setAttribute: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

/** createSetup 返回类型 */
interface Setup {
  manager: SpriteLifecycleManager;
  mockAgent: Agent;
  mockTriggerBus: TriggerBus;
  mockConfig: Required<SpriteConfig>;
  mockProactiveEngine: ProactiveEngine;
  mockPerceptionCoordinator: PerceptionCoordinator;
  mockMemoryController: MemoryController;
  mockTracer: ITracer | null;
  mockSpan: MockSpan | null;
  mockEmit: SpriteEventEmitter;
  agentHandlers: Map<string, AgentEventHandler>;
  mockWorks: { getProjection: ReturnType<typeof vi.fn>; ensureProjection: ReturnType<typeof vi.fn> } | null;
  /** memory 为 null 意味着读写都不可用 */
  mockMemory: { writePurgeExpired: ReturnType<typeof vi.fn> } | null;
}

/** 创建完整测试 setup（所有 mock 对象 + manager） */
function createSetup(opts?: {
  configOverrides?: Partial<Required<SpriteConfig>>;
  tracer?: ITracer | null;
  works?: { getProjection: ReturnType<typeof vi.fn>; ensureProjection: ReturnType<typeof vi.fn> } | null;
  /** memory 为 null 意味着读写都不可用 */
  memory?: { writePurgeExpired: ReturnType<typeof vi.fn> } | null;
}): Setup {
  const agentHandlers = new Map<string, AgentEventHandler>();

  const mockWorks = opts?.works ?? {
    getProjection: vi.fn().mockResolvedValue(null),
    ensureProjection: vi.fn().mockResolvedValue(null),
  };

  const mockMemory = opts?.memory ?? {
    writePurgeExpired: vi.fn().mockReturnValue(0),
  };

  const mockAgent = {
    on: vi.fn((event: string, handler: AgentEventHandler) => {
      agentHandlers.set(event, handler);
    }),
    off: vi.fn((event: string, _handler: AgentEventHandler) => {
      agentHandlers.delete(event);
    }),
    // memory 统一读写入口
    memory: mockMemory,
    works: mockWorks,
  } as unknown as Agent;

  const mockTriggerBus = {
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    onError: vi.fn(),
  } as unknown as TriggerBus;

  const mockConfig: Required<SpriteConfig> = {
    ...DEFAULT_SPRITE_CONFIG,
    ...opts?.configOverrides,
  };

  const mockProactiveEngine = {
    addNotice: vi.fn(),
    setLastTriggerReason: vi.fn(),
  } as unknown as ProactiveEngine;

  const mockPerceptionCoordinator = {
    refreshBeforeChat: vi.fn(),
  } as unknown as PerceptionCoordinator;

  const mockMemoryController = {
    getHealthDashboard: vi.fn(() => createEmptyHealth()),
    dashboard: vi.fn(() => createEmptyDashboard()),
  } as unknown as MemoryController;

  let mockSpan: MockSpan | null = null;
  let mockTracer: ITracer | null;

  if (opts?.tracer === null) {
    mockTracer = null;
  } else {
    mockSpan = {
      setAttribute: vi.fn(),
      recordException: vi.fn(),
      end: vi.fn(),
    };
    mockTracer = {
      startSpan: vi.fn(() => mockSpan),
    } as unknown as ITracer;
  }

  const mockEmit = vi.fn() as unknown as SpriteEventEmitter;

  const deps: LifecycleDeps = {
    agent: mockAgent,
    triggerBus: mockTriggerBus,
    config: mockConfig,
    proactiveEngine: mockProactiveEngine,
    perceptionCoordinator: mockPerceptionCoordinator,
    memoryController: mockMemoryController,
    tracer: mockTracer,
    projectPath: '/test/project',
    dataDir: '/test/data',
    allowedPaths: ['/extra/path'],
    emit: mockEmit,
  };

  const manager = new SpriteLifecycleManager(deps);

  return {
    manager,
    mockAgent,
    mockTriggerBus,
    mockConfig,
    mockProactiveEngine,
    mockPerceptionCoordinator,
    mockMemoryController,
    mockTracer,
    mockSpan,
    mockEmit,
    agentHandlers,
    mockWorks,
    mockMemory,
  };
}

/** 手动触发 Agent 事件（模拟 Agent 内部 emit） */
function emitAgentEvent(handlers: Map<string, AgentEventHandler>, event: string, payload: unknown): void {
  const handler = handlers.get(event);
  if (handler) handler(payload);
}

// ─── 共享 mock logger（setLogger 注入） ──────────────────
const mockLogger = createMockLogger();

// ═══════════════════════════════════════════════════════════════
// 1. 构造函数 + start/stop 生命周期
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager start/stop 生命周期', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it('start 后 triggerBus.on 和 triggerBus.start 被调用', () => {
    const setup = createSetup();
    setup.manager.start();

    expect(setup.mockTriggerBus.on).toHaveBeenCalledTimes(1);
    expect(setup.mockTriggerBus.start).toHaveBeenCalledTimes(1);
  });

  it('start 后 agent.on 被调用 10 次（10 种事件）', () => {
    const setup = createSetup();
    setup.manager.start();

    // 10 种事件：memoryAdded/insightExtracted/conflictDetected/memoryRecalled/
    // decayCompleted/personaSwitched/projectSwitched/skillMatched/sessionForked/archiveFailed
    expect(setup.mockAgent.on).toHaveBeenCalledTimes(10);
  });

  it('start 后立即触发回收站清理（purgeExpired 调用 1 次）', () => {
    const setup = createSetup();
    setup.manager.start();

    expect(setup.mockMemory!.writePurgeExpired).toHaveBeenCalledTimes(1);
  });

  it('recycleBinRetentionDays=0 时 start 不清理回收站', () => {
    const setup = createSetup({ configOverrides: { recycleBinRetentionDays: 0 } });
    setup.manager.start();

    expect(setup.mockMemory!.writePurgeExpired).not.toHaveBeenCalled();
  });

  it('stop 后 agent.off 被调用 10 次（取消全部订阅）', () => {
    const setup = createSetup();
    setup.manager.start();
    setup.mockAgent.off.mockClear();
    setup.manager.stop();

    expect(setup.mockAgent.off).toHaveBeenCalledTimes(10);
  });

  it('stop 后 triggerBus.stop 被调用', () => {
    const setup = createSetup();
    setup.manager.start();
    setup.mockTriggerBus.stop.mockClear();
    setup.manager.stop();

    expect(setup.mockTriggerBus.stop).toHaveBeenCalledTimes(1);
  });

  it('stop 后可再次 start（可重复启动）', () => {
    const setup = createSetup();
    setup.manager.start();
    setup.manager.stop();

    // 再次 start 不应抛错（定时器已清理）
    expect(() => setup.manager.start()).not.toThrow();
    setup.manager.stop();
  });

  it('stop 后定时器清理（无残留，再次 start 不泄漏）', () => {
    const setup = createSetup();
    setup.manager.start();
    setup.manager.stop();

    // 再次 start 后 purgeExpired 应只被调用 1 次（首次 start 的定时器已清理）
    setup.mockMemory!.writePurgeExpired.mockClear();
    setup.manager.start();
    expect(setup.mockMemory!.writePurgeExpired).toHaveBeenCalledTimes(1);
    setup.manager.stop();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. handleTrigger 主路径
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager handleTrigger 主路径', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it("source='fileWatcher' → proactiveEngine.addNotice('file', reason) 被调用", () => {
    const setup = createSetup();
    // reason 不匹配正则，避免触发 tryUpdateWorkProjection 异步分支
    setup.manager.handleTrigger({ source: 'fileWatcher', reason: '文件变化触发' });

    expect(setup.mockProactiveEngine.addNotice).toHaveBeenCalledWith('file', '文件变化触发');
  });

  it("source='timer' → 不调用 addNotice('file')", () => {
    const setup = createSetup();
    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    // timer 源不触发 file notice（但 generateSmartSuggestions 可能触发 suggestion notice）
    expect(setup.mockProactiveEngine.addNotice).not.toHaveBeenCalledWith('file', expect.anything());
  });

  it('tracer 非 null 时 startSpan/end 被调用', () => {
    const setup = createSetup();
    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    expect(setup.mockTracer!.startSpan).toHaveBeenCalledTimes(1);
    expect(setup.mockSpan!.end).toHaveBeenCalledTimes(1);
  });

  it('tracer 为 null 时安全执行（不抛错）', () => {
    const setup = createSetup({ tracer: null });
    expect(() => setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' })).not.toThrow();
  });

  it('generateSmartSuggestions 异常时被外层 catch（不重抛）', () => {
    const setup = createSetup();
    // getHealthDashboard 抛错 → generateSmartSuggestions 内部异常
    setup.mockMemoryController.getHealthDashboard.mockImplementation(() => {
      throw new Error('mock: getHealthDashboard 失败');
    });

    expect(() => setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' })).not.toThrow();
    // 异常时 span.recordException 应被调用
    expect(setup.mockSpan!.recordException).toHaveBeenCalled();
  });

  it('handleTrigger 内部异常时 span.end 仍被调用（finally 保证）', () => {
    const setup = createSetup();
    // addNotice 抛错 → catch 捕获 → finally 仍执行 span.end
    setup.mockProactiveEngine.addNotice.mockImplementation(() => {
      throw new Error('mock: addNotice 失败');
    });

    setup.manager.handleTrigger({ source: 'fileWatcher', reason: '文件变化触发' });

    expect(setup.mockSpan!.end).toHaveBeenCalledTimes(1);
    expect(setup.mockSpan!.recordException).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. generateSmartSuggestions 间接测试（通过 handleTrigger）
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager generateSmartSuggestions（通过 handleTrigger 间接测试）', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it('duplicates > 0 → addNotice("suggestion", 含"重复")', () => {
    const setup = createSetup();
    const dupMemories = [
      { id: '1', name: '重复记忆', source: 'insight', score: 0.5, contentPreview: '内容A' },
      { id: '2', name: '重复记忆', source: 'insight', score: 0.5, contentPreview: '内容B' },
    ];
    const health: HealthDashboard = {
      ...createEmptyHealth(),
      duplicates: [{ type: 'name', memories: dupMemories }] as DuplicateGroup[],
      totalMemories: 2,
    };
    setup.mockMemoryController.getHealthDashboard.mockReturnValue(health);

    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    const suggestionCall = noticeCalls.find((c) => c[0] === 'suggestion');
    expect(suggestionCall).toBeDefined();
    expect(suggestionCall![1]).toContain('重复');
  });

  it('staleMemories.length > 5 → addNotice("suggestion", 含"过时")', () => {
    const setup = createSetup();
    const staleMemories = Array.from({ length: 6 }, (_, i) => ({
      memory: { id: `s-${i}`, name: `过时记忆${i}`, source: 'insight', score: 0.5, contentPreview: '内容' },
      reason: 'old_age' as const,
      daysSinceAccess: 40,
    })) as StaleMemory[];
    const health: HealthDashboard = {
      ...createEmptyHealth(),
      staleMemories,
      totalMemories: 6,
    };
    setup.mockMemoryController.getHealthDashboard.mockReturnValue(health);

    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    const suggestionCall = noticeCalls.find((c) => c[0] === 'suggestion');
    expect(suggestionCall).toBeDefined();
    expect(suggestionCall![1]).toContain('过时');
  });

  it('profileCount=0 && totalMemories > 10 → addNotice("suggestion", 含"画像")', () => {
    const setup = createSetup();
    const health: HealthDashboard = {
      ...createEmptyHealth(),
      totalMemories: 11,
    };
    setup.mockMemoryController.getHealthDashboard.mockReturnValue(health);
    // dashboard() 返回无 profile 源
    setup.mockMemoryController.dashboard.mockReturnValue({
      ...createEmptyDashboard(),
      total: 11,
      bySource: { insight: 11 },
    });

    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    const suggestionCall = noticeCalls.find((c) => c[0] === 'suggestion');
    expect(suggestionCall).toBeDefined();
    expect(suggestionCall![1]).toContain('画像');
  });

  it('三者都不满足 → addNotice 未被调用 suggestion 类型', () => {
    const setup = createSetup();
    // 默认空健康度：duplicates=[], staleMemories=[], totalMemories=0
    setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' });

    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    const suggestionCall = noticeCalls.find((c) => c[0] === 'suggestion');
    expect(suggestionCall).toBeUndefined();
  });

  it('memoryController.getHealthDashboard 抛错 → 不抛出（异常由 handleTrigger catch 兜底）', () => {
    const setup = createSetup();
    setup.mockMemoryController.getHealthDashboard.mockImplementation(() => {
      throw new Error('mock: getHealthDashboard 失败');
    });

    expect(() => setup.manager.handleTrigger({ source: 'timer', reason: '定时检查' })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. tryUpdateWorkProjection 异步（通过 handleTrigger 间接触发）
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager tryUpdateWorkProjection（异步作品投影更新）', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  /** 构造匹配 tryUpdateWorkProjection 正则的 reason */
  const FILE_WATCHER_REASON = '文件变化：src/test.ts（已修改）';

  it('reason 不匹配正则 → 直接 return（works.getProjection 不被调用）', async () => {
    const setup = createSetup();
    // reason 不含 "文件变化：xxx（" 格式
    setup.manager.handleTrigger({ source: 'fileWatcher', reason: '不匹配的reason' });

    // 等待可能的后台异步操作（不应有任何调用）
    await vi.waitFor(() => {
      expect(setup.mockWorks!.getProjection).not.toHaveBeenCalled();
    });
  });

  it('agent.works 为 null → 直接 return（works.getProjection 不被调用）', async () => {
    const setup = createSetup({ works: null });
    setup.manager.handleTrigger({ source: 'fileWatcher', reason: FILE_WATCHER_REASON });

    await vi.waitFor(() => {
      // works 为 null 时 tryUpdateWorkProjection 直接 return
      expect(setup.mockEmit).not.toHaveBeenCalledWith('workProjectionUpdated', expect.anything());
    });
  });

  it('文件不存在（existsSync=false）→ return（works.getProjection 不被调用）', async () => {
    const setup = createSetup();
    vi.mocked(existsSync).mockReturnValue(false);

    setup.manager.handleTrigger({ source: 'fileWatcher', reason: FILE_WATCHER_REASON });

    await vi.waitFor(() => {
      expect(setup.mockWorks!.getProjection).not.toHaveBeenCalled();
    });
  });

  it('existing 投影为 null → return（ensureProjection 不被调用）', async () => {
    const setup = createSetup();
    vi.mocked(existsSync).mockReturnValue(true);
    setup.mockWorks!.getProjection.mockResolvedValue(null);

    setup.manager.handleTrigger({ source: 'fileWatcher', reason: FILE_WATCHER_REASON });

    await vi.waitFor(() => {
      expect(setup.mockWorks!.ensureProjection).not.toHaveBeenCalled();
    });
  });

  it('ensureProjection 返回 entry → emit("workProjectionUpdated") 被调用', async () => {
    const setup = createSetup();
    vi.mocked(existsSync).mockReturnValue(true);
    setup.mockWorks!.getProjection.mockResolvedValue({
      id: 'work-proj-test',
      sourcePath: '/test/project/src/test.ts',
      fileHash: 'old-hash',
      summary: '旧摘要',
    });
    vi.mocked(readFile).mockResolvedValue('文件内容');
    setup.mockWorks!.ensureProjection.mockResolvedValue({
      id: 'work-proj-test',
      sourcePath: '/test/project/src/test.ts',
      fileHash: 'new-hash',
      summary: '新摘要',
    });

    setup.manager.handleTrigger({ source: 'fileWatcher', reason: FILE_WATCHER_REASON });

    await vi.waitFor(() => {
      expect(setup.mockEmit).toHaveBeenCalledWith('workProjectionUpdated', {
        sourcePath: resolve('/test/project', 'src/test.ts'),
        summary: '新摘要',
      });
    });
  });

  it('ensureProjection 抛错 → catch + logger.warn，不抛出', async () => {
    const setup = createSetup();
    vi.mocked(existsSync).mockReturnValue(true);
    setup.mockWorks!.getProjection.mockResolvedValue({
      id: 'work-proj-test',
      sourcePath: '/test/project/src/test.ts',
      fileHash: 'old-hash',
      summary: '旧摘要',
    });
    vi.mocked(readFile).mockResolvedValue('文件内容');
    setup.mockWorks!.ensureProjection.mockRejectedValue(new Error('mock: ensureProjection 失败'));

    // handleTrigger 本身不抛错（异步 IIFE 内部 catch）
    expect(() => setup.manager.handleTrigger({ source: 'fileWatcher', reason: FILE_WATCHER_REASON })).not.toThrow();

    // 等待异步 IIFE 完成后验证 logger.warn 被调用
    await vi.waitFor(() => {
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    // emit 不应被调用（ensureProjection 失败）
    expect(setup.mockEmit).not.toHaveBeenCalledWith('workProjectionUpdated', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. 10 种 Agent 事件转发
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager Agent 事件转发', () => {
  let setup: Setup;

  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
    setup = createSetup();
    setup.manager.start();
  });

  afterEach(() => {
    setup.manager.stop();
  });

  // ─── memoryAdded → memoryNoticed + addNotice('memory') ───

  it('memoryAdded → emit("memoryNoticed") + addNotice("memory")', () => {
    emitAgentEvent(setup.agentHandlers, 'memoryAdded', { id: '1', source: 'insight', name: '测试记忆' });

    expect(setup.mockEmit).toHaveBeenCalledWith('memoryNoticed', { source: 'insight', name: '测试记忆' });
    expect(setup.mockProactiveEngine.addNotice).toHaveBeenCalledWith('memory', '[insight] 测试记忆');
  });

  // ─── insightExtracted → insightGained + addNotice('insight') ───

  it('insightExtracted → emit("insightGained") + addNotice("insight")', () => {
    emitAgentEvent(setup.agentHandlers, 'insightExtracted', { source: 'insight', insight: '新洞察' });

    expect(setup.mockEmit).toHaveBeenCalledWith('insightGained', { source: 'insight', insight: '新洞察' });
    expect(setup.mockProactiveEngine.addNotice).toHaveBeenCalledWith('insight', '新洞察');
  });

  // ─── conflictDetected → conflictDetected（直接转发） ───

  it('conflictDetected → emit("conflictDetected") 转发完整 payload', () => {
    emitAgentEvent(setup.agentHandlers, 'conflictDetected', {
      newMemoryId: 'mem-1',
      newInsight: '新洞察',
      targetId: 'mem-2',
      targetContent: '冲突内容',
    });

    expect(setup.mockEmit).toHaveBeenCalledWith('conflictDetected', {
      newMemoryId: 'mem-1',
      newInsight: '新洞察',
      targetId: 'mem-2',
      targetContent: '冲突内容',
    });
  });

  it('conflictDetected 不调用 addNotice（事实通知，非主动行为）', () => {
    emitAgentEvent(setup.agentHandlers, 'conflictDetected', {
      newMemoryId: 'mem-1',
      newInsight: '新',
      targetId: 'mem-2',
      targetContent: '旧',
    });

    // conflictDetected 不经过 proactiveEngine
    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    expect(noticeCalls.find((c) => c[0] === 'conflict')).toBeUndefined();
  });

  // ─── memoryRecalled → memoryRecalled ───

  it('memoryRecalled → emit("memoryRecalled") 转发 count/query', () => {
    emitAgentEvent(setup.agentHandlers, 'memoryRecalled', { count: 5, query: '用户问题' });

    expect(setup.mockEmit).toHaveBeenCalledWith('memoryRecalled', { count: 5, query: '用户问题' });
  });

  // ─── decayCompleted → decayCompleted ───

  it('decayCompleted → emit("decayCompleted") 转发 decayedCount', () => {
    emitAgentEvent(setup.agentHandlers, 'decayCompleted', { decayedCount: 12 });

    expect(setup.mockEmit).toHaveBeenCalledWith('decayCompleted', { decayedCount: 12 });
  });

  // ─── archiveFailed → archiveFailed（直接转发 + warn 日志） ───

  it('archiveFailed → emit("archiveFailed") 转发 stage/message + logger.warn', () => {
    emitAgentEvent(setup.agentHandlers, 'archiveFailed', {
      stage: 'profile',
      message: 'LLM 提取失败',
    });

    expect(setup.mockEmit).toHaveBeenCalledWith('archiveFailed', {
      stage: 'profile',
      message: 'LLM 提取失败',
    });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { stage: 'profile', message: 'LLM 提取失败' },
      '归档失败',
    );
  });

  it('archiveFailed 不调用 addNotice（事实通知，非主动行为）', () => {
    emitAgentEvent(setup.agentHandlers, 'archiveFailed', {
      stage: 'insight',
      message: 'LLM 提取失败',
    });

    // archiveFailed 不经过 proactiveEngine（与 conflictDetected 同属事实通知）
    const noticeCalls = setup.mockProactiveEngine.addNotice.mock.calls;
    expect(noticeCalls.find((c) => c[0] === 'archive')).toBeUndefined();
  });

  // ─── personaSwitched → personaChanged + addNotice + refreshBeforeChat ───

  it('personaSwitched → emit("personaChanged") + addNotice("persona") + refreshBeforeChat()', () => {
    emitAgentEvent(setup.agentHandlers, 'personaSwitched', { from: '旧角色', to: '新角色' });

    expect(setup.mockEmit).toHaveBeenCalledWith('personaChanged', { from: '旧角色', to: '新角色' });
    expect(setup.mockProactiveEngine.addNotice).toHaveBeenCalledWith('persona', '旧角色 → 新角色');
    expect(setup.mockPerceptionCoordinator.refreshBeforeChat).toHaveBeenCalled();
  });

  it('personaSwitched from=null → addNotice 含 "(无)"', () => {
    emitAgentEvent(setup.agentHandlers, 'personaSwitched', { from: null, to: '开发者' });

    expect(setup.mockProactiveEngine.addNotice).toHaveBeenCalledWith('persona', '(无) → 开发者');
  });

  // ─── projectSwitched → projectSwitched ───

  it('projectSwitched → emit("projectSwitched") 转发 from/to/projectName', () => {
    emitAgentEvent(setup.agentHandlers, 'projectSwitched', {
      from: '/old/project',
      to: '/new/project',
      projectName: '新项目',
    });

    expect(setup.mockEmit).toHaveBeenCalledWith('projectSwitched', {
      from: '/old/project',
      to: '/new/project',
      projectName: '新项目',
    });
  });

  // ─── skillMatched → skillMatched ───

  it('skillMatched → emit("skillMatched") 转发 skill/score', () => {
    emitAgentEvent(setup.agentHandlers, 'skillMatched', { skill: 'code-review', score: 0.85 });

    expect(setup.mockEmit).toHaveBeenCalledWith('skillMatched', { skill: 'code-review', score: 0.85 });
  });

  // ─── sessionForked → sessionForked ───

  it('sessionForked → emit("sessionForked") 转发 from/to/messageCount', () => {
    emitAgentEvent(setup.agentHandlers, 'sessionForked', {
      from: 'session-1',
      to: 'session-2',
      messageCount: 15,
    });

    expect(setup.mockEmit).toHaveBeenCalledWith('sessionForked', {
      from: 'session-1',
      to: 'session-2',
      messageCount: 15,
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. purgeExpiredMemories（回收站清理）
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager purgeExpiredMemories（回收站清理）', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it('purgedCount > 0 → emit("trashPurged") + logger.info', () => {
    const setup = createSetup();
    setup.mockMemory!.writePurgeExpired.mockReturnValue(5);

    setup.manager.start();

    expect(setup.mockEmit).toHaveBeenCalledWith('trashPurged', { purgedCount: 5 });
    expect(mockLogger.info).toHaveBeenCalled();
    setup.manager.stop();
  });

  it('purgedCount = 0 → 不 emit("trashPurged")', () => {
    const setup = createSetup();
    setup.mockMemory!.writePurgeExpired.mockReturnValue(0);

    setup.manager.start();

    expect(setup.mockEmit).not.toHaveBeenCalledWith('trashPurged', expect.anything());
    setup.manager.stop();
  });

  it('memory.writePurgeExpired 抛错 → catch + logger.warn（不抛出）', () => {
    const setup = createSetup();
    setup.mockMemory!.writePurgeExpired.mockImplementation(() => {
      throw new Error('mock: purgeExpired 失败');
    });

    // start 调用 purgeExpiredMemories，异常应被 catch
    expect(() => setup.manager.start()).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalled();
    setup.manager.stop();
  });

  it('agent.memory 为 null → 直接 return（不抛错）', () => {
    const setup = createSetup({ memory: null });

    // memory 为 null 时 start 不应抛错（读写均不可用，跳过回收站清理）
    expect(() => setup.manager.start()).not.toThrow();
    setup.manager.stop();
  });

  it('threshold 计算正确（now - retentionDays * MS_PER_DAY）', () => {
    const setup = createSetup({ configOverrides: { recycleBinRetentionDays: 7 } });
    const beforeStart = Date.now();

    setup.manager.start();

    const threshold = setup.mockMemory!.writePurgeExpired.mock.calls[0][0] as Date;
    const expectedThreshold = beforeStart - 7 * MS_PER_DAY;
    // 允许 1 秒误差（测试执行耗时）
    expect(Math.abs(threshold.getTime() - expectedThreshold)).toBeLessThan(1000);
    setup.manager.stop();
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. registerFileWatcher / rebuildFileWatcher
// ═══════════════════════════════════════════════════════════════

describe('SpriteLifecycleManager registerFileWatcher / rebuildFileWatcher', () => {
  beforeEach(() => {
    setLogger(mockLogger);
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockLogger.debug.mockClear();
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFile).mockReset();
  });

  it('registerFileWatcher 调用 triggerBus.register', () => {
    const setup = createSetup();
    setup.manager.registerFileWatcher();

    expect(setup.mockTriggerBus.register).toHaveBeenCalledTimes(1);
    // 注册的触发器 name 应为 'fileWatcher'
    const registeredTrigger = vi.mocked(setup.mockTriggerBus.register).mock.calls[0][0];
    expect(registeredTrigger.name).toBe('fileWatcher');
  });

  it('watchPaths 解析为绝对路径', () => {
    const setup = createSetup({ configOverrides: { fileWatcherPaths: ['src', 'docs'] } });
    setup.manager.registerFileWatcher();

    const registeredTrigger = vi.mocked(setup.mockTriggerBus.register).mock.calls[0][0];
    // 通过 bracket 访问私有 config 字段验证 watchPaths
    const config = (registeredTrigger as unknown as { config: { watchPaths: string[] } }).config;
    expect(config.watchPaths).toEqual([
      resolve('/test/project', 'src'),
      resolve('/test/project', 'docs'),
    ]);
  });

  it('rebuildFileWatcher 总是先 unregister("fileWatcher")', () => {
    const setup = createSetup({ configOverrides: { fileWatcherEnabled: false } });
    setup.manager.rebuildFileWatcher();

    expect(setup.mockTriggerBus.unregister).toHaveBeenCalledWith('fileWatcher');
  });

  it('rebuildFileWatcher + fileWatcherEnabled=true → register 被调用', () => {
    const setup = createSetup({ configOverrides: { fileWatcherEnabled: true } });
    setup.mockTriggerBus.register.mockClear();
    setup.manager.rebuildFileWatcher();

    expect(setup.mockTriggerBus.register).toHaveBeenCalledTimes(1);
  });

  it('rebuildFileWatcher + fileWatcherEnabled=false → register 不被调用', () => {
    const setup = createSetup({ configOverrides: { fileWatcherEnabled: false } });
    setup.mockTriggerBus.register.mockClear();
    setup.manager.rebuildFileWatcher();

    expect(setup.mockTriggerBus.register).not.toHaveBeenCalled();
  });

  it('rebuildFileWatcher 后 running=true → triggerBus 重启（stop+start）', () => {
    const setup = createSetup({ configOverrides: { fileWatcherEnabled: false } });
    setup.manager.start();
    setup.mockTriggerBus.stop.mockClear();
    setup.mockTriggerBus.start.mockClear();

    setup.manager.rebuildFileWatcher();

    // running=true 时 restartTriggersIfRunning 调用 stop+start
    expect(setup.mockTriggerBus.stop).toHaveBeenCalledTimes(1);
    expect(setup.mockTriggerBus.start).toHaveBeenCalledTimes(1);
    setup.manager.stop();
  });

  it('rebuildFileWatcher 后 running=false → triggerBus 不重启', () => {
    const setup = createSetup({ configOverrides: { fileWatcherEnabled: false } });
    // 不调用 start()，running=false
    setup.mockTriggerBus.stop.mockClear();
    setup.mockTriggerBus.start.mockClear();

    setup.manager.rebuildFileWatcher();

    expect(setup.mockTriggerBus.stop).not.toHaveBeenCalled();
    expect(setup.mockTriggerBus.start).not.toHaveBeenCalled();
  });

  it('restartTriggersIfRunning 运行中 → stop+start', () => {
    const setup = createSetup();
    setup.manager.start();
    setup.mockTriggerBus.stop.mockClear();
    setup.mockTriggerBus.start.mockClear();

    setup.manager.restartTriggersIfRunning();

    expect(setup.mockTriggerBus.stop).toHaveBeenCalledTimes(1);
    expect(setup.mockTriggerBus.start).toHaveBeenCalledTimes(1);
    setup.manager.stop();
  });
});
