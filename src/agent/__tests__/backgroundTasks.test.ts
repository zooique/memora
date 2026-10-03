/**
 * backgroundTasks.test.ts — 后台命令任务注册表（方案文档 §14 · 阶段 1）
 *
 * 覆盖范围：
 *   1. start 立即返回 taskId（不阻塞）+ running 态可查
 *   2. 完成 → 回调一次 + completed 态 + 结果可读
 *   3. kill → 返回已捕获输出 + killed 态，且**不再回调**（防同一结果被消费两次）
 *   4. reapAll → 收割全部存活任务，已终态不重复收割
 *   5. 不存在的 taskId → get/kill 返回 null（非抛错）
 *   6. **实例隔离**：两个注册表互不可见（非单例——多会话不得互杀，§14.1 定案守卫）
 *
 * 进程治理本身（杀树 / 内存护栏）的断言在 skillScriptRunner 侧，本文件不重复。
 */
import { describe, it, expect } from 'vitest';
import {
  BackgroundTaskRegistry,
  BACKGROUND_TASK_STATUS_LABELS,
  formatBackgroundTaskNotice,
  type BackgroundTask,
} from '../backgroundTasks.js';

/**
 * 跨平台长驻命令（经注册表内的 shell 派发：Windows cmd /c，POSIX sh -c）
 * 生命周期 120s：收割靠 kill/reapAll 主动结束而非自然退出——给 gate-full
 * 全量并发下的调度抖动留余量（20000 在饱和负载下会被测试窗口追上）
 */
const SLEEP_CMD = 'node -e "setTimeout(()=>{},120000)"';
/** 跨平台快速命令（完成态用例用） */
const ECHO_CMD = 'echo memora-bg-ok';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待任务进入 running 态（裸 sleep 在全量并发下不可靠：调度延迟会跨过断言窗口） */
async function waitForRunning(registry: BackgroundTaskRegistry, taskIds: string[]): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const statuses = taskIds.map((id) => registry.get(id)?.status);
    if (statuses.every((s) => s === 'running')) return;
    await sleep(200);
  }
  const snapshot = registry
    .list()
    .map((t) => `${t.taskId}:${t.status}`)
    .join(', ');
  throw new Error(`任务未按预期存活（${snapshot}）`);
}

describe('BackgroundTaskRegistry（后台命令任务注册表）', () => {
  it('start 立即返回 taskId（不等进程结束）', () => {
    const registry = new BackgroundTaskRegistry();
    const t0 = Date.now();
    const taskId = registry.start(SLEEP_CMD);

    // 意图 = 没等 120s 进程结束；上界给足调度余量（饱和负载下同步 spawn 实测可达 1.7s）
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(taskId).toBe('bg-1');
    expect(registry.get(taskId)?.status).toBe('running');

    registry.reapAll();
  });

  it('完成 → 回调一次 + completed 态 + 结果可读', async () => {
    const registry = new BackgroundTaskRegistry();
    const done = new Promise<BackgroundTask>((resolve) => registry.setCompletionListener(resolve));
    const taskId = registry.start(ECHO_CMD);

    const task = await done;
    expect(task.taskId).toBe(taskId);
    expect(task.status).toBe('completed');
    expect(task.result?.stdout).toContain('memora-bg-ok');
    expect(registry.get(taskId)?.status).toBe('completed');
  });

  it('kill → 返回已捕获输出 + killed 态，且**不再回调**（防重复消费）', async () => {
    const registry = new BackgroundTaskRegistry();
    const calls: BackgroundTask[] = [];
    registry.setCompletionListener((t) => calls.push(t));

    const taskId = registry.start(SLEEP_CMD);
    await waitForRunning(registry, [taskId]);

    const killed = registry.kill(taskId);
    expect(killed?.status).toBe('killed');
    expect(killed?.result).toBeDefined();

    // 给进程退出留窗口：退出事件不得再触发完成回调（输出已由 kill_command 直接返回）
    await sleep(800);
    expect(calls).toHaveLength(0);
    expect(registry.get(taskId)?.status).toBe('killed');
  });

  it('reapAll → 收割全部存活任务；已终态不重复收割', async () => {
    const registry = new BackgroundTaskRegistry();
    const a = registry.start(SLEEP_CMD);
    const b = registry.start(SLEEP_CMD);

    await waitForRunning(registry, [a, b]);

    const reaped = registry.reapAll();
    expect(reaped.map((t) => t.taskId).sort()).toEqual([a, b].sort());
    reaped.forEach((t) => expect(t.status).toBe('killed'));
    // 第二次收割为空（不重复计数）
    expect(registry.reapAll()).toHaveLength(0);
  });

  it('不存在的 taskId → get/kill 返回 null（不抛错）', () => {
    const registry = new BackgroundTaskRegistry();
    expect(registry.get('bg-999')).toBeNull();
    expect(registry.kill('bg-999')).toBeNull();
  });

  it('两个注册表实例互不可见（非单例——多会话不得互杀，§14.1 定案守卫）', async () => {
    const sessionA = new BackgroundTaskRegistry();
    const sessionB = new BackgroundTaskRegistry();
    const taskId = sessionA.start(SLEEP_CMD);

    // 若注册表是模块级单例，下面两行就会「看得到 / 杀得掉」别的会话的进程
    expect(sessionB.get(taskId)).toBeNull();
    expect(sessionB.kill(taskId)).toBeNull();

    sessionA.reapAll();
  });
});

