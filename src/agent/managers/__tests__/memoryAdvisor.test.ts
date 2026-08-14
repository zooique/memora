/**
 * MemoryAdvisor 单元测试 — 记忆顾问（健康诊断 + 关联推荐）
 *
 * 覆盖范围：
 *   - sourceHealth()：source 健康状态判定（healthy/warning/critical）+ 整体状态 + 排序 + 字段精度
 *   - suggest()：关联推荐（无 query 全局推荐 + 有 query 搜索命中优先 + excludeSources + recencyWeight + reason 4 种分支 + contentPreview 截断 + limit）
 *
 * 测试范式：真实 InMemoryStorage 夹具 + 时间偏移构造 + 字段精度断言。
 * 与 memoryInspector.test.ts 同范式，避免 mock 整个 IMemoryStorage 接口。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** 1 天的毫秒数（与 recall.ts ONE_DAY_MS 一致，本地复用避免跨模块导入） */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 构造单条记忆（覆盖 Memory 7 字段，支持覆写）
 * @param overrides - 字段覆写
 * @returns 完整 Memory 对象
 */
function createMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: '默认内容',
    source: SOURCE_LABELS.PROFILE,
    name: 'default',
    createdAt: '2026-06-27T10:00:00.000Z',
    accessedAt: '2026-06-27T10:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

/**
 * 构造指定天数前访问的记忆（用于时效性测试）
 * @param daysAgo - 距今天数
 * @param overrides - 其他字段覆写
 * @returns 完整 Memory 对象
 */
function createMemoryDaysAgo(daysAgo: number, overrides: Partial<Memory> = {}): Memory {
  const accessedAt = new Date(Date.now() - daysAgo * ONE_DAY_MS).toISOString();
  return createMemory({ accessedAt, ...overrides });
}

/** 真实 InMemoryStorage 夹具（每个 it 重建） */
let storage: InMemoryStorage;
/** MemoryAdvisor 实例（每个 it 重建） */
let advisor: MemoryAdvisor;

beforeEach(() => {
  storage = new InMemoryStorage();
  advisor = new MemoryAdvisor(storage);
});

// ─── sourceHealth() ───────────────────────────────────────

describe('MemoryAdvisor.sourceHealth()', () => {
  describe('空存储与健康状态判定', () => {
    it('空存储：sources=[], overallStatus=healthy', () => {
      const report = advisor.sourceHealth();
      expect(report.sources).toEqual([]);
      expect(report.overallStatus).toBe('healthy');
      // diagnosedAt 是 ISO 8601 字符串
      expect(typeof report.diagnosedAt).toBe('string');
      expect(new Date(report.diagnosedAt).toString()).not.toBe('Invalid Date');
    });

    it('healthy：avgScore≥0.5 且 7 天内访问', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.sources).toHaveLength(1);
      expect(report.sources[0]?.status).toBe('healthy');
      expect(report.overallStatus).toBe('healthy');
    });

    it('warning：avgScore<0.5 且 7 天内访问', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.3 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.status).toBe('warning');
      expect(report.overallStatus).toBe('warning');
    });

    it('warning：avgScore≥0.5 且 7-30 天未访问', () => {
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:1', score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.status).toBe('warning');
      expect(report.overallStatus).toBe('warning');
    });

    it('critical：avgScore<0.2 且 7 天内访问', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.1 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.status).toBe('critical');
      expect(report.overallStatus).toBe('critical');
    });

    it('critical：avgScore≥0.5 且 >30 天未访问', () => {
      storage.upsert(createMemoryDaysAgo(40, { id: 'content:1', score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.status).toBe('critical');
      expect(report.overallStatus).toBe('critical');
    });

    it('critical 优先级高于 warning（score 边界 0.2 触发）', () => {
      // score=0.19 + 1 天前访问：触发 critical（score<0.2 优先于 days<7）
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.19 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.status).toBe('critical');
    });
  });

  describe('多 source 整体状态与排序', () => {
    it('overallStatus 取最差 source（healthy + critical → critical）', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'work:1', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(40, { id: 'profile:1', source: SOURCE_LABELS.PROFILE, score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.overallStatus).toBe('critical');
      // 排序：critical 在前，healthy 在后
      expect(report.sources[0]?.source).toBe(SOURCE_LABELS.PROFILE);
      expect(report.sources[1]?.source).toBe(SOURCE_LABELS.WORK_PROJECTION);
    });

    it('overallStatus 取最差 source（healthy + warning → warning）', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'work:1', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(10, { id: 'profile:1', source: SOURCE_LABELS.PROFILE, score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.overallStatus).toBe('warning');
    });

    it('多 source 同状态时保持插入顺序无关（按 status 排序）', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'work:1', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'profile:1', source: SOURCE_LABELS.PROFILE, score: 0.8 }));
      const report = advisor.sourceHealth();
      expect(report.sources).toHaveLength(2);
      // 两个都是 healthy，排序稳定即可
      expect(report.sources.every((s) => s.status === 'healthy')).toBe(true);
    });
  });

  describe('字段精度与边界', () => {
    it('avgScore 四舍五入到 3 位小数', () => {
      // score 0.3333... → avgScore 应为 0.333
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.3333 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.avgScore).toBe(0.333);
    });

    it('daysSinceLastAccess 四舍五入到 1 位小数', () => {
      // 1.5 天前访问
      storage.upsert(createMemoryDaysAgo(1.5, { id: 'content:1', score: 0.7 }));
      const report = advisor.sourceHealth();
      // 允许 ±0.2 误差（测试执行耗时）
      expect(report.sources[0]?.daysSinceLastAccess).toBeGreaterThanOrEqual(1.4);
      expect(report.sources[0]?.daysSinceLastAccess).toBeLessThanOrEqual(1.6);
    });

    it('count 字段反映 source 记忆数', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2', score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:3', score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.count).toBe(3);
    });

    it('avgScore 取该 source 所有记忆的均值', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.6 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2', score: 0.8 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.avgScore).toBe(0.7);
    });

    it('daysSinceLastAccess 取该 source 中最近访问时间', () => {
      // 一条 5 天前，一条 1 天前：取 1 天前
      storage.upsert(createMemoryDaysAgo(5, { id: 'content:1', score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2', score: 0.7 }));
      const report = advisor.sourceHealth();
      expect(report.sources[0]?.daysSinceLastAccess).toBeGreaterThanOrEqual(0.9);
      expect(report.sources[0]?.daysSinceLastAccess).toBeLessThanOrEqual(1.1);
    });
  });
});

