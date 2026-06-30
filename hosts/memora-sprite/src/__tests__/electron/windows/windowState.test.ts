/**
 * 窗口状态管理器测试
 *
 * 覆盖范围：
 * - 常量：FLOAT_SIZE / FULL_SIZE / DEFAULT_FLOAT_POSITION
 * - 构造器：默认值 / 自定义值
 * - transition：tray↔full 转换 / 同态跳过 / 窗口显示隐藏 / 持久化触发
 * - showInitial：full 态显示 / tray+气泡显示 / tray+气泡隐藏 / isDestroyed 守卫
 * - getShowFloatBubble / setShowFloatBubble：查询 / 设置 / 立即生效 / 同值跳过
 * - saveFloatPosition：保存位置 + 持久化
 * - getState / getFloatSize / getFullSize：访问器
 * - attachFloatWindow / attachFullWindow：窗口注入
 * - persistState：持久化回调触发 + 数据结构
 *
 * Mock 策略：
 * - BrowserWindow：简单对象 mock isDestroyed/show/hide/focus/setPosition
 * - onSaveState：vi.fn() 捕获持久化调用
 */
import { describe, it, expect, vi } from 'vitest';
import {
  WindowStateManager,
  FLOAT_SIZE,
  FULL_SIZE,
  DEFAULT_FLOAT_POSITION,
} from '../../../electron/windows/windowState.js';
import type { BrowserWindow } from 'electron';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock BrowserWindow（捕获 show/hide/focus/setPosition 调用） */
function createMockWindow(destroyed = false): BrowserWindow & {
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
} {
  return {
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    setPosition: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
  } as unknown as BrowserWindow & {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
}

// ─── 常量 ────────────────────────────────────────────────

describe('窗口尺寸常量', () => {
  it('FLOAT_SIZE 应为 80x80（悬浮球尺寸）', () => {
    expect(FLOAT_SIZE).toEqual({ width: 80, height: 80 });
  });

  it('FULL_SIZE 应为 900x680（确保侧边栏+主内容区空间）', () => {
    expect(FULL_SIZE).toEqual({ width: 900, height: 680 });
  });

  it('DEFAULT_FLOAT_POSITION 应为屏幕左上角偏移 (100, 100)', () => {
    expect(DEFAULT_FLOAT_POSITION).toEqual({ x: 100, y: 100 });
  });
});

// ─── 构造器 ──────────────────────────────────────────────

describe('WindowStateManager 构造器', () => {
  it('无参数时应使用默认值', () => {
    const manager = new WindowStateManager();
    expect(manager.getState()).toBe('tray');
    expect(manager.getFloatSize()).toEqual(FLOAT_SIZE);
    expect(manager.getFullSize()).toEqual(FULL_SIZE);
    expect(manager.getShowFloatBubble()).toBe(true);
  });

  it('应支持自定义 defaultState', () => {
    const manager = new WindowStateManager({ defaultState: 'full' });
    expect(manager.getState()).toBe('full');
  });

  it('应支持自定义 floatPosition', () => {
    const manager = new WindowStateManager({ floatPosition: { x: 200, y: 300 } });
    // floatPosition 通过 saveFloatPosition 或 persistState 间接验证
    manager.saveFloatPosition(200, 300);
    expect(manager.getState()).toBe('tray');
  });

  it('应支持自定义 floatSize', () => {
    const manager = new WindowStateManager({ floatSize: { width: 100, height: 100 } });
    expect(manager.getFloatSize()).toEqual({ width: 100, height: 100 });
  });

  it('应支持自定义 fullSize', () => {
    const manager = new WindowStateManager({ fullSize: { width: 1200, height: 800 } });
    expect(manager.getFullSize()).toEqual({ width: 1200, height: 800 });
  });

  it('应支持自定义 showFloatBubble', () => {
    const manager = new WindowStateManager({ showFloatBubble: false });
    expect(manager.getShowFloatBubble()).toBe(false);
  });
});

// ─── transition 状态转换 ─────────────────────────────────

describe('transition 状态转换', () => {
  it('tray → full 应切换状态 + 隐藏浮动窗口 + 显示完整窗口', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({ defaultState: 'tray', onSaveState });
    const floatWin = createMockWindow();
    const fullWin = createMockWindow();
    manager.attachFloatWindow(floatWin);
    manager.attachFullWindow(fullWin);

    manager.transition('full');

    expect(manager.getState()).toBe('full');
    // tray 态隐藏的是浮动窗口
    expect(floatWin.hide).toHaveBeenCalledTimes(1);
    // full 态显示完整窗口 + focus
    expect(fullWin.show).toHaveBeenCalledTimes(1);
    expect(fullWin.focus).toHaveBeenCalledTimes(1);
    // 持久化应触发
    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({ windowState: 'full' }),
    );
  });

  it('full → tray 应切换状态 + 隐藏完整窗口 + 显示浮动窗口（气泡可见时）', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({
      defaultState: 'full',
      showFloatBubble: true,
      onSaveState,
    });
    const floatWin = createMockWindow();
    const fullWin = createMockWindow();
    manager.attachFloatWindow(floatWin);
    manager.attachFullWindow(fullWin);

    manager.transition('tray');

    expect(manager.getState()).toBe('tray');
    // full 态隐藏完整窗口
    expect(fullWin.hide).toHaveBeenCalledTimes(1);
    // tray 态 + 气泡可见 → 显示浮动窗口 + setPosition
    expect(floatWin.show).toHaveBeenCalledTimes(1);
    expect(floatWin.setPosition).toHaveBeenCalledTimes(1);
  });

  it('full → tray 气泡隐藏时不应显示浮动窗口', () => {
    const manager = new WindowStateManager({
      defaultState: 'full',
      showFloatBubble: false,
    });
    const floatWin = createMockWindow();
    const fullWin = createMockWindow();
    manager.attachFloatWindow(floatWin);
    manager.attachFullWindow(fullWin);

    manager.transition('tray');

    expect(manager.getState()).toBe('tray');
    expect(fullWin.hide).toHaveBeenCalledTimes(1);
    // 气泡隐藏时不应显示浮动窗口
    expect(floatWin.show).not.toHaveBeenCalled();
  });

  it('同态转换应跳过（tray → tray）', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({ defaultState: 'tray', onSaveState });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.transition('tray');

    // 同态不应触发任何窗口操作和持久化
    expect(floatWin.hide).not.toHaveBeenCalled();
    expect(floatWin.show).not.toHaveBeenCalled();
    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('同态转换应跳过（full → full）', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({ defaultState: 'full', onSaveState });

    manager.transition('full');

    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('窗口已销毁时不应调用 show/hide（isDestroyed 守卫）', () => {
    const manager = new WindowStateManager({ defaultState: 'tray' });
    const floatWin = createMockWindow(true); // destroyed = true
    const fullWin = createMockWindow(true);
    manager.attachFloatWindow(floatWin);
    manager.attachFullWindow(fullWin);

    manager.transition('full');

    // 窗口已销毁，hide/show 均不应调用
    expect(floatWin.hide).not.toHaveBeenCalled();
    expect(fullWin.show).not.toHaveBeenCalled();
  });

  it('未注入窗口实例时 transition 不应抛错', () => {
    const manager = new WindowStateManager({ defaultState: 'tray' });
    // 不调用 attachFloatWindow / attachFullWindow
    expect(() => manager.transition('full')).not.toThrow();
    expect(manager.getState()).toBe('full');
  });
});

