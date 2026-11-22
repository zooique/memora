/**
 * 底部状态条收纳器（StatusDock，ADR-037 形态宪法）
 *
 * 由 chatView 外置（本批腾行）：本文件收「裁决 + 搬移 + 抽屉入口态」这一自洽状态机，
 * chatView 只保留元素引用、注册点与 deps 接线。实现契约见
 * docs/方案-底部状态条收纳-20261001.md §三。
 *
 * 底部三条（fileChanges / pendingQueue / activityBar 非错误态）同屏堆叠收紧：
 * 主位常显优先级最高一条，其余收进「+N」浮层（同 planBar head→panel 纵向展开形态）。
 * 🔴 SSOT：三条的 hidden 与 DOM 归位**只由 resolve 裁决**——各条更新函数只上报
 * setActive / setFixed，禁直写 hidden / insertBefore（散写即回到堆叠现状）。
 * error 豁免（fail-visible）：fixed 恒主位，裁决优先于 priority 排序。
 * background 取最低（0）：activity 承载「正在思考/执行」主状态，不可被后台条顶掉；轮次
 * 收尾后 activity 归位、后台任务仍在跑 ⇒ 它自动成为唯一活跃条升主位，「终止」按钮恰在
 * 最需要它的时刻直接可见（方案 §2.3）。
 *
 * ─── 提示 UI 两分收敛（A 类阻断 / B 类信息，方案-提示UI两分收敛-20261005.md §四/§五）───
 * 🔴 SSOT：A、B 两类**共用一个裁决器** resolve()——不另造 promptSlot 裁决器
 * （两个裁决器会争同一个插入锚点、顺序不定，即双源）。A 类作为最高优先级 entry 注册
 * 进来，复用既有 fixed/主位/收纳机制。数值含义：confirm(10) 恒主位，优先于 error 豁免
 * ——确认卡被收纳 = 不可见 = 超时自动拒绝，而 error 被收纳仍可从图标条点开，代价不对称
 * （方案 §九 A2）。
 *
 * dock 浮层放置机制（UI-TOAST-1：活动条浮层化的搬移/类同步；判据与裁决仍在本文件）：
 * 放置/类操作机械收口于 helpers/dockToast.ts，本文件只调用。
 */
import * as l10n from '@vscode/l10n';
import { isToastHead, placeDockHead, toastLoopSkip } from './dockToast.js';

/** 收纳器条目 id（confirm 恒主位；其余按 priority 排序） */
export type DockId = 'confirm' | 'fileChanges' | 'pendingQueue' | 'activity' | 'background';

/** 主位优先级（数值越大越靠前；confirm 单独判据，勿与 B 类数值混用） */
const DOCK_PRIORITY = {
  confirm: 10,
  fileChanges: 3,
  pendingQueue: 2,
  activity: 1,
  background: 0,
} as const;

/** A 类阻断面板的优先级（恒主位判据；勿与 B 类数值混用） */
const CONFIRM_PRIORITY = DOCK_PRIORITY.confirm;

/** 收纳器条目（DOM 节点 + 排序/豁免/活跃三态） */
type DockEntry = {
  el: HTMLElement;
  priority: number;
  /** error 豁免：恒主位（裁决优先于 priority）；error 消失时撤销 */
  fixed: boolean;
  active: boolean;
};

/** 收纳器依赖（全部来自 chatView 闭包内的 const；非类字段，无可见性问题） */
export interface StatusDockDeps {
  /** DOM 文档（本模块不读全局 document） */
  document: Document;
  /** 主位条插入锚（输入区容器） */
  anchor: HTMLElement;
  /** composer 替换目标（A 类阻断面板激活时整体让位） */
  composer: HTMLElement | null;
  /** 抽屉入口 chip（「+N / 活动」） */
  chip: HTMLElement | null;
  /** 抽屉体（面板开合只切它的 hidden） */
  panel: HTMLElement | null;
  /** 被收纳条的单实例容器 */
  controls: HTMLElement | null;
  /** 活动条浮层槽（UI-TOAST-1；缺失时降级流内条） */
  toastSlot: HTMLElement | null;
  /**
   * 抽屉入口判据（时间线就绪 / 未读），懒读：活动抽屉域在本模块之后创建，
   * 直接取值会踩 TDZ；与 chatView 既有「函数引用经声明提升与闭包捕获」同口径。
   */
  getDockState(): { timelineReady: boolean; hasUnread: boolean };
  /** 抽屉拉开即已读（活动抽屉域的信号消费，同为懒调用） */
  onDrawerOpened(): void;
}

