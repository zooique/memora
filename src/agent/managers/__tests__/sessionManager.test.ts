/**
 * 单元测试：SessionManager 会话管理器
 *
 * 覆盖 SessionManager 全部 6 个公共方法：
 *   - switchSession：切换会话，isChatBusy 时抛 configError
 *   - forkSession：分叉会话，委托 history + applySessionToLoop + emitEvent
 *   - restoreMostRecentSession：恢复最近会话，多分支降级
 *   - restoreSession：恢复指定会话
 *   - loadSessionMessages：加载消息（会切换会话）
 *   - applySessionToLoop：private，通过 restore* 间接测试
 *
 * Mock 策略：5 个回调注入用 vi.fn()，history/loop 用 Partial<T> as T 单层断言
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import { SessionManager } from '@/agent/managers/sessionManager.js';
import type { AgentForkResult } from '@/agent/managers/sessionManager.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';
import { AGENT_CONSTANTS } from '@/agent/constants.js';

/**
 * 创建 Mock MessageHistory
 * 仅实现 SessionManager 用到的方法：switchSession / forkSession / loadSessionMessages / currentSessionName
 */
function createMockHistory(overrides: Partial<MessageHistory> = {}): MessageHistory {
  return {
    switchSession: vi.fn().mockReturnValue('2026-06-27-main'),
    forkSession: vi.fn().mockReturnValue({
      newSession: 'main-b1',
      date: '2026-06-27',
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-06-27T10:00:00Z' },
        { role: 'assistant', content: 'hi', timestamp: '2026-06-27T10:00:01Z' },
      ],
    }),
    loadSessionMessages: vi.fn().mockResolvedValue([]),
    currentSessionName: '2026-06-27-main',
    ...overrides,
  } as unknown as MessageHistory;
}

/**
 * 创建 Mock AgentLoop
 * 仅实现 SessionManager 用到的方法：restoreHistory
 */
