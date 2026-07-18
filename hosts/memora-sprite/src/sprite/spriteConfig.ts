/**
 * 精灵配置持久化 — sprite.json 读写
 *
 * 配置文件位于 ~/.memora-sprite/sprite.json（根级，与 data/ 和 config/ 同级）。
 * 启动时加载，偏好变更时自动保存。
 *
 * 目录分层：
 *   ~/.memora-sprite/
 *   ├── config.json      ← LLM 配置（根级）
 *   ├── sprite.json      ← 精灵配置（根级）
 *   ├── config/          ← Agent 级配置（rules/skills/personas）
 *   └── data/            ← 用户记忆（memora.db/workspace）
 *
 * 设计原则：
 *   - 所有字段可选，缺失时使用内置默认值
 *   - 保存时合并（不覆盖未知字段，向前兼容）
 *   - 文件损坏时静默回退到默认值
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
// logger/toError/isPlainObject：日志 + 错误归一化 + 对象类型守卫（消费内核已提取工具）
// isPlainObject 用于 validateObjectField 校验 JSON.parse 结果是否为纯对象（H4-E）
import { logger, toError, isPlainObject } from 'memora';
// safeWriteJsonSync 统一 JSON 写入（mkdir + 0o600 权限，消除本地手写三件套）
import { safeWriteJsonSync } from '../shared/safeWriteJson.js';
// 导入 SPRITE_HOME_DIR_NAME（路径真理源），消除硬编码重复
import { SPRITE_HOME_DIR_NAME, MS_PER_HOUR } from './constants.js';
// 从 shared/ 导入 DEFAULT_SHORTCUTS 和 ShortcutConfig（单一真理源，消除与 settingsController.ts 的重复）
import { DEFAULT_SHORTCUTS } from '../shared/shortcutDefaults.js';
import type { ShortcutConfig } from '../shared/shortcutDefaults.js';
// 导入 glob 校验函数，用于 fileWatcherIgnore 配置保存前校验
import { validateGlob } from './fileWatcherTrigger.js';

/** 精灵持久化配置 */
export interface SpriteConfig {
  /** 配置版本号，用于迁移管理。默认 1（初始版本），递增时触发对应迁移函数 */
  configVersion?: number;
  /** 定时触发器间隔（毫秒），默认 3_600_000（1 小时） */
  triggerIntervalMs?: number;
  /** 默认角色名称，启动时自动切换 */
  defaultPersona?: string;
  /**
   * 角色匹配模式，默认 'auto'
   *
   * - 'auto'：自动模式，postProcessInner 中由 personaMatcher 基于对话上下文自动匹配角色
   * - 'manual'：手动模式，仅响应 UI 手动切换，不自动匹配
   *
   * 持久化到 sprite.json，启动时读取并应用到 PersonaManager.setMode()，
   * 运行时通过设置面板切换（sprite.setPersonaMode()）。
   */
  personaMode?: 'auto' | 'manual';
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
   * 项目模式：
   * - 'smart'（默认）：智能模式，监听启动时的 projectPath，未来可扩展多项目自动识别
   * - 'focus'：专注模式，锁定 focusProjectPath 指定的项目，其他项目的文件变化被忽略
   */
  projectMode?: 'smart' | 'focus';
  /** 专注模式锁定的项目路径（绝对路径），仅 projectMode='focus' 时生效 */
  focusProjectPath?: string;
  /** 完整窗口的边界（屏幕坐标 + 尺寸），启动时恢复。null 表示使用默认大小并居中 */
  windowBounds?: { x: number; y: number; width: number; height: number } | null;
  /** 静默模式恢复时间（ISO 8601），过期后自动关闭静默模式。null 表示无定时恢复 */
  silentModeExpiresAt?: string | null;
  /**
   * 界面主题，默认 'light'。持久化到 sprite.json，localStorage 仅作为内联脚本缓存
   * 新增 'auto' 跟随系统主题
   */
  theme?: 'light' | 'dark' | 'auto';
  /**
   * Phase 3.3 全局快捷键配置
   *
   * 持久化到 sprite.json，支持热更新（不重启应用即可修改快捷键）。
   * accelerators 是 action → accelerator 映射，action 为开放字符串（遵循 ADR-004）。
   */
  shortcuts?: ShortcutConfig;
  /**
   * 归档模式（ADR-015），默认 'full'
   *
   * - 'full'：profile facts + insight 自动归档（对话原始内容待 GAP-2 实现后自动）
   * - 'insights-only'：profile facts + insight 自动归档，对话原始内容需手动
   * - 'manual'：所有归档都需手动触发
   *
   * 持久化到 sprite.json，启动时读取传入 Agent 构造参数，
   * 运行时可通过设置面板切换（agent.setArchiveMode()）。
   */
  archiveMode?: 'full' | 'insights-only' | 'manual';
  /**
   * 每日用户消息计数（补齐 ReviewData.today.messageCount 数据断点）
   *
   * - key：本地日期 YYYY-MM-DD（使用 getLocalDate()，避免东八区凌晨错位）
   * - value：当日用户发送的消息条数
   *
   * 仅保留最近 7 天，更早日数在累加时自动剔除（防止无限增长）。
   * 每次累加同步持久化到 sprite.json（用户消息频率低，writeFileSync 开销可忽略）。
   */
  dailyMessageCount?: Record<string, number>;
  /**
   * 回收站保留天数，默认 30
   *
   * 软删除记忆超过此天数后，由定时器自动调用 purgeExpired 彻底清理。
   * 设为 0 表示禁用自动清理（仅手动 purge）。
   * 持久化到 sprite.json，用户可在设置面板调整。
   */
  recycleBinRetentionDays?: number;
  /**
   * 使用统计采集是否开启（AUDIT-5-4 隐私合规）
   *
   * - false（默认）：不采集任何数据
   * - true：采集匿名使用计数（功能使用次数/对话轮次/错误次数）
   *
   * 不采集对话内容、记忆内容、项目路径或文件内容。
   * 数据仅存储在本地，不会上传到任何服务器。
   */
  usageStatsEnabled?: boolean;

