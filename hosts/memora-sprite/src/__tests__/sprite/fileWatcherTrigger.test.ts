/**
 * FileWatcherTrigger 单元测试
 *
 * 覆盖范围：
 * - 构造与配置：watchPaths / ignore / debounceMs / allowedPaths 透传 + name 属性
 * - isPathAllowed 路径白名单：空拒绝 / 根目录 / 子目录 / 兄弟目录防绕过 / 多白名单
 * - shouldIgnore 忽略模式：默认 4 项 / 不匹配 / 自定义（含预编译）
 * - start 启动监听：越界 warn / watch 抛错继续 / 成功 info
 * - stop 停止监听：watcher.close + clearSafeTimeout / callback 置 null
 * - createWatcher 回调：filename null 静默 / 忽略模式静默 / 正常触发 debouncedEmit
 * - debouncedEmit 防抖：首次注册 + 参数格式 / 同文件去重 / 不同文件独立
 * - error 事件处理：logger.error + 不抛未捕获异常 + on('error') 注册
 *
 * 测试策略（对齐 triggers.test.ts / errorHandler.test.ts 范式）：
 * - mock node:fs 的 watch（vi.hoisted 持有 calls 数组，便于捕获回调与 watcher）
 * - mock memora 的 logger / toError / safeSetTimeout / clearSafeTimeout
 * - safeSetTimeout / clearSafeTimeout 透传到原生 setTimeout / clearTimeout，配合 vi.useFakeTimers()
 * - 类型导入使用 import type（consistent-type-imports 规则）
 * - 禁止 @ts-ignore / as any / as unknown as
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve, sep } from 'node:path';

// ─── Mock node:fs（vi.hoisted 保证在 vi.mock 工厂执行时 calls 已就绪） ───

/** mock watcher 结构：close + on 均为 vi.fn，便于断言调用 */
interface MockWatcher {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

/** 单次 watch 调用的捕获记录：路径 / 回调 / watcher 实例 */
interface WatchCall {
  path: string;
  callback: (eventType: string, filename: string | null) => void;
  watcher: MockWatcher;
}

const mockFs = vi.hoisted(() => {
  // 累积所有 watch 调用，供测试检索回调与 watcher
  const calls: WatchCall[] = [];
  const watch = vi.fn(
    (
      path: string,
      _options: unknown,
      callback: (eventType: string, filename: string | null) => void,
    ) => {
      const watcher: MockWatcher = {
        close: vi.fn(),
        // on 返回 watcher 本身以支持链式；handler 类型按 error 事件签名声明
        on: vi.fn((_event: string, _handler: (err: unknown) => void) => watcher),
      };
      calls.push({ path, callback, watcher });
      return watcher;
    },
  );
  return { calls, watch };
});

vi.mock('node:fs', () => ({ watch: mockFs.watch }));

// ─── Mock memora（logger / toError / safeSetTimeout / clearSafeTimeout） ───
vi.mock('memora', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  toError: (err: unknown): Error => (err instanceof Error ? err : new Error(String(err))),
  // 透传到原生 setTimeout / clearTimeout，便于 vi.useFakeTimers() 接管防抖计时器
  safeSetTimeout: vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms)),
  clearSafeTimeout: vi.fn((id: ReturnType<typeof setTimeout> | null) => {
    if (id !== null) clearTimeout(id);
  }),
}));

// 被测模块与 mock 引用（必须在 vi.mock 之后导入）
import { FileWatcherTrigger } from '../../sprite/fileWatcherTrigger.js';
import type { FileWatcherConfig } from '../../sprite/fileWatcherTrigger.js';
import type { TriggerCallback, TriggerPayload } from '../../sprite/triggers.js';
import { logger, safeSetTimeout, clearSafeTimeout } from 'memora';

// ─── 路径常量（使用 resolve 适配 Windows 反斜杠 + sep） ───
/** 白名单根目录：C:\proj\app（或 POSIX 等价） */
const ALLOWED_ROOT = resolve('/proj/app');
/** 白名单子目录：C:\proj\app\sub —— 真正位于根之下 */
const ALLOWED_CHILD = resolve(ALLOWED_ROOT, 'sub');
/** 兄弟目录：C:\proj\application —— 词法前缀匹配根，但非真正子目录（防绕过用例） */
const ALLOWED_SIBLING = resolve('/proj/application');
/** 另一个白名单路径，用于多白名单用例 */
const OTHER_ALLOWED = resolve('/other/dir');

// ─── 工厂辅助 ─────────────────────────────────────────

/**
 * 创建 FileWatcherTrigger 实例
 *
 * @param overrides 覆盖配置；未提供的字段走默认（watchPaths/allowedPaths 默认指向 ALLOWED_ROOT）
 */
