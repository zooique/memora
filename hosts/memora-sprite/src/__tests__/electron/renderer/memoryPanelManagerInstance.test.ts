/**
 * 记忆面板管理器实例方法测试
 *
 * 覆盖范围：
 * - renderMemoryList：列表渲染 + 空状态 + 分页
 * - showMemoryDetail：详情弹窗 + 编辑模式
 * - getAddMemoryFormData / clearAddMemoryForm：表单数据
 * - 回调注册：onMemorySearch/onMemoryFilter/onMemoryClick 等
 * - cleanup：资源清理
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryPanelManager } from '../../../electron/renderer/panels/memoryPanelManager.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { MemoryListItem, MemoryDetail, RelationPath } from '../../../electron/renderer/types.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock host */
function createMockHost() {
  return {
    showModal: vi.fn(),
    showConfirmDialog: vi.fn().mockResolvedValue(true),
  };
}

/** 创建记忆列表项 */
function makeMemory(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'test-1',
    name: '测试记忆',
    source: 'insight',
    score: 0.85,
    contentPreview: '这是预览内容',
    createdAt: '2026-06-27T10:00:00Z',
    ...overrides,
  };
}

/** 创建记忆详情 */
function makeDetail(overrides: Partial<MemoryDetail> = {}): MemoryDetail {
  return {
    id: 'detail-1',
    name: '详情记忆',
    source: 'profile',
    score: 0.92,
    content: '完整内容',
    createdAt: '2026-06-27T10:00:00Z',
    accessedAt: '2026-06-27T12:00:00Z',
    // 默认空关联列表（showMemoryDetail 会访问 .length，需初始化）
    relations: [],
    ...overrides,
  };
}

/** 创建完整的 DOM 环境（记忆面板所需元素） */
function setupDOM(): void {
  document.body.innerHTML = `
    <div id="memory-list"></div>
    <input id="memory-search" type="text" />
    <select id="memory-filter-source">
      <option value="">全部</option>
      <option value="insight">洞察</option>
    </select>
    <div id="memory-detail-modal">
      <h3 id="memory-detail-name"></h3>
      <code id="memory-detail-source"></code>
      <span id="memory-detail-score"></span>
      <span id="memory-detail-created"></span>
      <span id="memory-detail-accessed"></span>
      <pre id="memory-detail-content"></pre>
      <div id="memory-detail-relations" class="hidden">
        <div id="memory-relations-list"></div>
      </div>
      <div id="memory-detail-lineage" class="hidden">
        <div id="memory-lineage-list"></div>
      </div>
      <button id="btn-memory-edit">编辑</button>
      <button id="btn-memory-delete">删除</button>
      <button id="btn-memory-discuss">在对话中讨论</button>
      <button id="btn-memory-edit-save">保存</button>
      <button id="btn-memory-edit-cancel">取消</button>
    </div>
    <div id="memory-add-modal">
      <input id="memory-add-source" type="text" />
      <input id="memory-add-name" type="text" />
      <textarea id="memory-add-content"></textarea>
      <button id="btn-add-memory">添加</button>
      <button id="btn-memory-add-confirm">确认</button>
    </div>
  `;
}

beforeEach(() => {
  setupDOM();
});

// ─── renderMemoryList ─────────────────────────────────────

