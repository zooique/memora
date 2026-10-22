/**
 * 交互提醒判据单测（HOST-ATTN-1）
 *
 * 本文件守的是**该不该响**，不是「有没有调 API」。现行只有一条通道（提示音）：
 *   ① 聚焦 ⇒ 一律不响（承接面是面板内按钮：审批卡 / ask 卡 / 文件改动条）；
 *   ② 失焦 ⇒ 响，且同事件只响一次（否则每轮都响 = 用户关掉整个提醒渠道）。
 *
 * 未打桩的边界：本模块无 DOM、无 vscode，全部依赖注入，故无需 mock 任何宿主。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { createAttentionNotifier, type AttentionDeps, type AttentionNotifier } from '../attentionNotice.js';

interface Harness {
  notifier: AttentionNotifier;
  playSound: ReturnType<typeof vi.fn>;
}

/** 构造提醒器替身：只需要「窗口是否聚焦」一个判据 + 提示音一个出口 */
function setup(opts: { focused?: boolean; sound?: boolean } = {}): Harness {
  const playSound = vi.fn();
  const deps: AttentionDeps = {
    isWindowFocused: () => opts.focused ?? false,
    ...(opts.sound === false ? {} : { playSound }),
  };
  return { notifier: createAttentionNotifier(deps), playSound };
}

describe('判据：聚焦不响、失焦才响（单通道）', () => {
  it('窗口聚焦 ⇒ 三类事件一个都不响（承接面在面板内）', () => {
    const h = setup({ focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1' });
    h.notifier.onAskWaiting({ question: 'y' });
    h.notifier.onRoundSettled({ roundId: 'round-1' });
    expect(h.playSound).not.toHaveBeenCalled();
  });

  it('窗口失焦 ⇒ 三类事件各响一次（判据不是只接了 confirm）', () => {
    for (const fire of [
      (n: AttentionNotifier) => n.onConfirmShown({ requestId: 'r' }),
      (n: AttentionNotifier) => n.onAskWaiting({ question: 'q' }),
      (n: AttentionNotifier) => n.onRoundSettled({ roundId: 'rd' }),
    ]) {
      const h = setup({ focused: false });
      fire(h.notifier);
      expect(h.playSound).toHaveBeenCalledTimes(1);
    }
  });
});

describe('去重：同事件只响一次', () => {
  it('同一 requestId 重复进入等待 ⇒ 只响一次', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1' });
    h.notifier.onConfirmShown({ requestId: 'req-1' });
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it('不同 requestId ⇒ 各响一次', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1' });
    h.notifier.onConfirmShown({ requestId: 'req-2' });
    expect(h.playSound).toHaveBeenCalledTimes(2);
  });

  it('同一提问重复进入等待（setPending 覆写 + armAskTimeout 两次）⇒ 只响一次', () => {
    const h = setup({ focused: false });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it('同一 roundId 只响一次（done 分支重入不重复响）', () => {
    const h = setup({ focused: false });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    expect(h.playSound).toHaveBeenCalledTimes(1);
  });

  it('去重键带类别前缀：requestId / question / roundId 撞同一字符串互不影响', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'same' });
    h.notifier.onAskWaiting({ question: 'same' });
    h.notifier.onRoundSettled({ roundId: 'same' });
    expect(h.playSound).toHaveBeenCalledTimes(3);
  });

  it('去重表容量有界：超过 200 条后最早的事件键被淘汰（重新可响）', () => {
    const h = setup({ focused: false });
    for (let i = 0; i < 201; i++) h.notifier.onConfirmShown({ requestId: `req-${i}` });
    expect(h.playSound).toHaveBeenCalledTimes(201);
    h.notifier.onConfirmShown({ requestId: 'req-0' });
    expect(h.playSound).toHaveBeenCalledTimes(202);
  });
});

describe('降级与边界：提醒永不反噬主链路', () => {
  it('未注入 playSound ⇒ 静默降级（不抛错）', () => {
    const h = setup({ focused: false, sound: false });
    expect(() => h.notifier.onConfirmShown({ requestId: 'req-1' })).not.toThrow();
  });

  it('isWindowFocused 抛 ⇒ 不冒泡（确认卡路径是同步直调）', () => {
    const notifier = createAttentionNotifier({
      isWindowFocused: () => {
        throw new Error('window state 不可读');
      },
      playSound: vi.fn(),
    });
    expect(() => notifier.onAskWaiting({ question: 'q' })).not.toThrow();
  });

  it('playSound 抛 ⇒ 不冒泡', () => {
    const notifier = createAttentionNotifier({
      isWindowFocused: () => false,
      playSound: () => {
        throw new Error('powershell 崩了');
      },
    });
    expect(() => notifier.onRoundSettled({ roundId: 'r' })).not.toThrow();
  });

  it('抛错后去重键仍被消耗（同事件不因失败而无限重试）', () => {
    let calls = 0;
    const notifier = createAttentionNotifier({
      isWindowFocused: () => false,
      playSound: () => {
        calls++;
        throw new Error('炸');
      },
    });
    notifier.onRoundSettled({ roundId: 'r' });
    notifier.onRoundSettled({ roundId: 'r' });
    expect(calls).toBe(1);
  });
});
