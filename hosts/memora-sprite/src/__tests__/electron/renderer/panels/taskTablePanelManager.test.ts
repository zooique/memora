/**
 * TaskTablePanelManager 单元测试（暂停控制组：暂停/取消暂停/继续三态按钮）
 *
 * 用户设计定案（2026-08-10 + 实测纠偏）：暂停/继续/取消暂停统一在任务清单列表，
 * 发送按钮不承载暂停（大厂语义：运行态空=停止/有=发送补充）。
 *
 * 守护（三态互斥）：
 *   - 无暂停态且无在途申请：渲染「暂停」按钮，点击委托 host.pauseSession
 *   - 无暂停态但在途申请（pausePending）：渲染「取消暂停」，点击委托 host.cancelPause
 *   - suspended（已挂起）：只渲染「继续」（不再显示「取消暂停」——取消暂停仅在
 *     申请未触发时有意义，已暂停直接继续即可），点击委托 resumeSession
 *
 * 变异验证点：删除任一按钮渲染分支 → 对应用例转红。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskTablePanelManager, type TaskTablePanelHost, type WorkContext } from '../../../../electron/renderer/panels/taskTablePanelManager.js';

const TASKS_TABLE_CONTAINER_ID = 'tasks-table-container';

function createMockHost(): TaskTablePanelHost & { mocks: Record<string, ReturnType<typeof vi.fn>> } {
  const mocks: Record<string, ReturnType<typeof vi.fn>> = {
    showToast: vi.fn(),
    getAgentStatus: vi.fn(() => 'running'),
    getWorkContext: vi.fn(),
    pauseSession: vi.fn().mockResolvedValue(undefined),
    cancelPause: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    removeDraft: vi.fn(),
    archiveSessionWithContext: vi.fn().mockResolvedValue({ archivedCount: 0 }),
  };
  return { ...mocks, mocks };
}

function setup(ctx: WorkContext): { manager: TaskTablePanelManager; host: ReturnType<typeof createMockHost>; container: HTMLElement } {
  document.body.innerHTML = `<div id="${TASKS_TABLE_CONTAINER_ID}"></div>`;
  const container = document.getElementById(TASKS_TABLE_CONTAINER_ID)!;
  const host = createMockHost();
  host.mocks.getWorkContext.mockResolvedValue(ctx);
  const manager = new TaskTablePanelManager();
  manager.init(host as unknown as TaskTablePanelHost);
  return { manager, host, container };
}

/** 渲染后取按钮区中的文本按钮（排除任务表步骤） */
function buttonsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('button'));
}

describe('TaskTablePanelManager · 暂停控制组（用户设计：暂停/继续/取消暂停在任务清单）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('无暂停态且会话运行中（running）→ 渲染「暂停」按钮，点击委托 pauseSession', async () => {
    // 运行中空 plan：长任务 LLM 正在生成任务表，暂停按钮仍有意义（可中断生成）
    const ctx: WorkContext = { plan: [], activeStepOrder: -1 };
    const { manager, host, container } = setup(ctx);
    await manager.loadData();

    const btns = buttonsIn(container);
    const pauseBtn = btns.find((b) => b.textContent === '暂停');
    expect(pauseBtn).toBeDefined();
    expect(btns.find((b) => b.textContent === '继续')).toBeUndefined();

    pauseBtn!.click();
    expect(host.mocks.pauseSession).toHaveBeenCalledTimes(1);
  });

  it('无暂停态且会话空闲（idle）→ 不渲染「暂停」按钮（任务执行完毕重启后无任务可暂停）', async () => {
    const ctx: WorkContext = { plan: [], activeStepOrder: -1 };
    const { manager, host, container } = setup(ctx);
    // 模拟重启后会话空闲（无任务在执行）
    host.mocks.getAgentStatus.mockReturnValue('idle');
    await manager.loadData();

    const btns = buttonsIn(container);
    expect(btns.find((b) => b.textContent === '暂停')).toBeUndefined();
    expect(btns.find((b) => b.textContent === '继续')).toBeUndefined();
  });

  it('suspended（已挂起）→ 只渲染「继续」，不再显示「取消暂停」（互斥）', async () => {
    const ctx: WorkContext = {
      plan: [],
      activeStepOrder: -1,
      pausePhase: 'suspended',
      pauseReason: '用户暂停',
      pauseSource: 'user',
    };
    const { manager, host, container } = setup(ctx);
    await manager.loadData();

    const btns = buttonsIn(container);
    const resumeBtn = btns.find((b) => b.textContent === '继续');
    // 已暂停态：取消暂停按钮与继续互斥——取消暂停只在「申请未触发」时有意义
    expect(resumeBtn).toBeDefined();
    expect(btns.find((b) => b.textContent === '取消暂停')).toBeUndefined();
    expect(btns.find((b) => b.textContent === '暂停')).toBeUndefined();

    resumeBtn!.click();
    expect(host.mocks.resumeSession).toHaveBeenCalledTimes(1);
  });

  it('暂停申请在途（pausePending）→ 渲染「取消暂停」，点击委托 cancelPause（撤销申请）', async () => {
    const ctx: WorkContext = {
      plan: [],
      activeStepOrder: -1,
      pausePending: true,
    };
    const { manager, host, container } = setup(ctx);
    await manager.loadData();

    const btns = buttonsIn(container);
    const cancelPendingBtn = btns.find((b) => b.textContent === '取消暂停');
    expect(cancelPendingBtn).toBeDefined();
    // 在途申请态不显示「暂停」（已申请）也不显示「继续」（未挂起）
    expect(btns.find((b) => b.textContent === '暂停')).toBeUndefined();
    expect(btns.find((b) => b.textContent === '继续')).toBeUndefined();

    cancelPendingBtn!.click();
    expect(host.mocks.cancelPause).toHaveBeenCalledTimes(1);
  });

  it('无 plan 且无暂停态 → 仍显示「暂停」按钮（按钮区常显，与 plan 内容无关）', async () => {
    const ctx: WorkContext = { plan: [], activeStepOrder: -1 };
    const { manager, container } = setup(ctx);
    await manager.loadData();

    const pauseBtn = buttonsIn(container).find((b) => b.textContent === '暂停');
    expect(pauseBtn).toBeDefined();
  });
});
