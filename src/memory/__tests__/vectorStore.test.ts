/**
 * 向量存储测试
 * 覆盖 upsert / search / delete / 持久化 / 批量操作
 *
 * 加固测试：
 * - schema 校验（损坏文件 / 维度不一致 / 缺字段 / version 不匹配）
 * - 维度一致性校验（upsert / batchUpsert 抛错）
 * - save 并发串行化（多次 save 不互相覆盖）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore, type EmbeddingService } from '@/memory/vectorStore.js';

/**
 * 创建模拟的 EmbeddingService
 * 不调用真实 API，直接返回固定向量
 */
function mockEmbeddingService() {
  return {
    // 简单伪向量：基于文本首字符的 Unicode 码点
    embed: async (text: string) => {
      const base = text.charCodeAt(0) / 65536;
      return [base, 1 - base, 0.5];
    },
    batchEmbed: async (texts: string[]) => {
      return texts.map((text) => ({
        id: text,
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
    store = new VectorStore(join(tmpDir, 'vectors.json'), provider as unknown as EmbeddingService);
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
    store = new VectorStore(join(tmpDir, 'vectors.json'), provider as unknown as EmbeddingService);
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
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

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
    const store1 = new VectorStore(storePath, provider1 as unknown as EmbeddingService);
    await store1.upsert('mem:1', '文本A');
    await store1.save();

    // 新实例加载
    const provider2 = mockEmbeddingService();
    const store2 = new VectorStore(storePath, provider2 as unknown as EmbeddingService);
    await store2.load();

    expect(store2.size).toBe(1);
  });

  it('无变更时 save 不应写文件', async () => {
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.save();

    // 无 upsert，dirty=false，不应创建文件
    expect(existsSync(storePath)).toBe(false);
  });
});

// ─── 加固测试 ───────────────────────────────────────

/**
 * 创建可配置维度的 mock EmbeddingService
 * 用于维度一致性校验测试（不同维度触发不同分支）
 */
function mockEmbeddingServiceWithDimension(dim: number) {
  return {
    embed: async () => Array.from({ length: dim }, (_, i) => i / dim),
    batchEmbed: async (texts: string[]) =>
      texts.map((text) => ({
        text,
        vector: Array.from({ length: dim }, (_, i) => (i + text.charCodeAt(0)) / (dim * 2)),
      })),
  };
}

/**
 * 创建可切换维度的 stateful mock EmbeddingService
 *
 * 用于维度一致性测试：先返回 dim1，调用 switchDimension() 后返回 dim2，
 * 避免修改 VectorStore 的 readonly embeddingProvider 属性
 */
function createSwitchableEmbeddingService(initialDim: number) {
  let currentDim = initialDim;
  return {
    embed: async () => Array.from({ length: currentDim }, (_, i) => i / currentDim),
    batchEmbed: async (texts: string[]) =>
      texts.map((text) => ({
        text,
        vector: Array.from({ length: currentDim }, (_, i) => (i + text.charCodeAt(0)) / (currentDim * 2)),
      })),
    switchDimension(newDim: number) {
      currentDim = newDim;
    },
  };
}

describe('VectorStore · schema 校验', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-schema-'));
    storePath = join(tmpDir, 'vectors.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('损坏的 JSON 应视为"从空开始"，不抛错', async () => {
    writeFileSync(storePath, '{ not valid json', 'utf-8');
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await expect(store.load()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('version 不匹配应视为"从空开始"', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 99, dimension: 3, entries: [] }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(0);
  });

  it('dimension 非整数应视为"从空开始"', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, dimension: 3.5, entries: [] }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(0);
  });

  it('entries 非 Array 应视为"从空开始"', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, dimension: 3, entries: 'not-array' }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(0);
  });

  it('vector 长度与 dimension 不符应视为"从空开始"', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        dimension: 3,
        entries: [{ id: 'm1', vector: [1, 2] }], // 长度 2 ≠ dimension 3
      }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(0);
  });

  it('vector 含非数字元素应视为"从空开始"', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        dimension: 3,
        entries: [{ id: 'm1', vector: [1, 'not-number', 3] }],
      }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(0);
  });

  it('正常文件应成功加载', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        dimension: 3,
        entries: [{ id: 'm1', vector: [0.1, 0.2, 0.3] }],
      }),
      'utf-8',
    );
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.load();
    expect(store.size).toBe(1);
  });
});

describe('VectorStore · 维度一致性校验', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-dim-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('upsert 维度不一致应抛错', async () => {
    // 用可切换维度的 service：先用 dim=3 插入首条，再切到 dim=4 触发不一致
    const service = createSwitchableEmbeddingService(3);
    const store = new VectorStore(join(tmpDir, 'v.json'), service as unknown as EmbeddingService);
    await store.upsert('m1', 'first');

    // 切换到 dim=4，再次 upsert 应抛错
    service.switchDimension(4);

    await expect(store.upsert('m2', 'second')).rejects.toThrow(/向量维度不一致/);
  });

  it('batchUpsert 维度不一致应抛错', async () => {
    // 用可切换维度的 service：先用 dim=2 锁定 dimension，再切到 dim=3 触发不一致
    const service = createSwitchableEmbeddingService(2);
    const store = new VectorStore(join(tmpDir, 'v.json'), service as unknown as EmbeddingService);
    await store.upsert('m1', 'init');

    // 切换到 dim=3，batchUpsert 应抛错
    service.switchDimension(3);

    await expect(
      store.batchUpsert([
        { id: 'm2', text: 'a' },
        { id: 'm3', text: 'b' },
      ]),
    ).rejects.toThrow(/批量插入向量维度不一致/);
  });

  it('首条向量应锁定 dimension，不抛错', async () => {
    const provider = mockEmbeddingServiceWithDimension(5);
    const store = new VectorStore(join(tmpDir, 'v.json'), provider as unknown as EmbeddingService);

    await expect(store.upsert('m1', 'first')).resolves.toBeUndefined();
    expect(store.size).toBe(1);
  });
});

describe('VectorStore · save 串行化', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-vector-concurrent-'));
    storePath = join(tmpDir, 'vectors.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('并发 save 应串行执行，最终文件包含所有变更', async () => {
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    // 第一次 upsert 后并发触发 3 次 save
    await store.upsert('m1', '文本A');
    // 故意 dirty=true 时连续 save，验证串行化
    // 由于 dirty 在第一次 doSave 后清零，第二、三次 doSave 会跳过
    // 但 Promise 链不会丢失，仍按顺序 resolve
    await Promise.all([store.save(), store.save(), store.save()]);

    // 文件存在且包含 m1
    expect(existsSync(storePath)).toBe(true);
    const data = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].id).toBe('m1');
  });

  it('delete 后需显式 save 才持久化', async () => {
    const provider = mockEmbeddingService();
    const store = new VectorStore(storePath, provider as unknown as EmbeddingService);

    await store.upsert('m1', '文本A');
    await store.save();

    // delete 仅标记 dirty，不自动 save
    store.delete('m1');
    expect(store.size).toBe(0);

    // 此时文件仍包含 m1（未 save）
    const dataBeforeSave = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(dataBeforeSave.entries).toHaveLength(1);

    // 显式 save 后文件更新
    await store.save();
    const dataAfterSave = JSON.parse(readFileSync(storePath, 'utf-8'));
    expect(dataAfterSave.entries).toHaveLength(0);
  });
});
