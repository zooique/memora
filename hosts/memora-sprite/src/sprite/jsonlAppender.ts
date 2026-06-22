/**
 * JSONL 追加写入器 — 公共基础设施
 *
 * 为 auditManager 和 spriteTracer 提供统一的 JSONL 写入 + 截断能力。
 * 提取自两个模块的同构逻辑（DRY），优化截断策略为计数器间隔式。
 *
 * 设计：
 *   - JSONL 格式：每行一条 JSON，便于 append + grep
 *   - fire-and-forget 写入：不阻塞主流程，写入失败写 stderr
 *   - 计数器间隔截断：每 truncateCheckInterval 次写入检查一次文件大小，
 *     避免每次写入都读全文件（O(n) 写放大）
 *   - 超出 maxEntries 时保留最近条目，从头截断
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** JSONL 追加写入器配置 */
export interface JsonlAppenderOptions {
  /** 日志文件路径 */
  filePath: string;
  /** 最大保留条数，超出时从头截断。默认 1000 */
  maxEntries?: number;
  /** 每隔多少次写入检查一次截断。默认 100（避免每次写入都读文件） */
  truncateCheckInterval?: number;
}

/**
 * JSONL 追加写入器
 *
 * 使用方式：
 * ```ts
 * const appender = new JsonlAppender({ filePath: '/path/to/file.log', maxEntries: 500 });
 * appender.append({ name: 'test', value: 42 });
 * ```
 */
export class JsonlAppender {
  private readonly filePath: string;
  private readonly maxEntries: number;
  private readonly truncateCheckInterval: number;
  /** 累计写入计数（用于间隔截断检查） */
  private writeCount = 0;

  constructor(options: JsonlAppenderOptions) {
    this.filePath = options.filePath;
    this.maxEntries = options.maxEntries ?? 1000;
    this.truncateCheckInterval = options.truncateCheckInterval ?? 100;
  }

  /**
   * 追加一条记录到 JSONL 文件
   *
   * 写入为 fire-and-forget，不阻塞调用方。
   * 每累计 truncateCheckInterval 次写入后检查文件大小并截断。
   *
   * @param record 要序列化为 JSON 的记录对象
   */
  append(record: Record<string, unknown>): void {
    this.writeCount += 1;
    const shouldCheckTruncate = this.writeCount % this.truncateCheckInterval === 0;

    appendFile(this.filePath, `${JSON.stringify(record)}\n`)
      .then(async () => {
        if (shouldCheckTruncate && this.maxEntries > 0) {
          await this.truncateIfNeeded();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[jsonl-appender] 写入失败: ${msg}`);
      });
  }

  /**
   * 读取最近 N 条记录（从后往前读取，最新在前）
   *
   * @param limit 返回数量上限，默认 50
   * @returns 解析后的记录数组，文件不存在时返回空数组
   */
  async readRecent(limit = 50): Promise<Record<string, unknown>[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-limit);
      return recent
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((e): e is Record<string, unknown> => e !== null)
        .reverse(); // 最新在前
    } catch {
      return [];
    }
  }

  /**
   * 清空日志文件
   *
   * 确保目录存在后写入空内容。
   */
  async clear(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, '', 'utf8');
  }

  /** 获取当前累计写入计数（仅用于测试） */
  getWriteCount(): number {
    return this.writeCount;
  }

  /**
   * 检查文件行数，超出 maxEntries 时截断保留最近条目
   *
   * 读取全文 → 计算行数 → 超出时保留最近 maxEntries 条重写。
   * 仅在间隔检查点调用，避免高频读文件。
   */
  private async truncateIfNeeded(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const lines = content.trim().split('\n');
      if (lines.length > this.maxEntries) {
        const trimmed = lines.slice(-this.maxEntries).join('\n') + '\n';
        await writeFile(this.filePath, trimmed, 'utf8');
      }
    } catch {
      // 读取/截断失败，静默忽略（日志本身是辅助信息）
    }
  }
}
