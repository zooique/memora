/**
 * 会话管理器 —— 会话操作的统一入口
 *
 * 职责：
 * - 会话创建、加载、删除
 * - 会话分叉（核心功能）
 * - Round 追加到会话
 * - 会话元数据更新
 *
 * 设计理念：
 * - 会话管理器是 Round-based 存储模式的门面
 * - 封装 SessionStore、RoundStore、SessionViewLoader 的协作
 * - 提供高层 API，隐藏底层存储细节
 */

import type { IRoundStore } from '@/memory/roundStore.js';
import type {
  ISessionStore,
  SessionMeta,
} from '@/memory/sessionStore.js';
import type {
  ISessionViewLoader,
  SessionView,
  SessionSummary,
} from '@/memory/sessionViewLoader.js';
import {
  createRoundBasedSessionMeta,
  generateForkSessionId,
} from '@/memory/sessionStore.js';
import { logger } from '@/logging/logger.js';

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

/**
 * 默认会话管理器实现
 *
 * 协作关系：
 * - SessionManager → SessionStore（持久化会话元数据和 Round ID 列表）
 * - SessionManager → RoundStore（管理 Round 的引用计数）
 * - SessionManager → SessionViewLoader（加载会话视图）
 */
export class DefaultSessionManager implements ISessionManager {
  private readonly roundStore: IRoundStore;
  private readonly sessionStore: ISessionStore;
  private readonly viewLoader: ISessionViewLoader;

  constructor(
    roundStore: IRoundStore,
    sessionStore: ISessionStore,
    viewLoader: ISessionViewLoader,
  ) {
    this.roundStore = roundStore;
    this.sessionStore = sessionStore;
    this.viewLoader = viewLoader;
  }

  /**
   * 创建新会话
   */
  createSession(sessionId: string, initialRoundIds: string[] = []): SessionMeta {
    // 检查会话是否已存在
    const existingMeta = this.getSessionMeta(sessionId);
    if (existingMeta) {
      logger.warn({ sessionId }, '会话已存在，返回现有会话');
      return existingMeta;
    }

    // 创建新的会话元数据
    const meta = createRoundBasedSessionMeta(sessionId, initialRoundIds);

    // 调用 SessionStore.createSession
    const createSessionFn = this.sessionStore.createSession;
    if (createSessionFn) {
      createSessionFn.call(this.sessionStore, meta);
    }

    // 如果有初始 Round，增加引用计数
    for (const roundId of initialRoundIds) {
      this.roundStore.incrementRef(roundId);
    }

    logger.info({ sessionId, roundCount: initialRoundIds.length }, '会话已创建');
    return meta;
  }

  /**
   * 加载会话视图
   */
  loadSession(sessionId: string): SessionView {
    return this.viewLoader.loadView(sessionId);
  }

  /**
   * 加载会话摘要
   */
  loadSessionSummary(sessionId: string): SessionSummary | null {
    return this.viewLoader.loadSummary(sessionId);
  }

  /**
   * 列出所有会话
   */
  listSessions(limit?: number): SessionSummary[] {
    // 尝试从 SessionStore 获取所有会话 ID
    const listSessionsFn = this.sessionStore.listSessions;
    let sessionIds: string[] = [];

    if (listSessionsFn) {
      sessionIds = listSessionsFn.call(this.sessionStore);
    }

    // 批量加载摘要
    let summaries = this.viewLoader.loadBatchSummaries(sessionIds);

    // 限制数量
    if (limit && limit > 0) {
      summaries = summaries.slice(0, limit);
    }

    return summaries;
  }

  /**
   * 追加 Round 到会话
   */
  appendRound(sessionId: string, roundId: string): void {
    // 检查 Round 是否存在
    const round = this.roundStore.getById(roundId);
    if (!round) {
      logger.error({ roundId }, '追加失败：Round 不存在');
      throw new Error(`Round 不存在: ${roundId}`);
    }

    // 调用 SessionStore.appendRoundId
    const appendRoundIdFn = this.sessionStore.appendRoundId;
    if (!appendRoundIdFn) {
      throw new Error('SessionStore 未实现 appendRoundId');
    }

    appendRoundIdFn.call(this.sessionStore, sessionId, roundId);

    // 增加引用计数
    this.roundStore.incrementRef(roundId);

    // 更新会话元数据
    this.updateSessionRoundCount(sessionId);

    logger.debug({ sessionId, roundId }, 'Round 已追加到会话');
  }

  /**
   * 批量追加 Round 到会话
   */
  appendRounds(sessionId: string, roundIds: string[]): void {
    if (roundIds.length === 0) return;

    // 验证所有 Round 存在
    for (const roundId of roundIds) {
      const round = this.roundStore.getById(roundId);
      if (!round) {
        throw new Error(`Round 不存在: ${roundId}`);
      }
    }

    // 调用 SessionStore.appendRoundIds
    const appendRoundIdsFn = this.sessionStore.appendRoundIds;
    if (appendRoundIdsFn) {
      appendRoundIdsFn.call(this.sessionStore, sessionId, roundIds);
    } else {
      // 降级：逐个追加
      const appendRoundIdFn = this.sessionStore.appendRoundId;
      if (appendRoundIdFn) {
        for (const roundId of roundIds) {
          appendRoundIdFn.call(this.sessionStore, sessionId, roundId);
        }
      }
    }

    // 增加引用计数
    for (const roundId of roundIds) {
      this.roundStore.incrementRef(roundId);
    }

    // 更新会话元数据
    this.updateSessionRoundCount(sessionId);

    logger.debug({ sessionId, roundCount: roundIds.length }, '批量追加 Round 完成');
  }

