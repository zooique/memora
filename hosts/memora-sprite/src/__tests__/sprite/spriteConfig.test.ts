/**
 * spriteConfig 单元测试
 *
 * 覆盖范围：
 * - 常量与类型定义：DEFAULT_SPRITE_CONFIG 默认值 + CONFIG_FIELD_SCHEMA 字段映射
 * - applyConfigField 类型校验：number/boolean/string/string[]/object/enum 六类校验
 * - loadSpriteConfig 加载：默认值合并 + shortcuts 深合并 + windowState 迁移 + 版本迁移链 + 持久化
 * - saveSpriteConfig 保存：完整配置直写 + 部分配置合并 + 损坏降级 + 目录创建 + 0o600 权限
 * - isPlainObject 类型守卫：通过 saveSpriteConfig 部分配置路径间接验证（函数未导出）
 *
 * 测试策略（对齐 memoryController.test.ts 范式）：
 * - vi.mock 拦截 node:fs（readFileSync/writeFileSync/existsSync/mkdirSync）+ node:os（homedir）
 * - 通过 setLogger() 注入 mock logger，验证 warn 降级日志（logger 为 getter-only 单例，无法 spyOn）
 * - vi.spyOn(console, 'error') 验证迁移持久化失败日志
 * - applyConfigField 为纯函数，直接构造 Required<SpriteConfig> 验证原地修改
 * - 类型导入使用 import type，禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock 必须在 import 之前声明（vitest 会自动提升到文件顶部）
// 拦截 node:os 的 homedir，避免依赖真实 home 目录路径
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

// 拦截 node:fs 的同步 I/O，所有文件操作走 mock，零真实 IO
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { setLogger, logger } from 'memora';
import type { ILogger } from 'memora';
import {
  DEFAULT_SPRITE_CONFIG,
  CONFIG_FIELD_SCHEMA,
  loadSpriteConfig,
  saveSpriteConfig,
  applyConfigField,
} from '../../sprite/spriteConfig.js';
import type { SpriteConfig } from '../../sprite/spriteConfig.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/**
 * 创建 Mock ILogger
 *
 * 用于通过 setLogger() 注入，验证降级日志调用。
 * logger 为 getter-only 单例（get warn() { return _logger.warn.bind(_logger) }），
 * 无法用 vi.spyOn，必须通过 setLogger 替换内部 _logger 引用。
 */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * 创建测试用完整配置（深拷贝默认值，避免测试间状态共享）
 *
 * DEFAULT_SPRITE_CONFIG 含嵌套对象（floatIconPosition/shortcuts），需逐层拷贝。
 * windowBounds/silentModeExpiresAt 为 null（基本类型），浅拷贝即可。
 */
function makeConfig(): Required<SpriteConfig> {
  return {
    ...DEFAULT_SPRITE_CONFIG, // 展开默认值（基本类型字段直接拷贝）
    floatIconPosition: { ...DEFAULT_SPRITE_CONFIG.floatIconPosition }, // 深拷贝坐标对象
    fileWatcherPaths: [...DEFAULT_SPRITE_CONFIG.fileWatcherPaths], // 深拷贝路径数组
    fileWatcherIgnore: [...DEFAULT_SPRITE_CONFIG.fileWatcherIgnore], // 深拷贝忽略模式数组
    shortcuts: {
      ...DEFAULT_SPRITE_CONFIG.shortcuts, // 浅拷贝 shortcuts 外层
      accelerators: { ...DEFAULT_SPRITE_CONFIG.shortcuts.accelerators }, // 深拷贝加速器映射
    },
  };
}

// ─── 测试用例 ────────────────────────────────────────────

