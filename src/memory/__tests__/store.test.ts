/**
 * FileStore 单元测试
 *
 * 覆盖 read / write / list 的边界分支：
 *   - read 文件不存在 → null
 *   - read 文件无 frontmatter → 默认值（nullish coalescing 分支）
 *   - write + read 往返
 *   - list 目录不存在 → []
 *   - list 过滤非 .md 文件
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../store.js';
import { MemoryType } from '../types.js';

describe('FileStore · 文件级记忆存储', () => {
  let dataDir: string;
  let store: FileStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memora-store-'));
    store = new FileStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('read', () => {
    it('文件不存在时应返回 null', async () => {
      const result = await store.read(MemoryType.RULE, 'nonexistent');
      expect(result).toBeNull();
    });

    it('文件无 frontmatter 时应使用默认值', async () => {
      // 写入不含 frontmatter 的文件
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'no-frontmatter.md'), '这是纯文本内容，没有 frontmatter', 'utf-8');

      const result = await store.read(MemoryType.RULE, 'no-frontmatter');
      expect(result).not.toBeNull();
      // 无 frontmatter 时使用默认值
      expect(result!.permanence).toBe('topic'); // 默认 permanence
      expect(result!.tags).toEqual([]); // 默认空标签
      expect(result!.weight).toBe(0.5); // 默认权重
      expect(result!.content).toBe('这是纯文本内容，没有 frontmatter');
    });

    it('frontmatter 缺少可选字段时应使用 ?? 默认值', async () => {
      // 写入只有部分字段的 frontmatter
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'partial.md'),
        `---
type: rule
name: partial
---

# 部分字段
内容`,
        'utf-8',
      );

      const result = await store.read(MemoryType.RULE, 'partial');
      expect(result).not.toBeNull();
      // 缺少 permanence → 默认 'topic'
      expect(result!.permanence).toBe('topic');
      // 缺少 tags → 默认 []
      expect(result!.tags).toEqual([]);
      // 缺少 weight → 默认 0.5
      expect(result!.weight).toBe(0.5);
      // 缺少 createdAt → 使用文件 mtime
      expect(result!.createdAt).toBeDefined();
      // 缺少 updatedAt → 使用文件 mtime
      expect(result!.updatedAt).toBeDefined();
    });

    it('有完整 frontmatter 时应正确解析', async () => {
      const dir = join(dataDir, 'personality');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'default.md'),
        `---
type: personality
permanence: always
name: default
tags: core, persona
weight: 1.0
createdAt: 2026-06-01T00:00:00.000Z
updatedAt: 2026-06-02T00:00:00.000Z
---

# 默认人格
诚实、简洁。
`,
        'utf-8',
      );

      const result = await store.read(MemoryType.PERSONALITY, 'default');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('personality');
      expect(result!.permanence).toBe('always');
      expect(result!.tags).toEqual(['core', 'persona']);
      expect(result!.weight).toBe(1.0);
      expect(result!.content).toBe('# 默认人格\n诚实、简洁。');
    });
  });

  describe('write', () => {
    it('write + read 往返应保持数据一致', async () => {
      const memory = {
        id: 'rule:test-rule',
        type: MemoryType.RULE,
        permanence: 'always' as const,
        name: 'test-rule',
        content: '# 测试规则\n- 规则内容',
        tags: ['test', 'rule'],
        weight: 0.8,
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
        filePath: '',
      };

      await store.write(memory);

      const readBack = await store.read(MemoryType.RULE, 'test-rule');
      expect(readBack).not.toBeNull();
      expect(readBack!.id).toBe('rule:test-rule');
      expect(readBack!.type).toBe('rule');
      expect(readBack!.permanence).toBe('always');
      expect(readBack!.content).toBe('# 测试规则\n- 规则内容');
      expect(readBack!.tags).toEqual(['test', 'rule']);
      expect(readBack!.weight).toBe(0.8);
    });

    it('写入嵌套子目录应自动创建父目录', async () => {
      // tools 目录不存在，write 应自动创建
      const memory = {
        id: 'tool:deep-tool',
        type: MemoryType.TOOL,
        permanence: 'domain' as const,
        name: 'deep-tool',
        content: '深路径工具',
        tags: [],
        weight: 0.5,
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z',
        filePath: '',
      };

      await store.write(memory);

      const readBack = await store.read(MemoryType.TOOL, 'deep-tool');
      expect(readBack).not.toBeNull();
      expect(readBack!.content).toBe('深路径工具');
    });
  });

  describe('list', () => {
    it('目录不存在时应返回空数组', async () => {
      // 不创建任何目录
      const result = await store.list(MemoryType.SKILL);
      expect(result).toEqual([]);
    });

    it('应过滤非 .md 文件', async () => {
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'good.md'), '---\ntype: rule\n---\n\ncontent', 'utf-8');
      writeFileSync(join(dir, 'readme.txt'), 'not a markdown', 'utf-8');
      writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');

      const result = await store.list(MemoryType.RULE);
      // 只返回 .md 文件（去掉扩展名）
      expect(result).toEqual(['good']);
    });
  });
});
