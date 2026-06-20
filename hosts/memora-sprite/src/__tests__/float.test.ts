/**
 * 浮动窗口交互逻辑测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 拖动检测（mousedown → mousemove 超过阈值 → mouseup 保存位置）
 * - 单击展开（mousedown → mouseup 未超过阈值 → expandToFull）
 * - 右键菜单（contextmenu → showFloatContextMenu）
 * - 未读计数监听（onFloatUnread）
 * - 精灵事件监听（proactivePrompt → bounce 弹跳）
 * - 拖动引导提示（localStorage + drag-hint visibility）
 * - 元素缺失防护（静默退出）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { initFloatWindow, type FloatElectronAPI } from '../electron/renderer/float.js';

/** 测试辅助：初始化浮动窗口并返回 cleanup 函数 */
function setupFloat(mockAPI: FloatElectronAPI): () => void {
  return initFloatWindow(mockAPI);
}

/** float.html 的 DOM 结构 */
const FLOAT_HTML = `<!DOCTYPE html>
<html><body>
  <div id="sphere">
    <div id="sphere-inner">
      <div id="sphere-glow">
        <span id="sphere-emoji">🧚</span>
        <img id="sphere-image" src="" alt="精灵形态" style="display:none;" />
      </div>
      <div id="status-dot"></div>
    </div>
    <div id="badge">0</div>
    <div id="drag-hint">💡 拖动移动 · 单击展开</div>
  </div>
</body></html>`;

/** 创建 FloatElectronAPI mock */
function createMockFloatAPI(): FloatElectronAPI {
  return {
    startFloatDrag: vi.fn(),
    moveFloatWindow: vi.fn(),
    saveFloatPosition: vi.fn(),
    expandToFull: vi.fn(),
    showFloatContextMenu: vi.fn(),
    onFloatUnread: vi.fn(),
    onSpriteEvent: vi.fn(),
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

let dom: JSDOM;
let mockAPI: FloatElectronAPI;
let unreadCallback: ((count: number) => void) | null = null;
let spriteEventCallback: ((event: { type: string; payload: { prompt?: string; imageUrl?: string; silent?: boolean } }) => void) | null = null;

beforeEach(() => {
  dom = new JSDOM(FLOAT_HTML, { url: 'http://localhost' });
  global.document = dom.window.document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLImageElement = dom.window.HTMLImageElement;

  // 注入 localStorage（JSDOM 中需显式设为全局变量，否则 float.ts 中直接引用 localStorage 会指向 undefined）
  const storage: Record<string, string> = {};
  const localStorageMock = {
    getItem: vi.fn((key: string) => storage[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { storage[key] = value; }),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };
  Object.defineProperty(dom.window, 'localStorage', {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
  (global as unknown as Record<string, unknown>).localStorage = localStorageMock;

  mockAPI = createMockFloatAPI();
  // 捕获 onFloatUnread 回调
  mockAPI.onFloatUnread = vi.fn((cb: (count: number) => void) => {
    unreadCallback = cb;
  });
  // 捕获 onSpriteEvent 回调
  mockAPI.onSpriteEvent = vi.fn((cb) => {
    spriteEventCallback = cb;
  });

  unreadCallback = null;
  spriteEventCallback = null;
});

afterEach(() => {
  dom.window.close();
});

// ─── 拖动检测 ─────────────────────────────────────────────

describe('拖动检测', () => {
  it('移动超过 3px 阈值时触发拖动并调用 startFloatDrag', () => {
    setupFloat(mockAPI);

    // 鼠标按下（派发到 document，监听器注册在 document 上）
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));

    // 移动超过阈值
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 105, screenY: 100, button: 0, buttons: 1,
    }));

    expect(mockAPI.startFloatDrag).toHaveBeenCalled();
    const sphere = document.getElementById('sphere')!;
    expect(sphere.classList.contains('dragging')).toBe(true);
  });

  it('移动未超过 3px 阈值时不触发拖动', () => {
    setupFloat(mockAPI);

    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 101, screenY: 101, button: 0, buttons: 1,
    }));

    // 未超过阈值，不应调用 moveFloatWindow
    expect(mockAPI.moveFloatWindow).not.toHaveBeenCalled();
  });

  it('拖动结束后保存位置', () => {
    setupFloat(mockAPI);

    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 110, screenY: 100, button: 0, buttons: 1,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mouseup', {
      screenX: 110, screenY: 100, button: 0,
    }));

    expect(mockAPI.saveFloatPosition).toHaveBeenCalled();
    const sphere = document.getElementById('sphere')!;
    expect(sphere.classList.contains('dragging')).toBe(false);
  });

  it('连续拖动时传递增量移动', () => {
    setupFloat(mockAPI);

    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 105, screenY: 100, buttons: 1,
    }));
    // 第一次 mousemove 触发 drag 起始，startFloatDrag 被调用
    expect(mockAPI.startFloatDrag).toHaveBeenCalled();

    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 108, screenY: 102, buttons: 1,
    }));
    // 增量移动 (108-105, 102-100) = (3, 2)
    expect(mockAPI.moveFloatWindow).toHaveBeenCalledWith(3, 2);
  });
});