describe('renderMemoryList', () => {
  it('空列表应显示空状态 + 添加引导按钮', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([]);

    const list = document.getElementById('memory-list')!;
    expect(list.querySelector('.empty-state')).not.toBeNull();
    expect(list.querySelector('.empty-action-btn')?.textContent).toContain('添加第一条记忆');
  });

  it('空状态的添加按钮点击应调用 showModal', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([]);
    const btn = document.querySelector('.empty-action-btn') as HTMLButtonElement;
    btn.click();

    expect(host.showModal).toHaveBeenCalledWith('memory-add-modal');
  });

  it('单条记忆应渲染一个 memory-item', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([makeMemory()]);

    const items = document.querySelectorAll('.memory-item');
    expect(items.length).toBe(1);
  });

  it('记忆项应包含 name/source-tag/score/preview', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);
    mgr.renderMemoryList([makeMemory({ name: '测试名', source: 'profile', score: 0.5, contentPreview: '预览文本' })]);

    const item = document.querySelector('.memory-item')!;
    expect(item.querySelector('.name')?.textContent).toBe('测试名');
    expect(item.querySelector('.source-tag')?.textContent).toBe('profile');
    expect(item.querySelector('.score')?.textContent).toBe('权重: 0.50');
    expect(item.querySelector('.preview')?.textContent).toBe('预览文本');
  });

  it('记忆项应设置 data-action 和 data-memory-id', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([makeMemory({ id: 'mem-123' })]);

    const item = document.querySelector('.memory-item') as HTMLElement;
    expect(item.dataset.action).toBe('view-memory');
    expect(item.dataset.memoryId).toBe('mem-123');
  });

  it('有 createdAt 时应显示时间', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([makeMemory({ createdAt: '2026-06-27T10:00:00Z' })]);

    expect(document.querySelector('.memory-time')).not.toBeNull();
  });

  it('无 createdAt 时不应显示时间', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([makeMemory({ createdAt: undefined })]);

    expect(document.querySelector('.memory-time')).toBeNull();
  });

  it('memoryListEl 为 null 时应静默降级（不抛错）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    expect(() => mgr.renderMemoryList([makeMemory()])).not.toThrow();
  });

  // ─── 分页 ────────────────────────────────────────────────

  it('超过 MEMORY_PAGE_SIZE 条时应显示"加载更多"按钮', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    // 生成超过 50 条记忆
    const memories = Array.from({ length: 60 }, (_, i) => makeMemory({ id: `mem-${i}`, name: `记忆${i}` }));
    mgr.renderMemoryList(memories);

    const loadMoreBtn = document.querySelector('.memory-load-more');
    expect(loadMoreBtn).not.toBeNull();
    expect(loadMoreBtn?.textContent).toContain('剩余 10 条');
  });

  it('未超过 MEMORY_PAGE_SIZE 时不应显示"加载更多"按钮', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    mgr.renderMemoryList([makeMemory()]);
    expect(document.querySelector('.memory-load-more')).toBeNull();
  });

  it('点击"加载更多"应加载下一页', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, document.getElementById('memory-list'), null, null, null, events);

    const memories = Array.from({ length: 60 }, (_, i) => makeMemory({ id: `mem-${i}`, name: `记忆${i}` }));
    mgr.renderMemoryList(memories);

    // 第一页应有 50 条
    expect(document.querySelectorAll('.memory-item').length).toBe(50);

    // 点击加载更多
    const loadMoreBtn = document.querySelector('.memory-load-more') as HTMLButtonElement;
    loadMoreBtn.click();

    // 第二页应有 60 条（全部加载完）
    expect(document.querySelectorAll('.memory-item').length).toBe(60);
    // 加载更多按钮应消失
    expect(document.querySelector('.memory-load-more')).toBeNull();
  });
});

// ─── showMemoryDetail ─────────────────────────────────────

