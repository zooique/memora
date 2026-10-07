/**
 * 后台命令任务注册表（方案文档 §14 · 阶段 1）
 *
 * 职责单点：后台进程的**身份与生命周期**——`taskId` 寻址、完成回调、中途终止、终态结算。
 * 进程治理本身（spawn 选项 / 输出内存护栏 / 杀树）在 `skillScriptRunner`，
 * 本模块只持有句柄与状态，**不重复实现任何进程逻辑**。
 *
 * ⚠️ **实例，不是模块级单例**：单例会让多个 Agent 实例（多会话）共享同一张任务表，
 * `kill_command` 就能杀掉别的会话起的进程——与「仅可杀本 turn 本 agent 起的后台任务」
 * 定案（§14.1）直接冲突。故注册表挂在 Agent 实例上，按实例隔离。
 *
 * ⚠️ 本模块是**内核内部**模块：不进 `src/index.ts` 公出面（宿主零消费、零新增契约面）。
 */

import { logger } from '@/logging/logger.js';
import {
  formatCommandResult,
  formatKilledCommandOutput,
  startBackgroundCommand,
  normalizeBackgroundTimeoutMs,
  type ScriptExecutionResult,
} from '@/skill/skillScriptRunner.js';

/** 后台任务状态（running 为唯一中间态，其余均为终态） */
export type BackgroundTaskStatus = 'running' | 'completed' | 'timedOut' | 'killed';

/** 后台任务只读投影（供回流 / 收尾报告消费，不泄漏进程句柄） */
export interface BackgroundTask {
  taskId: string;
  command: string;
  startedAt: number;
  status: BackgroundTaskStatus;
  result?: ScriptExecutionResult;
}

/** 自然终态：进程自行跑完或超时；主动 kill 写入的 `killed` 不属此列（不走 listener） */
export type BackgroundTaskNaturalStatus = Extract<BackgroundTaskStatus, 'completed' | 'timedOut'>;

/** 自然终态投影（listener 收到的形态：状态必为 completed/timedOut，不可能是 running/killed） */
export type SettledBackgroundTask = BackgroundTask & { status: BackgroundTaskNaturalStatus };

/** 完成监听器：任务**自然终态**时回调**一次**（loop 借此入回流队列；主动 kill 不回调，见 kill） */
export type BackgroundTaskListener = (task: SettledBackgroundTask) => void;

/** 任务表内部条目（= 投影 + 进程句柄） */
interface TaskEntry extends BackgroundTask {
  /** 异步杀树（运行时收割用：kill_command / killAllRunning，有完整事件处理） */
  killNow: () => void;
  /** 同步杀树（**仅**进程退出钩子兜底用：钩子返回后 Node 即退出，异步 spawn 来不及） */
  killNowSync: () => void;
  peek: () => ScriptExecutionResult;
}

export class BackgroundTaskRegistry {
  /** taskId → 条目；插入顺序 = 启动顺序 */
  private readonly tasks = new Map<string, TaskEntry>();
  /** taskId 序号（实例内自增，跨会话不冲突） */
  private seq = 0;
  /** 完成监听（未注入 → 完成仅入表，不回流；不因缺监听而报错） */
  private listener: BackgroundTaskListener | null = null;
  /** exit 钩子是否已注销（Agent 实例终态 shutdown 后置真，钩子空转防重复收割） */
  private disposed = false;

  /** 进程退出兜底钩子（构造注册 / shutdown 注销，**配对**——防多实例钩子堆积） */
  private readonly exitHook = (): void => {
    if (this.disposed) return; // Agent.close 已收割并注销，幂等空转
    const killed = this.flushRunningSync();
    if (killed > 0) {
      logger.info({ count: killed }, '进程退出兜底：同步收割存活后台命令任务');
    }
  };

  constructor() {
    // 实例终态第二触发通路：Windows 正常关窗给扩展宿主的清理窗口实测仅 31ms，
    // async close() 深处的 killAllRunning 跑不到——exit 钩子用同步杀树在进程消失前落地
    // （定案锚：ADR-036；论证见 docs/方案-后台任务跨轮存活-20261004.md §4.2）。
    process.on('exit', this.exitHook);
  }

