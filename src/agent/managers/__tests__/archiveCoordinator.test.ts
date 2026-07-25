/**
 * ArchiveCoordinator 单元测试
 *
 * 覆盖范围：
 *   - archiveProfileFacts：null 降级 + 事实提取 + 事件发射（confirmed/unconfirmed 分支）
 *   - archiveInsight：null 降级 + classify skip/extract 分支 + 事件发射
 *   - archiveSessionContent：null 降级 + memories 事件发射
 *   - emit 回调：所有归档路径事件正确转发
 *
 * 测试范式：
 *   - mock UserProfile（archiveFacts 控制返回值）
 *   - mock InsightExtractor（classify/extract 控制返回值）
 *   - mock SessionArchiver（archiveSessionContent 控制返回值）
 *   - 真实 extractUserFacts（纯函数，用输入"我叫张三"触发身份规则）
 *   - 真实 ArchiveCoordinator 实例
 *   - spy emit 回调收集事件
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArchiveCoordinator } from '@/agent/managers/archiveCoordinator.js';
import type { UserProfile, UserProfileEntry } from '@/memory/userProfile.js';
import type { InsightExtractor } from '@/agent/managers/insightExtractor.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
import type { Memory } from '@/memory/types.js';
import type { AgentEventMap } from '@/utils/eventEmitter.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 事件记录条目 */
interface EmittedEvent {
  event: keyof AgentEventMap;
  payload: AgentEventMap[keyof AgentEventMap];
}

/**
 * 构造 emit 回调 spy（收集所有发射事件）
 * @returns emit 函数 + 事件列表
 */
function createEmitSpy(): {
  emit: (event: keyof AgentEventMap, payload: AgentEventMap[keyof AgentEventMap]) => void;
  events: EmittedEvent[];
} {
  const events: EmittedEvent[] = [];
  const emit = (event: keyof AgentEventMap, payload: AgentEventMap[keyof AgentEventMap]) => {
    events.push({ event, payload });
  };
  return { emit, events };
}

/**
 * 构造 mock UserProfile（archiveFacts 可控制返回值）
 * @param entries archiveFacts 返回值（默认空数组）
 */
function createMockUserProfile(entries: UserProfileEntry[] = []): UserProfile {
  return {
    archiveFacts: vi.fn().mockResolvedValue(entries),
  } as unknown as UserProfile;
}

/**
 * 构造 mock InsightExtractor
 * @param classifyResult classify 返回值（'skip' 或 'extract'）
 * @param extractResult extract 返回值（Memory 数组）
 */
function createMockInsightExtractor(
  classifyResult: 'skip' | 'extract' = 'skip',
  extractResult: Memory[] = [],
): InsightExtractor {
  return {
    classify: vi.fn().mockReturnValue(classifyResult),
    extract: vi.fn().mockResolvedValue(extractResult),
  } as unknown as InsightExtractor;
}

/**
 * 构造 mock SessionArchiver
 * @param result archiveSessionContent 返回值
 */
function createMockSessionArchiver(result: SessionArchiveResult): SessionArchiver {
  return {
    archiveSessionContent: vi.fn().mockResolvedValue(result),
  } as unknown as SessionArchiver;
}

/**
 * 构造 Memory 对象（用于测试）
 */
function createMemory(id: string, source: string = 'insight'): Memory {
  const now = '2026-07-04T00:00:00.000Z';
  return {
    id,
    source,
    name: `test-${id}`,
    content: `内容-${id}`,
    createdAt: now,
    accessedAt: now,
    score: 0.8,
  };
}

/**
 * 构造 UserProfileEntry（用于测试）
 */
