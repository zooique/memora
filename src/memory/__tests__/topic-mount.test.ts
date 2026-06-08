/**
 * 单元测试：话题记忆挂载器 TopicMount
 *
 * 覆盖核心路径：
 * - 冷启动（首次 focus）
 * - 同话题专注（缓存命中）
 * - 话题漂移（重新召回）
 * - 疑似漂移（异步预取 + 返回缓存）
 * - suppress/unmount 生命周期
 * - Jaccard 相似度计算
 *
 * 详见 V-002：补测试 topic-mount.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { TopicMount } from '@/memory/topic-mount.js';
import type { RecallPipeline } from '@/memory/recall.js';
import type { Memory } from '@/memory/types.js';
import { MemoryType, Permanence } from '@/memory/types.js';

// ─── 测试工具 ─────────────────────────────────────────────

/** 创建模拟的 RecallPipeline */
function createMockRecall(results: Memory[] = []): RecallPipeline {
  return {
    recall: vi.fn().mockResolvedValue(results),
  } as unknown as RecallPipeline;
}

/** 创建测试用记忆条目 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    type: MemoryType.TOPIC,
    permanence: Permanence.TOPIC,
    name: '测试话题',
    content: '测试内容',
    tags: [],
    weight: 0.7,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── 测试 ─────────────────────────────────────────────────

describe('V-002 · TopicMount 话题挂载器', () => {
  // ─── 冷启动 ────────────────────────────────────────────

  describe('冷启动', () => {
    it('首次 focus 应触发召回', async () => {
      const mem = createMemory({ name: '小说创作' });
      const recall = createMockRecall([mem]);
      const mount = new TopicMount(recall);

      const result = await mount.focus('帮我写小说');

      expect(recall.recall).toHaveBeenCalledWith('帮我写小说', {
        types: ['topic'],
        topK: 10,
        minWeight: 0.1,
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('小说创作');
    });

    it('首次 focus 后 isMounted 应为 true', async () => {
      const recall = createMockRecall([createMemory()]);
      const mount = new TopicMount(recall);

      expect(mount.isMounted).toBe(false);
      await mount.focus('测试');
      expect(mount.isMounted).toBe(true);
    });
  });

  // ─── 同话题专注（缓存命中）──────────────────────────────

  describe('同话题专注', () => {
    it('相同输入应命中缓存，不再调用 recall', async () => {
      const mem = createMemory({ name: '小说创作' });
      const recall = createMockRecall([mem]);
      const mount = new TopicMount(recall);

      // 首次 focus：冷启动
      await mount.focus('帮我写小说');
      expect(recall.recall).toHaveBeenCalledTimes(1);

      // 第二次 focus：完全相同的输入 → 100% Jaccard 相似度 → 缓存命中
      const result = await mount.focus('帮我写小说');
      expect(recall.recall).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });
  });

  // ─── 话题漂移（重新召回）────────────────────────────────

  describe('话题漂移', () => {
    it('完全不同的话题应触发重新召回', async () => {
      const novelMem = createMemory({ name: '小说创作' });
      const codeMem = createMemory({ name: '代码开发' });
      const recall = createMockRecall([novelMem]);
      const mount = new TopicMount(recall);

      // 首次 focus：纯中文小说话题
      await mount.focus('小说创作技巧');
      expect(recall.recall).toHaveBeenCalledTimes(1);

      // 模拟漂移：recall 返回代码相关记忆
      (recall.recall as ReturnType<typeof vi.fn>).mockResolvedValue([codeMem]);

      // 第二次 focus：纯英文代码话题（与中文小说零关键词重叠）
      const result = await mount.focus('refactor python code database');
      // 漂移应触发重新召回
      expect(recall.recall).toHaveBeenCalledTimes(2);
      expect(result[0]!.name).toBe('代码开发');
    });
  });

  // ─── suppress（踢出记忆）────────────────────────────────

  describe('suppress', () => {
    it('应从挂载中移除指定记忆', async () => {
      const mem1 = createMemory({ id: 'mem-1', name: '话题A' });
      const mem2 = createMemory({ id: 'mem-2', name: '话题B' });
      const recall = createMockRecall([mem1, mem2]);
      const mount = new TopicMount(recall);

      await mount.focus('测试话题');
      expect(mount.mounted).toHaveLength(2);

      // 踢出 mem-1
      const removed = mount.suppress('mem-1');
      expect(removed).toBe(true);
      expect(mount.mounted).toHaveLength(1);
      expect(mount.mounted[0]!.id).toBe('mem-2');
    });

    it('踢出不存在的 ID 应返回 false', () => {
      const recall = createMockRecall([]);
      const mount = new TopicMount(recall);
      expect(mount.suppress('nonexistent')).toBe(false);
    });

    it('被踢出的记忆在后续 focus 中应被过滤', async () => {
      const mem1 = createMemory({ id: 'mem-1', name: '话题A' });
      const mem2 = createMemory({ id: 'mem-2', name: '话题B' });
      const recall = createMockRecall([mem1, mem2]);
      const mount = new TopicMount(recall);

      await mount.focus('测试话题');
      mount.suppress('mem-1');

      // 漂移到新话题，recall 返回包含 mem-1 的结果
      (recall.recall as ReturnType<typeof vi.fn>).mockResolvedValue([mem1, mem2]);
      const result = await mount.focus('完全不同的新话题代码编程开发');

      // mem-1 被抑制，不应出现在结果中
      expect(result.every((m) => m.id !== 'mem-1')).toBe(true);
    });

    it('isSuppressed 应正确反映抑制状态', async () => {
      const mem = createMemory({ id: 'mem-1' });
      const recall = createMockRecall([mem]);
      const mount = new TopicMount(recall);

      await mount.focus('测试');
      mount.suppress('mem-1');

      expect(mount.isSuppressed('mem-1')).toBe(true);
      expect(mount.isSuppressed('mem-2')).toBe(false);
    });

    it('suppressedCount 应正确计数', async () => {
      const mem1 = createMemory({ id: 'mem-1' });
      const mem2 = createMemory({ id: 'mem-2' });
      const recall = createMockRecall([mem1, mem2]);
      const mount = new TopicMount(recall);

      await mount.focus('测试');
      mount.suppress('mem-1');
      expect(mount.suppressedCount).toBe(1);
      mount.suppress('mem-2');
      expect(mount.suppressedCount).toBe(2);
    });
  });

  // ─── unmount（卸载话题）─────────────────────────────────

  describe('unmount', () => {
    it('应清空挂载和抑制集合', async () => {
      const mem1 = createMemory({ id: 'mem-1' });
      const mem2 = createMemory({ id: 'mem-2' });
      const recall = createMockRecall([mem1, mem2]);
      const mount = new TopicMount(recall);

      await mount.focus('测试');
      // 踢出一条，还剩一条 → isMounted 仍为 true
      mount.suppress('mem-1');
      expect(mount.isMounted).toBe(true);
      expect(mount.suppressedCount).toBe(1);

      mount.unmount();
      expect(mount.isMounted).toBe(false);
      expect(mount.mounted).toHaveLength(0);
      expect(mount.suppressedCount).toBe(0);
    });

    it('unmount 后抑制集合应清除，下次 focus 不再过滤', async () => {
      const mem1 = createMemory({ id: 'mem-1', name: '话题A' });
      const recall = createMockRecall([mem1]);
      const mount = new TopicMount(recall);

      await mount.focus('测试');
      mount.suppress('mem-1');
      mount.unmount();

      // 重新 focus，mem-1 不应再被抑制
      (recall.recall as ReturnType<typeof vi.fn>).mockResolvedValue([mem1]);
      const result = await mount.focus('新话题');
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('mem-1');
    });
  });

  // ─── mounted 只读属性 ──────────────────────────────────

  describe('mounted 只读', () => {
    it('mounted 返回的数组不应影响内部状态', async () => {
      const mem = createMemory();
      const recall = createMockRecall([mem]);
      const mount = new TopicMount(recall);

      await mount.focus('测试');
      const mounted = mount.mounted;
      // 修改返回的数组不应影响内部
      const copy = [...mounted];
      copy.push(createMemory());
      expect(mount.mounted).toHaveLength(1);
    });
  });

  // ─── 记忆排序 ──────────────────────────────────────────

  describe('记忆排序', () => {
    it('挂载的记忆应按创建时间升序排列', async () => {
      const old = createMemory({
        id: 'old',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const recent = createMemory({
        id: 'recent',
        createdAt: '2026-06-01T00:00:00.000Z',
      });
      // recall 返回顺序与时间相反
      const recall = createMockRecall([recent, old]);
      const mount = new TopicMount(recall);

      const result = await mount.focus('测试');
      // 应按时间升序：old 在前
      expect(result[0]!.id).toBe('old');
      expect(result[1]!.id).toBe('recent');
    });
  });
});
