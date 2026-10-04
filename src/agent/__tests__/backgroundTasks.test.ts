/**
 * backgroundTasks.test.ts — 后台命令任务注册表（方案文档 §14 · 阶段 1）
 *
 * 覆盖范围：
 *   1. start 立即返回 taskId（不阻塞）+ running 态可查
 *   2. 完成 → 回调一次 + completed 态 + 结果可读
 *   3. kill → 返回已捕获输出 + killed 态，且**不再回调**（防同一结果被消费两次）
 *   4. detachAll → 脱管全部存活任务（**进程继续跑**、状态仍 running），已终态不计入
 *   5. killAllRunning → 实例终态真杀全部 running（已终态不动、不回调 listener）
 *   6. 不存在的 taskId → get/kill 返回 null（非抛错）
 *   7. **实例隔离**：两个注册表互不可见（非单例——多会话不得互杀，§14.1 定案守卫）
 *   8. exit 钩子兜底（方案-后台任务跨轮存活 §4.2）——构造注册恰一个 / shutdown 注销配对、
 *      兜底同步收割行为（不回调 listener、幂等）、注销后钩子空转
 *
 * 进程治理本身（杀树 / 内存护栏）的断言在 skillScriptRunner 侧，本文件不重复。
 * ⚠️ 收尾纪律：每个用例结束时经 `shutdown()` 清理（而非裸 kill）——exit 钩子是进程级
 * 监听，注册/注销必须配对；测试不得复制「注册后不注销」的堆积模式（每文件 11+ 个
 * 同事件监听器还会触发 Node MaxListeners 告警，污染门禁输出）。
 */
import { describe, it, expect } from 'vitest';
import {
  BackgroundTaskRegistry,
  BACKGROUND_TASK_STATUS_LABELS,
  formatBackgroundTaskNotice,
  type BackgroundTask,
} from '../backgroundTasks.js';

/**
 * 跨平台长驻命令（经注册表内的 shell 派发：Windows `cmd /c`、POSIX `sh -c`）
 * 生命周期 120s：脱管/收尾靠 kill/detachAll 主动处理而非自然退出——给 gate-full
 * 全量并发下的调度抖动留余量。
 *
 * ⚠️ 引号在两个 shell 里命运相反（2026-10-04 实锤）：双引号版在 `sh -c` 下保护
 * `()` 合法；在 `cmd /c` 下引号被原样传给 node，eval 的是「字符串字面量」
 * （空表达式语句，**秒退且 exit 0 = 假活**）。无引号 function 版反之：cmd 下是
 * 单个合法 token，sh 下 `()` 属语法错误。故按平台分叉，同 resolveShellCommand。
 */
const SLEEP_CMD =
  process.platform === 'win32'
    ? 'node -e setTimeout(function(){},120000)'
    : 'node -e "setTimeout(()=>{},120000)"';
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

