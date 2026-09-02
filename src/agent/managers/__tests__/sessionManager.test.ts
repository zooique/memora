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
 *   - 检查点生命周期：createCheckpoint / saveCheckpoint / loadPersistedCheckpoint / restoreFromCheckpoint
 *     （来自 sessionCheckpointLifecycle.test.ts 合并）
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
import type { Role, Standard, ResourceState, SessionCheckpoint, ToolExecutionRecord } from '@/agent/types.js';
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
    saveCheckpoint: vi.fn(),
    loadCheckpoint: vi.fn().mockReturnValue(null),
    deleteCheckpoint: vi.fn(),
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
      expect(emitEvent).not.toHaveBeenCalledWith('goalUpdated', expect.anything());
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

    it('confirm 级别目标变更应发射 goalUpdated 事件（含完整载荷）', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const newGoal = '编写一个计算器应用程序支持加减乘除运算';

      setupCheckpointWithGoal(mainGoal);
      emitEvent.mockClear();

      manager.updateGoal(newGoal);

      expect(emitEvent).toHaveBeenCalledWith('goalUpdated', expect.objectContaining({
        newGoal,
        goalChangeSeq: 1,
        sessionId: expect.any(String),
      }));
      // confirm 级别同时发射 goalUpdated 和 goalDriftDetected
      expect(emitEvent).toHaveBeenCalledWith('goalDriftDetected', expect.objectContaining({
        level: 'confirm',
      }));
    });

    it('drift 级别目标变更应同时发射 goalUpdated 和 goalDriftDetected', () => {
      const mainGoal = '编写一个计算器应用程序支持基本数学运算';
      const driftedGoal = '今天纽约的天气怎么样适合出行吗';

      setupCheckpointWithGoal(mainGoal);
      emitEvent.mockClear();

      manager.updateGoal(driftedGoal);

      // drift 级别应同时发射两个事件：goalUpdated（目标变更通知）+ goalDriftDetected（漂移告警）
      expect(emitEvent).toHaveBeenCalledWith('goalUpdated', expect.objectContaining({
        newGoal: driftedGoal,
        goalChangeSeq: 1,
      }));
      expect(emitEvent).toHaveBeenCalledWith('goalDriftDetected', expect.objectContaining({
        level: 'drift',
      }));
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

    it('saveCheckpoint 应持久化检查点到 sessionStore', () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      mgr.createCheckpoint('保存测试');

      expect(sessionStore!.saveCheckpoint).toHaveBeenCalledWith(
        '2026-06-27-main',
        expect.any(String),
      );
      // 验证序列化后的 JSON 可反序列化
      const savedJson = (sessionStore!.saveCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0]![1];
      expect(() => JSON.parse(savedJson)).not.toThrow();
    });

    it('flushNow 应强制落盘当前脏检查点（D1-②：工具副作用后持久化 completedToolCalls）', () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      // 建立检查点 + 模拟 logToolExecution 标脏（写副作用工具）
      mgr.createCheckpoint();
      mgr.logToolExecution({ name: 'write_file', argsSignature: '{}', executedAt: Date.now(), resultSummary: 'ok', ok: true, idempotent: 'non-idempotent' });
      const saveSpy = sessionStore!.saveCheckpoint as ReturnType<typeof vi.fn>;
      const callsAfterDirty = saveSpy.mock.calls.length;

      // flushNow 强制落盘（不依赖 completeRound）
      mgr.flushNow();
      expect(saveSpy.mock.calls.length).toBeGreaterThan(callsAfterDirty);
      // 落盘内容含刚记录的 completedToolCalls（幂等标记可跨重启排重）
      const latest = saveSpy.mock.calls[saveSpy.mock.calls.length - 1]![1] as string;
      expect(latest).toContain('write_file');
    });

    it('loadPersistedCheckpoint 应正常加载并恢复状态机', () => {
      const loop = createMockLoopWithMessages([
        { role: 'user', content: '历史消息' },
      ]);
      // mock loadCheckpoint 返回序列化检查点
      const store = createMockSessionStore({
        loadCheckpoint: vi.fn().mockReturnValue(JSON.stringify({
          sessionId: '2026-06-27-main',
          status: 'running',
          mainGoal: '加载测试',
          currentGoal: '加载测试',
          goalChangeSeq: 0,
          plan: [],
          role: { name: 'assistant' },
          standard: { quality: '完成', constraints: [] },
          resource: { documents: [], memories: [], context: '' },
          hotMemory: [{ role: 'user', content: '历史消息' }],
          lastHeartbeat: Date.now(),
        })),
      });
      const mgr = new SessionManager(
        () => history,
        () => loop,
        store,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.loadPersistedCheckpoint();

      expect(cp).not.toBeNull();
      expect(cp!.mainGoal).toBe('加载测试');
      expect(cp!.status).toBe('running');
      // 状态机应为 running（不需要额外操作）
      expect(mgr.status).toBe('running');
    });

    it('loadPersistedCheckpoint 应恢复 paused 状态', () => {
      const loop = createMockLoopWithMessages([]);
      const store = createMockSessionStore({
        loadCheckpoint: vi.fn().mockReturnValue(JSON.stringify({
          sessionId: '2026-06-27-main',
          status: 'paused',
          mainGoal: '暂停测试',
          currentGoal: '暂停测试',
          goalChangeSeq: 0,
          plan: [],
          role: { name: 'assistant' },
          standard: { quality: '完成', constraints: [] },
          resource: { documents: [], memories: [], context: '' },
          hotMemory: [],
          lastHeartbeat: Date.now(),
        })),
      });
      const mgr = new SessionManager(
        () => history,
        () => loop,
        store,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.loadPersistedCheckpoint();

      expect(cp).not.toBeNull();
      expect(cp!.status).toBe('paused');
      // 状态机恢复为 paused
      expect(mgr.status).toBe('paused');
    });

    it('loadPersistedCheckpoint 暂停超时应返回 null 并清理', () => {
      vi.useFakeTimers();
      const loop = createMockLoopWithMessages([]);
      // 检查点 lastHeartbeat 设为 31 分钟前
      const oldHeartbeat = Date.now() - AGENT_CONSTANTS.PAUSE_TIMEOUT_MS - 60_000;
      const store = createMockSessionStore({
        loadCheckpoint: vi.fn().mockReturnValue(JSON.stringify({
          sessionId: '2026-06-27-main',
          status: 'paused',
          mainGoal: '超时测试',
          currentGoal: '超时测试',
          goalChangeSeq: 0,
          plan: [],
          role: { name: 'assistant' },
          standard: { quality: '完成', constraints: [] },
          resource: { documents: [], memories: [], context: '' },
          hotMemory: [],
          lastHeartbeat: oldHeartbeat,
        })),
      });
      const mgr = new SessionManager(
        () => history,
        () => loop,
        store,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.loadPersistedCheckpoint();

      expect(cp).toBeNull();
      expect(mgr.getCheckpoint()).toBeNull();
      // 状态机应保持 running（超时清理后重置）
      expect(mgr.status).toBe('running');
      // 应发射超时事件
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: '2026-06-27-main',
      }));
      // 字段须在发射事件之前填好——监听器会同步消费，
      // 顺序颠倒会让归档消费到 null
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: '2026-06-27-main',
        date: '2026-06-27',
        session: 'main',
      }));
      vi.useRealTimers();
    });

    it('暂停后 touchCheckpoint 刷新 lastHeartbeat 不应推迟超时判定（pausedAt 为准）', () => {
      vi.useFakeTimers();
      const loop = createMockLoopWithMessages([]);
      // 核心契约：pausedAt 是暂停起点（31 分钟前 → 超时），
      // lastHeartbeat 刚被 touchCheckpoint（如 updatePlanStepStatus）刷新（新鲜）。
      // 判定基准是 pausedAt 而非 lastHeartbeat：pausedAt 超时则检查点被清理
      const oldPausedAt = Date.now() - AGENT_CONSTANTS.PAUSE_TIMEOUT_MS - 60_000;
      const store = createMockSessionStore({
        loadCheckpoint: vi.fn().mockReturnValue(JSON.stringify({
          sessionId: '2026-06-27-main',
          status: 'paused',
          mainGoal: '暂停超时测试',
          currentGoal: '暂停超时测试',
          goalChangeSeq: 0,
          plan: [],
          role: { name: 'assistant' },
          standard: { quality: '完成', constraints: [] },
          resource: { documents: [], memories: [], context: '' },
          hotMemory: [],
          lastHeartbeat: Date.now(), // 新鲜：模拟暂停后 touchCheckpoint 刷新
          pausedAt: oldPausedAt,     // 超时：暂停起点真实时间
        })),
      });
      const mgr = new SessionManager(
        () => history,
        () => loop,
        store,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.loadPersistedCheckpoint();

      expect(cp).toBeNull();
      expect(mgr.getCheckpoint()).toBeNull();
      expect(mgr.status).toBe('running');
      expect(emitEvent).toHaveBeenCalledWith('sessionPauseTimedOut', expect.objectContaining({
        sessionId: '2026-06-27-main',
      }));
      vi.useRealTimers();
    });

    it('restoreFromCheckpoint 应恢复消息和状态机', async () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const checkpoint = {
        sessionId: '2026-06-27-main',
        schemaVersion: 1,
        status: 'running' as const,
        mainGoal: '恢复测试',
        currentGoal: '恢复测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' } as Role,
        standard: { quality: '完成', constraints: [] } as Standard,
        resource: { documents: [], memories: [], context: '' } as ResourceState,
        hotMemory: [
          { role: 'user' as const, content: '消息1' },
          { role: 'assistant' as const, content: '消息2' },
        ],
        lastHeartbeat: Date.now(),
      };

      const count = await mgr.restoreFromCheckpoint(checkpoint);

      // 应恢复 2 条消息
      expect(count).toBe(2);
      expect(loop.restoreHistory).toHaveBeenCalledWith([
        { role: 'user', content: '消息1', name: undefined, toolCalls: undefined, toolCallId: undefined },
        { role: 'assistant', content: '消息2', name: undefined, toolCalls: undefined, toolCallId: undefined },
      ]);
    });

    it('restoreFromCheckpoint 截断时注入提示消息', async () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const checkpoint = {
        sessionId: '2026-06-27-main',
        schemaVersion: 1,
        status: 'running' as const,
        mainGoal: '截断测试',
        currentGoal: '截断测试',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' } as Role,
        standard: { quality: '完成', constraints: [] } as Standard,
        resource: { documents: [], memories: [], context: '' } as ResourceState,
        hotMemory: [{ role: 'user' as const, content: '消息' }],
        truncatedCount: 5, // 5 条早期消息被截断
        lastHeartbeat: Date.now(),
      };

      await mgr.restoreFromCheckpoint(checkpoint);

      expect(loop.injectSystemMessage).toHaveBeenCalledWith(
        expect.stringContaining('5 条早期消息已被截断'),
      );
    });

    it('restoreFromCheckpoint 恢复 paused 状态应设置状态机', async () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        sessionStore,
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const checkpoint = {
        sessionId: '2026-06-27-main',
        schemaVersion: 1,
        status: 'paused' as const,
        mainGoal: '暂停恢复',
        currentGoal: '暂停恢复',
        goalChangeSeq: 0,
        plan: [],
        role: { name: 'assistant' } as Role,
        standard: { quality: '完成', constraints: [] } as Standard,
        resource: { documents: [], memories: [], context: '' } as ResourceState,
        hotMemory: [],
        lastHeartbeat: Date.now(),
      };

      await mgr.restoreFromCheckpoint(checkpoint);

      expect(mgr.status).toBe('paused');
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

    it('sessionStore 未注入时 loadPersistedCheckpoint 应返回 null', () => {
      const loop = createMockLoopWithMessages([]);
      const mgr = new SessionManager(
        () => history,
        () => loop,
        undefined, // 无 sessionStore
        isChatBusy as unknown as () => boolean,
        emitEvent as unknown as (event: string, data: Record<string, unknown>) => void,
      );

      const cp = mgr.loadPersistedCheckpoint();
      expect(cp).toBeNull();
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

  // ── 检查点字段生命周期 ──────

  /** 带「假磁盘」的会话存储，真实保存序列化结果 */
  function createDiskBackedStore(): {
    store: ISessionStore;
    readDisk: () => SessionCheckpoint | null;
    writeCount: () => number;
  } {
    const disk = new Map<string, string>();
    let writes = 0;

    const store: ISessionStore = {
      loadMessages: vi.fn().mockReturnValue([]),
      listSessions: vi.fn().mockReturnValue([]),
      saveCheckpoint: (sessionId: string, json: string) => {
        writes += 1;
        disk.set(sessionId, json);
      },
      loadCheckpoint: (sessionId: string) => disk.get(sessionId) ?? null,
      deleteCheckpoint: (sessionId: string) => {
        disk.delete(sessionId);
      },
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };

    return {
      store,
      readDisk: () => {
        const json = disk.get('2026-06-27-main');
        return json ? (JSON.parse(json) as SessionCheckpoint) : null;
      },
      writeCount: () => writes,
    };
  }

  /** 测试用的工具执行记录 */
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

    /** 一份字段齐全的合法检查点，各用例只挖掉待测的那一处 */
    function intactCheckpoint(): Record<string, unknown> {
      return {
        sessionId: '2026-06-27-main',
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

    /** 往假磁盘直接种入任意结构的检查点 JSON */
    function seedDisk(raw: Record<string, unknown>): void {
      disk.store.saveCheckpoint!('2026-06-27-main', JSON.stringify(raw));
    }

    /** 建立一个三个侧车字段均有值的检查点 */
    function seedCheckpointWithSidecars(): void {
      manager.createCheckpoint('主目标');
      manager.logToolExecution(TOOL_RECORD);
      manager.completeRound({ summary: '第一回合' });
      manager.setPauseMeta({
        reason: '用户主动暂停',
        source: 'user',
      });
    }

    describe('侧车字段跨 pause 存活', () => {
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
      it('pause 前后检查点的键集合不得收缩，新增键仅限 pausedAt', () => {
        seedCheckpointWithSidecars();
        const before = Object.keys(manager.getCheckpoint()!).sort();
        manager.pause('测试暂停', 'user');
        const after = Object.keys(manager.getCheckpoint()!).sort();
        expect(before.every((k) => after.includes(k))).toBe(true);
        expect(after.filter((k) => !before.includes(k))).toEqual(['pausedAt']);
      });

      it('落盘快照不应丢失任何有值字段', () => {
        seedCheckpointWithSidecars();
        manager.pause('测试暂停', 'user');
        const memory = manager.getCheckpoint()!;
        const memoryKeys = Object.entries(memory)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k)
          .sort();
        const diskKeys = Object.keys(disk.readDisk()!).sort();
        expect(diskKeys).toEqual(memoryKeys);
      });
    });

    describe('outbox 落盘时机（批处理优化）', () => {
      it('工具执行记录应延迟到回合边界统一落盘', () => {
        manager.createCheckpoint('主目标');
        const writesBefore = disk.writeCount();
        manager.logToolExecution(TOOL_RECORD);
        const writesAfterLog = disk.writeCount();
        expect(writesAfterLog).toBe(writesBefore);
        manager.completeRound({ summary: '测试回合' });
        const writesAfterRound = disk.writeCount();
        expect(writesAfterRound).toBeGreaterThan(writesAfterLog);
        const onDisk = disk.readDisk();
        expect(onDisk!.completedToolCalls).toHaveLength(1);
        expect(onDisk!.completedToolCalls![0]!.argsSignature).toBe('{"path":"a.ts"}');
      });

      it('恢复后应能凭磁盘记录识别出工具已执行', () => {
        manager.createCheckpoint('主目标');
        manager.logToolExecution(TOOL_RECORD);
        manager.pause('暂停', 'user');
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

    describe('异常恢复链落盘', () => {
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
        expect(revived.status).toBe('running');
      });
    });

    describe('脏标记语义', () => {
      it('无变更时重复 resume 不应产生多余写盘', () => {
        manager.createCheckpoint('主目标');
        manager.pause('暂停', 'user');
        manager.resume();
        const baseline = disk.writeCount();
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

    describe('反序列化归一化（严格模式：残缺即拒绝，不做兜底填充）', () => {
      it('磁盘检查点缺少 lastHeartbeat 时应拒绝加载且不污染运行时检查点', () => {
        const raw = intactCheckpoint();
        raw.status = 'paused';
        delete raw.lastHeartbeat;
        seedDisk(raw);
        expect(manager.loadPersistedCheckpoint()).toBeNull();
        expect(manager.getCheckpoint()).toBeNull();
      });

      it('hotMemory 被截断成非数组时应中止恢复而非静默降级', async () => {
        const raw = intactCheckpoint();
        raw.hotMemory = '存储截断后的残片';
        const count = await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);
        expect(count).toBe(0);
        expect(manager.getCheckpoint()).toBeNull();
      });

      it('status 为越界值时应拒绝恢复', async () => {
        const raw = intactCheckpoint();
        raw.status = 'zombie';
        const count = await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);
        expect(count).toBe(0);
        expect(manager.getCheckpoint()).toBeNull();
      });

      it('error 侧车结构非法时应整体清除，异常态降级为 running', async () => {
        const raw = intactCheckpoint();
        raw.status = 'error';
        raw.error = { at: 1 };
        await manager.restoreFromCheckpoint(raw as unknown as SessionCheckpoint);
        const cp = manager.getCheckpoint();
        expect(cp).not.toBeNull();
        expect(cp!.error).toBeUndefined();
        expect(cp!.status).toBe('running');
      });

      it('磁盘内容为畸形 JSON 时应返回 null 且不污染运行时检查点', () => {
        disk.store.saveCheckpoint!('2026-06-27-main', '{"sessionId":');
        expect(manager.loadPersistedCheckpoint()).toBeNull();
        expect(manager.getCheckpoint()).toBeNull();
      });

      describe('版本路由（K1 持久化加固，2026-08-23）', () => {
        it('schemaVersion 缺失（旧版本检查点）向后兼容，视为当前版本恢复', () => {
          // intactCheckpoint 不带 schemaVersion —— 模拟未写版本字段的旧内核产物
          seedDisk(intactCheckpoint());
          const cp = manager.loadPersistedCheckpoint();
          expect(cp).not.toBeNull();
          expect(cp!.schemaVersion).toBe(AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION);
        });

        it('schemaVersion 为当前版本时正常恢复', () => {
          const raw = intactCheckpoint();
          raw.schemaVersion = AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION;
          seedDisk(raw);
          const cp = manager.loadPersistedCheckpoint();
          expect(cp).not.toBeNull();
          expect(cp!.schemaVersion).toBe(AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION);
        });

        it('schemaVersion 高于当前版本（未来内核）时拒绝恢复，不污染运行时检查点', () => {
          const raw = intactCheckpoint();
          raw.schemaVersion = AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION + 1;
          seedDisk(raw);
          expect(manager.loadPersistedCheckpoint()).toBeNull();
          expect(manager.getCheckpoint()).toBeNull();
        });

        it('schemaVersion 非法（非正整数）时拒绝恢复，视为数据损坏', () => {
          const raw = intactCheckpoint();
          raw.schemaVersion = 'v1';
          seedDisk(raw);
          expect(manager.loadPersistedCheckpoint()).toBeNull();
          expect(manager.getCheckpoint()).toBeNull();
        });
      });
    });

    describe('运行态挂载物卸载（SSOT 资源层 vs 状态层模型 2026-08-10）', () => {
      it('resume 应卸载 pauseMeta 挂载物（内存态与磁盘态一致）', () => {
        manager.createCheckpoint('主目标');
        manager.setPauseMeta({
          reason: '用户主动暂停',
          source: 'user',
        });
        manager.pause('测试暂停', 'user');
        expect(manager.getCheckpoint()!.pauseMeta).toBeDefined();
        manager.resume();
        const cp = manager.getCheckpoint()!;
        expect(cp.pauseMeta).toBeUndefined();
        expect(disk.readDisk()!.pauseMeta).toBeUndefined();
      });

      it('clearPlan 应清空 plan 与 roundLog（内存态与磁盘态一致）', () => {
        manager.createCheckpoint('主目标');
        manager.appendPlanStep('第一步');
        manager.appendPlanStep('第二步');
        manager.completeRound({ stepId: undefined, summary: '测试回合' });
        expect(manager.getCheckpoint()!.plan).toHaveLength(2);
        expect(manager.getCheckpoint()!.roundLog).toHaveLength(1);
        manager.clearPlan();
        const cp = manager.getCheckpoint()!;
        expect(cp.plan).toHaveLength(0);
        expect(cp.roundLog).toBeUndefined();
        const onDisk = disk.readDisk()!;
        expect(onDisk.plan).toHaveLength(0);
        expect(onDisk.roundLog).toBeUndefined();
      });

      it('clearPlan 在无检查点时安全 no-op 不抛错', () => {
        expect(() => manager.clearPlan()).not.toThrow();
        expect(manager.getCheckpoint()).toBeNull();
      });
    });

    describe('SessionManager · writePlan 模式分发（A3 盲区收敛）', () => {
      let mgr: SessionManager;
      let testDisk: ReturnType<typeof createDiskBackedStore>;

      beforeEach(() => {
        testDisk = createDiskBackedStore();
        mgr = new SessionManager(
          () => createMockHistory(),
          () => createMockLoop(),
          testDisk.store,
          () => false,
          vi.fn(),
        );
        mgr.createCheckpoint('主目标');
      });

      it("'append' 应在现有 plan 上追加步骤", () => {
        mgr.appendPlanStep('已有步骤');
        const result = mgr.writePlan('append', [{ description: '新增A' }, { description: '新增B' }]);
        expect(result).toHaveLength(3);
        expect(result.map((s: { description: string }) => s.description)).toEqual([
          '已有步骤',
          '新增A',
          '新增B',
        ]);
      });

      it("'overwrite' 应等价于追加（不要求 plan 为空）", () => {
        const result = mgr.writePlan('overwrite', [{ description: '第一步' }, { description: '第二步' }]);
        expect(result).toHaveLength(2);
        expect(result.map((s: { description: string }) => s.description)).toEqual(['第一步', '第二步']);
      });

      it("'update' 应全量替换并保留已有步骤 id 与 status", () => {
        mgr.appendPlanStep('旧步骤1');
        mgr.appendPlanStep('旧步骤2');
        const before = mgr.getCheckpoint()!.plan;
        const result = mgr.writePlan('update', [{ description: '新步骤1' }, { description: '新步骤2' }]);
        expect(result).toHaveLength(2);
        expect(result.map((s: { description: string }) => s.description)).toEqual(['新步骤1', '新步骤2']);
        expect(result[0]!.id).toBe(before[0]!.id);
        expect(result[0]!.status).toBe('pending');
      });

      it("'update' 传入更多步骤时应新建后续步骤并保留前序 id", () => {
        mgr.appendPlanStep('旧步骤');
        const result = mgr.writePlan('update', [
          { description: '新1' },
          { description: '新2' },
          { description: '新3' },
        ]);
        expect(result).toHaveLength(3);
        expect(result[0]!.id).toBe(mgr.getCheckpoint()!.plan[0]!.id);
      });

      it('无检查点时 writePlan 应安全返回空数组（no-op）', () => {
        const bare = new SessionManager(
          () => createMockHistory(),
          () => createMockLoop(),
          createDiskBackedStore().store,
          () => false,
          vi.fn(),
        );
        expect(bare.writePlan('append', [{ description: 'x' }])).toEqual([]);
      });

      it("'append' 步骤携带 rolePack（会议表层装配角色）应透传进 PlanStep（v0.13 S5）", () => {
        const result = mgr.writePlan('append', [
          { description: '从编辑视角审稿', rolePack: '编辑' },
          { description: '汇总会议结论' },
        ]);
        expect(result).toHaveLength(2);
        expect(result[0]!.rolePack).toBe('编辑');
        // 未声明 rolePack 的步骤保持 undefined（非会议）
        expect(result[1]!.rolePack).toBeUndefined();
      });

      it("'update' 保留既有步骤 rolePack（仅覆盖 description）", () => {
        mgr.appendPlanStep('旧步骤', '编辑');
        const result = mgr.writePlan('update', [{ description: '新描述' }]);
        expect(result[0]!.description).toBe('新描述');
        expect(result[0]!.rolePack).toBe('编辑');
      });
    });
  });
});
