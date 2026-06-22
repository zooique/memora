/**
 * 审计日志管理器（M2：SecurityGuard.onAudit 闭环）
 *
 * 设计：
 *   - 审计事件以 JSONL（每行一条 JSON）格式追加到 dataDir/audit.log
 *   - JSONL 格式便于 append（无需序列化整个数组），也便于 grep
 *   - 写入为 fire-and-forget（不阻塞主流程），写入失败写 stderr
 *   - 保留最近 MAX_AUDIT_ENTRIES 条，超出截断（避免文件无限增长）
 *   - 渲染进程可通过 IPC 读取/清空审计日志
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  private readonly logFilePath: string;
  private readonly sessionId: string;
  private readonly maxEntries: number;
  /** 等待写入队列（用于有序追加 + 单元测试断言） */
  private pendingWrites = 0;

  constructor(dataDir: string, maxEntries = 1000) {
    this.logFilePath = `${dataDir}/audit.log`;
    this.sessionId = `sess-${Date.now().toString(36)}`;
    this.maxEntries = maxEntries;
  }

  /** 从 SecurityGuard 接收审计事件，追加到 JSONL 文件
   * 超出 MAX_AUDIT_ENTRIES 时从头部截断（保留最近的条目）
   */
  record(event: AuditEvent): void {
    const entry: AuditLogEntry = {
      ...event,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
    };
    this.pendingWrites += 1;

    // 先追加（fire-and-forget），写入成功后检查是否需要截断
    appendFile(this.logFilePath, `${JSON.stringify(entry)}\n`)
      .then(async () => {
        this.pendingWrites -= 1;

        // 截断保护：读取行数，超出时保留最近 maxEntries 条
        // 为避免每次追加都读文件，只在记录数达到阈值的整数倍时检查
        // 这里采用简单策略：每次写入都用 pendingWrites 计数 + 间隔检查
        // 但为保持代码简洁（audit.log 通常很小），直接截断是可接受的
        // 实际策略：借助 readRecent + clear 的组合，无需全文件操作
        if (this.maxEntries > 0) {
          try {
            // 先读最近 maxEntries*2 条，保守截断
            const recentEntries = await this.readRecent(this.maxEntries);
            if (recentEntries.length >= this.maxEntries) {
              // 保留最近 maxEntries 条（reverse 还原顺序）
              const trimmed = recentEntries
                .slice(0, this.maxEntries)
                .reverse()
                .map((e) => `${JSON.stringify(e)}\n`)
                .join('');
              await writeFile(this.logFilePath, trimmed, 'utf8');
            }
          } catch (err) {
            console.error(`[audit] 截断失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })
      .catch((err) => {
        this.pendingWrites -= 1;
        console.error(`[audit] 写入失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** 读取最近 N 条审计日志（从后往前读取） */
  async readRecent(limit = 50): Promise<AuditLogEntry[]> {
    try {
      const content = await readFile(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-limit);
      return recent
        .map((line) => {
          try {
            return JSON.parse(line) as AuditLogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditLogEntry => e !== null)
        .reverse(); // 最新在前
    } catch {
      // 文件不存在或读取失败时返回空数组（而非抛错）—— 与空文件行为一致
      return [];
    }
  }

  /** 清空审计日志 */
  async clear(): Promise<void> {
    // 确保目录存在
    const dir = this.logFilePath.slice(0, this.logFilePath.lastIndexOf('/'));
    await mkdir(dir, { recursive: true });
    await writeFile(this.logFilePath, '', 'utf8');
  }

  /** （仅用于测试）获取当前未完成写入数 */
  getPendingCount(): number {
    return this.pendingWrites;
  }
}
