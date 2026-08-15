/**
 * 工作区会话存储 — ISessionStore 实现（JSON 文件落盘）
 *
 * 职责：
 *   - 将 memora 原始对话消息持久化到工作区 `.memora/sessions.json`
 *   - 实现 ISessionStore 接口，注入 Agent，让跨会话对话记录可回溯（traceSummary 依赖）
 *
 * 阶段 0：最小可用实现（内存 Map + 每次变更落盘）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  defaultSessionTitle,
  type ISessionStore,
  type SessionMessage,
  type SessionMeta,
} from '@zooique/memora';

/** 工作区会话存储 */
export class WorkspaceSessionStore implements ISessionStore {
  /** 会话消息主存储：`date-session` → SessionMessage[] */
  private store = new Map<string, SessionMessage[]>();
  /** 检查点存储：sessionId → checkpoint 字符串 */
  private checkpoints = new Map<string, string>();
  /** 会话标题元数据（ADR-024）：sessionId → SessionMeta */
  private metas = new Map<string, SessionMeta>();
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
      };
      for (const [k, v] of Object.entries(data.sessions ?? {})) this.store.set(k, v);
      for (const [k, v] of Object.entries(data.checkpoints ?? {})) this.checkpoints.set(k, v);
      for (const [k, v] of Object.entries(data.metas ?? {})) this.metas.set(k, v);
    } catch (err) {
      // 会话文件损坏时降级为空（不阻塞插件启动）
      // 注意：sessions 与 checkpoints 一并清空，避免跨会话回溯（trace_summary）读到脏检查点
      console.warn('Memora 会话文件读取失败，降级为空', err);
      this.store.clear();
      this.checkpoints.clear();
    }
  }

  /** 将内存写回文件 */
  private save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const data = {
      sessions: Object.fromEntries(this.store),
      checkpoints: Object.fromEntries(this.checkpoints),
      metas: Object.fromEntries(this.metas),
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
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
      title: existing?.title ?? defaultSessionTitle(),
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
   * 清空指定会话的消息（宿主扩展方法，供「清空对话」按钮调用）
   *
   * 非内核 ISessionStore 标准接口，仅在宿主侧使用。
   */
  clearSession(date: string, session: string): void {
    const key = `${date}-${session}`;
    this.store.delete(key);
    this.metas.delete(key);
    this.save();
  }

  listSessions(): string[] {
    return [...this.store.keys()];
  }

  /**
   * 读取会话标题元数据（ADR-024）：无元数据时按消息推断占位元数据
   *
   * 兼容旧数据：早期会话无 metas 记录，依据消息列表实时推导（updatedAt 取末条时间戳）。
   * 这样历史列表仍能列出旧会话，不必强制迁移。
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    const meta = this.metas.get(sessionId);
    if (meta) return meta;
    // 旧会话兜底：从消息列表推导占位元数据（不落盘，仅展示用）
    const msgs = this.store.get(sessionId);
    if (!msgs || msgs.length === 0) return undefined;
    const last = msgs[msgs.length - 1];
    return {
      sessionId,
      title: defaultSessionTitle(),
      updatedAt: last?.timestamp ?? new Date(0).toISOString(),
      messageCount: msgs.length,
    };
  }

  /**
   * 修改会话标题（ADR-024）：手动改名不改 updatedAt（改名非活跃事件）
   */
  setSessionTitle(sessionId: string, title: string): void {
    const existing = this.metas.get(sessionId);
    this.metas.set(sessionId, {
      sessionId,
      title,
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      messageCount: existing?.messageCount ?? 0,
    });
    this.save();
  }

  /**
   * 列出全部会话标题元数据（ADR-024）：按 updatedAt 降序（最新在前）
   *
   * 覆盖所有已持久化会话：先取 metas，再补全无 metas 的旧会话（getSessionMeta 推导）。
   */
  listSessionMetas(): SessionMeta[] {
    const all = new Map(this.metas);
    for (const key of this.store.keys()) {
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
}