// ─── suggest() ────────────────────────────────────────────

describe('MemoryAdvisor.suggest()', () => {
  describe('空存储与无候选', () => {
    it('空存储 + 无 query：返回 []', () => {
      expect(advisor.suggest()).toEqual([]);
    });

    it('空存储 + 有 query：返回 []', () => {
      expect(advisor.suggest('关键词')).toEqual([]);
    });

    it('所有 source 被 excludeSources 排除：返回 []', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.9 }));
      const result = advisor.suggest(undefined, { excludeSources: [SOURCE_LABELS.PROFILE] });
      expect(result).toEqual([]);
    });
  });

  describe('无 query 全局推荐', () => {
    it('仅 content source：返回按 relevance 排序的推荐', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'recent-high', score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:2', name: 'old-low', score: 0.3 }));
      const result = advisor.suggest();
      expect(result).toHaveLength(2);
      // 1 天前 + score 0.9 的 relevance 应高于 10 天前 + score 0.3
      expect(result[0]?.name).toBe('recent-high');
      expect(result[1]?.name).toBe('old-low');
    });

    it('默认排除 persona/rule/skill', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'persona:1', source: SOURCE_LABELS.PERSONA, score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'rule:1', source: SOURCE_LABELS.RULE, score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'skill:1', source: SOURCE_LABELS.SKILL, score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.5 }));
      const result = advisor.suggest();
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe(SOURCE_LABELS.PROFILE);
    });

    it('每个 source 采样 top-N（SUGGEST_TOP_PER_SOURCE=3）', () => {
      // 插入 5 条 content，应只取前 3 条（按 score 降序）
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2', score: 0.8 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:3', score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:4', score: 0.6 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:5', score: 0.5 }));
      const result = advisor.suggest(undefined, { limit: 10 });
      expect(result).toHaveLength(3);
      // 应该取 score 最高的 3 条
      const scores = result.map((r) => r.relevance);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1]!);
      expect(scores[1]).toBeGreaterThanOrEqual(scores[2]!);
    });
  });

  describe('有 query 搜索命中优先', () => {
    it('搜索命中的记忆优先于全局推荐', () => {
      // 一条会被搜索命中（content 含"算法"）
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:hit', name: 'algo', content: '算法优化', score: 0.3 }));
      // 一条不会被命中但 score 更高
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:high', name: 'high', content: '无关内容', score: 0.9 }));
      const result = advisor.suggest('算法');
      expect(result.length).toBeGreaterThan(0);
      // 搜索命中应排第一
      expect(result[0]?.name).toBe('algo');
    });

    it('搜索命中 + 全局补充混合', () => {
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:hit', name: 'hit', content: '算法', score: 0.3 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'profile:1', source: SOURCE_LABELS.PROFILE, name: 'profile-1', score: 0.8 }));
      const result = advisor.suggest('算法', { limit: 5 });
      // 应包含搜索命中 + 全局推荐
      const names = result.map((r) => r.name);
      expect(names).toContain('hit');
      expect(names).toContain('profile-1');
    });

    it('空 query 字符串（仅空格）按无 query 处理', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'test', content: '内容', score: 0.7 }));
      // query 为空格：不调用 search，所有候选都按全局推荐
      const result = advisor.suggest('   ');
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('test');
    });
  });

  describe('limit 控制', () => {
    it('默认 limit=5', () => {
      // 插入 7 条（PROFILE×3 + WORK_PROJECTION×4，跨 source 补足）
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:1', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:2', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.8 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'wp:3', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'profile:1', source: SOURCE_LABELS.PROFILE, score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'profile:2', source: SOURCE_LABELS.PROFILE, score: 0.8 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'profile:3', source: SOURCE_LABELS.PROFILE, score: 0.7 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'work-projection:1', source: SOURCE_LABELS.WORK_PROJECTION, score: 0.9 }));
      const result = advisor.suggest();
      // 默认 limit=5
      expect(result).toHaveLength(5);
    });

    it('自定义 limit=2', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:2', score: 0.8 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:3', score: 0.7 }));
      const result = advisor.suggest(undefined, { limit: 2 });
      expect(result).toHaveLength(2);
    });
  });

  describe('recencyWeight 权重', () => {
    it('recencyWeight=0：relevance 仅由 score 决定', () => {
      // 高 score + 旧 vs 低 score + 新
      storage.upsert(createMemoryDaysAgo(30, { id: 'content:old-high', name: 'old-high', score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:new-low', name: 'new-low', score: 0.3 }));
      const result = advisor.suggest(undefined, { recencyWeight: 0 });
      // score 0.9 应排前
      expect(result[0]?.name).toBe('old-high');
    });

    it('recencyWeight=1：relevance 仅由 recency 决定', () => {
      storage.upsert(createMemoryDaysAgo(30, { id: 'content:old-high', name: 'old-high', score: 0.9 }));
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:new-low', name: 'new-low', score: 0.3 }));
      const result = advisor.suggest(undefined, { recencyWeight: 1 });
      // 1 天前应排前
      expect(result[0]?.name).toBe('new-low');
    });

    it('relevance 四舍五入到 2 位小数', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', score: 0.55 }));
      const result = advisor.suggest(undefined, { recencyWeight: 0.5 });
      // relevance = 0.55*0.5 + recency*0.5，应四舍五入到 2 位
      expect(result[0]?.relevance).toBeLessThanOrEqual(1);
      // 验证最多 2 位小数
      const decimals = (result[0]?.relevance ?? 0).toString().split('.')[1];
      expect(!decimals || decimals.length <= 2).toBe(true);
    });
  });

  describe('reason 推荐理由 4 种分支', () => {
    it('reason="与搜索相关"（搜索命中）', () => {
      storage.upsert(createMemoryDaysAgo(10, { id: 'content:1', name: 'hit', content: '算法', score: 0.5 }));
      const result = advisor.suggest('算法');
      expect(result[0]?.reason).toBe('与搜索相关');
    });

    it('reason="最近访问"（daysSinceAccess<1）', () => {
      // 0.5 天前访问
      storage.upsert(createMemoryDaysAgo(0.5, { id: 'content:1', name: 'recent', score: 0.5 }));
      const result = advisor.suggest();
      expect(result[0]?.reason).toBe('最近访问');
    });

    it('reason="高频记忆"（score≥0.8 且非最近访问）', () => {
      // 5 天前访问 + score 0.9
      storage.upsert(createMemoryDaysAgo(5, { id: 'content:1', name: 'high', score: 0.9 }));
      const result = advisor.suggest();
      expect(result[0]?.reason).toBe('高频记忆');
    });

    it('reason="${source} 推荐"（其他情况）', () => {
      // 5 天前访问 + score 0.5（不满足 ≥0.8，也不满足 <1 天）
      storage.upsert(createMemoryDaysAgo(5, { id: 'profile:1', name: 'mid', score: 0.5 }));
      const result = advisor.suggest();
      expect(result[0]?.reason).toBe('profile 推荐');
    });
  });

  describe('contentPreview 截断', () => {
    it('短内容：原样返回', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: '短内容', score: 0.7 }));
      const result = advisor.suggest();
      expect(result[0]?.contentPreview).toBe('短内容');
    });

    it('长内容（>120 字符）：截断 + …', () => {
      const longContent = 'A'.repeat(200);
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: longContent, score: 0.7 }));
      const result = advisor.suggest();
      // 120 字符 + 1 个 … = 121 字符
      expect(result[0]?.contentPreview).toHaveLength(121);
      expect(result[0]?.contentPreview.endsWith('…')).toBe(true);
    });

    it('恰好 120 字符：原样返回（不截断）', () => {
      const exactContent = 'B'.repeat(120);
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', content: exactContent, score: 0.7 }));
      const result = advisor.suggest();
      expect(result[0]?.contentPreview).toBe(exactContent);
    });
  });

  describe('SuggestHit 字段完整性', () => {
    it('返回对象包含 name/source/relevance/contentPreview/reason 5 字段', () => {
      storage.upsert(createMemoryDaysAgo(1, { id: 'content:1', name: 'test', source: SOURCE_LABELS.PROFILE, content: '内容', score: 0.7 }));
      const result = advisor.suggest();
      expect(result).toHaveLength(1);
      const hit = result[0]!;
      expect(hit).toHaveProperty('name', 'test');
      expect(hit).toHaveProperty('source', SOURCE_LABELS.PROFILE);
      expect(hit).toHaveProperty('relevance');
      expect(hit).toHaveProperty('contentPreview', '内容');
      expect(hit).toHaveProperty('reason');
    });
  });
});
