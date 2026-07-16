/**
 * 记忆图谱视图子系统辅助测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - initGraphRenderer：幂等初始化、canvas 缺失降级、回调绑定
 * - updateGraphEmptyState：有数据显示/无数据隐藏
 * - applyCachedGraphState：高亮/选中状态应用
 * - clearGraphHighlights：清除缓存和渲染器状态
 * - showGraphContextMenu：菜单定位、菜单项点击、键盘导航
 * - hideGraphContextMenu：清理监听器
 * - showRelationEditDialog：填充值、保存/删除/取消
 * - showRelationCreateDialog：默认值、隐藏删除按钮
 *
 * Mock 策略：
 * - vi.mock RelationGraphRenderer（避免 Canvas 2D 上下文依赖）
 * - JSDOM 提供真实 DOM API（构建菜单 + 弹窗 + canvas）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initGraphRenderer,
  updateGraphEmptyState,
  applyCachedGraphState,
  clearGraphHighlights,
  showGraphContextMenu,
  hideGraphContextMenu,
  showRelationEditDialog,
  showRelationCreateDialog,
  type MemoryGraphPanelContext,
} from '../../../electron/renderer/panels/memoryGraphPanel.js';
import { RelationGraphRenderer } from '../../../electron/renderer/components/relationGraph.js';
import type { RelationGraphData } from '../../../electron/renderer/components/relationGraph.js';
import type { MemoryPanelHost } from '../../../electron/renderer/panels/memoryPanelManager.js';

// ─── Mock RelationGraphRenderer ──────────────────────────

const mockRenderer = {
  setOnNodeClick: vi.fn(),
  setOnNodeContextMenu: vi.fn(),
  setOnEdgeClick: vi.fn(),
  setOnConnectionCreate: vi.fn(),
  setHighlightedNodes: vi.fn(),
  setSelectedNode: vi.fn(),
  clearHighlights: vi.fn(),
};

// 箭头函数不能作为构造函数（new 调用），改用 function 形式
vi.mock('../../../electron/renderer/components/relationGraph.js', () => ({
  RelationGraphRenderer: vi.fn(function (this: unknown, _canvas: HTMLCanvasElement) {
    return mockRenderer;
  }),
}));

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建图谱 DOM 结构（canvas + 空状态 + 上下文菜单 + 关系弹窗） */
function setupDOM(): void {
  document.body.innerHTML = `
    <canvas id="memory-graph-canvas" tabindex="0"></canvas>
    <div id="memory-graph-empty" class="hidden"></div>
    <div id="graph-context-menu" class="hidden" role="menu">
      <button data-action="focus-subgraph" role="menuitem">聚焦子图</button>
      <button data-action="view-detail" role="menuitem">查看详情</button>
      <button data-action="connect-from" role="menuitem">创建连线</button>
      <button data-action="copy-id" role="menuitem">复制 ID</button>
    </div>
    <div id="relation-edit-dialog" class="hidden">
      <div class="modal-header"><h3>编辑关系</h3></div>
      <select id="relation-edit-type">
        <option value="related">相关</option>
        <option value="similar">相似</option>
      </select>
      <input id="relation-edit-weight" type="range" min="0" max="1" step="0.01" value="0.5" />
      <span id="relation-edit-weight-value">50</span>
      <button id="relation-edit-save">保存</button>
      <button id="relation-edit-delete">删除</button>
      <button id="relation-edit-cancel">取消</button>
    </div>
  `;
}

/** 创建 Mock MemoryPanelHost */
function createMockHost(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    showModal: vi.fn(),
    hideModal: vi.fn(),
    showConfirmDialog: vi.fn(async () => true),
    showToast: vi.fn(),
  };
}