  /**
   * 注入完成监听器（单点 setter）
   *
   * 监听器抛错**吞掉并记日志**：它是回流通道的入口，一抛就污染进程治理路径，
   * 而任务表状态结算不应受消费方失败影响。
   */
  setCompletionListener(listener: BackgroundTaskListener | null): void {
    this.listener = listener;
  }

  /**
   * 启动后台命令（**立即返回** taskId，不等进程结束）
   *
   * @param command 裸命令
   * @param cwd 工作目录
   * @param timeoutMs 收割时限（毫秒）；**省略 = 不限时**（长构建 / 冷缓存安装 /
   *        长驻服务是后台核心场景，不给它套同步上限；活过 turn 见 detachAll）
   */
  start(command: string, cwd?: string, timeoutMs?: number): string {
    this.seq += 1;
    const taskId = `bg-${this.seq}`;
    const entry: TaskEntry = {
      taskId,
      command,
      startedAt: Date.now(),
      status: 'running',
      // 占位：startBackgroundCommand 启动即失败时回调会同步触发，句柄随后覆盖
      killNow: () => undefined,
      killNowSync: () => undefined,
      peek: () => ({ stdout: '', stderr: '', exitCode: -1, timedOut: false }),
    };
    this.tasks.set(taskId, entry);

    const handle = startBackgroundCommand(
      command,
      cwd,
      timeoutMs === undefined ? null : normalizeBackgroundTimeoutMs(timeoutMs),
      (result) => this.settle(taskId, result),
    );
    entry.killNow = handle.killNow;
    entry.killNowSync = handle.killNowSync;
    entry.peek = handle.peek;
    return taskId;
  }

  /** 按 taskId 取任务（不存在返回 null） */
  get(taskId: string): BackgroundTask | null {
    const entry = this.tasks.get(taskId);
    return entry ? this.projection(entry) : null;
  }

  /** 全部任务（含终态；供收尾报告 / UI 呈现） */
  list(): BackgroundTask[] {
    return [...this.tasks.values()].map((entry) => this.projection(entry));
  }

  /**
   * 终止后台任务，返回**截至终止时的已捕获输出**（`kill_command` 兼任「放弃并看输出」）
   *
   * @returns 任务不存在 → `null`；否则返回终态 + 结果
   */
  kill(taskId: string): { status: BackgroundTaskStatus; result?: ScriptExecutionResult } | null {
    const entry = this.tasks.get(taskId);
    if (!entry) return null;
    if (entry.status === 'running') {
      this.terminate(entry, 'async');
    }
    return { status: entry.status, result: entry.result };
  }

