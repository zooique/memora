/**
 * ToolResultCache 单元测试
 * 覆盖闭环内工具防重缓存的全部公开 API + DEDUP_SUBJECT_EXTRACTORS 内置生成器
 *
 * 测试矩阵：
 *   ToolResultCache 类：set / check / clear / invalidateFile / size
 *   边界：同 tool 不同主体 / 同主体不同 tool / clear 后清空 / invalidate 精确匹配
 *   DEDUP_SUBJECT_EXTRACTORS：3 个内置生成器 + 空值 + 非法 JSON
 *   ★ 主体语义（1c）：路径规范化等价、读取区间区分、缺省 offset ≡ 显式 1
 *   ★ 失效完备（1c）：同一文件的**所有读取区间**一并失效
 */
import { describe, it, expect } from 'vitest';
import {
  ToolResultCache,
  DEDUP_SUBJECT_EXTRACTORS,
  normalizePathKey,
  formatDedupSubject,
} from '@/agent/toolResultCache.js';

describe('ToolResultCache', () => {
  describe('set + check 基础行为', () => {
    it('存一条 → check 命中并返回首次缓存条目', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/foo/bar.md', offset: 1 }, 3, { fileMtime: 1700000000000 });

      const hit = cache.check('read_file', { path: '/foo/bar.md', offset: 1 });
      expect(hit).toBeDefined();
      expect(hit?.cachedAtIteration).toBe(3);
      expect(hit?.fileMtime).toBe(1700000000000);
    });

    it('未存 → check 返回 undefined', () => {
      const cache = new ToolResultCache();
      expect(cache.check('read_file', { path: '/foo/bar.md', offset: 1 })).toBeUndefined();
    });

    it('同 toolName 不同主体 → 互不干扰', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/a.md', offset: 1 }, 1);
      cache.set('read_file', { path: '/b.md', offset: 1 }, 2);

      expect(cache.check('read_file', { path: '/a.md', offset: 1 })?.cachedAtIteration).toBe(1);
      expect(cache.check('read_file', { path: '/b.md', offset: 1 })?.cachedAtIteration).toBe(2);
      expect(cache.size).toBe(2);
    });

    it('不同 toolName 同主体 → 互不干扰', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/shared/path', offset: 1 }, 1);
      cache.set('list_dir', { path: '/shared/path' }, 2);

      expect(cache.check('read_file', { path: '/shared/path', offset: 1 })?.cachedAtIteration).toBe(1);
      expect(cache.check('list_dir', { path: '/shared/path' })?.cachedAtIteration).toBe(2);
      expect(cache.size).toBe(2);
    });

    it('读取区间进入主体：同文件不同区间互不干扰（1a 分段续读不被误判为重复）', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: 'docs/big.md', offset: 1 }, 1);

      // 分段续读：同文件、不同起始行 → 不是同一请求
      expect(cache.check('read_file', { path: 'docs/big.md', offset: 121 })).toBeUndefined();
      // 首段但限行数 → 同样是不同请求（读到的是另一个区间）
      expect(cache.check('read_file', { path: 'docs/big.md', offset: 1, limit: 200 })).toBeUndefined();
      // 原请求仍然命中
      expect(cache.check('read_file', { path: 'docs/big.md', offset: 1 })).toBeDefined();
    });
  });

  describe('invalidateFile 精确失效', () => {
    it('write_file 后 invalidateFile → 同 path 的 read_file 缓存被删', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/project/main.ts', offset: 1 }, 5, {
        fileMtime: 1700000000000,
      });

      // 模拟 write_file 成功 → 内核主动失效
      cache.invalidateFile('/project/main.ts');

      expect(cache.check('read_file', { path: '/project/main.ts', offset: 1 })).toBeUndefined();
    });

    it('invalidateFile 不影响其他文件的 read_file 缓存', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/project/main.ts', offset: 1 }, 1);
      cache.set('read_file', { path: '/project/utils.ts', offset: 1 }, 2);

      cache.invalidateFile('/project/main.ts');

      expect(cache.check('read_file', { path: '/project/main.ts', offset: 1 })).toBeUndefined();
      expect(cache.check('read_file', { path: '/project/utils.ts', offset: 1 })).toBeDefined();
      expect(cache.size).toBe(1);
    });

    it('同一文件的**所有读取区间**一并失效（文件变了，任何区间的旧结果都作废）', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/p/big.md', offset: 1 }, 1);
      cache.set('read_file', { path: '/p/big.md', offset: 121 }, 2);
      cache.set('read_file', { path: '/p/other.md', offset: 1 }, 3);

      cache.invalidateFile('/p/big.md');

      expect(cache.check('read_file', { path: '/p/big.md', offset: 1 })).toBeUndefined();
      expect(cache.check('read_file', { path: '/p/big.md', offset: 121 })).toBeUndefined();
      // 别的文件不受影响
      expect(cache.check('read_file', { path: '/p/other.md', offset: 1 })).toBeDefined();
    });

    it('路径写法不同但等价（`./a.md` 传入、`a.md` 缓存）→ 同样失效', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: normalizePathKey('docs/a.md'), offset: 1 }, 1);

      cache.invalidateFile('./docs/a.md');

      expect(cache.check('read_file', { path: normalizePathKey('docs/a.md'), offset: 1 })).toBeUndefined();
    });

    it('invalidateFile 不影响 list_dir 缓存（文件修改不改目录结构）', () => {
      const cache = new ToolResultCache();
      cache.set('list_dir', { path: '/project/src' }, 1);
      cache.set('read_file', { path: '/project/src/main.ts', offset: 1 }, 2);

      cache.invalidateFile('/project/src/main.ts');

      expect(cache.check('list_dir', { path: '/project/src' })).toBeDefined();
      expect(cache.check('read_file', { path: '/project/src/main.ts', offset: 1 })).toBeUndefined();
    });

    it('invalidateFile 对不存在的 path 静默无操作', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/exists.md', offset: 1 }, 1);

      cache.invalidateFile('/does/not/exist.md');

      expect(cache.check('read_file', { path: '/exists.md', offset: 1 })).toBeDefined();
      expect(cache.size).toBe(1);
    });
  });

  describe('clear 闭环结束清空', () => {
    it('clear 后 size=0 且全部 check miss', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/a.md', offset: 1 }, 1);
      cache.set('list_dir', { path: '/b' }, 2);
      cache.set('web_search', { query: 'query' }, 3);
      expect(cache.size).toBe(3);

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.check('read_file', { path: '/a.md', offset: 1 })).toBeUndefined();
      expect(cache.check('list_dir', { path: '/b' })).toBeUndefined();
      expect(cache.check('web_search', { query: 'query' })).toBeUndefined();
    });
  });

  describe('set 可选元信息', () => {
    it('read_file 带 mtime → check 可取到', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/p', offset: 1 }, 1, { fileMtime: 1234567890 });
      expect(cache.check('read_file', { path: '/p', offset: 1 })?.fileMtime).toBe(1234567890);
    });

    it('web_search 不传 mtime → check 返回 undefined', () => {
      const cache = new ToolResultCache();
      cache.set('web_search', { query: 'q' }, 1);
      expect(cache.check('web_search', { query: 'q' })?.fileMtime).toBeUndefined();
    });

    it('toolCallId 与内容指纹随条目留存（拦截前判定「结果是否仍在上下文」的依据）', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/p', offset: 1 }, 1, {
        toolCallId: 'call_abc',
        fingerprint: 'deadbeef',
      });

      const hit = cache.check('read_file', { path: '/p', offset: 1 });
      expect(hit?.toolCallId).toBe('call_abc');
      expect(hit?.fingerprint).toBe('deadbeef');
    });

    it('未传元信息 → toolCallId / fingerprint 均为 undefined（判定层据此保守放行）', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/p', offset: 1 }, 1);

      const hit = cache.check('read_file', { path: '/p', offset: 1 });
      expect(hit?.toolCallId).toBeUndefined();
      expect(hit?.fingerprint).toBeUndefined();
    });
  });

  describe('size 属性实时反映', () => {
    it('每次 set 后 size++，invalidateFile 后 size--', () => {
      const cache = new ToolResultCache();
      expect(cache.size).toBe(0);

      cache.set('read_file', { path: '/a', offset: 1 }, 1);
      expect(cache.size).toBe(1);

      cache.set('read_file', { path: '/b', offset: 1 }, 2);
      expect(cache.size).toBe(2);

      cache.invalidateFile('/a');
      expect(cache.size).toBe(1);
    });

    it('同主体 set 覆盖 → size 不变', () => {
      const cache = new ToolResultCache();
      cache.set('read_file', { path: '/a', offset: 1 }, 1);
      cache.set('read_file', { path: '/a', offset: 1 }, 5); // 覆盖
      expect(cache.size).toBe(1);
      expect(cache.check('read_file', { path: '/a', offset: 1 })?.cachedAtIteration).toBe(5);
    });
  });
});

