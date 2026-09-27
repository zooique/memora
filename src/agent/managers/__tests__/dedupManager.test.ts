/**
 * 语义去重管理器测试
 *
 * 覆盖核心语义：「判定为重复且 LLM 提供 mergedContent 时，
 * 保留方（高分记忆 a）的内容必须真正落库更新为合并内容」——
 * 若生成 mergedContent 却从不写回 → 合并实为死代码。
 *
 * 通过 mock IMemoryStorage + mock LlmProvider 驱动 deduplicateMemories，
 * 断言保留方内容被覆盖、降级方被软删（score 已物理退役，降级改由 delete 承担）。
 */
import { describe, it, expect, vi } from 'vitest';
import { DedupManager } from '@/agent/managers/dedupManager.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * 创建内存版 IMemoryStorage mock（与 workProjection.test.ts 同模式）
 *
 * score 退役后 demoteMemory 走 delete 软删路径，mock 只需实现写读基础操作。
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
    getBySource: (source: string) => Array.from(store.values()).filter((m) => m.source === source),
    search: () => [],
    count: () => store.size,
    countBySource: (source: string) =>
      Array.from(store.values()).filter((m) => m.source === source).length,
    getAllSources: () => new Map(),
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
    // Given - 两条名称相似（"用户偏好" ⊂ "用户偏好设置" → 相似度 0）的 work-projection 记忆
    const storage = createMockStorage();
    const memA: Memory = {
      id: 'content:a',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: '用户偏好',
      content: '用户偏好简洁 UI',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
    };
    const memB: Memory = {
      id: 'content:b',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: '用户偏好设置',
      content: '用户偏好简洁界面',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
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
    const manager = new DedupManager(storage, provider, undefined, [SOURCE_LABELS.WORK_PROJECTION]);

    // When
    const report = await manager.deduplicateMemories();

    // Then - 报告正确
    expect(report.deduplicatedCount).toBe(1);
    expect(report.demotedIds).toContain('content:b');
    expect(report.verdicts?.[0]?.mergedContent).toBe('合并后的完整偏好：简洁 UI');

    // 核心：保留方 a 内容被合并内容覆盖（若生成 mergedContent 却从不落库 → 合并失效）
    const kept = storage.getById('content:a');
    expect(kept).not.toBeNull();
    expect(kept!.content).toBe('合并后的完整偏好：简洁 UI');

    // 降级方 b 被软删（score 已物理退役：不降分，由 delete 保留可恢复性）
    const demoted = storage.getById('content:b');
    expect(demoted).toBeNull();
  });

  it('未提供 mergedContent 时不应覆盖保留方内容', async () => {
    // Given - 同样两条相似记忆，但 LLM 未给 mergedContent
    const storage = createMockStorage();
    const memA: Memory = {
      id: 'content:a',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: '用户偏好',
      content: '原始A内容',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
    };
    const memB: Memory = {
      id: 'content:b',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: '用户偏好设置',
      content: '原始B内容',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
    };
    storage.upsert(memA);
    storage.upsert(memB);

    const provider = createMockProvider(JSON.stringify({ isDuplicate: true, reason: '语义等价' }));
    const manager = new DedupManager(storage, provider, undefined, [SOURCE_LABELS.WORK_PROJECTION]);

    // When
    await manager.deduplicateMemories();

    // Then - 保留方内容保持原样（仅降级方被软删）
    expect(storage.getById('content:a')!.content).toBe('原始A内容');
    expect(storage.getById('content:b')).toBeNull();
  });
});

