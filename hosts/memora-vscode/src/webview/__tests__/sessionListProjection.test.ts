/**
 * session_list_data 投影守卫（HOSTED-LIST-GROUP-1）
 *
 * 钉住的判据：列表是**全量**，排除项只有「当前会话」与「助手窗那一条」（持久指针）。
 * `origin='hosted'` 是助手派发创建的工作会话，必须原样下发，由 webview 前端分组；
 * 宿主如果在这里按来源过滤，就会把「哪条会话可见」写成两份口径（DTO 注释 vs 实现）。
 *
 * 变异靶标：把 filter 加回 `m.origin !== 'hosted'` ⇒ 第一条用例红；
 * 把 assistantSessionId 排除删掉 ⇒ 同一条用例红（排除项少一个）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { SessionMeta } from '@zooique/memora';

vi.mock('vscode', () => ({ l10n: { t: (message: string) => message } }));

import { buildSessionListMessage } from '../helpers/sessionList.js';

const L10N = { t: (message: string) => message } as never;

/** 只填投影会读的字段（不做假元数据工厂，避免替身比被测面还大） */
function meta(sessionId: string, origin?: SessionMeta['origin']): SessionMeta {
  return {
    sessionId,
    origin,
    updatedAt: '2026-11-17T10:00:00.000Z',
    messageCount: 0,
  } as SessionMeta;
}

function fakeStore(metas: SessionMeta[], archivedIds: string[] = []) {
  return {
    listSessionMetas: () => metas,
    listArchivedIds: () => archivedIds,
    getSessionMeta: (id: string) => metas.find((m) => m.sessionId === id),
    getRoundIds: () => [] as string[],
  } as never;
}

describe('session_list_data 来源投影（HOSTED-LIST-GROUP-1）', () => {
  it('hosted 工作会话进列表；只排当前会话与助手窗那一条', () => {
    const metas = [
      meta('2026-11-17-current', 'user'),
      meta('2026-11-17-assistant', 'user'),
      meta('2026-11-17-hosted', 'hosted'),
      meta('2026-11-17-user', 'user'),
    ];
    const msg = buildSessionListMessage(
      fakeStore(metas),
      '2026-11-17-current',
      L10N,
      undefined,
      '2026-11-17-assistant',
    );
    expect(msg.sessions.map((s) => s.sessionId)).toEqual([
      '2026-11-17-hosted',
      '2026-11-17-user',
    ]);
    expect(msg.sessions[0].origin).toBe('hosted');
    expect(msg.sessions[1].origin).toBe('user');
  });

  it('旧数据没有 origin 键时原样下发，不补写成 user（真源是 meta）', () => {
    const msg = buildSessionListMessage(fakeStore([meta('2026-11-17-old')]), '', L10N);
    expect(msg.sessions).toHaveLength(1);
    expect(msg.sessions[0].origin).toBeUndefined(); // 不补写成 'user'（真源是 meta）
  });
});
