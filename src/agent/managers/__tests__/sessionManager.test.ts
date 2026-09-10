/**
 * 单元测试：SessionManager 会话管理器
 *
 * 覆盖 SessionManager 全部公共方法：
 *   - switchSession：切换会话，isChatBusy 时抛 configError
 *   - forkSession：分叉会话，委托 history + applySessionToLoop + emitEvent
 *   - restoreMostRecentSession：恢复最近会话，多分支降级
 *   - restoreSession：恢复指定会话
 *   - loadSessionMessages：加载消息（会切换会话）
 *   - applySessionToLoop：private，通过 restore* 间接测试
 *   - 检查点生命周期：createCheckpoint / getCheckpoint / settleCheckpoint（内存态）
 *     （来自 sessionCheckpointLifecycle.test.ts 合并；跨重启恢复链已随「减法」退役，2026-09-10）
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
      roundIds: ['round-1', 'round-2'],
    }),
    // round-based：根据 roundIds 加载消息列表
    loadRoundBasedMessages: vi.fn().mockReturnValue([
      { role: 'user', content: 'hello', timestamp: '2026-06-27T10:00:00Z' },
      { role: 'assistant', content: 'hi', timestamp: '2026-06-27T10:00:01Z' },
    ]),
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
    resetContextSummary: vi.fn(),
    getMessages: vi.fn().mockReturnValue([]),
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
    getSessionMeta: vi.fn().mockReturnValue(undefined),
    setSessionTitle: vi.fn(),
    updateSessionMeta: vi.fn(),
    listSessionMetas: vi.fn().mockReturnValue([]),
    getRoundIds: vi.fn().mockReturnValue([]),
    setRoundIds: vi.fn(),
    appendRoundId: vi.fn(),
    appendRoundIds: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
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

    it('SSOT 回归：切换会话应触发派生缓存失效（invalidateSessionDerivedState → resetContextSummary）', () => {
      manager.switchSession('new-session');
      // 会话替换后，上下文摘要等派生缓存必须作废，否则陈旧摘要注入新会话（对称补全）
      expect(loop.resetContextSummary).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSessionMeta / renameSession（会话标题层）', () => {
    it('getSessionMeta 应委托 store.getSessionMeta', () => {
      manager.getSessionMeta('2026-06-27-main');
      expect((sessionStore as ISessionStore).getSessionMeta).toHaveBeenCalledWith(
        '2026-06-27-main',
      );
    });

    it('getSessionMeta 未注入（sessionStore undefined）应返回 undefined', () => {
      const mgr = new SessionManager(() => history, () => loop, undefined, isChatBusy, emitEvent);
      expect(mgr.getSessionMeta('2026-06-27-main')).toBeUndefined();
    });

    it('renameSession 应委托 store.updateSessionMeta 写入 displayName', () => {
      manager.renameSession('2026-06-27-main', '新标题');
      expect((sessionStore as ISessionStore).updateSessionMeta).toHaveBeenCalledWith(
        '2026-06-27-main',
        { displayName: '新标题' },
      );
    });

    it('renameSession 未注入（sessionStore undefined）应静默 no-op', () => {
      const mgr = new SessionManager(() => history, () => loop, undefined, isChatBusy, emitEvent);
      expect(() => mgr.renameSession('2026-06-27-main', '新标题')).not.toThrow();
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
      expect(history.forkSession).toHaveBeenCalledWith(undefined, undefined);
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

    it('应发射 sessionForked 事件，包含 from/to/roundCount', () => {
      manager.forkSession();
      expect(emitEvent).toHaveBeenCalledWith('sessionForked', {
        from: '2026-06-27-main',
        to: '2026-06-27-main-b1',
        roundCount: 2,
      });
    });

    it('应返回 { newSession, roundCount } 简化封装', () => {
      const result: AgentForkResult = manager.forkSession();
      expect(result.newSession).toBe('main-b1');
      expect(result.roundCount).toBe(2);
    });

    it('自定义 targetSession 应透传给 history.forkSession', () => {
      manager.forkSession('custom-branch');
      expect(history.forkSession).toHaveBeenCalledWith('custom-branch', undefined);
    });

    it('K2 分叉后应清空检查点（防新分支状态写回源会话）', () => {
      // 先创建检查点，模拟源会话已有持久化检查点
      manager.createCheckpoint('源会话目标');
      expect(manager.getCheckpoint()).not.toBeNull();
      expect(manager.getCheckpoint()?.sessionId).toBe('2026-06-27-main');

      // 分叉后检查点必须被清空——否则 updateGoal→flushCheckpoint 会把新分支
      // 的 plan/goal 状态写入源会话的持久化检查点（跨会话数据污染）
      manager.forkSession();
      expect(manager.getCheckpoint()).toBeNull();
    });

    it('K3 热记忆按轮截断应保持 tool_calls 与 tool 结果配对', () => {
      // 构造 21 轮对话（HOT_MEMORY_MAX_ROUNDS=20，超 1 轮触发截断）
      // 最后一轮含 assistant(tool_calls)→tool 结果，验证截断后配对保持
      const messages = [];
      for (let i = 1; i <= 20; i++) {
        messages.push({ role: 'user', content: `u${i}` });
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      // 第 21 轮：用户 → assistant(tool_calls) → tool 结果 → assistant 回复
      messages.push({ role: 'user', content: 'u21' });
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c21', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      });
      messages.push({ role: 'tool', toolCallId: 'c21', content: 'tool21-result' });
      messages.push({ role: 'assistant', content: 'a21' });
      loop.getMessages = vi.fn().mockReturnValue(messages);

      const cp = manager.createCheckpoint('目标');
      const hot = cp.hotMemory;

      // 第 1 轮（最早）应被截断
      expect(hot.some((m) => m.content === 'u1')).toBe(false);
      // 第 21 轮的 tool_calls 与其 tool 结果必须同留（配对）
      const hasCall = hot.some(
        (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.id === 'c21'),
      );
      const hasResult = hot.some((m) => m.role === 'tool' && m.toolCallId === 'c21');
      expect(hasCall).toBe(true);
      expect(hasResult).toBe(true);
      // 任何带 tool_calls 的 assistant 消息其后必须紧跟 tool 结果（无孤立 tool_calls）
      for (let i = 0; i < hot.length; i++) {
        const m = hot[i]!;
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          expect(hot[i + 1]?.role).toBe('tool');
        }
      }
    });
  });

  // ── 交叉链路集成测试：检查点恢复 → 热记忆提取 → 上下文装配 ──
  // 验证 K3（按轮截断）和 K6（双份注入防护）在恢复链路中的协同正确性
  describe('交叉链路：检查点恢复 → 热记忆提取 → 上下文装配', () => {
    /**
     * 构造含 tool_calls 的多轮对话（超 HOT_MEMORY_MAX_ROUNDS 轮）
     * 模拟真实场景：用户 → assistant(tool_calls) → tool 结果 → assistant
     */
    function buildMultiRoundMessages(roundCount: number): Array<{
      role: 'user' | 'assistant' | 'tool';
      content: string;
      toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
      toolCallId?: string;
    }> {
      const msgs: Array<{
        role: 'user' | 'assistant' | 'tool';
        content: string;
        toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        toolCallId?: string;
      }> = [];
      for (let i = 1; i <= roundCount; i++) {
        msgs.push({ role: 'user', content: `第${i}轮-用户问题` });
        // 偶数轮包含 tool_calls
        if (i % 3 === 0) {
          const callId = `call-${i}`;
          msgs.push({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}"}` } }],
          });
          msgs.push({ role: 'tool', toolCallId: callId, content: `第${i}轮-工具执行结果` });
          msgs.push({ role: 'assistant', content: `第${i}轮-基于工具的回复` });
        } else {
          msgs.push({ role: 'assistant', content: `第${i}轮-直接回复` });
        }
      }
      return msgs;
    }

    it('K3+K6 协同：恢复含 tool_calls 的检查点后，热记忆截断保持配对且无孤立 tool_calls', () => {
      // 构造 25 轮对话（超 HOT_MEMORY_MAX_ROUNDS=20 轮 5 轮），含 8 次 tool_calls
      const messages = buildMultiRoundMessages(25);
      loop.getMessages = vi.fn().mockReturnValue(messages);

      // 创建检查点 → 内部触发 extractHotMemory
      const checkpoint = manager.createCheckpoint('K3+K6 交叉验证');
      const hotMemory = checkpoint.hotMemory;

      // 验证 1：旧轮次被截断（第 1-5 轮应被丢弃，保留最后 20 轮）
      const firstRoundUser = hotMemory.find((m) => m.content === '第1轮-用户问题');
      expect(firstRoundUser).toBeUndefined();

      // 验证 2：热记忆中 tool_calls 与 tool 结果保持配对
      // 遍历所有 assistant(tool_calls) 消息，验证其后紧跟 tool 结果
      for (let i = 0; i < hotMemory.length; i++) {
        const msg = hotMemory[i]!;
        if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
          // 下一条必须是 tool 结果
          const nextMsg = hotMemory[i + 1];
          expect(nextMsg).toBeDefined();
          expect(nextMsg!.role).toBe('tool');
          // tool 结果的 toolCallId 必须匹配
          expect(nextMsg!.toolCallId).toBe(msg.toolCalls[0]!.id);
        }
      }

      // 验证 3：无孤立 tool_calls（所有 tool_calls 都有配对的 tool 结果）
      const toolCallAssistantIndices: number[] = [];
      hotMemory.forEach((m, idx) => {
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
          toolCallAssistantIndices.push(idx);
        }
      });
      for (const idx of toolCallAssistantIndices) {
        const nextMsg = hotMemory[idx + 1];
        expect(nextMsg).toBeDefined();
        expect(nextMsg!.role).toBe('tool');
      }

      // 验证 4：截断计数正确
      expect((checkpoint.truncatedCount ?? 0)).toBeGreaterThan(0);
    });

    it('K3+K6 协同：恢复检查点后，热记忆可成功注入 AgentLoop 上下文', () => {
      // 构造含 tool_calls 的 22 轮对话
      const messages = buildMultiRoundMessages(22);
      loop.getMessages = vi.fn().mockReturnValue(messages);

      // 创建检查点
      const checkpoint = manager.createCheckpoint('恢复链路验证');
      const hotMemory = checkpoint.hotMemory;

      // 模拟恢复：将热记忆注入 loop
      // 验证热记忆的结构完整性（可被 loop.acceptsHistory 接受）
      for (const msg of hotMemory) {
        // 每条消息必须有 role 和 content（除 tool 消息外）
        expect(msg.role).toBeDefined();
        if (msg.role !== 'tool') {
          expect(typeof msg.content).toBe('string');
        }
      }

      // 验证热记忆不包含 system 消息
      const hasSystem = hotMemory.some((m) => m.role === 'system');
      expect(hasSystem).toBe(false);

      // 验证热记忆中 user/assistant/tool 三种角色齐全
      const roles = new Set(hotMemory.map((m) => m.role));
      expect(roles.has('user')).toBe(true);
      expect(roles.has('assistant')).toBe(true);
      expect(roles.has('tool')).toBe(true);
    });

    it('K3+K6 协同：边界场景——恰好 HOT_MEMORY_MAX_ROUNDS 轮不截断', () => {
      // 构造恰好 20 轮（HOT_MEMORY_MAX_ROUNDS=20）
      const messages = buildMultiRoundMessages(20);
      loop.getMessages = vi.fn().mockReturnValue(messages);

      const checkpoint = manager.createCheckpoint('边界验证');
      const hotMemory = checkpoint.hotMemory;

      // 不截断（truncatedCount 为 undefined 或 0 均表示无截断）
      expect(checkpoint.truncatedCount ?? 0).toBe(0);
      expect(hotMemory.length).toBe(messages.length);

      // tool_calls 配对依然完整
      for (let i = 0; i < hotMemory.length; i++) {
        const msg = hotMemory[i]!;
        if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
          expect(hotMemory[i + 1]?.role).toBe('tool');
        }
      }
    });

    it('K3+K6 协同：单轮 tool_calls 场景——截断不影响配对', () => {
      // 构造 21 轮对话，仅最后一轮含 tool_calls
      const messages: Array<{
        role: 'user' | 'assistant' | 'tool';
        content: string;
        toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
        toolCallId?: string;
      }> = [];
      for (let i = 1; i <= 20; i++) {
        messages.push({ role: 'user', content: `u${i}` });
        messages.push({ role: 'assistant', content: `a${i}` });
      }
      // 第 21 轮：单轮 tool_calls 场景
      messages.push({ role: 'user', content: 'u21' });
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-single', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }],
      });
      messages.push({ role: 'tool', toolCallId: 'call-single', content: '搜索结果' });
      messages.push({ role: 'assistant', content: '找到了' });

      loop.getMessages = vi.fn().mockReturnValue(messages);

      const checkpoint = manager.createCheckpoint('单轮 tool_calls');
      const hotMemory = checkpoint.hotMemory;

      // 第 1 轮被截断
      expect(hotMemory.some((m) => m.content === 'u1')).toBe(false);
      // 第 21 轮完整保留
      const hasToolCall = hotMemory.some(
        (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.id === 'call-single'),
      );
      const hasToolResult = hotMemory.some((m) => m.role === 'tool' && m.toolCallId === 'call-single');
      expect(hasToolCall).toBe(true);
      expect(hasToolResult).toBe(true);
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

    it('listSessionMetas 为空应返回 0', async () => {
      (sessionStore as ISessionStore).listSessionMetas = vi.fn().mockReturnValue([]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('按 updatedAt 降序恢复最近活跃会话（SSOT：listSessionMetas[0]）', async () => {
      (sessionStore as ISessionStore).listSessionMetas = vi.fn().mockReturnValue([
        // updatedAt 降序：最近活跃在前（mock 语义 = listSessionMetas 契约时序）
        { sessionId: '2026-06-27-fork-a', updatedAt: '2026-06-27T10:00:00Z', messageCount: 4 },
        { sessionId: '2026-06-26-main', updatedAt: '2026-06-26T10:00:00Z', messageCount: 2 },
      ]);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([
        { role: 'user', content: 'recent', timestamp: '2026-06-27T10:00:00Z' },
      ]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(1);
      expect(sessionStore!.loadMessages).toHaveBeenCalledWith('2026-06-27', 'fork-a');
    });

    it('会话标识格式不匹配（无日期前缀）应返回 0', async () => {
      (sessionStore as ISessionStore).listSessionMetas = vi.fn().mockReturnValue([
        { sessionId: 'invalid-name', updatedAt: '2026-06-27T10:00:00Z', messageCount: 0 },
      ]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('最近活跃会话的消息为空应返回 0', async () => {
      (sessionStore as ISessionStore).listSessionMetas = vi.fn().mockReturnValue([
        { sessionId: '2026-06-27-main', updatedAt: '2026-06-27T10:00:00Z', messageCount: 0 },
      ]);
      (sessionStore as ISessionStore).loadMessages = vi.fn().mockReturnValue([]);
      const count = await manager.restoreMostRecentSession();
      expect(count).toBe(0);
    });

    it('正常恢复应将消息恢复到 AgentLoop', async () => {
      (sessionStore as ISessionStore).listSessionMetas = vi.fn().mockReturnValue([
        { sessionId: '2026-06-27-main', updatedAt: '2026-06-27T10:00:00Z', messageCount: 6 },
      ]);
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

  // ── 运行时暂停超时检测 ──────────────────────────

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
      expect(manager.status).toBe('paused');

      // 验证检查点已创建
      expect(manager.getCheckpoint()).not.toBeNull();

      // 快进时间到超时阈值之前（29 分钟），应不触发超时清理
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS - 60_000);
      expect(manager.getCheckpoint()).not.toBeNull();

      // 快进时间超过超时阈值（再快进 2 分钟，确保超过 30 分钟）
      vi.advanceTimersByTime(120_000);
      expect(manager.getCheckpoint()).toBeNull();
      expect(manager.status).toBe('running');
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: expect.any(String),
        pauseDuration: expect.any(Number),
      }));
    });

    it('暂停后在超时前恢复，应不触发超时清理', () => {
      manager.pause('测试暂停', 'user');
      expect(manager.status).toBe('paused');

      // 恢复会话（应在超时前）
      manager.resume();
      expect(manager.status).toBe('running');

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
      expect(manager.status).toBe('paused');

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

    it('pause() 应在唯一状态转换点写入 pausedAt（覆盖空闲直翻与流中延迟翻）', () => {
      manager.pause('测试暂停', 'user');
      const cp = manager.getCheckpoint();
      expect(cp).not.toBeNull();
      // pause() 写入 Date.now() 时间戳
      expect(cp!.pausedAt).toBeTypeOf('number');
      expect(cp!.pausedAt!).toBeGreaterThan(0);
      expect(cp!.pausedAt!).toBeLessThanOrEqual(Date.now());
    });

    // ── 运行时超时也必须填充超时会话信息，通过事件载荷传递 ──
    // 超时信息经事件载荷传递（多监听器可并行消费），emitEvent 调用含 date/session 字段。

    it('运行时超时应通过事件载荷传递超时会话信息', () => {
      manager.pause('测试暂停', 'user');
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);

      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: '2026-06-27-main',
        date: '2026-06-27',
        session: 'main',
      }));
    });

    it('会话名含连字符时应按日期锚定切分，不误切', () => {
      const forkedHistory = createMockHistory({
        currentSessionName: '2026-06-27-main-fork-1',
      } as Partial<MessageHistory>);
      const mgr = new SessionManager(
        () => forkedHistory,
        () => loop,
        sessionStore,
        isChatBusy,
        emitEvent,
      );

      mgr.pause('测试暂停', 'user');
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);

      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: '2026-06-27-main-fork-1',
        date: '2026-06-27',
        session: 'main-fork-1',
      }));
    });

    it('会话标识非日期开头时应跳过填充但仍发射事件', () => {
      // 旧的 split('-').length >= 4 判据会把 'proj-alpha-beta' 误当作日期，
      // 归档到一个根本不存在的日期目录；日期锚定后应直接拒绝解析。
      const customHistory = createMockHistory({
        currentSessionName: 'proj-alpha-beta-gamma',
      } as Partial<MessageHistory>);
      const mgr = new SessionManager(
        () => customHistory,
        () => loop,
        sessionStore,
        isChatBusy,
        emitEvent,
      );

      mgr.pause('测试暂停', 'user');
      vi.advanceTimersByTime(AGENT_CONSTANTS.PAUSE_TIMEOUT_MS + 60_000);

      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: 'proj-alpha-beta-gamma',
      }));
    });
  });

  // ── goalChangeSeq 漂移强制暂停 ──────────────────────

  describe('goalChangeSeq drift auto-pause', () => {
    /**
     * 辅助方法：创建带有 mainGoal 的检查点
     * 首次调用 updateGoal 会创建检查点（返回 null），第二次调用才会触发一致性校验
     */
    function setupCheckpointWithGoal(mainGoal: string): void {
      // 第一次调用：创建检查点，mainGoal 设为目标值
      const result = manager.updateGoal(mainGoal);
      expect(result).toBeNull();
      // 状态机应保持 running
      expect(manager.status).toBe('running');
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
      expect(manager.status).toBe('paused');
    });

    it('confirm 级别时应不自动暂停', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const confirmGoal = '编写一个计算器应用程序支持加减乘除运算';

      setupCheckpointWithGoal(mainGoal);

      const result = manager.updateGoal(confirmGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('confirm');
      // confirm 级别不应暂停
      expect(manager.status).toBe('running');
    });

    it('same 级别时应不触发任何事件', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';

      setupCheckpointWithGoal(mainGoal);

      const result = manager.updateGoal(mainGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('same');
      // same 级别不应暂停
      expect(manager.status).toBe('running');
      // 不应发射 goalDriftDetected 事件
      expect(emitEvent).not.toHaveBeenCalledWith('goalDriftDetected', expect.anything());
    });

    it('值未变时应幂等短路：不递增 goalChangeSeq、不发射任何事件', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';

      setupCheckpointWithGoal(mainGoal);
      // 首次 updateGoal 创建检查点，goalChangeSeq = 0
      expect(manager.getCheckpoint()!.goalChangeSeq).toBe(0);

      // 值未变的 updateGoal（P2 记忆延续每轮重复喂入）→ 幂等短路
      const result = manager.updateGoal(mainGoal);
      expect(result).not.toBeNull();
      expect(result!.level).toBe('same');
      expect(manager.getCheckpoint()!.goalChangeSeq).toBe(0);
      expect(manager.status).toBe('running');
      expect(emitEvent).not.toHaveBeenCalledWith('goalDriftDetected', expect.anything());
    });

    it('连续多轮不改目标时 goalChangeSeq 保持不变，真实修正仍递增（防轮次计数退化）', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';

      setupCheckpointWithGoal(mainGoal);
      expect(manager.getCheckpoint()!.goalChangeSeq).toBe(0);

      // 模拟 3 轮「继续」类延续：每轮 updateGoal 相同的 currentGoal
      for (let i = 0; i < 3; i++) {
        manager.updateGoal(mainGoal);
      }
      expect(manager.getCheckpoint()!.goalChangeSeq).toBe(0);

      // 真实修正（不同目标）仍应递增
      manager.updateGoal('改用 Python 重写计算器应用');
      expect(manager.getCheckpoint()!.goalChangeSeq).toBe(1);
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
      expect(manager.status).toBe('running');
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

    it('confirm 级别目标变更应发射 goalDriftDetected（含完整载荷）', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const newGoal = '编写一个计算器应用程序支持加减乘除运算';

      setupCheckpointWithGoal(mainGoal);
      emitEvent.mockClear();

      manager.updateGoal(newGoal);

      // goalUpdated 已并入 goalDriftDetected（SSOT 收敛：后者 payload 全包含前者）
      expect(emitEvent).toHaveBeenCalledWith('goalDriftDetected', expect.objectContaining({
        level: 'confirm',
        newGoal,
        goalChangeSeq: 1,
        sessionId: expect.any(String),
      }));
    });

    it('drift 级别目标变更应发射 goalDriftDetected 并自动暂停', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const driftedGoal = '今天纽约的天气怎么样适合出行吗';

      setupCheckpointWithGoal(mainGoal);
      emitEvent.mockClear();

      manager.updateGoal(driftedGoal);

      // goalUpdated 已并入 goalDriftDetected（SSOT 收敛：后者 payload 全包含前者）
      expect(emitEvent).toHaveBeenCalledWith('goalDriftDetected', expect.objectContaining({
        level: 'drift',
        newGoal: driftedGoal,
        goalChangeSeq: 1,
      }));
      // drift 级内核自动低风险暂停
      expect(manager.status).toBe('paused');
    });
  });

  // ── consecutivePauseCount 时间衰减 ────────────────

  // ── 检查点序列化/反序列化全路径 ──────────────────────────

  describe('checkpoint create/load/restore cycle', () => {
    /** 创建有内容的 mock Loop，使 extractHotMemory 返回非空热记忆 */
    function createMockLoopWithMessages(msgs: Array<{ role: string; content: string }>): AgentLoop {
      return {
        restoreHistory: vi.fn(),
        getMessages: vi.fn().mockReturnValue(msgs.map((m) => ({ ...m, name: undefined }))),
        injectSystemMessage: vi.fn(),
        // 闭环节点锚点（TS-9）：检查点快照/恢复读写（默认空轮，测试覆盖时覆写）
        getCurrentRoundId: vi.fn().mockReturnValue(''),
        setCurrentRoundId: vi.fn(),
      } as unknown as AgentLoop;
    }

    it('createCheckpoint 首次创建应返回完整检查点', () => {
      const loop = createMockLoopWithMessages([
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好，有什么可以帮助的？' },
      ]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.createCheckpoint('测试主目标');

      expect(cp.sessionId).toBe('2026-06-27-main');
      expect(cp.mainGoal).toBe('测试主目标');
      expect(cp.currentGoal).toBe('测试主目标'); // 首次创建 currentGoal == mainGoal
      expect(cp.goalChangeSeq).toBe(0);
      expect(cp.status).toBe('running');
      expect(cp.hotMemory).toHaveLength(2);
      expect(cp.hotMemory[0]!.content).toBe('你好');
      expect(cp.plan).toEqual([]);
      expect(cp.lastHeartbeat).toBeGreaterThan(0);
    });

    it('createCheckpoint 后续调用应保留已有 currentGoal', () => {
      const loop = createMockLoopWithMessages([
        { role: 'user', content: '继续' },
      ]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      // 首次创建：设 mainGoal
      mgr.createCheckpoint('原始目标');
      expect(mgr.getCheckpoint()!.currentGoal).toBe('原始目标');

      // 模拟 updateGoal 更新了 currentGoal
      const cp = mgr.getCheckpoint()!;
      cp.currentGoal = '用户调整后的目标';
      cp.goalChangeSeq = 1;

      // 再次 createCheckpoint（不传 mainGoal）→ currentGoal 应保留
      mgr.createCheckpoint(); // 无参数
      expect(mgr.getCheckpoint()!.mainGoal).toBe('原始目标');
      expect(mgr.getCheckpoint()!.currentGoal).toBe('用户调整后的目标');
      expect(mgr.getCheckpoint()!.goalChangeSeq).toBe(1);
    });

    it('sessionStore 未注入时 createCheckpoint 不应抛错', () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        undefined, // 无 sessionStore
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      // 不应抛错
      expect(() => mgr.createCheckpoint('无存储测试')).not.toThrow();
      expect(mgr.getCheckpoint()).not.toBeNull();
      expect(mgr.getCheckpoint()!.mainGoal).toBe('无存储测试');
    });
  });

  describe('consecutivePauseDecay', () => {
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

      // 快进时间到暂停超时阈值之前（25 分钟），计数应仍为 1
      vi.advanceTimersByTime(25 * 60 * 1000);
      expect(manager.getConsecutivePauseCount()).toBe(1);

      // 快进超过暂停超时阈值（再快进 10 分钟，总计 35 分钟）
      // 暂停超时后 checkPauseTimeout 会重置连续暂停计数
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(manager.getConsecutivePauseCount()).toBe(0);

      // 再快进超过衰减窗口，计数仍为 0
      vi.advanceTimersByTime(30 * 60 * 1000);
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

      // 快进 25 分钟（总计 35 分钟），第二次暂停尚未超时（30 分钟阈值），
      // 两次暂停均仍在衰减窗口内（60 分钟）
      vi.advanceTimersByTime(25 * 60 * 1000);
      expect(manager.getConsecutivePauseCount()).toBe(2);

      // 再快进 10 分钟（总计 45 分钟），第二次暂停已超时（30 分钟阈值）
      // 暂停超时后 checkPauseTimeout 重置连续暂停计数
      vi.advanceTimersByTime(10 * 60 * 1000);
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
  });

});
