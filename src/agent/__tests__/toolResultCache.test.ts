/**
 * ToolResultCache 单元测试
 * 覆盖闭环内工具防重缓存的全部公开 API + DEDUP_KEY_EXTRACTORS 内置生成器
 *
 * 测试矩阵：
 *   ToolResultCache 类：set / check / clear / invalidateFile / size
 *   边界：同 tool 不同 key / 同 key 不同 tool / clear 后清空 / invalidate 精确匹配
 *   DEDUP_KEY_EXTRACTORS：3 个内置生成器 + 空值 + 非法 JSON
 */
import { describe, it, expect } from 'vitest';
import { ToolResultCache, DEDUP_KEY_EXTRACTORS } from '@/agent/toolResultCache.js';

describe('ToolResultCache', () => {
  describe('set + check 基础行为', () => {
    it('存一条 → check 命中并返回首次缓存条目', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/foo/bar.md', 3, 1700000000000);

      const hit = cache.check('read_file', '/foo/bar.md');
      expect(hit).toBeDefined();
      expect(hit?.cachedAtIteration).toBe(3);
      expect(hit?.fileMtime).toBe(1700000000000);
    });

    it('未存 → check 返回 undefined', () => {
      const cache = new ToolResultCache();
      const hit = cache.check('read_file', '/foo/bar.md');
      expect(hit).toBeUndefined();
    });

    it('同 toolName 不同 dedupKey → 互不干扰', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/a.md', 1);
      cache.set('read_file', '/b.md', 2);

      expect(cache.check('read_file', '/a.md')?.cachedAtIteration).toBe(1);
      expect(cache.check('read_file', '/b.md')?.cachedAtIteration).toBe(2);
      expect(cache.size).toBe(2);
    });

    it('不同 toolName 同 dedupKey → 互不干扰', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/shared/path', 1);
      cache.set('list_dir', '/shared/path', 2);

      expect(cache.check('read_file', '/shared/path')?.cachedAtIteration).toBe(1);
      expect(cache.check('list_dir', '/shared/path')?.cachedAtIteration).toBe(2);
      expect(cache.size).toBe(2);
    });
  });

  describe('invalidateFile 精确失效', () => {
    it('write_file 后 invalidateFile → 同 path 的 read_file 缓存被删', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/project/main.ts', 5, 1700000000000);

      // 模拟 write_file 成功 → 内核主动失效
      cache.invalidateFile('/project/main.ts');

      expect(cache.check('read_file', '/project/main.ts')).toBeUndefined();
    });

    it('invalidateFile 不影响其他文件的 read_file 缓存', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/project/main.ts', 1);
      cache.set('read_file', '/project/utils.ts', 2);

      cache.invalidateFile('/project/main.ts');

      // main.ts 被删，utils.ts 保留
      expect(cache.check('read_file', '/project/main.ts')).toBeUndefined();
      expect(cache.check('read_file', '/project/utils.ts')).toBeDefined();
      expect(cache.size).toBe(1);
    });

    it('invalidateFile 不影响 list_dir 缓存（文件修改不改目录结构）', () => {
      const cache = new ToolResultCache();
      cache.set('list_dir', '/project/src', 1);
      cache.set('read_file', '/project/src/main.ts', 2);

      cache.invalidateFile('/project/src/main.ts');

      // list_dir 缓存不受影响
      expect(cache.check('list_dir', '/project/src')).toBeDefined();
      // read_file 同文件被删
      expect(cache.check('read_file', '/project/src/main.ts')).toBeUndefined();
    });

    it('invalidateFile 对不存在的 path 静默无操作', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/exists.md', 1);

      cache.invalidateFile('/does/not/exist.md');

      expect(cache.check('read_file', '/exists.md')).toBeDefined();
      expect(cache.size).toBe(1);
    });
  });

  describe('clear 闭环结束清空', () => {
    it('clear 后 size=0 且全部 check miss', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/a.md', 1);
      cache.set('list_dir', '/b', 2);
      cache.set('web_search', 'query', 3);
      expect(cache.size).toBe(3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.check('read_file', '/a.md')).toBeUndefined();
      expect(cache.check('list_dir', '/b')).toBeUndefined();
      expect(cache.check('web_search', 'query')).toBeUndefined();
    });
  });

  describe('set 可选 fileMtime', () => {
    it('read_file 带 mtime → check 可取到', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/p', 1, 1234567890);
      expect(cache.check('read_file', '/p')?.fileMtime).toBe(1234567890);
    });

    it('web_search 不传 mtime → check 返回 undefined', () => {
      const cache = new ToolResultCache();
      cache.set('web_search', 'q', 1);
      expect(cache.check('web_search', 'q')?.fileMtime).toBeUndefined();
    });
  });

  describe('size 属性实时反映', () => {
    it('每次 set 后 size++，invalidateFile 后 size--', () => {
      const cache = new ToolResultCache();
      expect(cache.size).toBe(0);

      cache.set('read_file', '/a', 1);
      expect(cache.size).toBe(1);

      cache.set('read_file', '/b', 2);
      expect(cache.size).toBe(2);

      cache.invalidateFile('/a');
      expect(cache.size).toBe(1);
    });

    it('同 key set 覆盖 → size 不变', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', '/a', 1);
      cache.set('read_file', '/a', 5); // 覆盖
      expect(cache.size).toBe(1);
      expect(cache.check('read_file', '/a')?.cachedAtIteration).toBe(5);
    });
  });
});

describe('DEDUP_KEY_EXTRACTORS', () => {
  describe('read_file', () => {
    it('正确提取 path', () => {
      const key = DEDUP_KEY_EXTRACTORS.read_file!('{"path":"/foo/bar.md"}');
      expect(key).toBe('/foo/bar.md');
    });

    it('path 缺失 → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.read_file!('{"content":"hello"}');
      expect(key).toBeUndefined();
    });

    it('非法 JSON → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.read_file!('not-json');
      expect(key).toBeUndefined();
    });

    it('空 JSON → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.read_file!('{}');
      expect(key).toBeUndefined();
    });
  });

  describe('list_dir', () => {
    it('正确提取 path', () => {
      const key = DEDUP_KEY_EXTRACTORS.list_dir!('{"path":"/some/dir"}');
      expect(key).toBe('/some/dir');
    });

    it('path 缺失 → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.list_dir!('{}');
      expect(key).toBeUndefined();
    });

    it('非法 JSON → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.list_dir!('broken');
      expect(key).toBeUndefined();
    });
  });

  describe('web_search', () => {
    it('正确提取 query', () => {
      const key = DEDUP_KEY_EXTRACTORS.web_search!('{"query":"memora agent"}');
      expect(key).toBe('memora agent');
    });

    it('query 缺失 → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.web_search!('{"maxResults":5}');
      expect(key).toBeUndefined();
    });

    it('非法 JSON → undefined', () => {
      const key = DEDUP_KEY_EXTRACTORS.web_search!('{bad json');
      expect(key).toBeUndefined();
    });
  });
});

