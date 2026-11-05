/**
 * 6.0.0 收尾验收：彻底消掉 `_global.json`（归档标记 / 上次停留都落到会话自己的文件）
 *
 * 四条机判：
 *   ① 归档状态迁移后逐项不变：旧 `_global.json.archivedIds` 里的会话仍是归档态，
 *      不在其中的仍是非归档态；旧 `lastActiveSessionId` 迁移后仍是启动默认落点
 *   ② 摊了 1/3 就中断：已有 1 个会话已打标 + `_global.json` 仍在 ⇒ 再次启动归档状态仍正确
 *   ③ 两个进程分别归档两个不同会话各 20 次：零丢失（归档不再有共享写点）
 *   ④ `listSessions()` 分组行为与改动前一致（回归：归档不改变可见性，只改变分组标记）
 *
 * 判据口径：
 *   - 归档态真源 = 各会话文件的 `archived` 字段（`isArchived` / `listArchivedIds` 内存镜像）
 *   - `listSessions()` = metas ∪ roundIdsStore 并集，**不按归档标记过滤**（与改动前一致）
 */
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 宿主根（本文件位于 src/extension/host/__tests__ 下） */
const HOST_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/** 仓库根（宿主包在 hosts/memora-vscode，再上两级） */
const REPO_ROOT = join(HOST_ROOT, '..', '..');
/** tsx CLI（直跑 TS 源，免预编译） */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** 双进程归档的子进程入口 */
const CHILD_FIXTURE = join(import.meta.dirname, 'fixtures', 'archiveChild.ts');

/** `.memora` 数据目录 */
function memoraDir(ws: string): string {
  return join(ws, '.memora');
}

/** 会话目录 */
function sessionsDir(ws: string): string {
  return join(memoraDir(ws), 'sessions');
}

/** 单会话文件路径（与实现同口径：encodeURIComponent(sessionId)） */
function sessionFile(ws: string, sessionId: string): string {
  return join(sessionsDir(ws), `${encodeURIComponent(sessionId)}.json`);
}

/** step 2 过渡期全局态文件路径（迁移源） */
function legacyGlobalFile(ws: string): string {
  return join(sessionsDir(ws), '_global.json');
}

/** 全局态迁移完成后的保留名 */
function migratedGlobalFile(ws: string): string {
  return join(sessionsDir(ws), '_global.json.migrated');
}

/** 写一个「step 2 形态」会话文件（无归档 / 无停留字段） */
function writeSessionFile(
  ws: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(sessionsDir(ws), { recursive: true });
  writeFileSync(
    sessionFile(ws, sessionId),
    JSON.stringify(
      {
        sessionId,
        meta: { sessionId, updatedAt: '2026-08-01T10:00:00.000Z', messageCount: 2 },
        roundIds: [`${sessionId}-r1`],
        ...extra,
      },
      null,
      2,
    ),
    'utf8',
  );
}

/** 读会话文件的 JSON */
function readSession(ws: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(sessionFile(ws, sessionId), 'utf8')) as Record<string, unknown>;
}

/** 新建实例并 load（模拟重启：只走磁盘） */
function reopen(ws: string): WorkspaceSessionStore {
  const store = new WorkspaceSessionStore(ws);
  store.load();
  return store;
}