  /**
   * 已通知的记忆量级列表（ProactiveEngine 里程碑幂等保护）
   *
   * 记录已触发过"上百条/上千条/..."里程碑通知的量级（Math.log10(total) 取整）。
   * 持久化避免重启后重复触发同一量级里程碑。重启后首次 dashboard 调用初始化已知集合，
   * 后续仅在新量级突破时触发。
   */
  proactiveNoticedMagnitudes?: number[];
  /**
   * 已知 source 类型集合（ProactiveEngine 里程碑幂等保护）
   *
   * 记录已出现的记忆来源（如 chat/insight/profile/rule）。
   * 持久化避免重启后对已有 source 重复触发"首次从 X 提取记忆"里程碑。
   */
  proactiveKnownSources?: string[];
  /**
   * 上次用户拒绝主动提示的时间戳（ProactiveEngine 自适应冷却衰减）
   *
   * 用于时间衰减机制：连续拒绝次数在距上次拒绝超过 24h 后自动 -1，
   * 破解"连拒 10 次后冷却永久 6x 死锁"。null 表示从未拒绝过。
   */
  proactiveLastRejectAt?: number | null;
}

/**
 * 全局快捷键配置结构（单一真理源，shortcuts.ts / main.ts 均引用此类型）
 *
 * 持久化到 sprite.json，支持热更新（不重启应用即可修改快捷键）。
 * accelerators 是 action → accelerator 映射，action 为开放字符串（遵循 ADR-004）。
 *
 * ShortcutConfig 接口和 DEFAULT_SHORTCUTS 常量已迁移到
 * shared/shortcutDefaults.ts（纯类型+纯数据，无 Node 依赖），
 * 此处重新导出保持向后兼容（shortcuts.ts / configHandlers.ts 等仍从此处导入）。
 */
export type { ShortcutConfig } from '../shared/shortcutDefaults.js';

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
  personaMode: 'enum:auto|manual',
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
  shortcuts: 'object',
  archiveMode: 'enum:full|insights-only|manual',
  dailyMessageCount: 'object',
  // 回收站保留天数（number，0 禁用自动清理）
  recycleBinRetentionDays: 'number',
  // 使用统计开关（AUDIT-5-4 隐私合规，默认关闭）
  usageStatsEnabled: 'boolean',
  // ProactiveEngine 里程碑幂等保护（已通知量级 + 已知 source）
  proactiveNoticedMagnitudes: 'number[]',
  proactiveKnownSources: 'string[]',
  // ProactiveEngine 自适应冷却衰减（上次拒绝时间戳，null 表示从未拒绝）
  proactiveLastRejectAt: 'number',
};

