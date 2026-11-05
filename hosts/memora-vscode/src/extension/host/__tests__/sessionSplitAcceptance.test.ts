/**
 * 6.0.0 步 2 验收：会话清单拆成「每会话一文件」（`sessions/<sessionId>.json` + `_global.json`）
 *
 * 四条机判（对应排产表验收项，任一红即本步未落地）：
 *   ① 同进程 20 轮「新建 / 删除 / 截断」噪声下，既有会话 roundIds 零丢失（含磁盘往返）
 *   ② 两进程分别写**不同**会话 20 次，互不覆盖、零丢失（旧的整份 sessions.json 会互相覆盖）
 *   ③ 旧单文件迁移后：会话数、每会话 roundIds、全局态字段逐项与旧档相等；旧档改名 .migrated
 *   ④ 模拟「摊了 1/3 就中断」：已有 1 个会话文件 + 旧档仍在 ⇒ 再次启动三个会话全部可见，
 *      且已摊会话不被覆盖（内容以每会话文件为准）
 *
 * 判据口径：
 *   - 会话可见性 = `listSessions()`（metas ∪ roundIdsStore 的并集）
 *   - 引用真源 = 会话 roundIds（断言逐项相等，不看顺序以外的东西）
 *   - 扫目录排除 `_global.json` 与 `.tmp`，并以文件内 sessionId 为准（不靠文件名反解）
 */
// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync，见 helpers/tmpDir.ts）
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';

/** 宿主根（本文件位于 src/extension/host/__tests__ 下） */
const HOST_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/** 仓库根（宿主包在 hosts/memora-vscode，再上两级） */
const REPO_ROOT = join(HOST_ROOT, '..', '..');
/** tsx CLI（直跑 TS 源，免预编译） */
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** 双进程写会话的子进程入口 */
const CHILD_FIXTURE = join(import.meta.dirname, 'fixtures', 'sessionChild.ts');

/** 等待指定毫秒（让父子两个进程的写入在时间上交错） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `.memora` 数据目录（落盘布局的单点推导在 sessionStore 内部，测试只做定位断言） */
function memoraDir(ws: string): string {
  return join(ws, '.memora');
}

/** 单会话文件路径（文件名 = encodeURIComponent(sessionId)，与实现同口径） */
function sessionFile(ws: string, sessionId: string): string {
  return join(memoraDir(ws), 'sessions', `${encodeURIComponent(sessionId)}.json`);
}

/** 旧单文件路径（迁移源） */
function legacyFile(ws: string): string {
  return join(memoraDir(ws), 'sessions.json');
}

/** 旧单文件迁移后的保留名 */
function migratedFile(ws: string): string {
  return join(memoraDir(ws), 'sessions.json.migrated');
}

