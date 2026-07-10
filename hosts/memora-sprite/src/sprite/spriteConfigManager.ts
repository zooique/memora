/**
 * 精灵配置管理器 — 配置持久化 + 每日消息计数
 *
 * 从 sprite.ts 拆分出的独立模块，负责：
 *   1. 配置 CRUD（单项更新 + 批量事务性更新）
 *   2. 每日消息计数（加载/累加/查询）
 *   3. 配置格式化
 *
 * 副作用（文件监听重建、触发器重启、主动引擎更新等）通过回调注入，
 * 由 Sprite 门面负责编排。ConfigManager 本身是纯数据管理器。
 */
import { logger, toError } from 'memora';
import { saveSpriteConfig, applyConfigField, DEFAULT_SPRITE_CONFIG, type SpriteConfig, type SpriteConfigKey } from './spriteConfig.js';
import { MS_PER_DAY, getLocalDate } from './constants.js';
import * as cliFormatter from './cli/formatter.js';

/** 每日消息计数保留窗口（天），与 reviewManager 的 7 天趋势窗口对齐 */
const DAILY_MESSAGE_COUNT_WINDOW_DAYS = 7;

/**
 * 配置副作用回调集合
 * 由 Sprite 门面在构造时注入，ConfigManager 在配置变更时调用
 */
export interface ConfigSideEffects {
  /** 触发器间隔变更 */
  onTriggerIntervalChanged: (ms: number) => void;
  /** 文件监听配置变更（任一 fileWatcher* 键） */
  onFileWatcherChanged: (rebuild: boolean) => void;
  /** 主动提示配置变更 */
  onProactiveConfigChanged: (threshold: number, cooldownMs: number, silentMode: boolean) => void;
  /** 项目模式变更 */
  onProjectModeChanged: () => Promise<void>;
  /** 归档模式变更 */
  onArchiveModeChanged: (mode: string) => void;
}

/**
 * 精灵配置管理器
 *
 * 管理 SpriteConfig 的读取、写入、持久化和每日消息计数。
 * 不持有 triggerBus / agent 等运行时依赖——副作用通过回调委托给 Sprite 门面。
 */
export class SpriteConfigManager {
  private config: Required<SpriteConfig>;
  private sideEffects: ConfigSideEffects;
  /** 每日用户消息计数（内存态 Map，key=YYYY-MM-DD） */
  private dailyMessageCount: Map<string, number> = new Map();

  constructor(config: Required<SpriteConfig>, sideEffects: ConfigSideEffects) {
    this.config = config;
    this.sideEffects = sideEffects;
    // 从持久化配置加载每日消息计数到内存 Map
    this.loadDailyMessageCount();
  }

  /** 获取当前配置（只读副本） */
  getConfig(): Readonly<Required<SpriteConfig>> {
    return { ...this.config };
  }

  /**
   * 更新配置项并持久化
   *
   * 类型安全写入：通过分支判断将 unknown 类型的 value 赋给对应类型的配置字段。
   * 副作用通过回调委托给 Sprite 门面。
   */
  updateConfig(key: SpriteConfigKey, value: unknown): void {
    this.setConfigField(key, value);
    // 完整配置写入，避免每次读文件
    saveSpriteConfig(this.config);

    // 触发器间隔变更 → 重建 TimerTrigger
    if (key === 'triggerIntervalMs' && typeof value === 'number') {
      this.sideEffects.onTriggerIntervalChanged(value);
    }

    // 文件监听启用/禁用 → 重建 FileWatcherTrigger
    if (key === 'fileWatcherEnabled') {
      this.sideEffects.onFileWatcherChanged(true);
    }

    // 文件监听路径/忽略/防抖变更 → 仅在已启用时重建
    if (
      key === 'fileWatcherPaths' ||
      key === 'fileWatcherIgnore' ||
      key === 'fileWatcherDebounceMs'
    ) {
      this.sideEffects.onFileWatcherChanged(this.config.fileWatcherEnabled);
    }

    // 主动提示配置变更 → 更新 ProactiveEngine
    if (key === 'proactiveThreshold' || key === 'proactiveCooldownMs' || key === 'silentMode') {
      this.sideEffects.onProactiveConfigChanged(
        this.config.proactiveThreshold,
        this.config.proactiveCooldownMs,
        this.config.silentMode,
      );
    }

    // 项目模式/路径变更 → 切换 Agent 上下文
    if (key === 'projectMode' || key === 'focusProjectPath') {
      this.sideEffects.onProjectModeChanged();
    }

    // 归档模式变更 → 应用到 Agent
    if (key === 'archiveMode') {
      this.sideEffects.onArchiveModeChanged(this.config.archiveMode);
    }
  }

