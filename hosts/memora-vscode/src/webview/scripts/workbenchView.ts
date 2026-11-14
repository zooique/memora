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
    const state = orchestrator.managed
      ? ''
      : l10n.t('This session is no longer a managed agent session');
    seatState.textContent = state;
    seatState.hidden = !state;
  };

  /**
   * 渲染第二块：在管会话清单
   *
   * 空清单只显示空态句，**不摆空表格、不显示 0 或破折号**。
   */
  const renderJobs = (jobs: readonly WorkbenchJob[]): void => {
    jobsList.textContent = '';
    jobsEmpty.hidden = jobs.length > 0;
    for (const job of jobs) jobsList.appendChild(renderJob(document, deps, job));
  };

  return {
    ready: () => deps.post({ type: 'ready' }),
    render: (snapshot) => {
      renderSeat(snapshot);
      renderJobs(snapshot.jobs);
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
  const badge = document.createElement('span');
  badge.className = 'wb-badge';
  badge.dataset.kind = job.status.kind;
  badge.textContent = described.label;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'wb-job__open';
  open.textContent = l10n.t('Go to this session');
  open.addEventListener('click', () => {
    deps.post({ type: 'workbench_open_session', sessionId: job.sessionId });
  });
  side.append(badge, open);
  item.append(main, side);
  return item;
}

/**
 * 状态 → 界面文案（唯一映射点）
 *
 * 只把宿主给的事实翻成当前语言：`stopped` 的原因逐档如实显示；
 * `unsettled` / `unreadable` 明确说「没有记录 / 读不到」，不冒充被中止、也不冒充完成。
 *
 * @param status 宿主投影的状态
 * @returns 徽记文案与（可选的）明细行
 */
function describeStatus(status: WorkbenchJobStatus): { label: string; detail?: string } {
  switch (status.kind) {
    case 'running':
      return { label: l10n.t('Running') };
    case 'waiting':
      return { label: l10n.t('Waiting for you') };
    case 'completed':
      return { label: l10n.t('Completed') };
    case 'queued':
      return { label: l10n.t('Handed over, not started yet') };
    case 'unsettled':
      return {
        label: l10n.t('Did not finish last time'),
        detail: l10n.t('No stop reason was recorded'),
      };
    case 'unreadable':
      return {
        label: l10n.t('Status unavailable'),
        detail: l10n.t('The latest turn could not be read'),
      };
    case 'stopped':
      return { label: l10n.t('Stopped'), detail: describeStop(status.stop) };
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
