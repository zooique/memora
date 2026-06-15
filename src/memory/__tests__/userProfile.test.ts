/**
 * UserProfile 单元测试
 *
 * 测试范围：
 *   - 实时归档 upsert（身份、偏好、专业）
 *   - 置信度确认机制
 *   - system prompt 组装
 *
 * 注意：extractUserFacts() 在 agent/ 层，此处通过 archiveFacts() 间接测试归档逻辑。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserProfile } from '../userProfile.js';
import { extractUserFacts } from '@/agent/userFactExtractor.js';
import type { IMemoryStorage } from '../storageInterface.js';
import type { Memory } from '../types.js';
import { SOURCE_LABELS } from '../types.js';

/**
 * 创建 Mock IMemoryStorage
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
    count: vi.fn(() => store.size),
    countBySource: vi.fn((source: string) =>
      Array.from(store.values()).filter((m) => m.source === source).length,
    ),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('UserProfile', () => {
  let mockStorage: IMemoryStorage;
  let userProfile: UserProfile;

  beforeEach(() => {
    mockStorage = createMockStorage();
    userProfile = new UserProfile(mockStorage);
  });

  describe('archiveFacts - 身份信息', () => {
    it('应该归档身份信息到存储', async () => {
      // Given
      await userProfile.load();

      // When
      const facts = extractUserFacts('我叫张三', 'turn-1');
      await userProfile.archiveFacts(facts);

      // Then
      expect(mockStorage.upsert).toHaveBeenCalled();
      const addedMemory = (mockStorage.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Memory;
      expect(addedMemory.source).toBe(SOURCE_LABELS.PROFILE);
    });

    it('应该使用 upsert 语义（幂等写入）', async () => {
      // Given
      await userProfile.load();
      const facts1 = extractUserFacts('我叫张三', 'turn-1');
      await userProfile.archiveFacts(facts1);

      // When - 再次归档相同信息
      const facts2 = extractUserFacts('我叫张三', 'turn-2');
      await userProfile.archiveFacts(facts2);

      // Then - upsert 被调用两次（幂等）
      expect(mockStorage.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('archiveFacts - 偏好信息', () => {
    it('应该归档偏好信息', async () => {
      // Given
      await userProfile.load();

      // When - 正则要求动词后跟 用|写|做|的
      const facts = extractUserFacts('我喜欢用TypeScript', 'turn-1');
      await userProfile.archiveFacts(facts);

      // Then
      expect(mockStorage.upsert).toHaveBeenCalled();
      const addedMemory = (mockStorage.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0]![0] as Memory;
      expect(addedMemory.source).toBe(SOURCE_LABELS.PROFILE);
    });
  });

  describe('archiveFacts - 不匹配输入', () => {
    it('应该在不匹配正则时不归档', async () => {
      // Given
      await userProfile.load();

      // When - "好像"插入导致正则不匹配
      const facts = extractUserFacts('我好像叫张三', 'turn-1');
      await userProfile.archiveFacts(facts);

      // Then - 不匹配正则 → 无事实提取 → upsert 不被调用
      expect(mockStorage.upsert).not.toHaveBeenCalled();
    });
  });

  describe('load', () => {
    it('应该从存储加载已有画像', async () => {
      // Given - 预置一条已确认的画像记忆
      const existingMemory: Memory = {
        id: 'profile:user-profile-identity-姓名-张三',
        content: '姓名: 张三',
        source: SOURCE_LABELS.PROFILE,
        name: 'identity: 姓名: 张三',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 0.9,
      };

      (mockStorage.getBySource as ReturnType<typeof vi.fn>).mockReturnValue([existingMemory]);

      // When
      const entries = await userProfile.load();

      // Then
      expect(entries).toHaveLength(1);
      expect(entries[0]!.value).toBe('姓名: 张三');
      expect(entries[0]!.confirmed).toBe(true);
    });
  });

  describe('buildSystemPrompt', () => {
    it('应该构建用户画像的 system prompt', async () => {
      // Given
      await userProfile.load();
      const facts = extractUserFacts('我叫张三', 'turn-1');
      await userProfile.archiveFacts(facts);

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

      // When - 明确表达（高置信度 ≥ 0.8）
      const facts = extractUserFacts('我叫张三', 'turn-1');
      await userProfile.archiveFacts(facts);

      // Then - 高置信度的应该在 getConfirmed 中
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.length).toBeGreaterThan(0);
      expect(confirmed[0]!.confirmed).toBe(true);
    });

    it('应该为低置信度条目标记为待确认', async () => {
      // Given
      await userProfile.load();

      // When - 较低置信度表达
      const facts = extractUserFacts('我熟悉React', 'turn-1');
      await userProfile.archiveFacts(facts);

      // Then - 低置信度（0.75）应标记为待确认
      const confirmed = userProfile.getConfirmed();
      // 低置信度条目不写入存储，仅存内存缓存
      // getConfirmed 返回已确认条目，低置信度条目不应出现
      expect(confirmed).toHaveLength(0);
    });
  });
});
