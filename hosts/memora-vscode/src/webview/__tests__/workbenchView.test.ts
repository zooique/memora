/**
 * 工作台视图渲染测试（`scripts/workbenchView`）
 *
 * 钉住第五切片最要紧的界面判据——**「读不到」不许渲染成「没有」**：
 *   - 历史读不到（coverage=unreadable）时空态必须是「历史读不到」，绝不能是「还没有交给助手的活」；
 *   - 有会话找不到 / 只读了最近若干轮 / 部分历史读不到，各自说清，不拿一句空态盖过去；
 *   - 只有 coverage=complete 且清单为空，才允许说「还没有交给助手的活」。
 *
 * 另外钉住状态显示纪律：主标签只有四档（在跑 / 等你 / 完成 / 被中止），
 * `queued` / `unsettled` / `unreadable` 这类边缘事实**不出徽记**、只进副行；
 * 界面上不出现任何内部码（如 `interrupted` / `unavailable`），必须是英文源文案。
 *
 * 测试形态：jsdom（`@vscode/l10n` 未加载 bundle 时 `t()` 直出英文源文案，正好用于断言）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionMeta } from '@zooique/memora';
import { createWorkbenchView, type WorkbenchView } from '../scripts/workbenchView.js';
import { buildWorkbenchSnapshot } from '../helpers/workbenchModel.js';
import type {
  WorkbenchJob,
  WorkbenchJobStatus,
  WorkbenchSnapshot,
} from '../../shared/workbenchDto.js';

/** 与 `workbenchHtml` 同形的最小骨架（只铺本视图读取的节点） */
const SKELETON_HTML = `
  <div id="seatName"></div>
  <div id="seatTitle"></div>
  <div id="seatRole" hidden></div>
  <div id="seatState" hidden></div>
  <div id="jobsEmpty" hidden></div>
  <div id="jobsNotice" hidden></div>
  <ul id="jobsList"></ul>`;

/**
 * 构造一份快照（只写断言关心的字段，其余给稳定默认值）
 *
 * @param overrides 覆盖项
 * @returns 可直接渲染的快照
 */
