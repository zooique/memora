/**
 * 状态条 / 活动抽屉屏上语言断言（B8）
 *
 * 默认语言下，StatusDock 三条常驻条（待发送 / 未确认文件改动 / 后台任务）与活动抽屉
 * （含指标详情）渲染出来的文本必须是**零 CJK**。与 `securityScreenLanguage.test.ts` 同族：
 * 源码守卫（判据⑰）只能证明源文件里没有中文字面量，证明不了用户实际看到的屏上文本；
 * 这里直接断言渲染结果——传入的载荷（命令原文 / 工具标签 / 哈希）全部是 ASCII，
 * 屏上任何 CJK 都只可能来自 UI 文案本身。
 *
 * **覆盖边界（如实写死）**：
 *   - 本用例只喂 ASCII 数据，故它守住的是「UI 文案面」；
 *   - 真实链路上 `chatView` 传给 `showActivity` 的提示文案仍是中文（B9 迁移）；
 *   - 后台任务条的 `statusLabel` 由 extension 侧按**宿主自持词表**填充后下发
 *     （SSOT-OWNERSHIP-1：内核只出 `BackgroundTask['status']` 值域），故该条在真实链路上
 *     已是本地化文案；本用例喂 ASCII 标签只验 webview 自己的文案面。
 *
 * 环境：node + 显式 JSDOM（与 MCP / 安全页用例同法）。`activityDrawerView` 用全局
 * `window.setTimeout` 挂自动撤出计时器，故建 DOM 后把 `window` 挂到 globalThis，
 * 用例结束统一 `dispose()` 清计时器。
 */
// @vitest-environment node
import { createRequire } from 'node:module';
import { describe, it, expect, afterEach } from 'vitest';

/** 本仓未带 jsdom 类型；此处做一次结构断言即可 */
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => { window: Window & typeof globalThis };
};

/** CJK 区段：汉字 + CJK 标点 + 全角字符（与源码守卫同族） */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

import type { BackgroundTaskView } from '../../shared/protocol.js';
import { createActivityDrawerView } from '../scripts/activityDrawerView.js';
import type { ActivityDrawerView } from '../scripts/activityDrawerView.js';
import { createStatusBarsView } from '../scripts/statusBarsView.js';
import type { StatusBarsView } from '../scripts/statusBarsView.js';

