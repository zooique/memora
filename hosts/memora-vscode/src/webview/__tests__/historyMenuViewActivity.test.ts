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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { createHistoryMenuView, type SessionSummaryDto } from '../scripts/historyMenuView.js';

/** 造菜单依赖的 6 个节点（与 chatPanel 模板同名；不复用整页模板，避免测试被无关 DOM 拖累） */
function mount() {
  document.body.innerHTML = `
    <div id="historyMenu"></div>
    <button id="historyTabRecent"></button>
    <button id="historyTabArchived"></button>
    <button id="historyTabHosted"></button>
    <span id="historyArchivedCount"></span>
    <input id="historySearch" />
    <span id="historyPendingBadge" hidden></span>
  `;
  const view = createHistoryMenuView({
    document,
    menuEl: document.getElementById('historyMenu') as HTMLElement,
    tabRecent: document.getElementById('historyTabRecent') as HTMLButtonElement,
    tabArchived: document.getElementById('historyTabArchived') as HTMLButtonElement,
    tabHosted: document.getElementById('historyTabHosted') as HTMLButtonElement,
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

describe('历史菜单会话来源图标（origin）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('仅 hosted 显示图标；user / undefined 不显示任何标记', () => {
    const { view } = mount();
    view.renderMenu(
      [
        {
          sessionId: '2026-11-06-h',
          title: '助手会话',
          updatedAt: '2026-11-06T10:00:00.000Z',
          origin: 'hosted',
        },
        {
          sessionId: '2026-11-06-u',
          title: '用户会话',
          updatedAt: '2026-11-06T09:00:00.000Z',
          origin: 'user',
        },
        // 旧数据：无 origin 键
        { sessionId: '2026-11-06-o', title: '旧会话', updatedAt: '2026-11-06T08:00:00.000Z' },
      ],
      [],
    );

    /** 取某会话条目的来源图标（不存在返回 null） */
    const originIcon = (id: string): Element | null =>
      document.querySelector(`[data-treedd-id="${id}"] .session-history__item-origin`);

    // 第三区分组后 hosted 不在默认「会话记录」视图里：图标在它自己的分组中验
    (document.getElementById('historyTabHosted') as HTMLElement).click();
    expect(originIcon('2026-11-06-h')).not.toBeNull();
    // 面向用户只说「助手」；「托管」属内部模式名，不得出现在列表标识里
    expect(originIcon('2026-11-06-h')?.getAttribute('aria-label')).toBe('Assistant session');

    (document.getElementById('historyTabRecent') as HTMLElement).click();
    // 用户会话与旧数据：不造「用户」标记，也不留空 span（空 span 会多占 flex gap）
    expect(originIcon('2026-11-06-u')).toBeNull();
    expect(originIcon('2026-11-06-o')).toBeNull();
  });
});

/** 「助手建的」分组三态夹具：一个 hosted（且带留存标记）、一个普通、一个留存 */
const GROUP_SESSIONS: SessionSummaryDto[] = [
  {
    sessionId: '2026-11-17-hosted',
    title: '助手派的活',
    updatedAt: '2026-11-17T10:00:00.000Z',
    origin: 'hosted',
  },
  { sessionId: '2026-11-17-recent', title: '自助会话', updatedAt: '2026-11-17T09:00:00.000Z' },
  {
    sessionId: '2026-11-17-retained',
    title: '留存会话',
    updatedAt: '2026-11-17T08:00:00.000Z',
  },
];

/** 当前渲染出的条目 id（日期组头不是 item，天然被排除） */
function visibleIds(): string[] {
  return [...document.querySelectorAll('#historyMenu [data-treedd-id]')].map(
    (el) => (el as HTMLElement).dataset.treeddId ?? '',
  );
}

describe('历史菜单「助手建的」分组（HOSTED-LIST-GROUP-1）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('三组互斥：hosted 带留存标记仍归第三区，留存计数按实际归属派生', () => {
    const { view } = mount();
    // hosted 同时被打了归档标记，验证归属优先级而不是「两个标记各管各的」
    view.renderMenu(GROUP_SESSIONS, ['2026-11-17-hosted', '2026-11-17-retained']);
    const count = document.getElementById('historyArchivedCount') as HTMLElement;
    expect(visibleIds()).toEqual(['2026-11-17-recent']);
    expect(count.textContent).toContain('1'); // 不算 hosted 那条虚报「留存区 2」

    (document.getElementById('historyTabArchived') as HTMLElement).click();
    expect(visibleIds()).toEqual(['2026-11-17-retained']);

    (document.getElementById('historyTabHosted') as HTMLElement).click();
    expect(visibleIds()).toEqual(['2026-11-17-hosted']);
    const hostedTab = document.getElementById('historyTabHosted') as HTMLElement;
    expect(hostedTab.classList.contains('is-active')).toBe(true);
    expect(hostedTab.getAttribute('aria-selected')).toBe('true');
    expect(
      (document.getElementById('historyTabRecent') as HTMLElement).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('第三区不渲染无效的归档按钮，保留打开与删除；搜索只作用于当前组', () => {
    const { view } = mount();
    view.renderMenu(GROUP_SESSIONS, []);
    (document.getElementById('historyTabHosted') as HTMLElement).click();
    const item = document.querySelector('[data-treedd-id="2026-11-17-hosted"]') as HTMLElement;
    expect(item.querySelector('.session-history__item-keep')).toBeNull();
    expect(item.querySelector('.session-history__item-del')).not.toBeNull();

    const search = document.getElementById('historySearch') as HTMLInputElement;
    search.value = '没有这条';
    search.dispatchEvent(new Event('input'));
    expect(visibleIds()).toEqual([]);
    expect((document.getElementById('historyMenu') as HTMLElement).textContent).toContain(
      'No assistant-created sessions matching',
    );
  });

  it('再次打开历史浮层回到默认分组（第三区不是新默认）', () => {
    const { view } = mount();
    view.renderMenu(GROUP_SESSIONS, []);
    (document.getElementById('historyTabHosted') as HTMLElement).click();
    expect(visibleIds()).toEqual(['2026-11-17-hosted']);
    view.openFresh();
    // 回默认「会话记录」：hosted 退场，普通会话仍在（本夹具未归档，两条都属于近期）
    expect(visibleIds()).not.toContain('2026-11-17-hosted');
    expect(visibleIds()).toContain('2026-11-17-recent');
    expect(
      (document.getElementById('historyTabRecent') as HTMLElement).classList.contains('is-active'),
    ).toBe(true);
  });
});

