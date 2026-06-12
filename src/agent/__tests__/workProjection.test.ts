/**
 * WorkProjectionManager 单元测试
 *
 * 测试范围：
 *   - 首次读取 → 生成投影
 *   - hash 未变 → 跳过
 *   - hash 变更 → 重新生成
 *   - LLM 失败降级
 *   - schema 校验（summary / structure / keyDecisions）
 *   - loadAll / getProjection 查询
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkProjectionManager } from '../workProjection.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建 Mock LLM Provider
 *
 * @param response 预设的 LLM 返回 JSON
 */
const createMockProvider = (response: string): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

/**
 * 创建 Mock IMemoryStorage（内存存储）
 */
const createMockStorage = (): IMemoryStorage => {
  const store = new Map<string, Memory>();
  return {
    upsert: vi.fn((memory: Memory) => {
      store.set(memory.id, memory);
    }),
    delete: vi.fn((id: string) => {
      store.delete(id);
    }),
    getById: vi.fn((id: string) => store.get(id) ?? null),
    getBySource: vi.fn((source: string) =>
      Array.from(store.values()).filter((m) => m.source === source),
    ),
    search: vi.fn(() => []),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('WorkProjectionManager', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
  });

  describe('ensureProjection', () => {
    it('应该在首次读取时生成投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个关于成长与选择的故事',
        structure: ['第一章 起源', '第二章 抉择', '第三章 归宿'],
        keyDecisions: ['萧然选择救人而非复仇'],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '# 第一章\n\n萧然站在悬崖边...',
        'chapter-001.md',
      );

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('成长与选择');
      expect(result!.structure).toHaveLength(3);
      expect(result!.keyDecisions).toHaveLength(1);
    });

    it('应该在 hash 未变时跳过生成', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);
      const content = '# 第一章\n\n内容...';

      // 首次生成
      await manager.ensureProjection('/project/novel/chapter-001.md', content, 'chapter-001.md');

      // When - 相同内容再次读取
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        content,
        'chapter-001.md',
      );

      // Then - 应该返回已有投影，不再调用 LLM
      expect(result).not.toBeNull();
      expect(provider.chat).toHaveBeenCalledTimes(1); // 只调用了一次 LLM
    });

    it('应该在 hash 变更时重新生成', async () => {
      // Given
      const mockResponse1 = JSON.stringify({
        summary: '旧版本的故事',
        structure: ['第一章'],
        keyDecisions: [],
      });
      const mockResponse2 = JSON.stringify({
        summary: '新版本的故事',
        structure: ['第一章', '第二章'],
        keyDecisions: ['新增决策'],
      });

      let callCount = 0;
      const provider = {
        name: 'mock-multi',
        chat: vi.fn(async function* (_messages: Message[]) {
          callCount++;
          yield { content: callCount === 1 ? mockResponse1 : mockResponse2, done: false };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(mockStorage, provider);

      // 首次生成
      await manager.ensureProjection('/project/novel/chapter-001.md', '# 旧版本', 'chapter-001.md');

      // When - 内容变更
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '# 新版本',
        'chapter-001.md',
      );

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('新版本');
      expect(provider.chat).toHaveBeenCalledTimes(2); // 调用了两次 LLM
    });

    it('应该在 LLM 失败时降级返回 null', async () => {
      // Given
      const provider = {
        name: 'mock-error',
        chat: vi.fn(async function* () {
          throw new Error('LLM 调用失败');
        }),
      } as unknown as LlmProvider;
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '内容',
        'chapter-001.md',
      );

      // Then
      expect(result).toBeNull();
    });
  });

  describe('getProjection', () => {
    it('应该返回已有的投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);
      await manager.ensureProjection('/project/novel/chapter-001.md', '内容', 'chapter-001.md');

      // When
      const result = await manager.getProjection('/project/novel/chapter-001.md');

      // Then
      expect(result).not.toBeNull();
      expect(result!.summary).toContain('一个故事');
    });

    it('应该在无投影时返回 null', async () => {
      // Given
      const provider = createMockProvider('');
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.getProjection('/project/novel/nonexistent.md');

      // Then
      expect(result).toBeNull();
    });
  });

  describe('loadAll', () => {
    it('应该加载所有作品投影', async () => {
      // Given
      const mockResponse = JSON.stringify({
        summary: '一个故事',
        structure: ['第一章'],
        keyDecisions: [],
      });

      const provider = createMockProvider(mockResponse);
      const manager = new WorkProjectionManager(mockStorage, provider);
      await manager.ensureProjection('/project/novel/chapter-001.md', '内容1', 'chapter-001.md');
      await manager.ensureProjection('/project/novel/chapter-002.md', '内容2', 'chapter-002.md');

      // When
      const all = await manager.loadAll();

      // Then
      expect(all).toHaveLength(2);
    });

    it('应该在无投影时返回空数组', async () => {
      // Given
      const provider = createMockProvider('');
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const all = await manager.loadAll();

      // Then
      expect(all).toHaveLength(0);
    });
  });

  describe('LLM 响应解析', () => {
    it('应该在 JSON 解析失败时降级', async () => {
      // Given - LLM 返回非法 JSON
      const provider = createMockProvider('这不是一个合法的 JSON');
      const manager = new WorkProjectionManager(mockStorage, provider);

      // When
      const result = await manager.ensureProjection(
        '/project/novel/chapter-001.md',
        '内容',
        'chapter-001.md',
      );

      // Then - 应该降级但不崩溃
      expect(result).not.toBeNull();
      expect(result!.summary).toBeTruthy();
    });
  });
});