/** 起子进程向指定会话追加 count 个 roundId，返回完成 Promise */
function runChildWriter(
  ws: string,
  sessionId: string,
  prefix: string,
  count: number,
): {
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const child = spawn(
    process.execPath,
    [TSX_CLI, CHILD_FIXTURE, ws, sessionId, prefix, String(count)],
    {
      cwd: HOST_ROOT,
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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

/** 新建实例并 load（模拟重启：只走磁盘，不共享内存状态） */
function reopen(ws: string): WorkspaceSessionStore {
  const store = new WorkspaceSessionStore(ws);
  store.load();
  return store;
}

describe('6.0.0 步 2 验收：会话清单拆文件', () => {
  /** 每个用例独立临时工作区（避免落盘文件互相污染） */
  let ws: string;

  beforeEach(() => {
    ws = makeTempDir('memora-session-split-');
    mkdirSync(memoraDir(ws), { recursive: true });
  });

  it('① 同进程 20 轮「新建/删除/截断」噪声下，既有会话 roundIds 零丢失（含磁盘往返）', () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    const store = new WorkspaceSessionStore(ws, roundStore);
    store.load();

    // 两个需要保住的稳定会话
    const alpha = '2026-11-05-alpha';
    const beta = '2026-11-05-beta';

    for (let i = 0; i < 20; i += 1) {
      // 噪声 1：每轮都追加到两个稳定会话（验证写入只影响自己）
      store.appendRoundId(alpha, `a-${i}`);
      store.appendRoundId(beta, `b-${i}`);
      // 噪声 2：新建临时会话再删除（验证删除不连坐其他会话）
      const tmpSession = `2026-11-05-tmp${i}`;
      store.appendRoundId(tmpSession, `t-${i}`);
      store.deleteSession(tmpSession);
      // 噪声 3：scratch 会话追加后立刻截断（验证截断只收缩自己）
      const scratch = '2026-11-05-scratch';
      store.appendRoundId(scratch, `s-${i}`);
      store.truncateFrom('2026-11-05', 'scratch', `s-${i}`);
    }

    const expected = Array.from({ length: 20 }, (_, i) => i);
    expect(store.getRoundIds(alpha)).toEqual(expected.map((i) => `a-${i}`));
    expect(store.getRoundIds(beta)).toEqual(expected.map((i) => `b-${i}`));
    // 临时会话与 scratch 已被清掉（delete / truncate 的既有语义不变）
    expect(store.listSessions()).not.toContain('2026-11-05-tmp19');
    expect(store.getRoundIds('2026-11-05-scratch')).toEqual([]);

    // 磁盘往返（模拟重启）：零丢失判据落盘也成立
    const reloaded = reopen(ws);
    expect(reloaded.getRoundIds(alpha)).toEqual(expected.map((i) => `a-${i}`));
    expect(reloaded.getRoundIds(beta)).toEqual(expected.map((i) => `b-${i}`));
  });

  it('② 两进程分别写不同会话 20 次，互不覆盖、零丢失', async () => {
    const roundStore = new WorkspaceRoundStore(ws);
    roundStore.load();
    const store = new WorkspaceSessionStore(ws, roundStore);
    store.load();

    const parentSession = '2026-11-05-parent';
    const childSession = '2026-11-05-child';

    // 子进程写自己的会话，父进程同时写另一个会话（sleep 让写链路交错）
    const child = runChildWriter(ws, childSession, 'c', 20);
    for (let i = 0; i < 20; i += 1) {
      store.appendRoundId(parentSession, `p-${i}`);
      await sleep(8);
    }
    const result = await child.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('DONE');

    // 两个会话各自 20 条，顺序完整（旧整份文件布局下后写者会覆盖前者）
    const expected = Array.from({ length: 20 }, (_, i) => i);
    const reloaded = reopen(ws);
    expect(reloaded.getRoundIds(parentSession)).toEqual(expected.map((i) => `p-${i}`));
    expect(reloaded.getRoundIds(childSession)).toEqual(expected.map((i) => `c-${i}`));

    // 单文件内只有自己的 roundId（跨会话零污染的最小证据）
    const childRaw = readFileSync(sessionFile(ws, childSession), 'utf8');
    expect(childRaw).toContain('c-0');
    expect(childRaw).not.toContain('p-0');
  }, 120_000);

  it('③ 旧单文件迁移：会话数 / 每会话 roundIds / 全局态逐项相等，旧档改名 .migrated', () => {
    // 旧版单文件形态（meta + roundIdsStore + 两个全局字段全在一份里）
    const legacy = {
      metas: {
        '2026-08-01-a': {
          sessionId: '2026-08-01-a',
          displayName: '会话 A',
          updatedAt: '2026-08-01T10:00:00.000Z',
          messageCount: 4,
        },
        '2026-08-02-b': {
          sessionId: '2026-08-02-b',
          updatedAt: '2026-08-02T10:00:00.000Z',
          messageCount: 2,
        },
        '2026-08-03-c': {
          sessionId: '2026-08-03-c',
          updatedAt: '2026-08-03T10:00:00.000Z',
          messageCount: 2,
        },
      },
      roundIdsStore: {
        '2026-08-01-a': ['r-a1', 'r-a2'],
        '2026-08-02-b': ['r-b1'],
        '2026-08-03-c': ['r-c1'],
      },
      archivedIds: ['2026-08-02-b'],
      lastActiveSessionId: '2026-08-01-a',
    };
    writeFileSync(legacyFile(ws), JSON.stringify(legacy, null, 2), 'utf8');

    const store = reopen(ws);

    // 会话数 + 可见性
    expect(new Set(store.listSessions())).toEqual(
      new Set(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']),
    );
    // 每会话 roundIds 逐项相等（引用真源随会话文件走）
    expect(store.getRoundIds('2026-08-01-a')).toEqual(['r-a1', 'r-a2']);
    expect(store.getRoundIds('2026-08-02-b')).toEqual(['r-b1']);
    expect(store.getRoundIds('2026-08-03-c')).toEqual(['r-c1']);
    // 全局态两字段逐项相等（非数据路径，但迁移不能丢）
    expect(store.listArchivedIds()).toEqual(['2026-08-02-b']);
    expect(store.getInitialSessionId()).toBe('2026-08-01-a');

    // 落盘形态：三个会话文件都在；旧档已改名保留；全局态文件已写出
    for (const id of ['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']) {
      expect(existsSync(sessionFile(ws, id))).toBe(true);
    }
    expect(existsSync(legacyFile(ws))).toBe(false);
    expect(existsSync(migratedFile(ws))).toBe(true);
    const globalRaw = JSON.parse(
      readFileSync(join(memoraDir(ws), 'sessions', '_global.json'), 'utf8'),
    ) as { lastActiveSessionId: string; archivedIds: string[] };
    expect(globalRaw.lastActiveSessionId).toBe('2026-08-01-a');
    expect(globalRaw.archivedIds).toEqual(['2026-08-02-b']);
  });

  it('④ 摊了 1/3 就中断 ⇒ 再次启动三个会话全部可见，且已摊会话不被覆盖', () => {
    // 旧档三会话；模拟「第一次启动摊完第 1 个会话就崩」：
    // 磁盘上已有 a 的会话文件（内容为当次写入），旧档仍在（尚未改名 .migrated）
    const legacy = {
      metas: {
        '2026-08-01-a': {
          sessionId: '2026-08-01-a',
          updatedAt: '2026-08-01T10:00:00.000Z',
          messageCount: 2,
        },
        '2026-08-02-b': {
          sessionId: '2026-08-02-b',
          updatedAt: '2026-08-02T10:00:00.000Z',
          messageCount: 2,
        },
        '2026-08-03-c': {
          sessionId: '2026-08-03-c',
          updatedAt: '2026-08-03T10:00:00.000Z',
          messageCount: 2,
        },
      },
      roundIdsStore: {
        '2026-08-01-a': ['legacy-a1'],
        '2026-08-02-b': ['legacy-b1'],
        '2026-08-03-c': ['legacy-c1'],
      },
    };
    writeFileSync(legacyFile(ws), JSON.stringify(legacy, null, 2), 'utf8');
    // 中断前已摊出的第 1 个会话文件（故意放一份与旧档不同的 roundIds，
    // 用来证明续摊「以每会话文件为准、不覆盖」）
    mkdirSync(join(memoraDir(ws), 'sessions'), { recursive: true });
    writeFileSync(
      sessionFile(ws, '2026-08-01-a'),
      JSON.stringify(
        {
          sessionId: '2026-08-01-a',
          meta: legacy.metas['2026-08-01-a'],
          roundIds: ['already-flattened-a1'],
        },
        null,
        2,
      ),
      'utf8',
    );

    const resumed = reopen(ws);

    // 本步最关键的新增验收：三个会话全部可见（不再因「sessions/ 非空」而放弃剩余两个）
    expect(new Set(resumed.listSessions())).toEqual(
      new Set(['2026-08-01-a', '2026-08-02-b', '2026-08-03-c']),
    );
    // 已摊会话内容以已有文件为准（不被旧档覆盖）
    expect(resumed.getRoundIds('2026-08-01-a')).toEqual(['already-flattened-a1']);
    // 缺失的两个按旧档补齐
    expect(resumed.getRoundIds('2026-08-02-b')).toEqual(['legacy-b1']);
    expect(resumed.getRoundIds('2026-08-03-c')).toEqual(['legacy-c1']);
    // 全部补齐后才落幕：旧档改名保留
    expect(existsSync(legacyFile(ws))).toBe(false);
    expect(existsSync(migratedFile(ws))).toBe(true);
  });
});
