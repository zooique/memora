/**
 * 工作台 webview 视图（浏览器侧，纯渲染）
 *
 * 契约：宿主每次投递的都是**一整个快照**（`workbench_snapshot`），本视图一律
 * 整块重建——不做增量、不在 webview 里屯状态。这正是「不保活」的前提：隐藏后
 * webview 上下文整个销毁，重开时只靠新快照恢复现场，没有任何本地状态可依赖。
 *
 * 只读：唯一的上行动作是 `workbench_open_session`（切到聊天面板对应会话）；
 * 本视图**没有输入框、不发送任何消息**。
 */
import * as l10n from '@vscode/l10n';
import type { WebviewToExtensionMessage } from '../../shared/protocol.js';
import {
  WORKBENCH_DISPATCH_LOOKBACK_ROUNDS,
  type ListCoverageReason,
  type WorkbenchJob,
  type WorkbenchJobStatus,
  type WorkbenchSnapshot,
  type WorkbenchStopReason,
} from '../../shared/workbenchDto.js';

/** 视图依赖面（`document` 注入便于测试；`post` 由入口绑定到 acquire 的 api） */
export interface WorkbenchViewDeps {
  /** 当前文档（生产 = webview 的 document） */
  document: Document;
  /** 上行消息出口 */
  post: (message: WebviewToExtensionMessage) => void;
}

/** 视图对外能力 */
export interface WorkbenchView {
  /** 告知宿主「脚本已就绪，可以全量回放」（每次 webview 重建都要发一次） */
  ready(): void;
  /** 按快照整块重建界面 */
  render(snapshot: WorkbenchSnapshot): void;
}

/**
 * 创建视图
 *
 * @param deps 文档与上行出口
 * @returns 视图实例（`ready` / `render`）
 */
