/**
 * rolesView 测试 — 角色管理面板渲染分支（2026-08-17 独立视图）
 *
 * 覆盖新增的角色管理视图渲染路径：
 *   - 顶栏统计（statBar：「已加载 N 个角色」）
 *   - 分区标题（group-title：「当前角色」/「其他角色」）+ 激活角色置顶
 *   - 激活徽章（badge：「当前」）+ 能力标签 chips（cap-chip 中文 label + title 原始能力名）
 *   - 空态引导（empty-state）
 *   - 「设为当前」按钮 → postMessage roles_set_active（host 切换 + 持久化 + 重推）
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createRolesView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRolesView } from '../scripts/rolesView.js';

/** 覆盖 createRolesView 全部 getElementById 引用的最小 HTML 骨架 */
const HTML = `
  <div class="header">
    <h2>角色</h2>
    <span id="statBar" class="stat-bar" hidden></span>
  </div>
  <div id="list"><p class="hint">加载中…</p></div>
  <p class="footer-hint">角色决定对话定位与可用能力，切换后长期生效。</p>
`;

/** 挂载 createRolesView 并返回 postMessage mock */
function mountRolesView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  createRolesView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  return { postMessage };
}

/** 向 webview 分发一条 roles_loaded 消息，驱动 render */
function dispatchLoaded(packs: unknown[], activeName: string): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'roles_loaded', packs, activeName },
    }),
  );
}

describe('rolesView 渲染（2026-08-17 独立角色管理视图）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('roles_loaded 渲染角色卡片：激活角色置顶带徽章，其余归「其他角色」', () => {
    mountRolesView();
    dispatchLoaded(
      [
        { name: 'doc-review', displayName: '文档打磨', description: '打磨文档', capabilities: [] },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const list = document.getElementById('list') as HTMLElement;
    // 顶栏统计
    expect(document.getElementById('statBar')?.textContent).toBe('已加载 2 个角色');
    // 分组：当前角色（doc-review 带徽章）→ 其他角色
    const groups = list.querySelectorAll('.group-title');
    expect(groups[0]?.textContent).toBe('当前角色');
    expect(groups[1]?.textContent).toBe('其他角色');
    const cards = list.querySelectorAll('.card');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.classList.contains('active')).toBe(true);
    // badge 内嵌于 .card-name（文本节点 + 徽章 span），名称部分包含「文档打磨」
    expect(cards[0]?.querySelector('.card-name')?.textContent).toContain('文档打磨');
    expect(cards[0]?.querySelector('.badge')?.textContent).toBe('当前');
    // 激活角色无「设为当前」，其他角色有
    expect(cards[0]?.querySelector('.btn')).toBeNull();
    expect(cards[1]?.querySelector('.card-name')?.textContent).toBe('翻译助手');
    expect(cards[1]?.querySelector('.btn')?.textContent).toBe('设为当前');
  });

  it('能力标签 chips：展示 host 翻译的中文 label，title 承载原始能力名', () => {
    mountRolesView();
    dispatchLoaded(
      [
        {
          name: 'doc-review',
          displayName: '文档打磨',
          capabilities: [
            { capability: 'file:read', label: '读取文件' },
            { capability: 'llm:summarize', label: '摘要生成' },
          ],
        },
      ],
      'doc-review',
    );
    const chips = document.querySelectorAll('.cap-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe('读取文件');
    expect(chips[0]?.getAttribute('title')).toBe('file:read');
    expect(chips[1]?.textContent).toBe('摘要生成');
  });

  it('「设为当前」→ postMessage roles_set_active（host 切换 + 持久化 + 重推）', () => {
    const { postMessage } = mountRolesView();
    dispatchLoaded(
      [
        { name: 'doc-review', displayName: '文档打磨', capabilities: [] },
        { name: 'translator', displayName: '翻译助手', capabilities: [] },
      ],
      'doc-review',
    );
    const btn = document.querySelector('.card:not(.active) .btn') as HTMLButtonElement;
    btn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'roles_set_active', name: 'translator' });
  });

  it('roles_loaded 空列表 → 渲染空态引导', () => {
    mountRolesView();
    dispatchLoaded([], '');
    expect(document.querySelector('.empty-title')?.textContent).toBe('暂无角色包');
    expect(document.querySelector('.empty-hint')?.textContent).toContain('打开一个工作区');
  });
});
