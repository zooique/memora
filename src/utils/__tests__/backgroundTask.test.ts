/**
 * 后台任务收口门面单测：验证启动不阻塞、失败兜底（onFailure）、并发槽位排队与 awaitBackgroundTasks 语义。
 * 门面用模块级单例状态，测试间用 _resetBackgroundTaskState() 做物理隔离。
 *
 * 删后注记（2026-10-16 · 5.0.0）：曾有 completed/failed 累计统计断言（getBackgroundTaskStats 快照出口）——
 * 该出口的 Agent 公开面包装零宿主消费，连带 stats 只写字段整体拆除；在途观测改由
 * awaitBackgroundTasks 返回值与「排队任务被自动启动」的可观测行为承担。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  backgroundTask,
  awaitBackgroundTasks,
  _resetBackgroundTaskState,
} from '@/utils/backgroundTask.js';

describe('backgroundTask 后台任务收口', () => {
  // 每个测试前重置模块级状态，确保完全隔离（包括 activeCount / pendingQueue / pendingCount）
  beforeEach(() => {
    _resetBackgroundTaskState();
  });

  it('成功任务：awaitBackgroundTasks 等待完成后返回等待开始时的在途数', async () => {
    backgroundTask('success', () => Promise.resolve('ok'));
    const awaited = await awaitBackgroundTasks(5000);
    expect(awaited).toBe(1);
    // 等待后无在途任务（再次等待立即返回 0）
    expect(await awaitBackgroundTasks(5000)).toBe(0);
  });

  it('失败任务：onFailure 收到错误原因，await 不挂起', async () => {
    const onFailure = vi.fn();
    const boom = new Error('boom');
    backgroundTask('fail', () => Promise.reject(boom), onFailure);
    const awaited = await awaitBackgroundTasks(5000);
    expect(awaited).toBe(1);
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it('失败且未提供 onFailure 时静默降级（仅记日志，不抛未捕获）', async () => {
    backgroundTask('fail-nohandler', () => Promise.reject(new Error('x')));
    await expect(awaitBackgroundTasks(5000)).resolves.toBe(1);
  });

  it('awaitBackgroundTasks 超时应放弃剩余任务并返回等待开始时的在途数', async () => {
    // 永不完成的任务
    backgroundTask('await-forever', () => new Promise<void>(() => {}));
    const awaited = await awaitBackgroundTasks(100); // 100ms 超时
    expect(awaited).toBe(1);
  });

  // ── 并发槽位控制 ──────────────────────────────────────

  it('并发上限：超过 5 个任务时多余的进入排队，槽位释放后自动启动', async () => {
    // 启动 6 个受控任务：前 5 个立即执行（factory 被调用才注册 resolver），第 6 个排队
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
    // 排队中的第 6 个尚未启动（其 factory 未被调用，resolver 未注册）
    expect(resolvers).toHaveLength(5);

    // 释放第一个槽位 → 排队中的第 6 个任务应自动启动（resolver 注册）
    resolvers[0]!();
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(6);
    });

    // 清理：释放全部
    for (const res of resolvers) res();
    await awaitBackgroundTasks(5000);
  });

  it('排队任务的 onFailure 正确触发（失败也释放槽位并消费队列）', async () => {
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

    // 释放一个槽位 → 排队中的失败任务应自动启动并失败
    hold[0]!();
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(boom);
    });

    // 清理：释放剩余的占位任务
    for (let i = 1; i < hold.length; i++) {
      hold[i]!();
    }
    await awaitBackgroundTasks(5000);
  });

  it('awaitBackgroundTasks 应等待排队中的任务完成', async () => {
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
    // 第 6 个排队（启动即完成）
    let queuedDone = false;
    backgroundTask('queued', () => {
      queuedDone = true;
      return Promise.resolve();
    });

    // 开始等待（返回等待开始时的在途数 = 6）
    const waitPromise = awaitBackgroundTasks(5000);

    // 释放槽位让排队任务启动并完成
    hold[0]!();
    await vi.waitFor(() => {
      expect(queuedDone).toBe(true);
    });
    // 释放剩余
    for (let i = 1; i < hold.length; i++) {
      hold[i]!();
    }

    const awaited = await waitPromise;
    expect(awaited).toBe(6);
  });
});
