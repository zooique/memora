/**
 * 引用集合「现场派生」测试（审查 B2）
 *
 * 立此用例的伤：`referencedIds()` 曾遍历进程内的 `roundIdsStore`（仅 `load()` /
 * `reloadSessionFile()` 刷新）⇒ 另一个窗口分叉出的会话不在本进程名单里，删原会话时
 * 那些**仍被另一窗口引用**的轮会被当孤儿回收（数据丢失，且无任何提示）。
 *
 * 本文件两条判据：
 *   ① 跨进程复现（不是单进程造数据绕过）：A 先 `load()`，再由**子进程**写下分叉会话文件，
 *      然后 A 删原会话 —— 分叉仍在引用的轮必须留在盘上。
 *   ② 代价实测：200 个会话文件下一次 `referencedIds()` 的耗时（> 100ms 即需优化，见报告）。
 */
// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { Round } from '@zooique/memora';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';

/** 造一轮最小可用的问答闭环 */
function makeRound(id: string, at: string): Round {
  return {
    id,
    userMessage: { id: `${id}-user`, role: 'user', content: '问', timestamp: at },
    assistantMessage: { id: `${id}-assistant`, role: 'assistant', content: '答', timestamp: at },
    status: 'complete',
    createdAt: at,
    completedAt: at,
    refCount: 1,
  };
}

/** 会话目录（`.memora/sessions`）——与 store 内部同一推导（唯一计算点 = projectDataDir） */
function sessionsDirOf(workspacePath: string): string {
  return join(workspacePath, '.memora', 'sessions');
}

describe('referencedIds 现场扫盘（跨进程）', () => {
  it('另一窗口（子进程）分叉出的会话引用的轮，删原会话后仍在', async () => {
    const dir = makeTempDir('memora-refids-cross-');
    const roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const storeA = new WorkspaceSessionStore(dir, roundStore);
    storeA.load();

    // 原会话（A 侧）：引用 r1、r2
    const originalId = '2026-11-06-original';
    storeA.createSession({
      sessionId: originalId,
      displayName: 'original',
      updatedAt: '2026-11-06T00:00:00.000Z',
      messageCount: 0,
    });
    roundStore.save(makeRound('r1', '2026-11-06T00:00:00.000Z'));
    roundStore.save(makeRound('r2', '2026-11-06T00:01:00.000Z'));
    storeA.appendRoundId(originalId, 'r1');
    storeA.appendRoundId(originalId, 'r2');

    // 关键：A 的内存名单此刻只含原会话（不含随后由「另一窗口」写下的分叉）
    expect(storeA.referencedIds().sort()).toEqual(['r1', 'r2']);

    // 另一窗口（子进程）分叉出同一份问答：写会话文件，**不通知 A**
    const forkDir = sessionsDirOf(dir);
    mkdirSync(forkDir, { recursive: true });
    const forkFile = join(forkDir, '2026-11-06-fork.json');
    const body = JSON.stringify({
      sessionId: '2026-11-06-fork',
      meta: null,
      roundIds: ['r1', 'r2'],
    });
    const child = spawnSync(
      process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', forkFile, body],
      {
        encoding: 'utf8',
      },
    );
    expect(child.status).toBe(0);

    // A 删原会话：r1/r2 仍被分叉引用 ⇒ 一个都不许回收
    const removed = storeA.deleteSession(originalId);
    expect(removed).toEqual([]);
    expect(roundStore.getById('r1')).not.toBeNull();
    expect(roundStore.getById('r2')).not.toBeNull();
  });

  it('部分引用：分叉只引用 3 轮中的 2 轮 ⇒ 删原会话后「删 1 留 2」', () => {
    const dir = makeTempDir('memora-refids-partial-');
    const roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const storeA = new WorkspaceSessionStore(dir, roundStore);
    storeA.load();

    // 原会话（A 侧）：三轮 r1 / r2 / r3；轮文件均先落盘（与生产时序同：建轮即落盘）。
    // 轮创建时刻取「超龄」（>24h）：删除路径复用 sweepOrphans 的 24h 存活保护，
    // 刚建的轮本就不会被物理回收，用新时间戳会掩盖「引用集合是否真扫到分叉」这一判据。
    const originalId = '2026-11-06-original3';
    storeA.createSession({
      sessionId: originalId,
      displayName: 'original3',
      updatedAt: '2026-11-06T00:00:00.000Z',
      messageCount: 0,
    });
    for (const [id, offset] of [
      ['r1', 'T00:00:00'],
      ['r2', 'T00:01:00'],
      ['r3', 'T00:02:00'],
    ] as const) {
      roundStore.save(makeRound(id, `2026-10-30${offset}.000Z`));
      storeA.appendRoundId(originalId, id);
    }

    // 另一窗口（真子进程）分叉：只引用 r1 / r2（r3 无人引用）
    const forkDir = sessionsDirOf(dir);
    mkdirSync(forkDir, { recursive: true });
    const forkFile = join(forkDir, '2026-11-06-fork12.json');
    const body = JSON.stringify({
      sessionId: '2026-11-06-fork12',
      meta: null,
      roundIds: ['r1', 'r2'],
    });
    const child = spawnSync(
      process.execPath,
      ['-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])', forkFile, body],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(0);

    // 删原会话：r3 引用归零 ⇒ 唯一被回收；r1/r2 仍被分叉引用 ⇒ 必须留下
    const removed = storeA.deleteSession(originalId);
    expect(removed).toEqual(['r3']);
    expect(roundStore.getById('r3')).toBeNull();
    expect(roundStore.getById('r1')).not.toBeNull();
    expect(roundStore.getById('r2')).not.toBeNull();
  });

  it('200 个会话文件下 referencedIds 的耗时（代价实测）', () => {
    const dir = makeTempDir('memora-refids-perf-');
    const roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const store = new WorkspaceSessionStore(dir, roundStore);
    store.load();

    const sessionsDir = sessionsDirOf(dir);
    mkdirSync(sessionsDir, { recursive: true });
    // 200 个会话 × 每会话 3 条 roundIds（接近真实规模上界）
    for (let i = 0; i < 200; i += 1) {
      writeFileSync(
        join(sessionsDir, `perf-${i}.json`),
        JSON.stringify({
          sessionId: `perf-${i}`,
          meta: null,
          roundIds: [`p${i}-a`, `p${i}-b`, `p${i}-c`],
        }),
        'utf8',
      );
    }

    const started = performance.now();
    const ids = store.referencedIds();
    const elapsed = performance.now() - started;
    // 实测值打印出来供审查记录（不做阈值断言之外的优化；>100ms 才需要优化方案）
    console.log(
      `[B2] referencedIds() 200 会话文件耗时：${elapsed.toFixed(1)}ms（${ids.length} 个 roundId）`,
    );
    expect(ids.length).toBe(600);
    // 宽松上界：只挡病态回归（真实阈值口径见审查记录）
    expect(elapsed).toBeLessThan(500);
  });
});
