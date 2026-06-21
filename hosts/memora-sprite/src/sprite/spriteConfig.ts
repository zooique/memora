/**
 * 精灵配置持久化 — sprite.json 读写
 *
 * 配置文件位于 dataDir/sprite.json（与 memora.db 同级，Agent 级共享）。
 * 启动时加载，偏好变更时自动保存。
 *
 * 设计原则：
 *   - 所有字段可选，缺失时使用内置默认值
 *   - 保存时合并（不覆盖未知字段，向前兼容）
 *   - 文件损坏时静默回退到默认值
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/** 精灵持久化配置 */
export interface SpriteConfig {
  /** 配置版本号，用于迁移管理。默认 1（初始版本），递增时触发对应迁移函数 */
  configVersion?: number;
  /** 定时触发器间隔（毫秒），默认 3_600_000（1 小时） */
  triggerIntervalMs?: number;
  /** 默认角色名称，启动时自动切换 */
  defaultPersona?: string;
  /** 静默模式：不发射 proactivePrompt 事件，默认 false */
  silentMode?: boolean;
  /** 主动提示累积阈值，默认 3 */
  proactiveThreshold?: number;
  /** 主动提示冷却时间（毫秒），默认 300_000（5 分钟） */
  proactiveCooldownMs?: number;
  /** 文件监听是否启用，默认 true */
  fileWatcherEnabled?: boolean;
  /** 文件监听路径（相对于 projectPath），默认 ['.'] */
  fileWatcherPaths?: string[];
  /** 文件监听忽略模式（glob），默认 node_modules/.git/dist */
  fileWatcherIgnore?: string[];
  /** 文件监听防抖时间（毫秒），默认 1000 */
  fileWatcherDebounceMs?: number;
  /** 浮动图标位置（屏幕坐标），默认 { x: -1, y: -1 } 表示首次启动居中 */
  floatIconPosition?: { x: number; y: number };
  /** 窗口状态（持久化），默认 'tray'。仅支持 tray/full 二态，float 已独立为 showFloatBubble */
  windowState?: 'tray' | 'full';
  /** 是否显示浮动气泡（桌面小部件），默认 true。仅当 windowState === 'tray' 时生效 */
  showFloatBubble?: boolean;
  /**
   * 项目模式（FD-04）：
   * - 'smart'（默认）：智能模式，监听启动时的 projectPath，未来可扩展多项目自动识别
   * - 'focus'：专注模式，锁定 focusProjectPath 指定的项目，其他项目的文件变化被忽略
   */
  projectMode?: 'smart' | 'focus';
  /** 专注模式锁定的项目路径（绝对路径），仅 projectMode='focus' 时生效 */
  focusProjectPath?: string;
  /** FD-05 完整窗口的边界（屏幕坐标 + 尺寸），启动时恢复。null 表示使用默认大小并居中 */
  windowBounds?: { x: number; y: number; width: number; height: number } | null;
  /** FD-10 静默模式恢复时间（ISO 8601），过期后自动关闭静默模式。null 表示无定时恢复 */
  silentModeExpiresAt?: string | null;
}

/** 配置键名联合类型 */
export type SpriteConfigKey = keyof SpriteConfig;

/** 毫秒/分钟转换常量（从 constants.ts 重新导出，保持对旧导入者的兼容） */
export { MS_PER_MINUTE } from './constants.js';

