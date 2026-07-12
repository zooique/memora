/**
 * 记忆视图切换 / 分析面板管理辅助（从 memoryPanelManager.ts 提取）
 *
 * 职责：
 *   集中管理记忆面板的视图模式切换（list / timeline / graph）和分析面板互斥切换
 *   （insights / health），降低 memoryPanelManager.ts 体量。涵盖：
 *   - 视图容器显隐切换（含 150ms 退出/进入过渡动画）
 *   - 视图切换令牌（viewSwitchToken）防竞态保护——快速切换时仅最后一次生效
 *   - 分析面板互斥切换 + previousViewMode 恢复
 *   - 视图按钮 / 菜单项 active 状态同步
 *   - 离开记忆面板时 dismissAnalysisPanels 重置状态
 *
 * 提取原因：
 *   memoryPanelManager.ts 1534 行，视图切换 / 分析面板管理相关方法（9 个）
 *   形成完整子系统，约 281 行，相对独立，适合提取为接受 context 的纯函数模块。
 *
 * 设计：
 *   - 纯函数模块，不持有状态，所有依赖通过 MemoryViewSwitcherContext 注入
 *   - 视图状态字段（viewMode / previousViewMode / activeAnalysisPanel / viewSwitchToken）
 *     通过 getter/setter 访问，保持 MemoryPanelManager 作为状态所有者
 *   - 视图内容渲染（renderTimeline / 图谱初始化）通过回调委托给 manager，
 *     避免在 helper 中引入对图谱 / 时间线子系统的依赖
 *   - 不使用 @ts-ignore 或 as any，遵循现有代码风格
 *
 * 先例：
 *   参照 memoryGraphPanel.ts / memoryDetailPanel.ts 的 context 注入模式
 */

// ─── 上下文接口（依赖注入容器） ────────────────────────────

/** 记忆视图模式：list（列表）、timeline（时间线）、graph（图谱） */
export type MemoryViewMode = 'list' | 'timeline' | 'graph';

/** 分析面板类型：insights（统计洞察）、health（健康度诊断） */
export type AnalysisPanelType = 'insights' | 'health';

/**
 * 视图切换子系统所需的上下文
 *
 * 由 MemoryPanelManager 构建并传入。设计为接口而非直接传入 manager 实例，
 * 避免运行时循环依赖并便于独立测试。
 */
export interface MemoryViewSwitcherContext {
  // ─── DOM 元素 ───
  /** 记忆列表容器（缺失时列表视图降级） */
  readonly memoryListEl: HTMLElement | null;

  // ─── 状态访问器（getter/setter，状态所有权归 MemoryPanelManager） ───
  /** 获取当前视图模式 */
  getViewMode(): MemoryViewMode;
  /** 设置当前视图模式 */
  setViewMode(mode: MemoryViewMode): void;
  /** 获取打开分析面板前的视图模式（关闭时恢复） */
  getPreviousViewMode(): MemoryViewMode;
  /** 设置 previousViewMode（toggleAnalysisPanel 打开时记录） */
  setPreviousViewMode(mode: MemoryViewMode): void;
  /** 获取当前激活的分析面板（null 表示无） */
  getActiveAnalysisPanel(): AnalysisPanelType | null;
  /** 设置当前激活的分析面板 */
  setActiveAnalysisPanel(panel: AnalysisPanelType | null): void;
  /** 读取当前视图切换令牌（用于 setTimeout 回调内对比判断是否过期） */
  getViewSwitchToken(): number;
  /** 递增视图切换令牌并返回新值（每次 switchView 调用时触发） */
  incrementViewSwitchToken(): number;

  // ─── 视图内容激活回调（由 manager 提供，封装子视图的初始化逻辑） ───
  /** 切换到 timeline 视图后调用（触发时间线内容渲染） */
  onTimelineViewActivated(): void;
  /** 切换到 graph 视图后调用（触发图谱空状态更新 + 渲染器初始化 + 数据加载） */
  onGraphViewActivated(): void;

  // ─── 回调读取器（onXxx 注册晚于 init，用 getter 读取最新值） ───
  /** 获取更多菜单操作回调（打开 insights/health 时触发数据加载） */
  getMoreMenuActionCallback(): ((action: string) => void) | null;
}

// ─── 视图过渡动画常量 ────────────────────────────────────

/**
 * 视图切换过渡动画时长（毫秒）
 *
 * 与 CSS --transition-base (0.15s) 一致：
 * - 退出动画：当前可见视图添加 memory-view-exit，等待 150ms 后切换可见性
 * - 进入动画：新视图添加 memory-view-enter，再过 150ms 后移除进入类
 */