// ─── 单击展开 ─────────────────────────────────────────────

describe('单击展开', () => {
  it('未拖动时单击展开为完整窗口', () => {
    setupFloat(mockAPI);

    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 101, screenY: 100, button: 0, buttons: 1,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mouseup', {
      screenX: 101, screenY: 100, button: 0,
    }));

    // 移动未超阈值，应触发单击展开
    expect(mockAPI.expandToFull).toHaveBeenCalled();
    expect(mockAPI.saveFloatPosition).not.toHaveBeenCalled();
  });
});

// ─── 右键菜单 ─────────────────────────────────────────────

describe('右键菜单', () => {
  it('右键点击阻止默认行为并通知主进程', () => {
    setupFloat(mockAPI);

    const event = new dom.window.MouseEvent('contextmenu', {
      button: 2, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(event);

    expect(mockAPI.showFloatContextMenu).toHaveBeenCalled();
  });
});

// ─── 未读计数 ─────────────────────────────────────────────

describe('未读计数', () => {
  it('正数未读计数时显示徽章', () => {
    setupFloat(mockAPI);

    expect(unreadCallback).not.toBeNull();
    unreadCallback!(5);

    const badge = document.getElementById('badge')!;
    expect(badge.textContent).toBe('5');
    expect(badge.classList.contains('visible')).toBe(true);
  });

  it('超过 99 时显示 99+', () => {
    setupFloat(mockAPI);

    unreadCallback!(100);

    const badge = document.getElementById('badge')!;
    expect(badge.textContent).toBe('99+');
  });

  it('计数为 0 时隐藏徽章', () => {
    setupFloat(mockAPI);

    unreadCallback!(5);
    unreadCallback!(0);

    const badge = document.getElementById('badge')!;
    expect(badge.classList.contains('visible')).toBe(false);
  });
});

// ─── 精灵事件 ─────────────────────────────────────────────

describe('精灵事件', () => {
  it('proactivePrompt 事件触发球体弹跳', () => {
    vi.useFakeTimers();
    setupFloat(mockAPI);

    expect(spriteEventCallback).not.toBeNull();
    spriteEventCallback!({ type: 'proactivePrompt', payload: {} });

    const sphere = document.getElementById('sphere')!;
    expect(sphere.classList.contains('bounce')).toBe(true);

    // 600ms 后弹跳移除
    vi.advanceTimersByTime(600);
    expect(sphere.classList.contains('bounce')).toBe(false);

    vi.useRealTimers();
  });

  it('proactivePrompt 事件切换状态点为活跃', () => {
    vi.useFakeTimers();
    setupFloat(mockAPI);

    spriteEventCallback!({ type: 'proactivePrompt', payload: {} });

    const statusDot = document.getElementById('status-dot')!;
    expect(statusDot.classList.contains('active')).toBe(true);

    // 3 秒后恢复 idle
    vi.advanceTimersByTime(3000);
    expect(statusDot.classList.contains('active')).toBe(false);

    vi.useRealTimers();
  });

  it('formUpdate 事件切换形态图片', () => {
    setupFloat(mockAPI);

    spriteEventCallback!({
      type: 'formUpdate',
      payload: { imageUrl: 'data:image/png;base64,test' },
    });

    const image = document.getElementById('sphere-image') as HTMLImageElement;
    const emoji = document.getElementById('sphere-emoji')!;

    expect(image.src).toContain('data:image/png');
    expect(image.style.display).toBe('block');
    expect(emoji.style.display).toBe('none');
  });
});

// ─── 拖动引导提示 ─────────────────────────────────────────

describe('拖动引导提示', () => {
  it('首次悬停时显示引导提示', () => {
    setupFloat(mockAPI);

    const sphere = document.getElementById('sphere')!;
    const dragHint = document.getElementById('drag-hint')!;

    // mouseenter 不冒泡，使用 Event 类型触发（JSDOM 兼容）
    sphere.dispatchEvent(new dom.window.Event('mouseenter'));

    expect(dragHint.classList.contains('visible')).toBe(true);
  });

  it('首次拖动后引导提示消失', () => {
    setupFloat(mockAPI);

    // 拖动超过阈值
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 110, screenY: 100, buttons: 1,
    }));

    const dragHint = document.getElementById('drag-hint')!;
    expect(dragHint.classList.contains('visible')).toBe(false);
    // 确认 localStorage 已标记
    expect(dom.window.localStorage.setItem).toHaveBeenCalledWith('memora-drag-hint-seen', '1');
  });

  it('首次单击后引导提示消失', () => {
    setupFloat(mockAPI);

    // 单击（未超过阈值）
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mouseup', {
      screenX: 100, screenY: 100,
    }));

    const dragHint = document.getElementById('drag-hint')!;
    expect(dragHint.classList.contains('visible')).toBe(false);
    expect(dom.window.localStorage.setItem).toHaveBeenCalledWith('memora-drag-hint-seen', '1');
  });

  it('已见过引导后不再重复显示', () => {
    // 模拟已见过引导
    (dom.window.localStorage.getItem as ReturnType<typeof vi.fn>).mockReturnValue('1');

    setupFloat(mockAPI);

    const sphere = document.getElementById('sphere')!;
    const dragHint = document.getElementById('drag-hint')!;

    sphere.dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: true }));
    expect(dragHint.classList.contains('visible')).toBe(false);
  });
});