export function createWorkbenchView(deps: WorkbenchViewDeps): WorkbenchView {
  const { document } = deps;
  // 骨架元素必须齐全：缺一个就是 HTML 与脚本不同源（构建期 bug），直接抛给错误边界留痕
  const seatName = requireElement(document, 'seatName');
  const seatTitle = requireElement(document, 'seatTitle');
  const seatRole = requireElement(document, 'seatRole');
  const seatState = requireElement(document, 'seatState');
  const jobsEmpty = requireElement(document, 'jobsEmpty');
  const jobsNotice = requireElement(document, 'jobsNotice');
  const jobsList = requireElement(document, 'jobsList');

  /**
   * 渲染第一块：代理座位
   *
   * 角色名只在「有快照」时出现；撤销托管后如实提示「这条会话不再按托管运行」，
   * 不把旧身份留在屏上假装还在替你安排。
   */
  const renderSeat = (snapshot: WorkbenchSnapshot): void => {
    const { orchestrator } = snapshot;
    seatName.textContent = orchestrator.name;
    seatTitle.textContent = orchestrator.title;
    const role = orchestrator.rolePackName
      ? l10n.t('Role pack: {0}', orchestrator.rolePackDisplayName ?? orchestrator.rolePackName)
      : '';
    seatRole.textContent = role;
    seatRole.hidden = !role;
    const state = seatStateText(snapshot);
    seatState.textContent = state;
    seatState.hidden = !state;
  };

  /**
   * 渲染第二块：在管会话清单
   *
   * 空清单**不能一律说「还没有」**：历史读不到 / 有会话找不到 / 只读了最近若干轮
   * 都只说明「没读到」，不说明「没有」。三种情况用不同句子，绝不把读失败渲染成空。
   *
   * ⚠️ 「有 N 条记录但当前没有代理在驱动」只属于**空态**（下面 `jobs.length === 0` 内），
   * 不是一条全局状态横幅：清单非空时记录已经逐行摊在眼前，读者能自己看见它们的状态，
   * 再补一句「有 N 条但没人驱动」是把空态解释词误当状态播报。
   * 真机曾把「清单里挂着一条已完成记录时不出现这句」当成缺陷上报——这是**正常表达**，
   * 不是覆盖缺失；已完成的记录本身就在清单里，空态解释句没有存在的余地。
   */
  const renderJobs = (snapshot: WorkbenchSnapshot): void => {
    const { jobs, coverage, filteredCount, scan } = snapshot;
    // 判据已在 shared/sessionStatus 产出（结论 + 理由）；这里只做措辞，不重新推断
    const reasons = snapshot.coverageReasons;
    /** 按 kind 取理由（同一 kind 至多一条） */
    const reasonOf = <K extends ListCoverageReason['kind']>(kind: K) =>
      reasons.find(
        (reason): reason is Extract<ListCoverageReason, { kind: K }> => reason.kind === kind,
      );
    jobsList.textContent = '';
    jobsEmpty.hidden = jobs.length > 0;
    if (jobs.length === 0) {
      // 空态句子按「我们知道多少」分档：读不到 ≠ 没有
      const missing = reasonOf('missing-sessions');
      /** 主句（覆盖状态 / 过滤事实按优先级分档） */
      const base =
        coverage === 'unreadable'
          ? l10n.t('History could not be read')
          : missing
            ? l10n.t('{0} session(s) could not be found', missing.count)
            : reasonOf('history-window')
              ? l10n.t(
                  'Older history was not read (only the latest {0} rounds)',
                  scan.scannedRounds,
                )
              : reasonOf('dispatch-window')
                ? // 反查窗口截断：可能真的「派过但没读到」，不许落到「还没有交给助手的活」
                  l10n.t('Older dispatches were not read in some sessions')
                : coverage === 'partial'
                  ? l10n.t('Some history could not be read')
                  : filteredCount > 0
                    ? // 记录存在、但当前不由代理驱动（多为用户接管中）：如实说过滤，不改口成「没有」
                      l10n.t(
                        '{0} record(s) exist, but no agent is driving them right now',
                        filteredCount,
                      )
                    : l10n.t('No work has been handed to the assistant yet');
      // 另有别人派出的活：**只报数量、不列条目**（工作台锚点是当前座位，列出来会让
      // 「这是谁的活」变糊）；不补这句，「不在我的清单里」就会被读成「那条活消失了」。
      // 历史完全读不到时不补：那一刻连「本机有几条」都不可信。
      const foreign = snapshot.foreignDispatches;
      jobsEmpty.textContent =
        foreign > 0 && coverage !== 'unreadable'
          ? `${base} · ${l10n.t('{0} more were dispatched by other assistant sessions', foreign)}`
          : base;
    }
    // 有清单时的读不全说明（空态已在上面的句子里说清，不重复）
    const notices: string[] = [];
    if (jobs.length > 0 && coverage === 'unreadable') {
      notices.push(l10n.t('Some history could not be read'));
    }
    if (jobs.length > 0) {
      // 同一条「历史没读全」说明里交代两个窗口：创建者自己的轮窗口、目标会话的反查窗口
      const parts: string[] = [];
      if (reasonOf('history-window')) {
        parts.push(
          l10n.t('Older history was not read (only the latest {0} rounds)', scan.scannedRounds),
        );
      }
      const dispatch = reasonOf('dispatch-window');
      if (dispatch) {
        parts.push(
          l10n.t(
            'Older dispatches were not read in {0} session(s) (only the latest {1} rounds each)',
            dispatch.count,
            WORKBENCH_DISPATCH_LOOKBACK_ROUNDS,
          ),
        );
      }
      if (parts.length > 0) notices.push(parts.join(' '));
    }
    const missing = reasonOf('missing-sessions');
    if (jobs.length > 0 && missing) {
      notices.push(l10n.t('{0} session(s) could not be found', missing.count));
    }
    jobsNotice.textContent = notices.join(' · ');
    jobsNotice.hidden = notices.length === 0;
    for (const job of jobs) jobsList.appendChild(renderJob(document, deps, job));
  };

  return {
    ready: () => deps.post({ type: 'ready' }),
    render: (snapshot) => {
      renderSeat(snapshot);
      renderJobs(snapshot);
    },
  };
}