/** 创建 MemoryGraphPanelContext mock */
function createCtx(overrides?: Partial<MemoryGraphPanelContext>): {
  ctx: MemoryGraphPanelContext;
  graphRenderer: RelationGraphRenderer | null;
  graphDataCache: RelationGraphData | null;
  cachedHighlightedNodeIds: string[] | null;
  cachedSelectedNodeId: string | null;
  contextMenuCloseHandler: ((e: MouseEvent) => void) | null;
  contextMenuKeyHandler: ((e: KeyboardEvent) => void) | null;
  memoryClickCallback: ((id: string) => void) | null;
  graphContextMenuCallback: ((action: string, nodeId: string) => void) | null;
  relationEditCallback: ((s: string, t: string, ty: string, w: number) => void) | null;
  relationDeleteCallback: ((s: string, t: string, ty: string) => void) | null;
  relationCreateCallback: ((s: string, t: string, ty: string, w: number) => void) | null;
} {
  let graphRenderer: RelationGraphRenderer | null = null;
  let graphDataCache: RelationGraphData | null = null;
  let cachedHighlightedNodeIds: string[] | null = null;
  let cachedSelectedNodeId: string | null = null;
  let contextMenuCloseHandler: ((e: MouseEvent) => void) | null = null;
  let contextMenuKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  const memoryClickCallback: ((id: string) => void) | null = null;
  const graphContextMenuCallback: ((action: string, nodeId: string) => void) | null = null;
  const relationEditCallback: ((s: string, t: string, ty: string, w: number) => void) | null = null;
  const relationDeleteCallback: ((s: string, t: string, ty: string) => void) | null = null;
  const relationCreateCallback: ((s: string, t: string, ty: string, w: number) => void) | null = null;

  const ctx: MemoryGraphPanelContext = {
    host: createMockHost() as unknown as MemoryPanelHost,
    getGraphRenderer: () => graphRenderer,
    setGraphRenderer: (r) => { graphRenderer = r; },
    getGraphDataCache: () => graphDataCache,
    setGraphDataCache: (d) => { graphDataCache = d; },
    getCachedHighlightedNodeIds: () => cachedHighlightedNodeIds,
    setCachedHighlightedNodeIds: (ids) => { cachedHighlightedNodeIds = ids; },
    getCachedSelectedNodeId: () => cachedSelectedNodeId,
    setSelectedNodeId: (id) => { cachedSelectedNodeId = id; },
    getGraphContextMenuCloseHandler: () => contextMenuCloseHandler,
    setGraphContextMenuCloseHandler: (h) => { contextMenuCloseHandler = h; },
    getGraphContextMenuKeyHandler: () => contextMenuKeyHandler,
    setGraphContextMenuKeyHandler: (h) => { contextMenuKeyHandler = h; },
    getMemoryClickCallback: () => memoryClickCallback,
    getGraphContextMenuCallback: () => graphContextMenuCallback,
    getRelationEditCallback: () => relationEditCallback,
    getRelationDeleteCallback: () => relationDeleteCallback,
    getRelationCreateCallback: () => relationCreateCallback,
    ...overrides,
  };

  return {
    ctx,
    get graphRenderer() { return graphRenderer; },
    get graphDataCache() { return graphDataCache; },
    get cachedHighlightedNodeIds() { return cachedHighlightedNodeIds; },
    get cachedSelectedNodeId() { return cachedSelectedNodeId; },
    get contextMenuCloseHandler() { return contextMenuCloseHandler; },
    get contextMenuKeyHandler() { return contextMenuKeyHandler; },
    get memoryClickCallback() { return memoryClickCallback; },
    get graphContextMenuCallback() { return graphContextMenuCallback; },
    get relationEditCallback() { return relationEditCallback; },
    get relationDeleteCallback() { return relationDeleteCallback; },
    get relationCreateCallback() { return relationCreateCallback; },
  };
}

/** 创建 RelationGraphData */
function createGraphData(nodeCount = 2): RelationGraphData {
  return {
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `node-${i}`,
      name: `Node ${i}`,
      source: 'conversation',
      score: 0.9,
    })),
    edges: [],
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  setupDOM();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. initGraphRenderer ──────────────────────────────

