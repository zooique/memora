/**
 * SpriteConfigManager 单元测试
 *
 * 覆盖范围：
 * - getConfig：默认字段完整性 + 副本隔离
 * - updateConfig：11 个键的副作用路由 + saveSpriteConfig 持久化
 * - updateConfigBatch：事务性批量更新（原子性 + 副作用去重）
 * - formatConfig：委托 cliFormatter.formatConfig
 * - loadDailyMessageCount：7 天窗口过滤 + NaN 日期跳过（通过构造间接测试）
 * - incrementDailyMessageCount / getDailyMessageCounts：累加 + 持久化 + 异常兜底
 *
 * Mock 策略（对齐 spriteConfig.test.ts 范式）：
 * - vi.mock 拦截 spriteConfig.js 的 saveSpriteConfig（避免真实文件 IO），保留 applyConfigField / DEFAULT_SPRITE_CONFIG 真实实现
 * - vi.mock 拦截 cli/formatter.js 的 formatConfig（验证委托调用）
 * - setLogger 注入 mock logger，验证 warn 降级日志（logger 为 getter-only 单例，无法 spyOn）
 * - ConfigSideEffects 全部字段使用 vi.fn() 注入，验证副作用路由
 * - 类型导入使用 import type，禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';

// vi.mock 必须在 import 之前声明（vitest 会自动提升到文件顶部）
// 拦截 spriteConfig.js 的 saveSpriteConfig，保留 applyConfigField / DEFAULT_SPRITE_CONFIG 真实实现
vi.mock('../../sprite/spriteConfig.js', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('../../sprite/spriteConfig.js');
  return {
    ...actual,
    saveSpriteConfig: vi.fn(),
  };
});

// 拦截 cli/formatter.js，控制 formatConfig 返回值以验证委托
vi.mock('../../sprite/cli/formatter.js', () => ({
  formatConfig: vi.fn(),
  formatDashboard: vi.fn(),
  formatPersonas: vi.fn(),
}));

import { saveSpriteConfig, DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfig } from '../../sprite/spriteConfig.js';
import { SpriteConfigManager } from '../../sprite/spriteConfigManager.js';
import type { ConfigSideEffects } from '../../sprite/spriteConfigManager.js';
import { MS_PER_DAY, getLocalDate } from '../../sprite/constants.js';
import * as cliFormatter from '../../sprite/cli/formatter.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建 Mock ILogger（通过 setLogger 注入，验证降级日志） */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * 创建 Mock ConfigSideEffects（所有回调为 vi.fn()）
 *
 * onProjectModeChanged 返回 Promise<void>，mock 为 mockResolvedValue(undefined)
 * 以匹配接口签名（updateConfig 中使用 void 丢弃返回值，不 await）
 */
function createMockSideEffects(): ConfigSideEffects {
  return {
    onTriggerIntervalChanged: vi.fn(),
    onFileWatcherChanged: vi.fn(),
    onProactiveConfigChanged: vi.fn(),
    onProjectModeChanged: vi.fn().mockResolvedValue(undefined),
    onArchiveModeChanged: vi.fn(),
  };
}

/**
 * 创建测试用完整配置（深拷贝默认值，避免测试间状态共享）
 *
 * DEFAULT_SPRITE_CONFIG 含嵌套对象（floatIconPosition/shortcuts/fileWatcherPaths 等），
 * 需逐层拷贝。dailyMessageCount 默认为空对象，每次创建新引用避免污染。
 */
function makeConfig(overrides?: Partial<Required<SpriteConfig>>): Required<SpriteConfig> {
  return {
    ...DEFAULT_SPRITE_CONFIG,
    floatIconPosition: { ...DEFAULT_SPRITE_CONFIG.floatIconPosition },
    fileWatcherPaths: [...DEFAULT_SPRITE_CONFIG.fileWatcherPaths],
    fileWatcherIgnore: [...DEFAULT_SPRITE_CONFIG.fileWatcherIgnore],
    shortcuts: {
      ...DEFAULT_SPRITE_CONFIG.shortcuts,
      accelerators: { ...DEFAULT_SPRITE_CONFIG.shortcuts.accelerators },
    },
    dailyMessageCount: {},
    ...overrides,
  };
}

