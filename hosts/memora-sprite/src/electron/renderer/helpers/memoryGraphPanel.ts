/**
 * 记忆图谱视图子系统辅助（从 memoryPanelManager.ts 提取）
 *
 * 职责：
 *   集中管理图谱视图的渲染器初始化、状态同步、上下文菜单、关系编辑弹窗等子功能，
 *   降低 memoryPanelManager.ts 体量。涵盖：
 *   - Canvas 2D 力导向渲染器延迟初始化与回调绑定
 *   - 图谱空状态显示/隐藏
 *   - 缓存的高亮/选中状态应用（跨视图切换保持状态）
 *   - 右键上下文菜单（聚焦子图/查看详情/创建连线/复制 ID）
 *   - 关系编辑弹窗（编辑/创建/删除关系）
 *
 * 提取原因：
 *   memoryPanelManager.ts 超标（1968 行，超 1800 触发线）。
 *   图谱视图相关方法（initGraphRenderer + 空状态 + 缓存状态 + 上下文菜单 + 关系弹窗）
 *   形成完整子系统，相对独立，适合提取为接受 context 的纯函数模块。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 MemoryGraphPanelContext 注入
 *   - 图谱状态字段（graphRenderer/graphDataCache/cachedHighlightedNodeIds 等）通过 getter/setter 访问，
 *     保持 MemoryPanelManager 作为状态所有者
 *   - 回调（graphContextMenuCallback/relationEditCallback 等）通过 getter 读取
 *     （运行时获取最新值，因为 onXxx 注册晚于 init 调用）
 *   - type-only 导入 MemoryPanelHost 避免运行时循环依赖
 *
 * 先例：
 *   参照 memoryPanelEvents.ts 的提取模式，本次为图谱视图拆分
 */

import { reportError } from './errorHelpers.js';
import { RelationGraphRenderer } from '../components/relationGraph.js';
import type { RelationGraphData } from '../components/relationGraph.js';
// 类型仅导入：运行时不会产生循环依赖（type-only 在编译期擦除）
import type { MemoryPanelHost } from '../panels/memoryPanelManager.js';

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/**
 * 图谱视图子系统所需的上下文
 *
 * 由 MemoryPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface MemoryGraphPanelContext {
  // ─── 宿主能力 ───
  readonly host: MemoryPanelHost;

  // ─── 状态访问器（getter/setter） ───
  /** 获取当前图谱渲染器实例（可能为 null，表示尚未初始化） */
  getGraphRenderer(): RelationGraphRenderer | null;
  /** 设置图谱渲染器实例（initGraphRenderer 创建后回写） */
  setGraphRenderer(renderer: RelationGraphRenderer | null): void;
  /** 获取图谱数据缓存（切换回图谱视图时复用，避免重复 IPC） */
  getGraphDataCache(): RelationGraphData | null;
  /** 设置图谱数据缓存（loadGraphData 时回写） */
  setGraphDataCache(data: RelationGraphData | null): void;
  /** 获取缓存的高亮节点 ID 列表（渲染器未初始化时暂存） */
  getCachedHighlightedNodeIds(): string[] | null;
  /** 设置缓存的高亮节点 ID 列表 */
  setCachedHighlightedNodeIds(ids: string[] | null): void;
  /** 获取缓存的选中节点 ID（渲染器未初始化时暂存） */
  getCachedSelectedNodeId(): string | null;
  /** 设置缓存的选中节点 ID */
  setSelectedNodeId(id: string | null): void;
  /** 获取右键菜单关闭处理器（用于清理 document 监听器） */
  getGraphContextMenuCloseHandler(): ((e: MouseEvent) => void) | null;
  /** 设置右键菜单关闭处理器 */
  setGraphContextMenuCloseHandler(handler: ((e: MouseEvent) => void) | null): void;
  /** 获取右键菜单键盘导航处理器（Arrow/Escape 键盘导航） */
  getGraphContextMenuKeyHandler(): ((e: KeyboardEvent) => void) | null;
  /** 设置右键菜单键盘导航处理器 */
  setGraphContextMenuKeyHandler(handler: ((e: KeyboardEvent) => void) | null): void;

  // ─── 回调读取器（onXxx 注册晚于 init，用 getter 读取最新值） ───
  /** 获取节点点击回调（点击图谱节点 → 显示记忆详情） */
  getMemoryClickCallback(): ((id: string) => void) | null;
  /** 获取上下文菜单操作回调（聚焦子图/查看详情等） */
  getGraphContextMenuCallback(): ((action: string, nodeId: string) => void) | null;
  /** 获取关系编辑回调（保存已有边的类型/权重修改） */
  getRelationEditCallback(): ((sourceId: string, targetId: string, type: string, weight: number) => void) | null;
  /** 获取关系删除回调（删除已有边） */
  getRelationDeleteCallback(): ((sourceId: string, targetId: string, type: string) => void) | null;
  /** 获取关系创建回调（新建关系） */
  getRelationCreateCallback(): ((sourceId: string, targetId: string, type: string, weight: number) => void) | null;
}

