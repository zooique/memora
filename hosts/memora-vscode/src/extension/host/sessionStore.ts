/**
 * 工作区会话存储 — ISessionStore 实现（JSON 文件落盘）
 *
 * 职责：
 *   - 将 memora 原始对话消息持久化到工作区 `.memora/sessions.json`
 *   - 实现 ISessionStore 接口，注入 Agent，让跨会话对话记录可回溯（traceSummary 依赖）
 *   - 原子写入：save() 使用 atomicWriteFileSync 防崩溃损坏
 *   - 支持双模式：legacy 模式（消息列表）和 round-based 模式（Round ID 列表）
 *
 * 阶段 1：扩展支持 Round-based 存储模式（问答闭环独立存储）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultSessionTitle,
  type ISessionStore,
  type SessionMessage,
  type SessionMeta,
} from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';

/** 工作区会话存储 */
export class WorkspaceSessionStore implements ISessionStore {
  /** 会话消息主存储：`date-session` → SessionMessage[]（legacy 模式） */
  private store = new Map<string, SessionMessage[]>();
  /** 检查点存储：sessionId → checkpoint 字符串 */
  private checkpoints = new Map<string, string>();
  /** 会话标题元数据（ADR-024）：sessionId → SessionMeta */
  private metas = new Map<string, SessionMeta>();
  /** Round ID 列表存储：sessionId → roundId[]（round-based 模式） */
  private roundIdsStore = new Map<string, string[]>();
  /** 会话文件绝对路径 */
  private readonly filePath: string;

  constructor(workspacePath: string) {
    this.filePath = join(workspacePath, '.memora', 'sessions.json');
  }