describe('showMemoryDetail', () => {
  it('应填充详情弹窗各字段', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail({ name: '详情名', source: 'insight', score: 0.88, content: '内容文本' }));

    expect(document.getElementById('memory-detail-name')?.textContent).toBe('详情名');
    expect(document.getElementById('memory-detail-source')?.textContent).toBe('insight');
    expect(document.getElementById('memory-detail-score')?.textContent).toBe('0.88');
    expect(document.getElementById('memory-detail-content')?.textContent).toBe('内容文本');
  });

  it('应调用 showModal 打开弹窗', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail());
    expect(host.showModal).toHaveBeenCalledWith('memory-detail-modal');
  });

  it('应保存 memoryId 到 modal dataset', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail({ id: 'mem-abc' }));
    expect(detailModal.dataset.memoryId).toBe('mem-abc');
  });

  it('应保存 source 和 name 到 modal dataset（供编辑使用）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail({ source: 'rule', name: '规则名' }));
    expect(detailModal.dataset.memorySource).toBe('rule');
    expect(detailModal.dataset.memoryName).toBe('规则名');
  });

  it('应保存原始内容到 dataset.originalContent', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail({ content: '原始内容' }));
    const contentEl = document.getElementById('memory-detail-content') as HTMLElement;
    expect(contentEl.dataset.originalContent).toBe('原始内容');
  });

  it('detailModal 为 null 时应静默降级', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    expect(() => mgr.showMemoryDetail(makeDetail())).not.toThrow();
  });

  it('只读模式应显示编辑/删除/讨论按钮，隐藏保存/取消', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryDetail(makeDetail());

    expect(document.getElementById('btn-memory-edit')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('btn-memory-delete')?.classList.contains('hidden')).toBe(false);
    // 讨论按钮在只读模式下可见
    expect(document.getElementById('btn-memory-discuss')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('btn-memory-edit-save')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('btn-memory-edit-cancel')?.classList.contains('hidden')).toBe(true);
  });

  // 讨论按钮在编辑模式下隐藏
  it('编辑模式应隐藏讨论按钮（与编辑/删除同步）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, detailModal, events);
    // 必须先初始化监听器，编辑按钮的 click 事件才会触发 enterEditMode
    mgr.initMemoryPanelListeners();

    mgr.showMemoryDetail(makeDetail());
    // 点击编辑按钮进入编辑模式
    const btnEdit = document.getElementById('btn-memory-edit')!;
    btnEdit.dispatchEvent(new Event('click'));

    // 讨论按钮应与编辑/删除按钮同步隐藏
    expect(document.getElementById('btn-memory-discuss')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('btn-memory-edit')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('btn-memory-delete')?.classList.contains('hidden')).toBe(true);
    // 编辑模式按钮应显示
    expect(document.getElementById('btn-memory-edit-save')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('btn-memory-edit-cancel')?.classList.contains('hidden')).toBe(false);
  });
});

// ─── getCurrentMemoryId ───────────────────────────────────

describe('getCurrentMemoryId', () => {
  it('未打开详情时应返回 null', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, document.getElementById('memory-detail-modal'), events);

    expect(mgr.getCurrentMemoryId()).toBeNull();
  });

  it('打开详情后应返回当前记忆 ID', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, document.getElementById('memory-detail-modal'), events);

    mgr.showMemoryDetail(makeDetail({ id: 'mem-xyz' }));
    expect(mgr.getCurrentMemoryId()).toBe('mem-xyz');
  });

  it('detailModal 为 null 时应返回 null', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    expect(mgr.getCurrentMemoryId()).toBeNull();
  });
});

// ─── getAddMemoryFormData / clearAddMemoryForm ─────────────

describe('getAddMemoryFormData', () => {
  it('三个字段都有值时应返回表单数据', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'insight';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '新记忆';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    const data = mgr.getAddMemoryFormData();
    expect(data).toEqual({ source: 'insight', name: '新记忆', content: '内容' });
  });

  it('source 为空时应返回 null', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-name') as HTMLInputElement).value = '新记忆';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    expect(mgr.getAddMemoryFormData()).toBeNull();
  });

  it('name 为空时应返回 null', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'insight';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    expect(mgr.getAddMemoryFormData()).toBeNull();
  });

  it('content 为空时应返回 null', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'insight';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '新记忆';

    expect(mgr.getAddMemoryFormData()).toBeNull();
  });

  it('字段为纯空格时应 trim 后判断为空', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = '  ';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '新记忆';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    expect(mgr.getAddMemoryFormData()).toBeNull();
  });
});