describe('formatBackgroundTaskNotice（回流文案 · 2026-10-03 对抗式回顾补锁）', () => {
  /** 构造一个已完成的超长输出任务投影（不经真实进程，纯格式化层） */
  function makeTask(stdout: string, status: BackgroundTask['status'] = 'completed') {
    return {
      taskId: 'bg-1',
      command: 'npm run build',
      startedAt: Date.now(),
      status,
      result: { stdout, stderr: '', exitCode: 0, timedOut: false },
    } satisfies BackgroundTask;
  }

  it('超长输出被定长截断（真伤：定长真源曾住在 toolExecutor 私有常量，回流面看不到它）', () => {
    // 2MB 内存护栏放行的输出若无字符上限，回流会把它整块灌进上下文
    const notice = formatBackgroundTaskNotice(makeTask('x'.repeat(2 * 1024 * 1024)));
    expect(notice.length).toBeLessThan(30_000);
    // 截断必须如实标注（不得静默丢尾巴）
    expect(notice).toContain('省略');
  });

  it('头部与尾部都保留（构建失败原因常在尾部）', () => {
    const notice = formatBackgroundTaskNotice(
      makeTask('HEAD_MARKER' + 'y'.repeat(60_000) + 'TAIL_MARKER'),
    );
    expect(notice).toContain('HEAD_MARKER');
    expect(notice).toContain('TAIL_MARKER');
  });

  it('来源标记显式（系统事件，不能让 LLM 误认成用户发言）', () => {
    expect(formatBackgroundTaskNotice(makeTask('ok'))).toContain('[后台命令完成]');
    expect(formatBackgroundTaskNotice(makeTask('ok', 'killed'))).toContain('[后台命令已终止]');
  });

  it('被终止态不谎报执行失败 / 不声称退出码', () => {
    const task = makeTask('partial', 'killed');
    task.result!.exitCode = -1; // peek 快照：-1 意为「尚未退出」
    const notice = formatBackgroundTaskNotice(task);
    expect(notice).not.toContain('[COMMAND_ERROR]');
    expect(notice).not.toContain('退出码');
  });

  // 词表是宿主 UI 的唯一来源（宿主禁自建第二套）——键集与文案都必须钉死，
  // 否则 UI 出现「状态无对应文案」的空标签（Record 穷尽只保证编译期，这里锁运行期）。
  it('BACKGROUND_TASK_STATUS_LABELS 覆盖全部四态且文案非空', () => {
    expect(Object.keys(BACKGROUND_TASK_STATUS_LABELS).sort()).toEqual([
      'completed',
      'killed',
      'running',
      'timedOut',
    ]);
    for (const label of Object.values(BACKGROUND_TASK_STATUS_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('回流通知用同一词表（改词表即改通知，无第二套文案）', () => {
    const notice = formatBackgroundTaskNotice(makeTask('ok', 'timedOut'));
    expect(notice).toContain(BACKGROUND_TASK_STATUS_LABELS.timedOut);
  });
});