// ─── 清理函数 ─────────────────────────────────────────────

describe('清理函数', () => {
  it('调用 cleanup 后事件监听器被移除，拖动不再触发', () => {
    const cleanup = setupFloat(mockAPI);

    // 先确认拖动正常工作
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 110, screenY: 100, button: 0, buttons: 1,
    }));
    expect(mockAPI.startFloatDrag).toHaveBeenCalled();

    // 重置 mock 并调用 cleanup
    vi.clearAllMocks();
    cleanup();

    // cleanup 后拖动不应触发任何 API 调用
    document.dispatchEvent(new dom.window.MouseEvent('mousedown', {
      screenX: 100, screenY: 100, button: 0,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mousemove', {
      screenX: 110, screenY: 100, button: 0, buttons: 1,
    }));
    document.dispatchEvent(new dom.window.MouseEvent('mouseup', {
      screenX: 110, screenY: 100, button: 0,
    }));

    expect(mockAPI.moveFloatWindow).not.toHaveBeenCalled();
    expect(mockAPI.saveFloatPosition).not.toHaveBeenCalled();
    expect(mockAPI.expandToFull).not.toHaveBeenCalled();
  });

  it('调用 cleanup 后右键菜单不再触发', () => {
    const cleanup = setupFloat(mockAPI);

    cleanup();
    vi.clearAllMocks();

    const event = new dom.window.MouseEvent('contextmenu', {
      button: 2, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(event);

    expect(mockAPI.showFloatContextMenu).not.toHaveBeenCalled();
  });

  it('调用 cleanup 后球体 mouseenter 事件被移除', () => {
    const cleanup = setupFloat(mockAPI);

    cleanup();

    const sphere = document.getElementById('sphere')!;
    const dragHint = document.getElementById('drag-hint')!;

    // mouseenter 不再触发引导提示
    sphere.dispatchEvent(new dom.window.Event('mouseenter'));
    expect(dragHint.classList.contains('visible')).toBe(false);
  });

  it('cleanup 多次调用不抛异常', () => {
    const cleanup = setupFloat(mockAPI);

    expect(() => {
      cleanup();
      cleanup(); // 第二次调用不应抛异常
    }).not.toThrow();
  });
});

describe('元素缺失防护', () => {
  it('关键元素缺失时静默退出不抛异常', () => {
    // 清空 DOM 后初始化
    document.body.innerHTML = '';

    expect(() => setupFloat(mockAPI)).not.toThrow();
    // 不注册任何事件监听
    expect(mockAPI.onFloatUnread).not.toHaveBeenCalled();
  });
});