/**
 * 助手页内嵌工作台抽屉（INLINE-WORKBENCH-1）
 *
 * 职责：把宿主现场构建的 `WorkbenchSnapshot` 渲染成助手页身份条下方的一块只读抽屉，
 * 让「助手在管哪些活 / 覆盖读到多少 / 座位来源」在助手页就地可见，不再新开 editor tab。
 *
 * SSOT 纪律：
 *   - 数据真源 = 宿主 `MemoraWorkbenchPanel.buildSnapshot`（与独立面板同一投影函数）；
 *   - 状态 / 座位措辞 = 复用 `workbenchView` 的 `describeStatus` / `seatStateText`，
 *     **不另写一套文案**，独立面板与本抽屉逐字同源；
 *   - 点击出口 = 回调注入 `openSession(sid)`（chatView 接既有 `switch_session`），
 *     不新增协议 type、不动 workbench 的 `workbench_open_session` 判据。
 *
 * 本模块是纯函数 + DOM 构造，无 webview 全局副作用（符合 helpers/ 落点纪律）。
 */
import * as l10n from '@vscode/l10n';
import type {
  WorkbenchJob,
  WorkbenchJobStatus,
  WorkbenchSnapshot,
} from '../../shared/workbenchDto.js';
import { describeStatus, seatStateText } from '../scripts/workbenchView.js';

/** 抽屉依赖（窄接口，便于测试替身） */
export interface AssistantWorkbenchDrawerDeps {
  /** 文档对象（构造唯一 DOM 入口，禁读全局 document） */
  document: Document;
  /** 「去这个会话」回调（chatView 注入既有 switch_session 出口） */
  openSession: (sessionId: string) => void;
  /** 在独立 editor tab 打开工作台看板（chatView 注入：上行 open_workbench_tab；UI-SEAT-AUDIT） */
  openInTab: () => void;
  /**
   * 重置助手会话（ASSISTANT-UI-DECLUTTER-1）：chatView 注入既有 `reset_assistant` 上行。
   * 低频危险操作从身份条收进本抽屉，与「在 tab 打开」共用 awb-action 形态；确认弹窗
   * 与删除语义全在宿主侧，本面只转达点击，零新增协议。
   */
  onReset: () => void;
  /** 关闭抽屉回调（chatView 注入：直接置 drawer.hidden，展开态真源 = DOM 属性，零 JS 状态） */
  onClose: () => void;
}

/** 抽屉对外能力 */
export interface AssistantWorkbenchDrawer {
  /** 按快照整块重建抽屉内容（宿主每次投递一份完整快照） */
  render(snapshot: WorkbenchSnapshot): void;
}

/**
 * 抽屉内会话的三档分组（AWB-JOB-TIER-1）——纯函数，只读 status.kind
 *
 * 为什么分档：等用户拍板的活最需要人注意，排最前；在跑/待跑/读不到的居中；
 * 已收场的（完成/停手）排末位但直接显示——2026-11-20 用户真机拍板：折叠层是过度设计，
 * 卡片本身就是足够的分组，按钮横排 + 卡片包裹已能让多行紧凑可查。
 *
 * SSOT 边界：这里只按 `status.kind` 分档，**不改** `WorkbenchJobStatus`、
 * `projectSessionStatus`、`describeStatus`，也不碰独立面板。抽屉是宝自己的投影视图，
 * 自助模式的工作逻辑与独立面板逐字不变（上位原则「自助模式独立」）。
 */
export type AssistantJobTier = 'attention' | 'active' | 'settled';

export function assistantJobTier(status: WorkbenchJobStatus): AssistantJobTier {
  switch (status.kind) {
    case 'waiting':
      return 'attention';
    case 'running':
    case 'queued':
    case 'unsettled':
    case 'unreadable':
      return 'active';
    case 'completed':
    case 'stopped':
      return 'settled';
  }
}

/**
 * 创建抽屉渲染器
 *
 * @param deps 文档与点击出口
 * @returns 渲染器（`render`）
 */
