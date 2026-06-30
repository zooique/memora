/**
 * 记忆健康度模块单元测试
 *
 * 覆盖范围：
 * - buildHealthDashboard：空记忆库 / 正常记忆库 / 边界值
 * - 重复检测：同名重复 / 内容相似度重复 / 无重复
 * - 过期检测：old_age / low_score / both / 无过期
 * - 低质量检测：内容过短计数
 * - 健康度评分：唯一性 / 新鲜度 / 完整度 / 加权整体分
 * - 健康等级：excellent / good / fair / poor 边界
 * - getDuplicateRemovalIds：保留最高分 / 空列表 / 单条组
 * - getStaleRemovalIds：正常提取 / 空列表
 *
 * 测试策略（对齐 affectController.test.ts 范式）：
 * - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 * - 禁止 @ts-ignore / as any
 */
import { describe, it, expect } from 'vitest';
import {
  buildHealthDashboard,
  getDuplicateRemovalIds,
  getStaleRemovalIds,
} from '../../../sprite/controllers/memoryHealth.js';
import type { MemoryListItem } from '../../../sprite/controllers/memoryController.js';
import type { DuplicateGroup, StaleMemory } from '../../../sprite/controllers/memoryHealth.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 默认内容预览（≥20 字符，避免触发 LOW_QUALITY_MIN_LENGTH） */
const DEFAULT_CONTENT = '这是一条足够长的测试记忆内容数据文本信息';

/** 创建唯一内容文本（≥20 字符，不同 seed 使用完全不同的字符，避免 2-gram 误判） */
function makeContent(seed: string): string {
  // 使用 seed 中第一个字符重复填充到 20 字符
  // 不同 seed 使用不同字符，2-gram 完全不重叠，Jaccard = 0 < 0.85
  const char = seed.charAt(0) || 'X';
  return char.repeat(20);
}