/** 内置默认值 */
export const DEFAULT_SPRITE_CONFIG: Required<SpriteConfig> = {
  configVersion: 1,
  triggerIntervalMs: 3_600_000,
  defaultPersona: '',
  silentMode: false,
  proactiveThreshold: 3,
  proactiveCooldownMs: 300_000,
  fileWatcherEnabled: true,
  fileWatcherPaths: ['.'],
  fileWatcherIgnore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.memora/**'],
  fileWatcherDebounceMs: 1_000,
  floatIconPosition: { x: -1, y: -1 },
  windowState: 'tray',
  showFloatBubble: true,
  projectMode: 'smart',
  focusProjectPath: '',
  windowBounds: null,
  silentModeExpiresAt: null,
};

/** 配置文件名 */
const CONFIG_FILENAME = 'sprite.json';

/** 当前最新配置版本号（与 DEFAULT_SPRITE_CONFIG.configVersion 保持一致） */
const CURRENT_CONFIG_VERSION = 1;

/**
 * 配置迁移映射表
 *
 * 键为迁移前的版本号，值为迁移函数（接收配置，返回迁移后的配置）。
 * 迁移链按版本号递增顺序执行：v1→v2→v3→...→CURRENT。
 *
 * 设计原则：
 *   - 每个迁移函数独立、幂等，仅处理对应版本的变更
 *   - 新增字段时，在此处添加迁移条目并递增 CURRENT_CONFIG_VERSION
 *   - 示例见下方注释中的 v1→v2 模板
 */
const MIGRATIONS: Record<number, (config: Required<SpriteConfig>) => SpriteConfig> = {
  // 示例：当 CURRENT_CONFIG_VERSION = 2 时，取消注释以下迁移
  // 1: (config) => {
  //   // v1→v2：新增 xxx 字段，默认值 xxx
  //   return config;
  // },
};

/**
 * 执行配置迁移链
 *
 * 从当前配置的版本号开始，依次执行迁移函数，直到最新版本。
 * 迁移后更新 configVersion 字段。无迁移需求时直接返回原配置。
 */
function runMigrations(config: Required<SpriteConfig>): Required<SpriteConfig> {
  let current = config.configVersion ?? 0;
  let migrated = { ...config };

  while (current < CURRENT_CONFIG_VERSION) {
    const migrateFn = MIGRATIONS[current];
    if (migrateFn) {
      // 迁移函数接收完整配置，返回迁移后的配置（可能有新字段）
      migrated = migrateFn(migrated) as Required<SpriteConfig>;
    }
    current++;
  }

  migrated.configVersion = CURRENT_CONFIG_VERSION;
  return migrated;
}

/**
 * 加载精灵配置
 *
 * 文件不存在或损坏时返回默认值，不抛错。
 */
export function loadSpriteConfig(dataDir: string): Required<SpriteConfig> {
  const filePath = resolve(dataDir, CONFIG_FILENAME);

  if (!existsSync(filePath)) {
    return { ...DEFAULT_SPRITE_CONFIG };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SpriteConfig;
    const merged = { ...DEFAULT_SPRITE_CONFIG, ...parsed };

    // 迁移：旧版 windowState='float' 转换为 tray + showFloatBubble
    if ((merged.windowState as string) === 'float') {
      merged.windowState = 'tray';
      // 仅当用户未显式设置 showFloatBubble 时才设为 true（避免覆盖已有偏好）
      if (parsed.showFloatBubble === undefined) {
        merged.showFloatBubble = true;
      }
    }

    // FD-11 执行配置版本迁移链（v1→v2→...→CURRENT）
    return runMigrations(merged);
  } catch {
    // 文件损坏，静默回退
    return { ...DEFAULT_SPRITE_CONFIG };
  }
}

/**
 * 保存精灵配置
 *
 * 合并写入：保留文件中已有但当前接口未定义的字段（向前兼容）。
 */
export function saveSpriteConfig(dataDir: string, config: SpriteConfig): void {
  const filePath = resolve(dataDir, CONFIG_FILENAME);

  // 读取已有配置（向前兼容）
  let existing: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
      // P2-005 修复：添加类型守卫，避免 sprite.json 被篡改为非对象类型时
      // 展开操作产生异常行为（如数组或原始值）
      if (isPlainObject(parsed)) {
        existing = parsed;
      }
    } catch {
      // 文件损坏，从空开始
    }
  }

  const merged = { ...existing, ...config };
  // 设置 0o600 权限：仅文件所有者可读写
  // sprite.json 含 focusProjectPath 等路径信息，与 config.json（含 apiKey）保持一致的权限保护
  writeFileSync(filePath, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * 类型守卫：判断值是否为普通对象（非数组、非 null）
 *
 * 用于校验 JSON.parse 的结果，避免对非对象类型执行展开操作。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