/**
 * 座位状态行（按**事件来源**分档，不拿一句话套所有场景）
 *
 * 三档来源 + 非托管兜底各说各的：
 *   ① 仍按托管装配且不是恢复来的（实时事实）→ 不解释（空串）；
 *   ② 重启后从持久化状态恢复了座位（有调度权、还没开始跑）→ 恢复说明；
 *   ③ 本进程从没见过这条会话（典型 = 重开窗口）→ 重启后按历史重建；
 *   ④ 其余（不再按托管装配）→ 如实说明它已不是助手会话。
 *
 * 为什么 `managed` 排在最前：面板绑定的是**打开时**的来源快照，实时身份更权威；
 * 仍按助手装配时不解释，非托管时按最后一档说话。
 *
 * `restored`（形态 + 座位成对恢复）有调度权、没有驱动方。这句话只说「它是恢复来的、
 * 还没开始跑」，不给用户任何需要维护的入口——座位是内部判据，用户只认「我在跟助手说话」。
 *
 * @param snapshot 宿主投递的全量快照
 * @returns 要显示的句子（空串 = 隐藏该行）
 */
export function seatStateText(snapshot: WorkbenchSnapshot): string {
  // 恢复的座位虽然也是 managed，但它恰好需要被看见一次 ⇒ 显式例外，不随 managed 隐藏
  if (snapshot.orchestrator.managed && snapshot.seatSource !== 'restored') return '';
  if (snapshot.seatSource === 'restored') {
    return l10n.t(
      'Seat restored after restart; it starts working when you send your first message',
    );
  }
  if (snapshot.seatSource === 'history') {
    return l10n.t('Rebuilt from history after restart; no live agent is driving it right now');
  }
  return l10n.t('This session is no longer a managed agent session');
}

/**
 * 渲染一条会话
 *
 * @param document 当前文档
 * @param deps 视图依赖（按钮点击上行）
 * @param job 快照条目
 * @returns 列表项
 */
function renderJob(document: Document, deps: WorkbenchViewDeps, job: WorkbenchJob): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'wb-job';

  const main = document.createElement('div');
  main.className = 'wb-job__main';
  const title = document.createElement('div');
  title.className = 'wb-job__title';
  title.textContent = job.title;
  main.appendChild(title);

  // 来源分档：助手新建 / 派发接管。缺省不标——分不出来源时不许猜成某一种
  const viaLabel =
    job.via === 'create'
      ? l10n.t('Created by assistant')
      : job.via === 'delegate'
        ? l10n.t('Dispatched here')
        : '';
  if (viaLabel) {
    const via = document.createElement('div');
    via.className = 'wb-job__via';
    via.textContent = viaLabel;
    main.appendChild(via);
  }

  const described = describeStatus(job.status);
  if (described.detail) {
    const detail = document.createElement('div');
    detail.className = 'wb-job__detail';
    detail.textContent = described.detail;
    main.appendChild(detail);
  }

  const side = document.createElement('div');
  side.className = 'wb-job__side';
  // 主标签只允许四档（在跑 / 等你 / 完成 / 被中止）；边缘事实只进副行，不抢主标签
  if (described.badge) {
    const badge = document.createElement('span');
    badge.className = 'wb-badge';
    badge.dataset.kind = described.badge.kind;
    badge.textContent = described.badge.label;
    side.appendChild(badge);
  }
  // 末轮运行情况：就地展开（无 latest = 如实说读不到，不摆空白框）
  const detail = document.createElement('div');
  detail.className = 'wb-job__progress';
  detail.hidden = true;
  detail.appendChild(renderProgress(document, job));

  // 「查看运行情况」：纯本地展开（不上行消息、不改会话状态）——工作台是可丢弃的只读
  // 投影，3 秒快照重建后展开态自然收起，避免展示一份过期的末轮摘要。
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'wb-job__toggle';
  toggle.textContent = l10n.t('View progress');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    toggle.textContent = expanded ? l10n.t('View progress') : l10n.t('Hide progress');
    detail.hidden = expanded;
  });
  side.appendChild(toggle);

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'wb-job__open';
  open.textContent = l10n.t('Go to this session');
  open.addEventListener('click', () => {
    deps.post({ type: 'workbench_open_session', sessionId: job.sessionId });
  });
  side.appendChild(open);

  item.append(main, side, detail);
  return item;
}

