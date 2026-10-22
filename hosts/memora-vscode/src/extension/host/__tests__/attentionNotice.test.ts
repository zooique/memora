/**
 * 交互提醒判据单测（HOST-ATTN-1）
 *
 * 本文件守的是**该不该叫**，不是「有没有调 API」。三条红线逐面断链：
 *   ① 通知里只有「去处理」一个动作 —— 多给一个「确认」就把 fail-closed 反过来了；
 *   ② 看见就不打扰，且判据是 `可见 && 聚焦` 的**与**（写成或 ⇒ 面板折叠+有焦点时静默失职）；
 *   ③ L3 系统 toast 只在**失焦**时发，同事件只发一次（否则每轮都弹 = 用户关掉整个通知渠道）。
 *
 * 未打桩的边界：本模块无 DOM、无 vscode，全部依赖注入，故无需 mock 任何宿主。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import {
  ATTENTION_ACTION,
  composeAttention,
  createAttentionNotifier,
  type AttentionDeps,
  type AttentionNotifier,
} from '../attentionNotice.js';

const LAUNCH_URI = 'vscode://zooique.memora/attention';

interface Harness {
  notifier: AttentionNotifier;
  showInfoMessage: ReturnType<typeof vi.fn>;
  showSystemToast: ReturnType<typeof vi.fn>;
  showChatView: ReturnType<typeof vi.fn>;
}

/**
 * 构造提醒器替身。
 *
 * @param visible  面板是否可见
 * @param focused  窗口是否聚焦
 * @param picked   「去处理」被点后 workbench toast 的返回值（缺省 = 用户没点）
 */
function setup(
  opts: { visible?: boolean; focused?: boolean; picked?: string; toast?: boolean; reject?: boolean } = {},
): Harness {
  const showInfoMessage = vi.fn(() =>
    opts.reject ? Promise.reject(new Error('workbench toast 失败')) : Promise.resolve(opts.picked),
  );
  const showSystemToast = vi.fn();
  const showChatView = vi.fn();
  const deps: AttentionDeps = {
    isViewVisible: () => opts.visible ?? false,
    isWindowFocused: () => opts.focused ?? false,
    showChatView,
    showInfoMessage,
    ...(opts.toast === false ? {} : { showSystemToast }),
    launchUri: LAUNCH_URI,
  };
  return { notifier: createAttentionNotifier(deps), showInfoMessage, showSystemToast, showChatView };
}