// ─── 图谱渲染器初始化 ────────────────────────────────────

/**
 * 延迟初始化图谱渲染器
 *
 * 首次切换到图谱视图时调用，Canvas 元素可能尚未渲染，
 * 使用 requestAnimationFrame 延迟一帧确保 DOM 就绪。
 * 初始化后绑定节点点击、右键菜单、边点击、手动连线创建四个回调。
 *
 * @param ctx 图谱视图上下文
 */
export function initGraphRenderer(ctx: MemoryGraphPanelContext): void {
  // 已初始化则跳过（幂等）
  if (ctx.getGraphRenderer()) return;

  const canvas = document.getElementById('memory-graph-canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    reportError('MemoryPanel 图谱渲染 memory-graph-canvas 元素缺失', new Error('HTMLCanvasElement 校验失败'));
    return;
  }

  const renderer = new RelationGraphRenderer(canvas);

  // 节点点击回调：通过 memoryClickCallback 显示详情
  renderer.setOnNodeClick((nodeId: string) => {
    ctx.getMemoryClickCallback()?.(nodeId);
  });

  // 节点右键菜单回调：显示上下文菜单
  renderer.setOnNodeContextMenu((nodeId: string, x: number, y: number) => {
    showGraphContextMenu(ctx, nodeId, x, y);
  });

  // 边点击回调：打开关系编辑弹窗
  renderer.setOnEdgeClick((sourceId: string, targetId: string, type: string, weight: number) => {
    showRelationEditDialog(ctx, sourceId, targetId, type, weight);
  });

  // 手动连线创建回调：打开关系创建弹窗
  renderer.setOnConnectionCreate((sourceId: string, targetId: string) => {
    showRelationCreateDialog(ctx, sourceId, targetId);
  });

  ctx.setGraphRenderer(renderer);
}

// ─── 图谱空状态 ──────────────────────────────────────────

/**
 * 更新图谱空状态提示的可见性
 *
 * 规则：
 * - 无缓存数据 或 节点数为 0 → 显示空状态
 * - 有数据（nodes > 0）→ 隐藏空状态
 *
 * @param ctx 图谱视图上下文
 */
export function updateGraphEmptyState(ctx: MemoryGraphPanelContext): void {
  const emptyEl = document.getElementById('memory-graph-empty');
  if (!emptyEl) return;
  const cache = ctx.getGraphDataCache();
  const hasData = cache !== null && cache.nodes.length > 0;
  emptyEl.classList.toggle('hidden', hasData);
}

// ─── 缓存状态应用 ────────────────────────────────────────

/**
 * 将缓存的高亮/选中状态应用到渲染器
 *
 * 解决问题：用户在列表视图搜索/点击后切换到图谱，
 * 状态需要在渲染器初始化和数据加载后恢复。
 *
 * @param ctx 图谱视图上下文
 */
export function applyCachedGraphState(ctx: MemoryGraphPanelContext): void {
  const renderer = ctx.getGraphRenderer();
  if (!renderer) return;

  const highlightedIds = ctx.getCachedHighlightedNodeIds();
  if (highlightedIds !== null) {
    renderer.setHighlightedNodes(highlightedIds);
  }
  const selectedId = ctx.getCachedSelectedNodeId();
  if (selectedId !== null) {
    renderer.setSelectedNode(selectedId);
  }
}

/**
 * 清除图谱所有高亮和选中状态（含缓存）
 *
 * @param ctx 图谱视图上下文
 */
export function clearGraphHighlights(ctx: MemoryGraphPanelContext): void {
  ctx.setCachedHighlightedNodeIds(null);
  ctx.setSelectedNodeId(null);
  ctx.getGraphRenderer()?.clearHighlights();
}

// ─── 图谱上下文菜单 ────────────────────────────────────────

/**
 * 显示节点右键上下文菜单
 *
 * 菜单选项：聚焦子图 / 查看详情 / 创建连线 / 复制 ID
 *
 * 菜单使用 WAI-ARIA menu 模式（role="menu" + button[role="menuitem"]），
 * 打开时自动聚焦第一个菜单项，支持 Arrow Up/Down 键盘导航 + Escape 关闭。
 *
 * @param ctx 图谱视图上下文
 * @param nodeId 被右键的节点 ID
 * @param x 菜单显示位置（屏幕 X）
 * @param y 菜单显示位置（屏幕 Y）
 */