describe('DEDUP_SUBJECT_EXTRACTORS.read_file', () => {
  const extract = (args: string) => DEDUP_SUBJECT_EXTRACTORS.read_file!(args);

  it('正确提取路径，缺省区间归一为 offset=1 / limit 无', () => {
    expect(extract('{"path":"/foo/bar.md"}')).toEqual({
      path: '/foo/bar.md',
      offset: 1,
      limit: undefined,
    });
  });

  it('显式 offset/limit 进入主体（字符串数字被解析为数字）', () => {
    expect(extract('{"path":"/a.md","offset":"121","limit":"200"}')).toEqual({
      path: '/a.md',
      offset: 121,
      limit: 200,
    });
  });

  it('缺省 offset 与显式 offset=1 归一同主体（handler 读的确实是同一区间）', () => {
    const bare = extract('{"path":"docs/a.md"}');
    expect(bare).toEqual(extract('{"path":"docs/a.md","offset":"1"}'));
    expect(bare).toEqual(extract('{"path":"docs/a.md","offset":1}'));
    expect(bare).toEqual(extract('{"path":"docs/a.md","offset":"01"}'));

    // 缓存层同判：四者互认（否则真正的重复调用会被放过）
    const cache = new ToolResultCache();
    cache.set('read_file', bare!, 7);
    expect(cache.check('read_file', extract('{"path":"docs/a.md","offset":"1"}')!)?.cachedAtIteration).toBe(7);
    expect(cache.check('read_file', extract('{"path":"docs/a.md","offset":1}')!)?.cachedAtIteration).toBe(7);
    expect(cache.check('read_file', extract('{"path":"docs/a.md","offset":"01"}')!)?.cachedAtIteration).toBe(7);
  });

  it('非法 / 越界区间退回缺省（与 math.positiveInt 单一真源同规则：NaN / <1 → 缺省）', () => {
    const bare = extract('{"path":"docs/a.md"}');
    expect(extract('{"path":"docs/a.md","offset":"0"}')).toEqual(bare);
    expect(extract('{"path":"docs/a.md","offset":"-3"}')).toEqual(bare);
    expect(extract('{"path":"docs/a.md","offset":"abc"}')).toEqual(bare);
    expect(extract('{"path":"docs/a.md","limit":"0"}')).toEqual(bare);
    expect(extract('{"path":"docs/a.md","limit":"x"}')).toEqual(bare);
  });

  it('路径规范化：`./`、重复分隔符、`..`、反斜杠、尾斜杠归并到同一路径', () => {
    const expected = extract('{"path":"docs/a.md"}');
    expect(extract('{"path":"./docs/a.md"}')).toEqual(expected);
    expect(extract('{"path":"docs//a.md"}')).toEqual(expected);
    expect(extract('{"path":"docs/sub/../a.md"}')).toEqual(expected);
    expect(extract('{"path":"docs\\\\a.md"}')).toEqual(expected);
    expect(extract('{"path":"docs/a.md/"}')).toEqual(expected);
    expect(extract('{"path":"  docs/a.md  "}')).toEqual(expected);
  });

  it('path 缺失 / 空串 → undefined', () => {
    expect(extract('{"content":"hello"}')).toBeUndefined();
    expect(extract('{"path":""}')).toBeUndefined();
    expect(extract('{"path":"   "}')).toBeUndefined();
  });

  it('非法 JSON / 空 JSON / 非对象 JSON → undefined', () => {
    expect(extract('not-json')).toBeUndefined();
    expect(extract('{}')).toBeUndefined();
    expect(extract('[]')).toBeUndefined();
    expect(extract('"just-a-string"')).toBeUndefined();
    expect(extract('null')).toBeUndefined();
  });
});