describe('clearAddMemoryForm', () => {
  it('应清空三个字段的值', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'insight';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '新记忆';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    mgr.clearAddMemoryForm();

    expect((document.getElementById('memory-add-source') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('memory-add-name') as HTMLInputElement).value).toBe('');
    expect((document.getElementById('memory-add-content') as HTMLTextAreaElement).value).toBe('');
  });
});

// ─── 回调注册 ─────────────────────────────────────────────

describe('回调注册', () => {
  it('onMemorySearch 应注册搜索回调', async () => {
    const host = createMockHost();
    const events = new EventTracker();
    // initMemoryPanelListeners 要求 searchEl 和 filterSourceEl 都存在
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, null, events);
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemorySearch(cb);

    searchEl.value = '测试搜索';
    searchEl.dispatchEvent(new Event('input'));

    // 防抖 300ms，用 vi.waitFor 等待回调被调用
    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalledWith('测试搜索');
    }, { timeout: 2000, interval: 100 });
  });

  it('onMemoryFilter 应注册筛选回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, document.getElementById('memory-search') as HTMLInputElement, filterEl, null, events);
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemoryFilter(cb);

    filterEl.value = 'insight';
    filterEl.dispatchEvent(new Event('change'));

    expect(cb).toHaveBeenCalledWith('insight');
  });

  it('onMemoryClick 应注册点击回调（事件委托）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const listEl = document.getElementById('memory-list')!;
    // initMemoryPanelListeners 要求 searchEl 和 filterSourceEl 都存在
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, listEl, searchEl, filterEl, null, events);
    // 先初始化监听器（注册事件委托到 listEl）
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemoryClick(cb);

    // 再渲染列表（子元素冒泡到 listEl 的委托监听器）
    mgr.renderMemoryList([makeMemory({ id: 'click-test' })]);
    const item = document.querySelector('.memory-item') as HTMLElement;
    item.click();

    expect(cb).toHaveBeenCalledWith('click-test');
  });

  it('onMemoryAdd 应注册添加回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    const cb = vi.fn();
    mgr.onMemoryAdd(cb);

    // 直接调用回调验证注册
    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'rule';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '规则';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';
    const data = mgr.getAddMemoryFormData();
    if (data) cb(data);

    expect(cb).toHaveBeenCalledWith({ source: 'rule', name: '规则', content: '内容' });
  });

  // textarea Ctrl+Enter 快捷提交
  it('textarea 中 Ctrl+Enter 应触发 memoryAddCallback', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, null, events);
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemoryAdd(cb);

    // 填写表单
    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'insight';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '测试';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    // 模拟 Ctrl+Enter keydown
    const textarea = document.getElementById('memory-add-content') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

    expect(cb).toHaveBeenCalledWith({ source: 'insight', name: '测试', content: '内容' });
  });

  it('textarea 中 Cmd+Enter 应触发 memoryAddCallback（macOS 兼容）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, null, events);
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemoryAdd(cb);

    (document.getElementById('memory-add-source') as HTMLInputElement).value = 'profile';
    (document.getElementById('memory-add-name') as HTMLInputElement).value = '画像';
    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '数据';

    const textarea = document.getElementById('memory-add-content') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

    expect(cb).toHaveBeenCalledWith({ source: 'profile', name: '画像', content: '数据' });
  });

  it('textarea 中单独 Enter 不应触发提交（应换行）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, null, events);
    mgr.initMemoryPanelListeners();

    const cb = vi.fn();
    mgr.onMemoryAdd(cb);

    (document.getElementById('memory-add-content') as HTMLTextAreaElement).value = '内容';

    const textarea = document.getElementById('memory-add-content') as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(cb).not.toHaveBeenCalled();
  });

  it('onMemoryDelete 应注册删除回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    const cb = vi.fn();
    mgr.onMemoryDelete(cb);
    cb();

    expect(cb).toHaveBeenCalled();
  });

  it('onMemoryEdit 应注册编辑回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    const cb = vi.fn();
    mgr.onMemoryEdit(cb);
    cb('mem-1', '新内容');

    expect(cb).toHaveBeenCalledWith('mem-1', '新内容');
  });

  // 讨论回调注册
  it('onMemoryDiscuss 应注册讨论回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    const cb = vi.fn();
    mgr.onMemoryDiscuss(cb);
    cb('测试记忆');

    expect(cb).toHaveBeenCalledWith('测试记忆');
  });
});

