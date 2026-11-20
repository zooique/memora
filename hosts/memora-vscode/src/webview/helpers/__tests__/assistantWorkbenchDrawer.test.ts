/**
 * 助手页内嵌工作台抽屉测试（INLINE-WORKBENCH-1）
 *
 * 钉住五条判据：
 *   ① 抽屉渲染从快照取数，会话名 / 状态徽记 / 「去这个会话」一一就位；
 *   ② 措辞与独立工作台同源（复用 describeStatus / seatStateText）——running 出「Running」、
 *      stopped 出「Stopped」，边缘态（queued/unreadable）不出徽记；
 *   ③ 空态按 coverage 分档措辞：unreadable = 「历史读不到」，complete 才说「还没有」；
 *   ④ 点击「去这个会话」走注入的 openSession 回调（chatView 接 switch_session），零新增 type；
 *   ⑤ 顶部就地视图说明行点明两入口分工（就地 / 命令面板常驻）；
 *   ⑥ 抽屉关闭按钮点击走注入的 onClose 回调（chatView 置 drawer.hidden，零新状态/协议）；
 *   ⑦ 副行明细复刻 describeStatus.detail：无徽记的 queued/unreadable 仍出状态语义，措辞同源。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAssistantWorkbenchDrawer } from '../assistantWorkbenchDrawer.js';
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
  const onClose = vi.fn();
  const drawer = createAssistantWorkbenchDrawer({ document, openSession, onClose });
  return { drawer, openSession, onClose };
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
    expect(badges).toEqual(['Stopped', null, null]);
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
    expect(host.firstElementChild?.classList.contains('awb-hint')).toBe(true);
    expect(host.querySelector('.awb-hint')?.textContent).toBe(
      'Inline view. To keep a workbench open side by side, use the Command Palette.',
    );
    // 说明行不重复命令标题（真源 = package.nls 的 command.openWorkbench.title）
    expect(host.querySelector('.awb-hint')?.textContent).not.toContain('Memora:');
  });

  it('关闭按钮点击走 onClose 回调（chatView 置 drawer.hidden，零新状态/协议）', () => {
    const { drawer, onClose } = mount();
    drawer.render(snapshot());
    const host = document.getElementById('assistantWorkbenchDrawer') as HTMLElement;
    const close = host.querySelector<HTMLButtonElement>('.awb-close');
    expect(close).not.toBeNull();
    expect(close?.type).toBe('button');
    expect(close?.getAttribute('aria-label')).toBe('Close');
    close?.click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('容器不存在时静默跳过（self 形态无该节点），不抛错', () => {
    document.body.innerHTML = '';
    const openSession = vi.fn();
    const drawer = createAssistantWorkbenchDrawer({ document, openSession, onClose: vi.fn() });
    expect(() => drawer.render(snapshot())).not.toThrow();
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

  it('CSS：卡片纵向排列 + 描边/内距/面色，且行间距可辨、形态前缀不漏', () => {
    const block = blockOf("body[data-form='assistant'] .awb-job");
    expect(block).toMatch(/flex-direction:\s*column/);
    expect(block).toContain('border: var(--line-solid)');
    expect(block).toMatch(/border-radius:\s*var\(--radius/);
    expect(block).toMatch(/padding:\s*var\(--sp-3/);
    expect(block).toContain('background: var(--surface-card)');
    // 反向：退回旧的裸行（居中 + wrap）会让卡片边界再次糊掉
    expect(block).not.toMatch(/align-items:\s*center/);
    expect(block).not.toMatch(/flex-wrap:\s*wrap/);
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
    // 反向：这三条正是「看起来像一行字」的旧形态
    expect(block).not.toMatch(/text-decoration:\s*underline/);
    expect(block).not.toMatch(/border:\s*none/);
    expect(block).not.toMatch(/background:\s*transparent/);
    // 卡片化不得丢掉键盘可达的焦点环
    expect(css()).toContain("body[data-form='assistant'] .awb-job__open:focus-visible");
  });
});