const VIEW_TRANSITION_DURATION = 150;

// ─── 视图容器显隐 ────────────────────────────────────────

/**
 * 隐藏所有视图容器（list / timeline / graph）
 *
 * 当激活 insights 或 health 分析面板时调用，
 * 确保显示类型互斥切换，避免平铺污染。
 *
 * @param ctx 视图切换上下文
 */
export function hideAllDisplayViews(ctx: MemoryViewSwitcherContext): void {
  const listEl = ctx.memoryListEl;
  const graphEl = document.getElementById('memory-graph-container');
  const timelineEl = document.getElementById('memory-timeline-container');
  if (listEl) listEl.classList.add('hidden');
  if (graphEl) graphEl.classList.add('hidden');
  if (timelineEl) timelineEl.classList.add('hidden');
}

/**
 * 轻量隐藏分析面板（不恢复视图）
 *
 * 供 switchView() 调用——切换视图时只需要关闭分析面板 UI，
 * 不需要恢复 previousViewMode（因为 switchView 本身会切换到新视图）。
 * X 按钮和菜单项 toggle 请使用 hideAnalysisPanel()（会恢复之前的视图）。
 *
 * @param ctx 视图切换上下文
 */
export function hideInsightsAndHealth(ctx: MemoryViewSwitcherContext): void {
  const insightsBar = document.getElementById('memory-insights-bar');
  const healthBar = document.getElementById('memory-health-bar');
  const partnerInsights = document.getElementById('partner-insights');
  if (insightsBar) insightsBar.classList.add('hidden');
  if (healthBar) healthBar.classList.add('hidden');
  if (partnerInsights) partnerInsights.classList.add('hidden');
  ctx.setActiveAnalysisPanel(null);
  updateAnalysisMenuItemsActive(ctx);
}

/**
 * 显示指定视图容器（其他视图隐藏）
 *
 * @param ctx 视图切换上下文
 * @param mode 要显示的视图模式
 */
export function showDisplayView(ctx: MemoryViewSwitcherContext, mode: MemoryViewMode): void {
  const listEl = ctx.memoryListEl;
  const graphEl = document.getElementById('memory-graph-container');
  const timelineEl = document.getElementById('memory-timeline-container');
  if (listEl) listEl.classList.toggle('hidden', mode !== 'list');
  if (graphEl) graphEl.classList.toggle('hidden', mode !== 'graph');
  if (timelineEl) timelineEl.classList.toggle('hidden', mode !== 'timeline');
}

// ─── 分析面板菜单项 active 状态同步 ────────────────────────

/**
 * 更新分析面板菜单项的激活状态
 *
 * 打开分析面板时高亮对应菜单项，关闭时取消高亮。
 *
 * @param ctx 视图切换上下文
 */
export function updateAnalysisMenuItemsActive(ctx: MemoryViewSwitcherContext): void {
  const moreMenu = document.getElementById('memory-more-menu');
  if (!moreMenu) return;
  const items = moreMenu.querySelectorAll('.more-menu-item');
  const activePanel = ctx.getActiveAnalysisPanel();
  items.forEach((item) => {
    const action = item.getAttribute('data-action');
    const isActive = action === activePanel;
    item.classList.toggle('active', isActive);
  });
}

/**
 * 更新更多菜单中视图切换项的 active 状态
 *
 * 切换视图时，标记当前视图对应的菜单项为 active，
 * 让用户通过菜单直观感知当前所处视图模式。
 *
 * @param ctx 视图切换上下文
 * @param mode 当前视图模式
 */
export function updateViewMenuItemsActive(ctx: MemoryViewSwitcherContext, mode: MemoryViewMode): void {
  const moreMenu = document.getElementById('memory-more-menu');
  if (!moreMenu) return;
  const items = moreMenu.querySelectorAll('.more-menu-item');
  items.forEach((item) => {
    const action = item.getAttribute('data-action');
    // 仅视图切换项参与 active 标记（advanced-search/insights/health 不参与）
    const isActive = action === `view-${mode}`;
    item.classList.toggle('active', isActive);
  });
}

// ─── 分析面板切换（公开 API） ─────────────────────────────

/**
 * 切换分析面板（统计洞察 / 健康度诊断）
 *
 * - 如果点击的是当前已激活的面板，则关闭它并恢复之前的视图
 * - 如果点击的是不同面板，则切换到新面板（互斥）
 * - 首次打开时记录当前视图模式，关闭时恢复
 *
 * @param ctx 视图切换上下文
 * @param panel 目标面板：'insights' 或 'health'
 */
