/**
 * NodeSqliteStorage 测试入口
 *
 * ① 共用契约套件（与 InMemoryStorage 对拍同一份断言）—— 两实现语义逐位一致是硬不变量；
 * ② SQLite 专属能力：落盘持久、跨连接可见（多进程互见的同源模拟）、只读视图结构、LIKE 转义、
 *    工厂不可用判据。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeSqliteStorage } from '@/memory/nodeSqliteStorage.js';
import { MemoraError, ToolErrorCode } from '@/utils/errors.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import { makeMemory, runStorageContract } from './storageContract.js';

// ─── ① 契约对拍（内存库，快）──────────────────────────────

runStorageContract('NodeSqliteStorage', () => createNodeSqliteStorage(':memory:'));

// ─── ② SQLite 专属行为（文件库）───────────────────────────

describe('NodeSqliteStorage · 专属行为', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-sqlite-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('落盘持久化：写入 → close → 重开仍可读（数据保留，非内存丢弃）', () => {
    const path = join(dir, 'persist.db');
    const s1 = createNodeSqliteStorage(path);
    s1.upsert(makeMemory('r:1', SOURCE_LABELS.RULE));
    s1.close?.();

    const s2 = createNodeSqliteStorage(path);
    const got = s2.getById('r:1');
    expect(got).not.toBeNull();
    expect(got!.content).toBe('内容-r:1');
    s2.close?.();
  });

  it('跨连接可见：一个连接写入后，另一个连接立即读到（多进程互见的同源模拟）', () => {
    const path = join(dir, 'shared.db');
    const a = createNodeSqliteStorage(path);
    const b = createNodeSqliteStorage(path);

    a.upsert(makeMemory('x:1', 'content'));
    // b 在 a 写入之后发起的查询应看到已提交数据（无内存快照层）
    expect(b.getById('x:1')).not.toBeNull();
    expect(b.count()).toBe(1);

    // 反向：b 写 → a 读
    b.upsert(makeMemory('y:1', 'content'));
    expect(a.getById('y:1')).not.toBeNull();

    a.close?.();
    b.close?.();
  });

  it('只读视图：写方法结构上不存在，读正常', () => {
    const path = join(dir, 'readonly.db');
    const rw = createNodeSqliteStorage(path);
    rw.upsert(makeMemory('r:1', SOURCE_LABELS.RULE));
    rw.close?.();

    const view = createNodeSqliteStorage(path, { readOnly: true });
    for (const writeMethod of ['upsert', 'delete', 'restore', 'purge', 'touch'] as const) {
      expect(writeMethod in view).toBe(false);
    }
    expect(view.getById('r:1')).not.toBeNull();
    expect(view.count()).toBe(1);
    expect(view.search('内容')).toHaveLength(1);
    view.close?.();
  });

  it('只读打开不存在的文件 → FILE_NOT_FOUND 专属错误码（只读宿主不做建库/迁移）', () => {
    const absent = join(dir, 'absent.db');
    // 判据在错误码上，不在 message 上：宿主靠 code 分支，驱动原文（ERR_SQLITE_ERROR）不构成契约
    let caught: unknown;
    try {
      createNodeSqliteStorage(absent, { readOnly: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoraError);
    expect((caught as MemoraError).errorCode).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect((caught as MemoraError).detail).toContain(absent);
  });

  it('search：LIKE 通配符被转义，% 与 _ 按字面值匹配（不误当模式符）', () => {
    const path = join(dir, 'escape.db');
    const s = createNodeSqliteStorage(path);
    s.upsert({ ...makeMemory('pct', 'content'), content: '进度 100% 完成' });
    s.upsert({ ...makeMemory('und', 'content'), content: '变量 a_b 说明' });
    s.upsert({ ...makeMemory('nope', 'content'), content: '变量 aXb 不同' });

    // `100%` 里的 % 是字面值：若不转义会匹配任意串（过度召回），转义后只命中本行
    const pctHits = s.search('100%');
    expect(pctHits.map((m) => m.id)).toEqual(['pct']);

    // `a_b` 里的 _ 是字面值：不得匹配到 `aXb`
    const undHits = s.search('a_b');
    expect(undHits.map((m) => m.id)).toEqual(['und']);

    s.close?.();
  });

  it('工厂不可用：内建模块缺失 → 抛 NOT_AVAILABLE 专属错误（可用性判据唯一来源）', () => {
    const spy = vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined as never);
    try {
      let caught: unknown;
      try {
        createNodeSqliteStorage(':memory:');
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MemoraError);
      expect((caught as MemoraError).errorCode).toBe(ToolErrorCode.NOT_AVAILABLE);
    } finally {
      spy.mockRestore();
    }
  });

  it('工厂恢复后仍可正常创建（mock 不留副作用）', () => {
    const s = createNodeSqliteStorage(':memory:');
    expect(s.count()).toBe(0);
    s.close?.();
  });
});