/** 起子进程对自己的会话做 20 次归档翻转，返回完成 Promise */
function runChildArchiver(
  ws: string,
  sessionId: string,
  count: number,
): { done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(process.execPath, [TSX_CLI, CHILD_FIXTURE, ws, sessionId, String(count)], {
    cwd: HOST_ROOT,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => {
    stderr += d.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { done };
}

describe('6.0.0 收尾验收：消掉 _global.json', () => {
  /** 每个用例独立临时工作区 */
  let ws: string;

  beforeEach(() => {
    ws = makeTempDir('memora-global-removal-');
    mkdirSync(memoraDir(ws), { recursive: true });
  });

  it('① 旧 _global.json 的归档状态迁移后逐项不变', () => {
    // step 2 形态：三个会话文件 + 一份全局态（B 归档、A 是上次停留）
    writeSessionFile(ws, '2026-08-01-a');
    writeSessionFile(ws, '2026-08-02-b');
    writeSessionFile(ws, '2026-08-03-c');
    writeFileSync(
      legacyGlobalFile(ws),
      JSON.stringify({
        schemaVersion: 2,
        lastActiveSessionId: '2026-08-01-a',
        archivedIds: ['2026-08-02-b'],
      }),
      'utf8',
    );

    const store = reopen(ws);

    // 归档态逐项不变：B 归档、A/C 非归档
    expect(store.isArchived('2026-08-02-b')).toBe(true);
    expect(store.isArchived('2026-08-01-a')).toBe(false);
    expect(store.isArchived('2026-08-03-c')).toBe(false);
    expect(store.listArchivedIds()).toEqual(['2026-08-02-b']);
    // 停留指针迁移后仍是启动默认落点
    expect(store.getInitialSessionId()).toBe('2026-08-01-a');
    // 落盘：标记写进会话自己的文件；全局文件已退役
    expect(readSession(ws, '2026-08-02-b').archived).toBe(true);
    expect(typeof readSession(ws, '2026-08-01-a').lastActiveAt).toBe('string');
    expect(existsSync(legacyGlobalFile(ws))).toBe(false);
    expect(existsSync(migratedGlobalFile(ws))).toBe(true);
  });

  it('② 摊了 1/3 就中断 ⇒ 再次启动归档状态仍正确', () => {
    // 三会话；全局态 = A/B 归档、C 是上次停留。
    // 模拟「第一次启动已摊完 A 就崩」：A 的会话文件已带 archived，_global.json 仍在
    writeSessionFile(ws, '2026-08-01-a', { archived: true });
    writeSessionFile(ws, '2026-08-02-b');
    writeSessionFile(ws, '2026-08-03-c');
    writeFileSync(
      legacyGlobalFile(ws),
      JSON.stringify({
        schemaVersion: 2,
        lastActiveSessionId: '2026-08-03-c',
        archivedIds: ['2026-08-01-a', '2026-08-02-b'],
      }),
      'utf8',
    );

    const resumed = reopen(ws);

    // 续摊补齐：A（已摊）、B（本次补摊）归档；C 保持非归档
    expect(resumed.isArchived('2026-08-01-a')).toBe(true);
    expect(resumed.isArchived('2026-08-02-b')).toBe(true);
    expect(resumed.isArchived('2026-08-03-c')).toBe(false);
    // 中断前的已摊内容不被覆盖（A 只有 archived，没有被动写别的字段）
    expect(readSession(ws, '2026-08-01-a').archived).toBe(true);
    expect(readSession(ws, '2026-08-01-a').lastActiveAt).toBeUndefined();
    // 停留指针本次补摊到 C
    expect(resumed.getInitialSessionId()).toBe('2026-08-03-c');
    expect(typeof readSession(ws, '2026-08-03-c').lastActiveAt).toBe('string');
    // 全部补齐后才落幕
    expect(existsSync(legacyGlobalFile(ws))).toBe(false);
    expect(existsSync(migratedGlobalFile(ws))).toBe(true);
  });

  it('③ 两进程分别归档两个不同会话各 20 次，零丢失', async () => {
    const store = new WorkspaceSessionStore(ws);
    store.load();
    const parentSession = '2026-11-05-parent';
    const childSession = '2026-11-05-child';
    store.createSession({
      sessionId: parentSession,
      updatedAt: new Date().toISOString(),
      messageCount: 0,
    });

    // 子进程归档自己的会话；父进程同时归档另一个会话（两文件互不触碰）
    const child = runChildArchiver(ws, childSession, 20);
    for (let i = 0; i < 20; i += 1) {
      if (i % 2 === 0) {
        store.unarchiveSession(parentSession);
      } else {
        store.archiveSession(parentSession);
      }
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    const result = await child.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('DONE');

    // 重启后两个会话各自的归档态都在（旧全局文件布局下后写者会覆盖前者）
    const reloaded = reopen(ws);
    expect(reloaded.isArchived(parentSession)).toBe(true);
    expect(reloaded.isArchived(childSession)).toBe(true);
    expect(new Set(reloaded.listArchivedIds())).toEqual(new Set([parentSession, childSession]));
    // 每个文件只承载自己的标记（跨会话零污染）
    expect(readSession(ws, parentSession).archived).toBe(true);
    expect(readSession(ws, childSession).archived).toBe(true);
  }, 120_000);

  it('④ listSessions() 分组行为与改动前一致（归档只改分组，不改可见性）', () => {
    writeSessionFile(ws, '2026-08-01-a');
    writeSessionFile(ws, '2026-08-02-b');
    writeSessionFile(ws, '2026-08-03-c');
    const store = reopen(ws);

    // 归档前：三个会话全部可见，无归档标记
    expect(new Set(store.listSessions())).toEqual(
      new Set(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']),
    );
    expect(store.listArchivedIds()).toEqual([]);

    // 归档 B：可见性不变（仍三个），只是多了一个分组标记
    store.archiveSession('2026-08-02-b');
    expect(new Set(store.listSessions())).toEqual(
      new Set(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']),
    );
    expect(store.listArchivedIds()).toEqual(['2026-08-02-b']);

    // 取消归档：标记消失，可见性依旧
    store.unarchiveSession('2026-08-02-b');
    expect(store.listArchivedIds()).toEqual([]);
    expect(new Set(store.listSessions())).toEqual(
      new Set(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']),
    );

    // 删除归档会话：从可见列表与归档集合一并摘除（清理点仍是 deleteSession）
    expect(store.archiveSession('2026-08-03-c')).toBe(true);
    store.deleteSession('2026-08-03-c');
    expect(new Set(store.listSessions())).toEqual(new Set(['2026-08-01-a', '2026-08-02-b']));
    expect(store.listArchivedIds()).toEqual([]);
    expect(existsSync(sessionFile(ws, '2026-08-03-c'))).toBe(false);
  });
});
