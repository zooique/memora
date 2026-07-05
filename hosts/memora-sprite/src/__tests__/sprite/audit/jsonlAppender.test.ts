/**
 * JsonlAppender 单元测试（QC-TEST-AUDIT）
 *
 * 覆盖范围：
 * - append：追加写入 + 串行化写入队列 + writeCount 累计
 * - readRecent：从后往前读取 + 最新在前 + limit 截断
 * - clear：清空文件
 * - truncateIfNeeded：超出 maxEntries 时截断保留最近条目
 * - truncateCheckInterval：计数器间隔检查（非每次写入都截断）
 * - 串行化写入顺序：快速连续 append 后验证文件内容顺序（QC-FLAKY-JSONL）
 * - 错误降级：文件不存在返回空数组 + 单行 JSON 解析失败跳过
 * - 构造函数：自动创建目录
 *
 * 测试策略：
 * - 使用 tmpdir 真实 I/O（对齐 storage 测试模式，零 mock）
 * - append 通过 writeChain 串行化，用 await appender.flush() 等待队列排空
 * - readRecent 是 async，可直接 await
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlAppender } from '../../../sprite/audit/jsonlAppender.js';
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
 * 每次 append 后 await flush() 会序列化等待，预写入避免此开销。
 */
function prewriteRecords(filePath: string, count: number): void {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(JSON.stringify({ idx: i }));
  }
  writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
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
    await appender.flush(); // fire-and-forget 异步，需等待第一条落盘保证顺序
    appender.append({ name: 'event2', type: 'write' });
    await appender.flush();

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
    await appender.flush();
    expect(existsSync(filePath)).toBe(true);

    await appender.clear();

    const content = readFileSync(filePath, 'utf8');
    expect(content).toBe('');
  });

  it('clear 后 readRecent 应返回空数组', async () => {
    const appender = new JsonlAppender({ filePath });
    appender.append({ data: 'test' });
    await appender.flush();

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
      // 用 flush() 精确等待 writeChain 排空
      await appender.flush();
    }
    await appender.flush(); // 最终等待，确保最后一次截断完成

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
    await appender.flush();

    // 未触发截断检查（writeCount=5 未达到 100），文件应有 5 条
    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(5);
  });

  it('maxEntries=0 时不应截断', async () => {
    const appender = new JsonlAppender({ filePath, maxEntries: 0, truncateCheckInterval: 1 });
    for (let i = 1; i <= 5; i++) {
      appender.append({ idx: i });
      await appender.flush();
    }
    await appender.flush();

    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    // maxEntries=0 禁用截断，全部保留
    expect(lines).toHaveLength(5);
  });

  // ─── 串行化写入顺序 ──────────

  it('快速连续 append 应保持写入顺序（串行化写入队列）', async () => {
    // 验证 writeChain 串行化后，快速连续 append 不会乱序或丢失
    const appender = new JsonlAppender({ filePath, maxEntries: 0 });
    // 不等待地连续 append 20 条（模拟高并发写入场景）
    for (let i = 1; i <= 20; i++) {
      appender.append({ idx: i });
    }
    // 等待 writeChain 队列全部排空
    await appender.flush();

    const content = readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n');
    // 全部 20 条都应写入，顺序与调用顺序一致
    expect(lines).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      const record = JSON.parse(lines[i]!) as { idx: number };
      expect(record.idx).toBe(i + 1);
    }
  });

  it('并发 append + truncate 应无行丢失（串行化修复核心验证）', async () => {
    // 核心验证：maxEntries=5 + truncateCheckInterval=1
    // 每次 append 都触发 truncateIfNeeded，串行化前会因 read-modify-write
    // 竞态丢失行，串行化后应完整保留最近 5 条
    const appender = new JsonlAppender({ filePath, maxEntries: 5, truncateCheckInterval: 1 });
    // 快速连续 append 10 条（不等待，模拟并发场景）
    for (let i = 1; i <= 10; i++) {
      appender.append({ idx: i });
    }
    // 等待 writeChain 队列全部排空（含所有 truncateIfNeeded）
    await appender.flush();

    const records = await appender.readRecent<{ idx: number }>();
    // 截断后只保留最近 5 条（idx 6-10），无丢失
    expect(records).toHaveLength(5);
    expect(records[0]!.idx).toBe(10);
    expect(records[4]!.idx).toBe(6);
  });

  // ─── writeCount 累计 ───────────────────────────────────

  it('getWriteCount 应返回累计写入次数', async () => {
    const appender = new JsonlAppender({ filePath });
    expect(appender.getWriteCount()).toBe(0);

    appender.append({ a: 1 });
    appender.append({ b: 2 });
    appender.append({ c: 3 });

    expect(appender.getWriteCount()).toBe(3);
    // 串行化后需等待 writeChain 排空，避免 afterEach 删除目录后 pending 操作报错
    await appender.flush();
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
    await appender.flush();

    const records = await appender.readRecent<{ idx: number }>();
    expect(records).toHaveLength(2);
  });
});
