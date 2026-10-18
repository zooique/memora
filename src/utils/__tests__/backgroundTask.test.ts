/**
 * 后台任务收口门面单测：验证启动不阻塞、失败兜底（onFailure）、并发槽位排队、
 * awaitPending 语义 与 cancelPending（只清未启动队列）语义。
 *
 * 实例级：每个用例 new BackgroundTaskScheduler() 即天然隔离（无模块级状态、无需重置钩子）。
 *
 * 删后注记（2026-10-16 · 5.0.0）：曾有 completed/failed 累计统计断言（getBackgroundTaskStats 快照出口）——
 * 该出口的 Agent 公开面包装零宿主消费，连带 stats 只写字段整体拆除；在途观测改由
 * awaitPending 返回值与「排队任务被自动启动」的可观测行为承担。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundTaskScheduler } from '@/utils/backgroundTask.js';

describe('BackgroundTaskScheduler 后台任务收口', () => {
  /** 被测调度器（每用例新建，天然隔离） */
  let scheduler: BackgroundTaskScheduler;

  beforeEach(() => {
    scheduler = new BackgroundTaskScheduler();
  });

  it('成功任务：awaitPending 等待完成后返回等待开始时的在途数', async () => {
    scheduler.schedule('success', () => Promise.resolve('ok'));
    const awaited = await scheduler.awaitPending(5000);
    expect(awaited).toBe(1);
    // 等待后无在途任务（再次等待立即返回 0）
    expect(await scheduler.awaitPending(5000)).toBe(0);
  });

  it('失败任务：onFailure 收到错误原因，await 不挂起', async () => {
    const onFailure = vi.fn();
    const boom = new Error('boom');
    scheduler.schedule('fail', () => Promise.reject(boom), onFailure);
    const awaited = await scheduler.awaitPending(5000);
    expect(awaited).toBe(1);
    expect(onFailure).toHaveBeenCalledWith(boom);
  });

  it('失败且未提供 onFailure 时静默降级（仅记日志，不抛未捕获）', async () => {
    scheduler.schedule('fail-nohandler', () => Promise.reject(new Error('x')));
    await expect(scheduler.awaitPending(5000)).resolves.toBe(1);
  });

  it('awaitPending 超时应放弃剩余任务并返回等待开始时的在途数', async () => {
    // 永不完成的任务
    scheduler.schedule('await-forever', () => new Promise<void>(() => {}));
    const awaited = await scheduler.awaitPending(100); // 100ms 超时
    expect(awaited).toBe(1);
  });

  // ── 并发槽位控制 ──────────────────────────────────────

  it('并发上限：超过 5 个任务时多余的进入排队，槽位释放后自动启动', async () => {
    // 启动 6 个受控任务：前 5 个立即执行（factory 被调用才注册 resolver），第 6 个排队
    const resolvers: Array<() => void> = [];
    for (let i = 0; i < 6; i++) {
      scheduler.schedule(
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
    await scheduler.awaitPending(5000);
  });

  it('排队任务的 onFailure 正确触发（失败也释放槽位并消费队列）', async () => {
    const onFailure = vi.fn();
    const boom = new Error('concurrent-boom');

    // 5 个占位任务填满槽位
    const hold: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      scheduler.schedule(
        'fill-slot',
        () =>
          new Promise<void>((res) => {
            hold.push(res);
          }),
      );
    }

    // 第 6 个任务排队，它会立即失败
    scheduler.schedule('queued-fail', () => Promise.reject(boom), onFailure);

    // 释放一个槽位 → 排队中的失败任务应自动启动并失败
    hold[0]!();
    await vi.waitFor(() => {
      expect(onFailure).toHaveBeenCalledWith(boom);
    });

    // 清理：释放剩余的占位任务
    for (let i = 1; i < hold.length; i++) {
      hold[i]!();
    }
    await scheduler.awaitPending(5000);
  });

  it('awaitPending 应等待排队中的任务完成', async () => {
    // 5 个占位任务填满槽位
    const hold: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      scheduler.schedule(
        'fill',
        () =>
          new Promise<void>((res) => {
            hold.push(res);
          }),
      );
    }
    // 第 6 个排队（启动即完成）
    let queuedDone = false;
    scheduler.schedule('queued', () => {
      queuedDone = true;
      return Promise.resolve();
    });

    // 开始等待（返回等待开始时的在途数 = 6）
    const waitPromise = scheduler.awaitPending(5000);

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

  // ── cancelPending（只清未启动队列，不中断在途） ──────────────────────────

  it('cancelPending 只丢弃未启动的排队任务，不中断在途任务', async () => {
    // 5 个在途占位任务填满槽位
    const hold: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      scheduler.schedule(
        'inflight',
        () =>
          new Promise<void>((res) => {
            hold.push(res);
          }),
      );
    }
    // 2 个排队（未启动）
    let queuedRan = 0;
    scheduler.schedule('queued-1', () => {
      queuedRan++;
      return Promise.resolve();
    });
    scheduler.schedule('queued-2', () => {
      queuedRan++;
      return Promise.resolve();
    });

    // 清队列：返回丢弃数 2
    expect(scheduler.cancelPending()).toBe(2);
    // 在途 5 个不受影响（hold 仍有 5 个未 resolve）
    expect(hold).toHaveLength(5);
    // 排队的工厂从未启动
    expect(queuedRan).toBe(0);

    // 清理在途
    for (const res of hold) res();
    await scheduler.awaitPending(5000);
    expect(queuedRan).toBe(0);
  });

  it('cancelPending 无排队时返回 0（幂等，不误扣在途计数）', async () => {
    const hold: Array<() => void> = [];
    scheduler.schedule(
      'inflight',
      () =>
        new Promise<void>((res) => {
          hold.push(res);
        }),
    );
    // 无排队任务 → 0
    expect(scheduler.cancelPending()).toBe(0);
    // 在途计数未被误扣（awaitPending 仍读得到 1）
    const waitPromise = scheduler.awaitPending(5000);
    hold[0]!();
    expect(await waitPromise).toBe(1);
  });
});