/** 计算本地日期 N 天前的 YYYY-MM-DD 字符串（对齐 getLocalDate 格式） */
function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * MS_PER_DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── 测试用例 ────────────────────────────────────────────

describe('SpriteConfigManager', () => {
  let mockLogger: ILogger;

  beforeEach(() => {
    // 每个测试用例获得全新的 mock logger，避免日志调用计数泄漏
    mockLogger = createMockLogger();
    setLogger(mockLogger);
    // 重置 saveSpriteConfig mock 的调用记录和实现
    vi.mocked(saveSpriteConfig).mockReset();
    vi.mocked(cliFormatter.formatConfig).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── 1. getConfig（2 测试） ─────────────────────────

  describe('getConfig', () => {
    it('返回包含所有默认字段', () => {
      const config = makeConfig();
      const manager = new SpriteConfigManager(config, createMockSideEffects());
      const result = manager.getConfig();

      // 核心字段逐一验证（确保不是空对象或部分字段）
      expect(result.triggerIntervalMs).toBe(DEFAULT_SPRITE_CONFIG.triggerIntervalMs);
      expect(result.fileWatcherEnabled).toBe(DEFAULT_SPRITE_CONFIG.fileWatcherEnabled);
      expect(result.proactiveThreshold).toBe(DEFAULT_SPRITE_CONFIG.proactiveThreshold);
      expect(result.projectMode).toBe(DEFAULT_SPRITE_CONFIG.projectMode);
      expect(result.archiveMode).toBe(DEFAULT_SPRITE_CONFIG.archiveMode);
      expect(result.theme).toBe(DEFAULT_SPRITE_CONFIG.theme);
      expect(result.dailyMessageCount).toEqual({});
    });

    it('返回的是副本（修改返回值不影响内部配置）', () => {
      const config = makeConfig();
      const manager = new SpriteConfigManager(config, createMockSideEffects());
      const result = manager.getConfig();

      // 修改返回值的顶层基本类型字段（getConfig 返回浅拷贝，基本类型字段独立）
      result.triggerIntervalMs = 9_999_999;
      result.theme = 'dark';
      result.silentMode = true;

      // 内部配置不受影响
      const fresh = manager.getConfig();
      expect(fresh.triggerIntervalMs).toBe(DEFAULT_SPRITE_CONFIG.triggerIntervalMs);
      expect(fresh.theme).toBe('light');
      expect(fresh.silentMode).toBe(false);
    });
  });

  // ─── 2. updateConfig 副作用路由（14 测试） ─────────────

  describe('updateConfig 副作用路由', () => {
    let sideEffects: ConfigSideEffects;
    let manager: SpriteConfigManager;

    beforeEach(() => {
      sideEffects = createMockSideEffects();
      manager = new SpriteConfigManager(makeConfig(), sideEffects);
    });

    it('triggerIntervalMs → onTriggerIntervalChanged(value)', () => {
      manager.updateConfig('triggerIntervalMs', 7_200_000);

      expect(sideEffects.onTriggerIntervalChanged).toHaveBeenCalledWith(7_200_000);
      expect(sideEffects.onTriggerIntervalChanged).toHaveBeenCalledTimes(1);
    });

    it('fileWatcherEnabled=true → onFileWatcherChanged(true)', () => {
      manager.updateConfig('fileWatcherEnabled', true);

      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledWith(true);
      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledTimes(1);
    });

    it('fileWatcherPaths → onFileWatcherChanged(fileWatcherEnabled=true)', () => {
      // 默认 fileWatcherEnabled=true
      manager.updateConfig('fileWatcherPaths', ['src', 'lib']);

      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledWith(true);
    });

    it('fileWatcherPaths（fileWatcherEnabled=false 时）→ onFileWatcherChanged(false)', () => {
      // 构造 fileWatcherEnabled=false 的配置，验证传递的是当前 enabled 状态
      const mgr = new SpriteConfigManager(
        makeConfig({ fileWatcherEnabled: false }),
        sideEffects,
      );
      mgr.updateConfig('fileWatcherPaths', ['src', 'lib']);

      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledWith(false);
    });

    it('fileWatcherIgnore → onFileWatcherChanged(fileWatcherEnabled)', () => {
      manager.updateConfig('fileWatcherIgnore', ['**/node_modules/**', '*.log']);

      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledWith(true);
    });

    it('fileWatcherDebounceMs → onFileWatcherChanged(fileWatcherEnabled)', () => {
      manager.updateConfig('fileWatcherDebounceMs', 2_000);

      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledWith(true);
    });

    it('proactiveThreshold → onProactiveConfigChanged(3 个值)', () => {
      manager.updateConfig('proactiveThreshold', 5);

      // 回调接收 3 个参数：threshold / cooldownMs / silentMode（均为更新后的 config 当前值）
      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledWith(5, 300_000, false);
      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledTimes(1);
    });

    it('proactiveCooldownMs → onProactiveConfigChanged', () => {
      manager.updateConfig('proactiveCooldownMs', 600_000);

      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledWith(3, 600_000, false);
    });

    it('silentMode → onProactiveConfigChanged', () => {
      manager.updateConfig('silentMode', true);

      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledWith(3, 300_000, true);
    });

    it('projectMode → onProjectModeChanged()', () => {
      manager.updateConfig('projectMode', 'focus');

      expect(sideEffects.onProjectModeChanged).toHaveBeenCalledTimes(1);
      expect(sideEffects.onProjectModeChanged).toHaveBeenCalledWith();
    });

    it('focusProjectPath → onProjectModeChanged()', () => {
      manager.updateConfig('focusProjectPath', '/home/user/project');

      expect(sideEffects.onProjectModeChanged).toHaveBeenCalledTimes(1);
    });

    it('archiveMode → onArchiveModeChanged(mode)', () => {
      manager.updateConfig('archiveMode', 'manual');

      expect(sideEffects.onArchiveModeChanged).toHaveBeenCalledWith('manual');
      expect(sideEffects.onArchiveModeChanged).toHaveBeenCalledTimes(1);
    });

    it('无副作用键（theme）→ 5 个回调都不被调用', () => {
      manager.updateConfig('theme', 'dark');

      // theme 不触发任何副作用回调
      expect(sideEffects.onTriggerIntervalChanged).not.toHaveBeenCalled();
      expect(sideEffects.onFileWatcherChanged).not.toHaveBeenCalled();
      expect(sideEffects.onProactiveConfigChanged).not.toHaveBeenCalled();
      expect(sideEffects.onProjectModeChanged).not.toHaveBeenCalled();
      expect(sideEffects.onArchiveModeChanged).not.toHaveBeenCalled();
    });

    it('saveSpriteConfig 被调用 1 次（持久化）', () => {
      manager.updateConfig('theme', 'dark');

      // 无论是否有副作用，持久化总是执行
      expect(saveSpriteConfig).toHaveBeenCalledTimes(1);
      // 传入的是当前完整配置
      expect(saveSpriteConfig).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
      );
    });
  });

  // ─── 3. updateConfigBatch 事务性（10 测试） ────────────

  describe('updateConfigBatch 事务性', () => {
    let sideEffects: ConfigSideEffects;
    let manager: SpriteConfigManager;

    beforeEach(() => {
      sideEffects = createMockSideEffects();
      manager = new SpriteConfigManager(makeConfig(), sideEffects);
    });

    it('空批量 → { updated: true }，不持久化', () => {
      const result = manager.updateConfigBatch({});

      expect(result).toEqual({ updated: true });
      expect(saveSpriteConfig).not.toHaveBeenCalled();
      // 无副作用触发
      expect(sideEffects.onTriggerIntervalChanged).not.toHaveBeenCalled();
    });

    it('全部合法 → 一次性应用 + 单次 saveSpriteConfig', () => {
      const result = manager.updateConfigBatch({
        triggerIntervalMs: 7_200_000,
        theme: 'dark',
        silentMode: true,
      });

      expect(result).toEqual({ updated: true });
      // 配置已应用
      const config = manager.getConfig();
      expect(config.triggerIntervalMs).toBe(7_200_000);
      expect(config.theme).toBe('dark');
      expect(config.silentMode).toBe(true);
      // 仅持久化一次
      expect(saveSpriteConfig).toHaveBeenCalledTimes(1);
    });

    it('任一 key 非法 → { updated: false, error } + config 不变 + 不持久化', () => {
      // 使用 JSON.parse 构造含非法键的对象（绕过 TS 类型检查，模拟运行时非法输入）
      const updates: Partial<SpriteConfig> = JSON.parse(
        '{"triggerIntervalMs": 7200000, "nonExistentKey": 123}',
      );

      const result = manager.updateConfigBatch(updates);

      expect(result.updated).toBe(false);
      expect(result.error).toBeDefined();
      // config 不变（事务回滚）
      expect(manager.getConfig().triggerIntervalMs).toBe(DEFAULT_SPRITE_CONFIG.triggerIntervalMs);
      // 不持久化
      expect(saveSpriteConfig).not.toHaveBeenCalled();
    });

    it('任一 value 类型非法 → { updated: false, error } + config 不变', () => {
      // triggerIntervalMs 期望 number，传入 string
      const updates: Partial<SpriteConfig> = JSON.parse(
        '{"theme": "dark", "triggerIntervalMs": "not-a-number"}',
      );

      const result = manager.updateConfigBatch(updates);

      expect(result.updated).toBe(false);
      expect(result.error).toBeDefined();
      // config 不变（合法的 theme 也不应用，保证原子性）
      expect(manager.getConfig().theme).toBe('light');
      expect(manager.getConfig().triggerIntervalMs).toBe(DEFAULT_SPRITE_CONFIG.triggerIntervalMs);
    });

    it('多个 fileWatcher 键 → onFileWatcherChanged 只触发 1 次（去重）', () => {
      manager.updateConfigBatch({
        fileWatcherPaths: ['src', 'lib'],
        fileWatcherIgnore: ['**/node_modules/**'],
        fileWatcherDebounceMs: 2_000,
      });

      // 3 个 fileWatcher 键合并为 1 次副作用调用
      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledTimes(1);
    });

    it('多个 proactive 键 → onProactiveConfigChanged 只触发 1 次（去重）', () => {
      manager.updateConfigBatch({
        proactiveThreshold: 5,
        proactiveCooldownMs: 600_000,
        silentMode: true,
      });

      // 3 个 proactive 键合并为 1 次副作用调用
      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledTimes(1);
      // 传入更新后的 3 个值
      expect(sideEffects.onProactiveConfigChanged).toHaveBeenCalledWith(5, 600_000, true);
    });

    it('triggerIntervalMs + fileWatcherPaths 混合 → 各触发 1 次', () => {
      manager.updateConfigBatch({
        triggerIntervalMs: 7_200_000,
        fileWatcherPaths: ['src'],
      });

      // 两类副作用各触发 1 次
      expect(sideEffects.onTriggerIntervalChanged).toHaveBeenCalledTimes(1);
      expect(sideEffects.onTriggerIntervalChanged).toHaveBeenCalledWith(7_200_000);
      expect(sideEffects.onFileWatcherChanged).toHaveBeenCalledTimes(1);
    });

    it('projectMode + focusProjectPath → onProjectModeChanged 只触发 1 次（去重）', () => {
      manager.updateConfigBatch({
        projectMode: 'focus',
        focusProjectPath: '/home/user/project',
      });

      expect(sideEffects.onProjectModeChanged).toHaveBeenCalledTimes(1);
    });

    it('error 信息含非法 key 名', () => {
      const updates: Partial<SpriteConfig> = JSON.parse('{"nonExistentKey": 123}');

      const result = manager.updateConfigBatch(updates);

      expect(result.updated).toBe(false);
      expect(result.error).toContain('nonExistentKey');
    });

    it('副作用键 + 无副作用键混合 → 仅副作用键触发对应回调', () => {
      manager.updateConfigBatch({
        triggerIntervalMs: 7_200_000,
        theme: 'dark',
      });

      // triggerIntervalMs 触发 onTriggerIntervalChanged
      expect(sideEffects.onTriggerIntervalChanged).toHaveBeenCalledTimes(1);
      // theme 不触发任何副作用
      expect(sideEffects.onFileWatcherChanged).not.toHaveBeenCalled();
      expect(sideEffects.onProactiveConfigChanged).not.toHaveBeenCalled();
    });
  });

  // ─── 4. formatConfig（2 测试） ───────────────────────

  describe('formatConfig', () => {
    it('返回字符串含"精灵配置"', () => {
      vi.mocked(cliFormatter.formatConfig).mockReturnValue('── 精灵配置 ──');
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());

      const result = manager.formatConfig();

      expect(result).toContain('精灵配置');
    });

    it('委托 cliFormatter.formatConfig（传入当前配置）', () => {
      vi.mocked(cliFormatter.formatConfig).mockReturnValue('mocked');
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());
      const config = manager.getConfig();

      manager.formatConfig();

      // 验证委托调用：传入的参数与当前配置值深度相等
      expect(cliFormatter.formatConfig).toHaveBeenCalledTimes(1);
      expect(cliFormatter.formatConfig).toHaveBeenCalledWith(config);
    });
  });

  // ─── 5. loadDailyMessageCount（构造时加载，4 测试） ────

  describe('loadDailyMessageCount（构造时加载）', () => {
    it('config.dailyMessageCount 为空对象 → Map 为空', () => {
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());

      expect(manager.getDailyMessageCounts()).toEqual({});
    });

    it('含 3 天内数据 → Map 含对应条目', () => {
      const recentDate = daysAgo(3);
      const config = makeConfig({
        dailyMessageCount: { [recentDate]: 5 },
      });

      const manager = new SpriteConfigManager(config, createMockSideEffects());

      expect(manager.getDailyMessageCounts()).toEqual({ [recentDate]: 5 });
    });

    it('含 10 天前数据 → Map 不含（被剔除）', () => {
      const oldDate = daysAgo(10);
      const recentDate = daysAgo(1);
      const config = makeConfig({
        dailyMessageCount: {
          [oldDate]: 99,
          [recentDate]: 3,
        },
      });

      const manager = new SpriteConfigManager(config, createMockSideEffects());

      // 10 天前的数据被剔除，仅保留 1 天前的
      const counts = manager.getDailyMessageCounts();
      expect(counts).not.toHaveProperty(oldDate);
      expect(counts[recentDate]).toBe(3);
    });

    it('含无效日期 "invalid" → Map 不含（NaN 跳过）', () => {
      const recentDate = daysAgo(1);
      const config = makeConfig({
        dailyMessageCount: {
          'invalid': 42,
          [recentDate]: 7,
        },
      });

      const manager = new SpriteConfigManager(config, createMockSideEffects());

      // 无效日期被跳过，仅保留有效日期
      const counts = manager.getDailyMessageCounts();
      expect(counts).not.toHaveProperty('invalid');
      expect(counts[recentDate]).toBe(7);
    });
  });

  // ─── 6. incrementDailyMessageCount / getDailyMessageCounts（5 测试） ──

  describe('incrementDailyMessageCount / getDailyMessageCounts', () => {
    it('初始 getDailyMessageCounts 返回空对象', () => {
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());

      expect(manager.getDailyMessageCounts()).toEqual({});
    });

    it('increment 1 次后今日计数=1', () => {
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());
      const today = getLocalDate();

      manager.incrementDailyMessageCount();

      const counts = manager.getDailyMessageCounts();
      expect(counts[today]).toBe(1);
    });

    it('increment 3 次后今日计数=3', () => {
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());
      const today = getLocalDate();

      manager.incrementDailyMessageCount();
      manager.incrementDailyMessageCount();
      manager.incrementDailyMessageCount();

      const counts = manager.getDailyMessageCounts();
      expect(counts[today]).toBe(3);
    });

    it('saveSpriteConfig 被调用（持久化）', () => {
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());

      manager.incrementDailyMessageCount();

      // 累加后同步持久化
      expect(saveSpriteConfig).toHaveBeenCalledTimes(1);
      // 传入的配置含更新后的 dailyMessageCount
      const today = getLocalDate();
      expect(saveSpriteConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          dailyMessageCount: { [today]: 1 },
        }),
      );
    });

    it('saveSpriteConfig 抛错时 logger.warn 但不抛出', () => {
      // mock saveSpriteConfig 抛错（模拟磁盘已满等持久化失败场景）
      vi.mocked(saveSpriteConfig).mockImplementation(() => {
        throw new Error('disk full');
      });
      const manager = new SpriteConfigManager(makeConfig(), createMockSideEffects());

      // 不抛出异常（catch-only-warn 模式）
      expect(() => manager.incrementDailyMessageCount()).not.toThrow();
      // 降级日志已记录
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.stringContaining('disk full') }),
        '每日消息计数持久化失败',
      );
      // 内存中的计数仍然更新（持久化失败不影响内存态）
      const today = getLocalDate();
      expect(manager.getDailyMessageCounts()[today]).toBe(1);
    });
  });
});