export function showGraphContextMenu(ctx: MemoryGraphPanelContext, nodeId: string, x: number, y: number): void {
  // 隐藏已有的菜单（同时清理上一次的监听器）
  hideGraphContextMenu(ctx);

  const menu = document.getElementById('graph-context-menu');
  if (!menu) return;

  // 绑定菜单项点击事件（用 onclick 覆盖赋值，确保每次打开是全新的单一监听器，无累积）
  const handler = (action: string) => {
    hideGraphContextMenu(ctx);
    ctx.getGraphContextMenuCallback()?.(action, nodeId);
  };

  // 菜单项是静态模板元素，缺失即 bug，用 ! 断言正视契约
  const focusItem = menu.querySelector('[data-action="focus-subgraph"]')! as HTMLElement;
  const detailItem = menu.querySelector('[data-action="view-detail"]')! as HTMLElement;
  const connectItem = menu.querySelector('[data-action="connect-from"]')! as HTMLElement;
  const copyItem = menu.querySelector('[data-action="copy-id"]')! as HTMLElement;

  focusItem.onclick = () => handler('focus-subgraph');
  detailItem.onclick = () => handler('view-detail');
  connectItem.onclick = () => handler('connect-from');
  copyItem.onclick = () => handler('copy-id');

  // 定位菜单（避免超出视口）
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.remove('hidden');

  // 打开菜单后聚焦第一个 menuitem，使键盘用户可立即操作
  focusItem.focus();

  // 键盘导航处理器（Arrow Up/Down 移动焦点 + Escape 关闭）
  const menuItems = [focusItem, detailItem, connectItem, copyItem];
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const currentIdx = menuItems.indexOf(document.activeElement as HTMLElement);
      const nextIdx = (currentIdx + 1) % menuItems.length;
      menuItems[nextIdx]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const currentIdx = menuItems.indexOf(document.activeElement as HTMLElement);
      const prevIdx = (currentIdx - 1 + menuItems.length) % menuItems.length;
      menuItems[prevIdx]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideGraphContextMenu(ctx);
      // 关闭后焦点回到 Canvas，键盘用户可继续浏览图谱
      const canvas = document.getElementById('memory-graph-canvas');
      if (canvas instanceof HTMLCanvasElement) canvas.focus();
    }
  };
  ctx.setGraphContextMenuKeyHandler(keyHandler);
  menu.addEventListener('keydown', keyHandler);

  // 点击菜单外部关闭——closeHandler 存储为 context 字段，hideGraphContextMenu 时移除
  // 避免：用户打开菜单后不点菜单项而点外部，原 once 监听器残留累积
  const closeHandler = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      hideGraphContextMenu(ctx);
    }
  };
  ctx.setGraphContextMenuCloseHandler(closeHandler);

  // setTimeout 延迟注册，避免当前右键 click 事件立即触发 closeHandler
  setTimeout(() => {
    const handler = ctx.getGraphContextMenuCloseHandler();
    if (handler) {
      document.addEventListener('click', handler);
    }
  }, 0);
}

/**
 * 隐藏图谱上下文菜单，并清理 document + menu 上的监听器
 *
 * @param ctx 图谱视图上下文
 */
export function hideGraphContextMenu(ctx: MemoryGraphPanelContext): void {
  const menu = document.getElementById('graph-context-menu');
  if (menu) {
    menu.classList.add('hidden');
    // 移除键盘导航监听器
    const keyHandler = ctx.getGraphContextMenuKeyHandler();
    if (keyHandler) {
      menu.removeEventListener('keydown', keyHandler);
      ctx.setGraphContextMenuKeyHandler(null);
    }
  }
  // 移除 closeHandler，防止内存泄漏（用户切换面板/关闭菜单时都需要清理）
  const closeHandler = ctx.getGraphContextMenuCloseHandler();
  if (closeHandler) {
    document.removeEventListener('click', closeHandler);
    ctx.setGraphContextMenuCloseHandler(null);
  }
}

// ─── 关系编辑弹窗 ──────────────────────────────────────────

/**
 * 显示关系编辑弹窗（点击已有边 → 编辑/删除）
 *
 * @param ctx 图谱视图上下文
 * @param sourceId 关系起点
 * @param targetId 关系终点
 * @param type 当前关系类型
 * @param weight 当前权重
 */
