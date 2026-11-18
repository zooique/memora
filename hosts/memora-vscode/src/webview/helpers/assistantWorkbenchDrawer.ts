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
import type { WorkbenchJob, WorkbenchSnapshot } from '../../shared/workbenchDto.js';
import { describeStatus, seatStateText } from '../scripts/workbenchView.js';

/** 抽屉依赖（窄接口，便于测试替身） */
export interface AssistantWorkbenchDrawerDeps {
  /** 文档对象（构造唯一 DOM 入口，禁读全局 document） */
  document: Document;
  /** 「去这个会话」回调（chatView 注入既有 switch_session 出口） */
  openSession: (sessionId: string) => void;
}

/** 抽屉对外能力 */
export interface AssistantWorkbenchDrawer {
  /** 按快照整块重建抽屉内容（宿主每次投递一份完整快照） */
  render(snapshot: WorkbenchSnapshot): void;
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

      // 就地视图说明（两入口分工可见）：点身份条「工作台」看到的是助手页内嵌投影，
      // 常驻并排看板在命令面板。只指向命令面板、不硬编码命令标题——命令标题真源在
      // package.nls 的 command.openWorkbench.title，此处复述会产生第二份可漂移文案。
      const hint = document.createElement('div');
      hint.className = 'awb-hint';
      hint.textContent = l10n.t(
        'Inline view. To keep a workbench open side by side, use the Command Palette.',
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
      for (const job of snapshot.jobs) list.appendChild(renderJob(job));

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

      drawer.replaceChildren(hint, seat, list);
    },
  };
}
