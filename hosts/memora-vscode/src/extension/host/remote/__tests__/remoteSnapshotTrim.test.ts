/**
 * remoteSnapshotTrim 单测 —— 钉住 §6.4 `TrimmedRound` 的三条差异
 *
 * 判据来源：docs/方案-手机远程控制-20261110.md §6.4
 *   ① `attachmentUris` 一律不下发；② 过程事件 / 前序回答只留最近 N；
 *   ③ 裁剪发生时才带 `truncated` 计数。
 */
import { describe, expect, it } from 'vitest';
import type { RoundView } from '../../../../shared/protocol.js';
import { TRIMMED_RECENT_EVENTS, TRIMMED_RECENT_LOG, trimRound } from '../remoteSnapshotTrim.js';

/**
 * 造一个带附件 URL 的轮（字段用 `as unknown as` 补齐，本测只关心被裁的三处）
 *
 * @param eventCount 过程事件条数
 * @param logCount   前序回答段数
 */
function makeRound(eventCount: number, logCount: number): RoundView {
  return {
    id: 'r1',
    userMessage: { id: 'm1', role: 'user', content: '问题', timestamp: 't1' },
    assistantMessage: { id: 'm2', role: 'assistant', content: '回答', timestamp: 't2' },
    status: 'complete',
    createdAt: 't1',
    completedAt: 't2',
    attachmentUris: { abc: 'vscode-webview://abc.png' },
    processEvents: Array.from({ length: eventCount }, (_, i) => ({ type: `e${i}` })),
    assistantLog: Array.from({ length: logCount }, (_, i) => ({
      id: `a${i}`,
      role: 'assistant',
      content: `段${i}`,
      timestamp: `t${i}`,
    })),
  } as unknown as RoundView;
}

describe('remoteSnapshotTrim — TrimmedRound', () => {
  it('attachmentUris 整键删除（连键名都不出现）', () => {
    const trimmed = trimRound(makeRound(1, 1));
    expect('attachmentUris' in trimmed).toBe(false);
  });

  it('未超限：过程事件与前序回答原样保留，且不带 truncated', () => {
    const round = makeRound(2, 1);
    const trimmed = trimRound(round);
    expect(trimmed.processEvents).toEqual(round.processEvents);
    expect(trimmed.assistantLog).toEqual(round.assistantLog);
    expect('truncated' in trimmed).toBe(false);
  });

  it('超限：只留尾部 N 条，计数如实进 truncated', () => {
    const eventCount = TRIMMED_RECENT_EVENTS + 7;
    const logCount = TRIMMED_RECENT_LOG + 3;
    const round = makeRound(eventCount, logCount);
    const trimmed = trimRound(round);
    expect(trimmed.processEvents).toHaveLength(TRIMMED_RECENT_EVENTS);
    // 留的是尾部：最后一条必须与原文最后一条相同
    expect(trimmed.processEvents?.at(-1)).toEqual(round.processEvents?.at(-1));
    expect(trimmed.assistantLog).toHaveLength(TRIMMED_RECENT_LOG);
    expect(trimmed.truncated).toEqual({ processEvents: 7, assistantLog: 3 });
  });

  it('空数组保持空数组（纯问答轮的 processEvents: [] 是有效形状，不丢弃）', () => {
    const trimmed = trimRound(makeRound(0, 0));
    expect(trimmed.processEvents).toEqual([]);
    expect(trimmed.assistantLog).toEqual([]);
    expect('truncated' in trimmed).toBe(false);
  });

  it('§6.8 能力关闭：processEvents 整键删除，truncated 只记日志裁剪', () => {
    const round = makeRound(TRIMMED_RECENT_EVENTS + 5, TRIMMED_RECENT_LOG + 2);
    const trimmed = trimRound(round, false);
    expect('processEvents' in trimmed).toBe(false);
    expect(trimmed.assistantLog).toHaveLength(TRIMMED_RECENT_LOG);
    expect(trimmed.truncated).toEqual({ processEvents: 0, assistantLog: 2 });
    expect(round.processEvents).toHaveLength(TRIMMED_RECENT_EVENTS + 5);
  });

  it('不修改入参（宿主投影可能仍被 webview 侧使用）', () => {
    const round = makeRound(TRIMMED_RECENT_EVENTS + 1, 1);
    const before = round.processEvents?.length;
    trimRound(round);
    expect(round.processEvents?.length).toBe(before);
    expect(round.attachmentUris).toBeDefined();
  });
});
