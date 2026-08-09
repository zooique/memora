/**
 * UserProfile 单元测试
 *
 * 测试范围：
 *   - 实时归档 upsert（身份、偏好、专业）
 *   - 置信度确认机制
 *   - system prompt 组装
 *
 * 注意：extractUserFacts() 在 agent/ 层，此处直接构造 ExtractedFact[]
 *       避免反向依赖 agent/（memory/ 不可依赖 agent/）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserProfile } from '@/memory/userProfile.js';
import type { ExtractedFact } from '@/memory/userProfile.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

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

/**
 * 创建 Mock IMemoryRelationStore（T1-3 防回归用）
 * 仅 removeRelationsByMemoryId 需断言被调用，其余方法返回空实现。
 */
const createMockRelationStore = (): IMemoryRelationStore => {
  return {
    addRelation: vi.fn(),
    getRelations: vi.fn(() => []),
    getRelationsByType: vi.fn(() => []),
    getAllRelations: vi.fn(() => []),
    removeRelation: vi.fn(),
    removeRelationsByMemoryId: vi.fn(() => 0),
  } as unknown as IMemoryRelationStore;
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
      const facts: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ];
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
      const facts1: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ];
      await userProfile.archiveFacts(facts1);

      // When - 再次归档相同信息
      const facts2: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-2', confidence: 0.95 },
      ];
      await userProfile.archiveFacts(facts2);

      // Then - upsert 被调用两次（幂等）
      expect(mockStorage.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('archiveFacts - 偏好信息', () => {
    it('应该归档偏好信息', async () => {
      // Given
      await userProfile.load();

      // When - 偏好声明（高置信度 ≥ 0.8）
      const facts: ExtractedFact[] = [
        { category: 'preference', fieldName: '偏好', value: '偏好: TypeScript', sourceTurn: 'turn-1', confidence: 0.85 },
      ];
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

      // When - 空事实列表（模拟提取器未匹配任何模式）
      const facts: ExtractedFact[] = [];
      await userProfile.archiveFacts(facts);

      // Then - 无事实 → upsert 不被调用
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
      const facts: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ];
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

      // When - 高置信度（≥ 0.8）
      const facts: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ];
      await userProfile.archiveFacts(facts);

      // Then - 高置信度的应该在 getConfirmed 中
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.length).toBeGreaterThan(0);
      expect(confirmed[0]!.confirmed).toBe(true);
    });

    it('应该为低置信度条目标记为待确认', async () => {
      // Given
      await userProfile.load();

      // When - 低置信度（< 0.8）
      const facts: ExtractedFact[] = [
        { category: 'expertise', fieldName: '专长', value: '专长: React', sourceTurn: 'turn-1', confidence: 0.75 },
      ];
      await userProfile.archiveFacts(facts);

      // Then - 低置信度条目不写入存储，仅存内存缓存
      // getConfirmed 返回已确认条目，低置信度条目不应出现
      const confirmed = userProfile.getConfirmed();
      expect(confirmed).toHaveLength(0);
    });
  });
});

// ─── K1：userProfile 深度补测（子分类 + 边界 + 解析降级 + 冲突解决 + confirm/reject） ──
//
// 覆盖目标：
//   - habit/history 子分类归档（原仅测 identity/preference/expertise）
//   - confidence 边界值（0.8 直接归档 / 0.79 待确认）
//   - parseContentField 新格式 JSON + 旧格式 name 降级 + 默认 identity 兜底
//   - removeConflictingEntries 同分类冲突解决（新值替换旧值）
//   - confirm(id) / reject(id) / getPending() 状态流转
//   - buildSystemPrompt 多分类聚合 + value 去前缀
//   - upsert 抛错时降级返回 null