// ─── showInitial 首次显示 ────────────────────────────────

describe('showInitial 首次显示', () => {
  it('full 态应显示完整窗口 + focus', () => {
    const manager = new WindowStateManager({ defaultState: 'full' });
    const fullWin = createMockWindow();
    manager.attachFullWindow(fullWin);

    manager.showInitial();

    expect(fullWin.show).toHaveBeenCalledTimes(1);
    expect(fullWin.focus).toHaveBeenCalledTimes(1);
  });

  it('tray 态 + 气泡可见应显示浮动窗口 + setPosition', () => {
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: true,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.showInitial();

    expect(floatWin.setPosition).toHaveBeenCalledWith(100, 100);
    expect(floatWin.show).toHaveBeenCalledTimes(1);
  });

  it('tray 态 + 气泡隐藏不应显示任何窗口', () => {
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: false,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.showInitial();

    expect(floatWin.show).not.toHaveBeenCalled();
  });

  it('窗口已销毁时不应调用 show（isDestroyed 守卫）', () => {
    const manager = new WindowStateManager({ defaultState: 'full' });
    const fullWin = createMockWindow(true);
    manager.attachFullWindow(fullWin);

    manager.showInitial();

    expect(fullWin.show).not.toHaveBeenCalled();
  });

  it('未注入窗口实例时不应抛错', () => {
    const manager = new WindowStateManager({ defaultState: 'full' });
    expect(() => manager.showInitial()).not.toThrow();
  });
});

// ─── 浮动气泡偏好 ───────────────────────────────────────

