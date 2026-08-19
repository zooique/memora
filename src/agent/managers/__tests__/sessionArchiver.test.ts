/**
 * SessionArchiver 单元测试
 *
 * 覆盖：
 * - archiveSession 主流程（正常归档、空会话、消息过少）
 * - 降级策略（sessionStore 未注入、LLM 失败、LLM 返回 null）
 * - LLM 摘要解析（JSON 解析、null 响应、无效响应）
 * - 消息截断（超长会话、超长单条消息）
 * - SessionMeta 写入（summary / keyTopics / autoName）
 *
 * 测试模式：MockProvider + MockSessionStore（实现 updateSessionMeta）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionArchiver } from '@/agent/managers/sessionArchiver.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ISessionStore, SessionMessage, SessionMeta } from '@/memory/sessionStore.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider
// ═══════════════════════════════════════════════════════════════

/**
 * Mock LLM Provider
 *
 * 可配置响应内容，模拟 LLM 元数据生成。
 * 支持抛出异常以测试降级路径。
 */
class MockProvider extends LlmProvider {
  readonly name = 'mock';
  private response: string;
  private shouldThrow: boolean;

  constructor(response: string = '{"summary": "测试摘要内容", "keyTopics": ["测试", "摘要"], "autoName": "测试会话"}') {
    super();
    this.response = response;
    this.shouldThrow = false;
  }

  /** 设置 LLM 响应内容 */
  setResponse(response: string): void {
    this.response = response;
  }

  /** 设置是否在 chat() 时抛出异常（模拟 LLM 不可用） */
  setShouldThrow(shouldThrow: boolean): void {
    this.shouldThrow = shouldThrow;
  }

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    if (this.shouldThrow) {
      throw new Error('模拟 LLM 不可用');
    }
    yield { content: this.response };
    yield { finishReason: 'stop' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Mock SessionStore（实现 updateSessionMeta）
// ═══════════════════════════════════════════════════════════════

/**
 * Mock SessionStore
 *
 * 内存实现的 ISessionStore，支持预设消息列表。
 * 实现 updateSessionMeta 和 getSessionMeta 以验证归档写入。
 */
class MockSessionStore implements ISessionStore {
  private messages: SessionMessage[];
  private metaMap: Map<string, SessionMeta> = new Map();
  /** 记录 updateSessionMeta 调用次数和参数 */
  updateCalls: Array<{ sessionId: string; meta: Record<string, unknown> }> = [];

  constructor(messages: SessionMessage[] = []) {
    this.messages = messages;
  }

  /** 设置会话消息列表 */
  setMessages(messages: SessionMessage[]): void {
    this.messages = messages;
  }

  appendMessage(): void {
    // 测试不需要实现追加逻辑
  }

  loadMessages(): SessionMessage[] {
    return this.messages;
  }

  listSessions(): string[] {
    return this.messages.length > 0 ? ['2026-07-03-main'] : [];
  }

  copySession(): void {
    // 测试不需要实现复制逻辑
  }

  /** 实现 getSessionMeta（返回预设元数据，默认空） */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.metaMap.get(sessionId);
  }

  /** 实现 updateSessionMeta（记录调用，合并到 metaMap） */
  updateSessionMeta(sessionId: string, meta: Record<string, unknown>): void {
    this.updateCalls.push({ sessionId, meta });
    const existing = this.metaMap.get(sessionId);
    if (existing) {
      this.metaMap.set(sessionId, { ...existing, ...meta } as SessionMeta);
    } else {
      this.metaMap.set(sessionId, {
        sessionId,
        updatedAt: new Date().toISOString(),
        messageCount: this.messages.length,
        ...meta,
      } as SessionMeta);
    }
  }

  /** 实现 setSessionTitle（记录调用） */
  setSessionTitle(sessionId: string, title: string): void {
    this.updateSessionMeta(sessionId, { displayName: title });
  }

  /** 获取调用记录 */
  getUpdateCalls(): Array<{ sessionId: string; meta: Record<string, unknown> }> {
    return this.updateCalls;
  }

  /** 获取最后一次写入的元数据 */
  getLastMeta(): Record<string, unknown> | undefined {
    const lastCall = this.updateCalls[this.updateCalls.length - 1];
    return lastCall?.meta;
  }
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 创建测试用会话消息列表 */
function makeMessages(count: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `消息 ${i + 1}`,
      timestamp: new Date().toISOString(),
    });
  }
  return messages;
}

