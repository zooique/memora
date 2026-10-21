/**
 * 计划常驻条（planBar）渲染域容器
 *
 * 自 `chatView.ts` 外置（HOST-SPLIT-1 chatView 首刀）：单轨任务看板 = 顶部常驻条
 * （N/M + 进度条 + 当前 active 任务项摘要）+ 锚定浮层（全量任务项 + 任务项推进记录）。
 *
 * 三条设计约束（在 chatView 内联时期已定案，随域迁移，不在两处重述）：
 *   ① 常驻门槛 ≥3 个任务项 = **展示层自身决策**（2 个任务项常驻成噪音）。它与内核
 *      `detectNeedsPlanning` 的关键词/结构式**布尔判定无对应关系**，也不构成需互相同步的
 *      约束；内核 `taskTableRenderer` 的 `plan.length < 3` 是**收尾验证门槛**，同数字但别义，
 *      改任一处都**不需要**同步另一处。
 *   ② 缓存保持「最近一次非空 plan」：plan 清空（turn 收尾 autoClearPlan）时**不覆写**缓存，
 *      供 round-block 的任务项标签继续读取。
 *   ③ 浮层懒构建：收起态不建面板 DOM；收起时清空面板内容，防残留 DOM 挡住下次展开的重建。
 *
 * 状态（`planBarEl` / `planBarExpanded` / `currentPlanItems`）全部封装在工厂闭包内，
 * view 侧只经窄接口读写——不外泄内部变量，避免出现第二写入点。
 *
 * @module planBarView
 */

import type { PlanItemDto } from '../../shared/protocol.js';
import { applyIcon } from './icons.js';

/** 任务项状态 → 中文标签（状态枚举固定，缺一即编译报错，无需运行时兜底） */
const PLAN_ITEM_STATUS_LABEL: Record<PlanItemDto['status'], string> = {
  pending: '待执行',
  active: '进行中',
  done: '已完成',
  blocked: '阻塞',
};

/** 相对时间格式化（任务项推进记录完成时间 → "3s 前 / 2m 前 / 1h 前"） */
function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  // 时间差（钳到非负：宿主时钟与 webview 时钟可能有微小回拨）
  const diff = Math.max(0, now - timestamp);
  // 秒级 → 分钟级 → 小时级 → 天级，逐档降精度
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s 前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m 前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h 前`;
  const days = Math.floor(hours / 24);
  return `${days}d 前`;
}

/** 工厂依赖：只需要文档对象（DOM 引用按需惰性查询，不预先注入节点） */
export interface PlanBarViewDeps {
  /** webview 文档对象（`#planBar` 为静态骨架，脚本执行时已存在） */
  document: Document;
}

/**
 * 计划栏窄接口（view 侧唯一可触面）
 *
 * 三个数据面（写 / 清 / 读缓存）+ 四个开合面（读 / 切换 / 收起 / 命中判定）。
 * 开合交互监听器**留在 chatView**（注册时机与顺序零变化），此处只提供方法。
 */
export interface PlanBarView {
  /** 刷新看板（`plan_update` 消息入口；含常驻门槛判定与缓存写入） */
  renderBoard(items: PlanItemDto[]): void;
  /** 完全重置（清空/切换会话）：隐藏常驻条并清空缓存 */
  removeAll(): void;
  /** 只读快照（round-block 任务项标签读取；调用方不得改动返回数组） */
  getItems(): readonly PlanItemDto[];
  /** 浮层是否展开 */
  isExpanded(): boolean;
  /** 切换浮层开合（头部点击） */
  toggleExpanded(): void;
  /** 收起浮层（外部点击 / Esc） */
  collapse(): void;
  /** 目标节点是否在常驻条（含浮层）内部——用于「点在浮层外才收起」判定 */
  containsTarget(target: Node): boolean;
}

/**
 * 创建计划常驻条渲染域
 *
 * @param deps 工厂依赖（仅 document）
 * @returns 窄接口（状态封装在闭包内）
 */
