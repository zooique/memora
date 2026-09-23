/**
 * WorkspaceStorage 单元测试
 *
 * 覆盖关键行为：
 *   - search：分词 token 匹配（多关键词短语召回，而非整串子串）
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Memory } from '@zooique/memora';
import { WorkspaceStorage } from '../workspaceStorage.js';

/** 构造一条最小 Memory（测试数据） */
function makeMemory(overrides: Partial<Memory> & { id: string; content: string }): Memory {
  const now = new Date().toISOString();
  return {
    source: 'test',
    name: `记忆-${overrides.id}`,
    createdAt: now,
    accessedAt: now,
    ...overrides,
  };
}

describe('WorkspaceStorage.search', () => {
  /** 临时工作区路径（每用例独立，避免落盘文件互相污染） */
  let dir: string;
  /** 被测试的存储实例 */
  let storage: WorkspaceStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-ws-test-'));
    storage = new WorkspaceStorage(dir);
    storage.load();
  });

  it('多关键词短语应通过分词 token 匹配命中', () => {
    storage.upsert(
      makeMemory({
        id: 'm1',
        content: '用户决定插件记忆功能采用 JSON 文件存储（memories.json），不引入 SQLite。',
      }),
    );

    // query 含空格时按分词 token 匹配，任一 token 命中即返回
    const hits = storage.search('记忆存储方案 决策', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('单关键词命中 content 即可返回', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储，保持零依赖。' }));

    const hits = storage.search('JSON', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('关键词命中 name 也应返回', () => {
    storage.upsert(
      makeMemory({ id: 'm1', content: '无关内容', name: '存储方案决策记录' }),
    );

    const hits = storage.search('存储方案', 10);
    expect(hits.map((m) => m.id)).toContain('m1');
  });

  it('软删除的记忆不被命中', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储。' }));
    storage.delete('m1');

    const hits = storage.search('JSON', 10);
    expect(hits).toHaveLength(0);
  });

  it('空查询按 accessedAt 降序返回全部活跃记忆', () => {
    storage.upsert(makeMemory({ id: 'old', content: '旧记忆', accessedAt: '2026-01-01T00:00:00.000Z' }));
    storage.upsert(makeMemory({ id: 'new', content: '新记忆', accessedAt: '2026-09-01T00:00:00.000Z' }));

    const hits = storage.search('', 10);
    expect(hits.map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('limit 截断返回数量', () => {
    for (let i = 0; i < 5; i++) {
      storage.upsert(makeMemory({ id: `m${i}`, content: `记忆内容 ${i}` }));
    }

    const hits = storage.search('记忆', 3);
    expect(hits).toHaveLength(3);
  });

  it('返回结果为浅拷贝，修改不影响内部存储', () => {
    storage.upsert(makeMemory({ id: 'm1', content: '采用 JSON 文件存储。' }));

    const hits = storage.search('JSON', 10);
    hits[0]!.accessedAt = '1970-01-01T00:00:00.000Z';
    // 内部存储的 accessedAt 不应被外部修改污染
    expect(storage.getById('m1')!.accessedAt).not.toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('WorkspaceStorage.load 数据层清洗（阶段3 score 退役后）', () => {
  let dir: string;
  /** 记忆文件路径：`<dir>/.memora/memories.json` */
  let memoryFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-ws-load-'));
    mkdirSync(join(dir, '.memora'), { recursive: true });
    memoryFile = join(dir, '.memora', 'memories.json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 写一条带已退役 score 字段的旧档记忆到磁盘 */
  function writeLegacy(): void {
    writeFileSync(
      memoryFile,
      JSON.stringify(
        [
          {
            id: 'round-summary:legacy',
            content: '旧档内容（退役字段已在顶层）',
            source: 'round-summary',
            name: 'legacy',
            createdAt: '2026-06-02T00:00:00.000Z',
            accessedAt: '2026-06-02T00:00:00.000Z',
            score: 0.85, // 阶段3 已物理退役
          },
        ],
        null,
        2,
      ),
    );
  }

  it('读旧档后内存对象不应残留 score（白名单剥离）', () => {
    writeLegacy();
    const storage = new WorkspaceStorage(dir);
    storage.load();

    const loaded = storage.getById('round-summary:legacy')!;
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>).score).toBeUndefined();
  });

  it('下次写回应不含 score（读即清洗，无需迁移脚本）', () => {
    writeLegacy();
    const storage = new WorkspaceStorage(dir);
    storage.load();
    // 触发一次写回
    expect(storage.touch('round-summary:legacy', new Date().toISOString())).toBe(true);

    // 结构化断言：落盘条目不应再有 score 键（字符串匹配会误伤 content 里的同名词）
    const onDisk = JSON.parse(readFileSync(memoryFile, 'utf8')) as Record<string, unknown>[];
    expect(onDisk).toHaveLength(1);
    expect(Object.keys(onDisk[0]!)).not.toContain('score');
  });

  it('单条损坏只跳过该条，不整库清空', () => {
    writeFileSync(
      memoryFile,
      JSON.stringify([
        {
          id: 'good:1',
          content: '合法记忆',
          source: 'test',
          name: 'good',
          createdAt: '2026-06-02T00:00:00.000Z',
          accessedAt: '2026-06-02T00:00:00.000Z',
        },
        { id: 'bad:1' }, // 缺 content/source/name/日期 → 解析失败
      ]),
    );

    const storage = new WorkspaceStorage(dir);
    storage.load();

    // 合法条目保住，损坏条目跳过——不因一条脏数据丢掉整个记忆库
    expect(storage.getById('good:1')).not.toBeNull();
    expect(storage.getById('bad:1')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('顶层非数组应降级为空库而非崩溃', () => {
    writeFileSync(memoryFile, JSON.stringify({ notAnArray: true }));

    const storage = new WorkspaceStorage(dir);
    expect(() => storage.load()).not.toThrow();
    expect(storage.search('', 10)).toHaveLength(0);
  });

  it('deletedAt 为 null 的记忆应判定为活跃（null 归一为 undefined）', () => {
    writeFileSync(
      memoryFile,
      JSON.stringify([
        {
          id: 'test:null-deleted',
          content: '曾落盘为 null',
          source: 'test',
          name: 'null-deleted',
          createdAt: '2026-06-02T00:00:00.000Z',
          accessedAt: '2026-06-02T00:00:00.000Z',
          deletedAt: null,
        },
      ]),
    );

    const storage = new WorkspaceStorage(dir);
    storage.load();

    // 若 null 未归一，isActive 判 `deletedAt === undefined` 为 false → 记忆被误判已删除
    expect(storage.search('曾落盘', 10).map((m) => m.id)).toContain('test:null-deleted');
  });
});

describe('WorkspaceStorage.migrateRetiredSettingSources（设定记忆存量清理）', () => {
  /** 临时工作区路径 */
  let dir: string;
  /** 记忆文件路径：`<dir>/.memora/memories.json` */
  let memoryFile: string;
  /** 被测试的存储实例 */
  let storage: WorkspaceStorage;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memora-ws-migrate-'));
    mkdirSync(join(dir, '.memora'), { recursive: true });
    memoryFile = join(dir, '.memora', 'memories.json');
    storage = new WorkspaceStorage(dir);
    storage.load();
  });

  it('persona/rule/skill 存量行被软删，摘要记忆不受影响', () => {
    storage.upsert(makeMemory({ id: 'p1', content: '旧人格设定', source: 'persona' }));
    storage.upsert(makeMemory({ id: 'r1', content: '旧创作规则', source: 'rule' }));
    storage.upsert(makeMemory({ id: 's1', content: '旧技能定义', source: 'skill' }));
    storage.upsert(makeMemory({ id: 'rs1', content: '轮次摘要', source: 'round-summary' }));

    expect(storage.migrateRetiredSettingSources()).toBe(3);

    // 设定行退出记忆库全部活跃查询面
    expect(storage.getById('p1')).toBeNull();
    expect(storage.getById('r1')).toBeNull();
    expect(storage.getById('s1')).toBeNull();
    expect(storage.count()).toBe(1);
    expect(storage.search('旧', 10)).toHaveLength(0);
    // 摘要记忆原样保留
    expect(storage.getById('rs1')).not.toBeNull();
  });

  it('软删行进回收站可兜底恢复（迁移不直删）', () => {
    storage.upsert(makeMemory({ id: 'p1', content: '旧人格设定', source: 'persona' }));

    storage.migrateRetiredSettingSources();

    // 回收站可见 + restore 可恢复，数据未被物理清除
    expect(storage.listDeleted().map((m) => m.id)).toContain('p1');
    storage.restore('p1');
    expect(storage.getById('p1')).not.toBeNull();
  });

  it('幂等：二次执行零动作，且不覆盖首次软删时间戳', () => {
    storage.upsert(makeMemory({ id: 'p1', content: '旧人格设定', source: 'persona' }));

    expect(storage.migrateRetiredSettingSources()).toBe(1);
    const firstDeletedAt = storage.listDeleted()[0]!.deletedAt;

    expect(storage.migrateRetiredSettingSources()).toBe(0);
    expect(storage.listDeleted()[0]!.deletedAt).toBe(firstDeletedAt);
  });

  it('落盘为软删形态：行仍在文件中带 deletedAt（软删兼容）', () => {
    storage.upsert(makeMemory({ id: 'p1', content: '旧人格设定', source: 'persona' }));

    storage.migrateRetiredSettingSources();

    const onDisk = JSON.parse(readFileSync(memoryFile, 'utf8')) as Record<string, unknown>[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.deletedAt).toBeTypeOf('string');
  });
});

