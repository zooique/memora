/**
 * TopicStore 单元测试
 *
 * 覆盖：
 *   - 创建新话题并追加首条消息
 *   - 追加第二条消息（应保留已有内容）
 *   - 读取已存在的话题文件
 *   - 读取不存在的话题返回 null
 *   - 列出话题文件
 *   - 序列化 → 反序列化（formatMessage / parseMessages）
 *   - todayDate / nowTimestamp 工具函数
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TopicStore, todayDate, nowTimestamp } from '../topic-store.js';

describe('TopicStore · 话题文件持久化', () => {
  let dataDir: string;
  let store: TopicStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memora-topic-'));
    store = new TopicStore(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('应该创建新话题并追加首条 user 消息', async () => {
    const msg = { role: 'user' as const, content: '你好', timestamp: '2026-06-02T10:00:00.000Z' };
    await store.append('2026-06-02', 'main', msg);

    const filePath = store.getFilePath('2026-06-02', 'main');
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('date: 2026-06-02');
    expect(content).toContain('topic: main');
    expect(content).toContain('# main (2026-06-02)');
    expect(content).toContain('## [user] 2026-06-02T10:00:00.000Z');
    expect(content).toContain('你好');
  });

  it('应该能追加第二条消息并保留已有内容', async () => {
    const msg1 = {
      role: 'user' as const,
      content: '第一条',
      timestamp: '2026-06-02T10:00:00.000Z',
    };
    const msg2 = {
      role: 'assistant' as const,
      content: '第二条',
      timestamp: '2026-06-02T10:00:05.000Z',
    };

    await store.append('2026-06-02', 'main', msg1);
    await store.append('2026-06-02', 'main', msg2);

    const tf = await store.read('2026-06-02', 'main');
    expect(tf).not.toBeNull();
    expect(tf!.messages).toHaveLength(2);
    expect(tf!.messages[0]?.content).toBe('第一条');
    expect(tf!.messages[1]?.content).toBe('第二条');
    expect(tf!.messages[1]?.role).toBe('assistant');
  });

  it('应该能读取已存在的话题文件', async () => {
    const msg = {
      role: 'user' as const,
      content: '测试读取',
      timestamp: '2026-06-02T12:00:00.000Z',
    };
    await store.append('2026-06-02', 'chat', msg);

    const tf = await store.read('2026-06-02', 'chat');
    expect(tf).not.toBeNull();
    expect(tf!.date).toBe('2026-06-02');
    expect(tf!.topic).toBe('chat');
    expect(tf!.messages).toHaveLength(1);
    expect(tf!.messages[0]?.content).toBe('测试读取');
  });

  it('读取不存在的话题应该返回 null', async () => {
    const tf = await store.read('2099-01-01', 'nonexistent');
    expect(tf).toBeNull();
  });

  it('应该能列出所有话题文件', async () => {
    await store.append('2026-06-01', 'a', {
      role: 'user',
      content: 'a1',
      timestamp: '2026-06-01T10:00:00.000Z',
    });
    await store.append('2026-06-02', 'b', {
      role: 'user',
      content: 'b1',
      timestamp: '2026-06-02T10:00:00.000Z',
    });
    await store.append('2026-06-02', 'c', {
      role: 'user',
      content: 'c1',
      timestamp: '2026-06-02T10:00:00.000Z',
    });

    const list = await store.list();
    expect(list).toHaveLength(3);
    expect(list).toContain('2026-06-01-a.md');
    expect(list).toContain('2026-06-02-b.md');
    expect(list).toContain('2026-06-02-c.md');
  });

  it('列出空目录应该返回空数组', async () => {
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('应该能从写好的文件正确反序列化 frontmatter 元数据', async () => {
    const tf = {
      date: '2026-06-02',
      topic: 'meta-test',
      messages: [{ role: 'user' as const, content: 'msg', timestamp: '2026-06-02T10:00:00.000Z' }],
      summary: '一个测试话题',
      keywords: ['test', 'topic'],
    };
    await store.write(tf);

    const loaded = await store.read('2026-06-02', 'meta-test');
    expect(loaded).not.toBeNull();
    expect(loaded!.summary).toBe('一个测试话题');
    expect(loaded!.keywords).toEqual(['test', 'topic']);
    expect(loaded!.messages).toHaveLength(1);
  });

  it('应该支持多行消息内容（包含换行符）', async () => {
    const msg = {
      role: 'assistant' as const,
      content: '第一行\n第二行\n第三行',
      timestamp: '2026-06-02T10:00:00.000Z',
    };
    await store.append('2026-06-02', 'multiline', msg);

    const tf = await store.read('2026-06-02', 'multiline');
    expect(tf!.messages[0]?.content).toBe('第一行\n第二行\n第三行');
  });
});

describe('TopicStore · 工具函数', () => {
  it('todayDate 应该返回 YYYY-MM-DD 格式', () => {
    const fixed = new Date('2026-06-02T15:30:00');
    expect(todayDate(fixed)).toBe('2026-06-02');
  });

  it('todayDate 应该补零到两位数', () => {
    const fixed = new Date('2026-01-05T08:00:00');
    expect(todayDate(fixed)).toBe('2026-01-05');
  });

  it('nowTimestamp 应该返回 ISO 8601 字符串', () => {
    const fixed = new Date('2026-06-02T10:00:00.000Z');
    expect(nowTimestamp(fixed)).toBe('2026-06-02T10:00:00.000Z');
  });
});
