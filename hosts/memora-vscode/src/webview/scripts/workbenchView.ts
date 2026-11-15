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
import type {
  WorkbenchJob,
  WorkbenchJobStatus,
  WorkbenchSnapshot,
  WorkbenchStopReason,
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
    const state =
      // 重启后按历史重建：必须先说清这不是实时画面，且当前没有实时驱动方
      snapshot.seatSource === 'history'
        ? l10n.t('Rebuilt from history after restart; no live agent is driving it right now')
        : orchestrator.managed
          ? ''
          : l10n.t('This session is no longer a managed agent session');
    seatState.textContent = state;
    seatState.hidden = !state;
  };

  /**
   * 渲染第二块：在管会话清单
   *
   * 空清单**不能一律说「还没有」**：历史读不到 / 有会话找不到 / 只读了最近若干轮
   * 都只说明「没读到」，不说明「没有」。三种情况用不同句子，绝不把读失败渲染成空。
   */
  const renderJobs = (snapshot: WorkbenchSnapshot): void => {
    const { jobs, coverage, missingCount, filteredCount, scan } = snapshot;
    /** 是否因超上限只读了一部分（界面必须说清，不能当完整） */
    const truncated = scan.totalRounds > scan.scannedRounds;
    jobsList.textContent = '';
    jobsEmpty.hidden = jobs.length > 0;
    if (jobs.length === 0) {
      // 空态句子按「我们知道多少」分档：读不到 ≠ 没有
      jobsEmpty.textContent =
        coverage === 'unreadable'
          ? l10n.t('History could not be read')
          : missingCount > 0
            ? l10n.t('{0} session(s) could not be found', missingCount)
            : truncated
              ? l10n.t(
                  'Older history was not read (only the latest {0} rounds)',
                  scan.scannedRounds,
                )
              : coverage === 'partial'
                ? l10n.t('Some history could not be read')
                : filteredCount > 0
                  ? // 记录存在、但当前不由代理驱动（多为用户已收回）：如实说过滤，不改口成「没有」
                    l10n.t(
                      '{0} record(s) exist, but no agent is driving them right now',
                      filteredCount,
                    )
                  : l10n.t('No work has been handed to the assistant yet');
    }
    // 有清单时的读不全说明（空态已在上面的句子里说清，不重复）
    const notices: string[] = [];
    if (jobs.length > 0 && coverage === 'unreadable') {
      notices.push(l10n.t('Some history could not be read'));
    }
    if (jobs.length > 0 && truncated) {
      notices.push(
        l10n.t('Older history was not read (only the latest {0} rounds)', scan.scannedRounds),
      );
    }
    if (jobs.length > 0 && missingCount > 0) {
      notices.push(l10n.t('{0} session(s) could not be found', missingCount));
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
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'wb-job__open';
  open.textContent = l10n.t('Go to this session');
  open.addEventListener('click', () => {
    deps.post({ type: 'workbench_open_session', sessionId: job.sessionId });
  });
  side.appendChild(open);
  item.append(main, side);
  return item;
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
function describeStatus(status: WorkbenchJobStatus): {
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
