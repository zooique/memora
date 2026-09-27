/**
 * pager — 设置面板通用分页组件（webview 侧单一真理源）
 *
 * 记忆 / 技能 / 角色包三个子视图共用同一分页状态机，避免各自实现翻页逻辑：
 *   - 统一数据通道：`fetchPage(page, pageSize)` 由调用方负责取数，数据到达后调用 `show()` 填充；
 *     - 全量前端分页（技能/角色包）：fetchPage 内本地数组 slice → 同步 show；
 *     - 增量服务端分页（记忆）：fetchPage 内 postMessage 向宿主拉页 → 回包后 show。
 *   - 自含 DOM：分页条（‹ 上一页 · 第 x/y 页 · 共 N 条 · 下一页 ›）由组件创建并 append 到
 *     mountRoot，调用方零骨架改动；单页 / 无数据自动隐藏（小数据量不暴露无意义分页 UI）。
 *   - 竞态防护：show(page, ...) 显式携带页码，调用方据 getPage() 校验滞后响应。
 *
 * 组件无模块级全局状态（工厂 + 显式依赖注入），适用 jsdom 单测。
 */
export interface PagerDeps<T> {
  /** 子视图根容器（id 空间隔离约定，不直接使用，仅语义锚点） */
  root: HTMLElement;
  /** 分页条挂载容器：组件将分页条 insert 到 anchor 之前；anchor 缺省时 append 到 mountRoot 末尾 */
  mountRoot: HTMLElement;
  /** 分页条插入锚点（插到该元素之前；不提供则 append 到 mountRoot 末尾） */
  anchor?: HTMLElement;
  /** 每页条数 */
  pageSize: number;
  /** 渲染一页数据（调用方按当前页 items 绘制列表） */
  renderPage: (items: readonly T[]) => void;
  /** 翻页取数回调：外部拿到某页数据后必须调用 controller.show(page, items, total?) 填充 */
  fetchPage: (page: number, pageSize: number) => void;
  /** 计数文案定制（缺省「第 x / y 页（共 N 条）」；total 未知时省略共 N 条） */
  label?: (page: number, pageCount: number, total?: number) => string;
}

/** 分页控制器：调用方与组件交互的只读句柄 */
export interface PagerController<T> {
  /** 数据到达填充：page 必须与当前请求一致（外部据 getPage() 竞态校验），total 可选 */
  show(page: number, items: readonly T[], total?: number): void;
  /** 重置分页态：回到第 1 页并触发 fetchPage(1)（新数据集首次填充） */
  reset(): void;
  /** 下一页（无更多时 no-op） */
  next(): void;
  /** 上一页（首页时 no-op） */
  prev(): void;
  /** 启停分页条（搜索模式等无分页场景停用隐藏） */
  setEnabled(enabled: boolean): void;
  /** 当前页码（竞态校验用） */
  getPage(): number;
}

/**
 * 创建分页控制器并挂载分页条 DOM
 */
export function createPager<T>(deps: PagerDeps<T>): PagerController<T> {
  const { mountRoot, pageSize, renderPage, fetchPage, label, anchor } = deps;

  // 状态：当前页 / 当前页数据 / 总数（undefined = 未知）
  let curPage = 1;
  let curItems: readonly T[] = [];
  let total: number | undefined;
  let enabled = true;

  // 分页条 DOM（自含，append 到 mountRoot；hidden 初始，首次数据到达后可见）
  const bar = document.createElement('div');
  bar.className = 'pager-bar';
  bar.setAttribute('role', 'navigation');
  bar.setAttribute('aria-label', '分页');
  const prevBtn = document.createElement('button');
  prevBtn.className = 'pager-btn';
  prevBtn.textContent = '‹ 上一页';
  prevBtn.title = '上一页';
  const info = document.createElement('span');
  info.className = 'pager-info';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'pager-btn';
  nextBtn.textContent = '下一页 ›';
  nextBtn.title = '下一页';
  bar.append(prevBtn, info, nextBtn);
  // 插入位置：anchor 存在 → 插到 anchor 之前（列表正下的语义位）；否则 append 到 mountRoot 末尾
  const parent = anchor?.parentElement ?? mountRoot;
  parent.insertBefore(bar, anchor ?? null);
  // 初始态即同步（curItems 空 → 隐藏），避免挂载后未填充数据时分页条误显示
  syncBar();

  /** 当前页容量（total 已知时向下取整，未知时按 `当前页数据=满页` 判定还有下一页） */
  function pageCount(): number {
    if (total === undefined) return Math.max(1, curPage);
    return Math.max(1, Math.ceil(total / pageSize));
  }

  function hasPrev(): boolean {
    return curPage > 1;
  }

  function hasNext(): boolean {
    if (total === undefined) return curItems.length === pageSize;
    return curPage < pageCount();
  }

  /** 同步分页条 UI：按钮禁用态 + 计数文案 + 单页/停用隐藏 */
  function syncBar(): void {
    bar.hidden = !enabled || curItems.length === 0 || (total !== undefined && pageCount() <= 1);
    prevBtn.disabled = !hasPrev();
    nextBtn.disabled = !hasNext();
    info.textContent = label
      ? label(curPage, pageCount(), total)
      : total === undefined
        ? `第 ${curPage} 页`
        : `第 ${curPage} / ${pageCount()} 页（共 ${total} 条）`;
  }

  /** 切换页码并渲染：调用 fetchPage 取数（组件不自知数据源，数据到达后经 show 回填） */
  function go(page: number): void {
    if (!enabled) return;
    if (page < 1) return;
    if (total !== undefined && page > pageCount()) return;
    curPage = page;
    fetchPage(page, pageSize);
  }

  prevBtn.addEventListener('click', () => go(curPage - 1));
  nextBtn.addEventListener('click', () => go(curPage + 1));

  return {
    show(page, items, nextTotal) {
      curPage = page;
      curItems = items;
      if (nextTotal !== undefined) total = nextTotal;
      syncBar();
      renderPage(items);
    },
    reset() {
      curPage = 1;
      curItems = [];
      total = undefined;
      syncBar();
      fetchPage(1, pageSize);
    },
    next() {
      if (hasNext()) go(curPage + 1);
    },
    prev() {
      if (hasPrev()) go(curPage - 1);
    },
    setEnabled(nextEnabled) {
      enabled = nextEnabled;
      syncBar();
    },
    getPage() {
      return curPage;
    },
  };
}
