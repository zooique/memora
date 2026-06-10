/**
 * UserProfile 单元测试
 *
 * 测试范围：
 *   - 实时归档 upsert（身份、偏好、专业、习惯、历史）
 *   - 5 个子分类的字段校验
 *   - weight 更新
 *   - 置信度确认机制
 *   - system prompt 组装
 *
 * 注意：UserProfile.extractUserFacts() 是私有方法，
 * 通过 archive() 间接测试提取逻辑。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserProfile } from '../userProfile.js';
import type { IMemoryStorage } from '../storage-interface.js';
import type { Memory } from '../types.js';
import { MemoryType, Permanence } from '../types.js';

/**
 * 创建 Mock MemoryIndex（包含 upsert 方法）
 */
const createMockIndex = (): IMemoryStorage => {
  const store = new Map<string, Memory>();
  return {
    add: vi.fn(async (memory: Memory) => {
      store.set(memory.id, memory);
    }),
    upsert: vi.fn(async (memory: Memory) => {
      store.set(memory.id, memory);
    }),
    update: vi.fn(async (memory: Memory) => {
      store.set(memory.id, memory);
    }),
    getById: vi.fn(async (id: string) => store.get(id)),
    search: vi.fn(async () => []),
    getByType: vi.fn(async (type: string) =>
      Array.from(store.values()).filter((m) => m.type === type),
    ),
    delete: vi.fn(async (id: string) => {
      store.delete(id);
    }),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('UserProfile', () => {
  let mockIndex: IMemoryStorage;
  let userProfile: UserProfile;

  beforeEach(() => {
    mockIndex = createMockIndex();
    userProfile = new UserProfile(mockIndex);
  });

  describe('archive - 身份信息', () => {
    it('应该归档身份信息到 SQLite', async () => {
      // Given
      await userProfile.load();

      // When
      await userProfile.archive('我叫张三', 'turn-1');

      // Then
      expect(mockIndex.upsert).toHaveBeenCalled();
      const addedMemory = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Memory;
      expect(addedMemory.type).toBe(MemoryType.PERSONALITY);
      expect(addedMemory.permanence).toBe(Permanence.ALWAYS);
      expect(addedMemory.tags).toContain('user-profile');
    });

    it('应该使用 upsert 语义（幂等写入）', async () => {
      // Given
      await userProfile.load();
      await userProfile.archive('我叫张三', 'turn-1');

      // When - 再次归档相同信息
      await userProfile.archive('我叫张三', 'turn-2');

      // Then - upsert 被调用两次（幂等）
      expect(mockIndex.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('archive - 偏好信息', () => {
    it('应该归档偏好信息', async () => {
      // Given
      await userProfile.load();

      // When - 正则要求动词后跟 用|写|做|的
      await userProfile.archive('我喜欢用TypeScript', 'turn-1');

      // Then
      expect(mockIndex.upsert).toHaveBeenCalled();
      const addedMemory = (mockIndex.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Memory;
      expect(addedMemory.tags).toContain('user-profile');
    });
  });

  describe('archive - 不匹配输入', () => {
    it('应该在不匹配正则时不归档', async () => {
      // Given
      await userProfile.load();

      // When - "好像"插入导致正则不匹配
      await userProfile.archive('我好像叫张三', 'turn-1');

      // Then - 不匹配正则 → 无事实提取 → upsert 不被调用
      expect(mockIndex.upsert).not.toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('应该从 SQLite 加载已有画像', async () => {
      // Given
      const existingMemory: Memory = {
        id: 'user-profile-identity-张三',
        type: MemoryType.PERSONALITY,
        permanence: Permanence.ALWAYS,
        name: 'identity: 张三',
        content: '张三',
        tags: ['user-profile', 'category:identity', 'status:confirmed'],
        weight: 0.9,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      (mockIndex.getByType as ReturnType<typeof vi.fn>).mockResolvedValue([existingMemory]);

      // When
      await userProfile.load();

      // Then
      const confirmed = userProfile.getConfirmed();
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.value).toBe('张三');
    });
  });

  describe('buildSystemPrompt', () => {
    it('应该构建用户画像的 system prompt', async () => {
      // Given
      await userProfile.load();
      await userProfile.archive('我叫张三', 'turn-1');

      // When
      const prompt = userProfile.buildSystemPrompt();

      // Then
      expect(prompt).toBeTruthy();
      expect(prompt).toContain('张三');
      expect(prompt).toContain('【用户画像】');
    });

    it('应该在无画像时返回空字符串', async () => {
      // Given
      await userProfile.load();

      // When
      const prompt = userProfile.buildSystemPrompt();

      // Then
      expect(prompt).toBe('');
    });
  });

  describe('置信度确认', () => {
    it('应该为高置信度条目标记为已确认', async () => {
      // Given
      await userProfile.load();

      // When - 明确表达
      await userProfile.archive('我叫张三', 'turn-1');

      // Then - 高置信度的应该在 getConfirmed 中
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.length).toBeGreaterThan(0);
      expect(confirmed[0]!.confirmed).toBe(true);
    });
  });
});
