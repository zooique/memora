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

/**
 * MULTI-AGENT-1 —— 多实例共享后台槽位（形态定案的代价面，2026-10-18 实测）。
 *
 * 背景：内核形态定案「一个 Agent = 一个项目，多项目由宿主各建实例」，但本门面的
 * `activeCount` / `pendingQueue` / `pendingCount` 三个绑定是**模块级**而非实例级
 * （`src/utils/backgroundTask.ts` 顶部模块作用域）⇒ N 个 Agent 实例共享同一 5 槽位与同一 FIFO 队列。
 *
 * 为什么测机制而不是端到端起两个 Agent：根因就在模块级可变状态，起两个真 Agent 需要注入
 * store/provider/hooks，链路噪声远大于信号；本块用「标签分组」模拟两个实例的调用来源，
 * 直接对根因下断言。端到端行为差异已由本块两条用例的结论完整覆盖（挤占 + 交叉等待）。
 *
 * 本块是**事实测量**，不是缺陷断言——形态定案的既定代价，修不修由台账 `MULTI-AGENT-1` 定，
 * 这里只负责让「已知代价」变成「可执行、可回归的证据」。
 */
describe('MULTI-AGENT-1 · 多 Agent 实例共享后台槽位（事实测量）', () => {
  beforeEach(() => {
    _resetBackgroundTaskState();
  });

  it('槽位全局共享：实例 A 占满 5 槽后，实例 B 的任务被挤进同一队列', async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const slow = (label: string) => () =>
      new Promise<void>((res) => {
        started.push(label);
        gates.push(res);
      });

    // 实例 A 起 5 个长任务（占满全局槽位）
    for (let i = 0; i < 5; i++) backgroundTask(`A-${i}`, slow(`A-${i}`));
    expect(started.filter((s) => s.startsWith('A-'))).toHaveLength(5);

    // 实例 B 起 1 个任务 —— 明明 A、B 是两个项目，B 却抢不到槽位
    backgroundTask('B-0', slow('B-0'));
    expect(started).not.toContain('B-0');

    // 只有 A 释放一个槽位，B 才能启动（挤占实证）
    gates[0]!();
    await vi.waitFor(() => {
      expect(started).toContain('B-0');
    });

    // 清理
    for (const g of gates) g();
    await awaitBackgroundTasks(5000);
  });

  it('awaitBackgroundTasks 是全局口径：实例 A 的 close 会等实例 B 的在途任务', async () => {
    let releaseB!: () => void;
    backgroundTask(
      'B-long',
      () =>
        new Promise<void>((res) => {
          releaseB = res;
        }),
    );

    // 「实例 A」调 close → awaitBackgroundTasks 读到的是 B 的在途数（交叉等待实证）
    const waitPromise = awaitBackgroundTasks(5000);
    releaseB();
    const awaited = await waitPromise;
    expect(awaited).toBe(1);
  });
});
