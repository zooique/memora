/**
 * 审计日志单测 —— 一行一条 JSON / 追加顺序 / sink 失败不冒泡
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §16.2 G5
 *   （追加式审计：只 append，不就地改写；审计失败不得拖垮桥）
 */
import { describe, expect, it } from 'vitest';
import { RemoteAuditLog, type RemoteAuditSink } from '../remoteAudit.js';

/** 收集型 sink（按 append 顺序存行） */
class MemorySink implements RemoteAuditSink {
  /** 已追加的行（不含换行） */
  readonly lines: string[] = [];

  async append(line: string): Promise<void> {
    this.lines.push(line);
  }
}

describe('RemoteAuditLog — 追加式', () => {
  it('按调用顺序追加，每行是带 at 的 JSON', async () => {
    const sink = new MemorySink();
    const log = new RemoteAuditLog(sink, () => 1_700_000_000_000);

    await log.record({ event: 'device_paired', deviceFp: 'AAAA', ip: '192.168.1.2' });
    await log.record({ event: 'pairing_rejected', detail: 'mismatch' });

    expect(sink.lines).toHaveLength(2);
    const first = JSON.parse(sink.lines[0]) as Record<string, unknown>;
    const second = JSON.parse(sink.lines[1]) as Record<string, unknown>;
    expect(first).toEqual({
      at: 1_700_000_000_000,
      event: 'device_paired',
      deviceFp: 'AAAA',
      ip: '192.168.1.2',
    });
    expect(second.event).toBe('pairing_rejected');
    expect(second.detail).toBe('mismatch');
    // 每行都是单行（不含换行，换行由 sink 负责）
    expect(sink.lines[0]).not.toContain('\n');
  });

  it('sink 抛错只记日志，record 不 reject', async () => {
    const failingSink: RemoteAuditSink = {
      append: async () => {
        throw new Error('磁盘满');
      },
    };
    const logs: string[] = [];
    const log = new RemoteAuditLog(failingSink, Date.now, (m) => logs.push(m));

    await expect(log.record({ event: 'should_not_throw' })).resolves.toBeUndefined();
    expect(logs.some((line) => line.includes('追加审计行失败'))).toBe(true);
    expect(logs.some((line) => line.includes('磁盘满'))).toBe(true);
  });
});
