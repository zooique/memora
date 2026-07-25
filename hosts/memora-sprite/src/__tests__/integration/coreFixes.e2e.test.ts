/**
 * 内核修复 · 真实实例端到端（M5 / M7 / M8 / M9）
 *
 * 这些场景不依赖完整 Agent，直接消费内核从 `memora` 导出的真实类/函数，
 * 针对真实临时文件系统进行断言：M5 validateSource、M7 parseFrontmatter、
 * M8/M9 JsonVectorStore 原子写 + 串行化 + 损坏备份。全部为"真实 memora 实例"。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSource, parseFrontmatter, JsonVectorStore, type EmbeddingService } from 'memora';

// ── M5：validateSource 拒绝路径分隔符 ──────────────────────────────
describe('M5 validateSource（真实内核函数）', () => {
  it('拒绝 / 与 \\ 路径分隔符', () => {
    expect(validateSource('rules/evil').valid).toBe(false);
    expect(validateSource('a\\b').valid).toBe(false);
  });
  it('接受扁平标签', () => {
    const r = validateSource('profile');
    expect(r.valid).toBe(true);
  });
});

// ── M7：parseFrontmatter 无尾随换行不丢 body + 内部换行保留 ──────────
describe('M7 parseFrontmatter（真实内核函数）', () => {
  it('以 --- 结尾无尾随换行时 body 不丢', () => {
    const raw = '---\nid: x\nsource: rule\n---\n规则内容';
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.id).toBe('x');
    expect(body).toBe('规则内容');
  });
  it('保留 body 内部换行，仅容忍结构尾随换行', () => {
    const raw = '---\nid: x\n---\n第一行\n第二行\n'; // body 末尾含一个结构尾随换行
    const { body } = parseFrontmatter(raw);
    expect(body).toBe('第一行\n第二行'); // 内部换行保留；末尾结构换行被剥离
  });
});

// ── M8/M9：JsonVectorStore 串行化 + 原子写 + 损坏备份 ───────────────
function stubEmbedding(): EmbeddingService {
  const hash = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return n;
  };
  const vec = (t: string): number[] => Array.from({ length: 8 }, (_, i) => ((hash(t) + i) % 97) / 97);
  return {
    async embed(text: string): Promise<number[]> {
      return vec(text);
    },
    async batchEmbed(texts: string[]): Promise<Array<{ text: string; vector: number[] }>> {
      return texts.map((t) => ({ text: t, vector: vec(t) }));
    },
  };
}

describe('M8/M9 JsonVectorStore（真实内核类 · 临时文件）', () => {
  let dir: string;
  let store: JsonVectorStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vs-e2e-'));
    store = new JsonVectorStore(join(dir, 'vectors.json'), stubEmbedding());
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('M8 并发 upsert + save 严格串行化，不丢数据', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.upsert(`m${i}`, `文本${i}`).then(() => store.save())),
    );
    expect(store.size).toBe(20);

    const reloaded = new JsonVectorStore(join(dir, 'vectors.json'), stubEmbedding());
    await reloaded.load();
    expect(reloaded.size).toBe(20);
  });

  it('M9 损坏文件 load 时备份为 .corrupt.<ts> 并从空开始（不抛、不静默覆盖）', async () => {
    await store.upsert('m1', '文本A');
    await store.save();

    // 模拟半写/手动损坏
    writeFileSync(join(dir, 'vectors.json'), '{ broken json ', 'utf-8');

    const reloaded = new JsonVectorStore(join(dir, 'vectors.json'), stubEmbedding());
    await reloaded.load(); // 应备份并清空，不得抛错
    expect(reloaded.size).toBe(0);

    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('vectors.json.corrupt.'))).toBe(true);
  });

  it('M9 原子写：save 完成后无残留 .tmp，storePath 有效', async () => {
    await store.upsert('m1', '文本A');
    await store.save();
    expect(existsSync(join(dir, 'vectors.json'))).toBe(true);
    expect(existsSync(join(dir, 'vectors.json.tmp'))).toBe(false);
  });
});

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
