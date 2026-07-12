/**
 * 使用统计采集器
 *
 * 采集匿名使用数据（功能使用次数、对话轮次、错误次数），
 * 默认关闭，需显式开启。数据持久化到 dataDir/usage-stats.json。
 *
 * 不采集：对话内容、记忆内容、项目路径、文件内容。
 *
 * 持久化策略：
 *   - 定时批量写入（默认每 5 分钟）
 *   - 退出时写入（before-quit 钩子调用 flush）
 *   - JSON 文件覆盖写入（累积快照，非追加日志）
 *
 * 与 AuditManager 的区别：
 *   - AuditManager 使用 JsonlAppender 追加写入（审计日志是事件流）
 *   - UsageStatsCollector 使用 JSON 覆盖写入（使用统计是累积快照）
 */

import { writeFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger, toError } from 'memora';

/** 使用统计快照 */
export interface UsageStatsSnapshot {
  /** 采集开始时间（ISO 8601） */
  since: string;
  /** 最后更新时间（ISO 8601） */
  updatedAt: string;
  /** 功能使用次数（按 IPC 通道名分组） */
  featureUsage: Record<string, number>;
  /** 对话轮次（按日期分组，如 "2026-07-12"） */
  chatTurns: Record<string, number>;
  /** 错误次数（按位置分组） */
  errors: Record<string, number>;
}

/** 默认定时写入间隔（5 分钟） */
const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

export class UsageStatsCollector {
  private readonly filePath: string;
  private enabled = false;
  private since: string;
  private featureUsage: Record<string, number> = {};
  private chatTurns: Record<string, number> = {};
  private errors: Record<string, number> = {};
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'usage-stats.json');
    this.since = new Date().toISOString();
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** 开启/关闭采集。关闭后已累积的数据仍保留，可导出或持久化 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 记录功能使用（按 IPC 通道名分组）。关闭状态下为空操作 */
  recordFeatureUsage(channel: string): void {
    if (!this.enabled) return;
    this.featureUsage[channel] = (this.featureUsage[channel] ?? 0) + 1;
  }

  /** 记录对话轮次（按日期分组）。关闭状态下为空操作 */
  recordChatTurn(): void {
    if (!this.enabled) return;
    const today = new Date().toISOString().slice(0, 10);
    this.chatTurns[today] = (this.chatTurns[today] ?? 0) + 1;
  }

  /** 记录错误（按位置分组）。关闭状态下为空操作 */
  recordError(location: string): void {
    if (!this.enabled) return;
    this.errors[location] = (this.errors[location] ?? 0) + 1;
  }

  /** 获取当前快照（不持久化） */
  getSnapshot(): UsageStatsSnapshot {
    return {
      since: this.since,
      updatedAt: new Date().toISOString(),
      featureUsage: { ...this.featureUsage },
      chatTurns: { ...this.chatTurns },
      errors: { ...this.errors },
    };
  }

  /** 启动定时批量写入。重复调用安全（已启动时为空操作） */
  startAutoFlush(intervalMs = DEFAULT_FLUSH_INTERVAL_MS): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        logger.debug({ err: toError(err).message }, '使用统计定时写入失败');
      });
    }, intervalMs);
  }

  /** 停止定时批量写入 */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** 持久化当前快照到 JSON 文件。关闭状态下为空操作 */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    try {
      const snapshot = this.getSnapshot();
      await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (err) {
      logger.debug({ err: toError(err).message }, '使用统计写入失败');
    }
  }

  /** 导出快照到 JSON 文件并返回文件路径。无论开关状态均可调用 */
  async export(): Promise<string> {
    const snapshot = this.getSnapshot();
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    return this.filePath;
  }

  /** 从文件加载历史快照（合并到内存计数器） */
  async load(): Promise<UsageStatsSnapshot | null> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const snapshot = JSON.parse(content) as UsageStatsSnapshot;
      if (snapshot.since) this.since = snapshot.since;
      if (snapshot.featureUsage) {
        for (const [k, v] of Object.entries(snapshot.featureUsage)) {
          this.featureUsage[k] = (this.featureUsage[k] ?? 0) + v;
        }
      }
      if (snapshot.chatTurns) {
        for (const [k, v] of Object.entries(snapshot.chatTurns)) {
          this.chatTurns[k] = (this.chatTurns[k] ?? 0) + v;
        }
      }
      if (snapshot.errors) {
        for (const [k, v] of Object.entries(snapshot.errors)) {
          this.errors[k] = (this.errors[k] ?? 0) + v;
        }
      }
      return this.getSnapshot();
    } catch {
      return null;
    }
  }

  /** 清空所有计数器并重置 since 时间 */
  async clear(): Promise<void> {
    this.featureUsage = {};
    this.chatTurns = {};
    this.errors = {};
    this.since = new Date().toISOString();
    try {
      await writeFile(this.filePath, JSON.stringify(this.getSnapshot(), null, 2), 'utf8');
    } catch (err) {
      logger.debug({ err: toError(err).message }, '使用统计清空失败');
    }
  }
}
