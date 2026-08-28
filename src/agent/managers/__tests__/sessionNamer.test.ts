/**
 * SessionNamer 单元测试 — 会话标题层
 *
 * 覆盖：
 * - 正常命名：LLM 返回标题 → setSessionTitle 写入
 * - 会话已有标题 → 跳过（不覆盖手动改名，决策3：仅首次触发）
 * - LLM 返回 null（无价值）→ 降级为占位标题
 * - LLM 抛异常（不可用）→ 降级为占位标题
 * - sessionStore 未注入 → 跳过命名
 * - 标题超长截断
 *
 * 测试模式：MockProvider + MockSessionStore
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionNamer } from '@/agent/managers/sessionNamer.js';
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
 * 可配置响应内容，模拟标题生成。
 * 支持抛出异常以测试降级路径。
 */
class MockProvider extends LlmProvider {
  readonly name = 'mock';
  private response: string;
  private shouldThrow: boolean;

  constructor(response: string = '{"title": "测试标题"}') {
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
// Mock SessionStore（含标题元数据能力）
// ═══════════════════════════════════════════════════════════════

/**
 * Mock SessionStore
 *
 * 内存实现 ISessionStore，支持会话标题元数据读写。
 */
class MockSessionStore implements ISessionStore {
  private messages: SessionMessage[];
  private metas: Map<string, SessionMeta>;
  private roundIdsMap: Map<string, string[]> = new Map();

  constructor(messages: SessionMessage[] = [], metas: SessionMeta[] = []) {
    this.messages = messages;
    this.metas = new Map(metas.map((m) => [m.sessionId, m]));
  }

  /** 预设会话标题元数据（模拟已手动改名） */
  setMeta(meta: SessionMeta): void {
    this.metas.set(meta.sessionId, meta);
  }

  /** 读取会话标题元数据 */
  getMeta(sessionId: string): SessionMeta | undefined {
    return this.metas.get(sessionId);
  }

  loadMessages(): SessionMessage[] {
    return this.messages;
  }

  listSessions(): string[] {
    return [...this.metas.keys()];
  }

  // ── Round-based 方法 ──

  appendRoundId(sessionId: string, roundId: string): void {
    const ids = this.roundIdsMap.get(sessionId) ?? [];
    ids.push(roundId);
    this.roundIdsMap.set(sessionId, ids);
  }

  appendRoundIds(sessionId: string, roundIds: string[]): void {
    const ids = this.roundIdsMap.get(sessionId) ?? [];
    ids.push(...roundIds);
    this.roundIdsMap.set(sessionId, ids);
  }

  getRoundIds(sessionId: string): string[] {
    return this.roundIdsMap.get(sessionId) ?? [];
  }

  setRoundIds(sessionId: string, roundIds: string[]): void {
    this.roundIdsMap.set(sessionId, [...roundIds]);
  }

  createSession(meta: SessionMeta): void {
    this.metas.set(meta.sessionId, { ...meta });
  }

  deleteSession(sessionId: string): void {
    this.metas.delete(sessionId);
    this.roundIdsMap.delete(sessionId);
  }

  getSessionMeta(sessionId: string): SessionMeta | undefined {
    return this.metas.get(sessionId);
  }

  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    this.metas.set(sessionId, {
      ...existing,
      sessionId,
      ...meta,
      updatedAt: new Date().toISOString(),
      messageCount: existing?.messageCount ?? 0,
    });
  }

  listSessionMetas(): SessionMeta[] {
    return [...this.metas.values()];
  }
}

// ═══════════════════════════════════════════════════════════════
// 测试：ensureSessionTitle 主流程
// ═══════════════════════════════════════════════════════════════

describe('SessionNamer · ensureSessionTitle 主流程', () => {
  let provider: MockProvider;
  let sessionStore: MockSessionStore;
  let namer: SessionNamer;

  beforeEach(() => {
    provider = new MockProvider();
    sessionStore = new MockSessionStore();
    namer = new SessionNamer({ getProvider: () => provider, sessionStore });
  });

  it('正常命名：LLM 返回标题应写入 updateSessionMeta', async () => {
    await namer.ensureSessionTitle('2026-07-03', 'main', '帮我写一个排序算法');

    const meta = sessionStore.getMeta('2026-07-03-main');
    expect(meta?.autoName).toBe('测试标题');
    expect(meta?.displayName).toBe('测试标题');
  });

  it('会话已有 autoName 应跳过（不覆盖）', async () => {
    sessionStore.setMeta({
      sessionId: '2026-07-03-main',
      autoName: '已存在的自动命名',
      updatedAt: new Date().toISOString(),
      messageCount: 3,
    });

    await namer.ensureSessionTitle('2026-07-03', 'main', '帮我写代码');

    const meta = sessionStore.getMeta('2026-07-03-main');
    expect(meta?.autoName).toBe('已存在的自动命名');
  });

  it('LLM 返回 null（无价值）应降级为占位标题', async () => {
    provider.setResponse('null');

    await namer.ensureSessionTitle('2026-07-03', 'main', '你好');

    const meta = sessionStore.getMeta('2026-07-03-main');
    expect(meta?.autoName).toMatch(/^新会话 \d{2}:\d{2}$/);
  });

  it('LLM 抛异常（不可用）应降级为占位标题，不抛出', async () => {
    provider.setShouldThrow(true);

    await expect(
      namer.ensureSessionTitle('2026-07-03', 'main', '帮我查资料'),
    ).resolves.toBeUndefined();

    const meta = sessionStore.getMeta('2026-07-03-main');
    expect(meta?.autoName).toMatch(/^新会话 \d{2}:\d{2}$/);
  });

  it('标题超长应被截断', async () => {
    provider.setResponse(`{"title": "${'超'.repeat(100)}"}`);

    await namer.ensureSessionTitle('2026-07-03', 'main', '内容');

    const meta = sessionStore.getMeta('2026-07-03-main');
    expect(meta?.autoName?.length).toBeLessThanOrEqual(30);
  });
});

describe('SessionNamer · 降级策略', () => {
  it('sessionStore 未注入应跳过命名（best-effort）', async () => {
    const provider = new MockProvider();
    const namer = new SessionNamer({ getProvider: () => provider });

    await expect(
      namer.ensureSessionTitle('2026-07-03', 'main', '内容'),
    ).resolves.toBeUndefined();
  });
});