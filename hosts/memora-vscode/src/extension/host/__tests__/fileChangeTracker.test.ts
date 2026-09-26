/**
 * FileChangeTracker 单测（纯逻辑 · node 环境 · 无需 mock vscode）
 *
 * 对位设计文档 docs/方案-文件改动diff可视化-20260926.md §7 验证计划中**可纯逻辑验证**的条目：
 * 触发正确性 / 新文件 / 删除 / args 容错 / 按文件合并 / 确认即注销 / 跨会话存活 / 多文件 / 上限淘汰。
 * 依赖真实 VS Code API 的渲染与恢复写回（open/decoration/diff/statusbar）不在此覆盖。
 *
 * 路径说明：`path.resolve` 在 Windows 上带盘符，故期望键一律经 `abs()` 计算，不硬编码 POSIX 字面量。
 *
 * @module __tests__/fileChangeTracker.test
 */

import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  FileChangeTracker,
  DISK_WRITE_TOOLS,
  type FileChangeIO,
  type FileChangeTrackerOptions,
} from '../fileChangeTracker.js';

const ROOT = resolve('/proj');
const abs = (rel: string): string => resolve(ROOT, rel);

/** 内存文件系统假实现：避免真实 IO（本环境 rmSync 慢，纯逻辑更快更稳） */
function makeIO(initial: Record<string, string> = {}): FileChangeIO & { set(p: string, c: string | null): void } {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    readTextFile: (p: string): string | null => (files.has(p) ? (files.get(p) as string) : null),
    set: (p: string, c: string | null): void => {
      if (c === null) files.delete(p);
      else files.set(p, c);
    },
  };
}

/** 递增时钟（确定性）：每次调用 +1，保证 updatedAt 可比较且无并列 */
function makeClock(): () => number {
  let t = 0;
  return () => ++t;
}

function makeTracker(io: FileChangeIO, opts: Partial<FileChangeTrackerOptions> = {}): FileChangeTracker {
  return new FileChangeTracker(ROOT, { io, now: makeClock(), ...opts });
}

