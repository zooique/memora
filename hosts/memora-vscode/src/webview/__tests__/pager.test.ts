/**
 * pager 通用分页组件单元测试（2026-09-08）
 *
 * 覆盖分页状态机核心契约：
 *   - show() 填充当前页 → renderPage 收到对应 items（翻页数据通道）
 *   - 首页/末页按钮禁用态 + total 未知时「满页=还有下一页」判定
 *   - 单页自动隐藏（小数据量不暴露分页 UI）+ setEnabled 停用
 *   - reset() 回第 1 页并触发 fetchPage(1)
 * 用 jsdom 环境 + 纯 DOM 骨架驱动，不依赖子视图。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPager } from '../scripts/pager.js';

/** 挂载最小骨架并返回分页控制器 + 记录工具 */
function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root') as HTMLElement;
  const fetchLog: Array<{ page: number; size: number }> = [];
  let lastPage: string[] = [];
  const controller = createPager<string>({
    root,
    mountRoot: root,
    pageSize: 10,
    renderPage: (items) => {
      lastPage = [...items];
    },
    fetchPage: (page, size) => {
      fetchLog.push({ page, size });
    },
  });
  return { root, controller, fetchLog, getLast: () => lastPage };
}

describe('pager 通用分页组件', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('总数据 25 条 / 每页 10 → 分页条可见 + 计数「第 1 / 3 页」+ 首页上一页禁用', () => {
    const { controller } = mount();
    controller.show(1, Array.from({ length: 10 }, (_, i) => `a${i}`), 25);
    const bar = document.querySelector('.pager-bar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.pager-info')?.textContent).toBe('第 1 / 3 页（共 25 条）');
    expect((bar.querySelectorAll('.pager-btn')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((bar.querySelectorAll('.pager-btn')[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('next() 触发 fetchPage(2) 且未回填前不动 render；show 回填后渲染新页', () => {
    const { controller, fetchLog, getLast } = mount();
    controller.show(1, Array.from({ length: 10 }, (_, i) => `a${i}`), 25);
    controller.next();
    expect(fetchLog).toContainEqual({ page: 2, size: 10 });
    // 未回填前保持上一页数据（组件不自造数据）
    expect(getLast()[0]).toBe('a0');
    controller.show(2, Array.from({ length: 10 }, (_, i) => `b${i}`), 25);
    expect(getLast()[0]).toBe('b0');
    expect(document.querySelector('.pager-info')?.textContent).toBe('第 2 / 3 页（共 25 条）');
  });

  it('末页 next() 拒绝（越界钳制）；prev() 正常回退', () => {
    const { controller, fetchLog } = mount();
    controller.show(3, Array.from({ length: 5 }, (_, i) => `c${i}`), 25);
    expect((document.querySelectorAll('.pager-btn')[1] as HTMLButtonElement).disabled).toBe(true);
    controller.next();
    expect(fetchLog).toHaveLength(0); // 末页 next no-op，不触发取数
    controller.prev();
    expect(fetchLog).toContainEqual({ page: 2, size: 10 });
  });

  it('total 未知（undefined）→ 满页（items.length === pageSize）判定还有下一页', () => {
    const { controller, fetchLog } = mount();
    controller.show(1, Array.from({ length: 10 }, (_, i) => `a${i}`)); // 无 total
    expect((document.querySelectorAll('.pager-btn')[1] as HTMLButtonElement).disabled).toBe(false);
    controller.next();
    expect(fetchLog).toContainEqual({ page: 2, size: 10 });
    // 非满页（不足 pageSize）→ 视为无更多
    controller.show(2, ['only-one']);
    expect((document.querySelectorAll('.pager-btn')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('单页自动隐藏（pageCount=1）——小数据量不暴露分页 UI', () => {
    const { controller } = mount();
    controller.show(1, new Array(8).fill('x'), 8);
    expect((document.querySelector('.pager-bar') as HTMLElement).hidden).toBe(true);
  });

  it('setEnabled(false) 停用隐藏；show() 恢复可见', () => {
    const { controller } = mount();
    controller.show(1, new Array(10).fill('a'), 30);
    expect((document.querySelector('.pager-bar') as HTMLElement).hidden).toBe(false);
    controller.setEnabled(false);
    expect((document.querySelector('.pager-bar') as HTMLElement).hidden).toBe(true);
    controller.setEnabled(true);
    expect((document.querySelector('.pager-bar') as HTMLElement).hidden).toBe(false);
  });

  it('reset() 清分页态并触发 fetchPage(1)', () => {
    const { controller, fetchLog } = mount();
    controller.show(1, new Array(10).fill('a'), 30);
    controller.next(); // 翻到第 2 页（取数记录第 2 页）
    fetchLog.length = 0;
    controller.reset();
    expect(fetchLog).toEqual([{ page: 1, size: 10 }]);
    // reset 后无数据 → 分页条隐藏（等下次 fetch 回填）
    expect((document.querySelector('.pager-bar') as HTMLElement).hidden).toBe(true);
  });
});