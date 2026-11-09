/**
 * worksView 测试 — 设置页「作品和规则」子视图的渲染与动作入口
 *
 * 🔴 本套件最要紧的一条不是「渲染对不对」，而是**行内按钮不得顺带打开原文件**：
 * 行本身可点（open），行内两颗按钮是 toggle / unregister。生产实现只在列表容器做
 * 一次委托、先判按钮再判行；这条若退化成「行级 click 监听」或改了判定顺序，
 * 点「移除登记」会同时打开正在编辑的文件——单测能红，真机才发现就晚了。
 *
 * 其余钉死：清单文本走 textContent（文件名与简介都不可信）、description 落在卡片内
 * 而不是只靠 hover tooltip、source 只从行的 dataset 取、notice / 空态 / 刷新按钮各有出口。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorksView } from '../scripts/worksView.js';
import type { WorkProjectionRow, WorkProjectionViewState } from '../../shared/workProjectionDto.js';

const ROOT_HTML = `
  <div id="works-root">
    <span id="worksCount" hidden></span>
    <button id="btnRefreshWorks" type="button">刷新</button>
    <div id="worksNotice" hidden></div>
    <div id="worksList"><p class="loading-hint">加载中…</p></div>
  </div>`;

function row(source: string, resident: boolean, hasFailure = false): WorkProjectionRow {
  return {
    source,
    name: source.replace(/\.md$/, ''),
    description: `${source} 的一句话说明`,
    statusText: resident ? '项目规则' : '未设为项目规则',
    // 与派生层同形：说明已进卡片字段，tooltip 不再重复
    tooltip: source,
    resident,
    hasFailure,
  };
}

function mount(): { postMessage: ReturnType<typeof vi.fn>; list: HTMLElement } {
  document.body.innerHTML = ROOT_HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('works-root') as HTMLElement;
  createWorksView({ vscode: { postMessage }, window, root });
  return { postMessage, list: document.getElementById('worksList') as HTMLElement };
}

function push(state: WorkProjectionViewState): void {
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'work_projection', state } }));
}

function rowsState(...rows: WorkProjectionRow[]): WorkProjectionViewState {
  return { kind: 'rows', rows };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('作品子视图：状态渲染', () => {
  it('rows 状态逐条渲染，条数徽标显示真实行数', () => {
    const { list } = mount();
    push(rowsState(row('a.md', true), row('b.md', false, true)));
    const lines = list.querySelectorAll('.works-row');
    expect(lines).toHaveLength(2);
    expect((lines[0] as HTMLElement).dataset.source).toBe('a.md');
    expect((lines[1] as HTMLElement).classList.contains('is-failure')).toBe(true);
    expect(document.getElementById('worksCount')?.textContent).toBe('2 条');
  });

  it('清单文本来自用户可手改的 JSON ⇒ 文件名里的标签不得被解析成 DOM', () => {
    const { list } = mount();
    const hostile = row('x.md', false);
    hostile.name = '<img src=x onerror=alert(1)>';
    push(rowsState(hostile));
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('.works-row-name')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('说明直接显示在卡片内，且不再只靠 hover tooltip 承载', () => {
    const { list } = mount();
    const item = row('a.md', false);
    item.description = '这句是作品简介';
    push(rowsState(item));
    expect(list.querySelector('.works-row-description')?.textContent).toBe('这句是作品简介');
    // 反例判据：说明不得再塞回 title（用户反馈「鼠标放置才显示」正是这个形态）
    const line = list.querySelector<HTMLElement>('.works-row');
    expect(line?.title).not.toContain('这句是作品简介');
  });

  it('说明来自用户可手改的 JSON ⇒ 标签不得被解析成 DOM', () => {
    const { list } = mount();
    const hostile = row('y.md', false);
    hostile.description = '<img src=y onerror=alert(1)>';
    push(rowsState(hostile));
    expect(list.querySelector('img')).toBeNull();
    expect(list.querySelector('.works-row-description')?.textContent).toBe(
      '<img src=y onerror=alert(1)>',
    );
  });

  it('说明为空串 ⇒ 不渲染空行占位（卡片不因缺简介多出一行）', () => {
    const { list } = mount();
    const item = row('z.md', false);
    item.description = '';
    push(rowsState(item));
    expect(list.querySelector('.works-row-description')).toBeNull();
    expect(list.querySelector('.works-row-source')?.textContent).toBe('z.md');
  });

  it('报告不可当作零失效时显示 notice，且带级别', () => {
    mount();
    push({ kind: 'rows', rows: [row('a.md', true)], notice: { text: '尚未求值', level: 'info' } });
    const notice = document.getElementById('worksNotice') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('尚未求值');
    expect(notice.classList.contains('is-warning')).toBe(false);
  });

  it('空态 / 错误态各显示自己的文案，不残留条数徽标', () => {
    mount();
    push({ kind: 'malformed', message: '清单格式异常' });
    expect(document.getElementById('worksCount')?.hidden).toBe(true);
    expect(document.getElementById('worksList')?.textContent).toContain('清单格式异常');
  });
});

describe('作品子视图：动作入口互斥（点按钮 ≠ 打开文件）', () => {
  it('点第 2 行「移除登记」只发 unregister，且 source 命中第 2 行', () => {
    const { postMessage, list } = mount();
    push(rowsState(row('a.md', true), row('b.md', false)));
    const buttons = list.querySelectorAll<HTMLButtonElement>(
      '.works-row:nth-child(2) button[data-action]',
    );
    const remove = Array.from(buttons).find((b) => b.dataset.action === 'unregister');
    expect(remove).toBeDefined();
    remove!.click();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'work_projection',
      action: 'unregister',
      source: 'b.md',
    });
    // 反例判据：不得有任何 open 消息
    expect(postMessage.mock.calls.some((c) => c[0]?.action === 'open')).toBe(false);
  });

  it('点第 1 行「设为项目规则」只发 toggle，source 命中第 1 行', () => {
    const { postMessage, list } = mount();
    push(rowsState(row('a.md', false), row('b.md', false)));
    const toggle = list.querySelector<HTMLButtonElement>(
      '.works-row:nth-child(1) button[data-action="toggle"]',
    );
    toggle!.click();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'work_projection',
      action: 'toggle',
      source: 'a.md',
    });
  });

  it('单击行本身（非按钮）才发 open，source 取该行 dataset', () => {
    const { postMessage, list } = mount();
    push(rowsState(row('a.md', true), row('b.md', false)));
    const secondRow = list.querySelector<HTMLElement>('.works-row:nth-child(2)');
    secondRow!.click();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'work_projection',
      action: 'open',
      source: 'b.md',
    });
  });

  it('页内刷新按钮只发 load', () => {
    const { postMessage } = mount();
    (document.getElementById('btnRefreshWorks') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'work_projection', action: 'load' });
  });
});
