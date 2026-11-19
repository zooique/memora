/**
 * 助手会话身份容器（唯一身份真源 = 工作区指针）
 *
 * 职责边界：
 * - **身份真源 = `assistantSession.ts` 的工作区指针**：`isManaged(sid)` 只回答「这条是不是助手
 *   会话」。指针持久（workspaceState），故重启后侧栏先打开助手会话、助手窗没开，它照样按助手装配。
 * - **当前驱动权真源 = 盘上轮记录**：`isAgentDrivenFailClosed` 按 `SessionMeta.origin` +
 *   最近轮 `Round.origin` 判，重启仍在；停止 / 清单 / 通知三处注入点共用。
 * - `agentDriven` 只作**本进程事件标签**（本进程代理建 / 派活的会话 ⇒ 工作台座位档 `live`），
 *   不承担身份或驱动权判定；不落盘，重启回落空集 = 「重启后按历史重建」的语义。
 * - `labels` 只作**事件来源标签**（工作台要说「本进程登记过」），不承担身份判定；
 *   未知 sid 一律回落 `'self'`。
 *
 * ⚠️ 设计允许的张力（不要当 bug 修）：
 * 事件标签不落盘，重启回落空集；而 `SessionMeta.origin` / `Round.origin` 是**持久事实**。
 * 装配期身份（指针）与出生归属（origin）是两回事，刻意不同步。
 */

import type { Memento } from 'vscode';
import {
  clearAssistantSessionId,
  readAssistantSessionId,
  writeAssistantSessionId,
} from './assistantSession.js';

/**
 * 会话运行模式：`self` = 普通会话；`managed` = **助手会话**
 *
 * ⚠️ `managed` 只代表「这条是唯一的助手会话（有调度权）」，不代表「它是代理开的」。
 * 代理开出的工作会话按 `self` 装配（拿不到主控工具集，不能再层层开会话），
 * 「代理开的」只记在持久来源 `SessionMeta.origin = 'hosted'`（出生事实，不当权限用）。
 */
export type SessionMode = 'self' | 'managed';

/**
 * 会话身份容器
 *
 * 进程内单例（activate 内创建一次），身份读同一份工作区指针；不做跨窗口同步。
 */
export class SessionModeStore {
  /**
   * 身份的事件来源标签（**不承担身份判定**，身份只看指针）
   *
   * 用途：区分「本进程显式登记过」与「本进程第一次见」的事件分档。
   * 身份判据一律 `isManaged`（读指针），不从本表反推。
   */
  private readonly labels = new Map<string, SessionMode>();

  /** 本进程内代理建立 / 接管的会话 id（工作台座位档 `live` 的事件标签；非驱动权判据） */
  private readonly agentDriven = new Set<string>();

  /**
   * 本进程**启动时**从工作区指针恢复的助手会话（事件来源标签，不是权限来源）
   *
   * 用途：工作台区分「指针恢复来的助手会话」与「用户本次刚设的」。
   * 生命周期：`set()` 任何显式登记即清除（那一刻起它不再是「恢复来的」）；删除会话一并清除。
   */
  private readonly restored = new Set<string>();

  constructor(private readonly workspaceState: Memento) {
    // 启动即读一次指针，仅用于「恢复」事件标签；身份判定本身每次都现读指针（单一真源）
    const persisted = readAssistantSessionId(workspaceState);
    if (persisted) this.restored.add(persisted);
  }

  /** 读取某会话的装配模式；非助手会话一律 `'self'` */
  get(sessionId: string): SessionMode {
    return this.isManaged(sessionId) ? 'managed' : 'self';
  }

  /**
   * 该会话是否是助手会话（装配链唯一消费口）
   *
   * 判据 = 工作区指针（唯一身份真源）。指针为空 / 别的 id ⇒ false，不猜、不从标签表回填。
   */
  isManaged(sessionId: string): boolean {
    return sessionId.length > 0 && readAssistantSessionId(this.workspaceState) === sessionId;
  }

  /** 本进程内该会话是否由代理建立 / 派活（工作台座位档事件标签；驱动权判据在 `sessionStatus`） */
  isAgentDriven(sessionId: string): boolean {
    return this.agentDriven.has(sessionId);
  }

  /** 登记「本进程内代理建立 / 派活了这条会话」（工作台座位档事件标签；驱动权另读盘） */
  markAgentDriven(sessionId: string): void {
    this.agentDriven.add(sessionId);
  }

  /**
   * 列出助手会话 id（只读同一份指针，不新增状态）
   *
   * @returns 助手会话 id 列表（无助手会话时为空数组）
   */
  listManagedSessionIds(): string[] {
    const assistantId = readAssistantSessionId(this.workspaceState);
    return assistantId ? [assistantId] : [];
  }

  /**
   * 本进程是否**登记过**这条会话的身份标签（只读 `labels`，不新增状态）
   *
   * 与 `get()` 的差别：`get()` 对未知会话回落 `'self'`，无法区分「本进程显式改成 self」与
   * 「本进程从没见过它」。事件分档据此说话。
   */
  has(sessionId: string): boolean {
    return this.labels.has(sessionId);
  }

  /**
   * 登记会话身份（新建会话时写）
   *
   * `managed` ⇒ 写助手会话指针（同一时刻只有一个，覆盖即换助手会话）；
   * `self` ⇒ 若它当前正是指针指向的助手会话则清指针。
   */
  set(sessionId: string, mode: SessionMode): void {
    this.labels.set(sessionId, mode);
    // 用户显式登记 ⇒ 它不再是「启动恢复来的」
    this.restored.delete(sessionId);
    if (mode === 'managed') {
      writeAssistantSessionId(this.workspaceState, sessionId);
    } else if (this.isManaged(sessionId)) {
      clearAssistantSessionId(this.workspaceState);
    }
  }

  /** 该会话是否由本进程启动时从指针恢复（工作台文案的事件来源档） */
  isRestored(sessionId: string): boolean {
    return this.restored.has(sessionId);
  }

  /** 会话删除时清理：标签 / 事件标签 / 恢复标记，以及指向它的助手指针 */
  delete(sessionId: string): void {
    this.labels.delete(sessionId);
    this.agentDriven.delete(sessionId);
    this.restored.delete(sessionId);
    if (this.isManaged(sessionId)) clearAssistantSessionId(this.workspaceState);
  }
}

/** 进程内 Memento：未注入工作区持久层时（测试 / 嵌入宿主）的默认持久层，不跨重启 */
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
 * 进程内默认容器（仅用于未注入 workspaceState 的宿主 / 测试）
 *
 * 生产 activate 必须注入 `context.workspaceState`（指针跨重启有效）。
 */
export function createEphemeralSessionModeStore(): SessionModeStore {
  return new SessionModeStore(new EphemeralMemento());
}
