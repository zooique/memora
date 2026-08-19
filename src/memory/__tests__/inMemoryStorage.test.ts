/**
 * InMemoryStorage 契约单测
 *
 * 覆盖 IMemoryStorage 接口的核心契约行为：
 *   - upsert/delete 的 sourceCountCache 增量维护
 *   - getById/getBySource 的读取隔离（浅拷贝）
 *   - search 的分词匹配与空查询降级
 *   - decayScores 的时间衰减
 *   - source 校验失败抛 configError
 *   - 软删除机制：delete/restore/purge/listDeleted/purgeExpired
 *
 * 本文件测 InMemoryStorage（内存级），聚焦 sourceCountCache 与衰减逻辑。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { ONE_DAY_MS } from '@/memory/recall.js';
import { MemoraError } from '@/utils/errors.js';
import type { Memory } from '@/memory/types.js';

describe('InMemoryStorage · 内存存储契约', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  // ─── 辅助：构造记忆对象 ───────────────────────────────────

  /** 构造一条测试记忆 */
  function makeMemory(id: string, source: string, score = 0.8): Memory {
    return {
      id,
      content: `内容-${id}`,
      source,
      name: `名称-${id}`,
      createdAt: new Date().toISOString(),
      accessedAt: new Date().toISOString(),
      score,
    };
  }

  // ─── upsert + sourceCountCache 增量维护 ─────────────────

  describe('upsert + sourceCountCache', () => {
    it('插入记忆后 countBySource 应正确计数', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('persona:1', SOURCE_LABELS.PERSONA));

      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(2);
      expect(storage.countBySource(SOURCE_LABELS.PERSONA)).toBe(1);
      expect(storage.countBySource('content')).toBe(0);
    });

    it('更新同 id 同 source 时计数不变', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE, 0.9));

      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
      expect(storage.count()).toBe(1);
    });

    it('更新同 id 不同 source 时旧 source 减 1、新 source 加 1', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
      expect(storage.countBySource(SOURCE_LABELS.PERSONA)).toBe(0);

      // 改 source
      storage.upsert(makeMemory('m1', SOURCE_LABELS.PERSONA));
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(0);
      expect(storage.countBySource(SOURCE_LABELS.PERSONA)).toBe(1);
    });

    it('getAllSources 应返回 source→count 的 Map', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('persona:1', SOURCE_LABELS.PERSONA));

      const sources = storage.getAllSources();
      expect(sources.get(SOURCE_LABELS.RULE)).toBe(2);
      expect(sources.get(SOURCE_LABELS.PERSONA)).toBe(1);
    });
  });

  // ─── delete + sourceCountCache ──────────────────────────

  describe('delete', () => {
    it('删除记忆后 countBySource 应减 1', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(2);

      storage.delete('rule:1');
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
    });

    it('删除不存在的 id 不报错', () => {
      expect(() => storage.delete('nonexistent')).not.toThrow();
    });

    it('source 计数减至 0 时应从 getAllSources 移除该键', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(0);
      expect(storage.getAllSources().has(SOURCE_LABELS.RULE)).toBe(false);
    });
  });

  // ─── 读取隔离（浅拷贝）─────────────────────────────────

  describe('读取隔离', () => {
    it('getById 应返回浅拷贝，修改不影响内部存储', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      const got = storage.getById('rule:1');
      expect(got).not.toBeNull();
      got!.content = '被篡改的内容';

      // 内部存储不受影响
      const again = storage.getById('rule:1');
      expect(again!.content).toBe('内容-rule:1');
    });

    it('getBySource 应返回浅拷贝数组', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      const list = storage.getBySource(SOURCE_LABELS.RULE);
      list[0]!.content = '被篡改';

      const again = storage.getBySource(SOURCE_LABELS.RULE);
      expect(again[0]!.content).toBe('内容-rule:1');
    });

    it('getBySource 应按 score 降序排列', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE, 0.3));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE, 0.9));
      storage.upsert(makeMemory('rule:3', SOURCE_LABELS.RULE, 0.6));

      const list = storage.getBySource(SOURCE_LABELS.RULE);
      expect(list[0]!.score).toBe(0.9);
      expect(list[1]!.score).toBe(0.6);
      expect(list[2]!.score).toBe(0.3);
    });

    it('getById 不存在时应返回 null', () => {
      expect(storage.getById('nonexistent')).toBeNull();
    });
  });

  // ─── search 分词匹配 ───────────────────────────────────

  describe('search', () => {
    it('空查询应按 score 降序返回（limit 限制）', () => {
      storage.upsert(makeMemory('m1', 'content', 0.5));
      storage.upsert(makeMemory('m2', 'content', 0.9));
      storage.upsert(makeMemory('m3', 'content', 0.3));

      const results = storage.search('', 2);
      expect(results).toHaveLength(2);
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.5);
    });

    it('应匹配 content 中的关键词', () => {
      storage.upsert({
        ...makeMemory('m1', 'content'),
        content: '用户偏好使用 TypeScript 开发',
      });
      storage.upsert({
        ...makeMemory('m2', 'content'),
        content: '完全无关的内容',
      });

      const results = storage.search('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('m1');
    });

    it('应匹配 name 中的关键词', () => {
      storage.upsert({
        ...makeMemory('m1', 'content'),
        name: 'TypeScript 规则',
        content: '无关内容',
      });

      const results = storage.search('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('TypeScript 规则');
    });

    it('匹配结果应按 score 降序排列', () => {
      storage.upsert({
        ...makeMemory('m1', 'content', 0.3),
        content: 'TypeScript 内容',
      });
      storage.upsert({
        ...makeMemory('m2', 'content', 0.9),
        content: 'TypeScript 内容',
      });

      const results = storage.search('TypeScript');
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.3);
    });

    it('应尊重 limit 参数', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert({
          ...makeMemory(`m${i}`, 'content', 0.5),
          content: `TypeScript 内容 ${i}`,
        });
      }

      const results = storage.search('TypeScript', 3);
      expect(results).toHaveLength(3);
    });
  });

  // ─── decayScores 时间衰减 ──────────────────────────────

  describe('decayScores', () => {
    it('7 天内的记忆不应衰减', () => {
      const now = new Date();
      storage.upsert(makeMemory('m1', 'content', 0.8));
      // accessedAt 是 now，7 天内不衰减

      const decayed = storage.decayScores(['content'], now);
      expect(decayed).toBe(0);
      expect(storage.getById('m1')!.score).toBe(0.8);
    });

    it('超过 7 天的记忆应衰减（每 7 天 -0.02）', () => {
      const now = new Date();
      // 14 天前访问的记忆（2 个周期）
      const oldDate = new Date(now.getTime() - 14 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'content', 0.8),
        accessedAt: oldDate.toISOString(),
      });

      const decayed = storage.decayScores(['content'], now);
      expect(decayed).toBe(1);
      // 2 个周期：0.8 - 0.02 * 2 = 0.76
      expect(storage.getById('m1')!.score).toBeCloseTo(0.76, 5);
    });

    it('衰减不应低于 DECAY_FLOOR（0.1）', () => {
      const now = new Date();
      // 1000 天前访问的记忆（约 142 个周期）
      const veryOldDate = new Date(now.getTime() - 1000 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'content', 0.8),
        accessedAt: veryOldDate.toISOString(),
      });

      storage.decayScores(['content'], now);
      // 0.8 - 0.02 * 142 = -2.04，应被 floor 到 0.1
      expect(storage.getById('m1')!.score).toBe(0.1);
    });

    it('decayScores 应只衰减指定 source 的记忆', () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 14 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'content', 0.8),
        accessedAt: oldDate.toISOString(),
      });
      storage.upsert({
        ...makeMemory('m2', SOURCE_LABELS.RULE, 0.8),
        accessedAt: oldDate.toISOString(),
      });

      // 只衰减 content，不衰减 rule
      const decayed = storage.decayScores(['content'], now);
      expect(decayed).toBe(1);
      expect(storage.getById('m1')!.score).toBeCloseTo(0.76, 5);
      expect(storage.getById('m2')!.score).toBe(0.8); // rule 未衰减
    });
  });

  // ─── source 校验 ──────────────────────────────────────

  describe('source 校验', () => {
    it('合法 source 应正常写入', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      expect(storage.count()).toBe(1);
    });

    it('严重非法 source（block 级别）应抛 configError', () => {
      // validateSource 对空字符串/纯空格返回 block 级别
      expect(() => storage.upsert(makeMemory('m1', ''))).toThrow(MemoraError);
    });
  });

  // ─── 软删除机制 ─────────────────────────────────

  describe('软删除：delete（软删除）', () => {
    it('软删除后应写入 deletedAt 时间戳', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      // getById 返回 null（活跃态过滤），但 listDeleted 应包含该记忆
      expect(storage.getById('rule:1')).toBeNull();
      const deleted = storage.listDeleted();
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.id).toBe('rule:1');
      expect(deleted[0]!.deletedAt).toBeDefined();
      // deletedAt 应为合法 ISO 8601 时间戳
      expect(new Date(deleted[0]!.deletedAt!).getTime()).not.toBeNaN();
    });

    it('软删除后 countBySource 应减 1（不计入活跃计数）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(2);

      storage.delete('rule:1');
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
    });

    it('软删除后 count() 应不含已软删除的', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      expect(storage.count()).toBe(2);

      storage.delete('rule:1');
      expect(storage.count()).toBe(1);
    });

    it('软删除后 getAllSources 应不含该记忆的计数', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      // source 计数减至 0 时应从 getAllSources 移除该键
      expect(storage.getAllSources().has(SOURCE_LABELS.RULE)).toBe(false);
    });

    it('软删除后 getBySource 应过滤已软删除的', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      const list = storage.getBySource(SOURCE_LABELS.RULE);
      expect(list).toHaveLength(1);
      expect(list[0]!.id).toBe('rule:2');
    });

    it('软删除后 search 应过滤已软删除的', () => {
      storage.upsert({ ...makeMemory('m1', 'content'), content: 'TypeScript 内容' });
      storage.upsert({ ...makeMemory('m2', 'content'), content: 'TypeScript 其他' });
      storage.delete('m1');

      const results = storage.search('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('m2');
    });

    it('软删除后 getById 应返回 null', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      expect(storage.getById('rule:1')).toBeNull();
    });

    it('对已软删除的记忆再次 delete 应为 no-op（不更新 deletedAt）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      const firstDeletedAt = storage.listDeleted()[0]!.deletedAt;

      // 再次 delete 不应改变 deletedAt
      storage.delete('rule:1');
      expect(storage.listDeleted()[0]!.deletedAt).toBe(firstDeletedAt);
    });

    it('对不存在的 id delete 应为 no-op', () => {
      expect(() => storage.delete('nonexistent')).not.toThrow();
      expect(storage.listDeleted()).toHaveLength(0);
    });

    it('软删除后 decayScores 应跳过已软删除的', () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 14 * ONE_DAY_MS);
      storage.upsert({ ...makeMemory('m1', 'content', 0.8), accessedAt: oldDate.toISOString() });
      storage.upsert({ ...makeMemory('m2', 'content', 0.8), accessedAt: oldDate.toISOString() });
      storage.delete('m1');

      const decayed = storage.decayScores(['content'], now);
      // 只有 m2 被衰减，m1 已软删除跳过
      expect(decayed).toBe(1);
    });
  });

  describe('软删除：restore（恢复）', () => {
    it('restore 应清除 deletedAt 并重新计入活跃计数', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      expect(storage.count()).toBe(0);

      storage.restore('rule:1');
      expect(storage.count()).toBe(1);
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
      // getById 应能取到，且 deletedAt 为 undefined
      const restored = storage.getById('rule:1');
      expect(restored).not.toBeNull();
      expect(restored!.deletedAt).toBeUndefined();
    });

    it('restore 后记忆应重新出现在 getBySource 和 search 中', () => {
      storage.upsert({ ...makeMemory('m1', 'content'), content: 'TypeScript 内容' });
      storage.delete('m1');
      expect(storage.search('TypeScript')).toHaveLength(0);

      storage.restore('m1');
      expect(storage.search('TypeScript')).toHaveLength(1);
      expect(storage.getBySource('content')).toHaveLength(1);
    });

    it('restore 后 listDeleted 应不再包含该记忆', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      expect(storage.listDeleted()).toHaveLength(1);

      storage.restore('rule:1');
      expect(storage.listDeleted()).toHaveLength(0);
    });

    it('对活跃记忆 restore 应为 no-op', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      expect(storage.count()).toBe(1);

      storage.restore('rule:1');
      // 计数不变
      expect(storage.count()).toBe(1);
    });

    it('对不存在的 id restore 应为 no-op', () => {
      expect(() => storage.restore('nonexistent')).not.toThrow();
      expect(storage.count()).toBe(0);
    });
  });

  describe('软删除：purge（物理删除）', () => {
    it('purge 软删除记忆后应从 Map 彻底移除', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      expect(storage.listDeleted()).toHaveLength(1);

      storage.purge('rule:1');
      expect(storage.listDeleted()).toHaveLength(0);
      expect(storage.count()).toBe(0);
    });

    it('purge 软删除记忆不应重复扣除计数', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);

      storage.purge('rule:1');
      // 计数不变（delete 时已扣除）
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
    });

    it('purge 活跃记忆应扣除计数', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(2);

      storage.purge('rule:1');
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(1);
    });

    it('对不存在的 id purge 应为 no-op', () => {
      expect(() => storage.purge('nonexistent')).not.toThrow();
    });
  });

  describe('软删除：listDeleted（回收站列表）', () => {
    it('应只列出已软删除的记忆', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('rule:2', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      const deleted = storage.listDeleted();
      expect(deleted).toHaveLength(1);
      expect(deleted[0]!.id).toBe('rule:1');
    });

    it('应按 deletedAt 降序排列（最近删除的在前）', () => {
      storage.upsert(makeMemory('m1', 'content'));
      storage.upsert(makeMemory('m2', 'content'));
      storage.upsert(makeMemory('m3', 'content'));

      // 依次软删除并手动设置不同的 deletedAt（避免同毫秒时间戳导致排序不稳定）
      // m1 最早（10 天前），m2 居中（5 天前），m3 最近（刚刚）
      storage.delete('m1');
      storage.upsert({ ...storage.listDeleted().find((m) => m.id === 'm1')!, deletedAt: new Date(Date.now() - 10 * ONE_DAY_MS).toISOString() });
      storage.delete('m2');
      storage.upsert({ ...storage.listDeleted().find((m) => m.id === 'm2')!, deletedAt: new Date(Date.now() - 5 * ONE_DAY_MS).toISOString() });
      storage.delete('m3');
      // m3 保持当前时间（最近）

      const deleted = storage.listDeleted();
      expect(deleted[0]!.id).toBe('m3');
      expect(deleted[1]!.id).toBe('m2');
      expect(deleted[2]!.id).toBe('m1');
    });

    it('应尊重 limit 参数', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(makeMemory(`m${i}`, 'content'));
        storage.delete(`m${i}`);
      }

      const deleted = storage.listDeleted(2);
      expect(deleted).toHaveLength(2);
    });

    // 边界用例：limit <= 0 或 undefined 应表示"不设上限"（与 storageInterface 契约一致）
    // 回归测试：修复 listDeleted(0) 触发 slice(0,0) 返回空数组的 JS 语义陷阱 bug
    it('limit=0 时返回全部已删除记忆（不设上限语义）', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(makeMemory(`m${i}`, 'content'));
        storage.delete(`m${i}`);
      }

      const deleted = storage.listDeleted(0);
      expect(deleted).toHaveLength(5);
    });

    it('limit=undefined 时返回全部已删除记忆（默认不设上限）', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(makeMemory(`m${i}`, 'content'));
        storage.delete(`m${i}`);
      }

      const deleted = storage.listDeleted(undefined);
      expect(deleted).toHaveLength(5);
    });

    it('limit=-1 时返回全部已删除记忆（负数视为不设上限）', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(makeMemory(`m${i}`, 'content'));
        storage.delete(`m${i}`);
      }

      const deleted = storage.listDeleted(-1);
      expect(deleted).toHaveLength(5);
    });

    it('limit=NaN 时返回全部已删除记忆（NaN 视为不设上限）', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert(makeMemory(`m${i}`, 'content'));
        storage.delete(`m${i}`);
      }

      const deleted = storage.listDeleted(NaN);
      expect(deleted).toHaveLength(5);
    });

    it('应返回浅拷贝（修改不影响内部存储）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      const deleted = storage.listDeleted();
      deleted[0]!.content = '被篡改';

      const again = storage.listDeleted();
      expect(again[0]!.content).toBe('内容-rule:1');
    });

    it('无软删除记忆时应返回空数组', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      expect(storage.listDeleted()).toHaveLength(0);
    });
  });

  describe('软删除：getDeletedById（单点查询）', () => {
    it('软删除态记忆 → 返回该记忆（含 deletedAt）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      const mem = storage.getDeletedById('rule:1');
      expect(mem).not.toBeNull();
      expect(mem!.id).toBe('rule:1');
      // deletedAt 应为非空 ISO 字符串（由 delete 写入）
      expect(mem!.deletedAt).toBeTruthy();
      expect(typeof mem!.deletedAt).toBe('string');
    });

    it('活跃态记忆 → 返回 null（未软删除）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      // 未调用 delete，记忆仍为活跃态
      expect(storage.getDeletedById('rule:1')).toBeNull();
    });

    it('不存在的 id → 返回 null', () => {
      expect(storage.getDeletedById('not:exist')).toBeNull();
    });

    it('应返回浅拷贝（修改不影响内部存储）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');

      const mem = storage.getDeletedById('rule:1');
      mem!.content = '被篡改';

      // 再次查询应返回原始内容（未被外部修改污染）
      const again = storage.getDeletedById('rule:1');
      expect(again!.content).toBe('内容-rule:1');
    });

    it('restore 后 → 返回 null（已恢复为活跃态）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      storage.restore('rule:1');

      // 恢复后记忆不再属于回收站
      expect(storage.getDeletedById('rule:1')).toBeNull();
    });

    it('purge 后 → 返回 null（已彻底删除）', () => {
      storage.upsert(makeMemory('rule:1', SOURCE_LABELS.RULE));
      storage.delete('rule:1');
      storage.purge('rule:1');

      // 物理删除后记忆从 Map 移除
      expect(storage.getDeletedById('rule:1')).toBeNull();
    });
  });

  describe('软删除：purgeExpired（过期清理）', () => {
    it('应清理 deletedAt 早于阈值的记忆', () => {
      storage.upsert(makeMemory('m1', 'content'));
      storage.upsert(makeMemory('m2', 'content'));
      storage.delete('m1');
      storage.delete('m2');

      // 手动篡改 deletedAt 为 31 天前（模拟过期）
      const list = storage.listDeleted();
      const expiredDate = new Date(Date.now() - 31 * ONE_DAY_MS).toISOString();
      // 通过 upsert 覆盖 deletedAt（delta 方式会正确处理计数）
      storage.upsert({ ...list[0]!, deletedAt: expiredDate });

      // 阈值设为 30 天前：31 天前的应被清理
      const threshold = new Date(Date.now() - 30 * ONE_DAY_MS);
      const purged = storage.purgeExpired(threshold);

      expect(purged).toBe(1);
      expect(storage.listDeleted()).toHaveLength(1);
    });

    it('应保留 deletedAt 晚于阈值的记忆', () => {
      storage.upsert(makeMemory('m1', 'content'));
      storage.delete('m1');

      // 阈值设为 60 天前：刚刚删除的应保留
      const threshold = new Date(Date.now() - 60 * ONE_DAY_MS);
      const purged = storage.purgeExpired(threshold);

      expect(purged).toBe(0);
      expect(storage.listDeleted()).toHaveLength(1);
    });

    it('不应清理活跃记忆', () => {
      storage.upsert(makeMemory('m1', 'content'));
      storage.upsert(makeMemory('m2', 'content'));

      // 即便阈值很早，活跃记忆也不受影响
      const threshold = new Date(Date.now() - 365 * ONE_DAY_MS);
      const purged = storage.purgeExpired(threshold);

      expect(purged).toBe(0);
      expect(storage.count()).toBe(2);
    });

    it('应返回被清理的记忆数量', () => {
      storage.upsert(makeMemory('m1', 'content'));
      storage.upsert(makeMemory('m2', 'content'));
      storage.upsert(makeMemory('m3', 'content'));
      storage.delete('m1');
      storage.delete('m2');
      storage.delete('m3');

      // 全部篡改为 100 天前过期
      const expiredDate = new Date(Date.now() - 100 * ONE_DAY_MS).toISOString();
      const list = storage.listDeleted();
      for (const m of list) {
        storage.upsert({ ...m, deletedAt: expiredDate });
      }

      const threshold = new Date(Date.now() - 30 * ONE_DAY_MS);
      const purged = storage.purgeExpired(threshold);

      expect(purged).toBe(3);
      expect(storage.listDeleted()).toHaveLength(0);
    });
  });

  // ─── sourceCountCache 增量不变量（T4 防回归加固）──────────
  // 锁住「缓存派生计数 == 实时重算」，任何新增写路径若遗忘维护缓存即红。

  describe('sourceCountCache 增量不变量（T4 防回归）', () => {
    it('任意写序列（upsert/delete/restore/purgeExpired）后缓存计数应与实时重算一致', () => {
      storage.upsert(makeMemory('r1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('r2', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('p1', SOURCE_LABELS.PERSONA));
      storage.upsert(makeMemory('i1', 'content'));

      storage.delete('r1'); // 软删 r1
      storage.delete('p1'); // 软删 p1
      storage.restore('r1'); // 恢复 r1 → 存活 r1,r2,i1；p1 仍软删

      // 让 p1 过期并物理清理
      const deleted = storage.listDeleted();
      const expired = new Date(Date.now() - 31 * ONE_DAY_MS).toISOString();
      for (const m of deleted) storage.upsert({ ...m, deletedAt: expired });
      storage.purgeExpired(new Date(Date.now() - 30 * ONE_DAY_MS));

      // 不变量 1：缓存计数与实时重算（getBySource 长度）一致
      for (const source of [SOURCE_LABELS.RULE, SOURCE_LABELS.PERSONA, 'content']) {
        expect(storage.countBySource(source)).toBe(storage.getBySource(source).length);
      }
      // 不变量 2：缓存总和 == 存活总数
      const cacheSum = [...storage.getAllSources().values()].reduce((a, b) => a + b, 0);
      expect(cacheSum).toBe(storage.count());

      // 具体期望：p1 已物理清理，RULE 含 r1+r2
      expect(storage.countBySource(SOURCE_LABELS.RULE)).toBe(2);
      expect(storage.countBySource(SOURCE_LABELS.PERSONA)).toBe(0);
      expect(storage.countBySource('content')).toBe(1);
    });
  });

  // ─── close 清理 ───────────────────────────────────────

  describe('close', () => {
    it('close 后应清空所有数据', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      storage.upsert(makeMemory('m2', SOURCE_LABELS.PERSONA));
      expect(storage.count()).toBe(2);

      storage.close();
      expect(storage.count()).toBe(0);
      expect(storage.getAllSources().size).toBe(0);
    });
  });

  // ─── 软删除校验：阻止 upsert 复活 ──────────────

  describe('软删除校验：upsert 复活防护', () => {
    it('对软删除记忆以活跃态 upsert 应抛 configError', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      storage.delete('m1');
      // 此时 m1 处于软删除态

      // 直接 upsert 活跃态（无 deletedAt）应被拒绝
      expect(() => storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE))).toThrow(MemoraError);
      // 计数不应变化（m1 仍是软删除态）
      expect(storage.count()).toBe(0);
      expect(storage.listDeleted()).toHaveLength(1);
    });

    it('restore + upsert 显式恢复路径应正常工作', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      storage.delete('m1');
      expect(storage.count()).toBe(0);

      // 显式 restore 后再 upsert
      storage.restore('m1');
      storage.upsert({ ...makeMemory('m1', SOURCE_LABELS.RULE), content: '更新后的内容' });

      // 记忆已恢复为活跃态，且内容已更新
      expect(storage.count()).toBe(1);
      const got = storage.getById('m1');
      expect(got).not.toBeNull();
      expect(got!.content).toBe('更新后的内容');
      expect(got!.deletedAt).toBeUndefined();
    });

    it('对软删除记忆显式带 deletedAt 的 upsert 应允许（覆盖软删除态）', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      storage.delete('m1');
      const originalDeletedAt = storage.listDeleted()[0]!.deletedAt;

      // 显式带 deletedAt 的 upsert（如测试场景篡改 deletedAt）应允许
      const newDeletedAt = new Date(Date.now() - 10 * ONE_DAY_MS).toISOString();
      storage.upsert({ ...makeMemory('m1', SOURCE_LABELS.RULE), deletedAt: newDeletedAt });

      // deletedAt 应被覆盖为新值
      const deleted = storage.listDeleted()[0];
      expect(deleted!.deletedAt).toBe(newDeletedAt);
      expect(deleted!.deletedAt).not.toBe(originalDeletedAt);
      // 计数仍为 0（仍是软删除态）
      expect(storage.count()).toBe(0);
    });

    it('对活跃记忆 upsert 不受影响', () => {
      storage.upsert(makeMemory('m1', SOURCE_LABELS.RULE));
      // 活跃记忆的常规 upsert 应正常工作
      storage.upsert({ ...makeMemory('m1', SOURCE_LABELS.RULE), content: '更新内容' });

      const got = storage.getById('m1');
      expect(got!.content).toBe('更新内容');
    });

    it('对不存在的 id upsert 不受影响', () => {
      // 新增记忆应正常工作
      storage.upsert(makeMemory('new-id', SOURCE_LABELS.RULE));
      expect(storage.count()).toBe(1);
    });
  });
});
