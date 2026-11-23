/**
 * 崩溃打捞「补恢复标记」单测（`extension/host/interruptedSalvage.ts`）
 *
 * 钉住五件事（缺一即会让事实层重新分不清「崩溃恢复 / 用户停」）：
 *   ① 收场前补一条 `aborted(stopReason:'interrupted')`，且 seq 接在现有事件之后；
 *   ② 标记**先落盘、再收场**（内核收场是 store-first 读改写，顺序反了标记会被覆盖）；
 *   ③ 已有终止证据（aborted / error）的轮不重复补，不把普通中断冒充崩溃恢复；
 *   ④ 整轮回写取**盘上现值**：列表快照之后新落盘的事件不得被写丢；
 *   ⑤ 盘上已消失的候选**不回退旧缓存**（否则会把已删轮复活）。
 */
import { describe, expect, it } from 'vitest';
import type { Round } from '@zooique/memora';
import { salvageInterruptedRounds } from '../interruptedSalvage.js';

/**
 * 造一条 thought 过程事件
 *
 * @param seq 序号
 * @param content 正文（区分「列表快照」与「盘上后写」用）
 * @returns 过程事件
 */
function thought(seq: number, content = '思考'): NonNullable<Round['processEvents']>[number] {
  return { type: 'thought', seq, ts: '2026-11-23T10:00:00.000Z', payload: { content } };
}

/**
 * 造一个崩溃残留轮（pending + 可选过程事件）
 *
 * @param id Round ID
 * @param processEvents 崩溃前已落盘的过程事件（可缺省）
 */
function pendingRound(id: string, processEvents?: Round['processEvents']): Round {
  return {
    id,
    userMessage: {
      id: `msg-${id}-user`,
      role: 'user',
      content: '你好',
      timestamp: '2026-11-23T10:00:00.000Z',
    },
    status: 'pending',
    createdAt: '2026-11-23T10:00:00.000Z',
    ...(processEvents ? { processEvents } : {}),
  };
}

/**
 * 造打捞依赖（记录写入顺序，用来验证「先标记后收场」）
 *
 * @param rounds 打捞候选（list / getById 共用同一份）
 * @param freshRead 盘上新鲜读替身（缺省 = store 无 `getByIdFresh` 能力）
 */
function harness(rounds: Round[], freshRead?: (id: string) => Round | null) {
  /** 每次 save 的轮快照（按调用序） */
  const saved: Round[] = [];
  /** 写盘与收场的调用顺序（'save' / 'settle:<id>'） */
  const order: string[] = [];
  const store = {
    listInterruptedRecent: () => rounds,
    getById: (id: string) => rounds.find((r) => r.id === id) ?? null,
    ...(freshRead ? { getByIdFresh: freshRead } : {}),
    save: (r: Round) => {
      saved.push(r);
      order.push('save');
    },
  };
  const history = {
    appendInterrupted: async (id: string) => {
      order.push(`settle:${id}`);
    },
  };
  return {
    deps: {
      store,
      history,
      sessionDate: '2026-11-23',
    } as Parameters<typeof salvageInterruptedRounds>[0],
    saved,
    order,
  };
}

describe('salvageInterruptedRounds', () => {
  it('收场前补 aborted(stopReason=interrupted)，seq 接在现有事件之后', async () => {
    const h = harness([
      pendingRound('r1', [
        { type: 'meta', seq: 1, ts: '2026-11-23T10:00:00.000Z', payload: { role: 'AI', llm: 'm' } },
      ]),
    ]);

    await expect(salvageInterruptedRounds(h.deps)).resolves.toBe(1);

    // 先落标记，再收场（顺序反了，内核 store-first 读改写会把标记覆盖掉）
    expect(h.order).toEqual(['save', 'settle:r1']);
    const events = h.saved[0].processEvents ?? [];
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'aborted',
      seq: 2,
      payload: { stopReason: 'interrupted' },
    });
  });

  it('已有终止证据的轮不补标记（不把普通中断冒充崩溃恢复）', async () => {
    const h = harness([
      pendingRound('r2', [
        {
          type: 'aborted',
          seq: 1,
          ts: '2026-11-23T10:00:00.000Z',
          payload: { reason: 'cancelled', stopReason: 'user' },
        },
      ]),
    ]);

    await expect(salvageInterruptedRounds(h.deps)).resolves.toBe(1);

    // 只收场、不写盘
    expect(h.saved).toHaveLength(0);
    expect(h.order).toEqual(['settle:r2']);
  });

  it('整轮回写取盘上现值：列表快照之后新落盘的事件不被写丢', async () => {
    // 列表快照停在 seq 1；盘上已多出一条 seq 2（宿主检查点在列表之后写入）
    const listed = pendingRound('r3', [thought(1, '列表快照')]);
    const onDisk = pendingRound('r3', [thought(1, '列表快照'), thought(2, '盘上后写')]);
    const h = harness([listed], () => onDisk);

    await expect(salvageInterruptedRounds(h.deps)).resolves.toBe(1);

    // 用旧快照整轮 save 会只剩 [1, 标记]，把 seq 2 写丢（= 改写历史）
    expect((h.saved[0].processEvents ?? []).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('盘上已消失的候选不回退旧缓存：不写盘、不收场（不复活已删轮）', async () => {
    const listed = pendingRound('r4', [thought(1)]);
    // getById 仍能命中列表快照（本进程缓存）；getByIdFresh 说盘上没了
    const h = harness([listed], () => null);

    await expect(salvageInterruptedRounds(h.deps)).resolves.toBe(1);

    expect(h.saved).toHaveLength(0);
    expect(h.order).toEqual([]);
  });
});