/**
 * MULTI-AGENT-1 —— 多实例后台槽位**隔离验证**（形态定案：一个 Agent = 一个项目）。
 *
 * 背景：本门面曾为模块级单例（activeCount / pendingQueue / pendingCount 绑定模块作用域），
 * N 个 Agent 实例共享同一 5 槽与同一 FIFO ⇒ 跨项目挤占 + 交叉等待（历史实锤）。
 * 按 SSOT 归位到实例字段 `BackgroundTaskScheduler` 后，本块由「事实测量」翻转为**隔离断言**。
 *
 * 为什么测机制而不是端到端起两个 Agent：根因就在实例字段归属，起两个真 Agent 需注入
 * store/provider/hooks，链路噪声远大于信号；本块用两个调度器实例直接对根因下断言。
 */
describe('MULTI-AGENT-1 · 多 Agent 实例后台槽位隔离（隔离验证）', () => {
  it('槽位实例隔离：实例 A 占满 5 槽后，实例 B 的任务照常立即启动', async () => {
    const schedulerA = new BackgroundTaskScheduler();
    const schedulerB = new BackgroundTaskScheduler();
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const slow = (label: string) => () =>
      new Promise<void>((res) => {
        started.push(label);
        gates.push(res);
      });

    // 实例 A 起 5 个长任务（占满 A 的槽位）
    for (let i = 0; i < 5; i++) schedulerA.schedule(`A-${i}`, slow(`A-${i}`));
    expect(started.filter((s) => s.startsWith('A-'))).toHaveLength(5);

    // 实例 B 起 1 个任务 —— A、B 是两个项目，B 有自己的槽位，立即启动（隔离实证）
    schedulerB.schedule('B-0', slow('B-0'));
    expect(started).toContain('B-0');

    // 清理
    for (const g of gates) g();
    await schedulerA.awaitPending(5000);
    await schedulerB.awaitPending(5000);
  });

  it('awaitPending 是实例口径：实例 A 的 close 不等实例 B 的在途任务', async () => {
    const schedulerA = new BackgroundTaskScheduler();
    const schedulerB = new BackgroundTaskScheduler();
    let releaseB!: () => void;
    schedulerB.schedule(
      'B-long',
      () =>
        new Promise<void>((res) => {
          releaseB = res;
        }),
    );

    // 「实例 A」调 close → 读到的是 A 自己的在途数（0，不交叉等待 B）
    const awaitedA = await schedulerA.awaitPending(5000);
    expect(awaitedA).toBe(0);
    // B 确实在途（不受 A 影响）
    const waitB = schedulerB.awaitPending(5000);
    releaseB();
    expect(await waitB).toBe(1);
  });

  it('cancelPending 只清本实例队列：清 A 不影响 B 的排队任务', async () => {
    const schedulerA = new BackgroundTaskScheduler();
    const schedulerB = new BackgroundTaskScheduler();
    const hold: Array<() => void> = [];
    // A 填满 5 槽 + 1 排队；B 填满 5 槽 + 1 排队
    const fill = (s: BackgroundTaskScheduler, tag: string) => {
      for (let i = 0; i < 5; i++) {
        s.schedule(
          `${tag}-inflight-${i}`,
          () =>
            new Promise<void>((res) => {
              hold.push(res);
            }),
        );
      }
      s.schedule(`${tag}-queued`, () => Promise.resolve());
    };
    fill(schedulerA, 'A');
    fill(schedulerB, 'B');

    // 只清 A 的队列 → 返回 1（B 的排队任务不受影响）
    expect(schedulerA.cancelPending()).toBe(1);

    // 先各自取「等待开始时的在途数」（同步捕获 entry 快照），再释放全部在途
    const waitA = schedulerA.awaitPending(5000);
    const waitB = schedulerB.awaitPending(5000);
    for (const res of hold) res();
    // A 只剩 5 个在途（排队已丢），B 的 6 个照常跑完（含排队那个）——隔离实证
    expect(await waitA).toBe(5);
    expect(await waitB).toBe(6);
  });
});
