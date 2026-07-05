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
import { watch } from 'node:fs';
import { resolve, sep } from 'node:path';
// 合并 memora 导入：加入安全定时器包装，统一追踪定时器生命周期
import { logger, toError, safeSetTimeout, clearSafeTimeout } from 'memora';
import { MS_PER_SECOND } from './constants.js';
import type { SpriteTrigger, TriggerCallback } from './triggers.js';

/** FileWatcherTrigger 配置 */
export interface FileWatcherConfig {
  /** 监听路径列表（绝对路径） */
  watchPaths: string[];
  /** 忽略模式（glob），默认忽略 node_modules / .git / dist */
  ignore?: string[];
  /** 防抖间隔（毫秒），同一文件短时间内多次变化只触发一次，默认 1000 */
  debounceMs?: number;
  /**
   * 允许监听的路径白名单（绝对路径）
   * 仅允许监听位于白名单目录下的路径，防止配置错误导致监听越界
   */
  allowedPaths?: string[];
}

/** 默认防抖间隔（毫秒）：同一文件短时间内多次变化只触发一次（= MS_PER_SECOND） */
const DEFAULT_DEBOUNCE_MS = MS_PER_SECOND;

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
 * 使用 fs.watch 实现零依赖文件监听。
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
  /** 预编译的忽略模式正则缓存（构造函数中一次性编译，避免 shouldIgnore 每次重新编译） */
  private ignoreRegexes: RegExp[];

  constructor(config: FileWatcherConfig) {
    this.config = {
      watchPaths: config.watchPaths,
      ignore: config.ignore ?? DEFAULT_IGNORE,
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      allowedPaths: config.allowedPaths ?? [],
    };
    // 预编译所有忽略模式为正则（构造函数中一次性编译，避免 matchGlob 每次重新编译）
    this.ignoreRegexes = this.config.ignore.map(pattern => this.compileGlob(pattern));
  }

  start(cb: TriggerCallback): void {
    this.callback = cb;

    for (const watchPath of this.config.watchPaths) {
      // 路径白名单校验：防止监听越界路径（如 .. 或 /etc）
      if (!this.isPathAllowed(watchPath)) {
        logger.warn(
          { path: watchPath, allowedPaths: this.config.allowedPaths },
          '文件监听路径越界，已跳过',
        );
        continue;
      }
      try {
        const watcher = this.createWatcher(watchPath);
        this.watchers.push(watcher);
        logger.info({ path: watchPath }, '文件监听已启动');
      } catch (error) {
        logger.warn({ path: watchPath, err: toError(error).message }, '文件监听启动失败');
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
      // 使用 clearSafeTimeout 清理并从注册表中移除
      clearSafeTimeout(timer);
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

    // 监听 error 事件，防止监听目录被删除/权限丢失时触发 uncaughtException 导致进程崩溃
    watcher.on('error', (err) => {
      logger.error({ err, watchPath }, '文件监听器错误，停止该路径监听');
    });

    return watcher;
  }

  /**
   * 检查路径是否在白名单内
   *
   * 与内核 pathGuard 的 assertPathAllowed 逻辑一致（严格前缀匹配，追加 sep 防止兄弟目录绕过）。
   * 若 allowedPaths 为空，则拒绝所有路径（安全优先）。
   */
  private isPathAllowed(absolutePath: string): boolean {
    // 无白名单时拒绝所有路径
    if (this.config.allowedPaths.length === 0) return false;

    const resolved = resolve(absolutePath);
    for (const allowed of this.config.allowedPaths) {
      const allowedRoot = resolve(allowed);
      if (resolved === allowedRoot || resolved.startsWith(allowedRoot + sep)) {
        return true;
      }
    }
    return false;
  }

  /** 检查文件名是否匹配忽略模式（使用预编译正则缓存） */
  private shouldIgnore(filename: string): boolean {
    for (const regex of this.ignoreRegexes) {
      if (regex.test(filename)) return true;
    }
    return false;
  }

  /** 简易 glob 编译为正则（仅支持 ** 和 *） */
  private compileGlob(pattern: string): RegExp {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义正则特殊字符
      .replace(/\*\*/g, '§§')  // 临时标记 **
      .replace(/\*/g, '[^/]*')  // * 匹配非路径分隔符
      .replace(/§§/g, '.*');    // ** 匹配任意
    return new RegExp(regexStr);
  }

  /** 防抖发射触发事件 */
  private debouncedEmit(filename: string, eventType: string): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) clearSafeTimeout(existing);

    // 使用 safeSetTimeout 替代原生 setTimeout，便于统一追踪定时器生命周期
    const timer = safeSetTimeout(() => {
      this.debounceTimers.delete(filename);
      this.callback?.({
        reason: `文件变化：${filename}（${eventType}）`,
        source: this.name,
      });
    }, this.config.debounceMs);

    this.debounceTimers.set(filename, timer);
  }
}