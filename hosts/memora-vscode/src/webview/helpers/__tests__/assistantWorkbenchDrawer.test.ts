/**
 * 助手页内嵌工作台抽屉测试（INLINE-WORKBENCH-1）
 *
 * 钉住五条判据：
 *   ① 抽屉渲染从快照取数，会话名 / 状态徽记 / 「去这个会话」一一就位；
 *   ② 措辞与独立工作台同源（复用 describeStatus / seatStateText）——running 出「Running」、
 *      stopped 出「Stopped」，边缘态（queued/unreadable）不出徽记；
 *   ③ 空态按 coverage 分档措辞：unreadable = 「历史读不到」，complete 才说「还没有」；
 *   ④ 点击「去这个会话」走注入的 openSession 回调（chatView 接 switch_session），零新增 type；
 *   ⑤ 顶部就地视图说明行点明两入口分工（就地 / 独立 tab 常驻）；
 *   ⑥ 「在 tab 打开」按钮点击走 openInTab + onClose（UI-SEAT-AUDIT：原关闭按钮改语义）；
 *   ⑦ 副行明细复刻 describeStatus.detail：无徽记的 queued/unreadable 仍出状态语义，措辞同源；
 *   ⑧ ASSISTANT-UI-DECLUTTER-1：重置收进本抽屉、位于「在 tab 打开」左侧、共用 awb-action
 *      形态，点击走 onReset；身份条不再持有重置节点（源码级守卫）。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssistantWorkbenchDrawer, assistantJobTier } from '../assistantWorkbenchDrawer.js';
import type {
  WorkbenchJob,
  WorkbenchJobStatus,
  WorkbenchSnapshot,
} from '../../../shared/workbenchDto.js';

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
    foreignDispatches: 0,
    coverage: 'complete',
    missingCount: 0,
    coverageReasons: [],
    scan: { maxRounds: 60, totalRounds: 0, scannedRounds: 0 },
    ...overrides,
  };
}

function job(sessionId: string, status: WorkbenchJobStatus): WorkbenchJob {
  return { sessionId, title: `标题-${sessionId}`, status, updatedAt: '2026-11-14T00:00:00.000Z' };
}

function mount() {
  document.body.innerHTML = '<section id="assistantWorkbenchDrawer"></section>';
  const openSession = vi.fn();
  const openInTab = vi.fn();
  const onReset = vi.fn();
  const onClose = vi.fn();
  const drawer = createAssistantWorkbenchDrawer({
    document,
    openSession,
    openInTab,
    onReset,
    onClose,
  });
  return { drawer, openSession, openInTab, onReset, onClose };
}

describe('INLINE-WORKBENCH-1 · 助手页内嵌工作台抽屉', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('按快照渲染会话名 + 状态徽记 + 去会话按钮；点击走 openSession 回调', () => {
    const { drawer, openSession } = mount();
    drawer.render(snapshot({ jobs: [job('s-running', { kind: 'running' })] }));
    const item = document.querySelector('.awb-job') as HTMLElement;
    expect(item.querySelector('.awb-job__title')?.textContent).toBe('标题-s-running');
    expect(item.querySelector('.awb-badge')?.textContent).toBe('Running');
    (item.querySelector('.awb-job__open') as HTMLButtonElement).click();
    expect(openSession).toHaveBeenCalledWith('s-running');
  });

  it('措辞与独立工作台同源：stopped 出 Stopped，queued/unreadable 不出徽记', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({
        jobs: [
          job('s-stopped', { kind: 'stopped', stop: { kind: 'user' } }),
          job('s-queued', { kind: 'queued' }),
          job('s-bad', { kind: 'unreadable' }),
        ],
      }),
    );
    const badges = [...document.querySelectorAll('.awb-job')].map(
      (li) => li.querySelector('.awb-badge')?.textContent ?? null,
    );
    // 2026-11-20 去折叠：stopped 排末位仍直接显示，三张卡片同在常驻 ul；
    // 措辞与独立工作台同源的判据不变（Stopped 出徽记、queued/unreadable 不出）。
    expect(badges).toEqual([null, null, 'Stopped']);
    expect(
      document.querySelectorAll('li.awb-job')[2]?.querySelector('.awb-badge')?.textContent,
    ).toBe('Stopped');
    expect(document.querySelector('details')).toBeNull();
  });

  it('副行明细复刻 describeStatus.detail：无徽记的 queued/unreadable 仍出状态语义', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({
        jobs: [
          job('s-running', { kind: 'running' }),
          job('s-queued', { kind: 'queued' }),
          job('s-bad', { kind: 'unreadable' }),
          job('s-stopped', { kind: 'stopped', stop: { kind: 'user' } }),
        ],
      }),
    );
    const details = [...document.querySelectorAll('.awb-job')].map(
      (li) => li.querySelector('.awb-job__detail')?.textContent ?? null,
    );
    expect(details).toEqual([
      null,
      'Handed over, not started yet',
      'Status unavailable · The latest turn could not be read',
      'Stopped by you',
    ]);
  });

  it('空态按 coverage 分档：unreadable 说「历史读不到」，complete 才说「还没有」', () => {
    const { drawer } = mount();
    drawer.render(snapshot({ coverage: 'unreadable' }));
    expect(document.querySelector('.awb-empty')?.textContent).toBe('History could not be read');
    drawer.render(snapshot({ coverage: 'complete' }));
    expect(document.querySelector('.awb-empty')?.textContent).toBe(
      'No work has been handed to the assistant yet',
    );
  });

  it('顶部就地视图说明行点明两入口分工，且为首个节点', () => {
    const { drawer } = mount();
    drawer.render(snapshot({ jobs: [job('s-running', { kind: 'running' })] }));
    const host = document.getElementById('assistantWorkbenchDrawer') as HTMLElement;
    // 说明行被 awb-head 包裹（flex 行：hint + 「在 tab 打开」按钮），head 是首节点
    expect(host.firstElementChild?.classList.contains('awb-head')).toBe(true);
    expect(host.querySelector('.awb-hint')?.textContent).toBe(
      'Inline view. To keep a workbench open side by side, open it in a tab.',
    );
    // 说明行不重复命令标题（真源 = package.nls 的 command.openWorkbench.title）
    expect(host.querySelector('.awb-hint')?.textContent).not.toContain('Memora:');
  });

  it('「在 tab 打开」按钮点击走 openInTab + onClose（UI-SEAT-AUDIT：原关闭按钮改语义）', () => {
    const { drawer, openInTab, onClose } = mount();
    drawer.render(snapshot());
    const host = document.getElementById('assistantWorkbenchDrawer') as HTMLElement;
    const btn = host.querySelector<HTMLButtonElement>('[data-awb-action="open-tab"]');
    expect(btn).not.toBeNull();
    expect(btn?.type).toBe('button');
    expect(btn?.getAttribute('aria-label')).toBe('Open in a tab');
    btn?.click();
    expect(openInTab).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ASSISTANT-UI-DECLUTTER-1：重置收进头部动作组、居左、共用 awb-action，点击走 onReset 且不关抽屉', () => {
    const { drawer, onReset, onClose } = mount();
    drawer.render(snapshot());
    const host = document.getElementById('assistantWorkbenchDrawer') as HTMLElement;
    const actions = host.querySelector<HTMLElement>('.awb-actions');
    expect(actions).not.toBeNull();
    const buttons = [...actions!.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.dataset.awbAction)).toEqual(['reset', 'open-tab']);
    for (const b of buttons) expect(b.classList.contains('awb-action')).toBe(true);
    const reset = buttons[0];
    expect(reset.type).toBe('button');
    expect(reset.textContent).toBe('Reset');
    expect(reset.getAttribute('aria-label')).toBe('Reset assistant session');
    expect(reset.title).toBe('Reset assistant session');
    reset.click();
    expect(onReset).toHaveBeenCalledOnce();
    // 重置不是「离开抽屉」：确认弹窗在宿主侧，抽屉保留待用户裁决；与 open-tab 的 onClose 区分
    expect(onClose).not.toHaveBeenCalled();
  });

  it('容器不存在时静默跳过（self 形态无该节点），不抛错', () => {
    document.body.innerHTML = '';
    const openSession = vi.fn();
    const drawer = createAssistantWorkbenchDrawer({
      document,
      openSession,
      openInTab: vi.fn(),
      onReset: vi.fn(),
      onClose: vi.fn(),
    });
    expect(() => drawer.render(snapshot())).not.toThrow();
  });
});

describe('ASSISTANT-UI-DECLUTTER-1 · 重置入口收纳（源码级机检：生产 HTML + 样式）', () => {
  it('生产骨架与测试骨架均无身份条重置节点，避免第二入口回流', () => {
    for (const file of [
      join(__dirname, '..', '..', 'panels', 'chatPanelHtml.ts'),
      join(__dirname, '..', '..', '__tests__', 'helpers', 'chatViewTestEnv.ts'),
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toContain('assistantResetBtn');
    }
    const view = readFileSync(join(__dirname, '..', '..', 'scripts', 'chatView.ts'), 'utf8');
    expect(view).not.toContain("getElementById('assistantResetBtn')");
    expect(view).toContain("onReset: () => vscode.postMessage({ type: 'reset_assistant' })");
  });

  it('CSS：awb-action 为两钮唯一共用形态，旧 awb-open-tab 选择器已退役', () => {
    const style = readFileSync(
      join(__dirname, '..', '..', 'styles', 'chatStyles.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(style).toContain("body[data-form='assistant'] .awb-action {");
    expect(style).toContain("body[data-form='assistant'] .awb-actions {");
    expect(style).not.toMatch(/\.awb-open-tab/);
  });
});

describe('AWB-JOB-CARD-1 · 一行一卡片与实体按钮（源码级机检）', () => {
  /** 去注释的样式原文：注释里会出现示例选择器，干扰逐块比对 */
  const css = (): string =>
    readFileSync(join(__dirname, '..', '..', 'styles', 'chatStyles.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
  /** 精确取 `selector {` 到第一个 `}`（本层规则无嵌套） */
  const blockOf = (selector: string): string => {
    const text = css();
    const start = text.indexOf(`${selector} {`);
    expect(start, `样式块 ${selector} 未找到（选择器改名？同步本守卫）`).toBeGreaterThan(-1);
    return text.slice(start, text.indexOf('}', start));
  };

  it('DOM：一条会话 = 一个 li 卡片，去会话控件是原生 button[type=button]', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({ jobs: [job('s1', { kind: 'running' }), job('s2', { kind: 'queued' })] }),
    );
    const items = [...document.querySelectorAll('li.awb-job')];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.querySelector('.awb-job__title')).not.toBeNull();
      const open = item.querySelector('.awb-job__open');
      expect(open?.tagName).toBe('BUTTON');
      expect(open?.getAttribute('type')).toBe('button');
    }
  });

  it('CSS：卡片横排 + wrap + 描边/内距/面色，且行间距可辨、形态前缀不漏', () => {
    const block = blockOf("body[data-form='assistant'] .awb-job");
    // 2026-11-20 用户拍板：按钮与标题同行，空间不足才换行，卡片本身仍保留
    expect(block).toMatch(/flex-direction:\s*row/);
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    expect(block).toMatch(/align-items:\s*center/);
    expect(block).toContain('border: var(--line-solid)');
    expect(block).toMatch(/border-radius:\s*var\(--radius/);
    expect(block).toMatch(/padding:\s*var\(--sp-2/);
    expect(block).toContain('background: var(--surface-card)');
    // 反向：退回纵向独占一行的旧卡片，多行又变高
    expect(block).not.toMatch(/flex-direction:\s*column/);
    expect(block).not.toMatch(/align-items:\s*stretch/);
    // 卡片间距取 sp-2（大于卡内 sp-1），逐卡可辨
    expect(blockOf("body[data-form='assistant'] .awb-jobs")).toContain('gap: var(--sp-2, 6px)');
    // 反向：无前缀的同名卡片规则会泄漏到 self 形态
    const stray = [...css().matchAll(/([^\n{}]*\.awb-job[^\n{}]*)\{[^}]*border:/g)]
      .map((m) => m[1] as string)
      .filter((sel) => !sel.includes("body[data-form='assistant']"));
    expect(stray).toEqual([]);
  });

  it('CSS：去会话按钮是实体描边胶囊，不再是下划线文字（含焦点可见）', () => {
    const block = blockOf("body[data-form='assistant'] .awb-job__open");
    expect(block).toContain('border: var(--line-solid)');
    expect(block).toMatch(/border-radius:\s*var\(--radius-pill/);
    expect(block).toContain('background: var(--surface-card)');
    // 横排靠右：按钮不独占一行，与标题/徽记同行或换行到行尾
    expect(block).toContain('margin-left: auto');
    expect(block).toMatch(/align-self:\s*center/);
    // 反向：这三条正是「看起来像一行字」的旧形态
    expect(block).not.toMatch(/text-decoration:\s*underline/);
    expect(block).not.toMatch(/border:\s*none/);
    expect(block).not.toMatch(/background:\s*transparent/);
    // 卡片化不得丢掉键盘可达的焦点环
    expect(css()).toContain("body[data-form='assistant'] .awb-job__open:focus-visible");
  });
});

describe('AWB-JOB-TIER-1 · 三档分层与已收场折叠（上位原则：自助模式独立）', () => {
  it('纯函数分档：waiting=attention，未收场=active，完成/停手=settled', () => {
    expect(assistantJobTier({ kind: 'waiting' })).toBe('attention');
    for (const kind of ['running', 'queued', 'unsettled', 'unreadable'] as const) {
      expect(assistantJobTier({ kind })).toBe('active');
    }
    expect(assistantJobTier({ kind: 'completed' })).toBe('settled');
    expect(assistantJobTier({ kind: 'stopped', stop: { kind: 'user' } })).toBe('settled');
  });

  it('DOM 顺序：attention 最前、active 居中、已收场直接显示在末位（2026-11-20 去折叠）', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({
        jobs: [
          job('s-completed', { kind: 'completed' }),
          job('s-running', { kind: 'running' }),
          job('s-waiting', { kind: 'waiting' }),
          job('s-queued', { kind: 'queued' }),
          job('s-stopped', { kind: 'stopped', stop: { kind: 'error', message: 'x' } }),
        ],
      }),
    );
    const host = document.getElementById('assistantWorkbenchDrawer') as HTMLElement;
    const titles = [...host.querySelectorAll('ul.awb-jobs > li.awb-job')].map(
      (li) => li.querySelector('.awb-job__title')?.textContent,
    );
    expect(titles).toEqual([
      '标题-s-waiting',
      '标题-s-running',
      '标题-s-queued',
      '标题-s-completed',
      '标题-s-stopped',
    ]);
    // 折叠层判为过度设计：不得再出现 details / summary，且只有一个 ul
    expect(host.querySelector('details')).toBeNull();
    expect(host.querySelector('summary')).toBeNull();
    expect(host.querySelectorAll('ul.awb-jobs')).toHaveLength(1);
  });

  it('已收场卡片直接显示：无 details、无计数文案，卡片本身即分组', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({
        jobs: [
          job('a', { kind: 'completed' }),
          job('b', { kind: 'stopped', stop: { kind: 'user' } }),
        ],
      }),
    );
    const cards = [...document.querySelectorAll('li.awb-job')];
    expect(cards.map((li) => li.querySelector('.awb-job__title')?.textContent)).toEqual([
      '标题-a',
      '标题-b',
    ]);
    expect(document.querySelector('details.awb-settled')).toBeNull();
    expect(document.body.textContent).not.toContain('Finished (');
  });

  it('只读边界：抽屉源码只引用 describeStatus/seatStateText，不 import 判据投影与写入口', () => {
    const src = readFileSync(join(__dirname, '..', 'assistantWorkbenchDrawer.ts'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    // import 面只有四个只读符号：两个 DTO type + 两个只读文案函数
    expect(src).not.toMatch(/from\s+['"][^'"]*sessionStatus/);
    expect(src).not.toMatch(/projectSessionStatus|workStatus|\.save\(/);
    // 分档只读 status.kind，不写回 status
    expect(src).not.toMatch(/status\s*[:=]\s*\{/);
  });

  it('CSS：折叠区规则已删除，无 awb-settled 死样式残留', () => {
    const style = readFileSync(
      join(__dirname, '..', '..', 'styles', 'chatStyles.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(style).not.toMatch(/\.awb-settled/);
    expect(style).not.toMatch(/\.awb-jobs--settled/);
  });
});