/** 内置默认值 */
export const DEFAULT_SPRITE_CONFIG: Required<SpriteConfig> = {
  configVersion: 3,
  triggerIntervalMs: MS_PER_HOUR,
  defaultPersona: '',
  personaMode: 'auto',
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
  // 引用 shared/shortcutDefaults.ts 的 DEFAULT_SHORTCUTS（单一真理源）
  shortcuts: DEFAULT_SHORTCUTS,
  archiveMode: 'full',
  // 默认空对象，由 Sprite.incrementDailyMessageCount 累加填充
  dailyMessageCount: {},
  // 回收站默认保留 30 天，超过后定时器自动彻底清理
  recycleBinRetentionDays: 30,
  // 使用统计默认关闭（AUDIT-5-4 隐私合规，需用户显式开启）
  usageStatsEnabled: false,
  // ProactiveEngine 里程碑状态默认空集合（首次启动无已通知量级/已知 source）
  proactiveNoticedMagnitudes: [],
  proactiveKnownSources: [],
  // ProactiveEngine 上次拒绝时间戳默认 null（从未拒绝）
  proactiveLastRejectAt: null,
};

/** 配置文件名 */
const CONFIG_FILENAME = 'sprite.json';

/** 精灵配置文件的绝对路径（~/.memora-sprite/sprite.json） */
const SPRITE_CONFIG_PATH = resolve(homedir(), SPRITE_HOME_DIR_NAME, CONFIG_FILENAME);

/** 当前最新配置版本号（与 DEFAULT_SPRITE_CONFIG.configVersion 保持一致） */
const CURRENT_CONFIG_VERSION = 3;

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
  // v1→v2：新增 theme 字段，默认 'light'
  1: (config) => {
    return { ...config, theme: 'light' };
  },
  // v2→v3：新增 personaMode 字段，默认 'auto'（角色匹配模式持久化）
  2: (config) => {
    return { ...config, personaMode: 'auto' as const };
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
 * 从 ~/.memora-sprite/sprite.json 读取，文件不存在或损坏时返回默认值，不抛错。
 */
export function loadSpriteConfig(): Required<SpriteConfig> {
  const filePath = SPRITE_CONFIG_PATH;

  if (!existsSync(filePath)) {
    return { ...DEFAULT_SPRITE_CONFIG };
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SpriteConfig;
    const merged = { ...DEFAULT_SPRITE_CONFIG, ...parsed };

    // shortcuts 对象需要深合并：用户可能只持久化了 enabled 字段，
    // 浅合并会导致 accelerators 丢失。此处确保 accelerators 有默认值。
    if (parsed.shortcuts) {
      merged.shortcuts = {
        enabled: parsed.shortcuts.enabled ?? DEFAULT_SPRITE_CONFIG.shortcuts.enabled,
        accelerators: {
          ...DEFAULT_SPRITE_CONFIG.shortcuts.accelerators,
          ...parsed.shortcuts.accelerators,
        },
      };
    }

    // 迁移：旧版 windowState='float' 转换为 tray + showFloatBubble
    if ((merged.windowState as string) === 'float') {
      merged.windowState = 'tray';
      // 仅当用户未显式设置 showFloatBubble 时才设为 true（避免覆盖已有偏好）
      if (parsed.showFloatBubble === undefined) {
        merged.showFloatBubble = true;
      }
    }

    // 执行配置版本迁移链（v1→v2→...→CURRENT）
    const migrated = runMigrations(merged);

    // 迁移后立即持久化，避免下次启动重复执行迁移
    // 迁移持久化单独 try/catch，写入失败不影响已迁移配置的使用
    if (migrated.configVersion !== merged.configVersion) {
      try {
        saveSpriteConfig(migrated);
      } catch (persistErr) {
        // 持久化失败仅记录日志，不影响本次加载已迁移的配置
        const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
        logger.error({ err: msg }, '[spriteConfig] 迁移后持久化失败');
      }
    }

    return migrated;
  } catch (err) {
    // 文件损坏时回退到默认配置，记录警告便于排查
    logger.warn({ err: toError(err).message, filePath: SPRITE_CONFIG_PATH }, '精灵配置文件损坏，使用默认配置');
    return { ...DEFAULT_SPRITE_CONFIG };
  }
}

/**
 * 保存精灵配置
 *
 * 写入 ~/.memora-sprite/sprite.json，合并写入：保留文件中已有但当前接口未定义的字段（向前兼容）。
 *
 * 当传入的配置包含所有 DEFAULT_SPRITE_CONFIG 的键时，
 * 认为是"完整配置"（来自 Sprite.updateConfig），跳过读文件直接写入。
 * 仅传入部分字段时（如 CLI 直接调用），仍读文件合并。
 */
export function saveSpriteConfig(config: SpriteConfig): void {
  const filePath = SPRITE_CONFIG_PATH;

  // 判断是否为完整配置（包含所有默认键），避免每次读文件
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
      } catch (err) {
        // 文件损坏时从空配置开始，记录警告便于排查
        logger.warn({ err: toError(err).message, filePath }, '读取现有精灵配置失败，从空配置开始');
      }
    }
    merged = { ...existing, ...config };
  }

  // safeWriteJsonSync 统一封装 mkdir + JSON.stringify + 0o600 权限保护
  // sprite.json 含 focusProjectPath 等路径信息，与 config.json（含 apiKey）保持一致的权限保护
  safeWriteJsonSync(filePath, merged);
}