  /**
   * Agent 实例终态收割：**真杀全部仍在运行的任务**（仅 `Agent.close` 调用）
   *
   * 与 `detachAll` 的边界（两者各管一个生命周期终点，勿混用）：
   *   - `detachAll` = **turn 终态**：不杀，进程跨轮存活（问答闭环不是进程容器）；
   *   - `killAllRunning` = **Agent 实例终态**：杀。注册表按实例隔离是硬不变量，
   *     实例销毁后任务不可寻址（`kill_command` 找不到、UI 快照变空表），不杀只会
   *     制造无人可收的 OS 层孤儿。
   *
   * 真机依据（验收教程观察点 ⑧，2026-10-04）：完全退出 VS Code 后 `ping.exe`
   * 仍在运行而父进程（扩展宿主）已死——Windows 不回收脱离控制台的子进程，
   * Job Object 兜底在此环境不成立。
   *
   * 同 `kill` 单点约定：**不回调 listener**（实例正在关闭，回流队列已无消费方）；
   * 终态条目保留在表内（关闭流程不读它，无谓清理）。
   *
   * @returns 实际收割的 running 任务数（已终态的不计）
   */
  killAllRunning(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (entry.status !== 'running') continue;
      this.terminate(entry, 'async');
      count += 1;
    }
    return count;
  }

  /**
   * Agent 实例终态**总出口**：收割全部 running + 注销 exit 兜底钩子（仅 `Agent.close` 链路调用）
   *
   * 为什么收割之外还要注销：exit 钩子是**进程级**事件监听，注册表是**实例级**对象——
   * Agent 关闭后不注销 = 旧实例钩子残留（多实例场景堆积 + 闭包泄漏）。注销后若进程
   * 随即退出，`exitHook` 经 `disposed` 判空转——close 已杀光，钩子无事可做（幂等）。
   *
   * @returns 实际收割的 running 任务数（与 `killAllRunning` 同口径）
   */
  shutdown(): number {
    const killed = this.killAllRunning();
    this.disposed = true;
    process.removeListener('exit', this.exitHook);
    return killed;
  }

  /**
   * turn 终态**脱管**：把存活任务移出「本轮跟踪」，但**进程继续跑**
   * （定案锚：ADR-036；论证见 `docs/方案-后台任务跨轮存活-20261004.md` §三）
   *
   * 为什么不杀（勿改回强杀）：后台命令常需跨多轮存活（长构建 / 常驻服务）；turn 是问答的
   * 归档单元、不是进程容器，turn 结束就杀 = 用户没点终止的任务凭空死亡（真机实测：90 秒的
   * ping 在 turn 6.3 秒结束时被杀，UI 显示「已终止」而用户从未操作）。
   *
   * 「脱管」的实际含义 = **什么都不做**：
   *   - 不杀进程（`killNow` 不调用）⇒ 进程继续跑，输出继续被捕获
   *   - 不改 status（仍是 `running`）⇒ `list()` / UI 条照常显示「运行中」
   *   - 不清注册表条目 ⇒ 用户随时可 `kill(taskId)` 取回截至当时的输出
   *
   * 脱管窗口的边界（如实写）：
   *   - **无内核侧时限**：timeoutMs 省略时 startBackgroundCommand 收 null = 永不超时；
   *     `BACKGROUND_MAX_TIMEOUT_MS`（30min）只是「显式传值时的钳制上限」，缺省路径碰不到它。
   *   - 跨的是 turn，不是宿主寿命：**Agent 实例终态（`close` → `shutdown`）经
   *     `killAllRunning` 真杀**（注册表实例隔离，实例销毁后任务不可寻址，不杀即孤儿——
   *     观察点 ⑧ 真机实锤：父进程退出后 `ping.exe` 仍在）；close 清理窗口赶不上时由
   *     **exit 钩子同步兜底**（见构造函数）。唯一残留缺口：扩展崩溃 / 被 OS
   *     强杀时两者都来不及执行，该场景不承诺清理。
   *
   * @returns 本轮结束时仍在运行的任务清单（供脱管报告）；已终态的不计入
   */
  detachAll(): BackgroundTask[] {
    const detached: BackgroundTask[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.status !== 'running') continue;
      detached.push(this.projection(entry));
    }
    return detached;
  }

  // ── 内部 ──

  /**
   * 主动终止单点（`kill` 单个 / `killAllRunning` 实例终态收割 / exit 钩子兜底共用）：
   * 先取输出快照再杀树，随后置 `killed`。
   *
   * ⚠️ 刻意**不回调** listener：主动终止的输出已由调用方直接取得（`kill_command`
   * 返回值 / 关闭流程不需要），再回流一次会让消费方收到同一份结果的第二份副本
   * （重复消费）。自然终态的回调唯一入口是 `settle → notify`。
   *
   * @param mode 杀树原语档位，**必传**（缺省值语义 = 调用方对执行语境含糊，静默回落缺陷）：
   *   `'async'` = 异步杀树（运行时收割，有完整事件处理）；
   *   `'sync'`  = 同步杀树（**仅** exit 钩子——钩子返回后 Node 即退出，异步 spawn 来不及落地）
   */
  private terminate(entry: TaskEntry, mode: 'async' | 'sync'): void {
    // 先取快照再杀：杀完 stdio 关闭，此后拿不到已捕获内容
    entry.result = entry.peek();
    if (mode === 'sync') {
      entry.killNowSync();
    } else {
      entry.killNow();
    }
    entry.status = 'killed';
  }

  /**
   * exit 钩子的同步收割体：真杀全部 running（同步原语），逐条独立执行
   *
   * 单条杀树失败（taskkill 权限不足等）由原语内部降级 `child.kill()`，**不抛出**——
   * exit 钩子内抛错会中断监听器链，殃及后续清理；逐条循环本身就是故障隔离边界。
   *
   * @returns 实际收割的 running 任务数
   */
  private flushRunningSync(): number {
    let count = 0;
    for (const entry of this.tasks.values()) {
      if (entry.status !== 'running') continue;
      this.terminate(entry, 'sync');
      count += 1;
    }
    return count;
  }

  /** 终局结算（由 startBackgroundCommand 的 onSettled 调用；只处理 running 态） */
  private settle(taskId: string, result: ScriptExecutionResult): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    // 已终态（多为 kill 先行标记）不覆盖：主动终止的语义优先于进程退出
    if (entry.status !== 'running') return;
    entry.result = result;
    // 自然终态只有 completed/timedOut（killed 只由主动 kill 写入，永不走本路径）
    const status: BackgroundTaskNaturalStatus = result.timedOut ? 'timedOut' : 'completed';
    entry.status = status;
    this.notify(entry, status);
  }

  private notify(entry: TaskEntry, status: BackgroundTaskNaturalStatus): void {
    if (!this.listener) return;
    try {
      // 显式带上窄状态：listener 契约只传自然终态，killed 永不经此通道
      this.listener({ ...this.projection(entry), status });
    } catch (err) {
      logger.error({ taskId: entry.taskId, err }, '后台任务完成回调抛错（已吞，不影响任务表）');
    }
  }

  /** 只读投影：不泄漏 killNow/peek 等进程句柄 */
  private projection(entry: TaskEntry): BackgroundTask {
    return {
      taskId: entry.taskId,
      command: entry.command,
      startedAt: entry.startedAt,
      status: entry.status,
      ...(entry.result ? { result: entry.result } : {}),
    };
  }
}

