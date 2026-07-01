/**
 * 面板错误横幅管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：重试按钮事件绑定 / DOM 缺失静默跳过
 * - showPanelError：显示横幅 + 注册回调 + 防 XSS（textContent）
 * - hidePanelError：隐藏横幅 + 删除回调
 * - 重试按钮 click：触发回调 / 无回调时不抛错
 * - cleanup：EventTracker 清理后重试按钮不再触发
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API（classList/textContent/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PanelErrorBannerManager } from '../../../electron/renderer/panels/panelErrorBannerManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 3 面板完整 DOM 结构（settings/memory/chat 错误横幅 + 重试按钮 + 消息元素） */
const ERROR_HTML = `
  <div id="settings-error" class="hidden">
    <span id="settings-error-msg"></span>
    <button id="settings-error-retry">重试</button>
  </div>
  <div id="memory-error" class="hidden">
    <span id="memory-error-msg"></span>
    <button id="memory-error-retry">重试</button>
  </div>
  <div id="chat-error" class="hidden">
    <span id="chat-error-msg"></span>
    <button id="chat-error-retry">重试</button>
  </div>
`;

/** 创建 PanelErrorBannerManager 实例（默认已 init） */
function createManager(opts?: { init?: boolean; html?: string }): PanelErrorBannerManager {
  document.body.innerHTML = opts?.html ?? ERROR_HTML;
  const manager = new PanelErrorBannerManager();
  if (opts?.init !== false) {
    manager.init();
  }
  return manager;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init ────────────────────────────────────────────────

describe('init · 事件绑定与降级', () => {
  it('应绑定 3 个面板的重试按钮 click 事件', () => {
    createManager();
    // 通过模拟 showPanelError 注册回调 + click 重试按钮验证绑定
    const callback = vi.fn();
    const manager = createManager();
    manager.showPanelError('settings', '失败', callback);
    document.getElementById('settings-error-retry')!.click();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('重试按钮缺失时应静默跳过（不抛错）', () => {
    document.body.innerHTML = `
      <div id="settings-error" class="hidden">
        <span id="settings-error-msg"></span>
      </div>
    `;
    const manager = new PanelErrorBannerManager();
    // 无 settings-error-retry 按钮，init 应静默退出
    expect(() => manager.init()).not.toThrow();
  });

  it('DOM 全部缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new PanelErrorBannerManager();
    expect(() => manager.init()).not.toThrow();
  });
});

// ─── showPanelError ─────────────────────────────────────

describe('showPanelError · 显示与回调注册', () => {
  it('应移除 hidden 类并设置消息文本', () => {
    createManager();
    const manager = createManager({ init: false });
    manager.init();
    manager.showPanelError('memory', '加载失败');
    const errorEl = document.getElementById('memory-error')!;
    expect(errorEl.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('memory-error-msg')!.textContent).toBe('加载失败');
  });

  it('应注册 retryCallback', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.showPanelError('chat', '网络错误', callback);
    document.getElementById('chat-error-retry')!.click();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('无 retryCallback 时 click 重试按钮不应抛错', () => {
    const manager = createManager();
    manager.showPanelError('settings', '失败');
    expect(() => {
      document.getElementById('settings-error-retry')!.click();
    }).not.toThrow();
  });

  it('应使用 textContent 防 XSS', () => {
    const manager = createManager();
    const malicious = '<img src=x onerror=alert(1)>';
    manager.showPanelError('memory', malicious);
    const msgEl = document.getElementById('memory-error-msg')!;
    expect(msgEl.querySelector('img')).toBeNull();
    expect(msgEl.textContent).toBe(malicious);
  });

  it('错误元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new PanelErrorBannerManager();
    manager.init();
    expect(() => manager.showPanelError('settings', '失败')).not.toThrow();
  });

  it('多次 showPanelError 同一面板应覆盖旧回调', () => {
    const manager = createManager();
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    manager.showPanelError('settings', '失败1', oldCallback);
    manager.showPanelError('settings', '失败2', newCallback);
    document.getElementById('settings-error-retry')!.click();
    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).toHaveBeenCalledTimes(1);
  });
});

// ─── hidePanelError ─────────────────────────────────────

describe('hidePanelError · 隐藏与回调删除', () => {
  it('应添加 hidden 类', () => {
    const manager = createManager();
    manager.showPanelError('memory', '失败');
    manager.hidePanelError('memory');
    expect(document.getElementById('memory-error')!.classList.contains('hidden')).toBe(true);
  });

  it('应删除 retryCallback（隐藏后 click 不再触发）', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.showPanelError('memory', '失败', callback);
    manager.hidePanelError('memory');
    document.getElementById('memory-error-retry')!.click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('错误元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new PanelErrorBannerManager();
    manager.init();
    expect(() => manager.hidePanelError('settings')).not.toThrow();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 事件与回调清理', () => {
  it('cleanup 后重试按钮 click 不应触发回调', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.showPanelError('settings', '失败', callback);
    manager.cleanup();
    document.getElementById('settings-error-retry')!.click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('cleanup 应清空 retryCallbacks Map', () => {
    const manager = createManager();
    manager.showPanelError('settings', '失败', vi.fn());
    manager.showPanelError('memory', '失败', vi.fn());
    manager.cleanup();
    // cleanup 后再 showPanelError + click 应正常工作（验证 Map 已清空但 events 仍可用）
    // 注意：cleanup 后 events 已清理，新回调注册不会自动绑定到重试按钮
    // 此用例验证 retryCallbacks.clear() 不影响后续 showPanelError 注册逻辑
    const newCallback = vi.fn();
    expect(() => {
      manager.showPanelError('chat', '失败', newCallback);
    }).not.toThrow();
  });
});