/** 创建测试用 MemoryListItem 对象 */
function makeItem(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'test:default',
    name: '默认记忆',
    source: 'insight',
    score: 0.5,
    contentPreview: DEFAULT_CONTENT,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** 创建距今 N 天前的 ISO 时间字符串 */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

// ─── buildHealthDashboard ────────────────────────────────

describe('buildHealthDashboard', () => {
  it('空记忆列表应返回满分', () => {
    const result = buildHealthDashboard([]);
    expect(result.totalMemories).toBe(0);
    expect(result.scores.overall).toBe(100);
    expect(result.scores.uniqueness).toBe(100);
    expect(result.scores.freshness).toBe(100);
    expect(result.scores.completeness).toBe(100);
    expect(result.duplicates).toEqual([]);
    expect(result.staleMemories).toEqual([]);
    expect(result.lowQualityCount).toBe(0);
    expect(result.healthLabel).toBe('excellent');
    expect(result.healthDescription).toBe('记忆库为空，暂无数据');
  });

  it('完全不重复、不过期、不低质量的记忆库应返回满分', () => {
    const items = [
      makeItem({ id: 'a', name: '记忆A', score: 0.8, contentPreview: makeContent('A'), createdAt: daysAgo(1) }),
      makeItem({ id: 'b', name: '记忆B', score: 0.7, contentPreview: makeContent('B'), createdAt: daysAgo(2) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.duplicates).toHaveLength(0);
    expect(result.staleMemories).toHaveLength(0);
    expect(result.lowQualityCount).toBe(0);
  });

  // ─── 重复检测 ──────────────────────────────────────

  it('同名记忆应检测为 name 类型重复', () => {
    const items = [
      makeItem({ id: 'a', name: '相同名称', contentPreview: '内容A' }),
      makeItem({ id: 'b', name: '相同名称', contentPreview: '内容B' }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.type).toBe('name');
    expect(result.duplicates[0]!.memories).toHaveLength(2);
  });

  it('高度相似内容应检测为 content 类型重复', () => {
    // 仅最后 1 字符不同，2-gram Jaccard 相似度 ≈ 17/18 = 0.944 > 0.85 阈值
    const items = [
      makeItem({ id: 'a', name: '记忆A', contentPreview: 'React 状态管理最佳实践指南介绍XY' }),
      makeItem({ id: 'b', name: '记忆B', contentPreview: 'React 状态管理最佳实践指南介绍XZ' }),
    ];
    const result = buildHealthDashboard(items);
    // 两段文本在 2-gram 上有大量重叠，应触发 content 重复
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.type).toBe('content');
    expect(result.duplicates[0]!.similarity).toBeGreaterThan(0);
  });

  it('不相似的内容不应被标记为重复', () => {
    const items = [
      makeItem({ id: 'a', name: '记忆A', contentPreview: 'React 前端框架开发' }),
      makeItem({ id: 'b', name: '记忆B', contentPreview: 'Python 后端开发框架' }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.duplicates).toHaveLength(0);
  });

  // ─── 过期检测 ──────────────────────────────────────

  it('超过 30 天未访问的记忆应标记为 old_age 过期', () => {
    const items = [
      makeItem({ id: 'a', name: '旧记忆', score: 0.8, createdAt: daysAgo(35) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.staleMemories).toHaveLength(1);
    expect(result.staleMemories[0]!.reason).toBe('old_age');
    expect(result.staleMemories[0]!.daysSinceAccess).toBeGreaterThan(30);
  });

  it('低 score 记忆应标记为 low_score 过期', () => {
    const items = [
      makeItem({ id: 'a', name: '低分记忆', score: 0.1, createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.staleMemories).toHaveLength(1);
    expect(result.staleMemories[0]!.reason).toBe('low_score');
  });

  it('同时满足 old_age 和 low_score 的记忆应标记为 both', () => {
    const items = [
      makeItem({ id: 'a', name: '又旧又低分', score: 0.1, createdAt: daysAgo(40) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.staleMemories).toHaveLength(1);
    expect(result.staleMemories[0]!.reason).toBe('both');
  });

  it('近期访问且正常得分的记忆不应过期', () => {
    const items = [
      makeItem({ id: 'a', name: '正常记忆', score: 0.8, createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.staleMemories).toHaveLength(0);
  });

  // ─── 低质量检测 ────────────────────────────────────

  it('内容过短的记忆应计入低质量计数', () => {
    const items = [
      makeItem({ id: 'a', name: '短记忆', contentPreview: '短' }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.lowQualityCount).toBe(1);
  });

  it('内容足够长的记忆不应计入低质量', () => {
    const items = [
      makeItem({ id: 'a', name: '长记忆', contentPreview: makeContent('足够长') }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.lowQualityCount).toBe(0);
  });

  // ─── 健康度评分 ────────────────────────────────────

  it('有重复记忆时唯一性分应降低', () => {
    const items = [
      makeItem({ id: 'a', name: '重复名', score: 0.8, contentPreview: makeContent('a'), createdAt: daysAgo(1) }),
      makeItem({ id: 'b', name: '重复名', score: 0.7, contentPreview: makeContent('b'), createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    // 2 条记忆，2 条重复 → uniqueness = 100 * (1-2/2) = 0
    expect(result.scores.uniqueness).toBe(0);
    expect(result.scores.freshness).toBe(100);
    expect(result.scores.completeness).toBe(100);
  });

  it('有过期记忆时新鲜度分应降低', () => {
    const items = [
      makeItem({ id: 'a', name: '过期记忆', score: 0.1, createdAt: daysAgo(35) }),
    ];
    const result = buildHealthDashboard(items);
    // 1 条记忆，1 条过期 → freshness = 100 * (1-1/1) = 0
    expect(result.scores.freshness).toBe(0);
    expect(result.scores.uniqueness).toBe(100);
  });

  it('有低质量记忆时完整度分应降低', () => {
    const items = [
      makeItem({ id: 'a', name: '短', score: 0.8, contentPreview: '短', createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    // 1 条记忆，1 条低质量 → completeness = 100 * (1-1/1) = 0
    expect(result.scores.completeness).toBe(0);
  });

  it('加权整体分应按 uniqueness*0.4 + freshness*0.3 + completeness*0.3 计算', () => {
    const items = [
      makeItem({ id: 'a', name: '唯一', score: 0.8, contentPreview: makeContent('a'), createdAt: daysAgo(1) }),
      makeItem({ id: 'b', name: '唯一', score: 0.7, contentPreview: makeContent('b'), createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    // uniqueness=0, freshness=100, completeness=100 → overall = 0*0.4 + 100*0.3 + 100*0.3 = 60
    expect(result.scores.overall).toBe(60);
  });

  // ─── 健康等级边界 ──────────────────────────────────

  it('overall >= 90 应为 excellent', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeItem({ id: `item-${i}`, name: `记忆${i}`, score: 0.8, contentPreview: makeContent(`${i}`), createdAt: daysAgo(1) }),
    );
    const result = buildHealthDashboard(items);
    expect(result.healthLabel).toBe('excellent');
  });

  it('70 <= overall < 90 应为 good', () => {
    // 5条，3条重复 → uniqueness = 100*(1-3/5) = 40, overall = 40*0.4+100*0.3+100*0.3 = 76
    const items = [
      makeItem({ id: 'a', name: '重复', score: 0.8, contentPreview: makeContent('a'), createdAt: daysAgo(1) }),
      makeItem({ id: 'b', name: '重复', score: 0.7, contentPreview: makeContent('b'), createdAt: daysAgo(1) }),
      makeItem({ id: 'c', name: '重复', score: 0.6, contentPreview: makeContent('c'), createdAt: daysAgo(1) }),
      makeItem({ id: 'd', name: '正常', score: 0.8, contentPreview: makeContent('d'), createdAt: daysAgo(1) }),
      makeItem({ id: 'e', name: '正常2', score: 0.8, contentPreview: makeContent('e'), createdAt: daysAgo(1) }),
    ];
    // 5条，3条重复 → uniqueness = 100*(1-3/5) = 40, overall = 40*0.4+100*0.3+100*0.3 = 76
    const result = buildHealthDashboard(items);
    expect(result.healthLabel).toBe('good');
  });

  it('50 <= overall < 70 应为 fair', () => {
    // 5条记忆，3条过期+3条重复 → overall = 40*0.4+40*0.3+100*0.3 = 58
    const items = [
      makeItem({ id: 'a', name: '重复', score: 0.1, contentPreview: makeContent('a'), createdAt: daysAgo(35) }),
      makeItem({ id: 'b', name: '重复', score: 0.1, contentPreview: makeContent('b'), createdAt: daysAgo(35) }),
      makeItem({ id: 'c', name: '重复', score: 0.1, contentPreview: makeContent('c'), createdAt: daysAgo(35) }),
      makeItem({ id: 'd', name: '正常', score: 0.8, contentPreview: makeContent('d'), createdAt: daysAgo(1) }),
      makeItem({ id: 'e', name: '正常2', score: 0.8, contentPreview: makeContent('e'), createdAt: daysAgo(1) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.healthLabel).toBe('fair');
  });

  it('overall < 50 应为 poor', () => {
    // 3条记忆，全部重复+过期+低质量
    const items = [
      makeItem({ id: 'a', name: '重复', score: 0.1, contentPreview: '短', createdAt: daysAgo(35) }),
      makeItem({ id: 'b', name: '重复', score: 0.1, contentPreview: '短', createdAt: daysAgo(35) }),
      makeItem({ id: 'c', name: '重复', score: 0.1, contentPreview: '短', createdAt: daysAgo(35) }),
    ];
    const result = buildHealthDashboard(items);
    expect(result.healthLabel).toBe('poor');
  });
});

// ─── getDuplicateRemovalIds ───────────────────────────────

describe('getDuplicateRemovalIds', () => {
  it('应保留每组中 score 最高的一条，返回其余 ID', () => {
    const duplicates: DuplicateGroup[] = [
      {
        type: 'name',
        memories: [
          makeItem({ id: 'low', name: '重复', score: 0.3 }),
          makeItem({ id: 'high', name: '重复', score: 0.9 }),
          makeItem({ id: 'mid', name: '重复', score: 0.5 }),
        ],
      },
    ];
    const ids = getDuplicateRemovalIds(duplicates);
    // 保留 high(0.9)，删除 low(0.3) 和 mid(0.5)
    expect(ids).toContain('low');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('high');
    expect(ids).toHaveLength(2);
  });

  it('空列表应返回空数组', () => {
    const ids = getDuplicateRemovalIds([]);
    expect(ids).toEqual([]);
  });

  it('单条记忆的重复组应返回空数组（保留唯一一条）', () => {
    const duplicates: DuplicateGroup[] = [
      {
        type: 'name',
        memories: [makeItem({ id: 'only', name: '唯一' })],
      },
    ];
    const ids = getDuplicateRemovalIds(duplicates);
    expect(ids).toEqual([]);
  });

  it('多个重复组应分别处理', () => {
    const duplicates: DuplicateGroup[] = [
      {
        type: 'name',
        memories: [
          makeItem({ id: 'a1', name: 'A', score: 0.8 }),
          makeItem({ id: 'a2', name: 'A', score: 0.3 }),
        ],
      },
      {
        type: 'name',
        memories: [
          makeItem({ id: 'b1', name: 'B', score: 0.1 }),
          makeItem({ id: 'b2', name: 'B', score: 0.9 }),
        ],
      },
    ];
    const ids = getDuplicateRemovalIds(duplicates);
    // 组A保留 a1(0.8)，删除 a2(0.3)；组B保留 b2(0.9)，删除 b1(0.1)
    expect(ids).toContain('a2');
    expect(ids).toContain('b1');
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('b2');
    expect(ids).toHaveLength(2);
  });
});

// ─── getStaleRemovalIds ───────────────────────────────────

describe('getStaleRemovalIds', () => {
  it('应返回所有过期记忆的 ID', () => {
    const stale: StaleMemory[] = [
      { memory: makeItem({ id: 'a' }), reason: 'old_age', daysSinceAccess: 35 },
      { memory: makeItem({ id: 'b' }), reason: 'low_score', daysSinceAccess: 1 },
    ];
    const ids = getStaleRemovalIds(stale);
    expect(ids).toEqual(['a', 'b']);
  });

  it('空列表应返回空数组', () => {
    const ids = getStaleRemovalIds([]);
    expect(ids).toEqual([]);
  });
});