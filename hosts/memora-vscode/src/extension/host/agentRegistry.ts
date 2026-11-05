/**
 * 会话 → Agent 实例登记表（6.0.0 E4 · 只登记不启用）
 *
 * 背景（B 方案 = 一会话一 Agent 实例）：E5 起需要按会话取/建 Agent，因此先把「登记表」
 * 与「共享存储单例约束」立起来。**本轮不接线**——`extension.ts` 仍只装配一个 Agent、
 * 只登记一条，不改变现有多会话共享单例的行为。
 *
 * 🔶 **处置登记**（台账 `AGENTREGISTRY-PREEMPT-1`）：本类属**预支基础设施**——当前无收益、
 * E7 前不启用；若 E7 换方案（不走「一会话一 Agent 实例」）则删除。现状事实：`unregister`
 * 本轮零调用点、`stores` 只赋不读、`createAgentForSession` 不存在；`extension.ts` 只在装配时
 * 按当时的 `currentSessionName` 登记一次，`switchToSession` 不更新 key。这些是**未接线**，
 * 不得读成「已具备按会话取 Agent 的能力」。
 *
 * 🔴 硬约束（E3 实证，见台账 `ROUNDSIDX-SHARED-1`）：多 Agent 必须共享**同一**
 * `sessionStore` / `roundStore` 单例。两个实例各建一份 `roundStore` 时，`rounds/index.json`
 * 的整份覆盖写会让另一实例写入的轮次「文件在、视图不可见」。故本类构造参数**强制**传入
 * 该对单例（`ProjectStoreSingletons`），登记表自身**不自建任何存储**——这条约束写在类型上，
 * 不靠注释提醒。若将来真需要各建一份，必须显式改成双实例形态，而不是悄悄回落。
 */
import type { Agent, IRoundStore, ISessionStore } from '@zooique/memora';

/** 共享存储单例对（构造登记表时强制传入，杜绝每个 Agent 各建一份） */
export interface ProjectStoreSingletons {
  /** 会话存储单例（UI 面板与所有 Agent 共享） */
  readonly sessionStore: ISessionStore;
  /** 问答闭环存储单例（UI 视图加载器与所有 Agent 共享） */
  readonly roundStore: IRoundStore;
}

/** 会话 → Agent 实例登记表 */
export class AgentRegistry {
  /** 共享存储单例（构造期保存；E5 按会话建 Agent 时复用。**当前只赋不读**，属预支基础设施） */
  readonly stores: ProjectStoreSingletons;

  /** 登记表本体：sessionId → Agent（E4 只有一条） */
  private readonly agents = new Map<string, Agent>();

  /**
   * @param stores 共享存储单例对（必传；类型上强制，防止各 Agent 自建一份）
   */
  constructor(stores: ProjectStoreSingletons) {
    this.stores = stores;
  }

  /**
   * 登记会话 → Agent（同会话重复登记即替换：会话重建时应换新实例而非并存）
   *
   * @param sessionId 会话标识（内核 `MessageHistory.currentSessionName` 口径）
   * @param agent 该会话的 Agent 实例
   */
  register(sessionId: string, agent: Agent): void {
    this.agents.set(sessionId, agent);
  }

  /**
   * 按会话取 Agent
   *
   * @param sessionId 会话标识
   * @returns 已登记实例；未登记/已注销为 undefined
   */
  get(sessionId: string): Agent | undefined {
    return this.agents.get(sessionId);
  }

  /**
   * 注销登记（会话关闭时调用；E5 接线，本轮无调用点）
   *
   * 零调用点 = 未接线，不是「已具备注销能力」；处置见文件头 `AGENTREGISTRY-PREEMPT-1`。
   *
   * @param sessionId 会话标识
   */
  unregister(sessionId: string): void {
    this.agents.delete(sessionId);
  }
}