function createMockLoop(overrides: Partial<AgentLoop> = {}): AgentLoop {
  return {
    restoreHistory: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as AgentLoop;
}

/**
 * 创建 Mock ISessionStore
 */
function createMockSessionStore(overrides: Partial<ISessionStore> = {}): ISessionStore {
  return {
    appendMessage: vi.fn(),
    loadMessages: vi.fn().mockReturnValue([]),
    listSessions: vi.fn().mockReturnValue([]),
    copySession: vi.fn(),
    saveCheckpoint: vi.fn(),
    loadCheckpoint: vi.fn().mockReturnValue(null),
    deleteCheckpoint: vi.fn(),
    ...overrides,
  };
}

describe('SessionManager', () => {
  let history: MessageHistory;
  let loop: AgentLoop;
  let sessionStore: ISessionStore | undefined;
  // 用 vi.MockedFunction<T> 让变量同时具备函数签名和 mock 方法，
  // 避免 vi.fn() 推断为 Mock<Procedure | Constructable> 与具体函数签名不兼容
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

  describe('constructor', () => {
    it('应正确接收 5 个回调注入', () => {
      // 通过后续方法调用验证回调已存储
      manager.switchSession('test');
      expect(history.switchSession).toHaveBeenCalledWith('test');
    });
  });

  describe('switchSession', () => {
    it('对话繁忙时应抛 configError', () => {
      isChatBusy.mockReturnValue(true);
      expect(() => manager.switchSession('new')).toThrow('对话繁忙');
      expect(history.switchSession).not.toHaveBeenCalled();
    });

    it('非繁忙时应委托 history.switchSession', () => {
      const result = manager.switchSession('new-session');
      expect(history.switchSession).toHaveBeenCalledWith('new-session');
      expect(result).toBe('2026-06-27-main');
    });

    it('应同步返回（不引入 async 包装）', () => {
      const result = manager.switchSession('x');
      // 同步调用应直接返回字符串，非 Promise
      expect(typeof result).toBe('string');
    });
  });

  describe('forkSession', () => {
    it('对话繁忙时应抛 configError', () => {
      isChatBusy.mockReturnValue(true);
      expect(() => manager.forkSession()).toThrow('对话繁忙');
      expect(history.forkSession).not.toHaveBeenCalled();
    });

    it('非繁忙时应委托 history.forkSession', () => {
      manager.forkSession();
      expect(history.forkSession).toHaveBeenCalledWith(undefined);
    });

    it('应将分叉消息恢复到 AgentLoop 工作记忆', () => {
      manager.forkSession();
      expect(loop.restoreHistory).toHaveBeenCalledTimes(1);
      // 验证 SessionMessage 被转换为 Message（无 timestamp 字段）
      const restored = (loop.restoreHistory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(restored).toHaveLength(2);
      expect(restored[0]).toEqual({ role: 'user', content: 'hello' });
      expect(restored[1]).toEqual({ role: 'assistant', content: 'hi' });
    });

    it('应发射 sessionForked 事件，包含 from/to/messageCount', () => {
      manager.forkSession();
      expect(emitEvent).toHaveBeenCalledWith('sessionForked', {
        from: '2026-06-27-main',
        to: '2026-06-27-main-b1',
        messageCount: 2,
      });
    });

    it('应返回 { newSession, messageCount } 简化封装', () => {
      const result: AgentForkResult = manager.forkSession();
      expect(result).toEqual({
        newSession: 'main-b1',
        messageCount: 2,
      });
    });

    it('自定义 targetSession 应透传给 history.forkSession', () => {
      manager.forkSession('custom-branch');
      expect(history.forkSession).toHaveBeenCalledWith('custom-branch');
    });
  });

  describe('restoreMostRecentSession', () => {
    it('对话繁忙时应抛 configError', async () => {
      isChatBusy.mockReturnValue(true);
      await expect(manager.restoreMostRecentSession()).rejects.toThrow('对话繁忙');
    });

    it('未注入 sessionStore 应返回 0', async () => {
      // 重建 manager 不带 sessionStore
      const mgr = new SessionManager(() => history, () => loop, undefined, isChatBusy, emitEvent);
      const count = await mgr.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('sessions 为空应返回 0', async () => {
      (sessionStore as ISessionStore).listSessions = vi.fn().mockReturnValue([]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('preferredSession 匹配今天应优先选择', async () => {
      vi.setSystemTime(new Date('2026-06-27T15:00:00Z'));
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-26-main', '2026-06-27-main']);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([
        { role: 'user', content: 'msg1', timestamp: '2026-06-27T10:00:00Z' },
      ]);
      const count = await manager.restoreMostRecentSession('main');
      expect(count).toBe(1);
      expect(sessionStore!.loadMessages).toHaveBeenCalledWith('2026-06-27', 'main');
    });

    it('preferredSession 不匹配时应取最后一个会话', async () => {
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-26-main', '2026-06-27-other']);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([
        { role: 'user', content: 'fallback', timestamp: '2026-06-27T10:00:00Z' },
      ]);
      const count = await manager.restoreMostRecentSession('main');
      expect(count).toBe(1);
      expect(sessionStore!.loadMessages).toHaveBeenCalledWith('2026-06-27', 'other');
    });

    it('会话标识格式不匹配（无日期前缀）应返回 0', async () => {
      (sessionStore as ISessionStore).listSessions = vi.fn().mockReturnValue(['invalid-name']);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('加载的消息为空应返回 0', async () => {
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-27-main']);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('正常恢复应将消息恢复到 AgentLoop', async () => {
      vi.setSystemTime(new Date('2026-06-27T15:00:00Z'));
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-27-main']);
      const messages: SessionMessage[] = [
        { role: 'user', content: 'u1', timestamp: '2026-06-27T10:00:00Z' },
        { role: 'assistant', content: 'a1', timestamp: '2026-06-27T10:00:01Z' },
        { role: 'system', content: 's1', timestamp: '2026-06-27T10:00:02Z' },
      ];
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue(messages);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(3);
      expect(loop.restoreHistory).toHaveBeenCalledTimes(1);
      // 验证 SessionMessage 被转换为 Message（保留所有角色，restoreHistory 自己过滤 system）
      const restored = (loop.restoreHistory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(restored).toHaveLength(3);
      expect(restored[0]).toEqual({ role: 'user', content: 'u1' });
    });

    it('默认 preferredSession 应为 main', async () => {
      vi.setSystemTime(new Date('2026-06-27T15:00:00Z'));
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-27-main']);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([
        { role: 'user', content: 'x', timestamp: '2026-06-27T10:00:00Z' },
      ]);
      await manager.restoreMostRecentSession(); // 不传参
      expect(sessionStore!.loadMessages).toHaveBeenCalledWith('2026-06-27', 'main');
    });

    it('跨日场景：preferredSession 匹配今天的会话优先于昨天的', async () => {
      vi.setSystemTime(new Date('2026-06-28T03:00:00Z')); // UTC 6/28 凌晨
      (sessionStore as ISessionStore).listSessions = vi
        .fn()
        .mockReturnValue(['2026-06-27-main', '2026-06-28-main']);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([
        { role: 'user', content: 'today', timestamp: '2026-06-28T03:00:00Z' },
      ]);
      await manager.restoreMostRecentSession('main');
      expect(sessionStore!.loadMessages).toHaveBeenCalledWith('2026-06-28', 'main');
    });
  });

  describe('restoreSession', () => {
    it('对话繁忙时应抛 configError', async () => {
      isChatBusy.mockReturnValue(true);
      await expect(manager.restoreSession('2026-06-27', 'main')).rejects.toThrow('对话繁忙');
    });

    it('history 返回空数组应返回 0', async () => {
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue([]);
      const count = await manager.restoreSession('2026-06-27', 'main');
      expect(count).toBe(0);
      expect(loop.restoreHistory).not.toHaveBeenCalled();
    });

    it('正常恢复应返回消息数并调用 loop.restoreHistory', async () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'u', timestamp: '2026-06-27T10:00:00Z' },
        { role: 'assistant', content: 'a', timestamp: '2026-06-27T10:00:01Z' },
      ];
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(messages);
      const count = await manager.restoreSession('2026-06-27', 'main');
      expect(count).toBe(2);
      expect(history.loadSessionMessages).toHaveBeenCalledWith('2026-06-27', 'main');
      expect(loop.restoreHistory).toHaveBeenCalledTimes(1);
    });

    it('应将 SessionMessage 转换为 Message（去除 timestamp）', async () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'hello', timestamp: '2026-06-27T10:00:00Z' },
      ];
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(messages);
      await manager.restoreSession('2026-06-27', 'main');
      const restored = (loop.restoreHistory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(restored[0]).toEqual({ role: 'user', content: 'hello' });
      expect(restored[0].timestamp).toBeUndefined();
    });
  });

  describe('loadSessionMessages', () => {
    it('对话繁忙时应抛 configError', async () => {
      isChatBusy.mockReturnValue(true);
      await expect(manager.loadSessionMessages('2026-06-27', 'main')).rejects.toThrow('对话繁忙');
    });

    it('非繁忙时应委托 history.loadSessionMessages', async () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'x', timestamp: '2026-06-27T10:00:00Z' },
      ];
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(messages);
      const result = await manager.loadSessionMessages('2026-06-27', 'main');
      expect(result).toEqual(messages);
      expect(history.loadSessionMessages).toHaveBeenCalledWith('2026-06-27', 'main');
    });

    it('应返回空数组（history 返回空）', async () => {
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue([]);
      const result = await manager.loadSessionMessages('2026-06-27', 'main');
      expect(result).toEqual([]);
    });
  });

  describe('applySessionToLoop（间接测试）', () => {
    it('应过滤掉 timestamp 字段，只保留 role 和 content', async () => {
      const messages: SessionMessage[] = [
        { role: 'user', content: 'u', timestamp: '2026-06-27T10:00:00Z' },
        { role: 'assistant', content: 'a', timestamp: '2026-06-27T10:00:01Z' },
      ];
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(messages);
      await manager.restoreSession('2026-06-27', 'main');
      const restored = (loop.restoreHistory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(restored).toEqual([
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' },
      ]);
    });

    it('应保留 system 角色消息（restoreHistory 自己负责过滤）', async () => {
      const messages: SessionMessage[] = [
        { role: 'system', content: 'sys', timestamp: '2026-06-27T10:00:00Z' },
        { role: 'user', content: 'u', timestamp: '2026-06-27T10:00:01Z' },
      ];
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(messages);
      await manager.restoreSession('2026-06-27', 'main');
      const restored = (loop.restoreHistory as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      // applySessionToLoop 不过滤 system，全部传给 loop
      expect(restored).toHaveLength(2);
      expect(restored[0]).toEqual({ role: 'system', content: 'sys' });
    });
  });

  describe('getHistory/getLoop 回调语义', () => {
    it('history 引用变更后应获取最新实例', () => {
      // 模拟 Agent 重建 history：getHistory 回调每次返回新引用
      let currentHistory = history;
      const mgr = new SessionManager(
        () => currentHistory,
        () => loop,
        sessionStore,
        isChatBusy,
        emitEvent,
      );
      const newHistory = createMockHistory({
        switchSession: vi.fn().mockReturnValue('2026-06-27-new'),
      });
      currentHistory = newHistory;
      const result = mgr.switchSession('test');
      expect(newHistory.switchSession).toHaveBeenCalledWith('test');
      expect(result).toBe('2026-06-27-new');
    });

    it('loop 引用变更后应获取最新实例', async () => {
      let currentLoop = loop;
      const mgr = new SessionManager(
        () => history,
        () => currentLoop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );
      const newLoop = createMockLoop({ restoreHistory: vi.fn() });
      currentLoop = newLoop;
      (history.loadSessionMessages as ReturnType<typeof vi.fn>) = vi.fn().mockResolvedValue([
        { role: 'user', content: 'x', timestamp: '2026-06-27T10:00:00Z' },
      ]);
      await mgr.restoreSession('2026-06-27', 'main');
      expect(newLoop.restoreHistory).toHaveBeenCalledTimes(1);
    });
  });

  // ── P0-2：运行时暂停超时检测 ──────────────────────────

  describe('pauseTimeoutMonitor', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('暂停后超时，定时器应自动清理检查点并重置状态机', () => {
      // 暂停会话，启动超时检测定时器
      manager.pause('测试暂停', 'user');

      // 验证暂停成功
      expect(manager.stateMachine.status).toBe('paused');

      // 验证检查点已创建
      expect(manager.getCheckpoint()).not.toBeNull();

      // 快进时间到超时阈值之前（29 分钟），应不触发超时清理
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS - 60_000);
      expect(manager.getCheckpoint()).not.toBeNull();

      // 快进时间超过超时阈值（再快进 2 分钟，确保超过 30 分钟）
      vi.advanceTimersByTime(120_000);
      expect(manager.getCheckpoint()).toBeNull();
      expect(manager.stateMachine.status).toBe('running');
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: expect.any(String),
        pauseDuration: expect.any(Number),
      }));
    });

    it('暂停后在超时前恢复，应不触发超时清理', () => {
      manager.pause('测试暂停', 'user');
      expect(manager.stateMachine.status).toBe('paused');

      // 恢复会话（应在超时前）
      manager.resume();
      expect(manager.stateMachine.status).toBe('running');

      // 快进时间超过超时阈值，应不触发超时清理
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);
      // 检查点应存在（恢复后保留）
      // 注意：resume() 不会清除检查点，只是标记为 running
      expect(manager.getCheckpoint()).not.toBeNull();
      // 不应发射超时事件
      expect(emitEvent).not.toHaveBeenCalledWith('sessionPauseTimedOut', expect.anything());
    });

    it('destroy 应清理定时器，使其不触发回调', () => {
      manager.pause('测试暂停', 'user');
      expect(manager.stateMachine.status).toBe('paused');

      // 销毁 SessionManager，清理定时器
      manager.destroy();

      // 快进时间超过超时阈值，应不触发超时清理（定时器已被清除）
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);
      expect(manager.getCheckpoint()).not.toBeNull();
      expect(emitEvent).not.toHaveBeenCalledWith('sessionPauseTimedOut', expect.anything());
    });

    it('连续 pause 不重复启动定时器', () => {
      // 连续两次 pause（第二次应该不会启动新的定时器，因为状态机状态不匹配）
      const firstResult = manager.pause('第一次暂停', 'user');
      expect(firstResult).toBe(true);

      // 状态机已经是 paused，第二次 pause 应返回 false
      const secondResult = manager.pause('第二次暂停', 'user');
      expect(secondResult).toBe(false);

      // 快进时间超过超时阈值，应触发一次超时清理
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);

      // 验证超时事件只发射一次（只启动了一个定时器）
      expect(emitEvent).toHaveBeenCalledTimes(1 + 1); // sessionPaused + sessionPauseTimedOut
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.anything());
    });
  });

  // ── P1-2：goalVersion 漂移强制暂停 ──────────────────────

  describe('goalVersion drift auto-pause', () => {
    /**
     * 辅助方法：创建带有 mainGoal 的检查点
     * 首次调用 updateGoal 会创建检查点（返回 null），第二次调用才会触发一致性校验
     */
    function setupCheckpointWithGoal(mainGoal: string): void {
      // 第一次调用：创建检查点，mainGoal 设为目标值
      const result = manager.updateGoal(mainGoal);
      expect(result).toBeNull();
      // 状态机应保持 running
      expect(manager.stateMachine.status).toBe('running');
    }

    it('drift 级别时应自动暂停', () => {
      // 用长文本确保使用 Jaccard 相似度
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const driftedGoal = '今天纽约的天气怎么样适合出行吗';

      setupCheckpointWithGoal(mainGoal);

      // 第二次调用 updateGoal，检测到漂移应自动暂停
      const result = manager.updateGoal(driftedGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('drift');
      // 状态机应为 paused
      expect(manager.stateMachine.status).toBe('paused');
    });

    it('confirm 级别时应不自动暂停', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const confirmGoal = '编写一个计算器应用程序支持加减乘除运算';

      setupCheckpointWithGoal(mainGoal);

      const result = manager.updateGoal(confirmGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('confirm');
      // confirm 级别不应暂停
      expect(manager.stateMachine.status).toBe('running');
    });

    it('same 级别时应不触发任何事件', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';

      setupCheckpointWithGoal(mainGoal);

      const result = manager.updateGoal(mainGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('same');
      // same 级别不应暂停
      expect(manager.stateMachine.status).toBe('running');
      // 不应发射 goalDriftDetected 事件
      expect(emitEvent).not.toHaveBeenCalledWith('goalDriftDetected', expect.anything());
    });

    it('自动暂停应使用低风险（lowRisk=true），不增加连续暂停计数', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const driftedGoal = '今天纽约的天气怎么样适合出行吗';

      setupCheckpointWithGoal(mainGoal);
      expect(manager.getConsecutivePauseCount()).toBe(0);

      const result = manager.updateGoal(driftedGoal);
      expect(result!.level).toBe('drift');
      // 低风险暂停不应增加连续暂停计数
      expect(manager.getConsecutivePauseCount()).toBe(0);
    });

    it('无检查点时 updateGoal 不触发暂停', () => {
      // 首次调用 updateGoal，checkpoint 为 null，应创建检查点并返回 null
      const result = manager.updateGoal('新的目标');
      expect(result).toBeNull();
      // 不应暂停
      expect(manager.stateMachine.status).toBe('running');
    });

    it('drift 暂停时应发射 goalDriftDetected 事件', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const driftedGoal = '今天纽约的天气怎么样适合出行吗';

      setupCheckpointWithGoal(mainGoal);

      manager.updateGoal(driftedGoal);
      expect(emitEvent).toHaveBeenCalledWith('goalDriftDetected', expect.objectContaining({
        mainGoal,
        newGoal: driftedGoal,
        level: 'drift',
      }));
    });
  });

  // ── P2-1：consecutivePauseCount 时间衰减 ────────────────

  describe('consecutivePauseDecay (P2-1)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('暂停时间戳超过衰减窗口后应自动衰减', () => {
      // 第一次高风险暂停
      manager.pause('第一次暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 快进时间到衰减窗口之前（59 分钟），计数应仍为 1
      // 注意：暂停超时检测（30 分钟）可能在此时已触发清理检查点，
      // 但连续暂停计数的时间戳不受影响，衰减窗口为 60 分钟
      vi.advanceTimersByTime(3_600_000 - 60_000);
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 快进时间超过衰减窗口（再快进 2 分钟），旧暂停应衰减
      vi.advanceTimersByTime(120_000);
      expect(manager.getConsecutivePauseCount()).toBe(0);
    });

    it('多次暂停按时间衰减，只有窗口内的计数', () => {
      // 第一次暂停
      manager.pause('第一次暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 快进 10 分钟，恢复再暂停（模拟第二次暂停）
      vi.advanceTimersByTime(10 * 60 * 1000);
      manager.resume();
      manager.pause('第二次暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(2);

      // 快进 55 分钟，第一次暂停过期（总计 65 分钟），只剩第二次
      vi.advanceTimersByTime(55 * 60 * 1000);
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 再快进 30 分钟，第二次暂停也过期
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(manager.getConsecutivePauseCount()).toBe(0);
    });

    it('低风险暂停不记录时间戳，不影响衰减', () => {
      // 高风险暂停
      manager.pause('高风险暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 恢复后低风险暂停
      manager.resume();
      manager.pause('低风险暂停', 'system', true);
      expect(manager.getConsecutivePauseCount()).toBe(1); // 仍为 1

      // 快进时间超过衰减窗口，高风险暂停过期
      vi.advanceTimersByTime(3_600_000 + 60_000);
      expect(manager.getConsecutivePauseCount()).toBe(0);
    });

    it('resetConsecutivePauseCount 应清空所有时间戳', () => {
      manager.pause('第一次暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 恢复再暂停第二次
      manager.resume();
      manager.pause('第二次暂停', 'user');
      expect(manager.getConsecutivePauseCount()).toBe(2);

      // 重置
      manager.resetConsecutivePauseCount();
      expect(manager.getConsecutivePauseCount()).toBe(0);
      expect(manager.isPauseLimitReached()).toBe(false);
    });

    it('isPauseLimitReached 应基于衰减后的计数', () => {
      expect(manager.isPauseLimitReached()).toBe(false);

      manager.pause('第一次暂停', 'user');
      expect(manager.isPauseLimitReached()).toBe(false); // 1 < 2

      // 恢复再暂停第二次
      manager.resume();
      manager.pause('第二次暂停', 'user');
      expect(manager.isPauseLimitReached()).toBe(true); // 2 >= 2

      // 快进时间超过衰减窗口
      vi.advanceTimersByTime(3_600_000 + 60_000);
      expect(manager.isPauseLimitReached()).toBe(false); // 衰减后为 0
    });
  });
});
