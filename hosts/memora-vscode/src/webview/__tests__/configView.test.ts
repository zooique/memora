/**
 * configView 测试 — 大模型配置面板渲染分支（ui-redesign.md §6.2 新增）
 *
 * 覆盖本次 UI 重构新增的渲染路径：
 *   - 顶栏统计（statBar：「已配置 N 个 API」）
 *   - 分区标题（group-title：「激活 Provider」/「其他 Provider」）
 *   - 卡片图标（cfg-icon：Provider 首字）
 *   - 空态引导（empty-state）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createConfigView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createConfigView } from '../scripts/configView.js';

/** 覆盖 createConfigView 全部查询引用的最小 HTML 骨架（子视图挂载在 #config-root 根容器内，
 *  与设置视图选项卡合并后的 id 空间隔离约定一致） */
const HTML = `
  <div id="config-root">
    <div class="header">
      <h2>大模型配置</h2>
      <span id="statBar" class="stat-bar" hidden></span>
      <button id="btnAdd" class="btn">添加 API</button>
    </div>
    <div id="list"></div>
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle"></h3>
        <form id="cfgForm">
          <input id="f-name" />
          <input id="f-display" />
          <input id="f-model" />
          <input id="f-baseurl" />
          <input id="f-apikey" />
          <div id="apikeyHint" hidden></div>
          <div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button>
          <button id="btnCancel" type="button"></button>
          <button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
    <div id="toast"></div>
  </div>
`;

/** 挂载 createConfigView 并返回 postMessage mock */
function mountConfigView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('config-root') as HTMLElement;
  createConfigView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
    root,
  });
  return { postMessage };
}

/** 向 webview 分发一条 cfg_loaded 消息，驱动 render */
function dispatchLoaded(providers: unknown[], activeName?: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'cfg_loaded', providers, activeName },
    }),
  );
}

/** 构造一个 Provider 对象 */
function makeProvider(name: string, opts: { displayName?: string; model?: string; baseUrl?: string } = {}) {
  return {
    name,
    displayName: opts.displayName || name,
    model: opts.model || name + '-model',
    baseUrl: opts.baseUrl || 'https://api.example.com/v1',
    provider: 'remote',
  };
}

describe('configView 渲染分支（ui-redesign §6.2）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送 cfg_load 初始拉取列表', () => {
    const { postMessage } = mountConfigView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_load' });
  });

  it('空列表：渲染顶栏统计 + 空态引导，无分区标题', () => {
    mountConfigView();
    dispatchLoaded([]);

    const statBar = document.getElementById('statBar') as HTMLElement;
    expect(statBar.hidden).toBe(false);
    expect(statBar.textContent).toBe('已配置 0 个 API');

    const list = document.getElementById('list') as HTMLElement;
    expect(list.querySelector('.empty-state')).not.toBeNull();
    expect(list.querySelector('.empty-title')?.textContent).toBe('配置你的大模型');
    expect(list.querySelector('.group-title')).toBeNull();
  });

  it('单 Provider：渲染「激活 Provider」分区 + 卡片图标 + 当前徽章', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek')], 'deepseek');

    const list = document.getElementById('list') as HTMLElement;
    // 分区标题：仅激活分区
    const titles = list.querySelectorAll('.group-title');
    expect(titles.length).toBe(1);
    expect(titles[0].textContent).toBe('激活 Provider');

    const card = list.querySelector('.card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.classList.contains('active')).toBe(true);
    // 卡片图标：首字大写
    const icon = card.querySelector('.cfg-icon') as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.textContent).toBe('D');
    // 当前徽章
    expect(card.querySelector('.badge')?.textContent).toBe('当前');
  });

  it('多 Provider：激活与其他分区分离渲染', () => {
    mountConfigView();
    dispatchLoaded(
      [makeProvider('deepseek'), makeProvider('local', { displayName: '本地' })],
      'deepseek',
    );

    const list = document.getElementById('list') as HTMLElement;
    const titles = Array.from(list.querySelectorAll('.group-title')).map((t) => t.textContent);
    expect(titles).toEqual(['激活 Provider', '其他 Provider']);

    // 卡片顺序：激活在前，其他在后
    const icons = Array.from(list.querySelectorAll('.cfg-icon')).map((i) => i.textContent);
    expect(icons).toEqual(['D', '本']);
  });

  it('详情报文：保留 model · baseUrl 拼接', () => {
    mountConfigView();
    dispatchLoaded([makeProvider('deepseek')], 'deepseek');

    const list = document.getElementById('list') as HTMLElement;
    const detail = list.querySelector('.card-detail') as HTMLElement;
    expect(detail.textContent).toBe('deepseek-model · https://api.example.com/v1');
  });
});