/** 收纳器对外动作面（chatView 只经这些动作与它交互） */
export interface StatusDock {
  /** 注册条目（静态节点在初始化期、懒创建条在首次创建时） */
  register(id: DockId, el: HTMLElement): void;
  /** 上报活跃态（判重 no-op，变更即触发裁决） */
  setActive(id: DockId, active: boolean): void;
  /** 上报 error 豁免（fixed 恒主位；判重 no-op） */
  setFixed(id: DockId, fixed: boolean): void;
  /** 单点裁决（显隐 / 归位 / 抽屉入口态） */
  resolve(): void;
  /** 抽屉展开态（活动抽屉域只读） */
  isExpanded(): boolean;
}

/**
 * 构造 StatusDock 收纳器
 *
 * @param deps DOM 锚点与懒读回调（见 StatusDockDeps）
 * @returns 注册/上报/裁决/读展开态四个动作
 */
export function createStatusDock(deps: StatusDockDeps): StatusDock {
  const { document, anchor, composer, chip, panel, controls, toastSlot } = deps;
  const dockEntries = new Map<DockId, DockEntry>();
  /**
   * 抽屉展开态（唯一折叠轴，C1）。
   *
   * 2026-10-05 C1 之前还有第二根轴——#activityDetail 自己的 `<details>.open`，
   * 两轴并存期靠 follower 显隐回调（reconcileActivityDetailVisibility）缝合，
   * 止血契约 P10C 即此物。C1 把时间线静态固定进 #dockPanel 后，details 退化为
   * 普通容器，随从机制整组拆除：开/合只剩这一个变量，只由用户点 #dockChip 翻转。
   */
  let expanded = false;

  function register(id: DockId, el: HTMLElement): void {
    dockEntries.set(id, { el, priority: DOCK_PRIORITY[id], fixed: false, active: false });
  }

  /**
   * composer 替换（A 类阻断面板激活 ⇒ 输入框整体让位）
   *
   * 采用**替换**而非**遮罩**：composer 直接 hidden，面板占据输入框的位置。差别不是审美——
   * ①遮罩要新开 z-index 层（消息区 1 / 输入区 20），会与 treedd 下拉菜单抢层级、还要手写
   * 焦点陷阱；②替换是流布局，零新层级零陷阱；③体验等价：用户此刻只能做「确认/拒绝」这一个决定。
   * 🔴 SSOT：只由 resolve 调用，禁散写（散写会出现「面板关了 composer 没回来」的卡死）。
   */
  function setComposerReplaced(replaced: boolean): void {
    if (composer) composer.hidden = replaced;
    // 同一裁决的第二表现（UI-CONFIRM-FIT-1，2026-10-22 真机反馈「到底部按钮和确认框交叠」）：
    // 一键到底按钮 bottom: calc(100% + sp-4) 锚 #inputBar 顶边，而审批卡恰好占据该区域；
    // 且 #inputBar 有 z-index: var(--z-bar)=20 建层叠上下文、卡片无 z-index ⇒ 按钮既压住
    // 卡片的操作按钮、又能抢走点击。审批时导航本就无意义，故让它一并让位（CSS 见
    // chatStyles.ts `body.confirm-active .scroll-to-bottom`）。
    // 🔴 必须写在这里：判据与 composer 让位完全相同，分开两处写必然漂移（一处改了另一处忘）。
    document.body.classList.toggle('confirm-active', replaced);
  }

  function setActive(id: DockId, active: boolean): void {
    const entry = dockEntries.get(id);
    if (!entry || entry.active === active) return;
    entry.active = active;
    resolve();
  }

  function setFixed(id: DockId, fixed: boolean): void {
    const entry = dockEntries.get(id);
    if (!entry || entry.fixed === fixed) return;
    entry.fixed = fixed;
    resolve();
  }

  /**
   * 主位条裁决（SSOT 单点）：A 类阻断面板恒主位 > error 豁免（fixed）> priority 最大。
   *
   * 数值含义：confirm(10) 恒主位，优先于 error 豁免——确认卡被收纳 = 不可见 = 超时自动拒绝，
   * 而 error 被收纳仍可从图标条点开，代价不对称（方案§九 A2）。
   *
   * 🔴 勿把 error 豁免读成「不管优先级多低都硬占明面」：confirm 在场时 error 一样被收进
   * 浮层——豁免只相对 B 类 priority 排序成立，不越过 confirm。
   *
   * 🔴 单一真源：非活跃条归位（要退到主位之上）与主位条归位（要贴anchor）**共用此裁决**。
   * 早先两处各判一次，改一处忘另一处即出现「主位与 anchor 之间夹着隐藏节点」。
   */
  function pickDockHead(actives: DockEntry[]): DockEntry | undefined {
    return (
      actives.find((e) => e.priority === CONFIRM_PRIORITY) ??
      actives.find((e) => e.fixed) ??
      actives.reduce((a, b) => (b.priority > a.priority ? b : a), actives[0] as DockEntry)
    );
  }

  /**
   * 显隐与归位裁决（SSOT 单点，C1 重写）。
   *
   * 静态链（骨架写死，不再动态插拔）：非活跃条们(hidden) → #dockChip → #dockPanel → inputBar。
   * 每次全量重排三件事：①主位条（pickDockHead）插 inputBar 前，恒紧邻输入框；
   * ②其余活跃条单实例搬入 #dockControls（节点移动保留事件监听）；③非活跃条 hidden 退到
   * #dockChip 之上。时间线 #activityDetail 是 #dockPanel 的静态子节点，**永不参与搬运**。
   *
   * 抽屉入口状态同在此单点裁决：rest>0 显「+N」，否则时间段有内容时显「活动」；
   * 未读只挂 chip 徽章，抽屉从不自动弹（宪法④，ADR-037）。
   */
  function resolve(): void {
    const parent = anchor.parentNode;
    if (!parent || !chip || !panel || !controls) return;
    const actives = [...dockEntries.values()].filter((e) => e.active);
    const head = actives.length > 0 ? pickDockHead(actives) : undefined;
    // UI-TOAST-1：主位恰是 activity 且槽在位 ⇒ 出流定位于浮层槽（confirm 恒主位 ⇒ 抑制涌现）
    const activityToast = isToastHead(head, dockEntries.get('activity'), toastSlot);
    // 全量归位（必须先于重新收纳）：把上一轮搬进 #dockControls 的条先搬回 parent。
    // appendChild 是移动（幂等），随后的归位循环立刻给它们正确位置，中间态无渲染帧。
    // （2026-10-05 探针实锤教训：旧动态 panel 摘除时不先搬空，条会随 panel 一起消失一轮。）
    for (const e of dockEntries.values()) {
      if (toastLoopSkip(e.el, e === head, activityToast, toastSlot)) continue;
      if (e.el.parentNode !== parent) parent.appendChild(e.el);
    }
    // composer 让位裁决（唯一写入点）：A 类阻断面板激活即替换掉输入框——用户此刻只能做
    // 「确认/拒绝」这一个决定。B 类信息条再多条也不抢输入框（它们不阻断）。
    const confirmActive = actives.some((e) => e.priority === CONFIRM_PRIORITY);
    setComposerReplaced(confirmActive);
    // 🔴 结构纪律（探针实锤，2026-10-05）：**主位条与 anchor 之间必须恒定干净**——
    // 物理相邻，不允许隐藏节点夹在中间（点击穿透/点击区错位）。故非活跃条统一退到
    // #dockChip 之上（静态抽屉比任何条都更靠近 anchor），不退 anchor 前。
    // 必须在空态分支之前执行，否则「最后一条撤销」时残留可见。
    for (const e of dockEntries.values()) {
      if (!e.active) {
        e.el.hidden = true;
        parent.insertBefore(e.el, chip);
      }
    }
    const rest = head ? actives.filter((e) => e !== head) : [];
    // 主位归位：浮层主位见 placeDockHead（UI-TOAST-1，出流不挤消息区）；其余条插 anchor
    // 前 = 静态 #dockPanel 之后、inputBar 之前，恒紧贴输入框。
    // 抽屉开合只切 #dockPanel.hidden，chip/panel 从骨架起就不插拔 ⇒ P7/P8 时代
    // 「chip/panel 反复插拔把确认卡挤开、主位条瞬移闪烁」的结构根在此不复存在。
    if (head) {
      placeDockHead(head.el, parent, anchor, activityToast, toastSlot);
      head.el.hidden = false;
    }
    // 被收纳条：单实例移入控件段；收起态隐藏条本身（panel 也 hidden，双保险）
    for (const e of rest) {
      e.el.hidden = !expanded;
      controls.appendChild(e.el);
    }
    controls.hidden = rest.length === 0;
    // 抽屉入口：有被收纳的活跃条（+N）**或**时间段有内容（历史/指标）才可达。
    // 时间线一旦有内容不清空（历史有界保留、metrics 渲染后常驻）⇒ 入口首次出现后常驻，
    // 单条 error 8s 撤后历史仍可从这里拉开——C1 闭合的最后残余缺口（台账 P15 病③）。
    // timelineReady/hasUnread 判据真源随活动抽屉域收口于 activityDrawerView.getDockState（第 4 刀）。
    const { timelineReady, hasUnread } = deps.getDockState();
    // A 类阻断面板激活时入口一并让位（UI-CONFIRM-FIT-1 收尾，2026-10-22）：
    // 卡已按「输入框同盒替身」占据 inputBar 原位，chip 若留在卡上方，同盒错觉立即破功；
    // 且阻断态用户只能做「确认/拒绝」这一个决定，抽屉入口此刻没有承接面。
    // 代价与边界：隐藏的是**入口**不是数据——未读位由 activityDrawerView 持有，
    // 收卡后 resolve 重跑、chip 连同未读徽章原样恢复（不是清未读）。
    const chipVisible = !confirmActive && (rest.length > 0 || timelineReady);
    // 空态（入口不可达）时展开态无意义，强制收起——A 类阻断（confirm）同属入口不可达，
    // 由 chipVisible 判据统一覆盖；其余时刻**不替用户合抽屉**
    //（正在看历史时条全撤 = P10C open 轴血训的同一条纪律，折叠轴只剩这一个）。
    if (!chipVisible) expanded = false;
    chip.hidden = !chipVisible;
    chip.textContent = rest.length > 0 ? `+${rest.length}` : l10n.t('Activity');
    // 可见文案极简（+N/活动），可读名在此补全：收纳数 + 未读后缀。未读圆点是 ::before
    // 装饰（读屏拿不到），有未读必须靠 aria-label 让读屏器报出。
    let dockAria: string;
    if (rest.length > 0) {
      dockAria = hasUnread
        ? l10n.t('{0} folded statuses, unread', String(rest.length))
        : l10n.t('{0} folded statuses', String(rest.length));
    } else {
      dockAria = hasUnread ? l10n.t('Activity history, unread') : l10n.t('Activity history');
    }
    chip.setAttribute('aria-label', dockAria);
    chip.setAttribute('aria-expanded', String(expanded));
    chip.classList.toggle('is-unread', hasUnread);
    // 收起态形态降级（用户诉求 2026-10-07）：收起时 dockChip 收为输入框左侧小气泡，
    // 展开态不带该类 ⇒ 完全保持现状（全宽 pill + 抽屉）。仅切换类，不触碰搬运锚/显隐纪律。
    chip.classList.toggle('is-collapsed', !expanded);
    document.body.classList.toggle('dock-collapsed', !expanded);
    panel.hidden = !expanded;
  }

  /**
   * 抽屉入口点击：唯一折叠轴。拉开＝已读（清两个未读位 + 现场消费指标信号），
   * 开合都只切 expanded 后交 resolve 单点重排，不直写任何 hidden。
   */
  chip?.addEventListener('click', () => {
    expanded = !expanded;
    // 拉开＝已读：未读位与信号消费真源随活动抽屉域收口于 activityDrawerView（第 4 刀）
    if (expanded) deps.onDrawerOpened();
    resolve();
  });

  return {
    register,
    setActive,
    setFixed,
    resolve,
    isExpanded: () => expanded,
  };
}
