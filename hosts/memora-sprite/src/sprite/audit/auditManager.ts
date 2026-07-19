/**
 * 审计日志管理器（M2：SecurityGuard.onAudit 闭环）
 *
 * 设计：
 *   - 审计事件以 JSONL（每行一条 JSON）格式追加到 dataDir/audit.log
 *   - JSONL 格式便于 append（无需序列化整个数组），也便于 grep
 *   - 写入为 fire-and-forget（不阻塞主流程），写入失败写 stderr
 *   - 保留最近 MAX_AUDIT_ENTRIES 条，超出截断（避免文件无限增长）
 *   - 截断策略为计数器间隔式（每 100 次写入检查一次），避免每次读全文件
 *   - 渲染进程可通过 IPC 读取/清空审计日志
 */

import { JsonlAppender } from './jsonlAppender.js';
import { DEFAULT_MAX_ENTRIES } from '../constants.js';
import type { AuditEvent } from 'memora';

/** 单条审计日志在 JSONL 中的完整记录（比 AuditEvent 多了时间戳 & 运行时 ID） */
export interface AuditLogEntry extends AuditEvent {
  /** 时间戳（ISO 8601） */
  timestamp: string;
  /** 运行时会话 ID，便于用户重启后分段展示（如"今天/昨天"） */
  sessionId: string;
}

/** 审计日志管理类（宿主项目单例） */
export class AuditManager {
  private readonly appender: JsonlAppender;
  private readonly sessionId: string;

  constructor(dataDir: string, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.appender = new JsonlAppender({
      filePath: `${dataDir}/audit.log`,
      maxEntries,
    });
    this.sessionId = `sess-${Date.now().toString(36)}`;
  }

  /** 从 SecurityGuard 接收审计事件，追加到 JSONL 文件 */
  record(event: AuditEvent): void {
    const entry: AuditLogEntry = {
      ...event,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };
    this.appender.append(entry);
  }

  /** 读取最近 N 条审计日志（从后往前读取，最新在前） */
  async readRecent(limit = 50): Promise<AuditLogEntry[]> {
    const records = await this.appender.readRecent<AuditLogEntry>(limit);
    return records;
  }

  /**
   * 等待写入队列排空（仅用于测试）
   *
   * 委托 JsonlAppender.flush()，精确等待 writeChain 完成。
   */
  flush(): Promise<void> {
    return this.appender.flush();
  }

  /** 清空审计日志 */
  async clear(): Promise<void> {
    await this.appender.clear();
  }
}
