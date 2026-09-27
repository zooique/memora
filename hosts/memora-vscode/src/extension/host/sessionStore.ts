/**
 * 工作区会话存储 — ISessionStore 实现（JSON 文件落盘）
 *
 * 存储模型（round-based 单一模式，SSOT）：
 *   - 会话仅持有 Round ID 列表（roundIdsStore）；消息内容只存在于 RoundStore（物理真相源）
 *   - 消息读写经 roundIds → RoundStore 展开 / 成 Round 写入，绝无 legacy 扁平消息列表
 *   - 与设计文档 §3.2 对齐：SessionMeta 不含 storageMode 之类的模式标识字段
 *
 * 职责：
 *   - 将 memora 对话 Round ID 列表持久化到工作区 `.memora/sessions.json`
 *   - 实现 ISessionStore 接口，注入 Agent，让跨会话对话记录可回溯（traceSummary 依赖）
 *   - 原子写入：save() 使用 atomicWriteFileSync 防崩溃损坏
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSessionId,
  defaultSessionTitle,
  isRoundSettled,
  type IRoundStore,
  type ISessionStore,
  type Round,
  type SessionMessage,
  type SessionMeta,
} from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';
import { WorkspaceRoundStore } from './workspaceRoundStore.js';

/**
 * 截断结果（truncateFrom 返回值）：ok = 锚点命中并完成截断；
 * removedIds = 被物理删除（引用归零的孤儿）的 Round 列表，供调用方联动软删其记忆摘要（⑥）
 */
export interface RoundTruncateResult {
  ok: boolean;
  removedIds: string[];
}

/**
 * 工作区会话存储
 */
export class WorkspaceSessionStore implements ISessionStore {
  /** 会话标题元数据：sessionId → SessionMeta */
  private metas = new Map<string, SessionMeta>();
  /** Round ID 列表存储：sessionId → roundId[]（round-based 唯一真相源） */
  private roundIdsStore = new Map<string, string[]>();
  /** 问答闭环物理存储（IRoundStore 实现，文件落盘） */
  private readonly roundStore: IRoundStore;
  /** 会话文件绝对路径 */
  private readonly filePath: string;

  /**
   * @param workspacePath 工作区路径（落盘目录 `.memora`）
   * @param roundStore 问答闭环存储；缺省时在同工作区新建文件级 WorkspaceRoundStore 并 load()
   */
  constructor(workspacePath: string, roundStore?: IRoundStore) {
    this.filePath = join(workspacePath, '.memora', 'sessions.json');
    if (roundStore) {
      this.roundStore = roundStore;
    } else {
      const rs = new WorkspaceRoundStore(workspacePath);
      rs.load();
      this.roundStore = rs;
    }
  }

