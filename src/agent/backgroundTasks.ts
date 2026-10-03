/**
 * 后台命令任务注册表（方案文档 §14 · 阶段 1）
 *
 * 职责单点：后台进程的**身份与生命周期**——`taskId` 寻址、完成回调、中途终止、终态收割。
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

/** 完成监听器：任务到达终局时回调**一次**（loop 借此入回流队列） */
export type BackgroundTaskListener = (task: BackgroundTask) => void;

/** 任务表内部条目（= 投影 + 进程句柄） */
interface TaskEntry extends BackgroundTask {
  killNow: () => void;
  peek: () => ScriptExecutionResult;
}

export class BackgroundTaskRegistry {
  /** taskId → 条目；插入顺序 = 启动顺序 */
  private readonly tasks = new Map<string, TaskEntry>();
  /** taskId 序号（实例内自增，跨会话不冲突） */
  private seq = 0;
  /** 完成监听（未注入 → 完成仅入表，不回流；不因缺监听而报错） */
  private listener: BackgroundTaskListener | null = null;

  /**
   * 注入完成监听器（单点 setter）
   *
   * 监听器抛错**吞掉并记日志**：它是回流通道的入口，一抛就污染进程治理路径，
   * 而任务表状态与进程收割不应受消费方失败影响。
   */
  setCompletionListener(listener: BackgroundTaskListener | null): void {
    this.listener = listener;
  }

  /**
   * 启动后台命令（**立即返回** taskId，不等进程结束）
   *
   * @param command 裸命令
   * @param cwd 工作目录
   * @param timeoutMs 收割时限（毫秒）；**省略 = 不限时**，生命周期随 turn
   *        （长构建/冷缓存安装是后台核心场景，不给它套同步上限）
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
      // 先取快照再杀：杀完 stdio 关闭，此后拿不到已捕获内容
      entry.result = entry.peek();
      entry.killNow();
      entry.status = 'killed';
      // ⚠️ 主动 kill **不回调** listener：输出已由 kill_command 直接返回，
      // 再回流一次会让 LLM 收到同一份结果的第二份副本（重复消费）。
    }
    return { status: entry.status, result: entry.result };
  }

  /**
   * turn 终态收割：强杀**所有存活**任务（走杀树原语）
   *
   * @returns 被收割的任务清单（供收尾报告）；已终态的不重复收割
   */
  reapAll(): BackgroundTask[] {
    const reaped: BackgroundTask[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.status !== 'running') continue;
      entry.result = entry.peek();
      entry.killNow();
      entry.status = 'killed';
      reaped.push(this.projection(entry));
    }
    return reaped;
  }

  // ── 内部 ──

  /** 终局结算（由 startBackgroundCommand 的 onSettled 调用；只处理 running 态） */
  private settle(taskId: string, result: ScriptExecutionResult): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    // 已终态（多为 kill 先行标记）不覆盖：主动终止的语义优先于进程退出
    if (entry.status !== 'running') return;
    entry.result = result;
    entry.status = result.timedOut ? 'timedOut' : 'completed';
    this.notify(entry);
  }

  private notify(entry: TaskEntry): void {
    if (!this.listener) return;
    try {
      this.listener(this.projection(entry));
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
 * 超时文案不编造秒数：注册表不存时限，缺省即不限时（§13.6-C）。
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
