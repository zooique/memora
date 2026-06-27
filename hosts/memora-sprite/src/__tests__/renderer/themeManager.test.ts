/**
 * 主题管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - getTheme：默认 light / 已设 dark
 * - getThemeMode：返回 themeMode
 * - setTheme light：移除 data-theme + localStorage 缓存 + 触发回调 user
 * - setTheme dark：设置 data-theme='dark' + localStorage 缓存 + 触发回调 user
 * - setTheme auto：调用 getSystemTheme + 注册 mediaQueryListener
 * - setTheme localStorage 降级：抛错时静默退出
 * - syncThemeColorMeta：dark/light 更新 + meta 缺失静默
 * - syncThemeRadios：选中对应 radio + 多 radios 同步
 * - mediaQueryListener 触发：系统主题变化 + source='system' + 同步 data-theme + localStorage
 * - getSystemTheme 降级：matchMedia 不支持返回 light
 * - updateMediaQueryListener：切换到非 auto 移除旧监听器
 * - cleanup：移除 mediaQueryListener
 * - onThemeChange：注册回调
 *
 * Mock 策略：
 * - mock window.matchMedia 返回可控的 MediaQueryList（matches + addEventListener/removeEventListener）
 * - JSDOM 提供真实 DOM API（document.documentElement.setAttribute/localStorage/querySelector）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThemeManager } from '../../electron/renderer/components/themeManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 可控的 MediaQueryList mock */
interface MockMediaQueryList {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

/** 创建 mock MediaQueryList */
function createMockMQL(matches = false): MockMediaQueryList {
  return {
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

/** 创建带 DOM + meta + radios 的 ThemeManager */
function createManager(opts?: {
  html?: string;
  mqlMatches?: boolean;
}): { manager: ThemeManager; mql: MockMediaQueryList } {
  // 默认 DOM：theme-color meta + 3 个主题单选按钮
  document.body.innerHTML = opts?.html ?? `
    <meta name="theme-color" content="#f0f0f2" />
    <input type="radio" name="theme-mode" value="light" />
    <input type="radio" name="theme-mode" value="dark" />
    <input type="radio" name="theme-mode" value="auto" />
  `;

  // mock window.matchMedia（JSDOM 默认不实现，需用 defineProperty 注入）
  const mql = createMockMQL(opts?.mqlMatches ?? false);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql as unknown as MediaQueryList),
  });

  return { manager: new ThemeManager(), mql };
}

/** 派发 MediaQueryListEvent（模拟系统主题变化） */
function dispatchMediaChange(mql: MockMediaQueryList, matches: boolean): void {
  // 找到注册的 change 监听器并触发
  const calls = mql.addEventListener.mock.calls;
  const lastCall = calls[calls.length - 1];
  if (lastCall && lastCall[0] === 'change') {
    const listener = lastCall[1] as (e: MediaQueryListEvent) => void;
    // 构造伪 MediaQueryListEvent（JSDOM 可能不支持构造，用对象模拟）
    const fakeEvent = { matches } as MediaQueryListEvent;
    listener(fakeEvent);
  }
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 重置 localStorage（JSDOM 默认提供，但跨测试可能污染）
  localStorage.clear();
  // 重置 document.documentElement 的 data-theme
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

// ─── getTheme ────────────────────────────────────────────

describe('getTheme', () => {
  it('未设置 data-theme 应返回 light（默认）', () => {
    const { manager } = createManager();
    expect(manager.getTheme()).toBe('light');
  });

  it('data-theme="dark" 应返回 dark', () => {
    const { manager } = createManager();
    document.documentElement.setAttribute('data-theme', 'dark');
    expect(manager.getTheme()).toBe('dark');
  });
});

// ─── getThemeMode ────────────────────────────────────────

describe('getThemeMode', () => {
  it('初始值应为 light', () => {
    const { manager } = createManager();
    expect(manager.getThemeMode()).toBe('light');
  });

  it('setTheme 后应返回设置的模式', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    expect(manager.getThemeMode()).toBe('dark');
  });
});

// ─── setTheme · light/dark ───────────────────────────────

describe('setTheme · light', () => {
  it('应移除 data-theme 属性', () => {
    const { manager } = createManager();
    // 先设为 dark
    document.documentElement.setAttribute('data-theme', 'dark');
    manager.setTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('应缓存到 localStorage', () => {
    const { manager } = createManager();
    manager.setTheme('light');
    expect(localStorage.getItem('memora-theme')).toBe('light');
  });

  it('应触发回调 source="user"', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onThemeChange(cb);
    manager.setTheme('light');
    expect(cb).toHaveBeenCalledWith('light', 'user');
  });
});

describe('setTheme · dark', () => {
  it('应设置 data-theme="dark"', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('应缓存到 localStorage', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    expect(localStorage.getItem('memora-theme')).toBe('dark');
  });

  it('应触发回调 source="user"', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onThemeChange(cb);
    manager.setTheme('dark');
    expect(cb).toHaveBeenCalledWith('dark', 'user');
  });
});

// ─── setTheme · auto ─────────────────────────────────────

