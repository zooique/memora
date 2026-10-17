/**
 * 宿主记忆存储接线单元测试
 *
 * 覆盖分档矩阵（见 memoryStorage.ts 文件头）：
 *   - SQLite 可用：无旧档建空库 / 有旧档迁移并改名 / 退役来源软删 / 坏数据跳过 / 幂等；
 *   - SQLite 不可用：未迁移降级 JSON / 已迁移响亮失败 / 真故障不伪装成降级。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoraError, ToolErrorCode, type Memory } from '@zooique/memora';
import { createHostMemoryStorage, type MemoryStorageDeps } from '../memoryStorage.js';

/** 临时工作区路径（每用例独立，避免落盘互相污染） */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memora-store-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造一条最小 Memory（测试数据） */
function makeMemory(overrides: Partial<Memory> & { id: string; content: string }): Memory {
  const now = new Date().toISOString();
  return {
    source: 'round-summary',
    name: `记忆-${overrides.id}`,
    createdAt: now,
    accessedAt: now,
    ...overrides,
  };
}

/** 写入旧 JSON 档（自动建 .memora 目录），返回文件路径 */
function writeLegacyJson(workspace: string, rows: unknown[]): string {
  mkdirSync(join(workspace, '.memora'), { recursive: true });
  const file = join(workspace, '.memora', 'memories.json');
  writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
  return file;
}

/** .memora 目录下的文件名清单 */
function memoraFiles(workspace: string): string[] {
  return readdirSync(join(workspace, '.memora'));
}

/** 构造「SQLite 不可用」探针：抛专属 NOT_AVAILABLE 错误 */
function unavailableDeps(): MemoryStorageDeps {
  return {
    openSqlite: () => {
      throw new MemoraError({
        title: 'SQLite 存储不可用',
        detail: '当前 Node 运行时未提供 node:sqlite 内建模块',
        suggestions: [],
        category: 'config',
        errorCode: ToolErrorCode.NOT_AVAILABLE,
      });
    },
  };
}

describe('createHostMemoryStorage · SQLite 可用', () => {
  it('无旧档：建空 SQLite 库，不产生 JSON 档', () => {
    const storage = createHostMemoryStorage(dir);
    expect(storage.count()).toBe(0);
    expect(memoraFiles(dir)).toContain('memories.db');
    expect(memoraFiles(dir)).not.toContain('memories.json');
    storage.close?.();
  });

  it('有旧档：迁入 SQLite 并改名保留旧档（可追溯、不删除）', () => {
    writeLegacyJson(dir, [
      makeMemory({ id: 'm1', content: '记忆一' }),
      makeMemory({ id: 'm2', content: '记忆二' }),
    ]);

    const storage = createHostMemoryStorage(dir);
    expect(storage.count()).toBe(2);
    expect(storage.getById('m1')?.content).toBe('记忆一');
    // 旧档改名保留为 memories.json.migrated-<date>，原 memories.json 不再存在
    expect(memoraFiles(dir).some((f) => f.startsWith('memories.json.migrated-'))).toBe(true);
    expect(memoraFiles(dir)).not.toContain('memories.json');
    storage.close?.();
  });

  it('退役设定来源存量行随迁移软删（persona 出活跃集、进回收站）', () => {
    writeLegacyJson(dir, [
      makeMemory({ id: 'keep', content: '摘要', source: 'round-summary' }),
      makeMemory({ id: 'persona1', content: '旧设定', source: 'persona' }),
    ]);

    const storage = createHostMemoryStorage(dir);
    expect(storage.count()).toBe(1);
    expect(storage.getById('persona1')).toBeNull();
    expect(storage.listDeleted().map((m) => m.id)).toContain('persona1');
    storage.close?.();
  });

  it('单条坏数据跳过，其余照常迁入（不因一条脏数据清空整库）', () => {
    writeLegacyJson(dir, [makeMemory({ id: 'good', content: '正常' }), { not: 'a memory' }]);

    const storage = createHostMemoryStorage(dir);
    expect(storage.count()).toBe(1);
    expect(storage.getById('good')?.content).toBe('正常');
    storage.close?.();
  });

  it('幂等：再次装配不重复迁移、数据仍在、不新增快照', () => {
    writeLegacyJson(dir, [makeMemory({ id: 'm1', content: '一' })]);
    createHostMemoryStorage(dir).close?.();
    const snapshotsBefore = memoraFiles(dir).filter((f) => f.startsWith('memories.json.migrated-'));

    const storage = createHostMemoryStorage(dir);
    expect(storage.count()).toBe(1);
    const snapshotsAfter = memoraFiles(dir).filter((f) => f.startsWith('memories.json.migrated-'));
    expect(snapshotsAfter.length).toBe(snapshotsBefore.length);
    storage.close?.();
  });
});

describe('createHostMemoryStorage · SQLite 不可用', () => {
  it('未迁移：降级 JSON 读写（现状不变）', () => {
    const storage = createHostMemoryStorage(dir, undefined, unavailableDeps());
    expect(storage.count()).toBe(0);
    // 降级后仍可读写：写一条即落 JSON 档，且不产生 .db
    storage.upsert(makeMemory({ id: 'w1', content: '写一条' }));
    expect(storage.count()).toBe(1);
    expect(memoraFiles(dir)).toContain('memories.json');
    expect(memoraFiles(dir)).not.toContain('memories.db');
  });

  it('已迁移（有 .db）：响亮失败（禁数据分叉，不静默空库）', () => {
    mkdirSync(join(dir, '.memora'), { recursive: true });
    writeFileSync(join(dir, '.memora', 'memories.db'), '');
    expect(() => createHostMemoryStorage(dir, undefined, unavailableDeps())).toThrow(MemoraError);
  });

  it('真故障（非 NOT_AVAILABLE）：原样抛出，不伪装成降级', () => {
    const deps: MemoryStorageDeps = {
      openSqlite: () => {
        throw new Error('磁盘只读');
      },
    };
    expect(() => createHostMemoryStorage(dir, undefined, deps)).toThrow('磁盘只读');
    // 未降级：不产生 JSON 档（否则等于「真故障被吞成环境问题」）
    expect(memoraFiles(dir)).not.toContain('memories.json');
  });
});
