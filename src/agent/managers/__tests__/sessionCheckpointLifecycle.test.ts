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
import { AGENT_CONSTANTS } from '@/agent/constants.js';
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

  /** 一份字段齐全的合法检查点，各用例只挖掉待测的那一处（归一化组与 schemaVersion 组共用） */
  function intactCheckpoint(): Record<string, unknown> {
    return {
      sessionId: SESSION_ID,
      status: 'running',
      mainGoal: '主目标',
      currentGoal: '主目标',
      goalChangeSeq: 0,
      plan: [],
      role: { name: 'assistant' },
      standard: { quality: '', constraints: [] },
      resource: { documents: [], memories: [], context: '' },
      hotMemory: [],
      lastHeartbeat: Date.now(),
    };
  }

  /** 往假磁盘直接种入任意结构的检查点 JSON（绕过 createCheckpoint 的字段保证） */
  function seedDisk(raw: Record<string, unknown>): void {
    disk.store.saveCheckpoint!(SESSION_ID, JSON.stringify(raw));
  }

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

  describe('outbox 落盘时机（P3-1 批处理优化）', () => {
    it('工具执行记录应延迟到回合边界统一落盘', () => {
      manager.createCheckpoint('主目标');
      const writesBefore = disk.writeCount();

      manager.logToolExecution(TOOL_RECORD);

      // P3-1: logToolExecution 不再即时落盘，仅标记脏标记
      // 尚未 completeRound，磁盘不应有执行记录
      const writesAfterLog = disk.writeCount();
      expect(writesAfterLog).toBe(writesBefore);

      // 执行 completeRound 后，回合边界统一落盘
      manager.completeRound({ summary: '测试回合', toolCallCount: 1, assistantLength: 10 });
      const writesAfterRound = disk.writeCount();
      expect(writesAfterRound).toBeGreaterThan(writesAfterLog);

      const onDisk = disk.readDisk();
      expect(onDisk!.completedToolCalls).toHaveLength(1);
      expect(onDisk!.completedToolCalls![0]!.argsSignature).toBe('{"path":"a.ts"}');
    });

    it('副作用记录应延迟到回合边界统一落盘', () => {
      manager.createCheckpoint('主目标');
      manager.logToolExecution(TOOL_RECORD);

      // 先 completeRound 落盘第一轮（工具执行记录已在磁盘）
      manager.completeRound({ summary: '第一轮', toolCallCount: 1, assistantLength: 10 });

      manager.recordSideEffect('write_file', '{"path":"a.ts"}', {
        type: 'file_write',
        target: 'a.ts',
        description: '写入文件',
      });

      // P3-1: recordSideEffect 不再即时落盘，仅标记脏标记
      // 磁盘上已有的检查点应**没有**副作用记录
      const onDiskBefore = disk.readDisk();
      expect(onDiskBefore!.completedToolCalls![0]!.sideEffects).toBeUndefined();

      // 执行 completeRound 后，回合边界统一落盘，副作用记录出现
      manager.completeRound({ summary: '第二轮', toolCallCount: 0, assistantLength: 5 });
      const onDiskAfter = disk.readDisk();
      expect(onDiskAfter!.completedToolCalls![0]!.sideEffects).toHaveLength(1);
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

  /**
   * 反序列化归一化（T0-1 回归）
   *
   * 【本组存在的理由】
   * 同一份残缺检查点此前有两种崩法，无一是「降级但可用」：
   *   - loadPersistedCheckpoint 的裸 `JSON.parse(json) as SessionCheckpoint`——类型断言
   *     无运行时效力，残缺数据一路下沉，异常被外层 catch 吞成「加载失败」→ 用户整个
   *     会话静默消失；
   *   - restoreFromCheckpoint 直接信任外部对象，`hotMemory.map()` 抛 TypeError 且本函数
   *     无 catch → 崩进程。
   * 更早的 validateCheckpointIntegrity 注释声称「以默认值填充后继续」，实现却只 warn
   * 不填充——本组同时是那句注释的兑现凭证。
   *
   * 【断言原则】
   * 只经公共入口（loadPersistedCheckpoint / restoreFromCheckpoint）投喂残缺输入，
   * 不触碰 private 归一化方法：测私有实现会在重构时假红，测入口行为才锁得住契约。
   */
  describe('反序列化归一化（T0-1 回归）', () => {
    it('磁盘检查点缺少 lastHeartbeat 时应补为有限时间戳', () => {
      const raw = intactCheckpoint();
      raw.status = 'paused';
      delete raw.lastHeartbeat;
      seedDisk(raw);

      const loaded = manager.loadPersistedCheckpoint();

      // 修复前：undefined 一路存活 → isPauseTimedOut 的 `Date.now() - undefined` 得 NaN，
      // 任何比较恒 false → 僵尸暂停会话永不被超时清理。
      expect(loaded).not.toBeNull();
      expect(Number.isFinite(loaded!.lastHeartbeat)).toBe(true);
    });

    it('hotMemory 被截断成非数组时恢复应降级而非抛 TypeError', async () => {
      const raw = intactCheckpoint();
      raw.hotMemory = '存储截断后的残片';

      // 修复前：`checkpoint.hotMemory.map is not a function`，restoreFromCheckpoint
      // 无 catch → 异常穿透到调用栈顶。
      await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);

      expect(manager.getCheckpoint()!.hotMemory).toEqual([]);
    });

    it('error 侧车残缺时应补齐 cause，避免以 undefined 重建异常态', async () => {
      const raw = intactCheckpoint();
      raw.status = 'error';
      raw.error = { at: 1 }; // 缺 cause / recovered

      await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);

      const cp = manager.getCheckpoint()!;
      // 修复前：error 为 truthy 对象 → triggerError(undefined) → 异常态无可读原因
      expect(typeof cp.error?.cause).toBe('string');
      expect(cp.error!.cause.length).toBeGreaterThan(0);
      expect(cp.error!.recovered).toBe(false);
    });

    it('status 为越界值时应归一化为 running', async () => {
      const raw = intactCheckpoint();
      raw.status = 'zombie';

      await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);

      // 修复前：'zombie' 原样留存 → 三个状态分支全不匹配 → 检查点与状态机永久分叉
      expect(manager.getCheckpoint()!.status).toBe('running');
      expect(manager.stateMachine.status).toBe('running');
    });

    it('补齐的默认值不得在多个检查点之间共享引用', async () => {
      const first = intactCheckpoint();
      delete first.plan;
      await manager.restoreFromCheckpoint(first as unknown as SessionCheckpoint);
      manager.getCheckpoint()!.plan.push({
        id: 's1',
        description: '第一份检查点的步骤',
        status: 'pending',
        order: 0,
      });

      const second = intactCheckpoint();
      delete second.plan;
      await manager.restoreFromCheckpoint(second as unknown as SessionCheckpoint);

      // 默认值工厂若退化为共享常量，第二份检查点会凭空继承第一份的计划步骤
      expect(manager.getCheckpoint()!.plan).toHaveLength(0);
    });

    it('归一化补齐的默认值应与 createCheckpoint 的默认值同源', async () => {
      const fresh = manager.createCheckpoint('主目标');
      const createDefaults = {
        role: structuredClone(fresh.role),
        standard: structuredClone(fresh.standard),
        resource: structuredClone(fresh.resource),
      };

      const raw = intactCheckpoint();
      delete raw.role;
      delete raw.standard;
      delete raw.resource;
      await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);

      // 两条路径各写一套字面量默认值＝必然漂移的并列副本；此断言把它们钉在同一真理源上
      const restored = manager.getCheckpoint()!;
      expect(restored.role).toEqual(createDefaults.role);
      expect(restored.standard).toEqual(createDefaults.standard);
      expect(restored.resource).toEqual(createDefaults.resource);
    });

    it('磁盘内容为畸形 JSON 时应返回 null 且不污染运行时检查点', () => {
      disk.store.saveCheckpoint!(SESSION_ID, '{"sessionId":');

      expect(manager.loadPersistedCheckpoint()).toBeNull();
      expect(manager.getCheckpoint()).toBeNull();
    });
  });

  /**
   * 检查点 schemaVersion（T1-4 回归）
   *
   * 【本组存在的理由】
   * 检查点以 SQLite 单 TEXT 列全量覆盖存储，无版本号时字段重命名/跨版本升级
   * 必然爆（F2-1 的字段缺失场景会在下一次重命名爆发）。本组锁住两条契约：
   *   1. 新检查点必须携带当前 schemaVersion（未来升级迁移的锚点）；
   *   2. 旧内核产出的、无 schemaVersion 字段的检查点必须被补齐为当前版本、
   *      不报错、不丢弃用户工作（降级而非阻断）。
   */
  describe('检查点 schemaVersion（T1-4 回归）', () => {
    it('createCheckpoint 产出的检查点应携带当前 schemaVersion', () => {
      const cp = manager.createCheckpoint('主目标');

      expect(cp.schemaVersion).toBe(AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION);

      // 落盘快照同样应含 schemaVersion——迁移锚点必须落盘，否则重启后丢失
      const onDisk = disk.readDisk()!;
      expect(onDisk.schemaVersion).toBe(AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION);
    });

    it('无 schemaVersion 字段的旧检查点经 loadPersistedCheckpoint 应补为当前版本', () => {
      // intactCheckpoint() 模拟旧内核写出的完整检查点（不含 schemaVersion）
      const raw = intactCheckpoint();
      delete raw.schemaVersion; // 防御性：确保走「字段缺失」分支
      seedDisk(raw);

      const loaded = manager.loadPersistedCheckpoint();

      // 修复前：schemaVersion 为 undefined，未来重命名字段时无处比对版本
      expect(loaded).not.toBeNull();
      expect(loaded!.schemaVersion).toBe(AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION);
    });

    it('schemaVersion 高于当前内核版本的检查点应仍可按当前版本恢复（不阻断、不丢弃）', () => {
      const raw = intactCheckpoint();
      raw.schemaVersion = 999; // 来自更新版本的客户端
      seedDisk(raw);

      const loaded = manager.loadPersistedCheckpoint();

      // 首版仅 warn 不阻断：用户工作优先于严格版本校验
      expect(loaded).not.toBeNull();
      expect(loaded!.status).toBe('running');
      // 不强制降级为当前版本：保留原始版本号，交由上层迁移逻辑处理
      expect(loaded!.schemaVersion).toBe(999);
    });
  });
});