  /** 从文件加载会话（文件不存在则空） */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw) as {
        sessions: Record<string, SessionMessage[]>;
        checkpoints: Record<string, string>;
        metas: Record<string, SessionMeta>;
        roundIdsStore: Record<string, string[]>;
      };
      for (const [k, v] of Object.entries(data.sessions ?? {})) this.store.set(k, v);
      for (const [k, v] of Object.entries(data.checkpoints ?? {})) this.checkpoints.set(k, v);
      for (const [k, v] of Object.entries(data.metas ?? {})) this.metas.set(k, v);
      // 加载 round-based 模式的 Round ID 列表
      for (const [k, v] of Object.entries(data.roundIdsStore ?? {})) this.roundIdsStore.set(k, v);
    } catch (err) {
      // 会话文件损坏时降级为空（不阻塞插件启动）
      // 注意：sessions 与 checkpoints 一并清空，避免跨会话回溯（trace_summary）读到脏检查点
      console.warn('Memora 会话文件读取失败，降级为空', err);
      this.store.clear();
      this.checkpoints.clear();
      this.roundIdsStore.clear();
    }
  }

  /** 将内存原子写回文件（先写 .tmp 再 rename，防崩溃损坏） */
  private save(): void {
    const data = {
      sessions: Object.fromEntries(this.store),
      checkpoints: Object.fromEntries(this.checkpoints),
      metas: Object.fromEntries(this.metas),
      roundIdsStore: Object.fromEntries(this.roundIdsStore),
    };
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  appendMessage(date: string, session: string, message: SessionMessage): void {
    const key = `${date}-${session}`;
    const list = this.store.get(key) ?? [];
    list.push(message);
    this.store.set(key, list);
    // 同步维护会话标题元数据：updatedAt 刷新 + messageCount 递增（ADR-024）
    const existing = this.metas.get(key);
    this.metas.set(key, {
      sessionId: key,
      displayName: existing?.displayName ?? defaultSessionTitle(),
      updatedAt: new Date().toISOString(),
      messageCount: list.length,
    });
    this.save();
  }

  loadMessages(date: string, session: string): SessionMessage[] {
    const key = `${date}-${session}`;
    return (this.store.get(key) ?? []).map((m) => ({ ...m }));
  }

  /**
   * 删除指定会话记录（历史浮层垃圾桶触发，2026-08-17 会话管理重构）
   *
   * 删除整条会话：消息 + 标题元数据 + 检查点（连带清检查点，防脏检查点残留污染
   * trace_summary）。替代原 clearSession（清空当前会话）——清空为伪需求，由
   * 「删除会话记录」覆盖（用户决策 2026-08-17）。
   *
   * 非内核 ISessionStore 标准接口，仅在宿主侧使用。
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   */
  /**
   * 删除指定会话记录
   *
   * 支持 legacy 模式和 round-based 模式：
   * - legacy 模式：删除消息 + 元数据 + 检查点
   * - round-based 模式：删除 Round ID 列表 + 元数据 + 检查点
   *
   * @param sessionId 会话标识（YYYY-MM-DD-sessionName）
   */
  deleteSession(sessionId: string): void {
    // legacy 模式清理
    this.store.delete(sessionId);
    // round-based 模式清理
    this.roundIdsStore.delete(sessionId);
    // 通用清理
    this.metas.delete(sessionId);
    this.checkpoints.delete(sessionId);
    this.save();
  }

  /**
   * 截断指定会话（truncate-from-turn，宿主扩展方法，供「删除单个问答闭环」调用）
   *
   * 语义（对齐市面主流 ChatGPT 编辑重跑 / personal-ai）：删除【目标问答闭环及其之后所有
   * 消息】，保证剩余上下文自洽（避免中间删除一个闭环导致后续 assistant 回复的上文断裂）。
   *
   * 锚点：删除按钮携带的 fromTs 有两种来源（SSOT 归一）：
   *   - 流式：chatPanel 的 firstChunkTs（流开始时刻，早于该答存储时间戳）；
   *   - 历史回放：存储的 assistant timestamp（精确值）。
   * 故用「下界匹配」定位第一条 `role='assistant' && timestamp >= fromTs` 的消息，两种来源
   * 都能命中目标答；再向前回退到最近一条 role='user' 的消息视为该问答的「问」，
   * 删除从该「问」到会话末尾的全部消息。找不到锚点返回 false（no-op）。
   *
   * 非内核 ISessionStore 标准接口（内核接口坚持最小化），仅在宿主侧使用，与 deleteSession 同模式。
   *
   * @param date 会话日期 YYYY-MM-DD
   * @param session 会话标识
   * @param fromTs 删除按钮携带的 timestamp（webview 渲染时存的 dataset.ts）
   * @returns 是否截断成功（锚点消息未找到时返回 false）
   */
  truncateFrom(date: string, session: string, fromTs: string): boolean {
    const key = `${date}-${session}`;
    const list = this.store.get(key);
    if (!list || list.length === 0) return false;
    // 下界匹配定位第一条「timestamp >= fromTs 的 assistant」——兼容流式（fromTs=流开始时刻）
    // 与历史回放（fromTs=精确 timestamp）两种锚点来源，根治「源不一致导致删除失效」。
    const idx = list.findIndex((m) => m.role === 'assistant' && m.timestamp >= fromTs);
    if (idx === -1) return false;
    // 向前回退到最近一条 user 消息作为本轮起点（该问答的「问」）：
    // 从 anchor 自身开始，只要当前不是 user 就前移，直到停在 user 或 0。
    // 这样 anchor 对应的「问」也被一并删除（删了答也删问）。
    let start = idx;
    while (start > 0 && list[start].role !== 'user') start--;
    // 删除 [start, list.length) 之后的全部消息（含本轮问答）
    const truncated = list.slice(0, start);
    this.store.set(key, truncated);
    // 同步会话标题元数据：messageCount 更新为截断后条数（updatedAt 不变，非新增活跃事件）
    const existing = this.metas.get(key);
    if (existing) {
      this.metas.set(key, { ...existing, messageCount: truncated.length });
    }
    this.save();
    return true;
  }

  listSessions(): string[] {
    // 收集 legacy 模式的会话
    const sessions = new Set<string>(this.store.keys());
    // 收集 round-based 模式的会话
    for (const sessionId of this.roundIdsStore.keys()) {
      sessions.add(sessionId);
    }
    // 收集有元数据的会话（可能没有消息但有 meta）
    for (const sessionId of this.metas.keys()) {
      sessions.add(sessionId);
    }
    return [...sessions];
  }

  /**
   * 读取会话标题元数据（ADR-024）：无元数据但存在消息时按消息推断占位元数据
   *
   * 兼容旧数据：早期会话无 metas 记录，依据消息列表实时推导（updatedAt 取末条时间戳）。
   * 这样历史列表仍能列出旧会话，不必强制迁移。
   * 仅当会话仍存在消息时才推导占位——无消息且无 meta 视为会话不存在（如已删除），返回 undefined，
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
        storageMode: 'round-based',
        roundIds: [...roundIds],
        displayName: defaultSessionTitle(),
        updatedAt: new Date().toISOString(),
        messageCount: roundIds.length * 2,
      };
    }
    // 旧会话兜底：仅当存在消息时推导占位元数据（不落盘，仅展示用）
    const msgs = this.store.get(sessionId);
    if (!msgs || msgs.length === 0) return undefined;
    const last = msgs[msgs.length - 1];
    return {
      sessionId,
      displayName: defaultSessionTitle(),
      updatedAt: last?.timestamp ?? new Date().toISOString(),
      messageCount: msgs.length,
    };
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
   * 覆盖所有已持久化会话：
   * 1. 先取 metas（有元数据的会话）
   * 2. 补全 legacy 模式的会话（getSessionMeta 推导）
   * 3. 补全 round-based 模式的会话（getSessionMeta 推导）
   */
  listSessionMetas(): SessionMeta[] {
    const all = new Map(this.metas);
    // 补全 legacy 模式的会话
    for (const key of this.store.keys()) {
      if (!all.has(key)) {
        const derived = this.getSessionMeta(key);
        if (derived) all.set(key, derived);
      }
    }
    // 补全 round-based 模式的会话
    for (const key of this.roundIdsStore.keys()) {
      if (!all.has(key)) {
        const derived = this.getSessionMeta(key);
        if (derived) all.set(key, derived);
      }
    }
    return [...all.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  copySession?(
    sourceDate: string,
    sourceSession: string,
    targetDate: string,
    targetSession: string,
  ): void {
    const source = this.loadMessages(sourceDate, sourceSession);
    if (source.length === 0) return;
    this.store.set(`${targetDate}-${targetSession}`, source);
    this.save();
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