describe('setTheme · auto', () => {
  it('系统为 dark 时应应用 dark 主题', () => {
    const { manager } = createManager({ mqlMatches: true });
    manager.setTheme('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('memora-theme')).toBe('dark');
  });

  it('系统为 light 时应应用 light 主题', () => {
    const { manager } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(localStorage.getItem('memora-theme')).toBe('light');
  });

  it('应注册 mediaQueryListener', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    expect(mql.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('themeMode 应为 auto（不随系统变化改变）', () => {
    const { manager } = createManager({ mqlMatches: true });
    manager.setTheme('auto');
    expect(manager.getThemeMode()).toBe('auto');
  });

  it('系统主题变化时应触发回调 source="system"', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    const cb = vi.fn();
    manager.onThemeChange(cb);
    manager.setTheme('auto');
    // 模拟系统切换到 dark
    dispatchMediaChange(mql, true);
    expect(cb).toHaveBeenCalledWith('dark', 'system');
    // themeMode 应保持 auto
    expect(manager.getThemeMode()).toBe('auto');
  });

  it('系统主题变化时应同步 data-theme + localStorage', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    // 初始 light
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    // 系统切换到 dark
    dispatchMediaChange(mql, true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('memora-theme')).toBe('dark');
  });
});

// ─── setTheme · 切换模式时监听器管理 ────────────────────

describe('setTheme · 监听器切换', () => {
  it('从 auto 切换到 light 应移除 mediaQueryListener', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);

    manager.setTheme('light');
    // 应移除监听器
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('从 auto 切换到 dark 应移除 mediaQueryListener', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    manager.setTheme('dark');
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('从 light 切换到 dark 不应注册监听器', () => {
    const { manager, mql } = createManager();
    manager.setTheme('light');
    manager.setTheme('dark');
    // 非 auto 模式不注册监听器
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });
});

// ─── getSystemTheme 降级 ─────────────────────────────────

describe('getSystemTheme · 降级', () => {
  it('matchMedia 不支持时应返回 light', () => {
    // 模拟 matchMedia 不存在（删除属性）
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const manager = new ThemeManager();
    // setTheme('auto') 内部调用 getSystemTheme，应降级为 light
    manager.setTheme('auto');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(localStorage.getItem('memora-theme')).toBe('light');
  });
});

// ─── syncThemeColorMeta ──────────────────────────────────

describe('syncThemeColorMeta', () => {
  it('dark 主题应更新 theme-color 为 #1e1e2e', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    expect(meta.content).toBe('#1e1e2e');
  });

  it('light 主题应更新 theme-color 为 #f0f0f2', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    manager.setTheme('light');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    expect(meta.content).toBe('#f0f0f2');
  });

  it('meta 不存在时不应抛错', () => {
    const { manager } = createManager({
      html: '<input type="radio" name="theme-mode" value="light" />',
    });
    expect(() => manager.setTheme('dark')).not.toThrow();
  });

  it('auto 模式下系统变化应同步 theme-color', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
    // 初始 light
    expect(meta.content).toBe('#f0f0f2');
    // 系统切换到 dark
    dispatchMediaChange(mql, true);
    expect(meta.content).toBe('#1e1e2e');
  });
});

// ─── syncThemeRadios ─────────────────────────────────────

describe('syncThemeRadios', () => {
  it('应选中对应值的 radio', () => {
    const { manager } = createManager();
    manager.setTheme('dark');
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    expect(radios[0].checked).toBe(false); // light
    expect(radios[1].checked).toBe(true);  // dark
    expect(radios[2].checked).toBe(false); // auto
  });

  it('应支持 auto 选中', () => {
    const { manager } = createManager();
    manager.setTheme('auto');
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    expect(radios[2].checked).toBe(true); // auto
  });

  it('无 radio 时不应抛错', () => {
    const { manager } = createManager({ html: '' });
    expect(() => manager.setTheme('dark')).not.toThrow();
  });
});

// ─── setTheme · localStorage 降级 ────────────────────────

describe('setTheme · localStorage 降级', () => {
  it('localStorage 抛错时应静默退出（不中断主题应用）', () => {
    const { manager } = createManager();
    // mock localStorage.setItem 抛错（模拟隐私模式）
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    // 不应抛错，data-theme 仍应被设置
    expect(() => manager.setTheme('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

// ─── onThemeChange ───────────────────────────────────────

describe('onThemeChange', () => {
  it('注册回调后 setTheme 应触发', () => {
    const { manager } = createManager();
    const cb = vi.fn();
    manager.onThemeChange(cb);
    manager.setTheme('dark');
    expect(cb).toHaveBeenCalledWith('dark', 'user');
  });

  it('未注册回调时 setTheme 不应抛错', () => {
    const { manager } = createManager();
    expect(() => manager.setTheme('dark')).not.toThrow();
  });

  it('多次注册应覆盖前者', () => {
    const { manager } = createManager();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    manager.onThemeChange(cb1);
    manager.onThemeChange(cb2);
    manager.setTheme('dark');
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledWith('dark', 'user');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('auto 模式下 cleanup 应移除 mediaQueryListener', () => {
    const { manager, mql } = createManager({ mqlMatches: false });
    manager.setTheme('auto');
    manager.cleanup();
    expect(mql.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('非 auto 模式 cleanup 不应抛错', () => {
    const { manager } = createManager();
    manager.setTheme('light');
    expect(() => manager.cleanup()).not.toThrow();
  });

  it('matchMedia 不支持时 cleanup 不应抛错', () => {
    // 模拟 matchMedia 不存在
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    const manager = new ThemeManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});
