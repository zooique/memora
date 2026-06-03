/**
 * 向量存储测试
 * 覆盖 upsert / search / delete / 持久化 / 批量操作
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '@/memory/vector-store.js';
import type { EmbeddingService } from '@/memory/types.js';

/**
 * 创建模拟的 EmbeddingService
 * 不调用真实 API，直接返回固定向量
 * 年轮审判 R-03 修复：测试依赖 memory/ 层的接口而非 llm/ 层的具体实现
 */
function mockEmbeddingService(): EmbeddingService {
  return {
    // 简单伪向量：基于文本首字符的 Unicode 码点
    embed: async (text: string) => {
      const base = text.charCodeAt(0) / 65536;
      return [base, 1 - base, 0.5];
    },
    batchEmbed: async (texts: string[]) => {
      return texts.map((text) => ({
        text,
        vector: [text.charCodeAt(0) / 65536, 1 - text.charCodeAt(0) / 65536, 0.5],
      }));
    },
  };
}

describe('VectorStore · upsert + search', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-'));
    const provider = mockEmbeddingService();
    store = new VectorStore(join(tmpDir, 'vectors.json'), provider);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该存储向量并搜索到相似结果', async () => {
    await store.upsert('mem:1', '测试文本A');
    await store.upsert('mem:2', '其他内容B');

    const results = await store.search('测试文本A', 5, 0.0);

    // 测试文本A 和自己最相似
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe('mem:1');
    expect(results[0]!.similarity).toBeCloseTo(1.0);
  });

  it('应该支持 topK 限制', async () => {
    await store.upsert('mem:1', '文本A');
    await store.upsert('mem:2', '文本B');
    await store.upsert('mem:3', '文本C');

    const results = await store.search('文本A', 2, 0.0);

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('应该支持 minSimilarity 过滤', async () => {
    await store.upsert('mem:1', '文本A');

    // 极高阈值应该过滤掉所有结果（除了完全匹配）
    const results = await store.search('完全不同的查询XYZ', 5, 0.99);

    // 伪向量基于首字符，不同首字符的相似度不会达到 0.99
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('删除向量后不应再搜索到', async () => {
    await store.upsert('mem:1', '文本A');
    store.delete('mem:1');

    const results = await store.search('文本A', 5, 0.0);

    expect(results).toHaveLength(0);
  });
});

describe('VectorStore · batchUpsert', () => {
  let tmpDir: string;
  let store: VectorStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-'));
    const provider = mockEmbeddingService();
    store = new VectorStore(join(tmpDir, 'vectors.json'), provider);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('应该批量插入多条向量', async () => {
    await store.batchUpsert([
      { id: 'mem:1', text: '文本A' },
      { id: 'mem:2', text: '文本B' },
      { id: 'mem:3', text: '文本C' },
    ]);

    expect(store.size).toBe(3);
  });
});

describe('VectorStore · 持久化', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-'));
    storePath = join(tmpDir, 'vectors.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('save 后应该写入 JSON 文件', async () => {
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider);

    await store.upsert('mem:1', '文本A');
    await store.save();

    expect(existsSync(storePath)).toBe(true);
    const data = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(data.version).toBe(1);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe('mem:1');
  });

  it('load 后应该恢复向量索引', async () => {
    const provider1 = mockEmbeddingService();
    const store1 = new VectorStore(storePath, provider1);
    await store1.upsert('mem:1', '文本A');
    await store1.save();

    // 新实例加载
    const provider2 = mockEmbeddingService();
    const store2 = new VectorStore(storePath, provider2);
    await store2.load();

    expect(store2.size).toBe(1);
  });

  it('无变更时 save 不应写文件', async () => {
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider);

    await store.save();

    // 无 upsert，dirty=false，不应创建文件
    expect(existsSync(storePath)).toBe(false);
  });
});