function createTrigger(overrides: Partial<FileWatcherConfig> = {}): FileWatcherTrigger {
  return new FileWatcherTrigger({
    watchPaths: overrides.watchPaths ?? [ALLOWED_ROOT],
    ignore: overrides.ignore,
    debounceMs: overrides.debounceMs,
    allowedPaths: overrides.allowedPaths ?? [ALLOWED_ROOT],
  });
}

/**
 * 启动触发器并捕获第 index 次 watch 调用记录
 *
 * @param trigger 待启动的触发器
 * @param cb 触发回调
 * @param index watch 调用索引（默认 0）
 * @returns 对应的 WatchCall（含 callback 与 watcher）
 */
function startAndCapture(
  trigger: FileWatcherTrigger,
  cb: TriggerCallback,
  index = 0,
): WatchCall {
  trigger.start(cb);
  return mockFs.calls[index];
}

// ─── 测试主体 ─────────────────────────────────────────

describe('FileWatcherTrigger', () => {
  beforeEach(() => {
    // 防抖测试依赖 fake timers 接管 safeSetTimeout 透传的原生 setTimeout
    vi.useFakeTimers();
    // 清空 watch 调用捕获（clearAllMocks 不会重置自定义数组）
    mockFs.calls.length = 0;
    // 清除所有 mock 调用记录（保留实现，便于复用）
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 1. 构造与配置（3） ─────────────────────────────

  describe('构造与配置', () => {
    it('name 属性为 "fileWatcher"，且 watchPaths 透传至 watch 调用', () => {
      const trigger = createTrigger({ watchPaths: [ALLOWED_CHILD] });
      expect(trigger.name).toBe('fileWatcher');

      trigger.start(vi.fn());

      // watchPaths 透传：watch 以该路径被调用
      expect(mockFs.calls).toHaveLength(1);
      expect(mockFs.calls[0].path).toBe(ALLOWED_CHILD);

      trigger.stop();
    });

    it('自定义 debounceMs 透传：防抖间隔为 500ms 而非默认 1000ms', () => {
      const trigger = createTrigger({ debounceMs: 500 });
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      // 触发文件变化，safeSetTimeout 以 500ms 注册
      call.callback('change', 'src/foo.ts');
      expect(safeSetTimeout).toHaveBeenCalledWith(expect.any(Function), 500);

      // 499ms 未到防抖间隔，回调不应触发
      vi.advanceTimersByTime(499);
      expect(mockCb).not.toHaveBeenCalled();

      // 再推进 1ms 到达 500ms，回调触发
      vi.advanceTimersByTime(1);
      expect(mockCb).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('自定义 allowedPaths 透传：白名单内子目录允许监听', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_CHILD],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      // allowedPaths 透传：子目录在白名单内 → watch 被调用
      expect(mockFs.calls).toHaveLength(1);
      expect(mockFs.calls[0].path).toBe(ALLOWED_CHILD);

      trigger.stop();
    });
  });

  // ─── 2. isPathAllowed 路径白名单（5） ───────────────

  describe('isPathAllowed 路径白名单', () => {
    it('allowedPaths 为空时拒绝所有路径（安全优先）', () => {
      // 直接构造，不传 allowedPaths → 默认 []
      const trigger = new FileWatcherTrigger({ watchPaths: [ALLOWED_ROOT] });
      trigger.start(vi.fn());

      // 无白名单 → watch 不被调用
      expect(mockFs.calls).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: ALLOWED_ROOT, allowedPaths: [] }),
        '文件监听路径越界，已跳过',
      );

      trigger.stop();
    });

    it('路径等于白名单根目录（resolved === allowedRoot）→ 允许监听', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_ROOT],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      expect(mockFs.calls).toHaveLength(1);

      trigger.stop();
    });

    it('路径在白名单子目录（startsWith allowedRoot + sep）→ 允许监听', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_CHILD],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      expect(mockFs.calls).toHaveLength(1);
      // 佐证：子目录确实以 "根 + 分隔符" 为前缀
      expect(ALLOWED_CHILD.startsWith(ALLOWED_ROOT + sep)).toBe(true);

      trigger.stop();
    });

    it('路径是白名单兄弟目录（词法前缀但未追加 sep）→ 拒绝（防绕过）', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_SIBLING],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      // 兄弟目录词法前缀匹配根，但非真正子目录 → 拒绝
      expect(mockFs.calls).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: ALLOWED_SIBLING }),
        '文件监听路径越界，已跳过',
      );
      // 佐证：兄弟目录词法以根开头，但不以 "根 + sep" 开头
      expect(ALLOWED_SIBLING.startsWith(ALLOWED_ROOT)).toBe(true);
      expect(ALLOWED_SIBLING.startsWith(ALLOWED_ROOT + sep)).toBe(false);

      trigger.stop();
    });

    it('多个白名单路径只要任一匹配即允许监听', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_CHILD],
        allowedPaths: [OTHER_ALLOWED, ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      // 第一个白名单不匹配，第二个匹配 → 允许
      expect(mockFs.calls).toHaveLength(1);

      trigger.stop();
    });
  });

  // ─── 3. shouldIgnore 忽略模式（3） ─────────────────

  describe('shouldIgnore 忽略模式', () => {
    it('默认 ignore 匹配 node_modules / .git / dist / .memora（预编译生效）', () => {
      const trigger = createTrigger();
      const call = startAndCapture(trigger, vi.fn());

      // 依次触发各默认忽略模式匹配的文件名 → 均不应进入防抖
      call.callback('change', 'src/node_modules/pkg/index.js');
      call.callback('change', 'src/.git/config');
      call.callback('change', 'src/dist/bundle.js');
      call.callback('change', 'proj/.memora/data.json');

      expect(safeSetTimeout).not.toHaveBeenCalled();

      trigger.stop();
    });

    it('不匹配任何忽略模式 → 触发防抖（safeSetTimeout 调用）', () => {
      const trigger = createTrigger();
      const call = startAndCapture(trigger, vi.fn());

      call.callback('change', 'src/foo.ts');
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('自定义 ignore 模式替换默认：仅自定义模式生效', () => {
      const trigger = createTrigger({ ignore: ['**/custom/**'] });
      const call = startAndCapture(trigger, vi.fn());

      // 自定义模式匹配 → 忽略
      call.callback('change', 'a/custom/file.ts');
      expect(safeSetTimeout).not.toHaveBeenCalled();

      // 默认 node_modules 模式已被替换 → 不再忽略
      call.callback('change', 'src/node_modules/pkg/index.js');
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);

      trigger.stop();
    });
  });

  // ─── 4. start 启动监听（3） ─────────────────────────

  describe('start 启动监听', () => {
    it('路径越界时 logger.warn 并跳过（不创建 watcher）', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_SIBLING],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      expect(mockFs.calls).toHaveLength(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: ALLOWED_SIBLING, allowedPaths: [ALLOWED_ROOT] }),
        '文件监听路径越界，已跳过',
      );
      // 越界路径不应触发成功 info 日志
      expect(logger.info).not.toHaveBeenCalled();

      trigger.stop();
    });

    it('watch 抛错时 logger.warn 并继续处理其他路径', () => {
      // 第一次 watch 调用抛错（模拟 EPERM 等启动失败）
      mockFs.watch.mockImplementationOnce(() => {
        throw new Error('EPERM');
      });

      const trigger = createTrigger({
        watchPaths: [ALLOWED_ROOT, ALLOWED_CHILD],
        allowedPaths: [ALLOWED_ROOT],
      });
      trigger.start(vi.fn());

      // 第一个路径抛错被捕获，第二个路径正常创建 watcher
      expect(mockFs.calls).toHaveLength(1);
      expect(mockFs.calls[0].path).toBe(ALLOWED_CHILD);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path: ALLOWED_ROOT, err: 'EPERM' }),
        '文件监听启动失败',
      );

      trigger.stop();
    });

    it('watcher 注册成功时 logger.info 记录启动', () => {
      const trigger = createTrigger({ watchPaths: [ALLOWED_ROOT] });
      trigger.start(vi.fn());

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ path: ALLOWED_ROOT }),
        '文件监听已启动',
      );

      trigger.stop();
    });
  });

  // ─── 5. stop 停止监听（2） ──────────────────────────

  describe('stop 停止监听', () => {
    it('调用所有 watcher.close() 并清理防抖计时器（clearSafeTimeout）', () => {
      const trigger = createTrigger({
        watchPaths: [ALLOWED_ROOT, ALLOWED_CHILD],
        allowedPaths: [ALLOWED_ROOT],
      });
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      // 制造一个未触发的防抖计时器
      call.callback('change', 'src/foo.ts');
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);

      trigger.stop();

      // 两个 watcher 均被关闭
      expect(mockFs.calls[0].watcher.close).toHaveBeenCalledTimes(1);
      expect(mockFs.calls[1].watcher.close).toHaveBeenCalledTimes(1);
      // 防抖计时器被 clearSafeTimeout 清理
      expect(clearSafeTimeout).toHaveBeenCalled();

      // 推进时间，回调不再触发（计时器已清理）
      vi.advanceTimersByTime(2000);
      expect(mockCb).not.toHaveBeenCalled();
      // safeSetTimeout 仅在 stop 前调用一次
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);
    });

    it('stop 后 callback 置 null：后续事件不再触发回调', () => {
      const trigger = createTrigger();
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      // 首次事件 + 触发
      call.callback('change', 'src/foo.ts');
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(1);

      trigger.stop();

      // stop 后模拟再次事件：callback 已置 null，推进时间后回调不再增加
      call.callback('change', 'src/bar.ts');
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 6. createWatcher 回调逻辑（2） ─────────────────

  describe('createWatcher 回调逻辑', () => {
    it('filename 为 null 或匹配忽略模式时静默返回（不触发防抖）', () => {
      const trigger = createTrigger();
      const call = startAndCapture(trigger, vi.fn());

      // filename 为 null → 静默返回
      call.callback('change', null);
      // filename 匹配忽略模式 → 静默返回
      call.callback('change', 'src/node_modules/pkg/index.js');

      expect(safeSetTimeout).not.toHaveBeenCalled();

      trigger.stop();
    });

    it('filename 正常时调用 debouncedEmit（注册 safeSetTimeout）', () => {
      const trigger = createTrigger();
      const call = startAndCapture(trigger, vi.fn());

      call.callback('change', 'src/foo.ts');
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);

      trigger.stop();
    });
  });

  // ─── 7. debouncedEmit 防抖（3） ─────────────────────

  describe('debouncedEmit 防抖', () => {
    it('首次变化注册 safeSetTimeout，防抖间隔后触发 callback 且参数格式正确', () => {
      const trigger = createTrigger(); // 默认 debounceMs = 1000
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      call.callback('change', 'src/foo.ts');
      expect(safeSetTimeout).toHaveBeenCalledTimes(1);

      // 未到防抖间隔
      vi.advanceTimersByTime(999);
      expect(mockCb).not.toHaveBeenCalled();

      // 到达间隔触发
      vi.advanceTimersByTime(1);
      expect(mockCb).toHaveBeenCalledTimes(1);
      expect(mockCb).toHaveBeenCalledWith({
        reason: '文件变化：src/foo.ts（change）',
        source: 'fileWatcher',
      } satisfies TriggerPayload);

      trigger.stop();
    });

    it('同一文件多次变化只触发一次 callback（防抖间隔内）', () => {
      const trigger = createTrigger();
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      // 同一文件三次变化
      call.callback('change', 'src/foo.ts');
      call.callback('rename', 'src/foo.ts');
      call.callback('change', 'src/foo.ts');

      // safeSetTimeout 被调用三次，但每次会先 clearSafeTimeout 清理上一个
      expect(safeSetTimeout).toHaveBeenCalledTimes(3);
      expect(clearSafeTimeout).toHaveBeenCalled();

      // 推进防抖间隔，仅触发一次
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('不同文件各自独立防抖', () => {
      const trigger = createTrigger();
      const mockCb = vi.fn();
      const call = startAndCapture(trigger, mockCb);

      call.callback('change', 'src/a.ts');
      call.callback('change', 'src/b.ts');

      // 推进防抖间隔，两个文件各触发一次
      vi.advanceTimersByTime(1000);
      expect(mockCb).toHaveBeenCalledTimes(2);
      expect(mockCb).toHaveBeenCalledWith({
        reason: '文件变化：src/a.ts（change）',
        source: 'fileWatcher',
      } satisfies TriggerPayload);
      expect(mockCb).toHaveBeenCalledWith({
        reason: '文件变化：src/b.ts（change）',
        source: 'fileWatcher',
      } satisfies TriggerPayload);

      trigger.stop();
    });
  });

  // ─── 8. error 事件处理（1） ─────────────────

  describe('error 事件处理', () => {
    it("watcher.on('error') 已注册；触发 error 时 logger.error 记录且不抛未捕获异常", () => {
      const trigger = createTrigger();
      const call = startAndCapture(trigger, vi.fn());
      const watcher = call.watcher;

      // createWatcher 中注册了 on('error', ...)
      expect(watcher.on).toHaveBeenCalledWith('error', expect.any(Function));

      // 取出 error 处理器并手动触发
      const onErrorCall = watcher.on.mock.calls.find(c => c[0] === 'error');
      expect(onErrorCall).toBeDefined();
      if (!onErrorCall) return; // 类型收窄，逻辑不可达
      const errorHandler = onErrorCall[1];

      const boom = new Error('监听目录被删除');
      // 不应抛出未捕获异常（修复的核心目标）
      expect(() => errorHandler(boom)).not.toThrow();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), watchPath: ALLOWED_ROOT }),
        '文件监听器错误，停止该路径监听',
      );

      trigger.stop();
    });
  });
});
