/**
 * 会话 → Agent 实例登记表（6.0.0 E4）
 *
 * 职责 = 「一会话一 Agent」的唯一登记面：按键复用、在途去重、注销、close 后重建。
 * 装配细节（vscode 配置 / Provider / 目录）不进本类——由宿主注入 `SessionAgentFactory`。
 *
 * 现状（E4 批 2）：`createAgentForSession` 已是**生产唯一取用面**——面板工厂、命令、
 * 设置面板、信任门补注入、配置热更全部经本表；单实例 `agentPromise` 已删除。
 * `unregister` 的生产调用点 = 删除会话时回收该会话实例（面板 `deleteSession` 路径）。
 *
 * 🔴 硬约束（E3 实证，见台账 `ROUNDSIDX-SHARED-1`）：多 Agent 必须共享**同一**
 * `sessionStore` / `roundStore` 单例。两个实例各建一份 `roundStore` 时，`rounds/index.json`
 * 的整份覆盖写会让另一实例写入的轮次「文件在、视图不可见」。故本类构造参数**强制**传入
 * 该对单例（`ProjectStoreSingletons`），并原样交给工厂；登记表自身**不自建任何存储**——
 * 这条约束写在类型上，不靠注释提醒。
 */
import type { Agent, IRoundStore, ISessionStore } from '@zooique/memora';

/** 共享存储单例对（构造登记表时强制传入，杜绝每个 Agent 各建一份） */
export interface ProjectStoreSingletons {
  /** 会话存储单例（UI 面板与所有 Agent 共享） */
  readonly sessionStore: ISessionStore;
  /** 问答闭环存储单例（UI 视图加载器与所有 Agent 共享） */
  readonly roundStore: IRoundStore;
}

/**
 * 会话 Agent 装配函数（宿主注入）
 *
 * 只负责「怎样装出一个属于该会话的实例」；登记/复用/在途去重归登记表。
 * 实现约定：必须使用传入的共享存储单例（记忆存储亦须由宿主单例注入），
 * 且返回的实例必须真正绑定到 `sessionId`（工作记忆 = 该会话历史）。
 */
export type SessionAgentFactory = (
  sessionId: string,
  stores: ProjectStoreSingletons,
) => Promise<Agent>;

/** 触发「换新实例」的外部状态变更源（旧实例把该状态作为构造期快照持有，无法原地更新） */
export type RebuildSource = 'workspace-trust';

/** 会话 → Agent 实例登记表 */
export class AgentRegistry {
  /** 共享存储单例（构造期保存，原样交给工厂；登记表自身不消费存储方法） */
  readonly stores: ProjectStoreSingletons;

  /** 装配函数（宿主注入；登记表不认识 vscode 配置与装配细节） */
  private readonly factory: SessionAgentFactory;

  /** 登记表本体：sessionId → Agent */
  private readonly agents = new Map<string, Agent>();

  /** 在途创建：同会话并发取用时复用同一 Promise，避免建出两个实例 */
  private readonly inflight = new Map<string, Promise<Agent>>();

  /** 停用标志（fail-closed）：置位后拒绝一切登记与装配，在途装配 resolve 后立即关闭 */
  private disposed = false;

  /**
   * 待重建标记：sessionId → 触发源
   *
   * 用于「构造期快照类外部状态」发生变化（如工作区信任被授予）——旧实例的
   * `workspaceTrusted` 是装配时快照，原地改不了，必须换实例。**不在监听器里立即
   * close**（面板可能正在用），改为标记 + 在下次取用（`createAgentForSession`）时重建；
   * 忙碌会话自动顺延（标记保留），无需「轮末钩子」——下一次取用本就发生在上一轮之后。
   */
  private readonly pendingRebuilds = new Map<string, RebuildSource>();

  /**
   * @param stores 共享存储单例对（必传；类型上强制，防止各 Agent 自建一份）
   * @param factory 会话 Agent 装配函数（必传；缺它本类就无法兑现 createAgentForSession）
   */
  constructor(stores: ProjectStoreSingletons, factory: SessionAgentFactory) {
    this.stores = stores;
    this.factory = factory;
  }