describe('getShowFloatBubble / setShowFloatBubble', () => {
  it('getShowFloatBubble 应返回当前偏好', () => {
    const manager = new WindowStateManager({ showFloatBubble: true });
    expect(manager.getShowFloatBubble()).toBe(true);
  });

  it('setShowFloatBubble(true) 在 tray 态应立即显示浮动窗口', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: false,
      onSaveState,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.setShowFloatBubble(true);

    expect(manager.getShowFloatBubble()).toBe(true);
    expect(floatWin.setPosition).toHaveBeenCalledWith(100, 100);
    expect(floatWin.show).toHaveBeenCalledTimes(1);
    expect(onSaveState).toHaveBeenCalled();
  });

  it('setShowFloatBubble(false) 在 tray 态应立即隐藏浮动窗口', () => {
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: true,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.setShowFloatBubble(false);

    expect(manager.getShowFloatBubble()).toBe(false);
    expect(floatWin.hide).toHaveBeenCalledTimes(1);
  });

  it('setShowFloatBubble 在 full 态不应影响当前显示', () => {
    const manager = new WindowStateManager({
      defaultState: 'full',
      showFloatBubble: true,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.setShowFloatBubble(false);

    // full 态时浮动气泡始终隐藏，切换偏好不影响当前显示
    expect(floatWin.show).not.toHaveBeenCalled();
    expect(floatWin.hide).not.toHaveBeenCalled();
    expect(manager.getShowFloatBubble()).toBe(false);
  });

  it('同值设置应跳过（true → true）', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({
      showFloatBubble: true,
      onSaveState,
    });

    manager.setShowFloatBubble(true);

    expect(onSaveState).not.toHaveBeenCalled();
  });

  it('窗口已销毁时 setShowFloatBubble 不应调用 show/hide', () => {
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: false,
    });
    const floatWin = createMockWindow(true);
    manager.attachFloatWindow(floatWin);

    manager.setShowFloatBubble(true);

    expect(floatWin.show).not.toHaveBeenCalled();
  });
});

// ─── saveFloatPosition ──────────────────────────────────

describe('saveFloatPosition', () => {
  it('应保存位置并触发持久化', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({ onSaveState });

    manager.saveFloatPosition(250, 350);

    expect(onSaveState).toHaveBeenCalledWith(
      expect.objectContaining({ floatPosition: { x: 250, y: 350 } }),
    );
  });

  it('保存的位置应在后续 showInitial 中生效', () => {
    const manager = new WindowStateManager({
      defaultState: 'tray',
      showFloatBubble: true,
    });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.saveFloatPosition(500, 600);
    manager.showInitial();

    expect(floatWin.setPosition).toHaveBeenCalledWith(500, 600);
  });
});

// ─── 访问器 ─────────────────────────────────────────────

describe('访问器', () => {
  it('getState 应返回当前状态', () => {
    const manager = new WindowStateManager({ defaultState: 'tray' });
    expect(manager.getState()).toBe('tray');
    manager.transition('full');
    expect(manager.getState()).toBe('full');
  });

  it('getFloatSize 应返回浮动窗口尺寸', () => {
    const manager = new WindowStateManager();
    expect(manager.getFloatSize()).toEqual(FLOAT_SIZE);
  });

  it('getFullSize 应返回完整窗口尺寸', () => {
    const manager = new WindowStateManager();
    expect(manager.getFullSize()).toEqual(FULL_SIZE);
  });
});

// ─── 持久化回调 ─────────────────────────────────────────

describe('persistState 持久化回调', () => {
  it('transition 应触发持久化回调', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({ defaultState: 'tray', onSaveState });

    manager.transition('full');

    expect(onSaveState).toHaveBeenCalledTimes(1);
  });

  it('持久化数据应包含 windowState/floatPosition/showFloatBubble', () => {
    const onSaveState = vi.fn();
    const manager = new WindowStateManager({
      defaultState: 'tray',
      floatPosition: { x: 200, y: 200 },
      showFloatBubble: true,
      onSaveState,
    });

    manager.transition('full');

    expect(onSaveState).toHaveBeenCalledWith({
      windowState: 'full',
      floatPosition: { x: 200, y: 200 },
      showFloatBubble: true,
    });
  });

  it('无 onSaveState 回调时不应抛错', () => {
    const manager = new WindowStateManager({ defaultState: 'tray' });
    expect(() => manager.transition('full')).not.toThrow();
  });
});

// ─── 窗口注入 ───────────────────────────────────────────

describe('attachFloatWindow / attachFullWindow', () => {
  it('attachFloatWindow 应注入浮动窗口实例', () => {
    const manager = new WindowStateManager({ defaultState: 'tray', showFloatBubble: true });
    const floatWin = createMockWindow();
    manager.attachFloatWindow(floatWin);

    manager.showInitial();

    expect(floatWin.show).toHaveBeenCalledTimes(1);
  });

  it('attachFullWindow 应注入完整窗口实例', () => {
    const manager = new WindowStateManager({ defaultState: 'full' });
    const fullWin = createMockWindow();
    manager.attachFullWindow(fullWin);

    manager.showInitial();

    expect(fullWin.show).toHaveBeenCalledTimes(1);
  });
});
