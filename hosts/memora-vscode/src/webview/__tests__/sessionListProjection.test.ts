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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * 文档镜像守卫（HOSTED-LIST-GROUP-1 存量口径订正）：台账 1228 行声称托管模式
 * 文档 §4「两类会话都不进列表」已订正，曾实测 §四.1 仍留「工作会话…不进侧栏列表」
 * 的僵尸句（台账说改了、文档没改 = 自证无落点）。守卫让这条声明必须有落点。
 *
 * 判据用「不进侧栏列表」整文档零命中：助手窗那条的合法句写的是「不在侧栏列表里」
 * （含「不在」不含「不进」），不会被误伤；派活会话两处正向锚必须在。
 */
describe('托管模式文档 · 侧栏列表口径与代码一致', () => {
  function loadDoc(): string {
    // 从测试文件定位仓库根，与 cwd 无关（兼容 cd 宿主 / 从根 --root 两种入口）
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(resolve(here, '../../../../../docs/白话设计文档-托管模式.md'), 'utf8');
  }

  it('§四.1 不再有「工作会话不进侧栏列表」的僵尸句', () => {
    expect(loadDoc()).not.toContain('不进侧栏列表');
  });

  it('派活的工作会话进「助手建的」组、助手窗那条不进——两处正向锚都在', () => {
    const doc = loadDoc();
    expect(doc).toContain('派活创建的工作会话在侧栏');
    expect(doc).toContain('助手会话**不在侧栏列表里**');
  });
});