/** 建一份承载三条 bar / 抽屉节点的 DOM，并把 window 挂到全局（供域内定时器解析） */
function makeDom(): { window: Window & typeof globalThis; doc: Document } {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="input-bar"></div>
    <div id="activity-bar"></div>
    <div id="activity-list"></div>
    <div id="activity-metrics"></div>
    <div id="activity-metrics-empty"></div>
  </body></html>`);
  const { window } = dom;
  // 域内用全局 window.setTimeout / clearTimeout（不注入 deps），node 环境下须显式挂载
  (globalThis as unknown as { window: Window }).window = window;
  return { window, doc: window.document };
}

/** 创建状态条容器（所有上报面都是 no-op：本用例只看渲染文本） */
function mountBars(doc: Document): StatusBarsView {
  const inputBar = doc.getElementById('input-bar')!;
  return createStatusBarsView({
    document: doc,
    inputBar,
    setDockActive: () => {},
    registerDockEntry: () => {},
    appendInteractiveInput: () => {},
    postMessage: () => {},
  });
}

/** 创建活动抽屉容器（折叠轴固定收起：让未读位分支也走一遍） */
function mountDrawer(doc: Document): ActivityDrawerView {
  return createActivityDrawerView({
    document: doc,
    activityBar: doc.getElementById('activity-bar')!,
    activityList: doc.getElementById('activity-list')!,
    activityMetrics: doc.getElementById('activity-metrics')!,
    activityMetricsEmpty: doc.getElementById('activity-metrics-empty')!,
    setDockActive: () => {},
    setDockFixed: () => {},
    notifyDockChanged: () => {},
    isDockExpanded: () => false,
  });
}

/** 已创建的视图（afterEach 统一 dispose，防定时器跨用例泄漏） */
const views: { dispose: () => void }[] = [];

afterEach(() => {
  while (views.length > 0) views.pop()!.dispose();
});

describe('状态条：默认语言屏上文本', () => {
  it('待发送区 / 文件改动条 / 后台任务条零 CJK（含 title 与 aria-label）', () => {
    const { doc } = makeDom();
    const bars = mountBars(doc);
    views.push(bars);

    // ① 待发送区：一条 ASCII 队列项
    bars.updatePendingQueue(['run the tests please']);
    // ② 未确认文件改动条：一条 ASCII 路径
    bars.updateFileChanges(['src/alpha.ts']);
    // ③ 后台任务条：running 行（有「终止」）+ 终态行（有「收起」）
    const tasks: BackgroundTaskView[] = [
      { taskId: 't1', command: 'npm test', status: 'running', statusLabel: 'running' },
      { taskId: 't2', command: 'npm build', status: 'completed', statusLabel: 'completed' },
    ];
    bars.updateBackgroundTasks(tasks);

    const inputBar = doc.getElementById('input-bar')!;
    const parent = inputBar.parentNode as HTMLElement;
    const pendingBar = parent.querySelector('.pending-queue-bar')!;
    const changesBar = parent.querySelector('.file-changes-bar')!;
    const bgBar = parent.querySelector('.background-tasks-bar')!;

    // 正向控制：三条 bar 真的渲染了（空白节点不能靠「没文本」通过断言）
    expect(pendingBar.textContent).toContain('Pending');
    expect(pendingBar.textContent).toContain('run the tests please');
    expect(changesBar.textContent).toContain('1');
    expect(bgBar.textContent).toContain('npm test');
    expect(bgBar.textContent).toContain('running');

    // 属性面也是 UI 文案（悬停提示 + 读屏名），逐个点名核对
    expect(pendingBar.querySelector('.pending-queue-bar__clear')?.getAttribute('title')).toBe(
      'Clear all',
    );
    expect(pendingBar.querySelector('.pending-queue-bar__clear')?.getAttribute('aria-label')).toBe(
      'Clear all pending items',
    );
    expect(pendingBar.querySelector('.pending-queue-bar__item-del')?.getAttribute('title')).toBe(
      'Remove this item',
    );
    expect(changesBar.querySelector('.file-changes-bar__confirm')?.textContent).toBe('Confirm all');
    expect(changesBar.querySelector('.file-changes-bar__revert')?.textContent).toBe('Revert all');
    expect(bgBar.querySelector('.background-tasks-bar__kill')?.textContent).toBe('Stop');
    expect(bgBar.querySelector('.background-tasks-bar__dismiss')?.getAttribute('aria-label')).toBe(
      'Dismiss this background task',
    );

    // 断言口径：textContent 不含 CJK；属性面逐条已在上方点名，再整体扫一次 title / aria-label
    for (const el of [pendingBar, changesBar, bgBar]) {
      expect(el.textContent ?? '').not.toMatch(CJK);
      for (const node of Array.from(el.querySelectorAll('[title], [aria-label]'))) {
        expect(node.getAttribute('title') ?? '').not.toMatch(CJK);
        expect(node.getAttribute('aria-label') ?? '').not.toMatch(CJK);
      }
    }
  });

  it('正向控制：状态条里出现中文一定会被检出（守卫自身不失明）', () => {
    const { doc } = makeDom();
    const bars = mountBars(doc);
    views.push(bars);
    bars.updateFileChanges(['src/alpha.ts']);
    const label = doc.querySelector('.file-changes-bar__label')!;
    label.textContent = '个文件';
    expect(label.textContent).toMatch(CJK);
  });
});

describe('活动抽屉：默认语言屏上文本', () => {
  it('状态条 + 指标详情零 CJK（累计 / token / 预算 / 操作流 / 安全审计全分支）', () => {
    const { doc } = makeDom();
    const drawer = mountDrawer(doc);
    views.push(drawer);

    // 活动条：error 档（固定主位分支）；载荷 ASCII
    drawer.showActivity('error', 'boom from the server');

    // 指标详情：五类可选字段全部给值（trace / budget / securityAudit 都在）
    drawer.renderMetrics({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: {
        llmCallCount: 3,
        toolFailureCount: 2,
        unparsedToolIntentCount: 1,
        truncationCount: 4,
        llmTokenIn: 1234,
        llmTokenOut: 567,
        budget: {
          availableTokens: 100000,
          anchorTokens: 2000,
          dialogueBudgetTokens: 90000,
          remainingTokens: 8000,
        },
      },
      trace: [{ label: 'LLM call' }, { label: 'Tool · read_file' }],
      securityAudit: {
        total: 2,
        denied: 1,
        recent: [{ type: 'read', path: '/tmp/a.ts', reason: 'outside root' }],
      },
    });

    const barEl = doc.getElementById('activity-bar')!;
    const metricsEl = doc.getElementById('activity-metrics')!;
    const historyEl = doc.getElementById('activity-list')!;

    // 正向控制：各段真的渲染了（缺一段就等于该段没被测到）
    expect(barEl.textContent).toContain('boom from the server');
    expect(metricsEl.textContent).toContain('Round fingerprint: system prompt abc123');
    expect(metricsEl.textContent).toContain('Cumulative: 3 LLM calls');
    expect(metricsEl.textContent).toContain('2 tool failures');
    expect(metricsEl.textContent).toContain('1 unparsed tool intents');
    expect(metricsEl.textContent).toContain('4 truncations');
    expect(metricsEl.textContent).toContain(
      'Tokens (estimated): 1234 cumulative in / 567 (excludes thinking) out',
    );
    expect(metricsEl.textContent).toContain('Budget: 100k available');
    expect(metricsEl.textContent).toContain('Operation flow:');
    expect(metricsEl.textContent).toContain('› LLM call');
    expect(metricsEl.textContent).toContain('Security audit: 2 events · 1 denied');
    expect(metricsEl.textContent).toContain('recent: read /tmp/a.ts (outside root)');
    expect(historyEl.textContent).toContain('boom from the server');

    // 文案面判据：三块渲染结果均不得含 CJK
    expect(barEl.textContent ?? '').not.toMatch(CJK);
    expect(metricsEl.textContent ?? '').not.toMatch(CJK);
    expect(historyEl.textContent ?? '').not.toMatch(CJK);
  });

  it('指标可选字段缺省时不渲染占位中文（token / 预算缺省分支）', () => {
    const { doc } = makeDom();
    const drawer = mountDrawer(doc);
    views.push(drawer);

    drawer.renderMetrics({
      type: 'metrics',
      fingerprints: {},
      metrics: {
        llmCallCount: 1,
        toolFailureCount: 0,
        truncationCount: 0,
      },
    });

    const metricsEl = doc.getElementById('activity-metrics')!;
    expect(metricsEl.textContent).toContain('Round fingerprint: system prompt -');
    expect(metricsEl.textContent).toContain('Tokens (estimated): - in / - out');
    expect(metricsEl.textContent).not.toMatch(CJK);
  });

  it('正向控制：指标详情里出现中文一定会被检出（守卫自身不失明）', () => {
    const { doc } = makeDom();
    const drawer = mountDrawer(doc);
    views.push(drawer);
    const metricsEl = doc.getElementById('activity-metrics')!;
    metricsEl.textContent = '本轮指纹：中文';
    expect(metricsEl.textContent).toMatch(CJK);
  });
});
