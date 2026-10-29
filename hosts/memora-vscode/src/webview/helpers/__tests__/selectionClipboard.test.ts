// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText, installSelectionCopyGuard } from '../selectionClipboard.js';

function setBodySelection(text: string): void {
  const el = document.createElement('div');
  el.textContent = text;
  document.body.appendChild(el);
  const sel = window.getSelection();
  if (!sel) throw new Error('no selection');
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function dispatchCopy(): { ev: ClipboardEvent; setData: ReturnType<typeof vi.fn> } {
  const setData = vi.fn();
  const ev = new Event('copy', { cancelable: true }) as ClipboardEvent;
  Object.defineProperty(ev, 'clipboardData', { configurable: true, value: { setData } });
  document.dispatchEvent(ev);
  return { ev, setData };
}

describe('installSelectionCopyGuard（Layer A 选区复制兜底）', () => {
  beforeEach(() => {
    clearSelection();
    installSelectionCopyGuard();
  });
  afterEach(() => {
    clearSelection();
    vi.restoreAllMocks();
  });

  it('有文档选区 → 同步写 clipboardData 并 preventDefault（修复复制不出）', () => {
    setBodySelection('hello world');
    const { ev, setData } = dispatchCopy();
    expect(setData).toHaveBeenCalledWith('text/plain', 'hello world');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('无选区 → 放行原生复制（不写盘、不 preventDefault）', () => {
    clearSelection();
    const { ev, setData } = dispatchCopy();
    expect(setData).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('输入框 <textarea> 选区不计入 getSelection → 放行原生（不与 Ctrl+C 打架）', () => {
    const ta = document.createElement('textarea');
    ta.value = 'secret-input';
    document.body.appendChild(ta);
    ta.select();
    // textarea 选区不计入 window.getSelection —— 这是 guard 能安全放行输入复制的前提
    expect(window.getSelection()?.toString()).toBe('');
    const { ev, setData } = dispatchCopy();
    expect(setData).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    document.body.removeChild(ta);
  });

  it('重复调用幂等（只挂一次，不抛错）', () => {
    expect(() => installSelectionCopyGuard()).not.toThrow();
  });
});

describe('copyText（SSOT：原 chatView.copyText 外置）', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('优先调用 navigator.clipboard.writeText', () => {
    copyText('payload');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('payload');
  });
});