/**
 * 校验对象类型字段（floatIconPosition / windowBounds / shortcuts / dailyMessageCount）
 *
 * windowBounds / silentModeExpiresAt 允许设为 null（清除值）。
 *
 * @param target 配置对象（动态 key 赋值）
 * @param key 配置字段名
 * @param value 新值
 * @returns 是否校验通过
 */
function validateObjectField(target: Record<string, unknown>, key: SpriteConfigKey, value: unknown): boolean {
  // windowBounds / silentModeExpiresAt 允许设为 null（清除值）
  if (value === null && (key === 'windowBounds' || key === 'silentModeExpiresAt')) {
    target[key] = null;
    return true;
  }
  // 使用内核 isPlainObject 统一对象类型守卫（H4-E：消除重复 typeof 判断）
  if (!isPlainObject(value)) return false;

  // floatIconPosition：校验 x/y 为 number
  if (key === 'floatIconPosition') {
    const pos = value as { x: unknown; y: unknown };
    if ('x' in value && 'y' in value && typeof pos.x === 'number' && typeof pos.y === 'number') {
      target[key] = { x: pos.x, y: pos.y };
      return true;
    }
    return false;
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
    return false;
  }

  // shortcuts：校验 enabled 为 boolean，accelerators 为 Record<string, string>
  if (key === 'shortcuts') {
    const s = value as { enabled?: unknown; accelerators?: unknown };
    if ('enabled' in value && 'accelerators' in value
      && typeof s.enabled === 'boolean'
      && typeof s.accelerators === 'object' && s.accelerators !== null
      && !Array.isArray(s.accelerators)) {
      // 校验 accelerators 的所有值为字符串
      const accMap = s.accelerators as Record<string, unknown>;
      if (Object.values(accMap).every((v) => typeof v === 'string')) {
        target[key] = { enabled: s.enabled, accelerators: { ...accMap as Record<string, string> } };
        return true;
      }
    }
    return false;
  }

  // dailyMessageCount：校验为 Record<string, number>（日期 → 计数）
  if (key === 'dailyMessageCount') {
    if (Array.isArray(value)) return false;
    const dmc = value as Record<string, unknown>;
    if (Object.values(dmc).every((v) => typeof v === 'number' && Number.isFinite(v))) {
      target[key] = { ...dmc as Record<string, number> };
      return true;
    }
    return false;
  }

  return false;
}

/**
 * 应用配置字段更新（纯函数，原地修改 config）
 *
 * 根据 CONFIG_FIELD_SCHEMA 校验 value 类型，符合则写入 config[key]，
 * 不符合则忽略（保持原值）。windowBounds 可设为 null（清除窗口边界）。
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

  // 可空字段：proactiveLastRejectAt / silentModeExpiresAt 允许设为 null（清除值）
  if (value === null && (key === 'proactiveLastRejectAt' || key === 'silentModeExpiresAt')) {
    target[key] = null;
    return true;
  }

  // 简单类型校验（number / boolean / string）
  if (schema === 'number' || schema === 'boolean' || schema === 'string') {
    if (typeof value === schema) {
      target[key] = value;
      return true;
    }
    return false;
  }

  // 字符串数组类型
  if (schema === 'string[]') {
    // 提前 return 校验类型合法性，避免深层嵌套
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
      return false;
    }
    // fileWatcherIgnore 额外校验每个 glob 模式合法性
    if (key === 'fileWatcherIgnore') {
      const patterns = value as string[];
      if (patterns.length > 0 && !patterns.every((p) => validateGlob(p))) {
        return false;
      }
    }
    target[key] = value;
    return true;
  }

  // 数字数组类型（如 proactiveNoticedMagnitudes）
  if (schema === 'number[]') {
    if (!Array.isArray(value) || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return false;
    }
    target[key] = value;
    return true;
  }

  // 对象类型（需额外校验子字段）
  if (schema === 'object') {
    return validateObjectField(target, key, value);
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
