/**
 * 工作台清单历史重建测试
 *
 * 钉住的判据：
 *   - 新进程账本为空时，能从代理会话历史里恢复 `create_session` 的 sid 与标题；
 *   - 历史读不出来 / 某条记录解析失败 ⇒ 标 `unreadable` / `partial`（不得返回「完整空清单」）；
 *   - 扫描轮数有上限，超了如实标 partial 并给出总数；
 *   - 失败的 create_session、重复 sid 不污染结果。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round } from '@zooique/memora';
import {
  rebuildWorkbenchChildren,
  WORKBENCH_REBUILD_MAX_ROUNDS,
  type WorkbenchHistorySources,
} from '../helpers/workbenchHistory.js';

/** 构造 tool_start 事件 */
function start(toolCallId: string, name: string, args: string): ProcessEvent {
  return { type: 'tool_start', payload: { toolCallId, name, args } } as unknown as ProcessEvent;
}

/** 构造 tool_result 事件 */
function result(toolCallId: string, name: string, ok: boolean, summary: string): ProcessEvent {
  return {
    type: 'tool_result',
    payload: { toolCallId, name, ok, summary },
  } as unknown as ProcessEvent;
}

/** 构造一轮（只填重建会读的字段） */
function round(id: string, events: ProcessEvent[]): Round {
  return { id, status: 'complete', processEvents: events } as Round;
}

/** 一次 create_session 成功调用的标准事件对（结果摘要按内核 100 字符截断形态给） */
function createSessionEvents(sid: string, title: string, callId = 'call-1'): ProcessEvent[] {
  return [
    start(callId, 'create_session', JSON.stringify({ title })),
    result(
      callId,
      'create_session',
      true,
      `{\n  "ok": true,\n  "sid": "${sid}",\n  "title": "${title}"\n}`,
    ),
  ];
}

/** 构造读口（默认一轮） */
function sources(rounds: Round[], roundIds?: string[]): WorkbenchHistorySources {
  const byId = new Map(rounds.map((r) => [r.id, r]));
  return {
    readRoundIds: () => roundIds ?? rounds.map((r) => r.id),
    readRound: (id) => byId.get(id),
  };
}

describe('rebuildWorkbenchChildren', () => {
  it('新进程：从历史恢复 sid 与创建标题', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([round('r1', createSessionEvents('2026-11-14-session-abc', '整理周报'))]),
    );
    expect(rebuilt.children).toEqual([{ sessionId: '2026-11-14-session-abc', title: '整理周报' }]);
    expect(rebuilt.coverage).toBe('complete');
    expect(rebuilt.totalRounds).toBe(1);
  });

  it('历史读不出来（读轮列表抛错）⇒ unreadable，不返回「完整空清单」', () => {
    const rebuilt = rebuildWorkbenchChildren('session-agent', {
      readRoundIds: () => {
        throw new Error('disk error');
      },
      readRound: () => undefined,
    });
    expect(rebuilt.children).toEqual([]);
    expect(rebuilt.coverage).toBe('unreadable');
  });

  it('成功调用但解析不出 sid ⇒ 计入读不到并标 partial', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', '{"title":"无 sid"}'),
          // 摘要里没有 sid（例如旧版本 / 异常结果）
          result('call-1', 'create_session', true, '{"ok":true}'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([]);
    expect(rebuilt.unreadableRecords).toBe(1);
    expect(rebuilt.coverage).toBe('partial');
  });

  it('轮读不到 ⇒ 计入读不到（不能当成「这一轮没有」）', () => {
    const rebuilt = rebuildWorkbenchChildren('session-agent', {
      readRoundIds: () => ['r1', 'r2'],
      readRound: (id) => (id === 'r1' ? round('r1', []) : undefined),
    });
    expect(rebuilt.unreadableRecords).toBe(1);
    expect(rebuilt.coverage).toBe('partial');
  });

  it(`超过 ${WORKBENCH_REBUILD_MAX_ROUNDS} 轮 ⇒ 只扫最近 N 轮并如实标 partial`, () => {
    const rounds: Round[] = [];
    // 最早的轮里有一次创建；后面的轮都是空轮（总数超上限）
    rounds.push(round('r0', createSessionEvents('session-old', '旧任务')));
    for (let i = 1; i <= WORKBENCH_REBUILD_MAX_ROUNDS; i += 1) {
      rounds.push(round(`r${i}`, []));
    }
    const rebuilt = rebuildWorkbenchChildren('session-agent', sources(rounds));
    expect(rebuilt.totalRounds).toBe(WORKBENCH_REBUILD_MAX_ROUNDS + 1);
    expect(rebuilt.scannedRounds).toBe(WORKBENCH_REBUILD_MAX_ROUNDS);
    expect(rebuilt.coverage).toBe('partial');
    // 创建记录在未扫描的最早轮里：不得假装「没有」
    expect(rebuilt.children).toEqual([]);
  });

  it('失败的 create_session 不算创建；重复 sid 只保留一条', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', '{"title":"失败"}'),
          result('call-1', 'create_session', false, '{"ok":false}'),
          ...createSessionEvents('session-dup', '第一次', 'call-2'),
          ...createSessionEvents('session-dup', '第二次', 'call-3'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([{ sessionId: 'session-dup', title: '第一次' }]);
    expect(rebuilt.coverage).toBe('complete');
  });

  it('args 无法解析时仍靠摘要拿到 sid（标题留给元数据兜底）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', 'not-json'),
          result('call-1', 'create_session', true, '{"ok":true,"sid":"session-x"}'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([{ sessionId: 'session-x', title: undefined }]);
    expect(rebuilt.coverage).toBe('complete');
  });
});
