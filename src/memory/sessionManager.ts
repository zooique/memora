/**
 * 会话管理器接口
 *
 * 提供会话操作的统一 API，屏蔽底层存储实现。
 * 会话分叉的单一真理源见 `MessageHistory.forkSession()`（由 Agent 的 `SessionManager` 调用）；
 * 本接口仅为契约定义，不再提供独立的 fork 实现（避免平行分叉真理源）。
 */

import type {
  SessionMeta,
} from '@/memory/sessionStore.js';
import type {
  SessionView,
  SessionSummary,
} from '@/memory/sessionViewLoader.js';

/**
 * 会话管理器接口
 *
 * 提供会话操作的统一 API，屏蔽底层存储实现
 */
export interface ISessionManager {
  /**
   * 创建新会话
   *
   * @param sessionId - 会话 ID
   * @param initialRoundIds - 初始 Round ID 列表（可选）
   * @returns 创建的会话元数据
   */
  createSession(sessionId: string, initialRoundIds?: string[]): SessionMeta;

  /**
   * 加载会话视图
   *
   * @param sessionId - 会话 ID
   * @returns 完整会话视图
   */
  loadSession(sessionId: string): SessionView;

  /**
   * 加载会话摘要（轻量级）
   *
   * @param sessionId - 会话 ID
   * @returns 会话摘要
   */
  loadSessionSummary(sessionId: string): SessionSummary | null;

  /**
   * 列出所有会话摘要
   *
   * @param limit - 限制数量（可选）
   * @returns 会话摘要数组
   */
  listSessions(limit?: number): SessionSummary[];

  /**
   * 追加 Round 到会话
   *
   * @param sessionId - 会话 ID
   * @param roundId - 要追加的 Round ID
   */
  appendRound(sessionId: string, roundId: string): void;

  /**
   * 批量追加 Round 到会话
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 要追加的 Round ID 数组
   */
  appendRounds(sessionId: string, roundIds: string[]): void;

  /**
   * 会话分叉（核心功能）
   *
   * 从指定 Round 位置分叉会话，创建新会话：
   * 1. 复制源会话在分叉点之前的 Round ID 列表
   * 2. 增加这些 Round 的引用计数
   * 3. 创建新的 SessionMeta
   *
   * @param sourceSessionId - 源会话 ID
   * @param forkPointRoundId - 分叉点 Round ID
   * @param newSessionId - 新会话 ID（可选，自动生成）
   * @returns 分叉后的新会话元数据
   */
  forkSession(
    sourceSessionId: string,
    forkPointRoundId: string,
    newSessionId?: string,
  ): SessionMeta;

  /**
   * 删除会话
   *
   * @param sessionId - 会话 ID
   * @returns 是否删除成功
   */
  deleteSession(sessionId: string): boolean;

  /**
   * 更新会话标题
   *
   * @param sessionId - 会话 ID
   * @param title - 新标题
   */
  updateSessionTitle(sessionId: string, title: string): void;

  /**
   * 更新会话元数据
   *
   * @param sessionId - 会话 ID
   * @param meta - 要更新的元数据字段
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void;

  /**
   * 获取会话的 Round ID 列表
   *
   * @param sessionId - 会话 ID
   * @returns Round ID 数组
   */
  getSessionRoundIds(sessionId: string): string[];
}
