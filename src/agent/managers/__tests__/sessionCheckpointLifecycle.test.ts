/**
 * 检查点字段生命周期测试（T3-1）
 *
 * 【本套件存在的理由】
 * 历史缺陷：createCheckpoint() 曾以对象字面量整体重建检查点，等价于隐式字段白名单，
 * 导致 roundLog / completedToolCalls / pauseMeta 三个侧车字段在每次 pause 时被静默丢弃。
 * 原有测试之所以没能拦住，是因为它们在写入后**直接**断言内存态，从不经过一次
 * pause → 落盘 → 重新加载的完整往返——断言点与真实生命周期不对齐。
 *
 * 【本套件的断言原则】
 * 1. 断言磁盘态而非内存态。内存态一致不能证明崩溃后可恢复。
 * 2. 用「键集合比对」代替逐字段枚举，使新增检查点字段时无需修改本文件即可获得保护。
 * 3. 覆盖异常恢复链，确保 error.recovered 落盘。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SessionManager } from '@/agent/managers/sessionManager.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { ISessionStore } from '@/memory/sessionStore.js';
import type { SessionCheckpoint, ToolExecutionRecord } from '@/agent/types.js';

const SESSION_ID = '2026-06-27-main';

/**
 * 带「假磁盘」的会话存储
 *
 * 与普通 vi.fn() mock 的区别：真实保存序列化结果，使测试可以读取磁盘态，
 * 从而分辨「内存里有」和「崩溃后还在」这两件本质不同的事。
 */
function createDiskBackedStore(): {
  store: ISessionStore;
  readDisk: () => SessionCheckpoint | null;
  writeCount: () => number;
} {
  const disk = new Map<string, string>();
  let writes = 0;

  const store: ISessionStore = {
    appendMessage: vi.fn(),
    loadMessages: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    copySession: vi.fn(),
    saveCheckpoint: (sessionId: string, json: string) => {
      writes += 1;
      disk.set(sessionId, json);
    },
    loadCheckpoint: (sessionId: string) => disk.get(sessionId) ?? null,
    deleteCheckpoint: (sessionId: string) => {
      disk.delete(sessionId);
    },
  };

  return {
    store,
    readDisk: () => {
      const json = disk.get(SESSION_ID);
      return json ? (JSON.parse(json) as SessionCheckpoint) : null;
    },
    writeCount: () => writes,
  };
}

function createMockHistory(): MessageHistory {
  return {
    switchSession: vi.fn().mockReturnValue(SESSION_ID),
    loadSessionMessages: vi.fn().mockReturnValue([]),
    currentSessionName: SESSION_ID,
  } as unknown as MessageHistory;
}

function createMockLoop(): AgentLoop {
  return {
    restoreHistory: vi.fn(),
    injectSystemMessage: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
  } as unknown as AgentLoop;
}

const TOOL_RECORD: ToolExecutionRecord = {
  name: 'write_file',
  argsSignature: '{"path":"a.ts"}',
  executedAt: Date.now(),
  resultSummary: '已写入 a.ts',
  ok: true,
  idempotent: 'non-idempotent',
};

