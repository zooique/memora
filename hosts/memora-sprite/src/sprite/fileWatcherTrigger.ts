/**
 * 文件变化触发器 — 上下文感知而非内容感知（ADR-SP-004 阶段二）
 *
 * 监听项目目录的文件变化，发射触发事件。
 * 只感知"哪个文件变了"，不感知"文件内容是什么"。
 *
 * 遵循 ADR-SP-004 安全原则：
 *   - 不读取文件内容
 *   - 不监听键盘输入
 *   - 不监听剪贴板
 */
import type { SpriteTrigger, TriggerCallback } from './triggers.js';
import { logger } from 'memora';
import { watch } from 'node:fs';

/** FileWatcherTrigger 配置 */
export interface FileWatcherConfig {
  /** 监听路径列表（绝对路径） */
  watchPaths: string[];
  /** 忽略模式（glob），默认忽略 node_modules / .git / dist */
  ignore?: string[];
  /** 防抖间隔（毫秒），同一文件短时间内多次变化只触发一次，默认 1000 */
  debounceMs?: number;
}

/** 默认忽略模式 */
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.memora/**',
];

/**
 * 文件变化触发器
 *
 * 使用 fs.watch / fs.watchFile 实现零依赖文件监听。
 * 不引入 chokidar 以保持零 native 依赖（chokidar v4+ 已是纯 JS）。
 * 如需更强大的文件监听，宿主可自行替换为 chokidar 实现。
 */
export class FileWatcherTrigger implements SpriteTrigger {
  readonly name = 'fileWatcher';
  private callback: TriggerCallback | null = null;
  private watchers: Array<{ close(): void }> = [];
  private config: Required<FileWatcherConfig>;
  /** 防抖计时器 */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config: FileWatcherConfig) {
    this.config = {
      watchPaths: config.watchPaths,
      ignore: config.ignore ?? DEFAULT_IGNORE,
      debounceMs: config.debounceMs ?? 1000,
    };
  }

  start(cb: TriggerCallback): void {
    this.callback = cb;

    for (const watchPath of this.config.watchPaths) {
      try {
        const watcher = this.createWatcher(watchPath);
        this.watchers.push(watcher);
        logger.info({ path: watchPath }, '文件监听已启动');
      } catch (err) {
        logger.warn({ path: watchPath, err: (err as Error).message }, '文件监听启动失败');
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    // 清理防抖计时器
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.callback = null;
  }

  /** 创建 fs.watch 监听器 */
  private createWatcher(watchPath: string): { close(): void } {
    const watcher = watch(watchPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // 检查忽略模式
      if (this.shouldIgnore(filename)) return;

      // 防抖：同一文件短时间内多次变化只触发一次
      this.debouncedEmit(filename, eventType);
    });

    return watcher;
  }

  /** 检查文件名是否匹配忽略模式 */
  private shouldIgnore(filename: string): boolean {
    for (const pattern of this.config.ignore) {
      // 简单的 glob 匹配：支持 ** 和 * 通配符
      if (this.matchGlob(filename, pattern)) return true;
    }
    return false;
  }

  /** 简易 glob 匹配（仅支持 ** 和 *） */
  private matchGlob(str: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符
      .replace(/\*\*/g, '§§')  // 临时标记 **
      .replace(/\*/g, '[^/]*')  // * 匹配非路径分隔符
      .replace(/§§/g, '.*');    // ** 匹配任意
    const regex = new RegExp(regexStr);
    return regex.test(str);
  }

  /** 防抖发射触发事件 */
  private debouncedEmit(filename: string, eventType: string): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filename);
      this.callback?.({
        reason: `文件变化：${filename}（${eventType}）`,
        source: this.name,
      });
    }, this.config.debounceMs);

    this.debounceTimers.set(filename, timer);
  }
}
