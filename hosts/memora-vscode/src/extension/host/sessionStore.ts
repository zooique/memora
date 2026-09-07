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
  /** 检查点存储：sessionId → checkpoint 字符串 */
  private checkpoints = new Map<string, string>();
  /** 会话标题元数据（ADR-024）：sessionId → SessionMeta */
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

  /** 从文件加载会话（文件不存在则空）
   *
   * Phase 4 收敛：加 checkpoint 僵尸数据防御性清理。
   * 异常退出（kill/crash）时内核跳过 discardCheckpoint → sessions.json 残留 checkpoint 字段。
   * 判断：checkpoint 的 sessionId 在 roundIdsStore 里不存在 → 会话已被物理清理 → checkpoint 是僵尸。
   * 清理后持久化（调 save）——启动时顺手做，零额外成本。 */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        checkpoints: Record<string, string>;
        metas: Record<string, SessionMeta>;
        roundIdsStore: Record<string, string[]>;
      };
      for (const [k, v] of Object.entries(data.checkpoints ?? {})) this.checkpoints.set(k, v);
      for (const [k, v] of Object.entries(data.metas ?? {})) this.metas.set(k, v);
      // 加载 round-based 模式的 Round ID 列表（唯一内容来源）
      for (const [k, v] of Object.entries(data.roundIdsStore ?? {})) this.roundIdsStore.set(k, v);

    // 检查点清理职责归显式删除路径（deleteSession 三件套已含 checkpoints.delete）——
    // load() 不再做防御清理（2026-09-07 G21 实证误伤）：原判据「sessionId ∉ roundIdsStore」
    // 会把「新建检查点但尚未产生对话轮次」的合法暂停现场当僵尸删除，导致跨重启无法恢复。
    // 显式删除（deleteSession）已同步删 checkpoint，运行中异常退出残留的 pause checkpoint
    // 正是跨重启断点续跑的恢复源（G3），不应被只读加载路径当垃圾清掉。
    } catch (err) {
      // 会话文件损坏时降级为空（不阻塞插件启动）
      console.warn('Memora 会话文件读取失败，降级为空', err);
      this.checkpoints.clear();
      this.metas.clear();
      this.roundIdsStore.clear();
    }
  }

  /** 将内存原子写回文件（先写 .tmp 再 rename，防崩溃损坏） */
  private save(): void {
    const data = {
      checkpoints: Object.fromEntries(this.checkpoints),
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
      if (round.assistantMessage && round.status === 'complete') {
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
    // 清理：移除 Round ID 指针 + 元数据 + 检查点（物理 Round 由 RoundStore 引用计数 + GC 管理）
    this.roundIdsStore.delete(sessionId);
    this.metas.delete(sessionId);
    this.checkpoints.delete(sessionId);
    this.save();
    return removedIds;
  }

  /**
   * 截断指定会话（truncate-from-turn，宿主扩展方法）
   *
   * 删除【目标问答闭环及其之后所有 Round】，保证剩余上下文自洽。
   *
   * 锚点（下界匹配）：定位第一条 `assistant timestamp >= fromTs` 的 Round。
   * Round 边界即问答的 user 起点，删除该 Round 及之后。
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
    // 下界匹配：第一条 assistant 时间戳 >= fromTs 的 Round 作为截断起点
    const idx = rounds.findIndex(
      (r: Round) => r.assistantMessage?.timestamp !== undefined && r.assistantMessage.timestamp >= fromTs,
    );
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
    // 同步元数据
    const existing = this.metas.get(sessionId);
    if (existing) {
      this.metas.set(sessionId, { ...existing, roundIds: [...kept], messageCount: kept.length * 2 });
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
   * 读取会话标题元数据（ADR-024）
   *
   * round-based 单一模式：会话仅持 roundIds，无 legacy 扁平消息；占位元数据按 roundIds 推导。
   * 仅当会话存在 roundIds 或 meta 时才返回，否则视为会话不存在（如已删除）返回 undefined，
   * 避免删除后又被占位元数据「复活」（deleteSession 契约：删除后 getSessionMeta 应为 undefined）。
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    const meta = this.metas.get(sessionId);
    if (meta) {
      // 如果有 roundIds 存储但 meta 中没有，同步更新
      if (this.roundIdsStore.has(sessionId) && (!meta.roundIds || meta.roundIds.length === 0)) {
        const roundIds = this.roundIdsStore.get(sessionId) ?? [];
        meta.roundIds = roundIds;
        this.metas.set(sessionId, meta);
      }
      return meta;
    }
    // round-based 会话兜底：如果有 Round ID 列表，创建占位元数据
    const roundIds = this.roundIdsStore.get(sessionId);
    if (roundIds && roundIds.length > 0) {
      return {
        sessionId,
        roundIds: [...roundIds],
        displayName: defaultSessionTitle(),
        updatedAt: new Date().toISOString(),
        messageCount: roundIds.length * 2,
      };
    }
    return undefined;
  }

  /**
   * 更新 LLM 生成只读元数据（ADR-024 双层命名单一写点，2026-08-26 排雷复盘）：
   * autoName/keyTopics/summary 由内核 SessionNamer/SessionArchiver 写入；displayName
   * 由用户手动改名（renameSession）写入。setSessionTitle 亦收口于此，避免双路径分叉
   * （此前漏实现导致内核 updateSessionMeta 调用静默 no-op，自动命名/改名失效）。
   *
   * 合并语义：以既有 meta 为基底展开 Partial 覆盖——
   *   - autoName 不覆盖（手动改名保留 LLM 只读名，双层命名解耦）
   *   - displayName 优先用传入值，否则保留既有（含占位）
   *   - updatedAt/messageCount 保留（改名非活跃事件、命名不重置计数）
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   * @param meta 部分元数据（autoName/displayName/keyTopics/summary）
   */
  updateSessionMeta(sessionId: string, meta: Partial<SessionMeta>): void {
    const existing = this.metas.get(sessionId);
    const updated: SessionMeta = {
      sessionId,
      autoName: meta.autoName ?? existing?.autoName,
      displayName: meta.displayName ?? existing?.displayName ?? defaultSessionTitle(),
      keyTopics: meta.keyTopics ?? existing?.keyTopics,
      summary: meta.summary ?? existing?.summary,
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      messageCount: existing?.messageCount ?? 0,
    };
    this.metas.set(sessionId, updated);
    this.save();
  }

  /**
   * 修改会话标题（ADR-024）：手动改名不改 updatedAt，收口到 updateSessionMeta 单一写点
   */
  setSessionTitle(sessionId: string, title: string): void {
    this.updateSessionMeta(sessionId, { displayName: title });
  }

  /**
   * 列出全部会话标题元数据（ADR-024）：按 updatedAt 降序（最新在前）
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

  saveCheckpoint?(sessionId: string, checkpoint: string): void {
    this.checkpoints.set(sessionId, checkpoint);
    this.save();
  }

  loadCheckpoint?(sessionId: string): string | null {
    return this.checkpoints.get(sessionId) ?? null;
  }

  deleteCheckpoint?(sessionId: string): void {
    this.checkpoints.delete(sessionId);
    this.save();
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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

    // 更新元数据
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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

    // 更新元数据
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

    // 同步更新 meta 中的 roundIds 字段
    this.syncMetaRoundIds(sessionId);

    // 更新元数据
    this.updateRoundBasedMessageCount(sessionId);
    this.save();
  }

  /**
   * 创建新会话元数据（round-based 模式）
   *
   * @param meta - 会话元数据
   */
  createSession(meta: SessionMeta): void {
    this.metas.set(meta.sessionId, { ...meta });

    // 如果有 roundIds，同时存储到 roundIdsStore
    if (meta.roundIds && meta.roundIds.length > 0) {
      this.roundIdsStore.set(meta.sessionId, [...meta.roundIds]);
    }

    this.save();
  }

  // ─── 私有辅助方法 ─────────────────────────────────────

  /**
   * 同步 meta 中的 roundIds 字段
   *
   * 确保 meta.roundIds 和 roundIdsStore 保持一致
   */
  private syncMetaRoundIds(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    const roundIds = this.roundIdsStore.get(sessionId) ?? [];
    this.metas.set(sessionId, {
      ...meta,
      roundIds: [...roundIds],
    });
  }

  /**
   * 更新 round-based 会话的消息计数
   */
  private updateRoundBasedMessageCount(sessionId: string): void {
    const meta = this.metas.get(sessionId);
    if (!meta) return;

    const roundIds = this.roundIdsStore.get(sessionId) ?? meta.roundIds ?? [];
    const messageCount = roundIds.length * 2; // 每个 Round 包含 User + AI

    this.metas.set(sessionId, {
      ...meta,
      messageCount,
      updatedAt: new Date().toISOString(),
    });
  }
}
