/**
 * contextMenu 组件测试 — 场合命中判据单点 + 交互语义（COPY-2）
 *
 * 用 @vitest-environment jsdom 提供 DOM 环境（per-file，同 dropdown.test.ts 先例）。
 * 覆盖：
 *   - resolveContextMenuCtx：message / code 场合判定与 dataset 锚点读取（判据单点回归）
 *   - initContextMenu：场合过滤渲染、文本落点放行（输入框原生右键）、
 *     无可显项放行、点击项 run + 关闭、点外关闭、Escape 关闭（共享导航）
 *   - selection 优先级（mock getSelection）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initContextMenu, resolveContextMenuCtx, type ContextMenuItem } from '../components/contextMenu.js';

/** 测试挂载宏：构造含 assistant/user 消息、代码块、输入框的最小聊天 DOM */
function mountChat(): void {
  document.body.innerHTML = `
    <div class="msg assistant" data-round-id="r1" data-ts="t1" data-raw-text="**AI 回复** md">
      <div class="msg-body"><p>AI 回复文本</p><pre><code class="language-js">const a = 1;</code></pre></div>
    </div>
    <div class="msg user" data-ts="t0"><div class="msg-body"><p>用户提问</p></div></div>
    <textarea id="input"></textarea>
    <div id="outside">外部区域</div>
  `;
}

/** 向目标派发 contextmenu 事件（可断言 defaultPrevented） */
function ctxClick(target: Element): MouseEvent {
  const e = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  });
  target.dispatchEvent(e);
  return e;
}

function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

/** 测试菜单项全集（run 全部 vi.fn，由本宏返回供断言；dispose 供 afterEach 卸载 document 级监听） */
function mountMenu(): { runs: Record<string, ReturnType<typeof vi.fn>>; dispose(): void } {
  const runs: Record<string, ReturnType<typeof vi.fn>> = {
    'copy-message': vi.fn(),
    'copy-code': vi.fn(),
    regenerate: vi.fn(),
    delete: vi.fn(),
  };
  const items: ContextMenuItem[] = [
    { id: 'copy-message', label: '复制本条', when: (c) => c.kind === 'message', run: runs['copy-message'] },
    { id: 'copy-code', label: '复制代码', when: (c) => c.kind === 'code', run: runs['copy-code'] },
    {
      id: 'regenerate',
      label: '重新生成',
      when: (c) => c.kind === 'message' && !!c.messageEl?.classList.contains('assistant') && !!c.turnTs,
      run: runs.regenerate,
    },
    {
      id: 'delete',
      label: '删除',
      danger: true,
      when: (c) => c.kind === 'message' && !!c.turnTs,
      run: runs.delete,
    },
  ];
  const { dispose } = initContextMenu(document, items);
  return { runs, dispose };
}

describe('resolveContextMenuCtx 场合命中判据（单点）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mountChat();
  });

  it('message 场合：命中 .msg 并带出 dataset 锚点', () => {
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const ctx = resolveContextMenuCtx(msg.querySelector('p') as Element);
    expect(ctx?.kind).toBe('message');
    expect(ctx?.roundId).toBe('r1');
    expect(ctx?.turnTs).toBe('t1');
    expect(ctx?.rawText).toBe('**AI 回复** md');
    expect(ctx?.visibleText).toContain('AI 回复文本');
  });

  it('code 场合：命中 pre code 带出代码文本（优先于 message）', () => {
    const ctx = resolveContextMenuCtx(document.querySelector('pre code') as Element);
    expect(ctx?.kind).toBe('code');
    expect(ctx?.codeText).toBe('const a = 1;');
  });

  it('无 .msg 宿主 → null（不弹菜单不拦截）', () => {
    expect(resolveContextMenuCtx(document.getElementById('outside'))).toBeNull();
  });
});

