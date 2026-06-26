/**
 * JsonlAppender 单元测试（QC-TEST-AUDIT）
 *
 * 覆盖范围：
 * - append：追加写入 + fire-and-forget 异步 + writeCount 累计
 * - readRecent：从后往前读取 + 最新在前 + limit 截断
 * - clear：清空文件
 * - truncateIfNeeded：超出 maxEntries 时截断保留最近条目
 * - truncateCheckInterval：计数器间隔检查（非每次写入都截断）
 * - 错误降级：文件不存在返回空数组 + 单行 JSON 解析失败跳过
 * - 构造函数：自动创建目录
 *
 * 测试策略：
 * - 使用 tmpdir 真实 I/O（对齐 storage 测试模式，零 mock）
 * - append 是 fire-and-forget，用 await flushWrites() 等待 I/O 完成
 * - readRecent 是 async，可直接 await
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlAppender } from '../../sprite/audit/jsonlAppender.js';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 创建测试用临时目录 */
function createTmpDir(): string {
  const dir = join(tmpdir(), `memora-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 预写入 N 条 JSONL 记录到文件（同步，保证顺序）
 *
 * 用于 readRecent 顺序敏感测试，绕过 append 的 fire-and-forget 异步问题。
 * 每次 append 后 flushWrites 会累积大量延迟，预写入避免此问题。
 */
function prewriteRecords(filePath: string, count: number): void {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify({ idx: i }));
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

/**
 * 等待 fire-and-forget 写入完成
 *
 * append 内部是 appendFile().then().catch()，不返回 Promise。
 * 用 setTimeout(50) 等待 I/O 队列刷新，确保后续 readRecent 能读到全部数据。
 */
function flushWrites(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('JsonlAppender', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
    filePath = join(tmpDir, 'audit.log');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── append + readRecent 基础流程 ──────────────────────

  it('append 应追加 JSONL 行到文件', async () => {
    const appender = new JsonlAppender({ filePath });
    appender.append({ name: 'event1', type: 'read' });
    await flushWrites(); // fire-and-forget 异步，需等待第一条落盘保证顺序
    appender.append({ name: 'event2', type: 'write' });
    await flushWrites();

    // 直接读文件验证 JSONL 格式（每行一条 JSON）
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ name: 'event1', type: 'read' });
    expect(JSON.parse(lines[1]!)).toEqual({ name: 'event2', type: 'write' });
  });

  it('readRecent 应返回最新在前的数组', async () => {
    prewriteRecords(filePath, 3);
    const appender = new JsonlAppender({ filePath });

    const records = await appender.readRecent<{ idx: number }>();
    // 最新在前（reverse 后）
    expect(records).toHaveLength(3);
    expect(records[0]!.idx).toBe(3);
    expect(records[1]!.idx).toBe(2);
    expect(records[2]!.idx).toBe(1);
  });

  it('readRecent 应支持 limit 截断', async () => {
    prewriteRecords(filePath, 10);
    const appender = new JsonlAppender({ filePath });

    const records = await appender.readRecent<{ idx: number }>(3);
    expect(records).toHaveLength(3);
    // 最新 3 条，倒序
    expect(records[0]!.idx).toBe(10);
    expect(records[1]!.idx).toBe(9);
    expect(records[2]!.idx).toBe(8);
  });

  it('readRecent 默认 limit 为 50', async () => {
    prewriteRecords(filePath, 60);
    const appender = new JsonlAppender({ filePath });

    const records = await appender.readRecent<{ idx: number }>();
    expect(records).toHaveLength(50);
    expect(records[0]!.idx).toBe(60);
  });

  // ─── 错误降级 ──────────────────────────────────────────

  it('readRecent 文件不存在时应返回空数组', async () => {
    const appender = new JsonlAppender({ filePath: join(tmpDir, 'nonexistent.log') });
    const records = await appender.readRecent();
    expect(records).toEqual([]);
  });

  it('readRecent 单行 JSON 解析失败时应跳过该行', async () => {
    // 手动写入混合内容：2 行合法 JSON + 1 行损坏
    const { writeFileSync } = await import('node:fs');
    const brokenContent = [
      JSON.stringify({ valid: 1 }),
      'this is not json {{{',
      JSON.stringify({ valid: 2 }),
    ].join('\n');
    writeFileSync(filePath, brokenContent, 'utf8');

    const appender = new JsonlAppender({ filePath });
    const records = await appender.readRecent<{ valid?: number }>();
    // 损坏行被跳过，只返回 2 条合法记录
    expect(records).toHaveLength(2);
    expect(records[0]!.valid).toBe(2);
    expect(records[1]!.valid).toBe(1);
  });

  // ─── clear ─────────────────────────────────────────────

  it('clear 应清空文件内容', async () => {
    const appender = new JsonlAppender({ filePath });
    appender.append({ data: 'test' });
    await flushWrites();
    expect(existsSync(filePath)).toBe(true);

    await appender.clear();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('');
  });

  it('clear 后 readRecent 应返回空数组', async () => {
    const appender = new JsonlAppender({ filePath });
    appender.append({ data: 'test' });
    await flushWrites();

    await appender.clear();
    const records = await appender.readRecent();
    expect(records).toEqual([]);
  });

  // ─── truncateIfNeeded（计数器间隔截断） ────────────────

  it('超出 maxEntries 时应截断保留最近条目', async () => {
    // maxEntries=5，truncateCheckInterval=1（每次写入都检查，便于测试）
    const appender = new JsonlAppender({ filePath, maxEntries: 5, truncateCheckInterval: 1 });
    for (let i = 1; i <= 10; i++) {
      appender.append({ idx: i });
      // fire-and-forget 异步：需等待 appendFile + truncateIfNeeded 全部完成
      // 100ms 确保在高并发测试环境下也有足够 I/O 时间
      await flushWrites(100);
    }
    await flushWrites(150); // 最终等待，确保最后一次截断完成

    const records = await appender.readRecent<{ idx: number }>();
    // 截断后只保留最近 5 条
    expect(records).toHaveLength(5);
    expect(records[0]!.idx).toBe(10);
    expect(records[4]!.idx).toBe(6);
  });

  it('truncateCheckInterval 控制截断检查频率', async () => {
    // maxEntries=3，truncateCheckInterval=100（几乎不触发截断）
    const appender = new JsonlAppender({ filePath, maxEntries: 3, truncateCheckInterval: 100 });
    for (let i = 1; i <= 5; i++) {
      appender.append({ idx: i });
    }
    await flushWrites();

    // 未触发截断检查（writeCount=5 未达到 100），文件应有 5 条
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('maxEntries=0 时不应截断', async () => {
    const appender = new JsonlAppender({ filePath, maxEntries: 0, truncateCheckInterval: 1 });
    for (let i = 1; i <= 5; i++) {
      appender.append({ idx: i });
      await flushWrites(10);
    }
    await flushWrites();

    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    // maxEntries=0 禁用截断，全部保留
    expect(lines).toHaveLength(5);
  });

  // ─── writeCount 累计 ───────────────────────────────────

  it('getWriteCount 应返回累计写入次数', () => {
    const appender = new JsonlAppender({ filePath });
    expect(appender.getWriteCount()).toBe(0);

    appender.append({ a: 1 });
    appender.append({ b: 2 });
    appender.append({ c: 3 });

    expect(appender.getWriteCount()).toBe(3);
  });

  // ─── 构造函数 ──────────────────────────────────────────

  it('构造函数应自动创建目录', () => {
    const nestedPath = join(tmpDir, 'nested', 'deep', 'audit.log');
    expect(existsSync(join(tmpDir, 'nested'))).toBe(false);

    // 构造函数内部调用 mkdirSync recursive，应自动创建嵌套目录
    new JsonlAppender({ filePath: nestedPath });

    expect(existsSync(join(tmpDir, 'nested', 'deep'))).toBe(true);
  });

  it('默认 maxEntries 应为 1000', async () => {
    // 通过不传 maxEntries 验证默认值——写入少量数据不应触发截断
    const appender = new JsonlAppender({ filePath, truncateCheckInterval: 1 });
    appender.append({ idx: 1 });
    appender.append({ idx: 2 });
    await flushWrites();

    const records = await appender.readRecent<{ idx: number }>();
    expect(records).toHaveLength(2);
  });
});