describe('FileChangeTracker', () => {
  it('触发集合仅 write_file / delete_file', () => {
    expect([...DISK_WRITE_TOOLS]).toEqual(['write_file', 'delete_file']);
  });

  it('write_file 覆盖已有文件 → 记录 before≠after、writeCount=1', () => {
    const io = makeIO({ [abs('a.md')]: 'old' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    io.set(abs('a.md'), 'new'); // 模拟内核写盘
    const rec = tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    expect(rec).not.toBeNull();
    expect(rec?.path).toBe(abs('a.md'));
    expect(rec?.relPath).toBe('a.md');
    expect(rec?.beforeContent).toBe('old');
    expect(rec?.afterContent).toBe('new');
    expect(rec?.writeCount).toBe(1);
    expect(tracker.size()).toBe(1);
  });

  it('新文件（磁盘无旧内容）→ beforeContent=null', () => {
    const io = makeIO();
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'brand.md', content: 'x' }) });
    io.set(abs('brand.md'), 'x');
    const rec = tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    expect(rec?.beforeContent).toBeNull();
    expect(rec?.afterContent).toBe('x');
  });

  it('delete_file → afterContent=null', () => {
    const io = makeIO({ [abs('gone.md')]: 'bye' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'delete_file', args: JSON.stringify({ path: 'gone.md' }) });
    io.set(abs('gone.md'), null); // 模拟删除
    const rec = tracker.noteToolResult({ toolCallId: 't1', name: 'delete_file', ok: true });

    expect(rec?.beforeContent).toBe('bye');
    expect(rec?.afterContent).toBeNull();
  });

  it('args 为 undefined / 非法 JSON / 无 path → 跳过且不抛错、无记录', () => {
    const io = makeIO();
    const tracker = makeTracker(io);

    expect(() => tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: undefined })).not.toThrow();
    expect(() => tracker.noteToolStart({ toolCallId: 't2', name: 'write_file', args: '{not json' })).not.toThrow();
    expect(() => tracker.noteToolStart({ toolCallId: 't3', name: 'write_file', args: JSON.stringify({ content: 'no path' }) })).not.toThrow();
    // 三条均未登记 pending → result 无记录
    expect(tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true })).toBeNull();
    expect(tracker.size()).toBe(0);
  });

  it('blocked / 失败 → 不产生记录（写入未发生）', () => {
    const io = makeIO({ [abs('a.md')]: 'old' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    expect(tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: false })).toBeNull();

    tracker.noteToolStart({ toolCallId: 't2', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    expect(tracker.noteToolResult({ toolCallId: 't2', name: 'write_file', ok: false, blocked: true })).toBeNull();

    expect(tracker.size()).toBe(0);
  });

  it('非落盘工具（read_file）不追踪', () => {
    const io = makeIO();
    const tracker = makeTracker(io);
    tracker.noteToolStart({ toolCallId: 't1', name: 'read_file', args: JSON.stringify({ path: 'a.md' }) });
    expect(tracker.noteToolResult({ toolCallId: 't1', name: 'read_file', ok: true })).toBeNull();
    expect(tracker.size()).toBe(0);
  });

  it('按文件合并：同文件两次写 → 仍 1 条、beforeContent 为最早、writeCount=2、afterContent 最新', () => {
    const io = makeIO({ [abs('a.md')]: 'v0' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md', mode: 'overwrite' }) });
    io.set(abs('a.md'), 'v1');
    tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    tracker.noteToolStart({ toolCallId: 't2', name: 'write_file', args: JSON.stringify({ path: 'a.md', mode: 'append' }) });
    io.set(abs('a.md'), 'v2');
    const rec = tracker.noteToolResult({ toolCallId: 't2', name: 'write_file', ok: true });

    expect(tracker.size()).toBe(1);
    expect(rec?.beforeContent).toBe('v0');
    expect(rec?.afterContent).toBe('v2');
    expect(rec?.writeCount).toBe(2);
    expect(rec?.mode).toBe('append');
  });

  it('确认即注销：drop 后 size 归零、get 为 undefined', () => {
    const io = makeIO({ [abs('a.md')]: 'old' });
    const tracker = makeTracker(io);
    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    io.set(abs('a.md'), 'new');
    tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    tracker.drop(abs('a.md'));
    expect(tracker.size()).toBe(0);
    expect(tracker.get(abs('a.md'))).toBeUndefined();
  });

  it('跨会话存活语义：记录不随「新一轮」清空，仅 clear（= 扩展重启）清空', () => {
    const io = makeIO({ [abs('a.md')]: 'old' });
    const tracker = makeTracker(io);
    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    io.set(abs('a.md'), 'new');
    tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    // 模拟「切换/新建会话」：tracker 无会话概念，记录仍在
    expect(tracker.size()).toBe(1);
    expect(tracker.get(abs('a.md'))?.afterContent).toBe('new');

    // 模拟扩展重启
    tracker.clear();
    expect(tracker.size()).toBe(0);
  });

  it('多文件：三个文件各自记录，list size=3（按改动时间升序）', () => {
    const io = makeIO({ [abs('a.md')]: 'a0', [abs('b.md')]: 'b0' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: 'a.md' }) });
    io.set(abs('a.md'), 'a1');
    tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    tracker.noteToolStart({ toolCallId: 't2', name: 'write_file', args: JSON.stringify({ path: 'b.md' }) });
    io.set(abs('b.md'), 'b1');
    tracker.noteToolResult({ toolCallId: 't2', name: 'write_file', ok: true });

    tracker.noteToolStart({ toolCallId: 't3', name: 'write_file', args: JSON.stringify({ path: 'c.md' }) });
    io.set(abs('c.md'), 'c1');
    tracker.noteToolResult({ toolCallId: 't3', name: 'write_file', ok: true });

    expect(tracker.size()).toBe(3);
    expect(tracker.list().map((r) => r.relPath)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('上限淘汰：maxRecords=2 → 超出的最旧条目被淘汰', () => {
    const io = makeIO();
    const tracker = makeTracker(io, { maxRecords: 2 });

    for (const name of ['a.md', 'b.md', 'c.md']) {
      const id = `t-${name}`;
      tracker.noteToolStart({ toolCallId: id, name: 'write_file', args: JSON.stringify({ path: name }) });
      io.set(abs(name), 'x');
      tracker.noteToolResult({ toolCallId: id, name: 'write_file', ok: true });
    }

    expect(tracker.size()).toBe(2);
    expect(tracker.get(abs('a.md'))).toBeUndefined(); // 最旧被淘汰
    expect(tracker.get(abs('b.md'))).toBeDefined();
    expect(tracker.get(abs('c.md'))).toBeDefined();
  });

  it('绝对路径 args 不做项目根拼接', () => {
    const ABS = resolve('/abs/x.md');
    const io = makeIO({ [ABS]: 'old' });
    const tracker = makeTracker(io);
    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: ABS }) });
    io.set(ABS, 'new');
    const rec = tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });
    expect(rec?.path).toBe(ABS);
  });

  it('绝对路径 args → relPath 折回相对项目根（防经 file_changes 泄漏目录结构）', () => {
    const INSIDE = abs('sub/x.md');
    const OUTSIDE = resolve('/elsewhere/secret.md');
    const io = makeIO({ [INSIDE]: 'old', [OUTSIDE]: 'old' });
    const tracker = makeTracker(io);

    tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: INSIDE }) });
    io.set(INSIDE, 'new');
    const inside = tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    tracker.noteToolStart({ toolCallId: 't2', name: 'write_file', args: JSON.stringify({ path: OUTSIDE }) });
    io.set(OUTSIDE, 'new');
    const outside = tracker.noteToolResult({ toolCallId: 't2', name: 'write_file', ok: true });

    // 记录键始终是绝对路径（tracker 内部寻址用）
    expect(inside?.path).toBe(INSIDE);
    expect(outside?.path).toBe(OUTSIDE);
    // 展示路径折回相对 + 正斜杠——协议声明「不下发绝对路径，避免在 UI 暴露无关信息」
    expect(inside?.relPath).toBe('sub/x.md');
    expect(outside?.relPath).toBe('../elsewhere/secret.md');
  });
});