describe('initContextMenu 交互语义', () => {
  let disposeMenu: (() => void) | null = null;
  let runs: Record<string, ReturnType<typeof vi.fn>>;
  beforeEach(() => {
    document.body.innerHTML = '';
    mountChat();
  });
  afterEach(() => {
    // initContextMenu 监听挂在 document（全局单例）上：不卸载会跨测试叠加成多菜单
    disposeMenu?.();
    disposeMenu = null;
  });

  it('右键 assistant 消息条：拦截原生 + 按场合过滤渲染（message 3 项，不含 code 项）', () => {
    ({ dispose: disposeMenu } = mountMenu());
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const e = ctxClick(msg.querySelector('p') as Element);
    expect(e.defaultPrevented).toBe(true);
    const menu = document.querySelector('.ctxmenu') as HTMLElement;
    expect(menu).toBeTruthy();
    const ids = Array.from(menu.querySelectorAll('.ctxmenu__item')).map((b) =>
      b.getAttribute('data-ctxmenu-id'),
    );
    expect(ids).toEqual(['copy-message', 'regenerate', 'delete']);
  });

  it('右键 user 消息：regenerate 因 when 判 assistant 不出现', () => {
    ({ dispose: disposeMenu } = mountMenu());
    ctxClick(document.querySelector('.msg.user p') as Element);
    const ids = Array.from(document.querySelectorAll('.ctxmenu__item')).map((b) =>
      b.getAttribute('data-ctxmenu-id'),
    );
    expect(ids).toEqual(['copy-message', 'delete']);
  });

  it('右键代码块：code 场合（code 项独占）', () => {
    ({ dispose: disposeMenu } = mountMenu());
    ctxClick(document.querySelector('pre code') as Element);
    const ids = Array.from(document.querySelectorAll('.ctxmenu__item')).map((b) =>
      b.getAttribute('data-ctxmenu-id'),
    );
    expect(ids).toEqual(['copy-code']);
  });

  it('右键输入框：原生放行（不 preventDefault、无菜单）', () => {
    ({ dispose: disposeMenu } = mountMenu());
    const e = ctxClick(document.getElementById('input') as Element);
    expect(e.defaultPrevented).toBe(false);
    expect(document.querySelector('.ctxmenu')).toBeNull();
  });

  it('点击菜单项：run 收到 ctx + 菜单关闭', () => {
    ({ runs, dispose: disposeMenu } = mountMenu());
    ctxClick(document.querySelector('.msg.assistant p') as Element);
    const item = document.querySelector('[data-ctxmenu-id="copy-message"]') as HTMLElement;
    item.click();
    expect(runs['copy-message']).toHaveBeenCalledTimes(1);
    const arg = runs['copy-message'].mock.calls[0][0];
    expect(arg.turnTs).toBe('t1');
    expect(document.querySelector('.ctxmenu')).toBeNull();
  });

  it('再次右键 = 替换菜单（不残留旧菜单）；点击外部关闭', () => {
    ({ dispose: disposeMenu } = mountMenu());
    ctxClick(document.querySelector('.msg.assistant p') as Element);
    ctxClick(document.querySelector('.msg.user p') as Element);
    const menus = document.querySelectorAll('.ctxmenu');
    expect(menus.length).toBe(1);
    (document.getElementById('outside') as HTMLElement).click();
    expect(document.querySelector('.ctxmenu')).toBeNull();
  });

  it('Escape 关闭（共享键盘导航）', () => {
    ({ dispose: disposeMenu } = mountMenu());
    ctxClick(document.querySelector('.msg.assistant p') as Element);
    const first = document.querySelector('.ctxmenu__item') as HTMLElement;
    key(first, 'Escape');
    expect(document.querySelector('.ctxmenu')).toBeNull();
  });

  it('selection 优先（mock getSelection）：同一消息条上有选区 → selection 场合', () => {
    const spy = vi
      .spyOn(window, 'getSelection')
      .mockReturnValue({ toString: () => '选中的文字' } as Selection);
    try {
      const seen: string[] = [];
      ({ dispose: disposeMenu } = initContextMenu(document, [
        { id: 'a-msg', label: '消息项', when: (c) => (seen.push(c.kind), c.kind === 'message'), run: () => {} },
        { id: 'a-sel', label: '选区项', when: (c) => c.kind === 'selection', run: () => {} },
      ]));
      ctxClick(document.querySelector('.msg.assistant p') as Element);
      const ids = Array.from(document.querySelectorAll('.ctxmenu__item')).map((b) =>
        b.getAttribute('data-ctxmenu-id'),
      );
      expect(ids).toEqual(['a-sel']);
      expect(seen.every((k) => k === 'selection')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