describe('initGraphRenderer', () => {
  it('应创建渲染器并绑定回调', () => {
    const { ctx } = createCtx();
    initGraphRenderer(ctx);
    expect(ctx.getGraphRenderer()).toBeTruthy();
    expect(mockRenderer.setOnNodeClick).toHaveBeenCalled();
    expect(mockRenderer.setOnNodeContextMenu).toHaveBeenCalled();
    expect(mockRenderer.setOnEdgeClick).toHaveBeenCalled();
    expect(mockRenderer.setOnConnectionCreate).toHaveBeenCalled();
  });

  it('已初始化应跳过（幂等）', () => {
    const { ctx } = createCtx();
    ctx.setGraphRenderer(mockRenderer as unknown as RelationGraphRenderer);
    initGraphRenderer(ctx);
    // RelationGraphRenderer 构造函数不应被再次调用
    expect(RelationGraphRenderer).not.toHaveBeenCalled();
  });

  it('canvas 元素缺失应降级返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    initGraphRenderer(ctx);
    expect(ctx.getGraphRenderer()).toBeNull();
  });

  it('canvas 非 HTMLCanvasElement 应降级', () => {
    document.body.innerHTML = '<div id="memory-graph-canvas"></div>';
    const { ctx } = createCtx();
    initGraphRenderer(ctx);
    expect(ctx.getGraphRenderer()).toBeNull();
  });
});

// ─── 2. updateGraphEmptyState ──────────────────────────

describe('updateGraphEmptyState', () => {
  it('无缓存数据应显示空状态', () => {
    const { ctx } = createCtx();
    ctx.setGraphDataCache(null);
    updateGraphEmptyState(ctx);
    const empty = document.getElementById('memory-graph-empty');
    expect(empty?.classList.contains('hidden')).toBe(false);
  });

  it('节点数为 0 应显示空状态', () => {
    const { ctx } = createCtx();
    ctx.setGraphDataCache(createGraphData(0));
    updateGraphEmptyState(ctx);
    const empty = document.getElementById('memory-graph-empty');
    expect(empty?.classList.contains('hidden')).toBe(false);
  });

  it('有节点数据应隐藏空状态', () => {
    const { ctx } = createCtx();
    ctx.setGraphDataCache(createGraphData(3));
    updateGraphEmptyState(ctx);
    const empty = document.getElementById('memory-graph-empty');
    expect(empty?.classList.contains('hidden')).toBe(true);
  });

  it('空状态元素缺失应静默返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    expect(() => updateGraphEmptyState(ctx)).not.toThrow();
  });
});

// ─── 3. applyCachedGraphState ──────────────────────────

describe('applyCachedGraphState', () => {
  it('应将缓存的高亮节点应用到渲染器', () => {
    const { ctx } = createCtx();
    ctx.setGraphRenderer(mockRenderer as unknown as RelationGraphRenderer);
    ctx.setCachedHighlightedNodeIds(['node-1', 'node-2']);
    applyCachedGraphState(ctx);
    expect(mockRenderer.setHighlightedNodes).toHaveBeenCalledWith(['node-1', 'node-2']);
  });

  it('应将缓存的选中节点应用到渲染器', () => {
    const { ctx } = createCtx();
    ctx.setGraphRenderer(mockRenderer as unknown as RelationGraphRenderer);
    ctx.setSelectedNodeId('node-1');
    applyCachedGraphState(ctx);
    expect(mockRenderer.setSelectedNode).toHaveBeenCalledWith('node-1');
  });

  it('渲染器未初始化应静默返回', () => {
    const { ctx } = createCtx();
    ctx.setCachedHighlightedNodeIds(['node-1']);
    expect(() => applyCachedGraphState(ctx)).not.toThrow();
    expect(mockRenderer.setHighlightedNodes).not.toHaveBeenCalled();
  });

  it('缓存为 null 应不调用渲染器', () => {
    const { ctx } = createCtx();
    ctx.setGraphRenderer(mockRenderer as unknown as RelationGraphRenderer);
    ctx.setCachedHighlightedNodeIds(null);
    ctx.setSelectedNodeId(null);
    applyCachedGraphState(ctx);
    expect(mockRenderer.setHighlightedNodes).not.toHaveBeenCalled();
    expect(mockRenderer.setSelectedNode).not.toHaveBeenCalled();
  });
});

// ─── 4. clearGraphHighlights ───────────────────────────

