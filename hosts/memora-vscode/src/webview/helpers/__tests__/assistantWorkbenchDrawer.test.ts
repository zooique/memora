/**
 * 助手页内嵌工作台抽屉测试（INLINE-WORKBENCH-1）
 *
 * 钉住五条判据：
 *   ① 抽屉渲染从快照取数，会话名 / 状态徽记 / 「去这个会话」一一就位；
 *   ② 措辞与独立工作台同源（复用 describeStatus / seatStateText）——running 出「Running」、
 *      stopped 出「Stopped」，边缘态（queued/unreadable）不出徽记；
 *   ③ 空态按 coverage 分档措辞：unreadable = 「历史读不到」，complete 才说「还没有」；
 *   ④ 点击「去这个会话」走注入的 openSession 回调（chatView 接 switch_session），零新增 type；
 *   ⑤ 顶部就地视图说明行点明两入口分工（就地 / 命令面板常驻），且为首个节点，不硬编码命令标题。
 */
// @vitest-environment jsdom
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
  const drawer = createAssistantWorkbenchDrawer({ document, openSession });
  return { drawer, openSession };
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

  it('空态按 coverage 分档：unreadable 说「历史读不到」，complete 才说「还没有」', () => {
    const { drawer } = mount();
    drawer.render(snapshot({ coverage: 'unreadable' }));
    expect(document.querySelector('.awb-empty')?.textContent).toBe('History could not be read');
    drawer.render(snapshot({ coverage: 'complete' }));
    expect(document.querySelector('.awb-empty')?.textContent).toBe(
      'No work has been handed to the assistant yet',
    );
  });

  it('座位状态行复用 seatStateText：revoked 出「已从助手收回」', () => {
    const { drawer } = mount();
    drawer.render(
      snapshot({
        seatSource: 'revoked',
        orchestrator: { ...snapshot().orchestrator, managed: false },
      }),
    );
    expect(document.querySelector('.awb-seat__state')?.textContent).toBe(
      'Taken back from the assistant; no live agent is driving it right now',
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

  it('容器不存在时静默跳过（self 形态无该节点），不抛错', () => {
    document.body.innerHTML = '';
    const openSession = vi.fn();
    const drawer = createAssistantWorkbenchDrawer({ document, openSession });
    expect(() => drawer.render(snapshot())).not.toThrow();
  });
});