/**
 * 后台任务状态 → 中文标签（回流通知 / 收尾报告 / **宿主 UI** 共用一个词表）
 *
 * 公开导出：宿主 UI 直接消费本表渲染状态文案，**不自建第二套**（自建即双源漂移）。
 * `Record` 穷尽键 ⇒ 新增状态忘补标签 = **编译期红闸**（同 `COMPRESS_TARGET_LABELS` 定案）。
 */
export const BACKGROUND_TASK_STATUS_LABELS: Record<BackgroundTaskStatus, string> = {
  running: '运行中',
  completed: '已完成',
  timedOut: '超时被终止',
  killed: '已终止',
};

/**
 * 后台任务终局 → 回流通知文案（**格式化单点**：loop 回流与收尾报告共用）
 *
 * 来源标记前置且显式（`[后台命令完成]`）——消费方是 LLM，必须能让它分清
 * 「这是系统事件」而非「用户刚说了什么」（role 语义隔离，§14.2）。
 * 超时文案不编造秒数：注册表不存时限，缺省即不限时（命令执行能力方案 §13.6-C）。
 */
export function formatBackgroundTaskNotice(task: BackgroundTask): string {
  const header = `[后台命令${task.status === 'killed' ? '已终止' : '完成'}] taskId=${task.taskId} · ${BACKGROUND_TASK_STATUS_LABELS[task.status]}`;
  if (!task.result) return `${header}\n命令：${task.command}\n（无已捕获输出）`;
  // killed 态走专用格式化：被主动终止没有退出码，套三态会谎报成「命令执行失败」
  const body =
    task.status === 'killed'
      ? formatKilledCommandOutput(task.result)
      : formatCommandResult(task.result);
  return `${header}\n命令：${task.command}\n${body}`;
}
