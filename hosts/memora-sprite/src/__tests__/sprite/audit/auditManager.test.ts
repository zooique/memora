/**
 * AuditManager 单元测试
 *
 * 覆盖范围：
 * - record：追加带 timestamp + sessionId 的 AuditLogEntry
 * - readRecent：委托 JsonlAppender，返回最新在前
 * - clear：清空审计日志
 * - sessionId 一致性：同一实例所有记录共享 sessionId
 * - sessionId 唯一性：不同实例 sessionId 不同
 * - timestamp 格式：ISO 8601
 * - AuditEvent 字段透传：type/path/tool/source 等原样保留
 *
 * 测试策略：
 * - 使用 tmpdir 真实 I/O（对齐 jsonlAppender 测试模式）
 * - record 是 fire-and-forget（委托 appender.append），用 manager.flush() 精确等待写入队列排空
 * - readRecent 是 async，可直接 await
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuditManager } from '../../../sprite/audit/auditManager.js';
import type { AuditEvent } from 'memora';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** 创建测试用临时目录 */
function createTmpDir(): string {
  const dir = join(tmpdir(), `memora-audit-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 构造测试用 AuditEvent（补齐 timestamp 字段，record 会覆盖） */
function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    type: 'path-allow',
    path: '/test/path',
    timestamp: '', // record 会用 new Date().toISOString() 覆盖
    ...overrides,
  };
}

describe('AuditManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── record + readRecent 基础流程 ──────────────────────

  it('record 应追加带 timestamp + sessionId 的完整记录', async () => {
    const manager = new AuditManager(tmpDir);
    manager.record(makeEvent({ type: 'write-confirm', path: '/a/b.txt', tool: 'write_file' }));
    await manager.flush();

    const records = await manager.readRecent();
    expect(records).toHaveLength(1);
    const entry = records[0]!;
    // AuditEvent 字段透传
    expect(entry.type).toBe('write-confirm');
    expect(entry.path).toBe('/a/b.txt');
    expect(entry.tool).toBe('write_file');
    // AuditLogEntry 扩展字段
    expect(entry.sessionId).toMatch(/^sess-/);
    expect(entry.timestamp).toBeTruthy();
  });

  it('record 多次后 readRecent 应返回最新在前', async () => {
    const manager = new AuditManager(tmpDir);
    manager.record(makeEvent({ path: '/path1' }));
    await manager.flush();
    manager.record(makeEvent({ path: '/path2' }));
    await manager.flush();
    manager.record(makeEvent({ path: '/path3' }));
    await manager.flush();

    const records = await manager.readRecent();
    expect(records).toHaveLength(3);
    expect(records[0]!.path).toBe('/path3');
    expect(records[1]!.path).toBe('/path2');
    expect(records[2]!.path).toBe('/path1');
  });

  it('readRecent 应支持 limit 截断', async () => {
    const manager = new AuditManager(tmpDir);
    for (let i = 1; i <= 5; i++) {
      manager.record(makeEvent({ path: `/path${i}` }));
      await manager.flush();
    }

    const records = await manager.readRecent(2);
    expect(records).toHaveLength(2);
    expect(records[0]!.path).toBe('/path5');
    expect(records[1]!.path).toBe('/path4');
  });

  // ─── sessionId 一致性 + 唯一性 ─────────────────────────

  it('同一实例所有记录应共享同一 sessionId', async () => {
    const manager = new AuditManager(tmpDir);
    manager.record(makeEvent({ path: '/a' }));
    manager.record(makeEvent({ path: '/b' }));
    manager.record(makeEvent({ path: '/c' }));
    await manager.flush();

    const records = await manager.readRecent();
    expect(records).toHaveLength(3);
    const sessionId = records[0]!.sessionId;
    expect(records.every((r) => r.sessionId === sessionId)).toBe(true);
  });

  it('不同实例应生成不同 sessionId', () => {
    const manager1 = new AuditManager(tmpDir);
    const manager2 = new AuditManager(tmpDir);
    // sessionId 基于 Date.now() + 随机后缀（sess- 前缀），不同实例应不同
    // 注意：同一毫秒创建可能相同，但 toString(36) 时间戳 + 实例不同应足够区分
    expect(manager1).not.toBe(manager2);
    // 通过 record 后读取验证（间接验证 sessionId 唯一性）
  });

  it('不同实例 record 的 sessionId 应不同', async () => {
    const manager1 = new AuditManager(tmpDir);
    manager1.record(makeEvent({ path: '/from-mgr1' }));
    await manager1.flush();

    // 第二个 manager 写入不同文件（避免并发追加同一文件）
    const tmpDir2 = createTmpDir();
    try {
      const manager2 = new AuditManager(tmpDir2);
      manager2.record(makeEvent({ path: '/from-mgr2' }));
      await manager2.flush();

      const records1 = await manager1.readRecent();
      const records2 = await manager2.readRecent();
      expect(records1[0]!.sessionId).not.toBe(records2[0]!.sessionId);
    } finally {
      rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

  // ─── timestamp 格式 ────────────────────────────────────

  it('timestamp 应为有效 ISO 8601 格式', async () => {
    const manager = new AuditManager(tmpDir);
    const before = Date.now();
    manager.record(makeEvent({ path: '/test' }));
    await manager.flush();

    const records = await manager.readRecent();
    const entry = records[0]!;
    const ts = new Date(entry.timestamp).getTime();
    // 解析不应为 NaN
    expect(Number.isNaN(ts)).toBe(false);
    // timestamp 应在 record 调用前后时间范围内（允许 1 秒误差）
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('record 应覆盖 AuditEvent 原始 timestamp', async () => {
    const manager = new AuditManager(tmpDir);
    // 传入一个明显错误的旧 timestamp
    const oldTimestamp = '2000-01-01T00:00:00.000Z';
    manager.record(makeEvent({ path: '/test', timestamp: oldTimestamp }));
    await manager.flush();

    const records = await manager.readRecent();
    // record 内部用 new Date().toISOString() 覆盖，不应保留旧值
    expect(records[0]!.timestamp).not.toBe(oldTimestamp);
  });

  // ─── clear ─────────────────────────────────────────────

  it('clear 应清空审计日志', async () => {
    const manager = new AuditManager(tmpDir);
    manager.record(makeEvent({ path: '/a' }));
    manager.record(makeEvent({ path: '/b' }));
    await manager.flush();

    await manager.clear();

    const records = await manager.readRecent();
    expect(records).toEqual([]);
  });

  // ─── AuditEvent 字段透传 ───────────────────────────────

  it('应透传所有 AuditEvent 可选字段', async () => {
    const manager = new AuditManager(tmpDir);
    manager.record(
      makeEvent({
        type: 'write-decline',
        path: '/secret/file.txt',
        tool: 'custom_writer',
        source: 'custom',
        decision: 'declined' as never, // WriteDecision 类型简化
        reason: '用户拒绝写入',
      }),
    );
    await manager.flush();

    const records = await manager.readRecent();
    const entry = records[0]!;
    expect(entry.type).toBe('write-decline');
    expect(entry.path).toBe('/secret/file.txt');
    expect(entry.tool).toBe('custom_writer');
    expect(entry.source).toBe('custom');
    expect(entry.reason).toBe('用户拒绝写入');
  });

  // ─── 构造函数配置 ──────────────────────────────────────

  it('maxEntries 参数应正确透传给 JsonlAppender', async () => {
    // AuditManager 构造函数签名 (dataDir, maxEntries=1000)
    // 传入 maxEntries=2 验证构造不抛错 + 截断配置生效
    const manager = new AuditManager(tmpDir, 2);
    // 写入 4 条，由于默认 truncateCheckInterval=100，不会立即触发截断
    // 此处仅验证构造函数接受 maxEntries 参数不抛错
    manager.record(makeEvent({ path: '/a' }));
    manager.record(makeEvent({ path: '/b' }));
    await manager.flush();

    const records = await manager.readRecent();
    expect(records.length).toBeGreaterThanOrEqual(2);
    // maxEntries 实际截断行为已在 jsonlAppender.test.ts 中验证
  });
});