/** 让微任务/宏任务排空一轮（用于验证「没有未处理拒绝」） */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('composeAttention —— 文案单点', () => {
  it('confirm：标题点明要确认，正文带「工具：文件」简写', () => {
    const composed = composeAttention('confirm', { label: 'write_file：src/foo.ts' });
    expect(composed.title).toBe('Memora 需要你确认');
    expect(composed.message).toContain('Memora 需要你确认');
    expect(composed.message).toContain('write_file：src/foo.ts');
    expect(composed.body).toBe('write_file：src/foo.ts');
  });

  it('confirm：无 label 时给兜底文案而不是空串（通知不能只剩标题）', () => {
    const composed = composeAttention('confirm');
    expect(composed.body).toBeTruthy();
    expect(composed.message).toContain(composed.body);
  });

  it('ask：正文带提问摘要', () => {
    const composed = composeAttention('ask', { question: '要覆盖已有文件吗？' });
    expect(composed.title).toBe('Memora 在等你回答');
    expect(composed.message).toContain('要覆盖已有文件吗？');
  });

  it('ask：无提问时兜底（调用方传空串也不得产出空通知）', () => {
    expect(composeAttention('ask', { question: '' }).body).toBeTruthy();
    expect(composeAttention('ask').body).toBeTruthy();
  });

  it('settled：消息即标题，body 为空（toast 只留一行）', () => {
    const composed = composeAttention('settled');
    expect(composed.title).toBe('Memora 任务完成');
    expect(composed.message).toBe(composed.title);
    expect(composed.body).toBe('');
  });

  it('超长文本截断到 60 + 省略号（toast 一行放不下整段）', () => {
    const question = 'q'.repeat(100);
    const composed = composeAttention('ask', { question });
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

describe('红线①：通知里只有「去处理」这一个动作', () => {
  it('ATTENTION_ACTION 不是确认/拒绝语义（否则通知能直接批准写入）', () => {
    expect(ATTENTION_ACTION).toBe('去处理');
    expect(['确认', '拒绝', '批准', '允许', '同意', 'approve', 'allow', 'deny']).not.toContain(ATTENTION_ACTION);
  });

  it('workbench toast 只收到一个 action，且就是 ATTENTION_ACTION', () => {
    const h = setup({ visible: false, focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'write_file：a.ts' });
    expect(h.showInfoMessage).toHaveBeenCalledTimes(1);
    const args = h.showInfoMessage.mock.calls[0] as unknown[];
    // 只有 (message, action) 两参 —— 没有第三个按钮的容身之处
    expect(args).toHaveLength(2);
    expect(args[1]).toBe(ATTENTION_ACTION);
  });

  it('系统 toast 载荷只有 title/body/launchUri 三键（无任何审批动作位）', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'write_file：a.ts' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
    const payload = h.showSystemToast.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['body', 'launchUri', 'title']);
    expect(payload.launchUri).toBe(LAUNCH_URI);
  });
});

describe('红线②：看见就不打扰（判据是「可见 && 聚焦」的与）', () => {
  it('可见 + 聚焦 ⇒ 一层都不发', () => {
    const h = setup({ visible: true, focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onAskWaiting({ question: 'y' });
    h.notifier.onRoundSettled({ roundId: 'round-1' });
    expect(h.showInfoMessage).not.toHaveBeenCalled();
    expect(h.showSystemToast).not.toHaveBeenCalled();
  });

  it('可见但失焦 ⇒ 仍然提醒（判据写成「或」这条会红：面板开着但人在别的应用）', () => {
    const h = setup({ visible: true, focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    expect(h.showInfoMessage).toHaveBeenCalledTimes(1);
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('不可见但有焦点 ⇒ 仍然提醒（面板折叠、用户在看别的文件）', () => {
    const h = setup({ visible: false, focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    expect(h.showInfoMessage).toHaveBeenCalledTimes(1);
    // 有焦点 ⇒ 不叠系统 toast（workbench 已可见）
    expect(h.showSystemToast).not.toHaveBeenCalled();
  });

  it('三类事件各自都能穿透 L1（不是只有 confirm 接了判据）', () => {
    for (const fire of [
      (n: AttentionNotifier) => n.onConfirmShown({ requestId: 'r', label: 'x' }),
      (n: AttentionNotifier) => n.onAskWaiting({ question: 'q' }),
      (n: AttentionNotifier) => n.onRoundSettled({ roundId: 'rd' }),
    ]) {
      const h = setup({ visible: false, focused: true });
      fire(h.notifier);
      expect(h.showInfoMessage).toHaveBeenCalledTimes(1);
    }
  });
});

describe('红线③：系统 toast 只在失焦时发，且同事件一次', () => {
  it('失焦 ⇒ 系统 toast 载荷来自 composeAttention（标题/正文一致）', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onAskWaiting({ question: '要覆盖吗？' });
    const payload = h.showSystemToast.mock.calls[0][0] as { title: string; body: string };
    const composed = composeAttention('ask', { question: '要覆盖吗？' });
    expect(payload.title).toBe(composed.title);
    expect(payload.body).toBe(composed.body);
  });

  it('同一 requestId 重复进入等待 ⇒ 系统 toast 只发一次（workbench 每次仍发）', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
    expect(h.showInfoMessage).toHaveBeenCalledTimes(2);
  });

  it('不同 requestId ⇒ 各发一次', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    h.notifier.onConfirmShown({ requestId: 'req-2', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(2);
  });

  it('同一提问重复进入等待（setPending 覆写 + armAskTimeout 两次）⇒ 只弹一次', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    h.notifier.onAskWaiting({ question: '同一个问题' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('同一 roundId 只发一次（done 分支重入不重复弹）', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    h.notifier.onRoundSettled({ roundId: 'round-9' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(1);
  });

  it('去重键带类别前缀：requestId / question / roundId 撞同一字符串互不影响', () => {
    const h = setup({ visible: false, focused: false });
    h.notifier.onConfirmShown({ requestId: 'same', label: 'x' });
    h.notifier.onAskWaiting({ question: 'same' });
    h.notifier.onRoundSettled({ roundId: 'same' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(3);
  });

  it('未注入 showSystemToast ⇒ 静默降级，workbench toast 照发（不抛错）', () => {
    const h = setup({ visible: false, focused: false, toast: false });
    expect(() => h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' })).not.toThrow();
    expect(h.showInfoMessage).toHaveBeenCalledTimes(1);
  });

  it('去重表容量有界：超过 200 条后最早的事件键被淘汰（重新可见）', () => {
    const h = setup({ visible: false, focused: false });
    for (let i = 0; i < 201; i++) h.notifier.onConfirmShown({ requestId: `req-${i}`, label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(201);
    // 最早的那条已被 FIFO 淘汰 ⇒ 再来一次会重新弹（行为有界但不死锁）
    h.notifier.onConfirmShown({ requestId: 'req-0', label: 'x' });
    expect(h.showSystemToast).toHaveBeenCalledTimes(202);
  });
});

describe('点击承接：只有点了「去处理」才展开视图', () => {
  it('点「去处理」⇒ showChatView 被调一次', async () => {
    const h = setup({ visible: false, focused: true, picked: ATTENTION_ACTION });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    await flush();
    expect(h.showChatView).toHaveBeenCalledTimes(1);
  });

  it('toast 被关掉（返回 undefined）⇒ 不抢焦点、不展开', async () => {
    const h = setup({ visible: false, focused: true });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    await flush();
    expect(h.showChatView).not.toHaveBeenCalled();
  });

  it('非预期返回值 ⇒ 不展开（不把任意结果当「去处理」）', async () => {
    const h = setup({ visible: false, focused: true, picked: '取消' });
    h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    await flush();
    expect(h.showChatView).not.toHaveBeenCalled();
  });

  it('vscode Thenable（PromiseLike，无 .catch）也被正确消费', async () => {
    // vscode 的 Thenable 不带 catch —— 实现里必须 Promise.resolve 包一层才挂得上 catch
    const thenable = {
      then(onfulfilled: (value: string | undefined) => unknown) {
        return Promise.resolve(onfulfilled(ATTENTION_ACTION));
      },
    } as unknown as PromiseLike<string | undefined>;
    const showChatView = vi.fn();
    const notifier = createAttentionNotifier({
      isViewVisible: () => false,
      isWindowFocused: () => true,
      showChatView,
      showInfoMessage: () => thenable,
      launchUri: LAUNCH_URI,
    });
    notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
    await flush();
    expect(showChatView).toHaveBeenCalledTimes(1);
  });

  it('showInfoMessage 拒绝 ⇒ 不产生未处理拒绝（covers 宿主侧抛错面）', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const h = setup({ visible: false, focused: true, reject: true });
      h.notifier.onConfirmShown({ requestId: 'req-1', label: 'x' });
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toHaveLength(0);
  });
});

describe('增值能力边界：注入面同步抛错一律不冒泡', () => {
  /** 构造「指定注入点会同步抛」的提醒器 */
  function makeThrowingDeps(overrides: Partial<AttentionDeps>): AttentionNotifier {
    return createAttentionNotifier({
      isViewVisible: () => false,
      isWindowFocused: () => true,
      showChatView: () => undefined,
      showInfoMessage: () => Promise.resolve(undefined),
      launchUri: LAUNCH_URI,
      ...overrides,
    });
  }

  it('isViewVisible 抛 ⇒ 不冒泡（确认卡路径是同步直调）', () => {
    const notifier = makeThrowingDeps({
      isViewVisible: () => {
        throw new Error('view 已销毁');
      },
    });
    expect(() => notifier.onConfirmShown({ requestId: 'r', label: 'x' })).not.toThrow();
  });

  it('isWindowFocused 抛 ⇒ 不冒泡', () => {
    const notifier = makeThrowingDeps({
      isWindowFocused: () => {
        throw new Error('window state 不可读');
      },
    });
    expect(() => notifier.onAskWaiting({ question: 'q' })).not.toThrow();
  });

  it('showInfoMessage 同步抛 ⇒ 不冒泡，且不再尝试系统 toast（一处失败不追加第二处）', () => {
    const showSystemToast = vi.fn();
    const notifier = makeThrowingDeps({
      isWindowFocused: () => false,
      showInfoMessage: () => {
        throw new Error('workbench toast 炸了');
      },
      showSystemToast,
    });
    expect(() => notifier.onConfirmShown({ requestId: 'r', label: 'x' })).not.toThrow();
    expect(showSystemToast).not.toHaveBeenCalled();
  });

  it('showSystemToast 同步抛 ⇒ 不冒泡', () => {
    const notifier = makeThrowingDeps({
      isWindowFocused: () => false,
      showSystemToast: () => {
        throw new Error('powershell 崩了');
      },
    });
    expect(() => notifier.onRoundSettled({ roundId: 'r' })).not.toThrow();
  });

  it('showChatView 在异步回调里抛 ⇒ 被 catch 吞掉（不产生未处理拒绝）', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const notifier = makeThrowingDeps({
        showInfoMessage: () => Promise.resolve(ATTENTION_ACTION),
        showChatView: () => {
          throw new Error('focus 命令不存在');
        },
      });
      notifier.onConfirmShown({ requestId: 'r', label: 'x' });
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toHaveLength(0);
  });
});
