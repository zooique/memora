/**
 * 派活账本单测（判据 C）—— 记账 / 核销 / 悬空 / 坏文件容错 / 并发追加
 *
 * 锁定的不变式：
 *   ① 只有受理成功才入账，`send` 与 `create` 两类动作都落 pending；
 *   ② 核销只由 settle 事件驱动，带 roundId + outcome，且只吃掉同目标最早的 pending；
 *   ③ 超过超时窗的 pending 在**读出时**定性为 orphaned，不在读路径回写；
 *   ④ 文件不存在 / 整文件读坏 / 单行坏都不 throw，坏行跳过；
 *   ⑤ 两个窗口交替追加不互相覆盖（append-only，无整份读改写）。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import {
  DISPATCH_LEDGER_FILE_NAME,
  DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS,
  DISPATCH_LEDGER_TEXT_MAX_CHARS,
  recordDispatchLedger,
  readDispatchLedger,
  settleDispatchLedger,
} from '../dispatchLedger.js';

/** 账本文件路径（测试自己拼路径只用于读原始行 / 写坏文件；生产侧仍走 projectDataDir 单点） */
function ledgerPath(projectPath: string): string {
  return join(resolveProjectDataDir(projectPath), DISPATCH_LEDGER_FILE_NAME);
}

/**
 * 造一条最小派活受理
 *
 * @param overrides 覆盖默认字段（目标 / 时刻等）
 * @returns 可直接传给 recordDispatchLedger 的入参
 */
