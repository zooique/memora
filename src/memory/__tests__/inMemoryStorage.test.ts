/**
 * InMemoryStorage 契约单测
 *
 * 覆盖 IMemoryStorage 接口的核心契约行为：
 *   - upsert/delete 的 sourceCountCache 增量维护
 *   - getById/getBySource 的读取隔离（浅拷贝）
 *   - search 的分词匹配与空查询降级
 *   - decayScores 的时间衰减
 *   - source 校验失败抛 configError
 *
 * 与 store.test.ts 的区别：store.test.ts 测 FileStore（文件级），
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
      expect(storage.countBySource('insight')).toBe(0);
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
      storage.upsert(makeMemory('m1', 'insight', 0.5));
      storage.upsert(makeMemory('m2', 'insight', 0.9));
      storage.upsert(makeMemory('m3', 'insight', 0.3));

      const results = storage.search('', 2);
      expect(results).toHaveLength(2);
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.5);
    });

    it('应匹配 content 中的关键词', () => {
      storage.upsert({
        ...makeMemory('m1', 'insight'),
        content: '用户偏好使用 TypeScript 开发',
      });
      storage.upsert({
        ...makeMemory('m2', 'insight'),
        content: '完全无关的内容',
      });

      const results = storage.search('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('m1');
    });

    it('应匹配 name 中的关键词', () => {
      storage.upsert({
        ...makeMemory('m1', 'insight'),
        name: 'TypeScript 规则',
        content: '无关内容',
      });

      const results = storage.search('TypeScript');
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('TypeScript 规则');
    });

    it('匹配结果应按 score 降序排列', () => {
      storage.upsert({
        ...makeMemory('m1', 'insight', 0.3),
        content: 'TypeScript 内容',
      });
      storage.upsert({
        ...makeMemory('m2', 'insight', 0.9),
        content: 'TypeScript 内容',
      });

      const results = storage.search('TypeScript');
      expect(results[0]!.score).toBe(0.9);
      expect(results[1]!.score).toBe(0.3);
    });

    it('应尊重 limit 参数', () => {
      for (let i = 0; i < 5; i++) {
        storage.upsert({
          ...makeMemory(`m${i}`, 'insight', 0.5),
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
      storage.upsert(makeMemory('m1', 'insight', 0.8));
      // accessedAt 是 now，7 天内不衰减

      const decayed = storage.decayScores(['insight'], now);
      expect(decayed).toBe(0);
      expect(storage.getById('m1')!.score).toBe(0.8);
    });

    it('超过 7 天的记忆应衰减（每 7 天 -0.02）', () => {
      const now = new Date();
      // 14 天前访问的记忆（2 个周期）
      const oldDate = new Date(now.getTime() - 14 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'insight', 0.8),
        accessedAt: oldDate.toISOString(),
      });

      const decayed = storage.decayScores(['insight'], now);
      expect(decayed).toBe(1);
      // 2 个周期：0.8 - 0.02 * 2 = 0.76
      expect(storage.getById('m1')!.score).toBeCloseTo(0.76, 5);
    });

    it('衰减不应低于 DECAY_FLOOR（0.1）', () => {
      const now = new Date();
      // 1000 天前访问的记忆（约 142 个周期）
      const veryOldDate = new Date(now.getTime() - 1000 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'insight', 0.8),
        accessedAt: veryOldDate.toISOString(),
      });

      storage.decayScores(['insight'], now);
      // 0.8 - 0.02 * 142 = -2.04，应被 floor 到 0.1
      expect(storage.getById('m1')!.score).toBe(0.1);
    });

    it('decayScores 应只衰减指定 source 的记忆', () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 14 * ONE_DAY_MS);
      storage.upsert({
        ...makeMemory('m1', 'insight', 0.8),
        accessedAt: oldDate.toISOString(),
      });
      storage.upsert({
        ...makeMemory('m2', SOURCE_LABELS.RULE, 0.8),
        accessedAt: oldDate.toISOString(),
      });

      // 只衰减 insight，不衰减 rule
      const decayed = storage.decayScores(['insight'], now);
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
});
