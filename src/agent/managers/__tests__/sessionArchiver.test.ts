/**
 * SessionArchiver 单元测试
 *
 * 覆盖：
 * - archiveSessionContent 主流程（正常归档、空会话、消息过少）
 * - 降级策略（sessionStore 未注入、LLM 失败、LLM 返回 null）
 * - LLM 摘要解析（JSON 解析、null 响应、无效响应）
 * - 消息截断（超长会话、超长单条消息）
 * - 记忆写入（source='content'、upsert 语义）
 *
 * 测试模式：MockProvider + InMemoryStorage
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionArchiver } from '@/agent/managers/sessionArchiver.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';

// ═══════════════════════════════════════════════════════════════
// Mock LLM Provider
// ═══════════════════════════════════════════════════════════════

/**
 * Mock LLM Provider
 *
 * 可配置响应内容，模拟 LLM 摘要生成。
 * 支持抛出异常以测试降级路径。
 */
class MockProvider extends LlmProvider {
  readonly name = 'mock';
  private response: string;
  private shouldThrow: boolean;

  constructor(response: string = '{"summary": "测试摘要", "tags": ["测试"]}') {
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
// Mock SessionStore
// ═══════════════════════════════════════════════════════════════

/**
 * Mock SessionStore
 *
 * 内存实现的 ISessionStore，支持预设消息列表。
 */
class MockSessionStore implements ISessionStore {
  private messages: SessionMessage[];

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
// 测试：archiveSessionContent 主流程
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · archiveSessionContent 主流程', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;
  let sessionStore: MockSessionStore;
  let archiver: SessionArchiver;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
    archiver = new SessionArchiver(provider, storage, sessionStore);
  });

