/**
 * sessionActivity 快照的 titleById 投影判据（DISPATCH-SESSION-CARD-1）
 *
 * 派活会话卡要在 webview 显示「派给哪个会话」，而 webview 侧无 SessionMeta 读口，
 * 标题只能由宿主随 session_activity 快照投影下发。本测试钉住这条投影的真源口径：
 *   - 只收遍历面内会话（与 runningIds/pendingIds 同一份 id 并集，不额外扫盘）；
 *   - id 去重（多个来源的并集不给同一个会话算两次）；
 *   - 标题走注入的 titleFor（真源 = sessionTitleFor），改名后随下次快照重算；
 *   - 排除项（助手会话）不外泄——它不在工作会话列表里，卡片不该指向它。
 *
 * 变异靶标：
 *   - 把 titleById 收集删掉 / 改成只收 runningIds ⇒ 收录面用例红；
 *   - 收集时用原 sessionIds（未去重）⇒ 去重用例的红在「titleFor 调用次数」；
 *   - 用固定标题而非 titleFor ⇒ 改名用例红。
 */
import { describe, it, expect, vi } from 'vitest';
import { pushPanelSessionActivity } from '../sessionActivity.js';

const TITLES: Record<string, string> = {
  s1: '统计目录文件数',
  s2: '空白页草稿',
  s3: '登录链路调查',
  assistant: 'memora助手',
};

function push(
  overrides: {
    agentSessionIds?: string[];
    askSessionIds?: string[];
    excludeSessionIds?: (string | undefined)[];
    titleFor?: (sid: string) => string;
    post?: (s: unknown) => void;
  } = {},
) {
  let captured: unknown;
  pushPanelSessionActivity({
    currentSessionId: 's1',
    agentSessionIds: overrides.agentSessionIds ?? ['s1', 's2'],
    askSessionIds: overrides.askSessionIds ?? [],
    excludeSessionIds: overrides.excludeSessionIds,
    isStreaming: (id) => id === 's1',
    isWaiting: () => false,
    titleFor: overrides.titleFor ?? ((id) => TITLES[id] ?? id),
    dispatchedSessions: [],
    lastSerialized: undefined,
    force: true,
    post: (snapshot) => {
      captured = snapshot;
      overrides.post?.(snapshot);
    },
  });
  return captured as {
    runningIds: string[];
    pendingIds: string[];
    badgeCount: number;
    titleById: Record<string, string>;
  };
}

describe('sessionActivity titleById 投影（派活会话卡名字真源）', () => {
  it('只收遍历面内会话的展示名，标题走注入的 titleFor', () => {
    const snap = push({ agentSessionIds: ['s1', 's2'], askSessionIds: ['s3'] });
    expect(snap.titleById).toEqual({
      s1: '统计目录文件数',
      s2: '空白页草稿',
      s3: '登录链路调查',
    });
  });

  it('多来源重复 id 只算一次（titleFor 每个会话调用一次）', () => {
    const titleFor = vi.fn((id: string) => TITLES[id] ?? id);
    // s1 同时出现在 current / agent / ask 三处
    push({ agentSessionIds: ['s1', 's1', 's2'], askSessionIds: ['s1'], titleFor });
    expect(titleFor.mock.calls.map(([id]) => id)).toEqual(['s1', 's2']);
  });

  it('排除项（助手会话）不进快照，卡片不会指向它', () => {
    const snap = push({
      agentSessionIds: ['s1', 'assistant'],
      excludeSessionIds: ['assistant'],
    });
    expect(snap.titleById).not.toHaveProperty('assistant');
  });

  it('改名后 titleFor 返回新值 ⇒ 新快照带新标题（不缓存旧名）', () => {
    const first = push();
    const second = push({
      titleFor: (id) => (id === 's2' ? '空白页草稿·已改名' : (TITLES[id] ?? id)),
    });
    expect(first.titleById.s2).toBe('空白页草稿');
    expect(second.titleById.s2).toBe('空白页草稿·已改名');
  });
});
