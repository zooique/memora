/**
 * toast helper 单测（UI-TOAST-1 三面收口的单一实现）
 *
 * 覆盖面：
 *   - info / error 分级（类名契约：.settings-toast + .show [+ .error]）
 *   - 单元素复用（连续 notice 不建第二个节点）
 *   - 2.5s 自动隐藏 + 重触发 clearTimeout 重置（前一条的定时器不得提前撤掉后一条）
 *   - textContent 渲染防注入（XXS：宿主下发的用户可控文本不进 DOM 结构）
 *   - defaultView 缺失（脱离文档的 Document）⇒ 不排自动隐藏、不崩
 *
 * 形态契约（z 层 / 阴影 / error 变体令牌）由 settingsStyles 承载，jsdom 无布局引擎
 * 证不了浮层形态 ⇒ 用源码守卫钉在 settingsView.test.ts（与 chatStyles 的 toast 守卫同批）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showToast, TOAST_DURATION_MS } from '../toast.js';

describe('showToast（UI-TOAST-1 单一实现）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('时长常量为 2.5s（三面对齐：settings notice / config 反馈 / chat 活动条）', () => {
    expect(TOAST_DURATION_MS).toBe(2500);
  });

  it('info ⇒ 懒创建 #settings-toast 并挂 body，.show 可见、无 .error', () => {
    showToast(document, 'info', '已切换网页搜索引擎');
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast).not.toBeNull();
    expect(toast.parentElement).toBe(document.body);
    expect(toast.className).toBe('settings-toast show');
    expect(toast.textContent).toBe('已切换网页搜索引擎');
  });

  it('error ⇒ .error 变体类（标红醒目由 .settings-toast.error 样式承载）', () => {
    showToast(document, 'error', '角色包不存在：x');
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.className).toBe('settings-toast error show');
  });

  it('单元素复用：连续展示不建第二个节点', () => {
    showToast(document, 'info', '第一条');
    showToast(document, 'error', '第二条');
    expect(document.querySelectorAll('#settings-toast')).toHaveLength(1);
    expect((document.getElementById('settings-toast') as HTMLElement).textContent).toBe('第二条');
  });

  it('2.5s 后自动隐藏（移除 .show，元素留存复用）', () => {
    showToast(document, 'info', '提示');
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(toast.classList.contains('show')).toBe(false);
    expect(document.getElementById('settings-toast')).not.toBeNull();
  });

  it('🔴 重触发重置计时器：前一条的定时器不得提前撤掉后一条', () => {
    showToast(document, 'info', '第一条');
    vi.advanceTimersByTime(2000); // 第一条还剩 500ms 时第二条到达
    showToast(document, 'info', '第二条');
    vi.advanceTimersByTime(2000); // 距第一条 4000ms（已过期）、距第二条 2000ms（未到）
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.textContent).toBe('第二条');
    expect(toast.classList.contains('show')).toBe(true);
    vi.advanceTimersByTime(TOAST_DURATION_MS - 2000); // 走完第二条的 2.5s
    expect(toast.classList.contains('show')).toBe(false);
  });

  it('textContent 渲染防注入（XXS：`<img onerror>` 不进 DOM）', () => {
    showToast(document, 'info', '<img src=x onerror=alert(1)>');
    const toast = document.getElementById('settings-toast') as HTMLElement;
    expect(toast.querySelector('img')).toBeNull();
    expect(toast.textContent).toContain('<img');
  });

  it('defaultView 缺失（脱离文档的 Document）⇒ 照常展示、不排自动隐藏、不崩', () => {
    // DOMParser 产出的 Document 不带 defaultView（jsdom 语义）⇒ 走降级分支
    const detached = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(detached.defaultView).toBeNull();
    showToast(detached, 'error', '离线提示');
    const toast = detached.getElementById('settings-toast') as HTMLElement;
    expect(toast.className).toBe('settings-toast error show');
    expect(toast.textContent).toBe('离线提示');
  });
});
