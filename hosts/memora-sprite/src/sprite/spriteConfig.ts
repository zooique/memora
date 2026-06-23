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
import { resolve, dirname } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

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
  /** 浮动图标位置（屏幕坐标），默认 { x: -1, y: -1 } 表示使用 DEFAULT_FLOAT_POSITION */
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
  /**
   * UX-FD-12 界面主题，默认 'light'。持久化到 sprite.json，localStorage 仅作为内联脚本缓存
   * P3-FLOW-12 新增 'auto' 跟随系统主题
   */
  theme?: 'light' | 'dark' | 'auto';
}

/** 配置键名联合类型 */
export type SpriteConfigKey = keyof SpriteConfig;

/**
 * 配置字段类型 schema 映射表
 *
 * 用于 setConfigField 的运行时类型校验，替代 80 行 if-else 链。
 * 新增配置字段只需在此表加一行映射，无需修改 setConfigField 逻辑。
 *
 * 类型含义：
 *   - 'number'：数值类型
 *   - 'boolean'：布尔类型
 *   - 'string'：字符串类型
 *   - 'string[]'：字符串数组类型
 *   - 'object'：对象类型（需额外校验子字段）
 *   - 'enum:val1|val2'：枚举类型，值为竖线分隔的合法值
 */
export const CONFIG_FIELD_SCHEMA: Record<SpriteConfigKey, string> = {
  configVersion: 'number',
  triggerIntervalMs: 'number',
  defaultPersona: 'string',
  silentMode: 'boolean',
  proactiveThreshold: 'number',
  proactiveCooldownMs: 'number',
  fileWatcherEnabled: 'boolean',
  fileWatcherPaths: 'string[]',
  fileWatcherIgnore: 'string[]',
  fileWatcherDebounceMs: 'number',
  floatIconPosition: 'object',
  windowState: 'enum:tray|full',
  showFloatBubble: 'boolean',
  projectMode: 'enum:smart|focus',
  focusProjectPath: 'string',
  windowBounds: 'object',
  silentModeExpiresAt: 'string',
  theme: 'enum:light|dark|auto',
};

/** 内置默认值 */
export const DEFAULT_SPRITE_CONFIG: Required<SpriteConfig> = {
  configVersion: 2,
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
  theme: 'light',
};

/** 配置文件名 */
const CONFIG_FILENAME = 'sprite.json';

/** 当前最新配置版本号（与 DEFAULT_SPRITE_CONFIG.configVersion 保持一致） */
const CURRENT_CONFIG_VERSION = 2;

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
  // UX-FD-12 v1→v2：新增 theme 字段，默认 'light'
  1: (config) => {
    return { ...config, theme: 'light' };
  },
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
    const migrated = runMigrations(merged);

    // UX-PP-19 迁移后立即持久化，避免下次启动重复执行迁移
    if (migrated.configVersion !== merged.configVersion) {
      saveSpriteConfig(dataDir, migrated);
    }

    return migrated;
  } catch {
    // 文件损坏，静默回退
    return { ...DEFAULT_SPRITE_CONFIG };
  }
}

/**
 * 保存精灵配置
 *
 * 合并写入：保留文件中已有但当前接口未定义的字段（向前兼容）。
 *
 * R6 优化：当传入的配置包含所有 DEFAULT_SPRITE_CONFIG 的键时，
 * 认为是"完整配置"（来自 Sprite.updateConfig），跳过读文件直接写入。
 * 仅传入部分字段时（如 CLI 直接调用），仍读文件合并。
 */
export function saveSpriteConfig(dataDir: string, config: SpriteConfig): void {
  const filePath = resolve(dataDir, CONFIG_FILENAME);

  // R6 判断是否为完整配置（包含所有默认键），避免每次读文件
  const isFullConfig = Object.keys(DEFAULT_SPRITE_CONFIG).every(
    (key) => key in config,
  );

  let merged: Record<string, unknown>;
  if (isFullConfig) {
    // 完整配置：直接写入，无需读文件
    merged = { ...config };
  } else {
    // 部分配置：读文件合并（向前兼容）
    let existing: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (isPlainObject(parsed)) {
          existing = parsed;
        }
      } catch {
        // 文件损坏，从空开始
      }
    }
    merged = { ...existing, ...config };
  }

  // 确保目录存在（首次运行时 dataDir 可能尚未创建，如 ~/.memora-sprite/data/）
  // 否则 writeFileSync 会抛 ENOENT
  mkdirSync(dirname(filePath), { recursive: true });

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

/**
 * 应用配置字段更新（纯函数，原地修改 config）
 *
 * 根据 CONFIG_FIELD_SCHEMA 校验 value 类型，符合则写入 config[key]，
 * 不符合则忽略（保持原值）。
 *
 * P2-S3 重构：从 Sprite.setConfigField 提取为纯函数，配置逻辑集中到 spriteConfig.ts。
 * P1-5 修复：windowBounds 允许设为 null（清除窗口边界）。
 *
 * @param config - 配置对象（原地修改）
 * @param key - 配置字段名
 * @param value - 新值
 * @returns 是否成功设置（类型校验通过）
 */
export function applyConfigField(
  config: Required<SpriteConfig>,
  key: SpriteConfigKey,
  value: unknown,
): boolean {
  const schema = CONFIG_FIELD_SCHEMA[key];
  // 使用 Record<string, unknown> 绕过 TypeScript 对动态 key 赋值的类型检查
  // 运行时类型校验由 schema 映射表保证，编译时无法推断动态 key 的具体类型
  const target = config as Record<string, unknown>;

  // 数值类型
  if (schema === 'number') {
    if (typeof value === 'number') {
      target[key] = value;
      return true;
    }
    return false;
  }

  // 布尔类型
  if (schema === 'boolean') {
    if (typeof value === 'boolean') {
      target[key] = value;
      return true;
    }
    return false;
  }

  // 字符串类型
  if (schema === 'string') {
    if (typeof value === 'string') {
      target[key] = value;
      return true;
    }
    return false;
  }

  // 字符串数组类型
  if (schema === 'string[]') {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      target[key] = value;
      return true;
    }
    return false;
  }

  // 对象类型（需额外校验子字段）
  if (schema === 'object') {
    // P1-5 修复：windowBounds 允许设为 null（清除窗口边界）
    if (value === null && (key === 'windowBounds' || key === 'silentModeExpiresAt')) {
      target[key] = null;
      return true;
    }
    if (typeof value === 'object' && value !== null) {
      // floatIconPosition：校验 x/y 为 number
      if (key === 'floatIconPosition') {
        const pos = value as { x: unknown; y: unknown };
        if ('x' in value && 'y' in value && typeof pos.x === 'number' && typeof pos.y === 'number') {
          target[key] = { x: pos.x, y: pos.y };
          return true;
        }
      }
      // windowBounds：校验 x/y/width/height 为 number
      if (key === 'windowBounds') {
        const b = value as { x: unknown; y: unknown; width: unknown; height: unknown };
        if ('x' in value && 'y' in value && 'width' in value && 'height' in value
          && typeof b.x === 'number' && typeof b.y === 'number'
          && typeof b.width === 'number' && typeof b.height === 'number') {
          target[key] = { x: b.x, y: b.y, width: b.width, height: b.height };
          return true;
        }
      }
    }
    return false;
  }

  // 枚举类型（格式：'enum:val1|val2|val3'）
  if (schema.startsWith('enum:')) {
    const allowedValues = schema.slice(5).split('|');
    if (typeof value === 'string' && allowedValues.includes(value)) {
      target[key] = value;
      return true;
    }
    return false;
  }

  return false;
}
