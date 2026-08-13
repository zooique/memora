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
import type { ISessionStore, SessionMessage } from '@zooique/memora';

/** 工作区会话存储 */
export class WorkspaceSessionStore implements ISessionStore {
  /** 会话消息主存储：`date-session` → SessionMessage[] */
  private store = new Map<string, SessionMessage[]>();
  /** 检查点存储：sessionId → checkpoint 字符串 */
  private checkpoints = new Map<string, string>();
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
      };
      for (const [k, v] of Object.entries(data.sessions ?? {})) this.store.set(k, v);
      for (const [k, v] of Object.entries(data.checkpoints ?? {})) this.checkpoints.set(k, v);
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
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  appendMessage(date: string, session: string, message: SessionMessage): void {
    const key = `${date}-${session}`;
    const list = this.store.get(key) ?? [];
    list.push(message);
    this.store.set(key, list);
    this.save();
  }

  loadMessages(date: string, session: string): SessionMessage[] {
    const key = `${date}-${session}`;
    return (this.store.get(key) ?? []).map((m) => ({ ...m }));
  }

  listSessions(): string[] {
    return [...this.store.keys()];
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