function createEntry(id: string, confirmed: boolean = true): UserProfileEntry {
  return {
    id,
    category: 'identity',
    // fieldName 必填，与 UserProfileEntry 接口契约一致
    fieldName: '姓名',
    value: `值-${id}`,
    source: 'turn-test',
    weight: 0.9,
    confirmed,
    updatedAt: '2026-07-04T00:00:00.000Z',
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('ArchiveCoordinator', () => {
  let emitSpy: ReturnType<typeof createEmitSpy>;

  beforeEach(() => {
    emitSpy = createEmitSpy();
  });

  describe('archiveProfileFacts()', () => {
    it('getUserProfile 返回 null 时应返回空数组且不发射事件', async () => {
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveProfileFacts('我叫张三');

      expect(result).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('archiveFacts 返回 confirmed 条目时应发射 memoryAdded 事件', async () => {
      const entries = [createEntry('profile-1', true), createEntry('profile-2', true)];
      const userProfile = createMockUserProfile(entries);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveProfileFacts('我叫张三');

      // extractUserFacts("我叫张三") 至少返回 1 个 identity 事实，archiveFacts mock 返回 entries
      expect(result).toBe(entries);
      // 每条 confirmed 条目应发射一次 memoryAdded 事件
      const memoryAddedEvents = emitSpy.events.filter((e) => e.event === 'memoryAdded');
      expect(memoryAddedEvents).toHaveLength(2);
      expect(memoryAddedEvents[0]!.payload).toEqual({
        id: 'profile-1',
        source: 'profile',
        name: '值-profile-1',
      });
      expect(memoryAddedEvents[1]!.payload).toEqual({
        id: 'profile-2',
        source: 'profile',
        name: '值-profile-2',
      });
    });

    it('archiveFacts 返回未 confirmed 条目时不应发射 memoryAdded 事件', async () => {
      const entries = [createEntry('profile-1', false)];
      const userProfile = createMockUserProfile(entries);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveProfileFacts('我叫张三');

      expect(result).toBe(entries);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('archiveFacts 返回混合 confirmed/unconfirmed 时只对 confirmed 发射事件', async () => {
      const entries = [
        createEntry('profile-1', true),
        createEntry('profile-2', false),
        createEntry('profile-3', true),
      ];
      const userProfile = createMockUserProfile(entries);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      await coordinator.archiveProfileFacts('我叫张三');

      const memoryAddedEvents = emitSpy.events.filter((e) => e.event === 'memoryAdded');
      expect(memoryAddedEvents).toHaveLength(2);
      expect(memoryAddedEvents[0]!.payload).toMatchObject({ id: 'profile-1' });
      expect(memoryAddedEvents[1]!.payload).toMatchObject({ id: 'profile-3' });
    });

    it('archiveFacts 返回空数组时不应发射事件', async () => {
      const userProfile = createMockUserProfile([]);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveProfileFacts('你好');

      expect(result).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });
  });

  describe('archiveInsight()', () => {
    it('getInsightExtractor 返回 null 时应返回空数组且不发射事件', async () => {
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveInsight('输入', '助手回复');

      expect(result).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('classify 返回 skip 时应直接返回空数组，不调用 extract', async () => {
      const insightExtractor = createMockInsightExtractor('skip', []);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => insightExtractor,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveInsight('你好', '你好');

      expect(result).toEqual([]);
      expect(insightExtractor.extract).not.toHaveBeenCalled();
      expect(emitSpy.events).toHaveLength(0);
    });

    it('classify 返回 extract 且 extract 返回多条时应发射 memoryAdded + insightExtracted 事件', async () => {
      const memories = [createMemory('ins-1', 'insight'), createMemory('ins-2', 'insight')];
      const insightExtractor = createMockInsightExtractor('extract', memories);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => insightExtractor,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveInsight('关键洞察', '助手回复');

      expect(result).toBe(memories);
      expect(insightExtractor.extract).toHaveBeenCalledWith('关键洞察', '助手回复');
      // 每条 memory 应发射 memoryAdded + insightExtracted
      const memoryAddedEvents = emitSpy.events.filter((e) => e.event === 'memoryAdded');
      const insightExtractedEvents = emitSpy.events.filter((e) => e.event === 'insightExtracted');
      expect(memoryAddedEvents).toHaveLength(2);
      expect(insightExtractedEvents).toHaveLength(2);
      expect(memoryAddedEvents[0]!.payload).toEqual({
        id: 'ins-1',
        source: 'insight',
        name: 'test-ins-1',
      });
      expect(insightExtractedEvents[0]!.payload).toEqual({
        source: 'insight',
        insight: '内容-ins-1',
      });
    });

    it('classify 返回 extract 且 extract 返回空数组时不应发射事件', async () => {
      const insightExtractor = createMockInsightExtractor('extract', []);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => insightExtractor,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveInsight('输入', '助手回复');

      expect(result).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });
  });

  describe('archiveSessionContent()', () => {
    it('getSessionArchiver 返回 null 时应返回空降级结果', async () => {
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => null,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      expect(result).toEqual({
        memories: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      });
      expect(emitSpy.events).toHaveLength(0);
    });

    it('SessionArchiver 返回 memories 时应发射 memoryAdded 事件', async () => {
      const memories = [createMemory('content-1', 'content'), createMemory('content-2', 'content')];
      const archiveResult: SessionArchiveResult = {
        memories,
        sessionLabel: '2026-07-04-session-1',
        messageCount: 10,
      };
      const sessionArchiver = createMockSessionArchiver(archiveResult);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      expect(result).toBe(archiveResult);
      expect(sessionArchiver.archiveSessionContent).toHaveBeenCalledWith('2026-07-04', 'session-1');
      const memoryAddedEvents = emitSpy.events.filter((e) => e.event === 'memoryAdded');
      expect(memoryAddedEvents).toHaveLength(2);
      expect(memoryAddedEvents[0]!.payload).toEqual({
        id: 'content-1',
        source: 'content',
        name: 'test-content-1',
      });
    });

    it('SessionArchiver 返回空 memories 时不应发射事件', async () => {
      const archiveResult: SessionArchiveResult = {
        memories: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      };
      const sessionArchiver = createMockSessionArchiver(archiveResult);
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      expect(result.memories).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('SessionArchiver 抛出异常时应发射 archiveFailed({ stage: "content" }) 事件并返回降级结果', async () => {
      // 模拟 LLM 异常向上抛出的场景（SessionArchiver 不内部吞掉异常）
      const throwingArchiver = {
        archiveSessionContent: vi.fn().mockRejectedValue(new Error('LLM 不可用')),
      } as unknown as SessionArchiver;
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => throwingArchiver,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      // 应返回空降级结果，不向上抛出（保证 SESSION_SWITCH 自动归档不中断主流程）
      expect(result).toEqual({
        memories: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      });
      // 应发射 archiveFailed 事件，stage='content'
      const archiveFailedEvents = emitSpy.events.filter((e) => e.event === 'archiveFailed');
      expect(archiveFailedEvents).toHaveLength(1);
      expect(archiveFailedEvents[0]!.payload).toEqual({
        stage: 'content',
        message: 'LLM 不可用',
      });
    });

    it('异常 message 超过 200 字符时应截断后发射', async () => {
      // 验证 message.slice(0, 200) 截断逻辑，防止 payload 过大
      const longMessage = 'X'.repeat(300);
      const throwingArchiver = {
        archiveSessionContent: vi.fn().mockRejectedValue(new Error(longMessage)),
      } as unknown as SessionArchiver;
      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => null,
        getInsightExtractor: () => null,
        getSessionArchiver: () => throwingArchiver,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      const archiveFailedEvents = emitSpy.events.filter((e) => e.event === 'archiveFailed');
      expect(archiveFailedEvents).toHaveLength(1);
      expect(archiveFailedEvents[0]!.payload).toEqual({
        stage: 'content',
        message: longMessage.slice(0, 200),
      });
    });
  });

  describe('getter 回调动态求值', () => {
    it('getter 应每次调用时动态求值（模拟 Agent close 后字段 null 化）', async () => {
      // 模拟 Agent 字段在 close 后被 null 化的场景
      let userProfile: UserProfile | null = createMockUserProfile([createEntry('p-1', true)]);
      let insightExtractor: InsightExtractor | null = createMockInsightExtractor('extract', [
        createMemory('ins-1'),
      ]);
      let sessionArchiver: SessionArchiver | null = createMockSessionArchiver({
        memories: [createMemory('c-1', 'content')],
        sessionLabel: 'd-s',
        messageCount: 1,
      });

      const coordinator = new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => insightExtractor,
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        // FIX-P1-4：默认 full 模式，保持现有测试场景不变（manual/insights-only 三态控制在专属测试块验证）
        getArchiveMode: () => 'full',
      });

      // close 前：所有归档正常工作
      await coordinator.archiveProfileFacts('我叫张三');
      await coordinator.archiveInsight('关键洞察', '回复');
      await coordinator.archiveSessionContent('2026-07-04', 's-1');
      expect(emitSpy.events.length).toBeGreaterThan(0);

      // 模拟 Agent close：所有字段 null 化
      userProfile = null;
      insightExtractor = null;
      sessionArchiver = null;
      emitSpy.events.length = 0; // 清空事件

      // close 后：所有归档应降级返回空，不抛错
      const profileResult = await coordinator.archiveProfileFacts('我叫张三');
      const insightResult = await coordinator.archiveInsight('关键洞察', '回复');
      const sessionResult = await coordinator.archiveSessionContent('2026-07-04', 's-1');

      expect(profileResult).toEqual([]);
      expect(insightResult).toEqual([]);
      expect(sessionResult).toEqual({
        memories: [],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 0,
      });
      expect(emitSpy.events).toHaveLength(0);
    });
  });

  // ─── FIX-P1-4: archiveMode 三态控制集中到 ArchiveCoordinator ───
  describe('FIX-P1-4: archiveMode 三态控制', () => {
    /**
     * 辅助：构造指定 archiveMode 的 coordinator
     * @param mode archiveMode
     * @param userProfile 可选 UserProfile mock
     * @param insightExtractor 可选 InsightExtractor mock
     * @param sessionArchiver 可选 SessionArchiver mock
     */
    function createCoordinatorWithMode(
      mode: 'full' | 'insights-only' | 'manual',
      userProfile: UserProfile | null = null,
      insightExtractor: InsightExtractor | null = null,
      sessionArchiver: SessionArchiver | null = null,
    ): ArchiveCoordinator {
      return new ArchiveCoordinator({
        getUserProfile: () => userProfile,
        getInsightExtractor: () => insightExtractor,
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        getArchiveMode: () => mode,
      });
    }

    describe('archiveProfileFacts() 模式判断', () => {
      it('autoTriggered + manual 模式 → 跳过（返回空，不调用 archiveFacts）', async () => {
        const userProfile = createMockUserProfile([createEntry('p-1', true)]);
        const coordinator = createCoordinatorWithMode('manual', userProfile);

        const result = await coordinator.archiveProfileFacts('我叫张三', { autoTriggered: true });

        expect(result).toEqual([]);
        expect(userProfile.archiveFacts).not.toHaveBeenCalled();
        expect(emitSpy.events).toHaveLength(0);
      });

      it('autoTriggered + full 模式 → 执行（调用 archiveFacts）', async () => {
        const userProfile = createMockUserProfile([createEntry('p-1', true)]);
        const coordinator = createCoordinatorWithMode('full', userProfile);

        const result = await coordinator.archiveProfileFacts('我叫张三', { autoTriggered: true });

        expect(result).toHaveLength(1);
        expect(userProfile.archiveFacts).toHaveBeenCalled();
        expect(emitSpy.events.filter((e) => e.event === 'memoryAdded')).toHaveLength(1);
      });

      it('autoTriggered + insights-only 模式 → 执行（profile 不受 insights-only 限制）', async () => {
        const userProfile = createMockUserProfile([createEntry('p-1', true)]);
        const coordinator = createCoordinatorWithMode('insights-only', userProfile);

        const result = await coordinator.archiveProfileFacts('我叫张三', { autoTriggered: true });

        expect(result).toHaveLength(1);
        expect(userProfile.archiveFacts).toHaveBeenCalled();
      });

      it('手动触发 + manual 模式 → 执行（用户意图优先，不受模式限制）', async () => {
        const userProfile = createMockUserProfile([createEntry('p-1', true)]);
        const coordinator = createCoordinatorWithMode('manual', userProfile);

        // 不传 options（默认 autoTriggered=false）
        const result = await coordinator.archiveProfileFacts('我叫张三');

        expect(result).toHaveLength(1);
        expect(userProfile.archiveFacts).toHaveBeenCalled();
      });
    });

    describe('archiveInsight() 模式判断', () => {
      it('autoTriggered + manual 模式 → 跳过（不调用 classify/extract）', async () => {
        const insightExtractor = createMockInsightExtractor('extract', [createMemory('ins-1')]);
        const coordinator = createCoordinatorWithMode('manual', null, insightExtractor);

        const result = await coordinator.archiveInsight('关键洞察', '回复', { autoTriggered: true });

        expect(result).toEqual([]);
        expect(insightExtractor.classify).not.toHaveBeenCalled();
        expect(insightExtractor.extract).not.toHaveBeenCalled();
        expect(emitSpy.events).toHaveLength(0);
      });

      it('autoTriggered + full 模式 → 执行（走 classify 判断）', async () => {
        const insightExtractor = createMockInsightExtractor('extract', [createMemory('ins-1')]);
        const coordinator = createCoordinatorWithMode('full', null, insightExtractor);

        const result = await coordinator.archiveInsight('关键洞察', '回复', { autoTriggered: true });

        expect(result).toHaveLength(1);
        expect(insightExtractor.classify).toHaveBeenCalled();
        expect(insightExtractor.extract).toHaveBeenCalledWith('关键洞察', '回复');
      });

      it('autoTriggered + insights-only 模式 → 执行（insight 是 insights-only 的核心）', async () => {
        const insightExtractor = createMockInsightExtractor('extract', [createMemory('ins-1')]);
        const coordinator = createCoordinatorWithMode('insights-only', null, insightExtractor);

        const result = await coordinator.archiveInsight('关键洞察', '回复', { autoTriggered: true });

        expect(result).toHaveLength(1);
        expect(insightExtractor.extract).toHaveBeenCalled();
      });

      it('手动触发 + manual 模式 → 执行（用户意图优先）', async () => {
        const insightExtractor = createMockInsightExtractor('extract', [createMemory('ins-1')]);
        const coordinator = createCoordinatorWithMode('manual', null, insightExtractor);

        const result = await coordinator.archiveInsight('关键洞察', '回复');

        expect(result).toHaveLength(1);
        expect(insightExtractor.extract).toHaveBeenCalled();
      });
    });

    describe('archiveSessionContent() 模式判断', () => {
      it('autoTriggered + full 模式 → 执行（调用 SessionArchiver）', async () => {
        const memories = [createMemory('c-1', 'content')];
        const sessionArchiver = createMockSessionArchiver({
          memories,
          sessionLabel: '2026-07-04-s-1',
          messageCount: 5,
        });
        const coordinator = createCoordinatorWithMode('full', null, null, sessionArchiver);

        const result = await coordinator.archiveSessionContent('2026-07-04', 's-1', { autoTriggered: true });

        expect(result.memories).toHaveLength(1);
        expect(sessionArchiver.archiveSessionContent).toHaveBeenCalledWith('2026-07-04', 's-1');
        expect(emitSpy.events.filter((e) => e.event === 'memoryAdded')).toHaveLength(1);
      });

      it('autoTriggered + insights-only 模式 → 跳过（content 仅 full 模式自动归档）', async () => {
        const sessionArchiver = createMockSessionArchiver({
          memories: [createMemory('c-1', 'content')],
          sessionLabel: '2026-07-04-s-1',
          messageCount: 5,
        });
        const coordinator = createCoordinatorWithMode('insights-only', null, null, sessionArchiver);

        const result = await coordinator.archiveSessionContent('2026-07-04', 's-1', { autoTriggered: true });

        expect(result).toEqual({
          memories: [],
          sessionLabel: '2026-07-04-s-1',
          messageCount: 0,
        });
        expect(sessionArchiver.archiveSessionContent).not.toHaveBeenCalled();
        expect(emitSpy.events).toHaveLength(0);
      });

      it('autoTriggered + manual 模式 → 跳过', async () => {
        const sessionArchiver = createMockSessionArchiver({
          memories: [createMemory('c-1', 'content')],
          sessionLabel: '2026-07-04-s-1',
          messageCount: 5,
        });
        const coordinator = createCoordinatorWithMode('manual', null, null, sessionArchiver);

        const result = await coordinator.archiveSessionContent('2026-07-04', 's-1', { autoTriggered: true });

        expect(result.memories).toEqual([]);
        expect(sessionArchiver.archiveSessionContent).not.toHaveBeenCalled();
      });

      it('手动触发 + insights-only 模式 → 执行（用户意图优先，如"一键归档"按钮）', async () => {
        const memories = [createMemory('c-1', 'content')];
        const sessionArchiver = createMockSessionArchiver({
          memories,
          sessionLabel: '2026-07-04-s-1',
          messageCount: 5,
        });
        const coordinator = createCoordinatorWithMode('insights-only', null, null, sessionArchiver);

        // 不传 options（默认 autoTriggered=false）
        const result = await coordinator.archiveSessionContent('2026-07-04', 's-1');

        expect(result.memories).toHaveLength(1);
        expect(sessionArchiver.archiveSessionContent).toHaveBeenCalledWith('2026-07-04', 's-1');
      });

      it('手动触发 + manual 模式 → 执行（用户意图优先）', async () => {
        const memories = [createMemory('c-1', 'content')];
        const sessionArchiver = createMockSessionArchiver({
          memories,
          sessionLabel: '2026-07-04-s-1',
          messageCount: 5,
        });
        const coordinator = createCoordinatorWithMode('manual', null, null, sessionArchiver);

        const result = await coordinator.archiveSessionContent('2026-07-04', 's-1');

        expect(result.memories).toHaveLength(1);
        expect(sessionArchiver.archiveSessionContent).toHaveBeenCalled();
      });
    });

    describe('archiveMode 动态切换', () => {
      it('getArchiveMode 每次调用动态求值（模拟运行时切换 archiveMode）', async () => {
        const userProfile = createMockUserProfile([createEntry('p-1', true)]);
        let currentMode: 'full' | 'insights-only' | 'manual' = 'manual';
        const coordinator = new ArchiveCoordinator({
          getUserProfile: () => userProfile,
          getInsightExtractor: () => null,
          getSessionArchiver: () => null,
          emit: emitSpy.emit,
          getArchiveMode: () => currentMode,
        });

        // manual 模式 + 自动触发 → 跳过
        let result = await coordinator.archiveProfileFacts('我叫张三', { autoTriggered: true });
        expect(result).toEqual([]);
        expect(userProfile.archiveFacts).not.toHaveBeenCalled();

        // 运行时切换到 full 模式 + 自动触发 → 执行
        currentMode = 'full';
        result = await coordinator.archiveProfileFacts('我叫张三', { autoTriggered: true });
        expect(result).toHaveLength(1);
        expect(userProfile.archiveFacts).toHaveBeenCalled();
      });
    });
  });
});