export function showRelationEditDialog(
  ctx: MemoryGraphPanelContext,
  sourceId: string,
  targetId: string,
  type: string,
  weight: number,
): void {
  const dialog = document.getElementById('relation-edit-dialog');
  if (!dialog) return;

  // 重置 UI 状态（防御性，处理 Escape 走 modal.ts hideModal 路径留下的残留）
  const deleteBtnReset = dialog.querySelector('#relation-edit-delete')!;
  const titleElReset = dialog.querySelector('.modal-header h3')!;
  deleteBtnReset.classList.remove('hidden');
  titleElReset.textContent = '编辑关系';

  // 填充当前值（弹窗模板静态元素，dialog 已确认存在，用 ! 断言正视契约）
  const typeSelect = dialog.querySelector('#relation-edit-type')! as HTMLSelectElement;
  const weightInput = dialog.querySelector('#relation-edit-weight')! as HTMLInputElement;
  const weightValue = dialog.querySelector('#relation-edit-weight-value')!;

  typeSelect.value = type;
  weightInput.value = String(weight);
  weightValue.textContent = String(Math.round(weight * 100));

  // 绑定保存
  const saveBtn = dialog.querySelector('#relation-edit-save')! as HTMLElement;
  saveBtn.onclick = () => {
    const newType = typeSelect.value || type;
    const newWeight = parseFloat(weightInput.value);
    ctx.getRelationEditCallback()?.(sourceId, targetId, newType, newWeight);
    hideRelationEditDialog();
  };

  // 绑定删除
  const deleteBtn = dialog.querySelector('#relation-edit-delete')! as HTMLElement;
  deleteBtn.onclick = () => {
    ctx.getRelationDeleteCallback()?.(sourceId, targetId, type);
    hideRelationEditDialog();
  };

  // 绑定取消
  const cancelBtn = dialog.querySelector('#relation-edit-cancel')! as HTMLElement;
  cancelBtn.onclick = () => hideRelationEditDialog();

  // 背景遮罩点击关闭（点击 .modal 自身背景区域关闭，与 .modal 类的 Escape 监听配套）
  dialog.addEventListener('click', (e: MouseEvent) => {
    if (e.target === dialog) hideRelationEditDialog();
  });

  // 权重滑块联动
  weightInput.oninput = () => {
    weightValue.textContent = String(Math.round(parseFloat(weightInput.value) * 100));
  };

  dialog.classList.remove('hidden');
}

/**
 * 显示关系创建弹窗（Ctrl+拖拽连线 → 创建新关系）
 *
 * @param ctx 图谱视图上下文
 * @param sourceId 连线起点节点 ID
 * @param targetId 连线终点节点 ID
 */
export function showRelationCreateDialog(
  ctx: MemoryGraphPanelContext,
  sourceId: string,
  targetId: string,
): void {
  const dialog = document.getElementById('relation-edit-dialog');
  if (!dialog) return;

  // 重置为默认值（弹窗模板静态元素，dialog 已确认存在，用 ! 断言正视契约）
  const typeSelect = dialog.querySelector('#relation-edit-type')! as HTMLSelectElement;
  const weightInput = dialog.querySelector('#relation-edit-weight')! as HTMLInputElement;
  const weightValue = dialog.querySelector('#relation-edit-weight-value')!;
  const deleteBtn = dialog.querySelector('#relation-edit-delete')!;
  const titleEl = dialog.querySelector('.modal-header h3')!;

  // 创建模式下隐藏删除按钮，标题改为"创建关系"
  deleteBtn.classList.add('hidden');
  titleEl.textContent = '创建关系';
  typeSelect.value = 'related';
  weightInput.value = '0.5';
  weightValue.textContent = '50';

  // 绑定保存
  const saveBtn = dialog.querySelector('#relation-edit-save')! as HTMLElement;
  saveBtn.onclick = () => {
    const newType = typeSelect.value || 'related';
    const newWeight = parseFloat(weightInput.value);
    ctx.getRelationCreateCallback()?.(sourceId, targetId, newType, newWeight);
    hideRelationEditDialog();
  };

  // 绑定取消
  const cancelBtn = dialog.querySelector('#relation-edit-cancel')! as HTMLElement;
  cancelBtn.onclick = () => hideRelationEditDialog();

  // 背景遮罩点击关闭（点击 .modal 自身背景区域关闭，与 .modal 类的 Escape 监听配套）
  dialog.addEventListener('click', (e: MouseEvent) => {
    if (e.target === dialog) hideRelationEditDialog();
  });

  // 权重滑块联动
  weightInput.oninput = () => {
    weightValue.textContent = String(Math.round(parseFloat(weightInput.value) * 100));
  };

  dialog.classList.remove('hidden');
}

/**
 * 隐藏关系编辑弹窗，恢复默认状态
 */
function hideRelationEditDialog(): void {
  const dialog = document.getElementById('relation-edit-dialog');
  if (!dialog) return;
  dialog.classList.add('hidden');

  // 恢复默认 UI（弹窗模板静态元素，dialog 已确认存在，用 ! 断言正视契约）
  const deleteBtn = dialog.querySelector('#relation-edit-delete')!;
  const titleEl = dialog.querySelector('.modal-header h3')!;
  deleteBtn.classList.remove('hidden');
  titleEl.textContent = '编辑关系';
}
