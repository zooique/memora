/**
 * JSONL 追加写入器 — 公共基础设施
 *
 * 为 auditManager 和 spriteTracer 提供统一的 JSONL 写入 + 截断能力。
 * 提取自两个模块的同构逻辑（DRY），优化截断策略为计数器间隔式。
 *
 * 设计：
 *   - JSONL 格式：每行一条 JSON，便于 append + grep
 *   - 串行化写入队列（writeChain）：所有文件写入操作排队执行，避免并发
 *     read-modify-write 竞态导致日志行丢失
 *   - 计数器间隔截断：每 truncateCheckInterval 次写入检查一次文件大小，
 *     避免每次写入都读全文件（O(n) 写放大）
 *   - 超出 maxEntries 时保留最近条目，从头截断
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger, toError } from 'memora';
import { DEFAULT_MAX_ENTRIES } from '../constants.js';

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
  /**
   * 写入队列链
   *
   * 串行化所有文件写入操作（append + truncateIfNeeded），避免并发
   * read-modify-write 竞态导致日志行丢失。
   *
   * 每次 append/clear 将操作链接到链尾，确保前一个写入完成后才执行下一个。
   * 错误隔离：append 的 catch 恢复链为 resolved，单个写入失败不影响后续写入。
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: JsonlAppenderOptions) {
    this.filePath = options.filePath;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.truncateCheckInterval = options.truncateCheckInterval ?? 100;
    // 构造函数中确保目录存在，防止首次 append 时 ENOENT 静默失败
    // 同步执行：仅在初始化时执行一次，mkdirSync recursive 是幂等的
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * 追加一条记录到 JSONL 文件
   *
   * 写入通过 writeChain 串行化，保证 append + truncateIfNeeded 不会交错执行。
   * 方法本身是 fire-and-forget（不返回 Promise），调用方无需 await。
   * 每累计 truncateCheckInterval 次写入后检查文件大小并截断。
   *
   * @param record 要序列化为 JSON 的记录对象
   */
  append<T extends object>(record: T): void {
    this.writeCount += 1;
    const shouldCheckTruncate = this.writeCount % this.truncateCheckInterval === 0;

    // 将 append + truncate 链接到 writeChain 末尾，串行化执行
    this.writeChain = this.writeChain
      .then(async () => {
        await appendFile(this.filePath, `${JSON.stringify(record)}\n`);
        if (shouldCheckTruncate && this.maxEntries > 0) {
          await this.truncateIfNeeded();
        }
      })
      .catch((err: unknown) => {
        // 错误隔离：记录失败但恢复 writeChain 为 resolved，不阻塞后续写入
        const msg = toError(err).message;
        logger.error({ err: msg }, '[jsonl-appender] 写入失败');
      });
  }

  /**
   * 读取最近 N 条记录（从后往前读取，最新在前）
   *
   * @param limit 返回数量上限，默认 50
   * @returns 解析后的记录数组，文件不存在时返回空数组
   */
  async readRecent<T extends object = Record<string, unknown>>(limit = 50): Promise<T[]> {
    // try 仅包裹 readFile（IO），解析逻辑移出 try，避免解析错误被混入 IO 错误处理
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (err) {
      // 文件读取失败时返回空数组，记录警告便于排查
      logger.warn({ err: toError(err).message, filePath: this.filePath }, '读取审计日志失败');
      return [];
    }
    const lines = content.trim().split('\n').filter(Boolean);
    const recent = lines.slice(-limit);
    return recent
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          // 单行 JSON 解析失败时跳过该行，debug 级别避免日志噪音
          logger.debug({ line: line.slice(0, 100) }, '审计日志行解析失败，跳过该行');
          return null;
        }
      })
      .filter((e): e is T => e !== null)
      .reverse(); // 最新在前
  }

  /**
   * 清空日志文件
   *
   * 通过 writeChain 串行化，确保清空操作不会与并发 append 交错。
   * await writeChain 确保调用方返回时文件已清空。
   * 清空失败时错误抛给调用方，但 writeChain 恢复为 resolved 不阻塞后续写入。
   */
  async clear(): Promise<void> {
    // 将 clear 操作链接到 writeChain 末尾（等待之前排队的 append 完成）
    const clearPromise = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, '', 'utf8');
      });
    // 无论 clear 成功还是失败，writeChain 恢复为 resolved，避免阻塞后续 append
    this.writeChain = clearPromise.catch(() => {});
    // 等待 clear 完成，错误抛给调用方
    await clearPromise;
  }

  /** 获取当前累计写入计数（仅用于测试） */
  getWriteCount(): number {
    return this.writeCount;
  }

  /**
   * 等待写入队列排空（仅用于测试）
   *
   * 返回 writeChain 的 Promise，调用方 await 后可确保所有排队的 append/clear 已完成。
   * 精确等待 writeChain 排空，消除全量测试 I/O 压力下的 flaky test。
   */
  flush(): Promise<void> {
    return this.writeChain;
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
    } catch (err) {
      // 读取/截断失败时静默忽略（日志本身是辅助信息），debug 级别避免日志噪音
      logger.debug({ err: toError(err).message, filePath: this.filePath }, '审计日志截断失败');
    }
  }
}
