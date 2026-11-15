/**
 * 会话运行模式运行时容器（托管模式 v0 · 路线 §14.21.4「甲案」）
 *
 * 职责边界：
 * - **装配身份真源 = 本容器里的 `Map<sid, mode>`**：只回答「本会话这一次装配按什么身份」，
 *   不落盘、不进 `SessionMeta`。
 * - **当前驱动权真源 = `agentDriven` 集合**：只回答「这条会话现在是否由代理驱动」，
 *   与装配身份分开——代理开出的子会话没有调度权（mode = self），但当前仍由代理驱动；
 *   用户收回后从集合移除。停止 / 暂停 / 恢复、工作台清单、中断通知都只认这一个判断。
 *   确认代批问的不是「开了谁」而是「这一轮谁在支配」⇒ 用组合判据 `isAgentControlled`
 *   （托管座位 ∪ 本集合），边界见该方法注释；两套判据刻意分开，不互相顶替。
 * - 未知 sid 一律回落 `'self'`；重启 / 重开窗口后容器为空 ⇒ 存量会话按自助装配。
 * - `globalState` 里的「上次模式」只作**新建会话的默认值输入**，不描述任何存量会话。
 *
 * ⚠️ 设计允许的张力（不要当 bug 修）：
 * `mode` / `agentDriven` **不落盘**，重启回落 `'self'` / 空集；而 `SessionMeta.origin` /
 * `Round.origin` 是**持久事实**。托管会话重启后不再以主控身份运行，但历史会话 / 历史轮
 * 仍然标记为 `'hosted'`。两者刻意不同步：装配期状态与出生归属是两回事。
 */

import type { Memento } from 'vscode';

/**
 * 会话运行模式：`self` = 用户自助；`managed` = **用户亲自选择的**托管装配
 *
 * ⚠️ `managed` 只代表「这一条会话有调度权（主控工具面）」，不代表「它是代理开的」。
 * 代理开出的子会话按 `self` 装配（拿不到主控工具集，不能再层层开会话），
 * 「代理开的」只记在持久来源 `SessionMeta.origin = 'hosted'`（出生事实，不当权限用）。
 */
export type SessionMode = 'self' | 'managed';

/**
 * mode → 持久来源（`Round.origin` / `SessionMeta.origin`）
 *
 * 只有 `managed` 产生的会话 / 输入才标记 `'hosted'`；`self` 与缺省一律 `'user'`。
 * 这是 mode → origin 的**唯一映射点**：调用方不得各写一份三元表达式（防两处判据漂移）。
 *
 * ⚠️ 唯一例外是「代理开出的子会话」：它按 `self` 装配（没有调度权），但出生来源仍是
 * `'hosted'`。该来源由建会话参数显式传入（见 `createSession` 的 `agentCreated`），
 * 不走本函数——这不是第二个映射点，而是「调度权」与「出生事实」分家的落点。
 */
export function originForMode(mode: SessionMode): 'user' | 'hosted' {
  return mode === 'managed' ? 'hosted' : 'user';
}

/** 用户级「上次使用的模式」在 globalState 里的键（只作新建会话默认值） */
export const LAST_SESSION_MODE_KEY = 'memora.lastSessionMode';

/**
 * 会话级 mode 容器 + 用户级「上次模式」
 *
 * 进程内单例（activate 内创建一次），按会话 id 寻址；不做落盘、不做跨窗口同步。
 */
export class SessionModeStore {
  /** 会话 id → mode（运行期唯一真源；缺失 = `'self'`） */
  private readonly modes = new Map<string, SessionMode>();

  /**
   * 当前由代理驱动的会话 id（代理开出的子会话；收回即移除）
   *
   * 与 `modes` 分开：`managed` 回答「有调度权吗」，本集合回答「现在归谁驱动」。
   * 出生来源（`SessionMeta.origin` / 创建者账本）只做出生记录，不当权限用。
   */
  private readonly agentDriven = new Set<string>();

  constructor(private readonly globalState: Memento) {}

  /** 读取某会话的装配模式；未知会话一律 `'self'`（不猜、不从「上次模式」回填） */
  get(sessionId: string): SessionMode {
    return this.modes.get(sessionId) ?? 'self';
  }

  /** 该会话本轮装配是否为主控（装配链唯一消费口） */
  isManaged(sessionId: string): boolean {
    return this.get(sessionId) === 'managed';
  }

  /**
   * 该会话当前是否由代理驱动（停止 / 暂停 / 恢复、工作台清单、中断通知的唯一判据）
   *
   * @param sessionId 目标会话
   * @returns true = 代理现在可以操作它；false = 用户自己建的或已被用户收回
   */
  isAgentDriven(sessionId: string): boolean {
    return this.agentDriven.has(sessionId);
  }