// ─── 讨论按钮点击 ───────────────────

describe('讨论按钮点击', () => {
  it('点击讨论按钮应触发 onMemoryDiscuss 回调，携带记忆名称', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, detailModal, events);
    // 必须先初始化监听器，讨论按钮的 click 事件才会触发回调
    mgr.initMemoryPanelListeners();

    // 先打开详情，设置记忆名称到 dataset
    mgr.showMemoryDetail(makeDetail({ name: '记忆A' }));

    const cb = vi.fn();
    mgr.onMemoryDiscuss(cb);

    // 点击讨论按钮
    const btnDiscuss = document.getElementById('btn-memory-discuss')!;
    btnDiscuss.dispatchEvent(new Event('click'));

    expect(cb).toHaveBeenCalledWith('记忆A');
  });

  it('detailModal dataset 无 memoryName 时不应触发回调', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, detailModal, events);
    mgr.initMemoryPanelListeners();

    // 手动设置 dataset（不通过 showMemoryDetail，模拟异常状态）
    detailModal.dataset.memoryName = '';

    const cb = vi.fn();
    mgr.onMemoryDiscuss(cb);

    const btnDiscuss = document.getElementById('btn-memory-discuss')!;
    btnDiscuss.dispatchEvent(new Event('click'));

    expect(cb).not.toHaveBeenCalled();
  });

  it('多次注册 onMemoryDiscuss 应覆盖前者', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const filterEl = document.getElementById('memory-filter-source') as HTMLSelectElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, filterEl, detailModal, events);
    mgr.initMemoryPanelListeners();

    mgr.showMemoryDetail(makeDetail({ name: '记忆B' }));

    const cb1 = vi.fn();
    const cb2 = vi.fn();
    mgr.onMemoryDiscuss(cb1);
    mgr.onMemoryDiscuss(cb2);

    const btnDiscuss = document.getElementById('btn-memory-discuss')!;
    btnDiscuss.dispatchEvent(new Event('click'));

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('记忆B');
  });
});

// ─── showMemoryLineage（Phase 5.1：演化脉络） ──────────────