function dispatchInput(
  overrides: Partial<Parameters<typeof recordDispatchLedger>[1]> = {},
): Parameters<typeof recordDispatchLedger>[1] {
  return {
    kind: 'send',
    callerSessionId: 'caller-1',
    targetSessionId: 'target-1',
    targetTitle: '目标一',
    text: '把这件事办了',
    createdAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

describe('派活账本（dispatchLedger）', () => {
  it('记账：send / create 都落 pending，原文按上限截断', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    recordDispatchLedger(
      dir,
      dispatchInput({
        text: 'x'.repeat(DISPATCH_LEDGER_TEXT_MAX_CHARS + 100),
      }),
    );
    recordDispatchLedger(
      dir,
      dispatchInput({
        kind: 'create',
        targetSessionId: 'target-2',
        targetTitle: '目标二',
        text: '开个会话',
        createdAt: '2026-11-22T00:01:00.000Z',
      }),
    );

    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:02:00.000Z') });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: 'send',
      targetSessionId: 'target-1',
      targetTitle: '目标一',
      status: 'pending',
      text: 'x'.repeat(DISPATCH_LEDGER_TEXT_MAX_CHARS),
    });
    expect(rows[1]).toMatchObject({
      kind: 'create',
      targetSessionId: 'target-2',
      status: 'pending',
    });
  });

  it('核销：settle 事件按目标 sid + roundId 把最早的 pending 改成 settled', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    recordDispatchLedger(dir, dispatchInput());
    settleDispatchLedger(dir, {
      targetSessionId: 'target-1',
      roundId: 'round-9',
      outcome: 'success',
      settledAt: '2026-11-22T00:10:00.000Z',
    });

    const [row] = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:11:00.000Z') });
    expect(row).toMatchObject({
      targetSessionId: 'target-1',
      status: 'settled',
      roundId: 'round-9',
      outcome: 'success',
      settledAt: '2026-11-22T00:10:00.000Z',
    });
  });

  it('核销只吃同目标最早的 pending；匹配不上的 settle 被忽略', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    // 两条同目标 pending（真实路径第二条会被 E_BUSY 拒，这里只验折叠规则不会串账）
    recordDispatchLedger(
      dir,
      dispatchInput({ text: '第一条', createdAt: '2026-11-22T00:00:00.000Z' }),
    );
    recordDispatchLedger(
      dir,
      dispatchInput({ text: '第二条', createdAt: '2026-11-22T00:05:00.000Z' }),
    );
    settleDispatchLedger(dir, {
      targetSessionId: 'target-1',
      roundId: 'round-first',
      outcome: 'success',
      settledAt: '2026-11-22T00:06:00.000Z',
    });
    // 目标不存在 / 早于受理时刻的 settle 都不该动任何账
    settleDispatchLedger(dir, {
      targetSessionId: 'target-unknown',
      roundId: 'round-x',
      outcome: 'failed',
      settledAt: '2026-11-22T00:07:00.000Z',
    });

    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:08:00.000Z') });
    expect(rows.map((row) => row.status)).toEqual(['settled', 'pending']);
    expect(rows[0].roundId).toBe('round-first');
    expect(rows[1].text).toBe('第二条');
  });

  it('悬空：超过超时窗的 pending 读出为 orphaned，窗口内仍是 pending', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    const created = Date.parse('2026-11-22T00:00:00.000Z');
    recordDispatchLedger(dir, dispatchInput({ createdAt: new Date(created).toISOString() }));

    // 恰好到窗口边界仍算在途（判据是严格大于）
    const atBoundary = readDispatchLedger(dir, {
      now: created + DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS,
    });
    expect(atBoundary[0].status).toBe('pending');

    const afterBoundary = readDispatchLedger(dir, {
      now: created + DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS + 1,
    });
    expect(afterBoundary[0].status).toBe('orphaned');
  });

  it('坏文件容错：文件不存在 / 整段坏 JSON / 单行坏都不 throw', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    // ① 文件不存在 = 空账
    expect(readDispatchLedger(dir)).toEqual([]);

    // ② 整段不是 JSON = 空账，不抛
    const file = ledgerPath(dir);
    mkdirSync(resolveProjectDataDir(dir), { recursive: true });
    writeFileSync(file, '{not json at all\n', 'utf8');
    expect(readDispatchLedger(dir)).toEqual([]);

    // ③ 好行 + 坏行混排：好行仍可读，坏行跳过
    appendFileSync(
      file,
      `${JSON.stringify({
        type: 'dispatch',
        id: 'good-1',
        kind: 'send',
        callerSessionId: 'caller-1',
        targetSessionId: 'target-1',
        targetTitle: '目标一',
        text: '好行',
        createdAt: '2026-11-22T00:00:00.000Z',
      })}\n`,
      'utf8',
    );
    appendFileSync(file, 'half-line-without-newline', 'utf8');
    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:01:00.000Z') });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('good-1');
  });

  it('并发追加：两个调用方交替写，账一条不少（无整份覆盖）', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    recordDispatchLedger(
      dir,
      dispatchInput({ callerSessionId: 'window-a', targetSessionId: 'a1' }),
    );
    recordDispatchLedger(
      dir,
      dispatchInput({ callerSessionId: 'window-b', targetSessionId: 'b1' }),
    );
    recordDispatchLedger(
      dir,
      dispatchInput({ callerSessionId: 'window-a', targetSessionId: 'a2' }),
    );
    recordDispatchLedger(
      dir,
      dispatchInput({ callerSessionId: 'window-b', targetSessionId: 'b2' }),
    );

    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:01:00.000Z') });
    expect(rows.map((row) => row.targetSessionId)).toEqual(['a1', 'b1', 'a2', 'b2']);
    // append-only 的直接证据：文件 4 行，没有发生过整份重写
    expect(readFileSync(ledgerPath(dir), 'utf8').trim().split(/\r?\n/)).toHaveLength(4);
  });

  it('写失败只 warn 不 throw：项目路径本身是文件时也不影响调用方', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    // 把「项目根」指向一个普通文件 ⇒ 其下 .memora 目录无法创建，写路径必然失败
    const bogusProject = join(dir, 'not-a-directory');
    writeFileSync(bogusProject, 'x', 'utf8');
    expect(() => recordDispatchLedger(bogusProject, dispatchInput())).not.toThrow();
  });
});