export function toggleAnalysisPanel(ctx: MemoryViewSwitcherContext, panel: AnalysisPanelType): void {
  const insightsBar = document.getElementById('memory-insights-bar');
  const healthBar = document.getElementById('memory-health-bar');
  const partnerInsights = document.getElementById('partner-insights');
  const targetBar = panel === 'insights' ? insightsBar : healthBar;
  const otherBar = panel === 'insights' ? healthBar : insightsBar;

  if (!targetBar) return;

  const isAlreadyActive = ctx.getActiveAnalysisPanel() === panel;

  if (isAlreadyActive) {
    // 再次点击当前面板 → 关闭
    hideAnalysisPanel(ctx);
    return;
  }

  // 打开新面板：记录当前视图（如果之前没有激活的面板）
  if (ctx.getActiveAnalysisPanel() === null) {
    ctx.setPreviousViewMode(ctx.getViewMode());
  }

  // 隐藏主视图和另一个面板
  hideAllDisplayViews(ctx);
  if (otherBar) otherBar.classList.add('hidden');
  // 打开 health 时隐藏 partner-insights（它是 insights 的子内容）
  if (panel === 'health' && partnerInsights) {
    partnerInsights.classList.add('hidden');
  }

  // 显示目标面板
  targetBar.classList.remove('hidden');
  ctx.setActiveAnalysisPanel(panel);

  // 更新菜单项高亮
  updateAnalysisMenuItemsActive(ctx);

  // 触发数据加载回调
  ctx.getMoreMenuActionCallback()?.(panel);
}

/**
 * 隐藏分析面板并恢复主视图
 *
 * 点击关闭按钮、再次点击菜单项、或切换视图时调用。
 * 恢复打开分析面板前的视图模式。
 *
 * @param ctx 视图切换上下文
 */
export function hideAnalysisPanel(ctx: MemoryViewSwitcherContext): void {
  const insightsBar = document.getElementById('memory-insights-bar');
  const healthBar = document.getElementById('memory-health-bar');
  const partnerInsights = document.getElementById('partner-insights');
  if (insightsBar) insightsBar.classList.add('hidden');
  if (healthBar) healthBar.classList.add('hidden');
  if (partnerInsights) partnerInsights.classList.add('hidden');

  // 恢复之前的主视图
  if (ctx.getActiveAnalysisPanel() !== null) {
    const previousMode = ctx.getPreviousViewMode();
    showDisplayView(ctx, previousMode);
    ctx.setViewMode(previousMode);
    ctx.setActiveAnalysisPanel(null);

    // 同步视图切换按钮状态
    const currentMode = ctx.getViewMode();
    const listBtn = document.getElementById('btn-list-view');
    const timelineBtn = document.getElementById('btn-timeline-view');
    const graphBtn = document.getElementById('btn-graph-view');
    if (listBtn) {
      listBtn.classList.toggle('active', currentMode === 'list');
      listBtn.setAttribute('aria-selected', String(currentMode === 'list'));
    }
    if (timelineBtn) {
      timelineBtn.classList.toggle('active', currentMode === 'timeline');
      timelineBtn.setAttribute('aria-selected', String(currentMode === 'timeline'));
    }
    if (graphBtn) {
      graphBtn.classList.toggle('active', currentMode === 'graph');
      graphBtn.setAttribute('aria-selected', String(currentMode === 'graph'));
    }
  }

  // 更新菜单项高亮
  updateAnalysisMenuItemsActive(ctx);
}

/**
 * 切换面板时关闭分析面板（公开方法，供 UI 层在离开记忆面板时调用）
 *
 * 只隐藏 DOM 元素和重置状态，不恢复视图——因为面板本身将被隐藏，
 * 下次进入记忆面板时默认显示列表视图。
 *
 * @param ctx 视图切换上下文
 */
