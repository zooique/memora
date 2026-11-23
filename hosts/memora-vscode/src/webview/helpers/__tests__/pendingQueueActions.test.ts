/**
 * 待发队列操作（清空 / 删单条）的契约测试。
 *
 * 被测契约（webview 按「信号帧 → 快照帧」成对消耗，见 pendingQueueActions 模块头注释）：
 *  1. 先读后变：变之前从内核取被丢条目文本（webview diff 据此分流「消失 = 丢弃不上屏」）
 *  2. 丢弃信号帧 postDiscarded 必须 先于 快照帧 sync——顺序错 ⇒ webview 先拿到空快照再补信号，
 *     被丢条目会被当成「用户主动删除」上屏，而非「丢弃不上屏」（与 chatPanelInterject FIFO 断言同源）
 *  3. 未丢任何条目 ⇒ 零信号（不发 postDiscarded / 不发清空通知），但仍 sync（让角标熄灭）
 *
 * 变异验证：若在 dispatchPendingQueueAction 里调换 postDiscarded 与 sync 顺序，
 * 或删掉「空队列仍 sync」分支，本文件对应用例会红。
 */
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { dispatchPendingQueueAction, type PendingQueueDeps } from '../pendingQueueActions.js';

/**
 * 构造一组记录调用顺序的替身。
 * opts 控制各 mock 的返回值（默认：队列 [a,b]，清 2 条，删单条成功）；
 * 注意必须用选项注入返回值、不能用 mockReturnValue——后者会替换掉整个实现体，
 * 导致 seq.push 不执行、顺序断言失真。
 * seq 按调用先后 push 标签——顺序契约用序列断言比单 mock 计数更难骗过。
 */
function makeFixture(
  opts: {
    pending?: readonly string[];
    cleared?: number;
    removed?: boolean;
  } = {},
) {
  // 调用顺序记录：契约核心是 postDiscarded 先于 sync，序列断言直接钉死
  const seq: string[] = [];
  const pending = opts.pending ?? ['a', 'b']; // 当前待发条目（变之前读）
  const cleared = opts.cleared ?? 2; // 清空返回的条数
  const removed = opts.removed ?? true; // 删单条是否成功
  // 读当前待发
  const getPending = vi.fn((): readonly string[] => {
    seq.push('getPending');
    return pending;
  });
  // 原子清空
  const clearAll = vi.fn((): number => {
    seq.push('clearAll');
    return cleared;
  });
  // 删单条
  const removeOne = vi.fn((_index: number): boolean => {
    seq.push('removeOne');
    return removed;
  });
  // 清空通知上屏
  const postClearedNotice = vi.fn((_count: number): void => {
    seq.push('postClearedNotice');
  });
  // 丢弃信号帧
  const postDiscarded = vi.fn((_items: readonly string[]): void => {
    seq.push('postDiscarded');
  });
  // 推当前待发快照
  const sync = vi.fn((): void => {
    seq.push('sync');
  });
  // deps：dispatchPendingQueueAction 的注入面；各 mock 运行时签名与 PendingQueueDeps 同构
  const deps: PendingQueueDeps = {
    getPending,
    clearAll,
    removeOne,
    postClearedNotice,
    postDiscarded,
    sync,
  };
  return { deps, seq, getPending, clearAll, removeOne, postClearedNotice, postDiscarded, sync };
}

describe('dispatchPendingQueueAction · clear_pending_queue', () => {
  it('有条目：先读后清 → 通知 → 丢弃信号 → 快照（顺序钉死）', () => {
    const f = makeFixture();
    dispatchPendingQueueAction({ type: 'clear_pending_queue' }, f.deps);
    // 顺序不变量：getPending → clearAll → postClearedNotice → postDiscarded → sync
    expect(f.seq).toEqual(['getPending', 'clearAll', 'postClearedNotice', 'postDiscarded', 'sync']);
    expect(f.postClearedNotice).toHaveBeenCalledWith(2);
    expect(f.postDiscarded).toHaveBeenCalledWith(['a', 'b']);
    expect(f.sync).toHaveBeenCalledTimes(1);
  });

  it('空队列（清到 0）：无通知、无丢弃信号，但仍推快照（角标熄灭）', () => {
    const f = makeFixture({ pending: [], cleared: 0 }); // 队列已空，清到 0 条
    dispatchPendingQueueAction({ type: 'clear_pending_queue' }, f.deps);
    expect(f.seq).toEqual(['getPending', 'clearAll', 'sync']);
    expect(f.postClearedNotice).not.toHaveBeenCalled();
    expect(f.postDiscarded).not.toHaveBeenCalled();
    expect(f.sync).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchPendingQueueAction · remove_pending_item', () => {
  it('成功：先读后删 → 丢弃信号带被删文本 → 快照', () => {
    const f = makeFixture();
    dispatchPendingQueueAction({ type: 'remove_pending_item', index: 1 }, f.deps);
    // before=[a,b]，index 1 ⇒ 被删文本 'b'
    expect(f.seq).toEqual(['getPending', 'removeOne', 'postDiscarded', 'sync']);
    expect(f.removeOne).toHaveBeenCalledWith(1);
    expect(f.postDiscarded).toHaveBeenCalledWith(['b']);
  });

  it('删除失败（ok=false）：零丢弃信号，但仍同步快照', () => {
    const f = makeFixture({ removed: false }); // 内核越界 / 并发已删
    dispatchPendingQueueAction({ type: 'remove_pending_item', index: 0 }, f.deps);
    expect(f.seq).toEqual(['getPending', 'removeOne', 'sync']);
    expect(f.postDiscarded).not.toHaveBeenCalled();
    expect(f.sync).toHaveBeenCalledTimes(1);
  });

  it('越界（被删文本 undefined）：即使 removeOne 返回 ok 也不发丢弃信号', () => {
    const f = makeFixture({ pending: ['a'] }); // 仅 1 条，index 1 越界 ⇒ removed 为 undefined
    dispatchPendingQueueAction({ type: 'remove_pending_item', index: 1 }, f.deps);
    expect(f.postDiscarded).not.toHaveBeenCalled();
    expect(f.sync).toHaveBeenCalledTimes(1);
  });
});