describe('showMemoryLineage', () => {
  /** 创建脉络节点（RelationPath） */
  function makePath(overrides: Partial<RelationPath> = {}): RelationPath {
    return {
      memoryId: 'mem-1',
      memoryName: '节点1',
      memorySource: 'insight',
      relationType: null,
      relationWeight: null,
      depth: 0,
      ...overrides,
    };
  }

  it('空数组应显示"暂无演化脉络"空状态文案', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryLineage([]);

    const lineageEl = document.getElementById('memory-detail-lineage')!;
    expect(lineageEl.classList.contains('hidden')).toBe(false);
    expect(document.querySelectorAll('.lineage-item').length).toBe(0);
    const empty = lineageEl.querySelector('.lineage-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('暂无演化脉络');
  });

  it('仅起点节点（length=1）应显示空状态（无上游来源）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    mgr.showMemoryLineage([makePath({ depth: 0 })]);

    const lineageEl = document.getElementById('memory-detail-lineage')!;
    expect(lineageEl.classList.contains('hidden')).toBe(false);
    expect(lineageEl.querySelector('.lineage-empty')?.textContent).toBe('暂无演化脉络');
  });

  it('多节点路径应渲染多个 .lineage-item 并显示脉络区域', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    const path: RelationPath[] = [
      makePath({ memoryId: 'current', memoryName: '当前记忆', memorySource: 'profile', depth: 0, relationType: null }),
      makePath({ memoryId: 'src1', memoryName: '上游洞察', memorySource: 'insight', depth: 1, relationType: 'supports' }),
      makePath({ memoryId: 'src2', memoryName: '原始输入', memorySource: 'session', depth: 2, relationType: 'derived-from' }),
    ];

    mgr.showMemoryLineage(path);

    const lineageEl = document.getElementById('memory-detail-lineage')!;
    expect(lineageEl.classList.contains('hidden')).toBe(false);

    const items = document.querySelectorAll('.lineage-item');
    expect(items.length).toBe(3);
    // 验证 depth 通过 CSS 变量传递（不直接操作 padding-left）
    expect(items[0].getAttribute('style')).toContain('--lineage-depth: 0');
    expect(items[1].getAttribute('style')).toContain('--lineage-depth: 1');
    expect(items[2].getAttribute('style')).toContain('--lineage-depth: 2');
  });

  it('起点节点不渲染 relation-tag（relationType 为 null）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    const path: RelationPath[] = [
      makePath({ depth: 0, relationType: null }),
      makePath({ depth: 1, relationType: 'supports' }),
    ];

    mgr.showMemoryLineage(path);

    const items = document.querySelectorAll('.lineage-item');
    // 起点节点不应有 .lineage-relation-tag
    expect(items[0].querySelector('.lineage-relation-tag')).toBeNull();
    // 上游节点应有 .lineage-relation-tag
    expect(items[1].querySelector('.lineage-relation-tag')).not.toBeNull();
  });

  it('点击脉络节点应触发 memoryClickCallback', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    const clickCb = vi.fn();
    mgr.onMemoryClick(clickCb);

    const path: RelationPath[] = [
      makePath({ memoryId: 'current', depth: 0 }),
      makePath({ memoryId: 'src1', depth: 1, relationType: 'supports' }),
    ];
    mgr.showMemoryLineage(path);

    const items = document.querySelectorAll('.lineage-item');
    (items[1] as HTMLElement).click();

    expect(clickCb).toHaveBeenCalledWith('src1');
  });

  it('detailModal 为 null 时应静默降级', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    expect(() => mgr.showMemoryLineage([makePath()])).not.toThrow();
  });

  it('showMemoryDetail 后未调用 showMemoryLineage 时脉络区域应隐藏', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const detailModal = document.getElementById('memory-detail-modal')!;
    const mgr = new MemoryPanelManager(host, null, null, null, detailModal, events);

    // showMemoryDetail 内部会调用 resetLineage，确保脉络区域隐藏
    mgr.showMemoryDetail(makeDetail());

    const lineageEl = document.getElementById('memory-detail-lineage')!;
    expect(lineageEl.classList.contains('hidden')).toBe(true);
  });
});

// ─── cleanup ──────────────────────────────────────────────

describe('cleanup', () => {
  it('应清理防抖定时器（不抛错）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    const mgr = new MemoryPanelManager(host, null, searchEl, null, null, events);
    mgr.initMemoryPanelListeners();

    // 触发搜索输入（启动防抖定时器）
    searchEl.value = 'test';
    searchEl.dispatchEvent(new Event('input'));

    // 立即 cleanup（定时器还在等待中）
    expect(() => mgr.cleanup()).not.toThrow();
  });

  it('未初始化监听器时 cleanup 应安全', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    expect(() => mgr.cleanup()).not.toThrow();
  });

  it('多次 cleanup 应安全（幂等）', () => {
    const host = createMockHost();
    const events = new EventTracker();
    const mgr = new MemoryPanelManager(host, null, null, null, null, events);

    mgr.cleanup();
    mgr.cleanup();
    mgr.cleanup();
  });
});