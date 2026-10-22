/**
 * 交互提醒判据单测（HOST-ATTN-1）
 *
 * 本文件守的是**该不该叫**，不是「有没有调 API」。现行只有一条通道（系统 toast）：
 *   ① 聚焦 ⇒ 一律不发（承接面是面板内按钮：审批卡 / ask 卡 / 文件改动条）；
 *   ② 失焦 ⇒ 发，且同事件只发一次（否则每轮都弹 = 用户关掉整个通知渠道）；
 *   ③ 通知载荷**没有任何动作位**：只能被点开回跳，永不表达「批准/拒绝」。
 *
 * 未打桩的边界：本模块无 DOM、无 vscode，全部依赖注入，故无需 mock 任何宿主。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  ATTENTION_URI,
  composeAttention,
  createAttentionNotifier,
  type AttentionDeps,
  type AttentionNotifier,
} from '../attentionNotice.js';

const LAUNCH_URI = 'vscode://zooique.memora-vscode/attention';

interface Harness {
  notifier: AttentionNotifier;
  showSystemToast: ReturnType<typeof vi.fn>;
}

/** 构造提醒器替身：只需要「窗口是否聚焦」一个判据 + 系统 toast 一个出口 */
function setup(opts: { focused?: boolean; toast?: boolean } = {}): Harness {
  const showSystemToast = vi.fn();
  const deps: AttentionDeps = {
    isWindowFocused: () => opts.focused ?? false,
    ...(opts.toast === false ? {} : { showSystemToast }),
    launchUri: LAUNCH_URI,
  };
  return { notifier: createAttentionNotifier(deps), showSystemToast };
}

describe('composeAttention —— 文案单点', () => {
  it('confirm：标题点明要确认，正文带「工具：文件」简写', () => {
    const composed = composeAttention('confirm', { label: 'write_file：src/foo.ts' });
    expect(composed.title).toBe('Memora 需要你确认');
    expect(composed.body).toBe('write_file：src/foo.ts');
  });

  it('confirm：无 label 时给兜底文案而不是空串（toast 不能只剩标题）', () => {
    expect(composeAttention('confirm').body).toBeTruthy();
  });

  it('ask：正文带提问摘要', () => {
    const composed = composeAttention('ask', { question: '要覆盖已有文件吗？' });
    expect(composed.title).toBe('Memora 在等你回答');
    expect(composed.body).toBe('要覆盖已有文件吗？');
  });

  it('ask：空串与纯空白都走兜底（不能用 `??`，`??` 只挡 null/undefined）', () => {
    expect(composeAttention('ask', { question: '' }).body).toBeTruthy();
    expect(composeAttention('ask', { question: '   ' }).body).toBeTruthy();
    expect(composeAttention('ask').body).toBeTruthy();
  });

  it('settled：只有标题，body 为空（toast 单行）', () => {
    const composed = composeAttention('settled');
    expect(composed.title).toBe('Memora 任务完成');
    expect(composed.body).toBe('');
  });

  it('超长文本截断到 60 + 省略号（toast 一行放不下整段）', () => {
    const composed = composeAttention('ask', { question: 'q'.repeat(100) });
    expect(composed.body).toHaveLength(61);
    expect(composed.body.endsWith('…')).toBe(true);
  });

  it('恰好 60 字符不截断（边界不多加省略号）', () => {
    expect(composeAttention('ask', { question: 'q'.repeat(60) }).body).toHaveLength(60);
  });

  it('换行折叠成空格（toast 里换行破排版）', () => {
    const composed = composeAttention('confirm', { label: 'a\n\nb\tc' });
    expect(composed.body).toBe('a b c');
    expect(composed.body).not.toContain('\n');
  });

  it('首尾空白裁剪', () => {
    expect(composeAttention('confirm', { label: '  padded  ' }).body).toBe('padded');
  });
});

