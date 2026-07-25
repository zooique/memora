/**
 * 语义去重管理器测试
 *
 * 覆盖 M6 修复的核心语义：「判定为重复且 LLM 提供 mergedContent 时，
 * 保留方（高分记忆 a）的内容必须真正落库更新为合并内容」——
 * 旧实现生成 mergedContent 却从不写回，合并实为死代码。
 *
 * 通过 mock IMemoryStorage + mock LlmProvider 驱动 deduplicateMemories，
 * 断言保留方内容被覆盖、降级方 score 降至低分。
 */
import { describe, it, expect, vi } from 'vitest';
import { DedupManager } from '@/agent/managers/dedupManager.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * 创建内存版 IMemoryStorage mock（与 workProjection.test.ts 同模式）
 */
const createMockStorage = (): IMemoryStorage => {
  const store = new Map<string, Memory>();
  return {
    upsert: (memory: Memory) => {
      store.set(memory.id, memory);
    },
    delete: (id: string) => {
      store.delete(id);
    },
    getById: (id: string) => store.get(id) ?? null,
    getBySource: (source: string) =>
      Array.from(store.values()).filter((m) => m.source === source),
    search: () => [],
    count: () => store.size,
    countBySource: (source: string) =>
      Array.from(store.values()).filter((m) => m.source === source).length,
    close: () => {},
  } as unknown as IMemoryStorage;
};

/**
 * 创建 mock LlmProvider：chat 流式返回预设 JSON（供 judgeWithLlm 解析）
 */
const createMockProvider = (response: string): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

describe('DedupManager · M6 合并内容落库', () => {
  it('判定重复且提供 mergedContent 时，保留方 a 的内容应更新为合并内容', async () => {
    // Given - 两条名称相似（"用户偏好" ⊂ "用户偏好设置" → 相似度 0）的 insight 记忆
    const storage = createMockStorage();
    const memA: Memory = {
      id: 'insight:a',
      source: SOURCE_LABELS.INSIGHT,
      name: '用户偏好',
      content: '用户偏好简洁 UI',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
      score: 0.9, // 高分 → 保留方
    };
    const memB: Memory = {
      id: 'insight:b',
      source: SOURCE_LABELS.INSIGHT,
      name: '用户偏好设置',
      content: '用户偏好简洁界面',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
      score: 0.5, // 低分 → 降级方
    };
    storage.upsert(memA);
    storage.upsert(memB);

    // LLM 判定为重复并给出合并内容
    const provider = createMockProvider(
      JSON.stringify({
        isDuplicate: true,
        mergedContent: '合并后的完整偏好：简洁 UI',
        reason: '语义等价',
      }),
    );
    const manager = new DedupManager(storage, provider);

    // When
    const report = await manager.deduplicateMemories();

    // Then - 报告正确
    expect(report.deduplicatedCount).toBe(1);
    expect(report.demotedIds).toContain('insight:b');
    expect(report.verdicts?.[0]?.mergedContent).toBe('合并后的完整偏好：简洁 UI');

    // M6 核心：保留方 a 内容被合并内容覆盖（旧实现生成 mergedContent 却从不落库）
    const kept = storage.getById('insight:a');
    expect(kept).not.toBeNull();
    expect(kept!.content).toBe('合并后的完整偏好：简洁 UI');

    // 降级方 b score 降至低分（不物理删除，保留可恢复性）
    const demoted = storage.getById('insight:b');
    expect(demoted!.score).toBe(0.1);
  });

  it('未提供 mergedContent 时不应覆盖保留方内容', async () => {
    // Given - 同样两条相似记忆，但 LLM 未给 mergedContent
    const storage = createMockStorage();
    const memA: Memory = {
      id: 'insight:a',
      source: SOURCE_LABELS.INSIGHT,
      name: '用户偏好',
      content: '原始A内容',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
      score: 0.9,
    };
    const memB: Memory = {
      id: 'insight:b',
      source: SOURCE_LABELS.INSIGHT,
      name: '用户偏好设置',
      content: '原始B内容',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
      score: 0.5,
    };
    storage.upsert(memA);
    storage.upsert(memB);

    const provider = createMockProvider(
      JSON.stringify({ isDuplicate: true, reason: '语义等价' }),
    );
    const manager = new DedupManager(storage, provider);

    // When
    await manager.deduplicateMemories();

    // Then - 保留方内容保持原样（仅降级方被降分）
    expect(storage.getById('insight:a')!.content).toBe('原始A内容');
    expect(storage.getById('insight:b')!.score).toBe(0.1);
  });
});