/** 轮询等待任务离开 running（自然终态用；裸 sleep 在全量并发下不可靠） */
async function waitForTerminal(registry: BackgroundTaskRegistry, taskId: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (registry.get(taskId)?.status !== 'running') return;
    await sleep(200);
  }
  throw new Error(`任务未按预期结束（${registry.get(taskId)?.status}）`);
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

    registry.shutdown();
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

    registry.shutdown();
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

    registry.shutdown();
  });

  it('detachAll → 脱管全部存活任务（进程继续跑，状态仍是 running）；已终态不计入', async () => {
    const registry = new BackgroundTaskRegistry();
    const a = registry.start(SLEEP_CMD);
    const b = registry.start(SLEEP_CMD);

    await waitForRunning(registry, [a, b]);

    const detached = registry.detachAll();
    expect(detached.map((t) => t.taskId).sort()).toEqual([a, b].sort());
    // ⚠️ 脱管 ≠ 终止：状态必须仍是 running
    // （变异验证：把 detachAll 改回调 killNow 即红）
    detached.forEach((t) => expect(t.status).toBe('running'));
    // 进程真的还活着：注册表仍查得到、仍可 kill 取回输出
    expect(registry.get(a)?.status).toBe('running');
    expect(registry.kill(a)?.status).toBe('killed');
    // 脱管是纯读，不改任何状态 ⇒ 再脱管仍能列出未终结的那条（b）
    expect(registry.detachAll().map((t) => t.taskId)).toEqual([b]);

    // 收尾清理（避免 120s 进程泄漏到后续用例）
    registry.shutdown();
  });

  it('killAllRunning → 实例终态真杀全部 running；已终态不动、不回调 listener', async () => {
    const registry = new BackgroundTaskRegistry();

    // ① 先起一条长驻并确认真活：waitForRunning 首检可能命中 start 的占位 running，
    //    故再留 300ms 窗口复查——饱和并发下 spawn 异步失败会在此窗口暴露为非 running
    const a = registry.start(SLEEP_CMD);
    await waitForRunning(registry, [a]);
    await sleep(300);
    if (registry.get(a)?.status !== 'running') {
      throw new Error(`前置任务未真存活（${registry.get(a)?.status}），本用例无有效断言对象`);
    }

    // ② 再造一条 killed：主动终止（错开 spawn，避免多条长驻同时起的瞬时负载）
    const d = registry.start(SLEEP_CMD);
    await waitForRunning(registry, [d]);
    registry.kill(d);
    expect(registry.get(d)?.status).toBe('killed');

    // ③ 再造一条 completed（自然终态）
    const settleCalls: BackgroundTask[] = [];
    registry.setCompletionListener((t) => settleCalls.push(t));
    const c = registry.start(ECHO_CMD);
    await waitForTerminal(registry, c);
    expect(registry.get(c)?.status).toBe('completed');

    // ④ 换装干净探针：此后只允许出现收割「不应触发」的回调（自然终态已全部发生完）
    const listenerCallsAfterSetup: BackgroundTask[] = [];
    registry.setCompletionListener((t) => listenerCallsAfterSetup.push(t));

    // ⑤ 收割：表里 running 仅 a 一条（c=completed、d=killed 都不得被碰）
    const count = registry.killAllRunning();
    expect(count).toBe(1);
    expect(registry.get(a)?.status).toBe('killed');
    // 变异验证：若收割漏 status 判据扫全表，下面两条会被覆盖成 killed
    expect(registry.get(c)?.status).toBe('completed');
    expect(registry.get(d)?.status).toBe('killed');
    // 自然完成的 c 恰好转过一次回调（前置监听期），换装后无新增
    expect(settleCalls.map((t) => t.taskId)).toEqual([c]);

    // 给 a 的进程退出事件留落定窗口：收割不得触发任何 listener 回调（主动终止不回流）
    await sleep(800);
    expect(listenerCallsAfterSetup).toHaveLength(0);

    registry.shutdown(); // 全部已终态：返回 0，仅注销 exit 钩子
  });

  it('不存在的 taskId → get/kill 返回 null（不抛错）', () => {
    const registry = new BackgroundTaskRegistry();
    expect(registry.get('bg-999')).toBeNull();
    expect(registry.kill('bg-999')).toBeNull();
    registry.shutdown();
  });

  it('两个注册表实例互不可见（非单例——多会话不得互杀，§14.1 定案守卫）', async () => {
    const sessionA = new BackgroundTaskRegistry();
    const sessionB = new BackgroundTaskRegistry();
    const taskId = sessionA.start(SLEEP_CMD);

    // 若注册表是模块级单例，下面两行就会「看得到 / 杀得掉」别的会话的进程
    expect(sessionB.get(taskId)).toBeNull();
    expect(sessionB.kill(taskId)).toBeNull();

    sessionA.shutdown();
    sessionB.shutdown();
  });

  // ── exit 钩子兜底（Agent 实例终态第二触发通路 · 方案-后台任务跨轮存活 §4.2）──
  // 真机实锤：Windows 正常关窗给扩展宿主的清理窗口仅 31ms，async close() 深处的
  // killAllRunning 跑不到 ⇒ 需要 exit 钩子同步兜底。钩子引用经 listeners 快照 diff 捕获、
  // 直接调用——不经 process.emit('exit')（会误触发同进程其他清理监听器，副作用不可控）。

  /** 构造注册表并捕获它注册的 exit 钩子引用（快照 diff，恰一个为配对正确的前提） */
  function newRegistryWithHook(): { registry: BackgroundTaskRegistry; hook: () => void } {
    const before = process.listeners('exit');
    const registry = new BackgroundTaskRegistry();
    const added = process.listeners('exit').filter((l) => !before.includes(l));
    expect(added).toHaveLength(1); // 恰注册一个：多注册 = 钩子堆积（重复收割回归）
    return { registry, hook: added[0] as () => void };
  }

  it('构造注册恰一个 exit 钩子，shutdown 注销回原数（注册/注销配对守卫）', () => {
    const countBefore = process.listenerCount('exit');
    const registry = new BackgroundTaskRegistry();
    expect(process.listenerCount('exit')).toBe(countBefore + 1);
    registry.shutdown();
    expect(process.listenerCount('exit')).toBe(countBefore);
  });

  it('进程退出钩子兜底：running 被同步收割置 killed、不回调 listener、重复触发幂等', async () => {
    const { registry, hook } = newRegistryWithHook();
    const calls: BackgroundTask[] = [];
    registry.setCompletionListener((t) => calls.push(t));

    const taskId = registry.start(SLEEP_CMD);
    await waitForRunning(registry, [taskId]);

    hook(); // 模拟进程退出兜底（真实路径：Node 退出前最后同步窗口）
    const task = registry.get(taskId);
    expect(task?.status).toBe('killed');
    expect(task?.result).toBeDefined(); // 先快照再杀（与 terminate 单点同约定）

    // 给被杀进程的退出事件留窗口：兜底收割不得触发回流回调
    await sleep(800);
    expect(calls).toHaveLength(0);

    hook(); // 幂等：表内已全终态，重复触发零副作用
    expect(registry.get(taskId)?.status).toBe('killed');
    expect(calls).toHaveLength(0);

    registry.shutdown();
  });

  it('shutdown 收割 running 并注销钩子：注销后钩子即使被残留调用也必须空转', async () => {
    const { registry, hook } = newRegistryWithHook();

    const taskId = registry.start(SLEEP_CMD);
    await waitForRunning(registry, [taskId]);

    const count = registry.shutdown();
    expect(count).toBe(1);
    expect(registry.get(taskId)?.status).toBe('killed');

    // 钩子已注销（disposed）：被残留调用（如监听器引用泄漏场景）也不得改状态、不得抛
    expect(() => hook()).not.toThrow();
    expect(registry.get(taskId)?.status).toBe('killed');
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