describe('判据：聚焦不发、失焦才发（单通道）', () => {
  it('窗口聚焦 ⇒ 三类事件一条都不发（承接面在面板内）', () => {
    const h = setup({ focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onAskWaiting({ question: 'y' });
    h.notifier.onRoundSettled({ roundId: 'round-1' });
    expect(h.showSystemToast).not.toHaveBeenCalled();
  });

  it('窗口失焦 ⇒ 三类事件各发一次（判据不是只接了 confirm）', () => {
    for (const fire of [
      (n: AttentionNotifier) => n.onConfirmShown({ requestId: 'r', label: 'x' }),
      (n: AttentionNotifier) => n.onAskWaiting({ question: 'q' }),
      (n: AttentionNotifier) => n.onRoundSettled({ roundId: 'rd' }),
    ]) {
      const h = setup({ focused: false });
      fire(h.notifier);
      expect(h.showSystemToast).toHaveBeenCalledTimes(1);
    }
  });

  it('失焦 ⇒ 载荷来自 composeAttention，且三键即全部（无 action/buttons 审批位）', () => {
    const h = setup({ focused: false });
    h.notifier.onAskWaiting({ question: '要覆盖吗？' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
    const payload = h.showSystemToast.mock.calls[0][0] as Record<string, unknown>;
    const composed = composeAttention('ask', { question: '要覆盖吗？' });
    expect(payload.title).toBe(composed.title);
    expect(payload.body).toBe(composed.body);
    expect(payload.launchUri).toBe(LAUNCH_URI);
    expect(Object.keys(payload).sort()).toEqual(['body', 'launchUri', 'title']);
  });
});

describe('去重：同事件只发一次', () => {
  it('同一 requestId 重复进入等待 ⇒ 只发一次', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('不同 requestId ⇒ 各发一次', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onConfirmShown({ requestId: 'req-2', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(2);
  });

  it('同一提问重复进入等待（setPending 覆写 + armAskTimeout 两次）⇒ 只弹一次', () => {
    const h = setup({ focused: false });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('同一 roundId 只发一次（done 分支重入不重复弹）', () => {
    const h = setup({ focused: false });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('去重键带类别前缀：requestId / question / roundId 撞同一字符串互不影响', () => {
    const h = setup({ focused: false });
    h.notifier.onConfirmShown({ requestId: 'same', label: 'x' });
    h.notifier.onAskWaiting({ question: 'same' });
    h.notifier.onRoundSettled({ roundId: 'same' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(3);
  });

  it('去重表容量有界：超过 200 条后最早的事件键被淘汰（重新可见）', () => {
    const h = setup({ focused: false });
    for (let i = 0; i < 201; i++) h.notifier.onConfirmShown({ requestId: `req-${i}`, label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(201);
    h.notifier.onConfirmShown({ requestId: 'req-0', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(202);
  });
});

describe('降级与边界：通知永不反噬主链路', () => {
  it('未注入 showSystemToast ⇒ 静默降级（不抛错）', () => {
    const h = setup({ focused: false, toast: false });
    expect(() => h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' })).not.toThrow();
  });

  it('isWindowFocused 抛 ⇒ 不冒泡（确认卡路径是同步直调）', () => {
    const notifier = createAttentionNotifier({
      isWindowFocused: () => {
        throw new Error('window state 不可读');
      },
      showSystemToast: vi.fn(),
      launchUri: LAUNCH_URI,
    });
    expect(() => notifier.onAskWaiting({ question: 'q' })).not.toThrow();
  });

  it('showSystemToast 抛 ⇒ 不冒泡', () => {
    const notifier = createAttentionNotifier({
      isWindowFocused: () => false,
      showSystemToast: () => {
        throw new Error('powershell 崩了');
      },
      launchUri: LAUNCH_URI,
    });
    expect(() => notifier.onRoundSettled({ roundId: 'r' })).not.toThrow();
  });

  it('抛错后去重键仍被消耗（同事件不因失败而无限重试）', () => {
    const calls: string[] = [];
    const notifier = createAttentionNotifier({
      isWindowFocused: () => false,
      showSystemToast: (p) => {
        calls.push(p.title);
        throw new Error('炸');
      },
      launchUri: LAUNCH_URI,
    });
    notifier.onRoundSettled({ roundId: 'r' });
    notifier.onRoundSettled({ roundId: 'r' });
    expect(calls).toHaveLength(1);
  });
});

describe('URI 契约（纯逻辑层单点）', () => {
  it('ATTENTION_URI = vscode://<扩展ID>/attention', () => {
    expect(ATTENTION_URI).toBe('vscode://zooique.memora-vscode/attention');
    expect(new URL(ATTENTION_URI).host).toBe('zooique.memora-vscode');
  });
});