export function createPlanBarView({ document }: PlanBarViewDeps): PlanBarView {
  /** 顶部常驻进度条插槽（惰性查询单例；HTML #planBar，hidden 由本域直控） */
  let planBarEl: HTMLElement | null = null;
  /** 锚定浮层展开态（点击头部切换；浮层非 modal——看进度时需同时看正文） */
  let planBarExpanded = false;
  /** 当前计划快照缓存（供 round-block 任务项标签 + 浮层复用，零新增协议）。
   *  保持「最近一次非空 plan」：plan 清空时不覆写（round-block 重建时任务项标签仍可读） */
  let currentPlanItems: PlanItemDto[] = [];

  /** 惰性获取常驻条插槽（单例：同一 DOM 节点，避免每次渲染重新 getElementById） */
  function getPlanBarEl(): HTMLElement | null {
    if (!planBarEl) planBarEl = document.getElementById('planBar');
    return planBarEl;
  }

  /** 移除所有任务看板（常驻条隐藏 + 浮层收起 + 状态缓存重置）。
   *  注意：clear_ok/切换会话时调用，与 plan 清空（autoClearPlan）的「顶部条收起」语义不同——
   *  clear_ok 意味着完全重置对话区，缓存也应一起清 */
  function removeAllPlanBoards(): void {
    setPlanBarVisible(false);
    currentPlanItems = [];
  }

  /** 常驻条可见性切换（幂等：hidden 布尔直控；隐藏时同步收起浮层，防浮层孤儿） */
  function setPlanBarVisible(visible: boolean): void {
    const bar = getPlanBarEl();
    if (!bar) return;
    bar.hidden = !visible;
    if (!visible) setPlanBarExpanded(false);
  }

  /** 锚定浮层展开/收起（点击 head 切换；浮层非 modal——看进度时需同时看正文）。
   *  展开态同时写 aria-expanded（可访问性）与 chevron 图标（chevron-right 收起态 /
   *  chevron-down 展开态，icons.ts 的 SVG）。
   *  懒构建：展开时才从当前快照补建面板（收起态 renderPlanBar 不建 DOM，省运行期开销）。
   *  ⚠ 收起时清空面板内容：plan 清空（收尾 autoClearPlan）后 setPlanBarVisible(false) 把
   *  planBarExpanded 置 false，若旧面板 DOM 残留——再次展开时懒构建门 childElementCount===0
   *  被残留 DOM 挡住不重建，任务表保持第一次展开的快照（数字更新但完成状态不更新）。坑：
   *  清空后展开必重建为最新快照。 */
  function setPlanBarExpanded(expanded: boolean): void {
    planBarExpanded = expanded;
    const bar = getPlanBarEl();
    const head = bar?.querySelector<HTMLElement>('#planBarHead');
    const panel = bar?.querySelector<HTMLElement>('#planBarPanel');
    const chevron = bar?.querySelector<HTMLElement>('#planBarChevron');
    if (head) head.setAttribute('aria-expanded', String(expanded));
    if (panel) {
      // 展开且面板尚未构建（收起态跳过建 DOM）→ 从当前快照补建
      if (expanded && panel.childElementCount === 0 && currentPlanItems.length > 0) {
        renderPlanBarPanel(currentPlanItems);
      } else if (!expanded) {
        // 收起即视为「未构建」：清空面板，防残留 DOM 挡住下次展开的懒构建重建
        panel.innerHTML = '';
      }
      panel.hidden = !expanded;
    }
    if (chevron) applyIcon(chevron, expanded ? 'chevron-down' : 'chevron-right');
  }

  /** 渲染常驻条（一行头 + 锚定浮层内容）。头 = N/M + 进度条 + 当前 active 任务项摘要。
   *  浮层懒构建：仅展开态重建面板（运行时 plan_update 频繁，收起态不建 DOM——省开销） */
  function renderPlanBar(items: PlanItemDto[]): void {
    const bar = getPlanBarEl();
    if (!bar) return;
    // 完成计数与总量（头行的 N/M）
    const doneCount = items.filter((s) => s.status === 'done').length;
    const total = items.length;
    // 进度条宽度（空表按 0% 处理，避免除零）
    const percent = total > 0 ? (doneCount / total) * 100 : 0;
    // 当前推进中的任务项（头行摘要来源）
    const activePlanItem = items.find((s) => s.status === 'active');
    // 头行各槽位（HTML #planBar 内固定 id；零新增协议）
    const countEl = bar.querySelector<HTMLElement>('#planBarCount');
    const fillEl = bar.querySelector<HTMLElement>('#planBarFill');
    const currentEl = bar.querySelector<HTMLElement>('#planBarCurrent');
    if (countEl) countEl.textContent = `${doneCount}/${total}`;
    if (fillEl) fillEl.style.width = `${percent}%`;
    if (currentEl) {
      if (doneCount === total && total > 0) {
        currentEl.textContent = '已完成';
      } else if (activePlanItem) {
        // 摘要超 28 字截断，避免撑破一行
        const brief =
          activePlanItem.description.length > 28
            ? `${activePlanItem.description.slice(0, 28)}…`
            : activePlanItem.description;
        currentEl.textContent = brief;
      } else {
        currentEl.textContent = '';
      }
    }
    if (planBarExpanded) {
      renderPlanBarPanel(items); // 展开态：面板跟随最新快照重建
    }
    setPlanBarExpanded(planBarExpanded); // 保持展开态（aria/chevron 同步；收起态不建面板）
  }

  function renderPlanBarPanel(items: PlanItemDto[]): void {
    const bar = getPlanBarEl();
    const panel = bar?.querySelector<HTMLElement>('#planBarPanel');
    if (!panel) return;
    panel.innerHTML = '';
    panel.appendChild(buildPlanItemList(items));
  }

  /** 构建全量任务项列表（ul.plan-board-list；任务浮层专用——round-block 内任务项组标题走
   *  round-block__plan-item-summary 独立实现，两处不同构） */
  function buildPlanItemList(items: PlanItemDto[]): HTMLUListElement {
    const ul = document.createElement('ul');
    ul.className = 'plan-board-list';
    for (const planItem of items) {
      // 任务节点折叠：每个任务项一个 details，summary = 序号+描述+状态徽标
      const item = document.createElement('details');
      item.className = `plan-item plan-item-${planItem.status}`;
      item.open = false;
      const summary = document.createElement('summary');
      summary.className = 'plan-item-summary';
      const label = document.createElement('span');
      label.className = 'plan-item-title';
      label.textContent = `${planItem.order + 1}. ${planItem.description}`;
      summary.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'plan-item-badge';
      badge.textContent = PLAN_ITEM_STATUS_LABEL[planItem.status];
      summary.appendChild(badge);
      item.appendChild(summary);
      const logs = planItem.planItemLog;
      if (logs.length > 0) {
        const body = document.createElement('div');
        body.className = 'plan-item-rounds';
        const now = Date.now();
        for (const r of logs) {
          const row = document.createElement('div');
          row.className = 'plan-item-round';
          // 相对时间：completedAt 可选，有则显示"3s 前 / 2m 前 / 1h 前"
          if (r.completedAt) {
            const span = document.createElement('span');
            span.className = 'plan-item-round-time';
            span.textContent = formatRelativeTime(r.completedAt, now);
            row.appendChild(span);
            const text = document.createElement('span');
            text.textContent = r.summary;
            row.appendChild(text);
          } else {
            row.textContent = r.summary;
          }
          body.appendChild(row);
        }
        item.appendChild(body);
      }
      ul.appendChild(item);
    }
    return ul;
  }

  /** 渲染/刷新单轨任务看板（收到 plan_update 消息时调用）。
   *  非空 plan → 缓存 + 常驻条（≥3 个任务项才显示，门槛依据见模块头 ①）；
   *  空 plan → 收起常驻条（内容区零投影——任务过程由 round-block 折叠块承载，不留完成卡片） */
  function renderPlanBoard(items: PlanItemDto[]): void {
    if (items.length === 0) {
      // 空计划（turn 收尾 autoClearPlan / LLM 写入空表）→ 收起顶部条
      setPlanBarVisible(false);
      return;
    }
    // 非空计划：缓存（供 round-block 任务项标签 + 浮层复用）；plan 清空时不清此缓存
    currentPlanItems = items;
    setPlanBarVisible(items.length >= 3);
    if (items.length >= 3) {
      renderPlanBar(items);
    }
  }

  return {
    renderBoard: renderPlanBoard,
    removeAll: removeAllPlanBoards,
    getItems: () => currentPlanItems,
    isExpanded: () => planBarExpanded,
    toggleExpanded: () => setPlanBarExpanded(!planBarExpanded),
    collapse: () => setPlanBarExpanded(false),
    containsTarget: (target: Node) => {
      const bar = getPlanBarEl();
      return bar !== null && bar.contains(target);
    },
  };
}