  /**
   * 批量更新配置并持久化（事务性保证）
   *
   * 原子性：任一 key 非法或 value 类型校验失败时，全部更新不应用。
   * 单次持久化：仅调用一次 saveSpriteConfig。
   * 副作用去重：批量内涉及同类副作用只触发一次。
   */
  updateConfigBatch(updates: Partial<SpriteConfig>): { updated: boolean; error?: string } {
    const keys = Object.keys(updates) as SpriteConfigKey[];

    // 空批量：直接成功（幂等）
    if (keys.length === 0) {
      return { updated: true };
    }

    // 校验阶段：在 config 浅副本上校验，不修改真实 config
    const configCopy: Required<SpriteConfig> = { ...this.config };
    for (const key of keys) {
      if (!(key in DEFAULT_SPRITE_CONFIG)) {
        return { updated: false, error: `非法配置键：${key}` };
      }
      const ok = applyConfigField(configCopy, key, updates[key]);
      if (!ok) {
        return { updated: false, error: `配置值类型非法：${key}` };
      }
    }

    // 应用阶段：校验全部通过，逐个写入真实 config
    for (const key of keys) {
      this.setConfigField(key, updates[key]);
    }

    // 持久化：仅一次写盘
    saveSpriteConfig(this.config);

    // 副作用统一触发（去重，每类副作用只触发一次）
    this.triggerBatchSideEffects(keys, updates);

    return { updated: true };
  }

  /**
   * 批量更新后统一触发副作用（同类副作用只触发一次）
   *
   * @param keys 本次更新的配置键列表
   * @param updates 原始更新对象（用于读取新值）
   */
  private triggerBatchSideEffects(keys: SpriteConfigKey[], updates: Partial<SpriteConfig>): void {
    const keySet = new Set<string>(keys);

    if (keySet.has('triggerIntervalMs') && typeof updates.triggerIntervalMs === 'number') {
      this.sideEffects.onTriggerIntervalChanged(updates.triggerIntervalMs);
    }

    if (
      keySet.has('fileWatcherEnabled') ||
      keySet.has('fileWatcherPaths') ||
      keySet.has('fileWatcherIgnore') ||
      keySet.has('fileWatcherDebounceMs')
    ) {
      this.sideEffects.onFileWatcherChanged(true);
    }

    if (
      keySet.has('proactiveThreshold') ||
      keySet.has('proactiveCooldownMs') ||
      keySet.has('silentMode')
    ) {
      this.sideEffects.onProactiveConfigChanged(
        this.config.proactiveThreshold,
        this.config.proactiveCooldownMs,
        this.config.silentMode,
      );
    }

    if (keySet.has('projectMode') || keySet.has('focusProjectPath')) {
      void this.sideEffects.onProjectModeChanged();
    }
  }

  /** 类型安全地设置配置字段 */
  private setConfigField(key: SpriteConfigKey, value: unknown): void {
    applyConfigField(this.config, key, value);
  }

  /** 格式化配置为可读文本 */
  formatConfig(): string {
    return cliFormatter.formatConfig(this.config);
  }

  // ─── 每日消息计数 ──────────────────────────────

  /**
   * 从持久化配置加载每日消息计数到内存 Map
   * 仅保留最近 7 天，更早日数在加载时剔除
   */
  private loadDailyMessageCount(): void {
    const stored = this.config.dailyMessageCount;
    const cutoff = Date.now() - DAILY_MESSAGE_COUNT_WINDOW_DAYS * MS_PER_DAY;
    for (const [date, count] of Object.entries(stored)) {
      const ts = new Date(date).getTime();
      if (isNaN(ts) || ts < cutoff) continue;
      this.dailyMessageCount.set(date, count);
    }
  }

  /**
   * 累加当日用户消息计数
   * 累加后同步持久化到 sprite.json
   */
  incrementDailyMessageCount(): void {
    const today = getLocalDate();
    const current = this.dailyMessageCount.get(today) ?? 0;
    this.dailyMessageCount.set(today, current + 1);

    const record: Record<string, number> = {};
    for (const [date, count] of this.dailyMessageCount) {
      record[date] = count;
    }
    this.config.dailyMessageCount = record;
    try {
      saveSpriteConfig(this.config);
    } catch (err) {
      logger.warn({ err: toError(err).message }, '每日消息计数持久化失败');
    }
  }

  /** 获取最近 7 天每日消息计数 */
  getDailyMessageCounts(): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [date, count] of this.dailyMessageCount) {
      record[date] = count;
    }
    return record;
  }
}