describe('clearGraphHighlights', () => {
  it('应清除缓存和渲染器状态', () => {
    const { ctx } = createCtx();
    ctx.setGraphRenderer(mockRenderer as unknown as RelationGraphRenderer);
    ctx.setCachedHighlightedNodeIds(['node-1']);
    ctx.setSelectedNodeId('node-1');
    clearGraphHighlights(ctx);
    expect(ctx.getCachedHighlightedNodeIds()).toBeNull();
    expect(ctx.getCachedSelectedNodeId()).toBeNull();
    expect(mockRenderer.clearHighlights).toHaveBeenCalled();
  });

  it('渲染器未初始化应仅清除缓存', () => {
    const { ctx } = createCtx();
    ctx.setCachedHighlightedNodeIds(['node-1']);
    clearGraphHighlights(ctx);
    expect(ctx.getCachedHighlightedNodeIds()).toBeNull();
    expect(ctx.getCachedSelectedNodeId()).toBeNull();
  });
});

// ─── 5. showGraphContextMenu / hideGraphContextMenu ───

describe('showGraphContextMenu', () => {
  it('应定位菜单并显示', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 100, 200);
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    expect(menu.classList.contains('hidden')).toBe(false);
    expect(menu.style.left).toBe('100px');
    expect(menu.style.top).toBe('200px');
  });

  it('应聚焦第一个菜单项', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    const focusItem = document.querySelector('[data-action="focus-subgraph"]') as HTMLElement;
    expect(document.activeElement).toBe(focusItem);
  });

  it('点击菜单项应触发回调并关闭菜单', () => {
    const { ctx } = createCtx();
    const callback = vi.fn();
    ctx.getGraphContextMenuCallback = () => callback;
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    const detailItem = document.querySelector('[data-action="view-detail"]') as HTMLElement;
    detailItem.click();
    expect(callback).toHaveBeenCalledWith('view-detail', 'node-1');
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  it('ArrowDown 应向下导航菜单项', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    const items = menu.querySelectorAll('[role="menuitem"]');
    // 第一个已聚焦
    expect(document.activeElement).toBe(items[0]);
    // ArrowDown 应聚焦第二个
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
  });

  it('ArrowUp 应向上导航菜单项（循环）', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    const items = menu.querySelectorAll('[role="menuitem"]');
    // 第一个已聚焦，ArrowUp 应循环到最后一个
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('Escape 应关闭菜单并聚焦 canvas', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.classList.contains('hidden')).toBe(true);
    const canvas = document.getElementById('memory-graph-canvas');
    expect(document.activeElement).toBe(canvas);
  });

  it('菜单元素缺失应静默返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    expect(() => showGraphContextMenu(ctx, 'node-1', 0, 0)).not.toThrow();
  });
});

describe('hideGraphContextMenu', () => {
  it('应添加 hidden 类并清理监听器', () => {
    const { ctx } = createCtx();
    showGraphContextMenu(ctx, 'node-1', 0, 0);
    hideGraphContextMenu(ctx);
    const menu = document.getElementById('graph-context-menu') as HTMLElement;
    expect(menu.classList.contains('hidden')).toBe(true);
    expect(ctx.getGraphContextMenuKeyHandler()).toBeNull();
    expect(ctx.getGraphContextMenuCloseHandler()).toBeNull();
  });

  it('菜单不存在应静默返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    expect(() => hideGraphContextMenu(ctx)).not.toThrow();
  });
});

// ─── 6. showRelationEditDialog ─────────────────────────