describe('DEDUP_SUBJECT_EXTRACTORS.list_dir', () => {
  it('正确提取并规范化路径', () => {
    expect(DEDUP_SUBJECT_EXTRACTORS.list_dir!('{"path":"/some/dir"}')).toEqual({
      path: '/some/dir',
    });
    expect(DEDUP_SUBJECT_EXTRACTORS.list_dir!('{"path":"./some/dir/"}')).toEqual({
      path: 'some/dir',
    });
  });

  it('path 缺失 / 非法 JSON → undefined', () => {
    expect(DEDUP_SUBJECT_EXTRACTORS.list_dir!('{}')).toBeUndefined();
    expect(DEDUP_SUBJECT_EXTRACTORS.list_dir!('broken')).toBeUndefined();
  });
});

describe('DEDUP_SUBJECT_EXTRACTORS.web_search', () => {
  it('正确提取 query', () => {
    expect(DEDUP_SUBJECT_EXTRACTORS.web_search!('{"query":"memora agent"}')).toEqual({
      query: 'memora agent',
    });
  });

  it('query 缺失 / 空串 / 非法 JSON → undefined', () => {
    expect(DEDUP_SUBJECT_EXTRACTORS.web_search!('{"maxResults":5}')).toBeUndefined();
    expect(DEDUP_SUBJECT_EXTRACTORS.web_search!('{"query":""}')).toBeUndefined();
    expect(DEDUP_SUBJECT_EXTRACTORS.web_search!('{bad json')).toBeUndefined();
  });
});

