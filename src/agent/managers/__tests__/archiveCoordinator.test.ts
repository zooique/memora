/**
 * ArchiveCoordinator 单元测试
 *
 * 覆盖范围（洞察层已移除，2026-08-14）：
 *   - archiveSessionContent：null 降级 + memories 事件发射 + 异常处理
 *   - archiveMode 三态控制（content 自动/手动归档）
 *   - emit 回调：内容归档路径事件正确转发
 *
 * 测试范式：
 *   - mock SessionArchiver（archiveSessionContent 控制返回值）
 *   - 真实 ArchiveCoordinator 实例
 *   - spy emit 回调收集事件
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArchiveCoordinator } from '@/agent/managers/archiveCoordinator.js';
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
function createMemory(id: string, source: string = 'content'): Memory {
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
 * 构造 archiveMode 固定为 full 的 coordinator（content 测试基线）
 */
function createCoordinator(
  emitSpy: ReturnType<typeof createEmitSpy>,
  sessionArchiver: SessionArchiver | null = null,
  mode: 'full' | 'manual' = 'full',
): ArchiveCoordinator {
  return new ArchiveCoordinator({
    getSessionArchiver: () => sessionArchiver,
    emit: emitSpy.emit,
    getArchiveMode: () => mode,
  });
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('ArchiveCoordinator', () => {
  let emitSpy: ReturnType<typeof createEmitSpy>;

  beforeEach(() => {
    emitSpy = createEmitSpy();
  });

  describe('archiveSessionContent()', () => {
    it('getSessionArchiver 返回 null 时应返回空降级结果', async () => {
      const coordinator = createCoordinator(emitSpy);

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
      const coordinator = createCoordinator(emitSpy, sessionArchiver);

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      expect(result).toBe(archiveResult);
      expect(sessionArchiver.archiveSessionContent).toHaveBeenCalledWith('2026-07-04', 'session-1', undefined);
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
      const coordinator = createCoordinator(emitSpy, sessionArchiver);

      const result = await coordinator.archiveSessionContent('2026-07-04', 'session-1');

      expect(result.memories).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('SessionArchiver 抛出异常时应发射 archiveFailed({ stage: "content" }) 事件并返回降级结果', async () => {
      // 模拟 LLM 异常向上抛出的场景（SessionArchiver 不内部吞掉异常）
      const throwingArchiver = {
        archiveSessionContent: vi.fn().mockRejectedValue(new Error('LLM 不可用')),
      } as unknown as SessionArchiver;
      const coordinator = createCoordinator(emitSpy, throwingArchiver);

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
      const coordinator = createCoordinator(emitSpy, throwingArchiver);

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
      // 注意：getter 必须闭包捕获外层 let 变量（而非 createCoordinator 的形参），
      // 才能在重新赋值后让 getter 读到最新值（动态求值语义）。
      let sessionArchiver: SessionArchiver | null = createMockSessionArchiver({
        memories: [createMemory('c-1', 'content')],
        sessionLabel: 'd-s',
        messageCount: 1,
      });
      const coordinator = new ArchiveCoordinator({
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        getArchiveMode: () => 'full',
      });

      // close 前：归档正常工作
      await coordinator.archiveSessionContent('2026-07-04', 's-1');
      expect(emitSpy.events.length).toBeGreaterThan(0);

      // 模拟 Agent close：字段 null 化
      sessionArchiver = null;
      emitSpy.events.length = 0; // 清空事件

      // close 后：归档应降级返回空，不抛错
      const sessionResult = await coordinator.archiveSessionContent('2026-07-04', 's-1');

      expect(sessionResult).toEqual({
        memories: [],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 0,
      });
      expect(emitSpy.events).toHaveLength(0);
    });
  });

  // ─── FIX-P1-4: archiveMode 三态控制集中到 ArchiveCoordinator ───
  describe('FIX-P1-4: archiveMode 三态控制（content）', () => {
    it('autoTriggered + full 模式 → 执行（调用 SessionArchiver）', async () => {
      const memories = [createMemory('c-1', 'content')];
      const sessionArchiver = createMockSessionArchiver({
        memories,
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'full');

      const result = await coordinator.archiveSessionContent('2026-07-04', 's-1', { autoTriggered: true });

      expect(result.memories).toHaveLength(1);
      expect(sessionArchiver.archiveSessionContent).toHaveBeenCalledWith('2026-07-04', 's-1', { autoTriggered: true });
      expect(emitSpy.events.filter((e) => e.event === 'memoryAdded')).toHaveLength(1);
    });

    it('autoTriggered + manual 模式 → 跳过', async () => {
      const sessionArchiver = createMockSessionArchiver({
        memories: [createMemory('c-1', 'content')],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'manual');

      const result = await coordinator.archiveSessionContent('2026-07-04', 's-1', { autoTriggered: true });

      expect(result.memories).toEqual([]);
      expect(sessionArchiver.archiveSessionContent).not.toHaveBeenCalled();
    });

    it('手动触发 + manual 模式 → 执行（用户意图优先）', async () => {
      const memories = [createMemory('c-1', 'content')];
      const sessionArchiver = createMockSessionArchiver({
        memories,
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'manual');

      const result = await coordinator.archiveSessionContent('2026-07-04', 's-1');

      expect(result.memories).toHaveLength(1);
      expect(sessionArchiver.archiveSessionContent).toHaveBeenCalled();
    });
  });
});