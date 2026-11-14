/**
 * 会话运行模式运行时容器（托管模式 v0 · 路线 §14.21.4「甲案」）
 *
 * 职责边界：
 * - **唯一真源 = 本容器里的 `Map<sid, mode>`**：只回答「本会话这一次装配按什么身份」，
 *   不落盘、不进 `SessionMeta`。
 * - 未知 sid 一律回落 `'self'`；重启 / 重开窗口后容器为空 ⇒ 存量会话按自助装配。
 * - `globalState` 里的「上次模式」只作**新建会话的默认值输入**，不描述任何存量会话。
 *
 * ⚠️ 设计允许的张力（不要当 bug 修）：
 * `mode` **不落盘**，重启回落 `'self'`；而 `SessionMeta.origin` / `Round.origin` 是**持久事实**。
 * 托管会话重启后不再以主控身份运行，但历史会话 / 历史轮仍然标记为 `'hosted'`。
 * 两者刻意不同步：mode 是装配期状态，origin 是来源归属。
 */

import type { Memento } from 'vscode';

/** 会话运行模式：`self` = 用户自助；`managed` = 主控（托管）装配 */
export type SessionMode = 'self' | 'managed';

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

  constructor(private readonly globalState: Memento) {}

  /** 读取某会话的装配模式；未知会话一律 `'self'`（不猜、不从「上次模式」回填） */
  get(sessionId: string): SessionMode {
    return this.modes.get(sessionId) ?? 'self';
  }

  /** 该会话本轮装配是否为主控（装配链唯一消费口） */
  isManaged(sessionId: string): boolean {
    return this.get(sessionId) === 'managed';
  }

  /** 登记会话模式（新建会话 / 切换时写；仅进程内有效） */
  set(sessionId: string, mode: SessionMode): void {
    this.modes.set(sessionId, mode);
  }

  /** 会话删除时清理，避免容器随已删会话累积 */
  delete(sessionId: string): void {
    this.modes.delete(sessionId);
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
