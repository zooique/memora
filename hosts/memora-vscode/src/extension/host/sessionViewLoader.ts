/**
 * 工作区会话视图加载器 — ISessionViewLoader 的宿主实现
 *
 * 设计理念：
 * - 复用内核 InMemorySessionViewLoader 的通用逻辑（仅依赖接口）
 * - 注入 WorkspaceRoundStore 和 WorkspaceSessionStore 作为底层存储
 *
 * 职责：
 * - 将 Session（Round ID 列表）+ RoundStore（物理存储）组合成完整视图（round-based 单一模式）
 */

import type {
  ISessionViewLoader,
  SessionView,
  SessionSummary,
  ISessionStore,
  IRoundStore,
} from '@zooique/memora';
import { InMemorySessionViewLoader } from '@zooique/memora';

/**
 * 工作区会话视图加载器
 *
 * 封装内核 InMemorySessionViewLoader，注入文件系统存储实现
 */
export class WorkspaceSessionViewLoader implements ISessionViewLoader {
  /** 内核提供的通用视图加载器（逻辑与存储实现解耦） */
  private readonly delegate: InMemorySessionViewLoader;

  constructor(roundStore: IRoundStore, sessionStore: ISessionStore) {
    this.delegate = new InMemorySessionViewLoader(roundStore, sessionStore);
  }

  /**
   * 加载会话的完整对话视图
   *
   * @param sessionId - 会话 ID
   * @returns 完整会话视图
   */
  loadView(sessionId: string): SessionView {
    return this.delegate.loadView(sessionId);
  }

  /**
   * 加载会话的简化摘要（用于历史列表等轻量场景）
   *
   * @param sessionId - 会话 ID
   * @returns 会话摘要，不存在返回 null
   */
  loadSummary(sessionId: string): SessionSummary | null {
    return this.delegate.loadSummary(sessionId);
  }

  /**
   * 批量加载多个会话的摘要
   *
   * @param sessionIds - 会话 ID 数组
   * @returns 会话摘要数组
   */
  loadBatchSummaries(sessionIds: string[]): SessionSummary[] {
    return this.delegate.loadBatchSummaries(sessionIds);
  }

  /**
   * 获取会话的消息数量
   *
   * @param sessionId - 会话 ID
   * @returns 消息数量
   */
  getMessageCount(sessionId: string): number {
    return this.delegate.getMessageCount(sessionId);
  }

  /**
   * 从指定 Round 位置截断会话视图
   *
   * @param sessionId - 会话 ID
   * @param upToRoundId - 截断到哪个 Round（包含）
   * @returns 截断后的会话视图
   */
  loadViewUpTo(sessionId: string, upToRoundId: string): SessionView {
    return this.delegate.loadViewUpTo(sessionId, upToRoundId);
  }
}
