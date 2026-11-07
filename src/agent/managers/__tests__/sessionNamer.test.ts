/**
 * SessionNamer 单元测试 — 会话标题层
 *
 * 覆盖：
 * - 正常命名：LLM 返回标题 → updateSessionMeta 写入 autoName + displayName
 * - 会话已有标题 → 跳过（不覆盖手动改名，决策3：仅首次触发）
 * - LLM 返回 null（无价值）→ **本轮不写** autoName（读侧现算占位）
 * - LLM 抛异常（不可用）→ **本轮不写** autoName，下一轮可重试
 * - 防复发：第一次失败后第二次成功 → 第二轮必须写入真实标题
 *   （旧实现失败时把占位串写进 autoName，第二轮会被「已有 autoName」跳过而永久不命名）
 * - sessionStore 未注入 → 跳过命名
 * - 标题超长截断
 * - `defaultTitle` 创建时间占位：同一创建时刻恒等（不随读取时刻漂移）
 *
 * 测试模式：MockProvider + MockSessionStore
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionNamer, defaultTitle } from '@/agent/managers/sessionNamer.js';
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

  it('LLM 返回 null（无价值）本轮不写 autoName（留待重试）', async () => {
    provider.setResponse('null');

    await namer.ensureSessionTitle('2026-07-03', 'main', '你好');

    // 不写 = 下一轮仍会尝试命名；写占位串会把「已命名」永久锁死（真机缺陷）
    expect(sessionStore.getMeta('2026-07-03-main')?.autoName).toBeUndefined();
  });

  it('LLM 抛异常（不可用）本轮不写 autoName，且不抛出', async () => {
    provider.setShouldThrow(true);

    await expect(
      namer.ensureSessionTitle('2026-07-03', 'main', '帮我查资料'),
    ).resolves.toBeUndefined();

    expect(sessionStore.getMeta('2026-07-03-main')?.autoName).toBeUndefined();
  });

  it('防复发：第一次失败后第二轮重试必须写入真实标题', async () => {
    // 第一轮：LLM 不可用 → 什么都不写
    provider.setShouldThrow(true);
    await namer.ensureSessionTitle('2026-07-03', 'main', '帮我看这个仓库');
    expect(sessionStore.getMeta('2026-07-03-main')?.autoName).toBeUndefined();

    // 第二轮：LLM 恢复 → 必须真正命名（旧实现会因占位串已写入而永久跳过 ⇒ 此断言转红）
    provider.setShouldThrow(false);
    provider.setResponse('{"title": "仓库结构梳理"}');
    await namer.ensureSessionTitle('2026-07-03', 'main', '帮我看这个仓库');

    expect(sessionStore.getMeta('2026-07-03-main')?.autoName).toBe('仓库结构梳理');
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

    await expect(namer.ensureSessionTitle('2026-07-03', 'main', '内容')).resolves.toBeUndefined();
  });
});

describe('defaultTitle · 创建时间占位（稳定，不随读取时刻漂移）', () => {
  it('同一创建时刻反复调用结果恒等（不得现算 now）', () => {
    // 创建时间 = 固定时点；间隔一段时间再算也必须一模一样
    const createdAt = new Date(2026, 6, 3, 8, 6, 0);
    const first = defaultTitle(createdAt);
    const later = defaultTitle(createdAt);
    expect(first).toBe('新会话 08:06');
    expect(later).toBe(first);
  });

  it('时间取自传入的创建时刻，而非调用时刻', () => {
    // 传入 08:01（创建时刻），当前时刻与之无关 ⇒ 标题必须是 08:01
    expect(defaultTitle(new Date(2026, 6, 3, 8, 1, 0))).toBe('新会话 08:01');
  });

  it('非法创建时刻不抛异常，降级为「新会话」', () => {
    expect(defaultTitle(new Date(Number.NaN))).toBe('新会话');
  });
});