  /**
   * 登记会话 → Agent（同会话重复登记即替换：会话重建时应换新实例而非并存）
   *
   * @param sessionId 会话标识（内核 `MessageHistory.currentSessionName` 口径）
   * @param agent 该会话的 Agent 实例
   */
  register(sessionId: string, agent: Agent): void {
    // fail-closed：停用后拒绝登记（否则「清表后迟到的改键/补登记」会让表重新长出来）
    if (this.disposed) throw new Error('AgentRegistry 已停用：拒绝登记');
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
   * 列出现已登记的全部实例（快照）
   *
   * 用途 = 对所有已装配实例执行同一动作（配置热更 / 信任门补注入 / 停用收口）：
   * 取用面已是「一会话一实例」，宿主不得再靠单例引用假设「只有一个 Agent」。
   *
   * @returns 实例快照（遍历期间增删不影响本次遍历）
   */
  list(): Agent[] {
    return this.listEntries().map((entry) => entry.agent);
  }

  /**
   * 列出现已登记实例及其会话 id（快照）
   *
   * 与 `list()` 同源（后者由本方法派生，不另遍历一次）：需要「按会话汇报广播结果」的动作
   * 必须拿到 id——否则失败只能报下标，用户不知道哪条会话没生效（组队广播的成功/失败汇总即此）。
   */
  listEntries(): { sessionId: string; agent: Agent }[] {
    return [...this.agents.entries()].map(([sessionId, agent]) => ({ sessionId, agent }));
  }

  /**
   * 注销登记（调用方负责随后 `agent.close()`；本类不碰实例生命周期）
   *
   * 生产调用点 = 面板删除会话时回收该会话实例（`chatPanel.deleteSession`）。
   *
   * @param sessionId 会话标识
   */
  unregister(sessionId: string): void {
    this.agents.delete(sessionId);
  }

  /**
   * 停用登记表（fail-closed 收口）
   *
   * 置位后 `register` / `createAgentForSession` 一律拒绝（不返回实例、不入表）；
   * 在途装配无法撤回，resolve 后**立即 close 且不登记**——防「deactivate 期间迟到的装配」
   * 往已清空但还活着的表里登记（换 close / 清表的**顺序**拦不住，只有状态位拦得住）。
   */
  dispose(): void {
    this.disposed = true;
    this.agents.clear();
    this.inflight.clear();
    this.pendingRebuilds.clear();
  }

  /**
   * 标记「该会话下次取用时重建」
   *
   * 只写标记、不碰实例：立即 close 会让面板手中的活实例变成僵尸。
   *
   * @param sessionId 会话标识
   * @param source 触发源（仅用于日志/排查，不参与判定）
   */
  markRebuildPending(sessionId: string, source: RebuildSource): void {
    this.pendingRebuilds.set(sessionId, source);
  }

  /**
   * 全量标记「所有已登记会话下次取用时重建」（工作区信任这类全局外部状态）
   *
   * @param source 触发源
   * @returns 标记的会话数（供宿主写可见记录）
   */
  markAllRebuildPending(source: RebuildSource): number {
    for (const sessionId of this.agents.keys()) {
      this.pendingRebuilds.set(sessionId, source);
    }
    return this.agents.size;
  }

  /**
   * 取得（必要时创建）该会话的 Agent 实例
   *
   * 三种命中路径（判据独立）：
   * 1. 已登记 → 直接返回同一实例（不是每调一次新建）；
   * 2. 创建在途 → 返回同一 Promise（并发两次只建一个）；
   * 3. 未登记 → 调工厂装配并登记。
   *
   * 工厂失败不登记、不留脏 Promise，下一次调用可重试。
   *
   * @param sessionId 会话标识（内核 `MessageHistory.currentSessionName` 口径）
   * @returns 属于该会话的 Agent 实例
   */
  async createAgentForSession(sessionId: string): Promise<Agent> {
    // fail-closed：停用后拒绝装配（调用方拿到拒绝，而不是一台已关闭的实例）
    if (this.disposed) throw new Error('AgentRegistry 已停用：拒绝装配');

    const existing = this.agents.get(sessionId);
    if (existing) {
      // 带待重建标记的命中：换实例（旧实例把外部状态当构造期快照持有）
      if (!this.pendingRebuilds.has(sessionId)) return existing;
      // 在途创建 ⇒ 顺延到该 Promise（标记保留，待其完成后再下一次取用重建）
      const pendingCreate = this.inflight.get(sessionId);
      if (pendingCreate) return pendingCreate;
      // 忙碌 ⇒ 顺延（标记保留；下一次取用发生在上一轮之后，天然满足「收尾补执行」）
      if (existing.isBusy) return existing;
      this.pendingRebuilds.delete(sessionId);
      this.agents.delete(sessionId);
      // 先摘出登记表再 close：反序会让「等待期内的取用」拿到正在关闭的实例
      await existing.close().catch(() => undefined);
      // 落到下方「未登记」路径完成重建
    } else if (this.pendingRebuilds.has(sessionId)) {
      // 实例已不在表里（已注销）：标记无意义，清掉避免残留
      this.pendingRebuilds.delete(sessionId);
    }

    const pending = this.inflight.get(sessionId);
    if (pending) return pending;

    const created = this.factory(sessionId, this.stores)
      .then(async (agent) => {
        // 停用后迟到的装配：立即关闭、不入表，并把失败回给调用方（fail-closed）
        if (this.disposed) {
          await agent.close().catch(() => undefined);
          throw new Error('AgentRegistry 已停用：在途装配已关闭');
        }
        // 装配成功才登记：失败路径不得留下半成品
        this.agents.set(sessionId, agent);
        return agent;
      })
      .finally(() => {
        // 无论成败都清在途标记：失败后允许下一次重试
        this.inflight.delete(sessionId);
      });
    this.inflight.set(sessionId, created);
    return created;
  }
}