describe('normalizePathKey', () => {
  it('归并等价写法，且保持绝对 / 相对语义不混同', () => {
    expect(normalizePathKey('./docs/a.md')).toBe('docs/a.md');
    expect(normalizePathKey('docs//a.md')).toBe('docs/a.md');
    expect(normalizePathKey('docs/sub/../a.md')).toBe('docs/a.md');
    expect(normalizePathKey('docs\\a.md')).toBe('docs/a.md');
    expect(normalizePathKey('docs/a.md/')).toBe('docs/a.md');
    // 绝对 vs 相对：**不合并** —— 无法确定是同一文件时不该判为重复（判错方向是死锁）
    expect(normalizePathKey('/docs/a.md')).toBe('/docs/a.md');
    expect(normalizePathKey('/docs/a.md')).not.toBe(normalizePathKey('docs/a.md'));
  });
});

describe('formatDedupSubject', () => {
  it('read_file 渲染为「路径 + 区间」，不暴露内部 key 格式', () => {
    expect(formatDedupSubject('read_file', { path: 'docs/a.md', offset: 1, limit: 200 })).toBe(
      'docs/a.md · 第 1 行起的 200 行',
    );
    expect(formatDedupSubject('read_file', { path: 'docs/a.md', offset: 121 })).toBe(
      'docs/a.md · 第 121 行起',
    );
    // 不含内部 key 的分隔符
    expect(formatDedupSubject('read_file', { path: 'docs/a.md', offset: 1 })).not.toContain('\u0001');
  });

  it('list_dir 只渲染路径；web_search 只渲染 query', () => {
    expect(formatDedupSubject('list_dir', { path: 'docs' })).toBe('docs');
    expect(formatDedupSubject('web_search', { query: 'memora' })).toBe('memora');
  });
});
