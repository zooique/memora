/**
 * settingsView 测试 — 设置视图选项卡切换 + 子视图挂载（2026-08-17 选项卡合并）
 *
 * 覆盖设置视图（合并 角色 / 大模型 / 记忆 三个子视图）的新增行为：
 *   - 挂载即发送三个子视图的初始消息（cfg_load / memory_load / ready）
 *   - 初始选项卡为「角色」（roles-root 可见，config/memory 隐藏）
 *   - 点击选项卡按钮切换（config-root 显示 + 按钮高亮 + aria-selected）
 *   - settings_switch_tab 消息切换（configureModel 命令路径）
 *   - id 空间隔离：各子视图数据只渲染进各自根容器（不跨根串扰）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createSettingsView 工厂驱动。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createSettingsView } from '../scripts/settingsView.js';
import type { MemoryItemDto } from '../../shared/protocol.js';

/** 覆盖 createSettingsView 全部查询引用 + 三个子视图骨架的最小 HTML */
const HTML = `
  <div class="tabs">
    <button class="tab-btn active" data-tab="roles">角色</button>
    <button class="tab-btn" data-tab="config">大模型</button>
    <button class="tab-btn" data-tab="memory">记忆</button>
  </div>
  <div id="roles-root">
    <div class="header"><h2>角色</h2><span id="statBar" class="stat-bar" hidden></span></div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">角色决定对话定位与可用能力，切换后长期生效。</p>
  </div>
  <div id="config-root" hidden>
    <div class="header"><h2>大模型配置</h2><span id="statBar" class="stat-bar" hidden></span><button id="btnAdd" class="btn">添加 API</button></div>
    <div id="list"></div>
    <div id="modal" class="modal-mask">
      <div class="modal">
        <h3 id="modalTitle"></h3>
        <form id="cfgForm">
          <input id="f-name" /><input id="f-display" /><input id="f-model" /><input id="f-baseurl" /><input id="f-apikey" />
          <div id="apikeyHint" hidden></div><div id="testResult" hidden></div>
          <button id="btnTest" type="button"></button><button id="btnCancel" type="button"></button><button id="btnSave" type="submit"></button>
        </form>
      </div>
    </div>
    <div id="toast"></div>
  </div>
  <div id="memory-root" hidden>
    <div class="header"><h2>记忆</h2><span id="statBar" class="stat-bar" hidden></span></div>
    <div class="search-wrap"><input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" /></div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>
  </div>
`;

/** 挂载 createSettingsView 并返回 postMessage mock */
function mountSettingsView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  createSettingsView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  return { postMessage };
}

describe('settingsView 选项卡切换（2026-08-17 合并角色/大模型/记忆）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载即发送三个子视图的初始消息（cfg_load / memory_load / ready）', () => {
    const { postMessage } = mountSettingsView();
    // 挂载顺序 config → memory → roles（roles 的 ready 在末尾，host 据此整体就绪）
    expect(postMessage).toHaveBeenCalledWith({ type: 'cfg_load' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_load' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('初始选项卡为「角色」：roles-root 可见，config/memory 隐藏', () => {
    mountSettingsView();
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('config-root') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(true);
  });

  it('点击选项卡按钮切换：config-root 显示、roles 隐藏、按钮高亮', () => {
    mountSettingsView();
    const configBtn = document.querySelector('.tab-btn[data-tab="config"]') as HTMLButtonElement;
    configBtn.click();
    expect((document.getElementById('config-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(true);
    expect(configBtn.classList.contains('active')).toBe(true);
    expect(configBtn.getAttribute('aria-selected')).toBe('true');
    // 原激活按钮（角色）取消高亮
    expect(
      document.querySelector('.tab-btn[data-tab="roles"]')?.classList.contains('active'),
    ).toBe(false);
  });

  it('settings_switch_tab 消息切换选项卡（configureModel 命令路径）', () => {
    mountSettingsView();
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'settings_switch_tab', tab: 'memory' } }),
    );
    expect((document.getElementById('memory-root') as HTMLElement).hidden).toBe(false);
    expect((document.getElementById('roles-root') as HTMLElement).hidden).toBe(true);
    expect(
      document.querySelector('.tab-btn[data-tab="memory"]')?.classList.contains('active'),
    ).toBe(true);
  });

  it('id 空间隔离：各子视图数据只渲染进各自根容器（不跨根串扰）', () => {
    mountSettingsView();
    // 角色数据 → 只进 roles-root
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'roles_loaded',
          packs: [{ name: 'doc-review', displayName: '文档打磨', capabilities: [] }],
          activeName: 'doc-review',
        },
      }),
    );
    expect(document.querySelector('#roles-root .card')).not.toBeNull();
    expect(document.querySelector('#roles-root .card-name')?.textContent).toContain('文档打磨');
    // 大模型数据 → 只进 config-root（roles-root 不受影响）
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'cfg_loaded',
          providers: [
            {
              name: 'deepseek',
              displayName: 'DeepSeek',
              model: 'deepseek-chat',
              baseUrl: 'https://api.example.com/v1',
              apiKey: '',
              provider: 'remote',
            },
          ],
          activeName: 'deepseek',
        },
      }),
    );
    expect(document.querySelector('#config-root .card')).not.toBeNull();
    expect(document.querySelector('#config-root .card-name')?.textContent).toContain('DeepSeek');
    // roles-root 卡片未被 config 数据污染
    expect(document.querySelector('#roles-root .card-name')?.textContent).toContain('文档打磨');
    // 记忆数据 → 只进 memory-root
    const mem: MemoryItemDto = {
      id: 'round-summary:设计决策',
      name: '设计决策',
      source: 'round-summary',
      score: 0.9,
      content: '确认合并选项卡。',
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'memory_loaded', stats: { total: 1, bySource: { 'round-summary': 1 } }, memories: [mem] },
      }),
    );
    expect(document.querySelector('#memory-root .mem-card')).not.toBeNull();
    expect(document.querySelector('#memory-root .mem-card-name')?.textContent).toContain('设计决策');
  });
});
