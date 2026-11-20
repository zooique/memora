/**
 * 重放投影的派发方展示名（DISPATCH-ORIGIN-VISIBLE-1）
 *
 * 覆盖判据：`RoundView.dispatchedByName` 只能由 `Round.dispatchedBy.from` → 会话存储现查得到；
 * 来源会话已删（读不到 meta）时必须缺省，绝不由 webview 侧编造名字。
 */
import { describe, expect, it } from 'vitest';
import type { WorkspaceSessionViewLoader } from '../../../extension/host/sessionViewLoader.js';
import type { HostSessionStore } from '../../../extension/host/sessionStore.js';
import { loadRoundBasedHistory } from '../historyLoad.js';

/** 造一条内核 Round 形状（只填本模块消费到的字段，其余按未知吞掉） */
function makeRound(dispatchedBy?: { from: string; via: 'delegate' | 'create' }): unknown {
  return {
    id: 'round-1',
    userMessage: {
      id: 'msg-1',
      role: 'user',
      content: '派给我的活',
      timestamp: '2026-11-17T09:00:00.000Z',
      name: 'Memora',
    },
    status: 'complete',
    createdAt: '2026-11-17T09:00:00.000Z',
    origin: 'hosted',
    ...(dispatchedBy ? { dispatchedBy } : {}),
  };
}

/** 最小装配：viewLoader 只回一轮；store 提供 roundIds（空会话守卫）与按 id 查展示名 */
function load(
  dispatchedBy: { from: string; via: 'delegate' | 'create' } | undefined,
  names: Record<string, string> = {},
) {
  const viewLoader = {
    loadView: () => ({ rounds: [makeRound(dispatchedBy)] }),
  } as unknown as WorkspaceSessionViewLoader;
  const store = {
    getRoundIds: () => ['round-1'],
    // 语义对齐生产 getSessionMeta：存在才返回对象（且 displayName 已含标题兜底）；不存在 = undefined
    getSessionMeta: (sessionId: string) =>
      names[sessionId] ? { sessionId, displayName: names[sessionId] } : undefined,
  } as unknown as HostSessionStore;
  return loadRoundBasedHistory(viewLoader, store, '2026-11-17-worker')[0];
}

describe('loadRoundBasedHistory · dispatchedByName', () => {
  it('派发轮：按 dispatchedBy.from 现查展示名并投影到 RoundView', () => {
    const round = load(
      { from: '2026-11-17-assistant', via: 'delegate' },
      {
        '2026-11-17-assistant': '统计目录文件数',
      },
    );
    expect(round?.dispatchedByName).toBe('统计目录文件数');
  });

  it('来源会话已删（读不到 meta）⇒ 字段缺省，不编造标题', () => {
    const round = load({ from: '2026-11-17-gone', via: 'delegate' }, {});
    expect(round?.dispatchedByName).toBeUndefined();
  });

  it('非派发轮 ⇒ 不产出字段（不查会话存储）', () => {
    let queried = false;
    const viewLoader = {
      loadView: () => ({ rounds: [makeRound(undefined)] }),
    } as unknown as WorkspaceSessionViewLoader;
    const store = {
      getRoundIds: () => ['round-1'],
      getSessionMeta: () => {
        queried = true;
        return undefined;
      },
    } as unknown as HostSessionStore;
    const round = loadRoundBasedHistory(viewLoader, store, '2026-11-17-worker')[0];
    expect(queried).toBe(false);
    expect(round?.dispatchedByName).toBeUndefined();
  });
});
