/**
 * 历史菜单「会话活跃度标识」渲染测试（E4 批 4）
 *
 * 钉住四条不变式：
 *   ① `setActivity` 后条目出现「待处理 / 运行中」标签（按 id 查表，不自行判运行态）；
 *   ② 两标签互斥且**待处理优先**（既在跑又在等用户答 ⇒ 只说「待处理」）；
 *   ③ 状态清空（`setActivity([], [])`）后标签消失——标识不得残留成僵尸；
 *   ④ 入口角标与条目标签**同一数据源**：0 ⇒ 隐藏，1 ⇒ 显示「1」。
 *
 * 变异靶标：把 `pendingSessionIds` 判断删掉 ⇒ 用例① 转红；把 append 的重渲染去掉
 * （`setActivity` 不调 `renderHistoryView`）⇒ 用例① 转红；角标 `hidden` 写反 ⇒ 用例④ 转红。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createHistoryMenuView, type SessionSummaryDto } from '../scripts/historyMenuView.js';

/** 造菜单依赖的 6 个节点（与 chatPanel 模板同名；不复用整页模板，避免测试被无关 DOM 拖累） */
function mount() {
  document.body.innerHTML = `
    <div id="historyMenu"></div>
    <button id="historyTabRecent"></button>
    <button id="historyTabArchived"></button>
    <span id="historyArchivedCount"></span>
    <input id="historySearch" />
    <span id="historyPendingBadge" hidden></span>
  `;
  const view = createHistoryMenuView({
    document,
    menuEl: document.getElementById('historyMenu') as HTMLElement,
    tabRecent: document.getElementById('historyTabRecent') as HTMLButtonElement,
    tabArchived: document.getElementById('historyTabArchived') as HTMLButtonElement,
    archivedCountEl: document.getElementById('historyArchivedCount') as HTMLElement,
    searchInput: document.getElementById('historySearch') as HTMLInputElement,
    entryBadge: document.getElementById('historyPendingBadge') as HTMLElement,
    postMessage: () => undefined,
  });
  const badge = document.getElementById('historyPendingBadge') as HTMLElement;
  return { view, badge };
}

/** 两条会话（id 与真实格式一致：日期前缀 + 名称） */
const SESSIONS: SessionSummaryDto[] = [
  { sessionId: '2026-11-06-a', title: '会话 A', updatedAt: '2026-11-06T10:00:00.000Z' },
  { sessionId: '2026-11-06-b', title: '会话 B', updatedAt: '2026-11-06T09:00:00.000Z' },
];

/** 取某会话条目的活跃度标签文本（无标签返回空串） */
function stateLabel(sessionId: string): string {
  const item = document.querySelector(`[data-treedd-id="${sessionId}"]`);
  return item?.querySelector('.session-history__item-state')?.textContent ?? '';
}

describe('历史菜单会话活跃度标识（E4 批 4）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('待处理 / 运行中按会话 id 亮起，且待处理优先', () => {
    const { view } = mount();
    view.renderMenu(SESSIONS, []);
    view.setActivity(['2026-11-06-b'], ['2026-11-06-a'], 1);

    expect(stateLabel('2026-11-06-a')).toBe('Awaiting answer');
    expect(stateLabel('2026-11-06-b')).toBe('Executing');

    // 同一会话既在跑又在等答 ⇒ 只留「待处理」（两标签并存会让用户以为要处理两件事）
    view.setActivity(['2026-11-06-a'], ['2026-11-06-a'], 0);
    expect(stateLabel('2026-11-06-a')).toBe('Awaiting answer');
  });

  it('状态清空后标签与角标一起消失（不残留）', () => {
    const { view, badge } = mount();
    view.renderMenu(SESSIONS, []);
    view.setActivity(['2026-11-06-a'], ['2026-11-06-b'], 1);
    expect(stateLabel('2026-11-06-a')).toBe('Executing');
    // 角标与条目标签同源：1 个待处理 ⇒ 显示「1」
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('1');

    view.setActivity([], [], 0);
    expect(stateLabel('2026-11-06-a')).toBe('');
    expect(stateLabel('2026-11-06-b')).toBe('');
    // 零待处理 ⇒ 零显示（不得留一个「0」在入口上）
    expect(badge.hidden).toBe(true);
    expect(badge.textContent).toBe('');
  });

  it('上一轮终态是第三优先级：待处理压过运行中、运行中压过终态（P1 会话终态投影）', () => {
    const { view } = mount();
    // 三条会话分别带 completed / interrupted / unsettled 终态投影
    view.renderMenu(
      [
        {
          sessionId: '2026-11-06-a',
          title: 'A',
          updatedAt: '2026-11-06T10:00:00.000Z',
          lastOutcome: 'unsettled',
        },
        {
          sessionId: '2026-11-06-b',
          title: 'B',
          updatedAt: '2026-11-06T09:00:00.000Z',
          lastOutcome: 'interrupted',
        },
        {
          sessionId: '2026-11-06-c',
          title: 'C',
          updatedAt: '2026-11-06T08:00:00.000Z',
          lastOutcome: 'completed',
        },
      ],
      [],
    );
    // 无实时活跃度 ⇒ 只有终态标签；unsettled 的文案必须是「上次未正常结束」
    expect(stateLabel('2026-11-06-a')).toBe('Last run did not finish normally');
    expect(stateLabel('2026-11-06-b')).toBe('Stopped');
    expect(stateLabel('2026-11-06-c')).toBe('Completed');

    // 运行中（实时真源）压过终态（盘上投影）
    view.setActivity(['2026-11-06-a'], [], 0);
    expect(stateLabel('2026-11-06-a')).toBe('Executing');

    // 待处理压过运行中，也压过终态
    view.setActivity(['2026-11-06-a'], ['2026-11-06-a'], 1);
    expect(stateLabel('2026-11-06-a')).toBe('Awaiting answer');

    // 活跃度清空后回落到终态投影（不是消失）
    view.setActivity([], [], 0);
    expect(stateLabel('2026-11-06-a')).toBe('Last run did not finish normally');
  });
});