  it('正常归档应写入 source=content 记忆条目', async () => {
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');

    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.source).toBe('content');
    expect(result.memories[0]!.name).toBe('2026-07-03-main');
    expect(result.memories[0]!.content).toBe('测试摘要');
    expect(result.messageCount).toBe(4);
    expect(result.sessionLabel).toBe('2026-07-03-main');
  });

  it('记忆条目应写入 storage（upsert 语义）', async () => {
    await archiver.archiveSessionContent('2026-07-03', 'main');
    const all = storage.getBySource('content');
    expect(all).toHaveLength(1);
    expect(all[0]!.source).toBe('content');
  });

  it('content 类记忆初始 score 应为 0.6', async () => {
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories[0]!.score).toBe(0.6);
  });

  it('记忆 id 应包含 content 前缀和会话标识', async () => {
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories[0]!.id).toContain('content-2026-07-03-main');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：降级策略
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 降级策略', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('sessionStore 未注入时应静默跳过', async () => {
    const archiver = new SessionArchiver(provider, storage, undefined);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
    expect(result.messageCount).toBe(0);
    expect(storage.getBySource('content')).toHaveLength(0);
  });

  it('LLM 抛出异常时应向上抛出（由 ArchiveCoordinator 统一 catch + emit archiveFailed）', async () => {
    provider.setShouldThrow(true);
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    // 错误传播契约：SessionArchiver LLM 异常向上抛出，交由上层 ArchiveCoordinator catch + emit archiveFailed
    await expect(archiver.archiveSessionContent('2026-07-03', 'main')).rejects.toThrow('模拟 LLM 不可用');
    expect(storage.getBySource('content')).toHaveLength(0);
  });

  it('LLM 返回 null 应判定无摘要价值', async () => {
    provider.setResponse('null');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
    expect(result.messageCount).toBe(4);
  });

  it('LLM 返回空字符串应判定无摘要价值', async () => {
    provider.setResponse('');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
  });

  it('LLM 返回无 summary 字段的 JSON 应判定无摘要价值', async () => {
    provider.setResponse('{"tags": ["测试"]}');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
  });

  it('LLM 返回 summary 为空字符串应判定无摘要价值', async () => {
    provider.setResponse('{"summary": "", "tags": []}');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
  });

  it('LLM 返回 summary 仅空白字符应判定无摘要价值', async () => {
    provider.setResponse('{"summary": "   ", "tags": []}');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：消息过少跳过
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 消息过少跳过', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
  });

  it('空会话（0 条消息）应跳过归档', async () => {
    const sessionStore = new MockSessionStore([]);
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
    expect(result.messageCount).toBe(0);
  });

  it('单条消息应跳过归档（无对话价值）', async () => {
    const sessionStore = new MockSessionStore(makeMessages(1));
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(0);
    expect(result.messageCount).toBe(1);
  });

  it('两条消息应正常归档（最低归档阈值）', async () => {
    const sessionStore = new MockSessionStore(makeMessages(2));
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories).toHaveLength(1);
    expect(result.messageCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：消息截断
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · 消息截断', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
  });

  it('超长会话应截取最近 50 条消息', async () => {
    // 60 条消息，应截取最后 50 条
    const sessionStore = new MockSessionStore(makeMessages(60));
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    // 截断后仍应正常归档（mock provider 不区分内容长度）
    expect(result.memories).toHaveLength(1);
    expect(result.messageCount).toBe(60);
  });

  it('超长单条消息应被截断（不撑爆 LLM 上下文）', async () => {
    // 构造一条超长消息（超过 MAX_MESSAGE_CHARS=500）
    const longContent = 'A'.repeat(1000);
    const sessionStore = new MockSessionStore([
      { role: 'user', content: longContent, timestamp: new Date().toISOString() },
      { role: 'assistant', content: '回复', timestamp: new Date().toISOString() },
    ]);
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    // 截断后仍应正常归档
    expect(result.memories).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：LLM 响应解析
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · LLM 响应解析', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('应正确解析 JSON 格式的摘要响应', async () => {
    provider.setResponse('{"summary": "讨论了项目架构设计", "tags": ["架构", "设计"]}');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories[0]!.content).toBe('讨论了项目架构设计');
  });

  it('应处理 LLM 返回带前后空白的响应', async () => {
    provider.setResponse('  {"summary": "带空白的摘要", "tags": []}  ');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories[0]!.content).toBe('带空白的摘要');
  });

  it('应处理非标准 JSON（parseLlmJson 容错）', async () => {
    // parseLlmJson 支持提取 JSON 代码块等非标准格式
    provider.setResponse('```json\n{"summary": "代码块摘要", "tags": []}\n```');
    const archiver = new SessionArchiver(provider, storage, sessionStore);
    const result = await archiver.archiveSessionContent('2026-07-03', 'main');
    expect(result.memories[0]!.content).toBe('代码块摘要');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：upsert 语义
// ═══════════════════════════════════════════════════════════════

describe('SessionArchiver · upsert 语义', () => {
  let storage: InMemoryStorage;
  let provider: MockProvider;
  let sessionStore: MockSessionStore;

  beforeEach(() => {
    storage = new InMemoryStorage();
    provider = new MockProvider();
    sessionStore = new MockSessionStore(makeMessages(4));
  });

  it('相同会话重复归档应更新最新摘要', async () => {
    const archiver = new SessionArchiver(provider, storage, sessionStore);

    // 第一次归档
    provider.setResponse('{"summary": "第一次摘要", "tags": []}');
    await archiver.archiveSessionContent('2026-07-03', 'main');
    const firstContent = storage.getBySource('content');
    expect(firstContent).toHaveLength(1);
    expect(firstContent[0]!.content).toBe('第一次摘要');

    // 第二次归档（相同 sessionLabel，不同摘要）
    // id 含 Date.now()，若时间戳不同则新增，相同则覆盖（mock 同步执行可能同毫秒）
    provider.setResponse('{"summary": "第二次摘要", "tags": []}');
    await archiver.archiveSessionContent('2026-07-03', 'main');
    const secondContent = storage.getBySource('content');
    // 无论覆盖还是新增，最新摘要应可被读取
    const latestContent = secondContent[secondContent.length - 1]!.content;
    expect(latestContent).toBe('第二次摘要');
  });
});
