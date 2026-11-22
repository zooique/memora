/**
 * 派活账本单测（判据 C）—— 记账 / 核销 / 悬空 / 坏文件容错 / 并发追加
 *
 * 锁定的不变式：
 *   ① 只有受理成功才入账，`send` 与 `create` 两类动作都落 pending；
 *   ② 核销只由 settle 事件驱动，带 roundId + outcome，按**文件行序**吃掉同目标第一条 pending；
 *   ③ 无主 settle（同目标没有在途）**不写**——零派发轮账本零新增；
 *   ④ 起流失败补 `aborted` 终态，有结局就不会被判悬空；
 *   ⑤ 超过超时窗的 pending 在**读出时**定性为 orphaned，不在读路径回写；
 *   ⑥ 文件不存在 / 整文件读坏 / 单行坏都不 throw，坏行跳过；
 *   ⑦ 两个窗口交替追加不互相覆盖（append-only，无整份读改写）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTempDir } from '../../../__tests__/helpers/tmpDir.js';
import { resolveProjectDataDir } from '../projectDataDir.js';
import {
  abortDispatchLedger,
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

  it('核销只吃同目标第一条未结；无主 settle 被写侧拦下', () => {
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
    // 目标不存在 ⇒ 无主，写侧直接不收（不靠读侧过滤）
    const orphanWrote = settleDispatchLedger(dir, {
      targetSessionId: 'target-unknown',
      roundId: 'round-x',
      outcome: 'failed',
      settledAt: '2026-11-22T00:07:00.000Z',
    });
    expect(orphanWrote).toBe(false);

    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:08:00.000Z') });
    expect(rows.map((row) => row.status)).toEqual(['settled', 'pending']);
    expect(rows[0].roundId).toBe('round-first');
    expect(rows[1].text).toBe('第二条');
    // 文件只有 2 条 dispatch + 1 条有效 settle；无主事件根本没落盘
    expect(readFileSync(ledgerPath(dir), 'utf8').trim().split(/\r?\n/)).toHaveLength(3);
  });

  it('缺陷 1 回归：零派发轮调用核销 → 账本零新增（连文件都不创建）', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');

    const wrote = settleDispatchLedger(dir, {
      targetSessionId: 'plain-user-session',
      roundId: 'round-plain',
      outcome: 'success',
      settledAt: '2026-11-22T00:10:00.000Z',
    });

    expect(wrote).toBe(false);
    expect(existsSync(ledgerPath(dir))).toBe(false);
  });

  it('缺陷 2 回归：create 的记账时刻晚于落定时刻仍能配上（判据不看时间戳）', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    // 真机实锤：目标轮 settle 07:44:44.549Z 早于 dispatch 07:44:44.551Z
    recordDispatchLedger(
      dir,
      dispatchInput({
        kind: 'create',
        targetSessionId: 'target-create',
        createdAt: '2026-11-22T07:44:44.551Z',
      }),
    );
    settleDispatchLedger(dir, {
      targetSessionId: 'target-create',
      roundId: 'round-create',
      outcome: 'success',
      settledAt: '2026-11-22T07:44:44.549Z',
    });

    const [row] = readDispatchLedger(dir, { now: Date.parse('2026-11-22T07:50:00.000Z') });
    expect(row).toMatchObject({
      kind: 'create',
      status: 'settled',
      roundId: 'round-create',
      outcome: 'success',
    });
  });

  it('起流失败落 aborted：有终态，且超过超时窗也不会被判悬空', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    const created = Date.parse('2026-11-22T00:00:00.000Z');
    recordDispatchLedger(
      dir,
      dispatchInput({ kind: 'create', createdAt: new Date(created).toISOString() }),
    );

    const wrote = abortDispatchLedger(dir, {
      targetSessionId: 'target-1',
      settledAt: '2026-11-22T00:00:01.000Z',
    });
    expect(wrote).toBe(true);

    // 远超超时窗：aborted 已有结局，不能被改判成 orphaned
    const [row] = readDispatchLedger(dir, {
      now: created + DISPATCH_LEDGER_ORPHAN_TIMEOUT_MS * 10,
    });
    expect(row.status).toBe('settled');
    expect(row.outcome).toBe('aborted');
    expect(row.roundId).toBeUndefined();
  });

  it('按文件行序配对：同目标连派三次、落定时间戳乱序也不串账', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    recordDispatchLedger(dir, dispatchInput({ text: '一', createdAt: '2026-11-22T00:00:00.000Z' }));
    recordDispatchLedger(dir, dispatchInput({ text: '二', createdAt: '2026-11-22T00:05:00.000Z' }));
    recordDispatchLedger(dir, dispatchInput({ text: '三', createdAt: '2026-11-22T00:10:00.000Z' }));
    // 三条 settle 按文件顺序追加，但 settledAt 故意乱序（第二条甚至早于「二」的 createdAt）：
    // 配对必须只认行序——第一条 settle → 第一条 pending，依此类推。
    settleDispatchLedger(dir, {
      targetSessionId: 'target-1',
      roundId: 'round-a',
      outcome: 'success',
      settledAt: '2026-11-22T00:20:00.000Z',
    });
    settleDispatchLedger(dir, {
      targetSessionId: 'target-1',
      roundId: 'round-b',
      outcome: 'success',
      settledAt: '2026-11-22T00:06:00.000Z',
    });
    settleDispatchLedger(dir, {
      targetSessionId: 'target-1',
      roundId: 'round-c',
      outcome: 'success',
      settledAt: '2026-11-22T00:07:00.000Z',
    });

    const rows = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:30:00.000Z') });
    expect(rows.map((row) => [row.text, row.roundId, row.status])).toEqual([
      ['一', 'round-a', 'settled'],
      ['二', 'round-b', 'settled'],
      ['三', 'round-c', 'settled'],
    ]);
  });

  it('无主 settle 不污染已有在途：拦下后原账仍等待自己的核销', () => {
    const dir = makeTempDir('memora-dispatch-ledger-');
    recordDispatchLedger(dir, dispatchInput({ targetSessionId: 'target-1' }));

    expect(
      settleDispatchLedger(dir, {
        targetSessionId: 'target-other',
        roundId: 'round-other',
        outcome: 'success',
        settledAt: '2026-11-22T00:10:00.000Z',
      }),
    ).toBe(false);
    // 文件仍只有那一条 pending
    expect(readFileSync(ledgerPath(dir), 'utf8').trim().split(/\r?\n/)).toHaveLength(1);

    expect(
      settleDispatchLedger(dir, {
        targetSessionId: 'target-1',
        roundId: 'round-own',
        outcome: 'success',
        settledAt: '2026-11-22T00:11:00.000Z',
      }),
    ).toBe(true);
    const [row] = readDispatchLedger(dir, { now: Date.parse('2026-11-22T00:12:00.000Z') });
    expect(row).toMatchObject({ status: 'settled', roundId: 'round-own' });
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