describe('UserProfile K1 深度补测', () => {
  let mockStorage: IMemoryStorage;
  let userProfile: UserProfile;
  /** 内存态存储，便于预置数据 */
  let store: Map<string, Memory>;

  beforeEach(() => {
    store = new Map<string, Memory>();
    mockStorage = {
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
    userProfile = new UserProfile(mockStorage);
  });

  describe('子分类覆盖（habit / history）', () => {
    it('应该归档 habit 子分类（习惯）', async () => {
      await userProfile.load();
      const facts: ExtractedFact[] = [
        { category: 'habit', fieldName: '习惯', value: '习惯: 上午工作', sourceTurn: 'turn-1', confidence: 0.9 },
      ];
      await userProfile.archiveFacts(facts);
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.category === 'habit' && e.value === '习惯: 上午工作')).toBe(true);
    });

    it('应该归档 history 子分类（历史）', async () => {
      await userProfile.load();
      const facts: ExtractedFact[] = [
        { category: 'history', fieldName: '历史', value: '历史: 2024年入职', sourceTurn: 'turn-1', confidence: 0.85 },
      ];
      await userProfile.archiveFacts(facts);
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.category === 'history')).toBe(true);
    });
  });

  describe('confidence 边界值', () => {
    it('confidence=0.8 边界值应直接归档为已确认', async () => {
      await userProfile.load();
      const facts: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 边界测试', sourceTurn: 'turn-1', confidence: 0.8 },
      ];
      await userProfile.archiveFacts(facts);
      // 0.8 ≥ 0.8 → 已确认 → 写入存储
      expect(mockStorage.upsert).toHaveBeenCalled();
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.value === '姓名: 边界测试')).toBe(true);
    });

    it('confidence=0.79 应标记为待确认（持久化但 confirmed=false）', async () => {
      await userProfile.load();
      const facts: ExtractedFact[] = [
        { category: 'identity', fieldName: '姓名', value: '姓名: 低于阈值', sourceTurn: 'turn-1', confidence: 0.79 },
      ];
      await userProfile.archiveFacts(facts);
      // M10 修复：待确认条目仍为持久化（confirmed=false 标记，重启可恢复为 pending），但不注入 system prompt
      expect(mockStorage.upsert).toHaveBeenCalled();
      const stored = (mockStorage.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Memory;
      expect(JSON.parse(stored.content).confirmed).toBe(false);
      // 仍可通过 getPending 访问
      const pending = userProfile.getPending();
      expect(pending.some((e) => e.value === '姓名: 低于阈值')).toBe(true);
      // 不出现在已确认（system prompt）中
      expect(userProfile.getConfirmed().some((e) => e.value === '姓名: 低于阈值')).toBe(false);
    });
  });

  describe('parseContentField 解析降级', () => {
    it('应该从 content JSON 新格式解析 category + value', async () => {
      // 预置新格式：content 为 JSON
      const mem: Memory = {
        id: 'profile:user-profile-preference-测试',
        content: JSON.stringify({ category: 'preference', value: '偏好: 暗色主题' }),
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-preference',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 1.0,
      };
      store.set(mem.id, mem);

      const entries = await userProfile.load();
      const entry = entries.find((e) => e.id === mem.id);
      expect(entry).toBeDefined();
      expect(entry!.category).toBe('preference');
      expect(entry!.value).toBe('偏好: 暗色主题');
    });

    it('应该从 name 字段旧格式降级解析（兼容历史数据）', async () => {
      // 预置旧格式：content 为纯 value，name 为 "${category}: ${value}"
      const mem: Memory = {
        id: 'profile:user-profile-expertise-旧数据',
        content: 'TypeScript',
        source: SOURCE_LABELS.PROFILE,
        name: 'expertise: TypeScript',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 1.0,
      };
      store.set(mem.id, mem);

      const entries = await userProfile.load();
      const entry = entries.find((e) => e.id === mem.id);
      expect(entry).toBeDefined();
      expect(entry!.category).toBe('expertise');
      expect(entry!.value).toBe('TypeScript');
    });

    it('content 非 JSON 且 name 无冒号时应降级为 history 分类', async () => {
      // 预置异常数据：content 非 JSON，name 无冒号
      const mem: Memory = {
        id: 'profile:异常数据',
        content: '纯文本内容',
        source: SOURCE_LABELS.PROFILE,
        name: '无分类标签',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 1.0,
      };
      store.set(mem.id, mem);

      const entries = await userProfile.load();
      const entry = entries.find((e) => e.id === mem.id);
      expect(entry).toBeDefined();
      // 最终降级：默认 history 分类（中性默认，避免 identity 高敏感类别污染画像）
      expect(entry!.category).toBe('history');
      expect(entry!.value).toBe('纯文本内容');
    });
  });

  describe('removeConflictingEntries 同分类冲突解决', () => {
    it('同分类同字段的新值应替换旧值（用户更新信息）', async () => {
      await userProfile.load();
      // 先归档"姓名: 张三"
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      expect(userProfile.getConfirmed().some((e) => e.value === '姓名: 张三')).toBe(true);

      // 再归档"姓名: 李四"（同分类 identity + 同 fieldName "姓名"）
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 李四', sourceTurn: 'turn-2', confidence: 0.9 },
      ]);

      // 旧值"姓名: 张三"应被删除，仅保留"姓名: 李四"
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.value === '姓名: 张三')).toBe(false);
      expect(confirmed.some((e) => e.value === '姓名: 李四')).toBe(true);
    });

    it('同分类不同字段不应替换（姓名 vs 年龄）', async () => {
      await userProfile.load();
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '年龄', value: '年龄: 25', sourceTurn: 'turn-2', confidence: 0.9 },
      ]);

      // 两条都应保留（fieldName 不同，不冲突）
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.value === '姓名: 张三')).toBe(true);
      expect(confirmed.some((e) => e.value === '年龄: 25')).toBe(true);
    });

    it('value 无前缀时仍能基于 fieldName 正确识别冲突', async () => {
      // 场景：LLM 提取输出 value 无 "姓名:" 前缀，仅靠 fieldName 识别冲突
      await userProfile.load();
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '张三', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '李四', sourceTurn: 'turn-2', confidence: 0.9 },
      ]);

      // 旧值"张三"应被删除，仅保留"李四"（基于 fieldName 识别冲突，不依赖 value 前缀）
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.some((e) => e.value === '张三')).toBe(false);
      expect(confirmed.some((e) => e.value === '李四')).toBe(true);
    });
  });

  describe('M2/M3/M10 修复回归', () => {
    it('M2：已确认条目不因同 value 低置信度重提取而降级', async () => {
      await userProfile.load();
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ]);
      expect(userProfile.getConfirmed().some((e) => e.value === '姓名: 张三')).toBe(true);

      // 同 value 低置信度重提取（如对话中再次提及但 LLM 置信度低）
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-2', confidence: 0.3 },
      ]);

      // 已确认态应保留（不被覆盖降级）
      expect(userProfile.getConfirmed().some((e) => e.value === '姓名: 张三')).toBe(true);
    });

    it('M3：不同 fieldName 同 value 应分配不同 id 而不互相覆盖', async () => {
      await userProfile.load();
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '张三', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '别名', value: '张三', sourceTurn: 'turn-2', confidence: 0.9 },
      ]);

      // 两条均应保留（不同 fieldName → 不同 id），不应静默丢失
      const confirmed = userProfile.getConfirmed();
      expect(confirmed.filter((e) => e.value === '张三').length).toBe(2);
    });

    it('M10：重启后待确认条目由存储恢复为 pending', async () => {
      const pendingMem: Memory = {
        id: 'profile:user-profile-identity-姓名-李四',
        content: JSON.stringify({ category: 'identity', value: '姓名: 李四', fieldName: '姓名', confirmed: false }),
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 1.0,
      };
      const confirmedMem: Memory = {
        id: 'profile:user-profile-identity-姓名-王五',
        content: JSON.stringify({ category: 'identity', value: '姓名: 王五', fieldName: '姓名', confirmed: true }),
        source: SOURCE_LABELS.PROFILE,
        name: '用户画像-identity',
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
        score: 1.0,
      };
      mockStorage.upsert(pendingMem);
      mockStorage.upsert(confirmedMem);

      const entries = await userProfile.load();
      expect(userProfile.getPending().some((e) => e.value === '姓名: 李四')).toBe(true);
      expect(userProfile.getConfirmed().some((e) => e.value === '姓名: 王五')).toBe(true);
      expect(entries.length).toBe(2);
    });
  });

  describe('confirm / reject / getPending 状态流转', () => {
    it('confirm(id) 应将待确认条目标记为已确认并写入存储', async () => {
      await userProfile.load();
      // 归档低置信度条目（待确认）
      await userProfile.archiveFacts([
        { category: 'expertise', fieldName: '专长', value: '专长: React', sourceTurn: 'turn-1', confidence: 0.7 },
      ]);
      const pending = userProfile.getPending();
      expect(pending).toHaveLength(1);
      // M10：待确认条目已持久化（confirmed=false）
      expect(mockStorage.upsert).toHaveBeenCalled();

      // 用户确认
      await userProfile.confirm(pending[0]!.id);

      // 应再次写入存储（confirmed=true）+ 从 pending 移除 + 出现在 confirmed
      expect((mockStorage.upsert as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
      expect(userProfile.getPending()).toHaveLength(0);
      expect(userProfile.getConfirmed().some((e) => e.value === '专长: React')).toBe(true);
    });

    it('confirm(不存在的 id) 应安全无副作用', async () => {
      await userProfile.load();
      await userProfile.confirm('profile:不存在的-id');
      // 不抛错 + 不写入存储
      expect(mockStorage.upsert).not.toHaveBeenCalled();
    });

    it('reject(id) 应从缓存删除并尝试从存储删除', async () => {
      await userProfile.load();
      // 归档高置信度条目（已确认 + 写入存储）
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 测试', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      const confirmed = userProfile.getConfirmed();
      expect(confirmed).toHaveLength(1);

      // 用户拒绝
      await userProfile.reject(confirmed[0]!.id);

      // 应从缓存删除 + 从存储删除
      expect(userProfile.getConfirmed()).toHaveLength(0);
      expect(mockStorage.delete).toHaveBeenCalled();
    });

    it('reject(待确认条目) 应仅从缓存删除（存储中不存在）', async () => {
      await userProfile.load();
      // 归档低置信度条目（待确认，未写入存储）
      await userProfile.archiveFacts([
        { category: 'expertise', fieldName: '专长', value: '专长: 待删除', sourceTurn: 'turn-1', confidence: 0.7 },
      ]);
      const pending = userProfile.getPending();
      expect(pending).toHaveLength(1);

      // 用户拒绝
      await userProfile.reject(pending[0]!.id);

      // 应从缓存删除；存储 delete 调用应安全降级（条目不存在）
      expect(userProfile.getPending()).toHaveLength(0);
      // delete 会被调用但不会抛错（mockStorage.delete 对不存在 id 安全）
      expect(mockStorage.delete).toHaveBeenCalled();
    });
  });

  describe('buildSystemPrompt 多分类聚合', () => {
    it('应按分类分组聚合 + value 去除前缀', async () => {
      await userProfile.load();
      await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.9 },
        { category: 'identity', fieldName: '年龄', value: '年龄: 25', sourceTurn: 'turn-2', confidence: 0.9 },
        { category: 'preference', fieldName: '偏好', value: '偏好: 暗色主题', sourceTurn: 'turn-3', confidence: 0.9 },
        { category: 'expertise', fieldName: '专长', value: '专长: TypeScript', sourceTurn: 'turn-4', confidence: 0.9 },
      ]);

      const prompt = userProfile.buildSystemPrompt();
      expect(prompt).toContain('【用户画像】');
      // 同分类应聚合为一行，用逗号分隔
      expect(prompt).toContain('- 身份：张三，25');
      expect(prompt).toContain('- 偏好：暗色主题');
      expect(prompt).toContain('- 专长：TypeScript');
    });
  });

  describe('upsert 抛错降级', () => {
    it('storage.upsert 抛错时 archiveFacts 应降级返回 null（不抛出）', async () => {
      // 让 upsert 抛错
      (mockStorage.upsert as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('存储不可用');
      });
      await userProfile.load();

      // 不应抛错，应降级返回空数组
      const result = await userProfile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 错误测试', sourceTurn: 'turn-1', confidence: 0.9 },
      ]);
      // upsertFact 返回 null → archiveFacts 返回空数组
      expect(result).toEqual([]);
    });
  });

  describe('关系侧车守门（T1-3 防回归 · 孤儿边清理）', () => {
    it('reject 删除记忆前应先清理该记忆的关系边', async () => {
      // Given：注入 relationStore 的 UserProfile
      const relationStore = createMockRelationStore();
      const profile = new UserProfile(mockStorage, relationStore);
      await profile.load();

      // When：归档一条身份记忆，再拒绝它
      const written = await profile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ]);
      const id = written[0]!.id;
      await profile.reject(id);

      // Then：关系侧车先被调用清边，再删记忆本身（顺序 = 先清关系后删，防孤儿边）
      expect(relationStore.removeRelationsByMemoryId).toHaveBeenCalledWith(id);
      expect(mockStorage.delete).toHaveBeenCalledWith(id);
    });

    it('冲突覆盖删除旧条目前应先清理旧条目的关系边', async () => {
      // Given：注入 relationStore 的 UserProfile
      const relationStore = createMockRelationStore();
      const profile = new UserProfile(mockStorage, relationStore);
      await profile.load();

      // When：先归档「张三」，再归档同 category+fieldName 不同 value 的「李四」触发冲突覆盖
      const v1 = await profile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 张三', sourceTurn: 'turn-1', confidence: 0.95 },
      ]);
      const oldId = v1[0]!.id;
      await profile.archiveFacts([
        { category: 'identity', fieldName: '姓名', value: '姓名: 李四', sourceTurn: 'turn-2', confidence: 0.95 },
      ]);

      // Then：removeConflictingEntries 删除旧条目时应先清其关系边
      expect(relationStore.removeRelationsByMemoryId).toHaveBeenCalledWith(oldId);
    });

    it('未注入 relationStore 时应退化为不守门（向后兼容，不抛错）', async () => {
      // Given：按旧契约构造（无 relationStore）
      const profile = new UserProfile(mockStorage);
      await profile.load();

      // When/Then：reject 不应因缺少 relationStore 而抛错
      const written = await profile.archiveFacts([
        { category: 'preference', fieldName: '主题', value: '偏好: 暗色', sourceTurn: 'turn-1', confidence: 0.95 },
      ]);
      await expect(profile.reject(written[0]!.id)).resolves.toBeUndefined();
    });
  });
});
