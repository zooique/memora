/**
 * 后台任务收口门面单测：验证统一计数（pending/completed/failed）、onFailure 补救与并发槽位控制。
 * 门面用模块级单例状态，测试间用 _resetBackgroundTaskState() 做物理隔离。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  backgroundTask,
  getBackgroundTaskStats,
  awaitBackgroundTasks,
  _resetBackgroundTaskState,
} from '@/utils/backgroundTask.js';

/** 取当前统计快照（相对差值基准） */
function snapshot() {
  return getBackgroundTaskStats();
}

describe('backgroundTask 后台任务收口', () => {
  // 每个测试前重置模块级状态，确保完全隔离（包括 activeCount / pendingQueue）
  beforeEach(() => {
    _resetBackgroundTaskState();
  });

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
    backgroundTask(
      'await-controlled',
      () =>
        new Promise<void>((res) => {
          resolveTask = res;
        }),
    );
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

  // ── 并发槽位控制 ──────────────────────────────────────

  it('并发上限：超过 5 个任务时多余的进入排队', async () => {
    const before = snapshot();
    // 启动 6 个永不完成的任务：前 5 个立即执行，第 6 个排队
    const resolvers: Array<() => void> = [];
    for (let i = 0; i < 6; i++) {
      backgroundTask(
        'concurrent',
        () =>
          new Promise<void>((res) => {
            resolvers.push(res);
          }),
      );
    }
    // 全部 6 个都计入 pending（含排队中的）
    expect(getBackgroundTaskStats().pending).toBe(before.pending + 6);

    // 释放第一个槽位 → 排队中的第 6 个任务应自动启动
    resolvers[0]!();
    await vi.waitFor(() => {
      // 1 个完成（completed+1, pending-1），第 6 个排队→执行（pending 不变）
      // 剩余 4 个运行中 + 1 个新启动的 = 5 运行中
      expect(getBackgroundTaskStats().completed).toBe(before.completed + 1);
      expect(getBackgroundTaskStats().pending).toBe(before.pending + 5);
    });

    // 释放全部剩余
    for (let i = 1; i < 6; i++) {
      resolvers[i]!();
    }
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().pending).toBe(before.pending);
      expect(getBackgroundTaskStats().completed).toBe(before.completed + 6);
    });
  });

  it('排队任务的 onFailure 正确触发（失败也释放槽位并消费队列）', async () => {
    const before = snapshot();
    const onFailure = vi.fn();
    const boom = new Error('concurrent-boom');

    // 5 个占位任务填满槽位
    const hold: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      backgroundTask(
        'fill-slot',
        () =>
          new Promise<void>((res) => {
            hold.push(res);
          }),
      );
    }

    // 第 6 个任务排队，它会立即失败
    backgroundTask('queued-fail', () => Promise.reject(boom), onFailure);

    // 排队中：pending 包含所有 6 个
    expect(getBackgroundTaskStats().pending).toBe(before.pending + 6);

    // 释放一个槽位 → 排队中的失败任务应自动启动并失败
    hold[0]!();
    await vi.waitFor(() => {
      // 1 fill-slot 完成 + 1 queued-fail 失败
      expect(getBackgroundTaskStats().completed).toBe(before.completed + 1);
      expect(getBackgroundTaskStats().failed).toBe(before.failed + 1);
      // pending: +6 - 1(完成) - 1(失败) = +4
      expect(getBackgroundTaskStats().pending).toBe(before.pending + 4);
    });
    expect(onFailure).toHaveBeenCalledWith(boom);

    // 清理：释放剩余的占位任务
    for (let i = 1; i < hold.length; i++) {
      hold[i]!();
    }
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().pending).toBe(before.pending);
      expect(getBackgroundTaskStats().completed).toBe(before.completed + 5);
    });
  });

  it('awaitBackgroundTasks 应等待排队中的任务完成', async () => {
    const before = snapshot();
    // 5 个占位任务填满槽位
    const hold: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      backgroundTask(
        'fill',
        () =>
          new Promise<void>((res) => {
            hold.push(res);
          }),
      );
    }
    // 第 6 个排队
    let resolveQueued!: () => void;
    backgroundTask(
      'queued',
      () =>
        new Promise<void>((res) => {
          resolveQueued = res;
        }),
    );

    // 全部 6 个在途
    expect(getBackgroundTaskStats().pending).toBe(before.pending + 6);

    // 开始等待
    const waitPromise = awaitBackgroundTasks(5000);

    // 释放槽位让排队任务启动并完成
    hold[0]!(); // 释放一个槽位 → 排队的开始执行
    await vi.waitFor(() => {
      expect(resolveQueued).toBeDefined();
    });
    resolveQueued(); // 排队的完成
    // 释放剩余
    for (let i = 1; i < hold.length; i++) {
      hold[i]!();
    }

    const awaited = await waitPromise;
    expect(awaited).toBe(before.pending + 6);
    await vi.waitFor(() => {
      expect(getBackgroundTaskStats().pending).toBe(before.pending);
      expect(getBackgroundTaskStats().completed).toBe(before.completed + 6);
    });
  });
});