  /**
   * 会话分叉（核心功能）
   *
   * 流程：
   * 1. 获取源会话的 Round ID 列表
   * 2. 截断到分叉点
   * 3. 创建新会话，复制截断后的 Round ID 列表
   * 4. 增加这些 Round 的引用计数
   */
  forkSession(
    sourceSessionId: string,
    forkPointRoundId: string,
    newSessionId?: string,
  ): SessionMeta {
    // 1. 获取源会话的 Round ID 列表
    const sourceRoundIds = this.getSessionRoundIds(sourceSessionId);
    if (sourceRoundIds.length === 0) {
      throw new Error(`源会话没有 Round: ${sourceSessionId}`);
    }

    // 2. 找到分叉点位置
    const forkPointIdx = sourceRoundIds.indexOf(forkPointRoundId);
    if (forkPointIdx === -1) {
      throw new Error(`分叉点 Round 不在源会话中: ${forkPointRoundId}`);
    }

    // 3. 截断 Round ID 列表（包含分叉点）
    const forkedRoundIds = sourceRoundIds.slice(0, forkPointIdx + 1);

    // 4. 生成新会话 ID
    const targetSessionId = newSessionId || generateForkSessionId(sourceSessionId);

    // 5. 创建新会话
    const forkedMeta = this.createSession(targetSessionId, forkedRoundIds);

    // 6. 更新元数据（标记分叉来源）
    const sourceMeta = this.getSessionMeta(sourceSessionId);
    if (sourceMeta?.autoName) {
      // 复制源会话的标题
      this.updateSessionMeta(targetSessionId, {
        autoName: `${sourceMeta.autoName} (分叉)`,
      });
    }

    logger.info(
      { source: sourceSessionId, target: targetSessionId, forkPoint: forkPointRoundId },
      '会话分叉完成',
    );

    return forkedMeta;
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): boolean {
    // 1. 获取会话的 Round ID 列表
    const roundIds = this.getSessionRoundIds(sessionId);

    // 2. 减少所有 Round 的引用计数
    for (const roundId of roundIds) {
      this.roundStore.decrementRef(roundId);
    }

    // 3. 删除会话
    const deleteSessionFn = this.sessionStore.deleteSession;
    if (deleteSessionFn) {
      deleteSessionFn.call(this.sessionStore, sessionId);
    }

    // 4. 更新 SessionMeta
    this.updateSessionMeta(sessionId, {
      roundIds: [],
      messageCount: 0,
    });

    logger.info({ sessionId }, '会话已删除');
    return true;
  }

  /**
   * 更新会话标题
   */
  updateSessionTitle(sessionId: string, title: string): void {
    const setTitleFn = this.sessionStore.setSessionTitle;
    if (setTitleFn) {
      setTitleFn.call(this.sessionStore, sessionId, title);
    } else {
      // 降级：通过 updateSessionMeta 更新 displayName
      this.updateSessionMeta(sessionId, { displayName: title });
    }
  }

  /**
   * 更新会话元数据
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const updateMetaFn = this.sessionStore.updateSessionMeta;
    if (updateMetaFn) {
      updateMetaFn.call(this.sessionStore, sessionId, meta);
    }
  }

  /**
   * 获取会话的 Round ID 列表
   */
  getSessionRoundIds(sessionId: string): string[] {
    // 优先使用 getRoundIds 方法
    const getRoundIdsFn = this.sessionStore.getRoundIds;
    if (getRoundIdsFn) {
      return getRoundIdsFn.call(this.sessionStore, sessionId);
    }

    // 降级：从 SessionMeta 获取
    const meta = this.getSessionMeta(sessionId);
    if (meta?.roundIds) {
      return [...meta.roundIds];
    }

    return [];
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 获取会话元数据
   */
  private getSessionMeta(sessionId: string): SessionMeta | null {
    const getMetaFn = this.sessionStore.getSessionMeta;
    if (getMetaFn) {
      const meta = getMetaFn.call(this.sessionStore, sessionId);
      if (meta) return { ...meta };
    }

    return null;
  }

  /**
   * 更新会话的 Round 数量和消息数
   */
  private updateSessionRoundCount(sessionId: string): void {
    const meta = this.getSessionMeta(sessionId);
    if (!meta) return;

    const roundIds = this.getSessionRoundIds(sessionId);
    const newMessageCount = roundIds.length * 2; // 每个 Round 包含 User + AI

    this.updateSessionMeta(sessionId, {
      messageCount: newMessageCount,
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * 创建默认会话管理器的工厂函数
 *
 * @param roundStore - 问答闭环存储
 * @param sessionStore - 会话存储
 * @param viewLoader - 会话视图加载器
 * @returns 会话管理器实例
 */
export function createDefaultSessionManager(
  roundStore: IRoundStore,
  sessionStore: ISessionStore,
  viewLoader: ISessionViewLoader,
): DefaultSessionManager {
  return new DefaultSessionManager(roundStore, sessionStore, viewLoader);
}