describe('spriteConfig', () => {
  let mockLogger: ILogger; // mock logger 实例，每个测试用例重置

  beforeEach(() => {
    // 每个测试用例获得全新的 mock logger，避免日志调用计数泄漏
    mockLogger = createMockLogger();
    // 注入 mock logger（替代默认 console fallback），使降级日志可验证
    setLogger(mockLogger);
    // 重置 fs mock 的返回值与实现，确保测试间隔离
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(mkdirSync).mockReset();
  });

  afterEach(() => {
    // 恢复 vi.spyOn 创建的间谍（如 console.error），不影响 vi.mock 的 vi.fn()
    vi.restoreAllMocks();
  });

  // ─── 1. 常量与类型定义（4 测试） ─────────────────────

  describe('常量与类型定义', () => {
    it('DEFAULT_SPRITE_CONFIG 包含所有字段默认值', () => {
      // 核心字段默认值逐一验证
      expect(DEFAULT_SPRITE_CONFIG.configVersion).toBe(3);
      expect(DEFAULT_SPRITE_CONFIG.triggerIntervalMs).toBe(3_600_000);
      expect(DEFAULT_SPRITE_CONFIG.silentMode).toBe(false);
      expect(DEFAULT_SPRITE_CONFIG.proactiveThreshold).toBe(3);
      expect(DEFAULT_SPRITE_CONFIG.proactiveCooldownMs).toBe(300_000);
      expect(DEFAULT_SPRITE_CONFIG.fileWatcherEnabled).toBe(true);
      expect(DEFAULT_SPRITE_CONFIG.fileWatcherPaths).toEqual(['.']);
      expect(DEFAULT_SPRITE_CONFIG.fileWatcherDebounceMs).toBe(1_000);
      expect(DEFAULT_SPRITE_CONFIG.windowState).toBe('tray');
      expect(DEFAULT_SPRITE_CONFIG.showFloatBubble).toBe(true);
      expect(DEFAULT_SPRITE_CONFIG.projectMode).toBe('smart');
      expect(DEFAULT_SPRITE_CONFIG.theme).toBe('light');
      expect(DEFAULT_SPRITE_CONFIG.shortcuts.enabled).toBe(true);
    });

    it('DEFAULT_SPRITE_CONFIG.shortcuts.accelerators 包含 4 个默认快捷键', () => {
      const accelerators = DEFAULT_SPRITE_CONFIG.shortcuts.accelerators; // 默认加速器映射
      expect(Object.keys(accelerators)).toHaveLength(4);
      expect(accelerators['toggle-window']).toBe('Ctrl+Shift+Space');
      expect(accelerators['quick-record']).toBe('Ctrl+Shift+M');
      expect(accelerators['recall-memory']).toBe('Ctrl+Shift+R');
      expect(accelerators['quick-input']).toBe('Ctrl+Shift+C');
    });

    it('CONFIG_FIELD_SCHEMA 包含所有 27 个字段的类型映射', () => {
      const keys = Object.keys(CONFIG_FIELD_SCHEMA); // 全部字段名
      expect(keys).toHaveLength(27);
      // 逐一验证关键类型映射存在
      expect(CONFIG_FIELD_SCHEMA.configVersion).toBe('number');
      expect(CONFIG_FIELD_SCHEMA.triggerIntervalMs).toBe('number');
      expect(CONFIG_FIELD_SCHEMA.defaultPersona).toBe('string');
      expect(CONFIG_FIELD_SCHEMA.personaMode).toBe('enum:auto|manual');
      expect(CONFIG_FIELD_SCHEMA.silentMode).toBe('boolean');
      expect(CONFIG_FIELD_SCHEMA.fileWatcherPaths).toBe('string[]');
      expect(CONFIG_FIELD_SCHEMA.floatIconPosition).toBe('object');
      expect(CONFIG_FIELD_SCHEMA.windowBounds).toBe('object');
      expect(CONFIG_FIELD_SCHEMA.shortcuts).toBe('object');
      // ProactiveEngine 持久化字段类型映射
      expect(CONFIG_FIELD_SCHEMA.proactiveNoticedMagnitudes).toBe('number[]');
      expect(CONFIG_FIELD_SCHEMA.proactiveKnownSources).toBe('string[]');
      expect(CONFIG_FIELD_SCHEMA.proactiveLastRejectAt).toBe('number');
    });

    it('CONFIG_FIELD_SCHEMA 的枚举字段格式正确', () => {
      // 枚举格式为 'enum:val1|val2|val3'
      expect(CONFIG_FIELD_SCHEMA.windowState).toBe('enum:tray|full');
      expect(CONFIG_FIELD_SCHEMA.projectMode).toBe('enum:smart|focus');
      expect(CONFIG_FIELD_SCHEMA.theme).toBe('enum:light|dark|auto');
    });
  });

  // ─── 2. applyConfigField 类型校验（20 测试） ─────────

  describe('applyConfigField 类型校验', () => {
    describe('number 类型', () => {
      it('triggerIntervalMs 设为有效数字 → 返回 true + config 更新', () => {
        const config = makeConfig(); // 全新配置副本
        const result = applyConfigField(config, 'triggerIntervalMs', 7_200_000);
        expect(result).toBe(true);
        expect(config.triggerIntervalMs).toBe(7_200_000);
      });

      it('triggerIntervalMs 设为字符串 → 返回 false + config 不变', () => {
        const config = makeConfig();
        const original = config.triggerIntervalMs; // 记录原值
        const result = applyConfigField(config, 'triggerIntervalMs', '7200000');
        expect(result).toBe(false);
        expect(config.triggerIntervalMs).toBe(original);
      });

      it('proactiveThreshold 设为 0 → 返回 true（0 是合法数值）', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveThreshold', 0);
        expect(result).toBe(true);
        expect(config.proactiveThreshold).toBe(0);
      });

      // proactiveLastRejectAt 允许设为 null（清除拒绝时间戳，表示从未拒绝或已完全衰减）
      it('proactiveLastRejectAt 设为有效时间戳 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveLastRejectAt', 1784332280000);
        expect(result).toBe(true);
        expect(config.proactiveLastRejectAt).toBe(1784332280000);
      });

      it('proactiveLastRejectAt 设为 null（清除拒绝时间戳）→ 返回 true', () => {
        const config = makeConfig();
        // 先设为有效时间戳，再清除为 null
        config.proactiveLastRejectAt = 1784332280000;
        const result = applyConfigField(config, 'proactiveLastRejectAt', null);
        expect(result).toBe(true);
        expect(config.proactiveLastRejectAt).toBeNull();
      });

      it('proactiveLastRejectAt 设为字符串 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveLastRejectAt', '1784332280000');
        expect(result).toBe(false);
        // 默认 null，未被覆盖
        expect(config.proactiveLastRejectAt).toBeNull();
      });
    });

    describe('boolean 类型', () => {
      it('silentMode 设为 true → 返回 true + config 更新', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'silentMode', true);
        expect(result).toBe(true);
        expect(config.silentMode).toBe(true);
      });

      it('silentMode 设为 0 → 返回 false（0 不是 boolean）', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'silentMode', 0);
        expect(result).toBe(false);
        // 默认 false，未被覆盖
        expect(config.silentMode).toBe(false);
      });
    });

    describe('string 类型', () => {
      it('defaultPersona 设为有效字符串 → 返回 true + config 更新', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'defaultPersona', 'coder');
        expect(result).toBe(true);
        expect(config.defaultPersona).toBe('coder');
      });

      it('defaultPersona 设为数字 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'defaultPersona', 123);
        expect(result).toBe(false);
        // 默认空字符串，未被覆盖
        expect(config.defaultPersona).toBe('');
      });
    });

    describe('string[] 类型', () => {
      it('fileWatcherPaths 设为有效字符串数组 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherPaths', ['src', 'lib']);
        expect(result).toBe(true);
        expect(config.fileWatcherPaths).toEqual(['src', 'lib']);
      });

      it('fileWatcherPaths 设为含非字符串的数组 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherPaths', ['src', 123]);
        expect(result).toBe(false);
        // 默认 ['.']，未被覆盖
        expect(config.fileWatcherPaths).toEqual(['.']);
      });

      it('fileWatcherPaths 设为字符串（非数组）→ 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherPaths', 'src');
        expect(result).toBe(false);
        expect(config.fileWatcherPaths).toEqual(['.']);
      });

      // fileWatcherIgnore glob 合法性校验
      it('fileWatcherIgnore 设为有效 glob 模式 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherIgnore', ['**/node_modules/**', '*.log']);
        expect(result).toBe(true);
        expect(config.fileWatcherIgnore).toEqual(['**/node_modules/**', '*.log']);
      });

      it('fileWatcherIgnore 含空字符串 → 返回 false（glob 非法）', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherIgnore', ['**/valid/**', '']);
        expect(result).toBe(false);
        // 默认值未被覆盖
        expect(config.fileWatcherIgnore).toEqual(DEFAULT_SPRITE_CONFIG.fileWatcherIgnore);
      });

      it('fileWatcherIgnore 含纯空白字符串 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherIgnore', ['**/valid/**', '   ']);
        expect(result).toBe(false);
        expect(config.fileWatcherIgnore).toEqual(DEFAULT_SPRITE_CONFIG.fileWatcherIgnore);
      });

      it('fileWatcherIgnore 所有模式合法 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'fileWatcherIgnore', [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**',
          '**/.memora/**',
          '*.log',
          'src/**/*.ts',
        ]);
        expect(result).toBe(true);
        expect(config.fileWatcherIgnore).toHaveLength(6);
      });
    });

    describe('number[] 类型', () => {
      // proactiveNoticedMagnitudes 是新增的 number[] 类型字段
      it('proactiveNoticedMagnitudes 设为有效数字数组 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveNoticedMagnitudes', [2, 3]);
        expect(result).toBe(true);
        expect(config.proactiveNoticedMagnitudes).toEqual([2, 3]);
      });

      it('proactiveNoticedMagnitudes 设为含 NaN 的数组 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveNoticedMagnitudes', [2, NaN]);
        expect(result).toBe(false);
        // 默认空数组，未被覆盖
        expect(config.proactiveNoticedMagnitudes).toEqual([]);
      });

      it('proactiveNoticedMagnitudes 设为非数组 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveNoticedMagnitudes', '2,3');
        expect(result).toBe(false);
        expect(config.proactiveNoticedMagnitudes).toEqual([]);
      });

      it('proactiveKnownSources 设为有效字符串数组 → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'proactiveKnownSources', ['chat', 'insight']);
        expect(result).toBe(true);
        expect(config.proactiveKnownSources).toEqual(['chat', 'insight']);
      });
    });

    describe('object 类型', () => {
      it('floatIconPosition 设为有效 {x,y} → 返回 true + config 更新', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'floatIconPosition', { x: 100, y: 200 });
        expect(result).toBe(true);
        expect(config.floatIconPosition).toEqual({ x: 100, y: 200 });
      });

      it('floatIconPosition 设为缺字段 {x:1} → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'floatIconPosition', { x: 1 });
        expect(result).toBe(false);
        // 默认 {x:-1, y:-1}，未被覆盖
        expect(config.floatIconPosition).toEqual({ x: -1, y: -1 });
      });

      it('floatIconPosition 设为 x 非数字 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'floatIconPosition', { x: 'a', y: 1 });
        expect(result).toBe(false);
        expect(config.floatIconPosition).toEqual({ x: -1, y: -1 });
      });

      it('windowBounds 设为有效 {x,y,width,height} → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'windowBounds', {
          x: 0,
          y: 0,
          width: 800,
          height: 600,
        });
        expect(result).toBe(true);
        expect(config.windowBounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
      });

      it('windowBounds 设为 null（清除窗口边界）→ 返回 true + config.windowBounds = null', () => {
        const config = makeConfig();
        // 先设为有效边界，再清除为 null，验证允许 null 值
        config.windowBounds = { x: 0, y: 0, width: 800, height: 600 };
        const result = applyConfigField(config, 'windowBounds', null);
        expect(result).toBe(true);
        expect(config.windowBounds).toBeNull();
      });

      it('windowBounds 设为缺字段 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'windowBounds', { x: 0, y: 0, width: 800 });
        expect(result).toBe(false);
        // 默认 null，未被覆盖
        expect(config.windowBounds).toBeNull();
      });

      it('shortcuts 设为有效 {enabled, accelerators} → 返回 true', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'shortcuts', {
          enabled: false,
          accelerators: { 'toggle-window': 'Ctrl+Alt+T' },
        });
        expect(result).toBe(true);
        expect(config.shortcuts.enabled).toBe(false);
        expect(config.shortcuts.accelerators['toggle-window']).toBe('Ctrl+Alt+T');
      });

      it('shortcuts 设为 accelerators 含非字符串值 → 返回 false', () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'shortcuts', {
          enabled: true,
          accelerators: { 'toggle-window': 123 },
        });
        expect(result).toBe(false);
        // shortcuts 未被覆盖，保留默认值
        expect(config.shortcuts.enabled).toBe(true);
        expect(config.shortcuts.accelerators['toggle-window']).toBe('Ctrl+Shift+Space');
      });
    });

    describe('enum 类型', () => {
      it("theme 设为 'dark' → 返回 true（合法枚举值）", () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'theme', 'dark');
        expect(result).toBe(true);
        expect(config.theme).toBe('dark');
      });

      it("theme 设为 'invalid' → 返回 false（非枚举值）", () => {
        const config = makeConfig();
        const result = applyConfigField(config, 'theme', 'invalid');
        expect(result).toBe(false);
        // 默认 'light'，未被覆盖
        expect(config.theme).toBe('light');
      });
    });
  });

  // ─── 3. loadSpriteConfig 加载（10 测试） ─────────────

  describe('loadSpriteConfig 加载', () => {
    it('文件不存在时返回默认配置（existsSync 返回 false）', () => {
      vi.mocked(existsSync).mockReturnValue(false); // 模拟文件不存在
      const config = loadSpriteConfig();
      expect(config).toEqual(DEFAULT_SPRITE_CONFIG);
      // 文件不存在时不应尝试读取
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it('文件存在且有效时返回合并后配置（默认值 + 用户值）', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ configVersion: 2, theme: 'dark', silentMode: true }),
      );
      const config = loadSpriteConfig();
      // 用户值覆盖默认值
      expect(config.theme).toBe('dark');
      expect(config.silentMode).toBe(true);
      // 未覆盖的字段保留默认值
      expect(config.triggerIntervalMs).toBe(DEFAULT_SPRITE_CONFIG.triggerIntervalMs);
    });

    it('shortcuts 深合并：用户只持久化 enabled 字段时 accelerators 保留默认值', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ configVersion: 2, shortcuts: { enabled: false } }),
      );
      const config = loadSpriteConfig();
      // enabled 用户值生效
      expect(config.shortcuts.enabled).toBe(false);
      // accelerators 保留默认值（浅合并会丢失，此处验证深合并）
      expect(config.shortcuts.accelerators).toEqual(DEFAULT_SPRITE_CONFIG.shortcuts.accelerators);
    });

    it('shortcuts 深合并：用户持久化部分 accelerators 时与默认 accelerators 合并', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          configVersion: 2,
          shortcuts: {
            enabled: true,
            accelerators: { 'toggle-window': 'Ctrl+Alt+T' },
          },
        }),
      );
      const config = loadSpriteConfig();
      // 用户覆盖的快捷键生效
      expect(config.shortcuts.accelerators['toggle-window']).toBe('Ctrl+Alt+T');
      // 未覆盖的快捷键保留默认值
      expect(config.shortcuts.accelerators['quick-record']).toBe('Ctrl+Shift+M');
      expect(config.shortcuts.accelerators['recall-memory']).toBe('Ctrl+Shift+R');
    });

    it("旧版 windowState='float' 转换为 'tray' + showFloatBubble=true（迁移）", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ configVersion: 2, windowState: 'float' }),
      );
      const config = loadSpriteConfig();
      expect(config.windowState).toBe('tray');
      // 未显式设置 showFloatBubble 时，迁移补为 true
      expect(config.showFloatBubble).toBe(true);
    });

    it("旧版 windowState='float' + 用户已设 showFloatBubble=false 时不覆盖（保留 false）", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({
          configVersion: 2,
          windowState: 'float',
          showFloatBubble: false,
        }),
      );
      const config = loadSpriteConfig();
      expect(config.windowState).toBe('tray');
      // 用户已显式设 false，迁移不覆盖（避免破坏已有偏好）
      expect(config.showFloatBubble).toBe(false);
    });

    it('文件损坏（JSON.parse 抛错）时备份原文件并返回默认配置 + logger.warn 记录', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ invalid json }'); // 非法 JSON
      const config = loadSpriteConfig();
      expect(config).toEqual(DEFAULT_SPRITE_CONFIG);
      // 损坏文件已备份（renameSync 被调用）
      expect(renameSync).toHaveBeenCalledTimes(1);
      // 降级日志已记录，含 backupPath
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expect.any(String), backupPath: expect.any(String) }),
        '精灵配置文件损坏，已备份原文件并使用默认配置',
      );
    });

    it("v1→v2→v3 链式迁移：configVersion=1 + 无 theme/personaMode 字段 → 迁移后 theme='light' + personaMode='auto' + configVersion=3", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ configVersion: 1 }), // 无 theme / personaMode 字段
      );
      const config = loadSpriteConfig();
      expect(config.theme).toBe('light');
      expect(config.personaMode).toBe('auto');
      expect(config.configVersion).toBe(3);
    });

    it("v2→v3 迁移：configVersion=2 + 无 personaMode 字段 → 迁移后 personaMode='auto' + configVersion=3", () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ configVersion: 2, theme: 'dark' }), // 已有 theme，无 personaMode
      );
      const config = loadSpriteConfig();
      // theme 字段保留用户偏好，不被覆盖
      expect(config.theme).toBe('dark');
      // personaMode 由迁移补为默认值 'auto'
      expect(config.personaMode).toBe('auto');
      expect(config.configVersion).toBe(3);
    });

    it('迁移后立即持久化（saveSpriteConfig 被调用）', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ configVersion: 1 }));
      loadSpriteConfig();
      // saveSpriteConfig 内部调用 writeFileSync 完成持久化
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('迁移持久化失败时 logger.error 记录但已迁移配置仍可用', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ configVersion: 1 }));
      // 模拟持久化写入失败
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw new Error('disk full');
      });
      // 捕获 logger.error，避免污染测试输出
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const config = loadSpriteConfig();
      // 已迁移的配置仍正常返回（持久化失败不影响内存中的配置）
      expect(config.configVersion).toBe(3);
      expect(config.theme).toBe('light');
      // 持久化失败已记录日志（logger.error 格式：{ err: msg }, msg）
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining('disk full') }),
        expect.stringContaining('迁移后持久化失败'),
      );
    });
  });

  // ─── 4. saveSpriteConfig 保存（6 测试） ──────────────

  describe('saveSpriteConfig 保存', () => {
    it('完整配置（包含所有 DEFAULT_SPRITE_CONFIG 键）跳过读文件直接写入', () => {
      const fullConfig = makeConfig(); // 含全部默认键
      saveSpriteConfig(fullConfig);
      // 完整配置路径不读文件、不检查存在性
      expect(readFileSync).not.toHaveBeenCalled();
      expect(existsSync).not.toHaveBeenCalled();
      // 直接写入
      expect(writeFileSync).toHaveBeenCalled();
      expect(mkdirSync).toHaveBeenCalled();
    });

    it('部分配置时读文件合并写入（向前兼容）', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ theme: 'light', silentMode: true, customField: 'preserve me' }),
      );
      saveSpriteConfig({ theme: 'dark' }); // 部分配置
      // 读文件被调用（部分配置路径）
      expect(readFileSync).toHaveBeenCalled();
      // 验证写入内容：existing + partial 合并，theme 被覆盖
      const writtenCall = vi.mocked(writeFileSync).mock.calls[0]; // 第一次写入调用
      const writtenContent = JSON.parse(writtenCall![1] as string) as Record<string, unknown>;
      expect(writtenContent.theme).toBe('dark');
      expect(writtenContent.silentMode).toBe(true);
      // 未知字段向前兼容保留
      expect(writtenContent.customField).toBe('preserve me');
    });

    it('部分配置 + 文件损坏时从空配置开始合并 + logger.warn 记录', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ broken }'); // 损坏 JSON
      saveSpriteConfig({ theme: 'dark' });
      // 降级日志已记录
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: expect.any(String) }),
        '读取现有精灵配置失败，从空配置开始',
      );
      // 写入内容仅含 partial（existing 为空）
      const writtenCall = vi.mocked(writeFileSync).mock.calls[0];
      const writtenContent = JSON.parse(writtenCall![1] as string) as Record<string, unknown>;
      expect(writtenContent).toEqual({ theme: 'dark' });
    });

    it('部分配置 + 文件存在但非对象时从空配置开始', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      // JSON.parse 结果为数字 123（非对象），isPlainObject 返回 false
      vi.mocked(readFileSync).mockReturnValue('123');
      saveSpriteConfig({ theme: 'dark' });
      // 写入内容仅含 partial（existing 被判定为非对象，保持空对象）
      const writtenCall = vi.mocked(writeFileSync).mock.calls[0];
      const writtenContent = JSON.parse(writtenCall![1] as string) as Record<string, unknown>;
      expect(writtenContent).toEqual({ theme: 'dark' });
    });

    it('mkdirSync 创建目录（recursive: true）', () => {
      const fullConfig = makeConfig();
      saveSpriteConfig(fullConfig);
      // 目录创建使用 recursive 选项（首次运行时 dataDir 可能尚未创建）
      expect(mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it('writeFileSync 使用 0o600 权限模式（mode: 0o600）', () => {
      const fullConfig = makeConfig();
      saveSpriteConfig(fullConfig);
      // 写入使用 0o600 权限（仅文件所有者可读写，与 config.json 保持一致）
      const writeCall = vi.mocked(writeFileSync).mock.calls[0];
      expect(writeCall![2]).toEqual({ encoding: 'utf-8', mode: 0o600 });
    });
  });

  // ─── 5. isPlainObject 类型守卫（4 测试） ────────────
  // isPlainObject 未导出，通过 saveSpriteConfig 部分配置路径间接验证：
  // 文件内容为对象 → existing 被填充；非对象 → existing 保持空 {}

  describe('isPlainObject 类型守卫', () => {
    /**
     * 辅助：从 writeFileSync 调用中提取写入的 JSON 内容
     *
     * 用于验证 isPlainObject 的判定结果是否影响 existing 合并。
     */
    function getWrittenContent(): Record<string, unknown> {
      const call = vi.mocked(writeFileSync).mock.calls[0]; // 第一次写入调用
      return JSON.parse(call![1] as string) as Record<string, unknown>;
    }

    beforeEach(() => {
      // 部分配置路径默认设置：文件存在 + readFileSync 返回值由各测试覆盖
      vi.mocked(existsSync).mockReturnValue(true);
    });

    it('普通对象返回 true（existing 被填充，写入内容含已有字段）', () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ existingField: 'old' }));
      saveSpriteConfig({ theme: 'dark' });
      const written = getWrittenContent();
      // isPlainObject=true → existing 与 partial 合并
      expect(written.existingField).toBe('old');
      expect(written.theme).toBe('dark');
    });

    it('null 返回 false（existing 保持空，写入内容仅含 partial）', () => {
      vi.mocked(readFileSync).mockReturnValue('null'); // JSON.parse → null
      saveSpriteConfig({ theme: 'dark' });
      const written = getWrittenContent();
      // isPlainObject(null)=false → existing 为 {}，写入仅 partial
      expect(written).toEqual({ theme: 'dark' });
    });

    it('数组返回 false（existing 保持空，写入内容仅含 partial）', () => {
      vi.mocked(readFileSync).mockReturnValue('[1, 2, 3]'); // JSON.parse → array
      saveSpriteConfig({ theme: 'dark' });
      const written = getWrittenContent();
      // isPlainObject(array)=false → existing 为 {}
      expect(written).toEqual({ theme: 'dark' });
    });

    it('字符串返回 false（existing 保持空，写入内容仅含 partial）', () => {
      vi.mocked(readFileSync).mockReturnValue('"hello"'); // JSON.parse → string
      saveSpriteConfig({ theme: 'dark' });
      const written = getWrittenContent();
      // isPlainObject(string)=false → existing 为 {}
      expect(written).toEqual({ theme: 'dark' });
    });
  });
});