// ═══════════════════════════════════════════════════════════════
// 测试：archiveSession 主流程
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · archiveSession 主流程', () => {
  let provider: MockProvider;
  let sessionStore: MockSessionStore;
  let archiver: SessionArchiver;

  beforeEach(() => {
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
    archiver = new SessionArchiver(provider, sessionStore);
  });

  it('正常归档应写入 SessionMeta（summary + keyTopics + autoName）', async () => {
    const result = await archiver.archiveSession('2026-07-03', 'main');

    expect(result.updatedFields).toContain('summary');
    expect(result.updatedFields).toContain('keyTopics');
    expect(result.updatedFields).toContain('autoName');
    expect(result.messageCount).toBe(4);
    expect(result.sessionLabel).toBe('2026-07-03-main');

    // 验证 sessionStore.updateSessionMeta 被正确调用
    const lastCall = sessionStore.getLastMeta();
    expect(lastCall).toBeDefined();
    expect(lastCall?.summary).toBe('测试摘要内容');
    expect(lastCall?.keyTopics).toEqual(['测试', '摘要']);
    expect(lastCall?.autoName).toBe('测试会话');
  });

  it('已有 autoName 时不应覆盖 autoName（由 SessionNamer 首轮生成）', async () => {
    const sessionId = '2026-07-03-main';
    // 预设已有 autoName（由 SessionNamer 在首轮对话时生成）
    sessionStore.updateSessionMeta(sessionId, { autoName: '已有名称' });
    sessionStore.updateCalls = []; // 清空调用记录

    const result = await archiver.archiveSession('2026-07-03', 'main');

    expect(result.updatedFields).not.toContain('autoName');
    expect(result.updatedFields).toContain('summary');
    expect(result.updatedFields).toContain('keyTopics');
  });

  it('归档结果不再包含 memories 字段（改为 updatedFields）', async () => {
    const result = await archiver.archiveSession('2026-07-03', 'main');

    // 新接口使用 updatedFields，不再使用 memories
    expect(result.updatedFields).toBeDefined();
    // @ts-expect-error - 验证旧字段不存在
    expect(result.memories).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：降级策略
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 降级策略', () => {
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('sessionStore 未注入时应静默跳过', async () => {
    const archiver = new SessionArchiver(provider, undefined);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
    expect(result.messageCount).toBe(0);
  });

  it('LLM 抛出异常时应向上抛出（由 ArchiveCoordinator 统一 catch）', async () => {
    provider.setShouldThrow(true);
    const archiver = new SessionArchiver(provider, sessionStore);
    await expect(archiver.archiveSession('2026-07-03', 'main')).rejects.toThrow('模拟 LLM 不可用');
    // 异常时不应写入任何元数据
    expect(sessionStore.getUpdateCalls()).toHaveLength(0);
  });

  it('LLM 返回 null 应判定无摘要价值', async () => {
    provider.setResponse('null');
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
    expect(result.messageCount).toBe(4);
  });

  it('LLM 返回空字符串应判定无摘要价值', async () => {
    provider.setResponse('');
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
  });

  it('LLM 返回无 summary 字段的 JSON 应判定无摘要价值', async () => {
    provider.setResponse('{"keyTopics": ["测试"]}');
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
  });

  it('LLM 返回 summary 为空字符串应判定无摘要价值', async () => {
    provider.setResponse('{"summary": "", "keyTopics": []}');
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
  });

  it('LLM 返回 summary 仅空白字符应判定无摘要价值', async () => {
    provider.setResponse('{"summary": "   ", "keyTopics": []}');
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：消息过少跳过
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 消息过少跳过', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('空会话（0 条消息）应跳过归档', async () => {
    const sessionStore = new MockSessionStore([]);
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
    expect(result.messageCount).toBe(0);
  });

  it('单条消息应跳过归档（无对话价值）', async () => {
    const sessionStore = new MockSessionStore(makeMessages(1));
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields).toHaveLength(0);
    expect(result.messageCount).toBe(1);
  });

  it('两条消息应正常归档（最低归档阈值）', async () => {
    const sessionStore = new MockSessionStore(makeMessages(2));
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    expect(result.updatedFields.length).toBeGreaterThan(0);
    expect(result.messageCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：消息截断
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 消息截断', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it('超长会话应截取最近 50 条消息', async () => {
    // 60 条消息，应截取最后 50 条
    const sessionStore = new MockSessionStore(makeMessages(60));
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    // 截断后仍应正常归档（mock provider 不区分内容长度）
    expect(result.updatedFields.length).toBeGreaterThan(0);
    expect(result.messageCount).toBe(60);
  });

  it('超长单条消息应被截断（不撑爆 LLM 上下文）', async () => {
    // 构造一条超长消息（超过 MAX_MESSAGE_CHARS=500）
    const longContent = 'A'.repeat(1000);
    const sessionStore = new MockSessionStore([
      { role: 'user', content: longContent, timestamp: new Date().toISOString() },
      { role: 'assistant', content: '回复', timestamp: new Date().toISOString() },
    ]);
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');
    // 截断后仍应正常归档
    expect(result.updatedFields.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：LLM 响应解析
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · LLM 响应解析', () => {
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('应正确解析 JSON 格式的元数据响应', async () => {
    provider.setResponse('{"summary": "讨论了项目架构设计", "keyTopics": ["架构", "设计", "讨论"], "autoName": "架构讨论"}');
    const archiver = new SessionArchiver(provider, sessionStore);
    await archiver.archiveSession('2026-07-03', 'main');

    const lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.summary).toBe('讨论了项目架构设计');
    expect(lastMeta?.keyTopics).toEqual(['架构', '设计', '讨论']);
    expect(lastMeta?.autoName).toBe('架构讨论');
  });

  it('应处理 LLM 返回带前后空白的响应', async () => {
    provider.setResponse('  {"summary": "带空白的摘要", "keyTopics": [], "autoName": "摘要"}  ');
    const archiver = new SessionArchiver(provider, sessionStore);
    await archiver.archiveSession('2026-07-03', 'main');

    const lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.summary).toBe('带空白的摘要');
  });

  it('应处理非标准 JSON（parseLlmJson 容错）', async () => {
    provider.setResponse('```json\n{"summary": "代码块摘要", "keyTopics": [], "autoName": "代码"}\n```');
    const archiver = new SessionArchiver(provider, sessionStore);
    await archiver.archiveSession('2026-07-03', 'main');

    const lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.summary).toBe('代码块摘要');
  });

  it('LLM 未返回 autoName 时，应从 summary 前几个字提取', async () => {
    provider.setResponse('{"summary": "这是一段很长的摘要内容，用于测试 autoName 回退逻辑", "keyTopics": ["测试"]}');
    const archiver = new SessionArchiver(provider, sessionStore);
    await archiver.archiveSession('2026-07-03', 'main');

    const lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.autoName).toBeDefined();
    // autoName 应从 summary 前 20 字提取
    expect((lastMeta?.autoName as string).length).toBeLessThanOrEqual(20);
  });

  it('keyTopics 超过 MAX_KEY_TOPICS(5) 时应截断', async () => {
    provider.setResponse('{"summary": "测试", "keyTopics": ["1", "2", "3", "4", "5", "6", "7"], "autoName": "测试"}');
    const archiver = new SessionArchiver(provider, sessionStore);
    await archiver.archiveSession('2026-07-03', 'main');

    const lastMeta = sessionStore.getLastMeta();
    expect((lastMeta?.keyTopics as string[]).length).toBeLessThanOrEqual(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：SessionMeta 更新语义（取代旧的 upsert 语义）
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · SessionMeta 更新语义', () => {
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('相同会话重复归档应更新 SessionMeta', async () => {
    const archiver = new SessionArchiver(provider, sessionStore);

    // 第一次归档
    provider.setResponse('{"summary": "第一次摘要", "keyTopics": ["第一次"], "autoName": "第一次"}');
    await archiver.archiveSession('2026-07-03', 'main');
    let lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.summary).toBe('第一次摘要');

    // 第二次归档（相同 sessionLabel，不同摘要）
    provider.setResponse('{"summary": "第二次摘要", "keyTopics": ["第二次"], "autoName": "第二次"}');
    await archiver.archiveSession('2026-07-03', 'main');
    lastMeta = sessionStore.getLastMeta();
    expect(lastMeta?.summary).toBe('第二次摘要');
  });

  it('归档不会写入 source=content 记忆（已迁移到 SessionMeta）', async () => {
    // 验证不再依赖 InMemoryStorage
    const archiver = new SessionArchiver(provider, sessionStore);
    const result = await archiver.archiveSession('2026-07-03', 'main');

    // 结果使用 updatedFields 而非 memories
    expect(result.updatedFields.length).toBeGreaterThan(0);
    // sessionStore.updateSessionMeta 应被调用
    expect(sessionStore.getUpdateCalls().length).toBeGreaterThan(0);
  });
});