describe('DedupManager · 降级与异常路径', () => {
  /**
   * 创建返回预设 JSON 的 mock provider（封装响应解析）
   */
  function providerReturning(json: string): LlmProvider {
    return createMockProvider(json);
  }

  /** 创建抛出异常的 mock provider（验证 catch 降级不阻塞） */
  function throwingProvider(error: Error): LlmProvider {
    return {
      name: 'mock-throw',
      chat: async function* () {
        throw error;
      },
    } as unknown as LlmProvider;
  }

  /** 构造两条指定 name 的 work-projection 记忆 */
  function seedMemories(storage: IMemoryStorage, nameA: string, nameB: string): void {
    storage.upsert({
      id: 'content:a',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: nameA,
      content: '内容 A',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
    });
    storage.upsert({
      id: 'content:b',
      source: SOURCE_LABELS.WORK_PROJECTION,
      name: nameB,
      content: '内容 B',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('backgroundProvider 未注入：返回 skippedReason 且空结果', async () => {
    const storage = createMockStorage();
    seedMemories(storage, '用户偏好', '用户偏好设置');
    const manager = new DedupManager(storage, null, undefined, [SOURCE_LABELS.WORK_PROJECTION]);

    const report = await manager.deduplicateMemories();
    expect(report.scannedCount).toBe(0);
    expect(report.pairCount).toBe(0);
    expect(report.deduplicatedCount).toBe(0);
    expect(report.skippedReason).toBe('backgroundProvider 未注入');
  });

  it('未发现名称相似的记忆对：返回 skippedReason', async () => {
    const storage = createMockStorage();
    // 名称差异大（无包含关系，归一化距离 = 3/3 = 1 > 0.3）→ 不构成候选对
    seedMemories(storage, 'abc', 'xyz');
    const manager = new DedupManager(
      storage,
      providerReturning('{"isDuplicate":false}'),
      undefined,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    const report = await manager.deduplicateMemories();
    expect(report.pairCount).toBe(0);
    expect(report.deduplicatedCount).toBe(0);
    expect(report.skippedReason).toBe('未发现名称相似的记忆对');
    expect(report.scannedCount).toBe(2);
  });

  it('LLM 判定非重复（isDuplicate=false）：不降级任何记忆', async () => {
    const storage = createMockStorage();
    seedMemories(storage, '用户偏好', '用户偏好设置');
    const manager = new DedupManager(
      storage,
      providerReturning(JSON.stringify({ isDuplicate: false, reason: 'B 是 A 的细化，非等价' })),
      undefined,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    const report = await manager.deduplicateMemories();
    expect(report.pairCount).toBe(1);
    expect(report.deduplicatedCount).toBe(0);
    expect(report.demotedIds).toEqual([]);
    // 两条记忆均保留
    expect(storage.getById('content:a')).not.toBeNull();
    expect(storage.getById('content:b')).not.toBeNull();
  });

  it('LLM 判断抛错：单对失败不阻塞，返回空降级结果', async () => {
    const storage = createMockStorage();
    seedMemories(storage, '用户偏好', '用户偏好设置');
    const manager = new DedupManager(
      storage,
      throwingProvider(new Error('LLM 去重请求超时')),
      undefined,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    const report = await manager.deduplicateMemories();
    expect(report.pairCount).toBe(1);
    expect(report.deduplicatedCount).toBe(0);
    expect(report.demotedIds).toEqual([]);
    // 记忆仍保留（未误删）
    expect(storage.getById('content:b')).not.toBeNull();
  });

  it('isDuplicate 且 mergedContent 缺失：reason 使用默认占位', async () => {
    const storage = createMockStorage();
    seedMemories(storage, '用户偏好', '用户偏好设置');
    // LLM 返回 isDuplicate=true 但无 reason
    const manager = new DedupManager(
      storage,
      providerReturning(JSON.stringify({ isDuplicate: true })),
      undefined,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    const report = await manager.deduplicateMemories();
    expect(report.deduplicatedCount).toBe(1);
    expect(report.verdicts?.[0]?.reason).toBe('(LLM 未提供理由)');
  });

  it('onCompleted 回调在完成时触发并携带报告', async () => {
    const storage = createMockStorage();
    seedMemories(storage, '用户偏好', '用户偏好设置');
    const onCompleted = vi.fn();
    const manager = new DedupManager(
      storage,
      providerReturning(
        JSON.stringify({ isDuplicate: true, mergedContent: '合并', reason: '等价' }),
      ),
      onCompleted,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    await manager.deduplicateMemories();
    expect(onCompleted).toHaveBeenCalledTimes(1);
    const payload = onCompleted.mock.calls[0]![0] as {
      demotedIds: string[];
      deduplicatedCount: number;
    };
    expect(payload.demotedIds).toContain('content:b');
    expect(payload.deduplicatedCount).toBe(1);
  });

  it('空名称记忆不与其他记忆构成相似对（computeNameSimilarity 防御）', async () => {
    const storage = createMockStorage();
    // nameA 为空字符串 → 与任何名称相似度视为 1（不同），不构成候选对
    seedMemories(storage, '用户偏好', '');
    const manager = new DedupManager(
      storage,
      providerReturning('{"isDuplicate":false}'),
      undefined,
      [SOURCE_LABELS.WORK_PROJECTION],
    );

    const report = await manager.deduplicateMemories();
    expect(report.pairCount).toBe(0);
    expect(report.skippedReason).toBe('未发现名称相似的记忆对');
  });
});