function snapshot(overrides: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot {
  return {
    orchestrator: {
      name: 'Memora',
      sessionId: 'session-agent',
      title: '代理会话',
      managed: true,
    },
    jobs: [],
    seatSource: 'live',
    filteredCount: 0,
    coverage: 'complete',
    missingCount: 0,
    scan: { maxRounds: 60, totalRounds: 0, scannedRounds: 0 },
    ...overrides,
  };
}

/**
 * 构造一条会话条目
 *
 * @param sessionId 会话标识
 * @param status 状态投影
 * @returns 清单条目
 */
function job(sessionId: string, status: WorkbenchJobStatus): WorkbenchJob {
  return { sessionId, title: `标题-${sessionId}`, status, updatedAt: '2026-11-14T00:00:00.000Z' };
}

/**
 * 挂载骨架并创建视图
 *
 * @returns 视图、上行消息间谍与常用节点
 */
function mount(): {
  view: WorkbenchView;
  post: ReturnType<typeof vi.fn>;
  seatState: HTMLElement;
  jobsEmpty: HTMLElement;
  jobsNotice: HTMLElement;
  jobsList: HTMLElement;
} {
  document.body.innerHTML = SKELETON_HTML;
  const post = vi.fn();
  const view = createWorkbenchView({ document, post });
  return {
    view,
    post,
    seatState: document.getElementById('seatState') as HTMLElement,
    jobsEmpty: document.getElementById('jobsEmpty') as HTMLElement,
    jobsNotice: document.getElementById('jobsNotice') as HTMLElement,
    jobsList: document.getElementById('jobsList') as HTMLElement,
  };
}

describe('workbenchView — 空态：读不到 ≠ 没有', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('历史读不到：说「历史读不到」，绝不冒充「还没有交给助手的活」', () => {
    const { view, jobsEmpty } = mount();
    view.render(snapshot({ coverage: 'unreadable' }));
    expect(jobsEmpty.hidden).toBe(false);
    expect(jobsEmpty.textContent).toBe('History could not be read');
    expect(jobsEmpty.textContent).not.toBe('No work has been handed to the assistant yet');
  });

  it('有会话找不到：如实说「有 N 条找不到了」', () => {
    const { view, jobsEmpty } = mount();
    view.render(snapshot({ coverage: 'partial', missingCount: 2 }));
    expect(jobsEmpty.textContent).toBe('2 session(s) could not be found');
  });

  it('只读了最近若干轮：说清读不全并带上实际轮数', () => {
    const { view, jobsEmpty } = mount();
    view.render(
      snapshot({
        coverage: 'partial',
        scan: { maxRounds: 60, totalRounds: 120, scannedRounds: 60 },
      }),
    );
    expect(jobsEmpty.textContent).toBe('Older history was not read (only the latest 60 rounds)');
  });

  it('部分历史读不到：说「部分历史读不到」', () => {
    const { view, jobsEmpty } = mount();
    view.render(snapshot({ coverage: 'partial' }));
    expect(jobsEmpty.textContent).toBe('Some history could not be read');
  });

  it('真的一条都没有：才说「还没有交给助手的活」', () => {
    const { view, jobsEmpty } = mount();
    view.render(snapshot({ coverage: 'complete' }));
    expect(jobsEmpty.hidden).toBe(false);
    expect(jobsEmpty.textContent).toBe('No work has been handed to the assistant yet');
  });

  it('有记录但被驱动权过滤：如实说过滤，不改口成「还没有」', () => {
    const { view, jobsEmpty } = mount();
    view.render(snapshot({ coverage: 'complete', filteredCount: 2 }));
    expect(jobsEmpty.hidden).toBe(false);
    expect(jobsEmpty.textContent).toBe('2 record(s) exist, but no agent is driving them right now');
    expect(jobsEmpty.textContent).not.toBe('No work has been handed to the assistant yet');
  });

  it('端到端（模型 → 视图）：历史完整、记录都在，只是不由代理驱动 → 说「有 N 条记录」', () => {
    // 上一批交付与真机复核对「这档是否存在」说法互相矛盾：这里不手搓快照，
    // 而是走真实投影 `buildWorkbenchSnapshot`，钉住「分支顺序 + 文案」由模型事实驱动。
    const orchestratorId = 'session-agent';
    const metas = new Map<string, SessionMeta>([
      [
        orchestratorId,
        {
          sessionId: orchestratorId,
          displayName: '代理会话',
          updatedAt: '2026-11-15T00:00:00.000Z',
          messageCount: 1,
        },
      ],
      [
        'session-a',
        {
          sessionId: 'session-a',
          displayName: '会话 A',
          updatedAt: '2026-11-15T00:00:00.000Z',
          messageCount: 1,
        },
      ],
      [
        'session-b',
        {
          sessionId: 'session-b',
          displayName: '会话 B',
          updatedAt: '2026-11-15T00:00:00.000Z',
          messageCount: 1,
        },
      ],
    ]);
    const snap = buildWorkbenchSnapshot({
      orchestratorId,
      seatSource: 'live',
      agentName: 'Memora',
      readMeta: (sid) => metas.get(sid),
      readRolePackName: () => undefined,
      readRolePackDisplayName: () => undefined,
      isManaged: () => true,
      // 历史读得到、记录也存在，但用户已全部收回驱动权
      isAgentDriven: () => false,
      childrenOf: () => ['session-a', 'session-b'],
      history: {
        children: [],
        dispatches: [],
        coverage: 'complete',
        totalRounds: 2,
        scannedRounds: 2,
        unreadableRecords: 0,
        dispatchScan: { sessions: 0, truncated: 0 },
      },
      peekActivity: () => ({ running: false, waiting: false }),
      readRoundIds: () => [],
      readRoundStatus: () => undefined,
      readRound: () => undefined,
      titleOf: (sid) => `标题-${sid}`,
    });
    // 前提确实是「读得到 + 完整 + 被过滤」，不是靠空历史蒙对
    expect(snap.coverage).toBe('complete');
    expect(snap.missingCount).toBe(0);
    expect(snap.filteredCount).toBe(2);
    expect(snap.jobs).toHaveLength(0);

    const { view, jobsEmpty } = mount();
    view.render(snap);
    expect(jobsEmpty.hidden).toBe(false);
    expect(jobsEmpty.textContent).toBe('2 record(s) exist, but no agent is driving them right now');
    expect(jobsEmpty.textContent).not.toBe('No work has been handed to the assistant yet');
  });

  it('重启后按历史重建：座位上明说「无实时驱动方」，不冒充实时画面', () => {
    const { view, seatState } = mount();
    view.render(
      snapshot({
        seatSource: 'history',
        // 按历史重建 = 本进程没登记过它 ⇒ 前端身份也不可能是托管（两处事实同源）
        orchestrator: {
          name: 'Memora',
          sessionId: 'session-agent',
          title: '代理会话',
          managed: false,
        },
      }),
    );
    expect(seatState.hidden).toBe(false);
    expect(seatState.textContent).toBe(
      'Rebuilt from history after restart; no live agent is driving it right now',
    );
  });

  it('重启恢复的座位：说「恢复了座位」，且不因 managed 为真而隐藏（可见标记）', () => {
    const { view, seatState } = mount();
    view.render(
      snapshot({
        seatSource: 'restored',
        orchestrator: {
          name: 'Memora',
          sessionId: 'session-agent',
          title: '代理会话',
          // 恢复的座位**有**调度权（managed 为真）：这行仍要显示，否则恢复不可见
          managed: true,
        },
      }),
    );
    expect(seatState.hidden).toBe(false);
    expect(seatState.textContent).toBe(
      'Seat restored after restart; it starts working when you send your first message',
    );
    // 不能把「恢复」说成另外两档事实
    expect(seatState.textContent).not.toContain('Taken back from the assistant');
    expect(seatState.textContent).not.toContain('Rebuilt from history after restart');
  });

  it('座位被收回（没重启）：说「已从助手收回」，不说「重启后按历史重建」', () => {
    const { view, seatState } = mount();
    view.render(
      snapshot({
        seatSource: 'revoked',
        orchestrator: {
          name: 'Memora',
          sessionId: 'session-agent',
          title: '代理会话',
          managed: false,
        },
      }),
    );
    expect(seatState.hidden).toBe(false);
    expect(seatState.textContent).toBe(
      'Taken back from the assistant; no live agent is driving it right now',
    );
    // 真机缺陷靶标：收回被错说成「重启后重建」
    expect(seatState.textContent).not.toContain('Rebuilt from history after restart');
  });

  it('收回后又点「助手」重新接管：实时事实优先，状态行立刻消失（来源快照不再当屏）', () => {
    const { view, seatState } = mount();
    view.render(
      snapshot({
        // 面板绑定的是打开时的来源；这一刻真实状态已是托管
        seatSource: 'revoked',
        orchestrator: {
          name: 'Memora',
          sessionId: 'session-agent',
          title: '代理会话',
          managed: true,
        },
      }),
    );
    expect(seatState.textContent).toBe('');
    expect(seatState.hidden).toBe(true);
  });

  it('清单非空 + 有被过滤记录：不出空态的「有 N 条记录但无人驱动」（空态解释句不越界当状态播报）', () => {
    const { view, jobsEmpty, jobsNotice, jobsList } = mount();
    view.render(
      snapshot({
        jobs: [job('session-a', { kind: 'completed' })],
        filteredCount: 3,
      }),
    );
    expect(jobsList.children).toHaveLength(1);
    // 空态整体隐藏：那条句子只属于空态
    expect(jobsEmpty.hidden).toBe(true);
    // 也没有被改道到通知行（真机就是「清单里挂着已完成记录，就不该出现这句」）
    expect(jobsEmpty.textContent ?? '').not.toContain('record(s) exist');
    expect(jobsNotice.textContent ?? '').not.toContain('record(s) exist');
  });

  it('清单非空时隐藏空态，并把读不全的事实放进 notice 行', () => {
    const { view, jobsEmpty, jobsNotice, jobsList } = mount();
    view.render(
      snapshot({
        jobs: [job('session-a', { kind: 'completed' })],
        coverage: 'partial',
        missingCount: 1,
        scan: { maxRounds: 60, totalRounds: 90, scannedRounds: 60 },
      }),
    );
    expect(jobsEmpty.hidden).toBe(true);
    expect(jobsList.children).toHaveLength(1);
    expect(jobsNotice.hidden).toBe(false);
    expect(jobsNotice.textContent).toContain('1 session(s) could not be found');
    expect(jobsNotice.textContent).toContain(
      'Older history was not read (only the latest 60 rounds)',
    );
  });
});

