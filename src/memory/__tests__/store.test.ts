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
import { FileStore } from '@/memory/store.js';
import { SOURCE_LABELS } from '@/memory/types.js';

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
      const result = await store.read(SOURCE_LABELS.RULE, 'nonexistent');
      expect(result).toBeNull();
    });

    it('文件无 frontmatter 时应使用默认值', async () => {
      // 写入不含 frontmatter 的文件
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'no-frontmatter.md'), '这是纯文本内容，没有 frontmatter', 'utf-8');

      const result = await store.read(SOURCE_LABELS.RULE, 'no-frontmatter');
      expect(result).not.toBeNull();
      // 无 frontmatter 时使用默认值
      expect(result!.source).toBe('rule');
      expect(result!.score).toBe(0.5); // 默认权重
      expect(result!.content).toBe('这是纯文本内容，没有 frontmatter');
    });

    it('frontmatter 缺少可选字段时应使用 ?? 默认值', async () => {
      // 写入只有部分字段的 frontmatter
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'partial.md'),
        `---
source: rule
name: partial
---

# 部分字段
内容`,
        'utf-8',
      );

      const result = await store.read(SOURCE_LABELS.RULE, 'partial');
      expect(result).not.toBeNull();
      // 缺少 score → 默认 0.5
      expect(result!.score).toBe(0.5);
      // 缺少 createdAt → 使用文件 mtime
      expect(result!.createdAt).toBeDefined();
      // 缺少 accessedAt → 使用文件 mtime
      expect(result!.accessedAt).toBeDefined();
    });

    it('有完整 frontmatter 时应正确解析', async () => {
      const dir = join(dataDir, 'personas');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'default.md'),
        `---
id: persona:default
source: persona
name: default
score: 1.0
createdAt: 2026-06-01T00:00:00.000Z
accessedAt: 2026-06-02T00:00:00.000Z
---

# 默认人格
诚实、简洁。
`,
        'utf-8',
      );

      const result = await store.read(SOURCE_LABELS.PERSONA, 'default');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('persona');
      expect(result!.score).toBe(1.0);
      expect(result!.content).toBe('# 默认人格\n诚实、简洁。');
    });
  });

  describe('write', () => {
    it('write + read 往返应保持数据一致', async () => {
      const memory = {
        id: 'rule:test-rule',
        content: '# 测试规则\n- 规则内容',
        source: 'rule',
        name: 'test-rule',
        createdAt: '2026-06-01T00:00:00.000Z',
        accessedAt: '2026-06-02T00:00:00.000Z',
        score: 0.8,
      };

      await store.write(memory);

      const readBack = await store.read(SOURCE_LABELS.RULE, 'test-rule');
      expect(readBack).not.toBeNull();
      expect(readBack!.id).toBe('rule:test-rule');
      expect(readBack!.source).toBe('rule');
      expect(readBack!.content).toBe('# 测试规则\n- 规则内容');
      expect(readBack!.score).toBe(0.8);
    });

    it('写入嵌套子目录应自动创建父目录', async () => {
      // 自定义 source 目录不存在，write 应自动创建
      const memory = {
        id: 'custom:deep-tool',
        content: '深路径工具',
        source: 'custom',
        name: 'deep-tool',
        createdAt: '2026-06-02T00:00:00.000Z',
        accessedAt: '2026-06-02T00:00:00.000Z',
        score: 0.5,
      };

      await store.write(memory);

      const readBack = await store.read('custom', 'deep-tool');
      expect(readBack).not.toBeNull();
      expect(readBack!.content).toBe('深路径工具');
    });
  });

  describe('list', () => {
    it('目录不存在时应返回空数组', async () => {
      // 不创建任何目录
      const result = await store.list(SOURCE_LABELS.SKILL);
      expect(result).toEqual([]);
    });

    it('应过滤非 .md 文件', async () => {
      const dir = join(dataDir, 'rules');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'good.md'), '---\nsource: rule\n---\n\ncontent', 'utf-8');
      writeFileSync(join(dir, 'readme.txt'), 'not a markdown', 'utf-8');
      writeFileSync(join(dir, '.gitkeep'), '', 'utf-8');

      const result = await store.list(SOURCE_LABELS.RULE);
      // 只返回 .md 文件（去掉扩展名）
      expect(result).toEqual(['good']);
    });
  });
});
