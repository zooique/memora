/**
 * ArchiveCoordinator 单元测试
 *
 * 覆盖范围：
 *   - archiveSession：null 降级 + 异常处理
 *   - archiveMode 二态控制（session 自动/手动归档）
 *   - emit 回调：归档路径事件正确转发
 *
 * 测试范式：
 *   - mock SessionArchiver（archiveSession 控制返回值）
 *   - 真实 ArchiveCoordinator 实例
 *   - spy emit 回调收集事件
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ArchiveCoordinator } from '@/agent/managers/archiveCoordinator.js';
import type { SessionArchiver, SessionArchiveResult } from '@/agent/managers/sessionArchiver.js';
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
 * @param result archiveSession 返回值
 */
function createMockSessionArchiver(result: SessionArchiveResult): SessionArchiver {
  return {
    archiveSession: vi.fn().mockResolvedValue(result),
  } as unknown as SessionArchiver;
}

/**
 * 构造 archiveMode 固定为 full 的 coordinator（session 测试基线）
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

  describe('archiveSession()', () => {
    it('getSessionArchiver 返回 null 时应返回空降级结果', async () => {
      const coordinator = createCoordinator(emitSpy);

      const result = await coordinator.archiveSession('2026-07-04', 'session-1');

      expect(result).toEqual({
        updatedFields: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      });
      expect(emitSpy.events).toHaveLength(0);
    });

    it('SessionArchiver 返回有效结果时应正常返回', async () => {
      const archiveResult: SessionArchiveResult = {
        updatedFields: ['summary', 'keyTopics'],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 10,
      };
      const sessionArchiver = createMockSessionArchiver(archiveResult);
      const coordinator = createCoordinator(emitSpy, sessionArchiver);

      const result = await coordinator.archiveSession('2026-07-04', 'session-1');

      expect(result).toBe(archiveResult);
      expect(sessionArchiver.archiveSession).toHaveBeenCalledWith('2026-07-04', 'session-1', undefined);
    });

    it('SessionArchiver 返回空 updatedFields 时不应发射事件', async () => {
      const archiveResult: SessionArchiveResult = {
        updatedFields: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      };
      const sessionArchiver = createMockSessionArchiver(archiveResult);
      const coordinator = createCoordinator(emitSpy, sessionArchiver);

      const result = await coordinator.archiveSession('2026-07-04', 'session-1');

      expect(result.updatedFields).toEqual([]);
      expect(emitSpy.events).toHaveLength(0);
    });

    it('SessionArchiver 抛出异常时应发射 archiveFailed({ stage: "session" }) 事件并返回降级结果', async () => {
      // 模拟 LLM 异常向上抛出的场景（SessionArchiver 不内部吞掉异常）
      const throwingArchiver = {
        archiveSession: vi.fn().mockRejectedValue(new Error('LLM 不可用')),
      } as unknown as SessionArchiver;
      const coordinator = createCoordinator(emitSpy, throwingArchiver);

      const result = await coordinator.archiveSession('2026-07-04', 'session-1');

      // 应返回空降级结果，不向上抛出（保证 SESSION_SWITCH 自动归档不中断主流程）
      expect(result).toEqual({
        updatedFields: [],
        sessionLabel: '2026-07-04-session-1',
        messageCount: 0,
      });
      // 应发射 archiveFailed 事件，stage='session'
      const archiveFailedEvents = emitSpy.events.filter((e) => e.event === 'archiveFailed');
      expect(archiveFailedEvents).toHaveLength(1);
      expect(archiveFailedEvents[0]!.payload).toEqual({
        stage: 'session',
        message: 'LLM 不可用',
      });
    });

    it('异常 message 超过 200 字符时应截断后发射', async () => {
      // 验证 message.slice(0, 200) 截断逻辑，防止 payload 过大
      const longMessage = 'X'.repeat(300);
      const throwingArchiver = {
        archiveSession: vi.fn().mockRejectedValue(new Error(longMessage)),
      } as unknown as SessionArchiver;
      const coordinator = createCoordinator(emitSpy, throwingArchiver);

      await coordinator.archiveSession('2026-07-04', 'session-1');

      const archiveFailedEvents = emitSpy.events.filter((e) => e.event === 'archiveFailed');
      expect(archiveFailedEvents).toHaveLength(1);
      expect(archiveFailedEvents[0]!.payload).toEqual({
        stage: 'session',
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
        updatedFields: ['summary'],
        sessionLabel: 'd-s',
        messageCount: 1,
      });
      const coordinator = new ArchiveCoordinator({
        getSessionArchiver: () => sessionArchiver,
        emit: emitSpy.emit,
        getArchiveMode: () => 'full',
      });

      // close 前：归档正常工作
      const resultBefore = await coordinator.archiveSession('2026-07-04', 's-1');
      expect(resultBefore.updatedFields).toHaveLength(1);

      // 模拟 Agent close：字段 null 化
      sessionArchiver = null;
      emitSpy.events.length = 0; // 清空事件

      // close 后：归档应降级返回空，不抛错
      const sessionResult = await coordinator.archiveSession('2026-07-04', 's-1');

      expect(sessionResult).toEqual({
        updatedFields: [],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 0,
      });
      expect(emitSpy.events).toHaveLength(0);
    });
  });

  // ─── archiveMode 二态控制集中到 ArchiveCoordinator ───
  describe('archiveMode 控制（session）', () => {
    it('autoTriggered + full 模式 → 执行（调用 SessionArchiver）', async () => {
      const sessionArchiver = createMockSessionArchiver({
        updatedFields: ['summary'],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'full');

      const result = await coordinator.archiveSession('2026-07-04', 's-1', { autoTriggered: true });

      expect(result.updatedFields).toHaveLength(1);
      expect(sessionArchiver.archiveSession).toHaveBeenCalledWith('2026-07-04', 's-1', { autoTriggered: true });
    });

    it('autoTriggered + manual 模式 → 跳过', async () => {
      const sessionArchiver = createMockSessionArchiver({
        updatedFields: ['summary'],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'manual');

      const result = await coordinator.archiveSession('2026-07-04', 's-1', { autoTriggered: true });

      expect(result.updatedFields).toEqual([]);
      expect(sessionArchiver.archiveSession).not.toHaveBeenCalled();
    });

    it('手动触发 + manual 模式 → 执行（用户意图优先）', async () => {
      const sessionArchiver = createMockSessionArchiver({
        updatedFields: ['summary'],
        sessionLabel: '2026-07-04-s-1',
        messageCount: 5,
      });
      const coordinator = createCoordinator(emitSpy, sessionArchiver, 'manual');

      const result = await coordinator.archiveSession('2026-07-04', 's-1');

      expect(result.updatedFields).toHaveLength(1);
      expect(sessionArchiver.archiveSession).toHaveBeenCalled();
    });
  });
});