export function createAssistantWorkbenchDrawer(
  deps: AssistantWorkbenchDrawerDeps,
): AssistantWorkbenchDrawer {
  const { document } = deps;

  const renderJob = (job: WorkbenchJob): HTMLLIElement => {
    const item = document.createElement('li');
    item.className = 'awb-job';

    const title = document.createElement('span');
    title.className = 'awb-job__title';
    title.textContent = job.title;
    item.appendChild(title);

    const described = describeStatus(job.status);
    if (described.badge) {
      const badge = document.createElement('span');
      badge.className = `awb-badge awb-badge--${described.badge.kind}`;
      badge.textContent = described.badge.label;
      item.appendChild(badge);
    }
    // 副行明细与徽记同源（describeStatus）：queued/unsettled/unreadable 无徽记时，
    // detail 是唯一状态语义；stopped 徽记外的停手者也在这一行。与独立面板同口径，不另写文案。
    if (described.detail) {
      const detail = document.createElement('span');
      detail.className = 'awb-job__detail';
      detail.textContent = described.detail;
      item.appendChild(detail);
    }

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'awb-job__open';
    open.textContent = l10n.t('Go to this session');
    open.setAttribute('aria-label', `${l10n.t('Go to this session')}: ${job.title}`);
    open.addEventListener('click', () => deps.openSession(job.sessionId));
    item.appendChild(open);
    return item;
  };

  return {
    render: (snapshot) => {
      const drawer = document.getElementById('assistantWorkbenchDrawer');
      if (!drawer) return;

      // UI-SEAT-AUDIT：抽屉里原「关闭」按钮冗余（身份条工作台按钮 = toggle 已能开关），
      // 改为「在独立 tab 打开」直达入口——原 hint 指向命令面板太隐蔽，按钮化后可见即达。
      // 开 tab 后顺手收抽屉（工作台按钮可再展开）。
      // ASSISTANT-UI-DECLUTTER-1：两钮共用语义中性的 awb-action 形态（css 单点）；
      // 区分靠 textContent / aria-label / data-awb 动作名，不靠两套视觉类。
      const openInTab = document.createElement('button');
      openInTab.type = 'button';
      openInTab.className = 'awb-action';
      openInTab.dataset.awbAction = 'open-tab';
      openInTab.textContent = l10n.t('Open in a tab');
      openInTab.setAttribute('aria-label', l10n.t('Open in a tab'));
      openInTab.addEventListener('click', () => {
        deps.openInTab();
        deps.onClose();
      });

      // ASSISTANT-UI-DECLUTTER-1：重置入口从身份条移来，低频危险操作不占常驻位；
      // 位于「在 tab 打开」左侧（DOM 序 = 视觉序）。危险确认留宿主侧，本面只转达。
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'awb-action';
      reset.dataset.awbAction = 'reset';
      reset.textContent = l10n.t('Reset');
      const resetLabel = l10n.t('Reset assistant session');
      reset.title = resetLabel;
      reset.setAttribute('aria-label', resetLabel);
      reset.addEventListener('click', () => deps.onReset());

      // 就地视图说明（两入口分工可见）：点身份条「工作台」看到的是助手页内嵌投影，
      // 常驻并排看板点上方按钮在独立 tab 打开。不再指向命令面板（UI-SEAT-AUDIT 收口）。
      const hint = document.createElement('div');
      hint.className = 'awb-hint';
      hint.textContent = l10n.t(
        'Inline view. To keep a workbench open side by side, open it in a tab.',
      );

      const seat = document.createElement('div');
      seat.className = 'awb-seat';
      const name = document.createElement('span');
      name.className = 'awb-seat__name';
      name.textContent = snapshot.orchestrator.name;
      seat.appendChild(name);
      const state = seatStateText(snapshot);
      if (state) {
        const stateEl = document.createElement('span');
        stateEl.className = 'awb-seat__state';
        stateEl.textContent = state;
        seat.appendChild(stateEl);
      }

      const list = document.createElement('ul');
      list.className = 'awb-jobs';
      // AWB-JOB-TIER-1：按 status.kind 分三档，**不改快照数据本身**，只调展示顺序。
      // 稳定排序（JS sort 保证）：同档内保持宿主下发顺序（宿主已按最近 turn 时间排序）。
      // 2026-11-20 用户拍板去折叠：已收场仍在末位，但直接显示在同一个 ul 里。
      const tierOrder: Record<AssistantJobTier, number> = {
        attention: 0,
        active: 1,
        settled: 2,
      };
      const ordered = [...snapshot.jobs].sort(
        (a, b) => tierOrder[assistantJobTier(a.status)] - tierOrder[assistantJobTier(b.status)],
      );
      for (const job of ordered) list.appendChild(renderJob(job));

      // 空态： coverage 非 complete 时如实说「读不到 / 没读全」，不说「还没有」（与独立面板同口径）
      if (snapshot.jobs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'awb-empty';
        empty.textContent =
          snapshot.coverage === 'unreadable'
            ? l10n.t('History could not be read')
            : snapshot.coverage === 'partial'
              ? l10n.t('Some history could not be read')
              : l10n.t('No work has been handed to the assistant yet');
        list.appendChild(empty);
      }

      // 头部行：说明文字 + 动作组（重置在左 / 在 tab 打开在右），flex 行尾避免绝对定位
      // 盖住长文案。「说明行为首节点」判据不变——head 是首节点，hint 是 head 首子节点。
      // 两按钮收进 awb-actions 容器：窄窗时整组换行，不与长 hint 互相挤压。
      const actions = document.createElement('div');
      actions.className = 'awb-actions';
      actions.appendChild(reset);
      actions.appendChild(openInTab);
      const head = document.createElement('div');
      head.className = 'awb-head';
      head.appendChild(hint);
      head.appendChild(actions);
      drawer.replaceChildren(head, seat, list);
    },
  };
}