/** 源码守卫的根：兼容「cd 宿主跑」与「从仓库根 --root 宿主跑」两种入口 */
const HOST_ROOT = existsSync(resolve(process.cwd(), 'src/webview/panels'))
  ? process.cwd()
  : resolve(process.cwd(), 'hosts/memora-vscode');

/** 生产 HTML 是手写夹具的镜像源：只锁夹具会漏掉「生产没这个节点 ⇒ 域工厂初始化即抛错」 */
describe('生产模板第三组 tab 源码守卫（HOSTED-LIST-GROUP-1）', () => {
  it('生产 HTML 真有第三组 tab，且未带 .treedd__item（点击委托会收起浮层）', () => {
    const src = readFileSync(resolve(HOST_ROOT, 'src/webview/panels/chatPanelHtml.ts'), 'utf8');
    const tag = src.split('\n').find((line) => line.includes('id="historyTabHosted"')) ?? '';
    expect(tag).toContain('data-view="hosted"');
    expect(tag).not.toContain('treedd__item');
  });

  it('view 侧把生产节点接进域工厂（缺接线时初始化即崩）', () => {
    const src = readFileSync(resolve(HOST_ROOT, 'src/webview/scripts/chatView.ts'), 'utf8');
    expect(src).toContain('tabHosted: historyTabHosted');
  });
});

/**
 * 三组 tab 的显示形态守卫（HIST-TAB-ORDER-1 · 2026-11-20 用户拍板）：
 * 显示顺序 = 助手(hosted) → 我的(recent) → 留存(archived)，默认选中仍为 recent（居中）。
 * 归属判据 groupOfSession 的 hosted > archived > recent 是**显示无关的定案**，不在本守卫范围。
 * 源码级读生产而非只锁夹具（夹具漂移不让守卫失效，规则 3）。
 */
describe('历史会话浮层显示形态源码守卫（HIST-TAB-ORDER-1）', () => {
  it('生产模板 tab DOM 顺序 = 助手 → 我的 → 留存，默认 is-active 仍在 recent', () => {
    const src = readFileSync(resolve(HOST_ROOT, 'src/webview/panels/chatPanelHtml.ts'), 'utf8');
    const order = ['historyTabHosted', 'historyTabRecent', 'historyTabArchived'].map((id) =>
      src.indexOf(`id="${id}"`),
    );
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // 三个 id 按此序出现
    const recentTag = src.split('\n').find((line) => line.includes('id="historyTabRecent"')) ?? '';
    expect(recentTag).toContain('is-active');
    expect(recentTag).toContain('aria-selected="true"');
  });

  it('浮层尺寸走专属令牌，max 宽高均带视口兜底（不复用共享 --dim-xl）', () => {
    const tokens = readFileSync(resolve(HOST_ROOT, 'src/webview/styles/tokens.ts'), 'utf8');
    expect(tokens).toMatch(/--history-menu-max-w:\s*400px/);
    expect(tokens).toMatch(/--history-menu-max-h:\s*480px/);
    const styles = readFileSync(resolve(HOST_ROOT, 'src/webview/styles/chatStyles.ts'), 'utf8');
    const menu = styles
      .split('\n')
      .find((line) => line.includes('max-width: min(var(--history-menu-max-w)'));
    expect(menu).toBeDefined();
    expect(styles).toContain(
      'max-height: min(var(--history-menu-max-h), calc(100vh - var(--sp-6)))',
    );
    // 共享刻度仍在 5+ 处消费，历史菜单不得再引它（改引专属令牌是本项落地点）
    expect(styles).not.toContain('max-width: min(var(--dim-xl), calc(100vw - var(--sp-6)))');
  });

  it('zh-cn 三组 tab 译文 = 助手 / 我的 / 留存（英文键不动）', () => {
    const zh = JSON.parse(
      readFileSync(resolve(HOST_ROOT, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'),
    ) as Record<string, string>;
    expect(zh['Assistant-created']).toBe('助手');
    expect(zh['Sessions']).toBe('我的');
    expect(zh['Retained']).toBe('留存');
    const en = JSON.parse(
      readFileSync(resolve(HOST_ROOT, 'l10n/bundle.l10n.json'), 'utf8'),
    ) as Record<string, string>;
    expect(en['Assistant-created']).toBe('');
    expect(en['Sessions']).toBe('');
    expect(en['Retained']).toBe('');
  });
});