  /**
   * 从文件加载会话（文件不存在则空）
   *
   * 存储模型：仅 metas（标题元数据）+ roundIdsStore（Round 指针）。
   * 无检查点持久化，本文件不涉及 checkpoint。
   */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        metas: Record<string, SessionMeta>;
        roundIdsStore: Record<string, string[]>;
      };
      for (const [k, v] of Object.entries(data.metas ?? {})) this.metas.set(k, v);
      // 加载 round-based 模式的 Round ID 列表（唯一内容来源）
      for (const [k, v] of Object.entries(data.roundIdsStore ?? {})) this.roundIdsStore.set(k, v);
    } catch (err) {
      // 会话文件损坏时降级为空（不阻塞插件启动）
      console.warn('Memora 会话文件读取失败，降级为空', err);
      this.metas.clear();
      this.roundIdsStore.clear();
    }
  }

  /** 将内存原子写回文件（先写 .tmp 再 rename，防崩溃损坏） */
  private save(): void {
    const data = {
      metas: Object.fromEntries(this.metas),
      roundIdsStore: Object.fromEntries(this.roundIdsStore),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  /** 加载指定会话的完整消息列表（从 roundIds → RoundStore 展开） */
  loadMessages(date: string, session: string): SessionMessage[] {
    // 组装 sessionId（SSOT 契约 buildSessionId，date+session 双向一致）
    const sessionId = buildSessionId(date, session);
    const roundIds = this.getRoundIds(sessionId);
    if (roundIds.length === 0) return [];
    const rounds = this.roundStore.getByIds(roundIds);
    const messages: SessionMessage[] = [];
    for (const round of rounds) {
      messages.push({
        role: round.userMessage.role,
        content: round.userMessage.content,
        timestamp: round.userMessage.timestamp,
        roundId: round.id,
      });
      // 判据收口 isRoundSettled：中断轮（interrupted）同样计入——本方法是 LLM 历史注入
      // （restoreHistory）唯一上游，漏计会让中断轮回复从上下文消失（与内核
      // inMemorySessionStore.loadMessages 逐字同构，勿单侧改判据）
      if (round.assistantMessage && isRoundSettled(round.status)) {
        messages.push({
          role: round.assistantMessage.role,
          content: round.assistantMessage.content,
          timestamp: round.assistantMessage.timestamp,
          roundId: round.id,
        });
      }
    }
    return messages;
  }

  /**
   * 删除整条会话（历史浮层垃圾桶触发）：Round ID 列表 + 元数据 + 检查点。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @returns 被物理删除（引用归零）的 Round ID 列表，供调用方联动软删其记忆摘要（⑥）
   */
  deleteSession(sessionId: string): string[] {
    // 引用递减 + 物理回收：被删除会话放弃其 Round 引用后，refCount 归零的轮
    // 立即物理删除（SSOT：Round 物理生命周期归 RoundStore，引用归 SessionStore；
    // 分叉共享轮由 RoundStore.delete 内部 refCount>0 护栏安全保留）
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    const removedIds: string[] = [];
    for (const roundId of roundIds) {
      this.roundStore.decrementRef(roundId);
      // 物理删除成功（引用归零）→ 记录被回收的 Round，供调用方联动软删其记忆摘要（⑥）
      if (this.roundStore.delete(roundId)) removedIds.push(roundId);
    }
    // 清理：移除 Round ID 指针 + 元数据（物理 Round 由 RoundStore 引用计数 + GC 管理）
    this.roundIdsStore.delete(sessionId);
    this.metas.delete(sessionId);
    this.save();
    return removedIds;
  }

  /**
   * 截断指定会话（truncate-from-turn，宿主扩展方法）
   *
   * 删除【目标问答闭环及其之后所有 Round】，保证剩余上下文自洽。
   *
   * 锚点（下界匹配）：定位第一条 `assistant timestamp >= fromTs` 的 Round。
   * Round 边界即问答的 user 起点，删除该 Round 及之后。中断收场轮（appendInterrupted
   * 零产出时不写 assistantMessage，status 即 'interrupted'）不满足
   * assistant 下界匹配，故有两条折回（见实现注释）：
   * ① 锚点落在末轮 user 之后 → 锚定末轮（中断轮收尾可删）；② 命中轮的前一轮为无
   * assistant 的中断轮且锚点落其时间窗 → 上折回该中断轮（防误删下一轮）。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识
   * @param fromTs 删除按钮携带的 timestamp
   * @returns 截断结果（ok = 锚点命中并完成；removedIds = 引用归零被物理删除的 Round，供联动软删记忆摘要）
   */
  truncateFrom(date: string, session: string, fromTs: string): RoundTruncateResult {
    // 组装 sessionId（SSOT 契约 buildSessionId）
    const sessionId = buildSessionId(date, session);
    const roundIds = this.roundIdsStore.get(sessionId);
    if (!roundIds || roundIds.length === 0) return { ok: false, removedIds: [] };
    const rounds = this.roundStore.getByIds(roundIds);
    // 下界匹配：第一条 assistant 时间戳 >= fromTs 的 Round 作为截断起点（兼容流式锚点
    // 早于落盘 assistant 时间戳的既有语义）。中断轮无 assistantMessage 会被跳锚，折回见下。
    let idx = rounds.findIndex(
      (r: Round) =>
        r.assistantMessage?.timestamp !== undefined && r.assistantMessage.timestamp >= fromTs,
    );
    if (idx === -1) {
      // ① 中断轮收尾：锚点 >= 末轮 user 起点（删除按钮带 meta ts / 回填 user ts）→ 锚定末轮
      const last = rounds[rounds.length - 1];
      if (
        last &&
        last.userMessage?.timestamp !== undefined &&
        last.userMessage.timestamp <= fromTs
      ) {
        idx = rounds.length - 1;
      }
    } else if (
      idx > 0 &&
      rounds[idx].userMessage?.timestamp !== undefined &&
      fromTs < rounds[idx].userMessage.timestamp
    ) {
      // ② 中断轮居中：assistant 下界命中「下一轮」，但锚点早于命中轮 user 起点（meta 属前一轮
      // 时间窗）且前一轮恰为无 assistant 的中断轮 → 上折回该中断轮。判别条件兼防伪折叠：
      // done 轮删除锚点 = 其自身 assistant ts（恒 >= 自己 user ts）→ 不满足 fromTs < user Ts，
      // 即使前一轮也是中断轮也不误折。
      const prev = rounds[idx - 1];
      if (
        prev &&
        prev.assistantMessage === undefined &&
        prev.userMessage?.timestamp !== undefined &&
        prev.userMessage.timestamp <= fromTs
      ) {
        idx -= 1;
      }
    }
    if (idx === -1) return { ok: false, removedIds: [] };
    // 删除 [idx, 末尾) 的全部 Round（含目标问答）
    const removed = roundIds.slice(idx);
    const removedIds: string[] = [];
    for (const id of removed) {
      this.roundStore.decrementRef(id);
      if (this.roundStore.delete(id)) removedIds.push(id); // refCount 归零才真删文件；若被分叉引用则安全保留
    }
    const kept = roundIds.slice(0, idx);
    this.roundIdsStore.set(sessionId, kept);
    // 同步元数据（roundIds 真源为 roundIdsStore，读时派生；此处仅更新 messageCount）
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, { ...existing, messageCount: this.deriveMessageCount(sessionId) });
    }
    this.save();
    return { ok: true, removedIds };
  }

  listSessions(): string[] {
    // 收集 round-based 模式的会话
    const sessions = new Set<string>(this.roundIdsStore.keys());
    // 收集有元数据的会话（可能没有消息但有 meta）
    for (const sessionId of this.metas.keys()) {
      sessions.add(sessionId);
    }
    return [...sessions];
  }

  /**
   * 读取会话标题元数据
   *
   * round-based 单一模式：会话仅持 roundIds，无 legacy 扁平消息；占位元数据按 roundIds 推导。
   * 仅当会话存在 roundIds 或 meta 时才返回，否则视为会话不存在（如已删除）返回 undefined，
   * 避免删除后又被占位元数据「复活」（deleteSession 契约：删除后 getSessionMeta 应为 undefined）。
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），Round ID 需经 getRoundIds() 真源读取
    const meta = this.metas.get(sessionId);
    if (meta) return meta;
    // round-based 会话兜底：如果有 Round ID 列表，创建占位元数据
    const roundIds = this.roundIdsStore.get(sessionId);
    if (roundIds && roundIds.length > 0) {
      return {
        sessionId,
        displayName: defaultSessionTitle(),
        updatedAt: new Date().toISOString(),
        messageCount: this.deriveMessageCount(sessionId),
      };
    }
    return undefined;
  }

  /**
   * 更新 LLM 生成只读元数据（双层命名单一写点）：
   * autoName/keyTopics/summary 由内核 SessionNamer/SessionArchiver 写入；displayName
   * 由用户手动改名（renameSession）写入。setSessionTitle 亦收口于此，避免双路径分叉
   * （缺此实现时内核 updateSessionMeta 调用静默 no-op，自动命名/改名失效）。
   *
   * 合并语义 = **既有 meta 基底 + 传入 Partial 覆盖**（与内核
   * `inMemorySessionStore.updateSessionMeta` 同构），使非本次入参字段（`createdAt` 等）
   * 一并留存——纯白名单式重建会静默丢弃它们，而内核在分叉路径显式传 `createdAt`
   * （`messageHistory.forkSession` 内的 `updateSessionMeta(newSessionId, { createdAt })`），
   * 丢一次即永久不可恢复（本文件是落盘真相源）。
   *
   * 末位显式覆盖三项（不用纯 spread 的理由与语义）：
   *   - autoName/displayName/keyTopics/summary：调用方可传显式 `undefined`（`Partial` 允许）
   *     → 语义是「缺省 = 保留既有」，`?? existing` 才是该语义；纯 spread 会把既有值抹掉
   *   - updatedAt：改名/命名都不是活跃事件 → 保留既有，不刷新
   *   - messageCount：命名不重置计数 → 保留既有；**无既有 meta 时由
   *     `deriveMessageCount` 派生，禁写 0**
   *
   * ⚠️ 无既有 meta 分支为何必须派生：内核
   * `messageHistory.forkSession` 是「先 `setRoundIds(newSessionId, ...)` 再
   * `updateSessionMeta(newSessionId, {createdAt})`」——调用时刻 roundIds 已就位而 meta
   * 尚不存在（`setRoundIds` 内的计数回写因 `if (!meta) return` 提前退出）。写 0 会让
   * 分叉会话在 meta 上留下假值 0，而 `getSessionMeta` 见 meta 即直接返回（不走
   * roundIds 占位兜底），于是 `getMessageCount()` 对它返回 0（真值 N*2）。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @param meta 部分元数据（autoName/displayName/keyTopics/summary/createdAt）
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    const updated: SessionMeta = {
      // 基底 + 覆盖：非本次入参字段（createdAt 等）随基底留存，不被白名单重建丢弃
      ...existing,
      ...meta,
      sessionId,
      // 以下显式行：入参未给时回退既有值（而非被 spread 抹成 undefined）
      autoName: meta.autoName ?? existing?.autoName,
      displayName: meta.displayName ?? existing?.displayName ?? defaultSessionTitle(),
      keyTopics: meta.keyTopics ?? existing?.keyTopics,
      summary: meta.summary ?? existing?.summary,
      // 改名/命名非活跃事件：不重置 updatedAt 与计数
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      messageCount: existing?.messageCount ?? this.deriveMessageCount(sessionId),
    };
    this.metas.set(sessionId, updated);
    this.save();
  }

  /**
   * 修改会话标题：手动改名不改 updatedAt，收口到 updateSessionMeta 单一写点
   */
  setSessionTitle(sessionId: string, title: string): void {
    this.updateSessionMeta(sessionId, { displayName: title });
  }

  /**
   * 列出全部会话标题元数据：按 updatedAt 降序（最新在前）
   *
   * 覆盖所有已持久化会话：先取 metas，再补全有 roundIds 但无 meta 的会话。
   */
  listSessionMetas(): SessionMeta[] {
    const all = new Map(this.metas);
    // 补全 round-based 模式的会话（有 roundIds 但无 meta）
    for (const key of this.roundIdsStore.keys()) {
      if (!all.has(key)) {
        const derived = this.getSessionMeta(key);
        if (derived) all.set(key, derived);
      }
    }
    return [...all.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // ─── Round-based 模式方法 ─────────────────────────────────

  /**
   * 追加 Round ID 到会话（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @param roundId - 要追加的 Round ID
   */
  appendRoundId(sessionId: string, roundId: string): void {
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    roundIds.push(roundId);
    this.roundIdsStore.set(sessionId, roundIds);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    this.save();
  }

  /**
   * 批量追加 Round ID 到会话（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 要追加的 Round ID 数组
   */
  appendRoundIds(sessionId: string, roundIds: string[]): void {
    const existing = this.roundIdsStore.get(sessionId) ?? [];
    const merged = [...existing, ...roundIds];
    this.roundIdsStore.set(sessionId, merged);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    this.save();
  }

  /**
   * 获取会话的 Round ID 列表（round-based 模式）
   *
   * @param sessionId - 会话 ID
   * @returns Round ID 数组（按顺序）
   */
  getRoundIds(sessionId: string): string[] {
    return this.roundIdsStore.get(sessionId) ?? [];
  }

  /**
   * 设置会话的 Round ID 列表（round-based 模式）
   *
   * 用于创建新会话或完整替换（如分叉操作）
   *
   * @param sessionId - 会话 ID
   * @param roundIds - 新的 Round ID 列表
   */
  setRoundIds(sessionId: string, roundIds: string[]): void {
    this.roundIdsStore.set(sessionId, [...roundIds]);

    // 更新元数据（roundIds 真源为 roundIdsStore，读时派生）
    this.updateRoundBasedMessageCount(sessionId);
    this.save();
  }

  /**
   * 创建新会话元数据（round-based 模式）
   *
   * @param meta - 会话元数据
   */
  createSession(meta: SessionMeta): void {
    // SSOT：SessionMeta 为纯展示 DTO（无 roundIds），设置轮次请走 setRoundIds 真源
    this.metas.set(meta.sessionId, { ...meta });
    this.save();
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 更新 round-based 会话的消息计数
   *
   * SSOT 边界（与 inMemorySessionStore 同口径）：*2 是「每个已收场轮 = User+AI」的固有语义缓存，
   * 在 append 时点轮已收场，与精确 countMessagesInRounds 等价（两者判据同为 isRoundSettled）；
   * 免加载物理 Round（O(1)）。真源取自 roundIdsStore（meta 不持有 roundIds）。
   */
  private updateRoundBasedMessageCount(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    this.metas.set(sessionId, {
      ...meta,
      messageCount: this.deriveMessageCount(sessionId),
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * 派生会话消息数（round-based 固有语义：`roundIds.length * 2`）——**单一真源**。
   *
   * 与内核 `inMemorySessionStore.deriveMessageCount` 同款（内核注释明示「派生逻辑单一真源
   * = deriveMessageCount」）：本文件四处消费（`getSessionMeta` 占位兜底、`truncateFrom`
   * 截断同步、`append/setRoundIds` 计数回写、`updateSessionMeta` 无 meta 兜底）一律经本
   * 方法，**禁止各写一遍 `length * 2`**——派生口径一旦变化（如改为只计已收场轮），
   * 散落实现必漏改其一，meta 与 roundIds 立刻分叉。
   */
  private deriveMessageCount(sessionId: string): number {
    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    return roundIds.length * 2;
  }
}