  /**
   * 该会话当前是否归代理（= 托管装配（有调度权）或由代理驱动）
   *
   * 为什么单独一个方法：确认请求的代批判据问的是「这一轮是谁在支配」——用户亲自选的托管座位
   * 由代理代写提示词、代批确认；代理开出 / 派发接管的会话同样归代理。两个集合各自回答
   * 不同问题（`isManaged` = 有调度权，`isAgentDriven` = 代理开出 / 接管），组合判据只此一处，
   * 避免各消费点手写 `||` 后漂移。
   *
   * 边界：停止 / 暂停 / 恢复的目标判据仍是 `isAgentDriven`——托管座位是用户自己开的，
   * 不因为「归代理」就允许别的代理去停它。
   *
   * @param sessionId 目标会话
   * @returns true = 当前由代理支配（含托管座位）
   */
  isAgentControlled(sessionId: string): boolean {
    return this.isManaged(sessionId) || this.isAgentDriven(sessionId);
  }

  /**
   * 登记「代理创建了这条会话 ⇒ 当前由代理驱动」
   *
   * 与 `set(sessionId, 'self')` 同批发生：子会话没有调度权，但仍由代理驱动。
   * 必须在首轮流启动之前调用（首轮可能立即失败 / 被停，晚登记会漏掉中断通知）。
   *
   * @param sessionId 代理开的子会话
   */
  markAgentDriven(sessionId: string): void {
    this.agentDriven.add(sessionId);
  }

  /**
   * 收回驱动权（用户点「收回托管」后当前归用户）
   *
   * 只清运行期事实，不动 `SessionMeta.origin` / 历史轮：出生记录永久保留。
   *
   * @param sessionId 被收回的会话
   */
  clearAgentDriven(sessionId: string): void {
    this.agentDriven.delete(sessionId);
  }

  /**
   * 列出本进程内**有调度权**的会话 id（= 用户亲自选择的托管会话）
   *
   * 只读同一条 `Map`（不新增状态、不落盘）：工作台的命令入口用它决定「打开哪一条座位」。
   * 代理开出的子会话按 `self` 装配（见类型注释），因此不会出现在这里——
   * 嵌套开会话被工具面缺席挡住，不需要深度闸 / 父字段 / 层级树。
   *
   * @returns 托管会话 id 列表（按登记顺序；无托管会话时为空数组）
   */
  listManagedSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sessionId, mode] of this.modes) {
      if (mode === 'managed') ids.push(sessionId);
    }
    return ids;
  }

  /**
   * 本进程是否**登记过**这条会话的装配模式（只读 `modes`，不新增状态）
   *
   * 与 `get()` 的差别：`get()` 对未知会话回落 `'self'`，无法区分「用户收回成 self」与
   * 「本进程从没见过它」。工作台据此按**事件来源**分档说话：
   * - 登记过 + 当前不归代理 ⇒ 座位被**收回**（不能写成「重启后重建」）；
   * - 从没登记过 ⇒ 典型 = 重开窗口后按历史重建。
   *
   * @param sessionId 目标会话
   * @returns true = 本进程写过它的 mode（无论写的是 self 还是 managed）
   */
  has(sessionId: string): boolean {
    return this.modes.has(sessionId);
  }

  /** 登记会话模式（新建会话 / 切换时写；仅进程内有效） */
  set(sessionId: string, mode: SessionMode): void {
    this.modes.set(sessionId, mode);
  }

  /** 会话删除时清理，避免容器随已删会话累积 */
  delete(sessionId: string): void {
    this.modes.delete(sessionId);
    this.agentDriven.delete(sessionId);
  }

  /**
   * 读取用户级「上次使用的模式」——**只**给新建会话取默认值
   *
   * 非法 / 缺失值一律回落 `'self'`（不把脏数据当托管指令）。
   */
  getLastMode(): SessionMode {
    return this.globalState.get<SessionMode>(LAST_SESSION_MODE_KEY) === 'managed'
      ? 'managed'
      : 'self';
  }

  /** 记录用户最近一次新建会话时选择的模式（下一次新建的默认值来源） */
  async setLastMode(mode: SessionMode): Promise<void> {
    await this.globalState.update(LAST_SESSION_MODE_KEY, mode);
  }
}

/** 进程内 Memento：未注入 globalState 时（测试 / 嵌入宿主）的默认持久层，不跨重启 */
class EphemeralMemento implements Memento {
  private readonly data = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.data.keys()];
  }

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

/**
 * 进程内默认容器（仅用于未注入 globalState 的宿主 / 测试）
 *
 * 语义与生产一致（Map 不落盘），差别只有「上次模式」不跨重启——mode 本来就不持久；
 * 生产 activate 必须注入基于 `context.globalState` 的实例。
 */
export function createEphemeralSessionModeStore(): SessionModeStore {
  return new SessionModeStore(new EphemeralMemento());
}