describe('showRelationEditDialog', () => {
  it('应填充当前关系类型和权重', () => {
    const { ctx } = createCtx();
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'similar', 0.8);
    const dialog = document.getElementById('relation-edit-dialog') as HTMLElement;
    expect(dialog.classList.contains('hidden')).toBe(false);
    const typeSelect = document.getElementById('relation-edit-type') as HTMLSelectElement;
    const weightInput = document.getElementById('relation-edit-weight') as HTMLInputElement;
    const weightValue = document.getElementById('relation-edit-weight-value');
    expect(typeSelect.value).toBe('similar');
    expect(weightInput.value).toBe('0.8');
    expect(weightValue?.textContent).toBe('80');
  });

  it('标题应为"编辑关系"', () => {
    const { ctx } = createCtx();
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'related', 0.5);
    const title = document.querySelector('.modal-header h3');
    expect(title?.textContent).toBe('编辑关系');
  });

  it('保存按钮应触发 editCallback', () => {
    const { ctx } = createCtx();
    const callback = vi.fn();
    ctx.getRelationEditCallback = () => callback;
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'related', 0.5);
    const saveBtn = document.getElementById('relation-edit-save') as HTMLElement;
    saveBtn.click();
    expect(callback).toHaveBeenCalledWith('node-1', 'node-2', 'related', 0.5);
    const dialog = document.getElementById('relation-edit-dialog') as HTMLElement;
    expect(dialog.classList.contains('hidden')).toBe(true);
  });

  it('删除按钮应触发 deleteCallback', () => {
    const { ctx } = createCtx();
    const callback = vi.fn();
    ctx.getRelationDeleteCallback = () => callback;
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'similar', 0.8);
    const deleteBtn = document.getElementById('relation-edit-delete') as HTMLElement;
    deleteBtn.click();
    expect(callback).toHaveBeenCalledWith('node-1', 'node-2', 'similar');
  });

  it('取消按钮应关闭弹窗', () => {
    const { ctx } = createCtx();
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'related', 0.5);
    const cancelBtn = document.getElementById('relation-edit-cancel') as HTMLElement;
    cancelBtn.click();
    const dialog = document.getElementById('relation-edit-dialog') as HTMLElement;
    expect(dialog.classList.contains('hidden')).toBe(true);
  });

  it('权重滑块应联动更新百分比', () => {
    const { ctx } = createCtx();
    showRelationEditDialog(ctx, 'node-1', 'node-2', 'related', 0.5);
    const weightInput = document.getElementById('relation-edit-weight') as HTMLInputElement;
    const weightValue = document.getElementById('relation-edit-weight-value');
    weightInput.value = '0.75';
    weightInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(weightValue?.textContent).toBe('75');
  });

  it('弹窗元素缺失应静默返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    expect(() => showRelationEditDialog(ctx, 'node-1', 'node-2', 'related', 0.5)).not.toThrow();
  });
});

// ─── 7. showRelationCreateDialog ───────────────────────

describe('showRelationCreateDialog', () => {
  it('应设置默认值（related / 0.5 / 50%）', () => {
    const { ctx } = createCtx();
    showRelationCreateDialog(ctx, 'node-1', 'node-2');
    const typeSelect = document.getElementById('relation-edit-type') as HTMLSelectElement;
    const weightInput = document.getElementById('relation-edit-weight') as HTMLInputElement;
    const weightValue = document.getElementById('relation-edit-weight-value');
    expect(typeSelect.value).toBe('related');
    expect(weightInput.value).toBe('0.5');
    expect(weightValue?.textContent).toBe('50');
  });

  it('标题应为"创建关系"', () => {
    const { ctx } = createCtx();
    showRelationCreateDialog(ctx, 'node-1', 'node-2');
    const title = document.querySelector('.modal-header h3');
    expect(title?.textContent).toBe('创建关系');
  });

  it('删除按钮应被隐藏', () => {
    const { ctx } = createCtx();
    showRelationCreateDialog(ctx, 'node-1', 'node-2');
    const deleteBtn = document.getElementById('relation-edit-delete') as HTMLElement;
    expect(deleteBtn.classList.contains('hidden')).toBe(true);
  });

  it('保存按钮应触发 createCallback', () => {
    const { ctx } = createCtx();
    const callback = vi.fn();
    ctx.getRelationCreateCallback = () => callback;
    showRelationCreateDialog(ctx, 'node-1', 'node-2');
    const saveBtn = document.getElementById('relation-edit-save') as HTMLElement;
    saveBtn.click();
    expect(callback).toHaveBeenCalledWith('node-1', 'node-2', 'related', 0.5);
    const dialog = document.getElementById('relation-edit-dialog') as HTMLElement;
    expect(dialog.classList.contains('hidden')).toBe(true);
  });

  it('取消按钮应关闭弹窗', () => {
    const { ctx } = createCtx();
    showRelationCreateDialog(ctx, 'node-1', 'node-2');
    const cancelBtn = document.getElementById('relation-edit-cancel') as HTMLElement;
    cancelBtn.click();
    const dialog = document.getElementById('relation-edit-dialog') as HTMLElement;
    expect(dialog.classList.contains('hidden')).toBe(true);
  });

  it('弹窗元素缺失应静默返回', () => {
    document.body.innerHTML = '';
    const { ctx } = createCtx();
    expect(() => showRelationCreateDialog(ctx, 'node-1', 'node-2')).not.toThrow();
  });
});