describe('workbenchView — 状态显示纪律', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('四档主标签都有徽记，且 data-kind 只来自这四档', () => {
    const { view, jobsList } = mount();
    view.render(
      snapshot({
        jobs: [
          job('s-running', { kind: 'running' }),
          job('s-waiting', { kind: 'waiting' }),
          job('s-completed', { kind: 'completed' }),
          job('s-stopped', { kind: 'stopped', stop: { kind: 'user' } }),
        ],
      }),
    );
    const badges = jobsList.querySelectorAll('.wb-badge');
    expect(Array.from(badges).map((badge) => (badge as HTMLElement).dataset.kind)).toEqual([
      'running',
      'waiting',
      'completed',
      'stopped',
    ]);
    expect(Array.from(badges).map((badge) => badge.textContent)).toEqual([
      'Running',
      'Waiting for you',
      'Completed',
      'Stopped',
    ]);
  });

  it('边缘事实（没开始 / 没正常结束 / 读不到）不出徽记，只写副行', () => {
    const { view, jobsList } = mount();
    view.render(
      snapshot({
        jobs: [
          job('s-queued', { kind: 'queued' }),
          job('s-unsettled', { kind: 'unsettled' }),
          job('s-unreadable', { kind: 'unreadable' }),
        ],
      }),
    );
    // 没有徽记：边缘事实不与主标签并列抢读
    expect(jobsList.querySelectorAll('.wb-badge')).toHaveLength(0);
    const details = Array.from(jobsList.querySelectorAll('.wb-job__detail')).map(
      (detail) => detail.textContent,
    );
    expect(details).toEqual([
      'Handed over, not started yet',
      'Did not finish last time · No stop reason was recorded',
      'Status unavailable · The latest turn could not be read',
    ]);
  });

  it('被中止的原因逐档明说，且不出现内部码', () => {
    const { view, jobsList } = mount();
    view.render(
      snapshot({
        jobs: [
          job('s-user', { kind: 'stopped', stop: { kind: 'user' } }),
          job('s-timeout', { kind: 'stopped', stop: { kind: 'timeout' } }),
          job('s-error', { kind: 'stopped', stop: { kind: 'error', message: 'upstream 502' } }),
          job('s-unknown-reason', { kind: 'stopped', stop: { kind: 'unavailable' } }),
        ],
      }),
    );
    const details = Array.from(jobsList.querySelectorAll('.wb-job__detail')).map(
      (detail) => detail.textContent,
    );
    expect(details).toEqual([
      'Stopped by you',
      'Request timed out',
      'Ended by an error: upstream 502',
      'Reason unavailable',
    ]);
    // 内部码一个都不许**直接**出现在界面上：主标签 / 副行必须是人话，
    // 不得把枚举值（queued / unsettled / stopped …）原样打印出来。
    // （英文译文里出现 "unavailable" 属正常措辞，故按「整段文本是否等于枚举值」判，不做子串匹配。）
    const rendered = Array.from(jobsList.querySelectorAll('.wb-badge, .wb-job__detail')).map(
      (node) => (node.textContent ?? '').trim(),
    );
    const enumValues = [
      'running',
      'waiting',
      'completed',
      'stopped',
      'unsettled',
      'queued',
      'unreadable',
      'user',
      'timeout',
      'error',
      'unavailable',
    ];
    for (const text of rendered) {
      expect(enumValues).not.toContain(text);
    }
  });
});

describe('workbenchView — 只读与上行契约', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ready 只发一次握手；「去这个会话」只上报会话 id', () => {
    const { view, post, jobsList } = mount();
    view.ready();
    expect(post).toHaveBeenCalledWith({ type: 'ready' });
    view.render(snapshot({ jobs: [job('session-child', { kind: 'completed' })] }));
    const button = jobsList.querySelector('button');
    expect(button?.textContent).toBe('Go to this session');
    button?.click();
    expect(post).toHaveBeenCalledWith({
      type: 'workbench_open_session',
      sessionId: 'session-child',
    });
  });
});