/**
 * 末轮运行情况块（只读摘要；文案按事实分档，不把「运行中」说成已完成）
 */
function renderProgress(document: Document, job: WorkbenchJob): DocumentFragment {
  const frag = document.createDocumentFragment();
  const latest = job.latest;
  if (!latest) {
    const none = document.createElement('div');
    none.className = 'wb-progress__none';
    none.textContent =
      job.status.kind === 'queued'
        ? l10n.t('No round has started yet')
        : l10n.t('The latest round could not be read');
    frag.appendChild(none);
    return frag;
  }
  const heading = document.createElement('div');
  heading.className = 'wb-progress__heading';
  heading.textContent = l10n.t(
    'Round {0} of {1} · {2}',
    latest.index,
    latest.totalRounds,
    latest.status,
  );
  frag.appendChild(heading);

  const request = document.createElement('div');
  request.className = 'wb-progress__request';
  request.textContent = latest.request;
  frag.appendChild(request);

  // 回答片段只在 complete 且有内容时显示——运行中/中断轮不给「回答」，那是伪造
  if (latest.response) {
    const response = document.createElement('div');
    response.className = 'wb-progress__response';
    response.textContent = latest.response;
    frag.appendChild(response);
  }
  const note = document.createElement('div');
  note.className = 'wb-progress__note';
  note.textContent = l10n.t('For live step-by-step output, open the session');
  frag.appendChild(note);
  return frag;
}

/**
 * 状态 → 界面呈现（唯一映射点）
 *
 * **主标签只四档**：在跑 / 等你 / 完成 / 被中止。`queued`（没开始）、`unsettled`
 * （没正常结束）、`unreadable`（读不到）这些边缘事实**不给徽记**，只写副行——
 * 它们不是四档之一，硬并列会让人误读成第五种主状态。
 *
 * @param status 宿主投影的状态
 * @returns 主标签（可选）与副行明细（可选）
 */
export function describeStatus(status: WorkbenchJobStatus): {
  badge?: { kind: 'running' | 'waiting' | 'completed' | 'stopped'; label: string };
  detail?: string;
} {
  switch (status.kind) {
    case 'running':
      return { badge: { kind: 'running', label: l10n.t('Running') } };
    case 'waiting':
      return { badge: { kind: 'waiting', label: l10n.t('Waiting for you') } };
    case 'completed':
      return { badge: { kind: 'completed', label: l10n.t('Completed') } };
    case 'stopped':
      return {
        badge: { kind: 'stopped', label: l10n.t('Stopped') },
        detail: describeStop(status.stop),
      };
    case 'queued':
      return { detail: l10n.t('Handed over, not started yet') };
    case 'unsettled':
      return {
        detail: `${l10n.t('Did not finish last time')} · ${l10n.t('No stop reason was recorded')}`,
      };
    case 'unreadable':
      return {
        detail: `${l10n.t('Status unavailable')} · ${l10n.t('The latest turn could not be read')}`,
      };
  }
}

/**
 * 被中止原因 → 界面文案
 *
 * @param stop 宿主投影的停手者分档
 * @returns 明细行
 */
function describeStop(stop: WorkbenchStopReason): string {
  switch (stop.kind) {
    case 'user':
      return l10n.t('Stopped by you');
    case 'timeout':
      return l10n.t('Request timed out');
    case 'error':
      // 原始错误文本由宿主透传，界面只套词形（不吞细节）
      return stop.message
        ? l10n.t('Ended by an error: {0}', stop.message)
        : l10n.t('Ended by an error');
    case 'unavailable':
      return l10n.t('Reason unavailable');
  }
}

/**
 * 取必须存在的骨架元素
 *
 * @param document 当前文档
 * @param id 元素 id
 * @returns 元素
 */
function requireElement(document: Document, id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`workbench skeleton missing element: #${id}`);
  return element;
}