export function dismissAnalysisPanels(ctx: MemoryViewSwitcherContext): void {
  const insightsBar = document.getElementById('memory-insights-bar');
  const healthBar = document.getElementById('memory-health-bar');
  const partnerInsights = document.getElementById('partner-insights');
  if (insightsBar) insightsBar.classList.add('hidden');
  if (healthBar) healthBar.classList.add('hidden');
  if (partnerInsights) partnerInsights.classList.add('hidden');
  // 重置内部状态：下次打开时重新记录 previousViewMode
  ctx.setActiveAnalysisPanel(null);
  ctx.setViewMode('list');
  updateAnalysisMenuItemsActive(ctx);
  // 同步视图按钮状态到列表
  const listBtn = document.getElementById('btn-list-view');
  const timelineBtn = document.getElementById('btn-timeline-view');
  const graphBtn = document.getElementById('btn-graph-view');
  if (listBtn) {
    listBtn.classList.add('active');
    listBtn.setAttribute('aria-selected', 'true');
  }
  if (timelineBtn) {
    timelineBtn.classList.remove('active');
    timelineBtn.setAttribute('aria-selected', 'false');
  }
  if (graphBtn) {
    graphBtn.classList.remove('active');
    graphBtn.setAttribute('aria-selected', 'false');
  }
}

// ─── 视图切换主入口（公开 API） ───────────────────────────

/**
 * 切换记忆视图模式（列表 ↔ 时间线 ↔ 图谱）
 *
 * 图谱视图使用 Canvas 2D 力导向图渲染记忆关系网络。
 * 时间线视图按天分组记忆列表。
 * 首次切换时延迟初始化渲染器（确保 Canvas DOM 已就绪）。
 * 关系数据为空时隐藏图谱标签，保持列表视图。
 *
 * **竞态保护**：通过 viewSwitchToken 防止快速切换视图时 setTimeout 回调
 * 相互覆盖导致空白。每次调用递增 token，setTimeout 回调内对比捕获的 token
 * 与当前 token，不一致则直接返回（旧回调作废）。
 *
 * @param ctx 视图切换上下文
 * @param mode 目标视图模式
 */
export function switchView(ctx: MemoryViewSwitcherContext, mode: MemoryViewMode): void {
  ctx.setViewMode(mode);
  // 递增视图切换令牌，过期 setTimeout 回调会被忽略
  const token = ctx.incrementViewSwitchToken();

  // 切换视图时隐藏 insights/health，避免显示类型平铺污染
  hideInsightsAndHealth(ctx);
  // 同步更多菜单中视图切换项的 active 状态
  updateViewMenuItemsActive(ctx, mode);

  // B2: 切换列表、时间线和图谱容器的可见性，统一用 .hidden 类
  const listEl = ctx.memoryListEl;
  const graphEl = document.getElementById('memory-graph-container');
  const timelineEl = document.getElementById('memory-timeline-container');

  // 视图切换过渡动画：先退出旧视图，再进入新视图
  const allViews = [listEl, graphEl, timelineEl].filter(Boolean) as HTMLElement[];

  // 当前可见的视图 → 添加退出动画
  const currentView = allViews.find((v) => !v.classList.contains('hidden'));
  if (currentView) {
    currentView.classList.add('memory-view-exit');
  }

  // 延迟切换视图（等待退出动画完成）
  setTimeout(() => {
    // 令牌检查——若期间有新 switchView 调用，本回调作废
    if (token !== ctx.getViewSwitchToken()) return;
    // 移除所有视图的退出态
    allViews.forEach((v) => v.classList.remove('memory-view-exit'));

    if (mode === 'list') {
      if (listEl) {
        listEl.classList.remove('hidden');
        listEl.classList.add('memory-view-enter');
      }
      if (graphEl) graphEl.classList.add('hidden');
      if (timelineEl) timelineEl.classList.add('hidden');
    } else if (mode === 'timeline') {
      if (listEl) listEl.classList.add('hidden');
      if (graphEl) graphEl.classList.add('hidden');
      if (timelineEl) {
        timelineEl.classList.remove('hidden');
        timelineEl.classList.add('memory-view-enter');
        // 委托给 manager：渲染时间线内容（按天分组记忆列表）
        ctx.onTimelineViewActivated();
      }
    } else {
      if (listEl) listEl.classList.add('hidden');
      if (timelineEl) timelineEl.classList.add('hidden');
      if (graphEl) {
        graphEl.classList.remove('hidden');
        graphEl.classList.add('memory-view-enter');
        // 委托给 manager：更新空状态 + 初始化渲染器 + 加载缓存数据
        ctx.onGraphViewActivated();
      }
    }

    // 动画完成后移除进入类
    setTimeout(() => {
      // 内层回调同样检查令牌
      if (token !== ctx.getViewSwitchToken()) return;
      allViews.forEach((v) => v.classList.remove('memory-view-enter'));
    }, VIEW_TRANSITION_DURATION);
  }, VIEW_TRANSITION_DURATION);
}