describe('检查点字段生命周期', () => {
  let manager: SessionManager;
  let disk: ReturnType<typeof createDiskBackedStore>;

  beforeEach(() => {
    disk = createDiskBackedStore();
    manager = new SessionManager(
      () => createMockHistory(),
      () => createMockLoop(),
      disk.store,
      () => false,
      vi.fn(),
    );
  });

  /** 建立一个三个侧车字段均有值的检查点 */
  function seedCheckpointWithSidecars(): void {
    manager.createCheckpoint('主目标');
    manager.logToolExecution(TOOL_RECORD);
    manager.completeRound({ summary: '第一回合', toolCallCount: 1, assistantLength: 42 });
    manager.setPauseMeta({
      phase: 'suspended',
      reason: '用户主动暂停',
      source: 'user',
      pausedAt: Date.now(),
    });
  }

  describe('侧车字段跨 pause 存活（T0-1 回归）', () => {
    it('pause 后内存态应保留 roundLog / completedToolCalls / pauseMeta', () => {
      seedCheckpointWithSidecars();

      manager.pause('测试暂停', 'user');

      const cp = manager.getCheckpoint();
      expect(cp).not.toBeNull();
      expect(cp!.completedToolCalls).toHaveLength(1);
      expect(cp!.completedToolCalls![0]!.name).toBe('write_file');
      expect(cp!.roundLog).toHaveLength(1);
      expect(cp!.roundLog![0]!.summary).toBe('第一回合');
      expect(cp!.pauseMeta?.reason).toBe('用户主动暂停');
    });

    it('pause 后磁盘态同样应保留三个侧车字段', () => {
      seedCheckpointWithSidecars();

      manager.pause('测试暂停', 'user');

      // 关键断言：崩溃后能否恢复取决于磁盘，而非内存
      const onDisk = disk.readDisk();
      expect(onDisk).not.toBeNull();
      expect(onDisk!.completedToolCalls).toHaveLength(1);
      expect(onDisk!.roundLog).toHaveLength(1);
      expect(onDisk!.pauseMeta?.reason).toBe('用户主动暂停');
    });

    it('连续多次 pause / resume 不应累积丢失字段', () => {
      seedCheckpointWithSidecars();

      for (let i = 0; i < 3; i += 1) {
        manager.pause(`第 ${i + 1} 次暂停`, 'user');
        manager.resume();
      }

      const onDisk = disk.readDisk();
      expect(onDisk!.completedToolCalls).toHaveLength(1);
      expect(onDisk!.roundLog).toHaveLength(1);
    });
  });

  describe('结构性守卫：字段集合不得在 pause 时收缩', () => {
    /**
     * 这条断言是本套件的核心防回归机制。
     *
     * 它不枚举任何具体字段名——将来为 SessionCheckpoint 新增字段时，
     * 只要 createCheckpoint 退回白名单式重建，此断言即失败，
     * 无需任何人记得回来补充测试。
     */
    it('pause 前后检查点的键集合应完全一致', () => {
      seedCheckpointWithSidecars();
      const before = Object.keys(manager.getCheckpoint()!).sort();

      manager.pause('测试暂停', 'user');

      const after = Object.keys(manager.getCheckpoint()!).sort();
      expect(after).toEqual(before);
    });

    it('落盘快照不应丢失任何有值字段', () => {
      seedCheckpointWithSidecars();
      manager.pause('测试暂停', 'user');

      const memory = manager.getCheckpoint()!;
      // JSON 序列化会省略值为 undefined 的键，故仅比对有值字段
      const memoryKeys = Object.entries(memory)
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k)
        .sort();
      const diskKeys = Object.keys(disk.readDisk()!).sort();

      expect(diskKeys).toEqual(memoryKeys);
    });
  });

  describe('outbox 落盘时机（工具幂等前提）', () => {
    it('工具执行记录应立即落盘，不得延迟到回合边界', () => {
      manager.createCheckpoint('主目标');

      manager.logToolExecution(TOOL_RECORD);

      // 尚未 completeRound，此刻若崩溃，磁盘必须已包含执行事实
      const onDisk = disk.readDisk();
      expect(onDisk!.completedToolCalls).toHaveLength(1);
      expect(onDisk!.completedToolCalls![0]!.argsSignature).toBe('{"path":"a.ts"}');
    });

    it('副作用记录应立即落盘（补偿机制前提）', () => {
      manager.createCheckpoint('主目标');
      manager.logToolExecution(TOOL_RECORD);

      manager.recordSideEffect('write_file', '{"path":"a.ts"}', {
        type: 'file_write',
        target: 'a.ts',
        description: '写入文件',
      });

      const onDisk = disk.readDisk();
      expect(onDisk!.completedToolCalls![0]!.sideEffects).toHaveLength(1);
    });

    it('恢复后应能凭磁盘记录识别出工具已执行', () => {
      manager.createCheckpoint('主目标');
      manager.logToolExecution(TOOL_RECORD);
      manager.pause('暂停', 'user');

      // 模拟进程重启：新建管理器，从同一块磁盘加载
      const revived = new SessionManager(
        () => createMockHistory(),
        () => createMockLoop(),
        disk.store,
        () => false,
        vi.fn(),
      );
      const loaded = revived.loadPersistedCheckpoint();

      expect(loaded).not.toBeNull();
      expect(revived.hasToolExecuted('write_file', '{"path":"a.ts"}')).toBe(true);
    });
  });

  describe('异常恢复链落盘（T0-3 回归）', () => {
    it('recover 后磁盘上的 error.recovered 应为 true 且状态为 running', () => {
      manager.createCheckpoint('主目标');
      manager.triggerError('磁盘写满');

      expect(disk.readDisk()!.status).toBe('error');

      const ok = manager.recover();

      expect(ok).toBe(true);
      const onDisk = disk.readDisk()!;
      expect(onDisk.status).toBe('running');
      expect(onDisk.error?.recovered).toBe(true);
    });

    it('重启后仍应停留在已恢复状态，而非回退为未恢复的异常', () => {
      manager.createCheckpoint('主目标');
      manager.triggerError('磁盘写满');
      manager.recover();

      const revived = new SessionManager(
        () => createMockHistory(),
        () => createMockLoop(),
        disk.store,
        () => false,
        vi.fn(),
      );
      const loaded = revived.loadPersistedCheckpoint();

      expect(loaded!.status).toBe('running');
      expect(revived.stateMachine.status).toBe('running');
    });
  });

  describe('脏标记语义', () => {
    it('无变更时重复 resume 不应产生多余写盘', () => {
      manager.createCheckpoint('主目标');
      manager.pause('暂停', 'user');
      manager.resume();
      const baseline = disk.writeCount();

      // 已是 running，再次 resume 被状态机拒绝，不应触发写盘
      manager.resume();

      expect(disk.writeCount()).toBe(baseline);
    });

    it('无存储层时应降级为纯内存模式而不抛错', () => {
      const memoryOnly = new SessionManager(
        () => createMockHistory(),
        () => createMockLoop(),
        undefined,
        () => false,
        vi.fn(),
      );

      expect(() => {
        memoryOnly.createCheckpoint('主目标');
        memoryOnly.logToolExecution(TOOL_RECORD);
        memoryOnly.pause('暂停', 'user');
      }).not.toThrow();
      expect(memoryOnly.getCheckpoint()!.completedToolCalls).toHaveLength(1);
    });
  });
});
