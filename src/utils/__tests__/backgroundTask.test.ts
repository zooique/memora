/**
 * 后台任务收口门面单测：验证统一计数（pending/completed/failed）与 onFailure 补救触发。
 * 门面用模块级单例状态，测试间用相对差值断言，避免用例间互相污染。
 */
import { describe, it, expect, vi } from 'vitest';
import { backgroundTask, getBackgroundTaskStats, awaitBackgroundTasks } from '@/utils/backgroundTask.js';

/** 取当前统计快照（相对差值基准） */
function snapshot() {
  return getBackgroundTaskStats();
}

describe('backgroundTask 后台任务收口', () => {
  it('成功任务累加 completed，完成后释放 pending', async () => {
    const before = snapshot();
    backgroundTask('success', () => Promise.resolve('ok'));
    await vi.waitFor(() => {
      const s = snapshot();
      expect(s.pending).toBe(before.pending);
      expect(s.completed).toBe(before.completed + 1);
    });
  });

  it('失败任务累加 failed，并触发 onFailure 传入错误原因', async () => {
    const before = snapshot();
    const onFailure = vi.fn();
    const boom = new Error('boom');
    backgroundTask('fail', () => Promise.reject(boom), onFailure);
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().failed).toBe(before.failed + 1);
    });
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it('失败且未提供 onFailure 时静默降级（仅计数，不抛未捕获）', async () => {
    const before = snapshot();
    backgroundTask('fail-nohandler', () => Promise.reject(new Error('x')));
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().failed).toBe(before.failed + 1);
    });
  });

  it('K7 awaitBackgroundTasks 应等待在途任务完成后返回 pending 数', async () => {
    const before = snapshot();
    // 启动一个受控任务（不自动完成）
    let resolveTask!: () => void;
    backgroundTask('await-controlled', () => new Promise<void>((res) => { resolveTask = res; }));
    expect(getBackgroundTaskStats().pending).toBe(before.pending + 1);

    // 等待器应在任务完成时返回（返回等待开始时的在途任务数）
    const waitPromise = awaitBackgroundTasks(5000);
    resolveTask();
    const awaited = await waitPromise;
    expect(awaited).toBe(before.pending + 1);
    // 等待后 pending 应回落到基线
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().pending).toBe(before.pending);
    });
  });

  it('K7 awaitBackgroundTasks 超时应放弃剩余任务并返回在途数', async () => {
    const before = snapshot();
    // 永不完成的任务
    backgroundTask('await-forever', () => new Promise<void>(() => {}));
    const p = awaitBackgroundTasks(100); // 100ms 超时
    const awaited = await p;
    expect(awaited).toBe(before.pending + 1);
    // 悬挂任务仍在途（未被强行取消，也不阻塞 close）
    expect(getBackgroundTaskStats().pending).toBe(before.pending + 1);
  });
});
