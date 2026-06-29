/**
 * 主动提示横幅测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showProactiveBanner：容器/文本元素缺失降级 / 正常显示（移除 hidden + 设置 textContent）
 * - hideProactiveBanner：容器缺失降级 / 正常隐藏（添加 hidden）
 * - initProactiveBannerButtons：4 个按钮回调（view/later/silent/disable）/ 关闭按钮 / 容器缺失降级 / 重复 init 幂等
 * - cleanup：事件监听器解绑（按钮点击不再触发回调）
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - JSDOM 提供真实 DOM API（classList/querySelector/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProactiveBanner } from '../../electron/renderer/components/proactiveBanner.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建完整的 banner DOM 结构（含 4 个操作按钮 + 关闭按钮） */
function setupBannerDom(): void {
  document.body.innerHTML = `
    <div id="proactive-banner" class="hidden">
      <span id="proactive-banner-text"></span>
      <button class="banner-btn" data-action="view">查看</button>
      <button class="banner-btn" data-action="later">稍后</button>
      <button class="banner-btn" data-action="silent">静默 1 小时</button>
      <button class="banner-btn" data-action="disable">不再提醒</button>
      <button class="banner-close">✕</button>
    </div>
  `;
}

/** 创建 ProactiveBanner 实例并初始化按钮回调，返回 manager + 回调 spy */
function createManager(opts?: { initButtons?: boolean }): {
  manager: ProactiveBanner;
  handlers: {
    onView: ReturnType<typeof vi.fn>;
    onLater: ReturnType<typeof vi.fn>;
    onSilent: ReturnType<typeof vi.fn>;
    onDisable: ReturnType<typeof vi.fn>;
  };
} {
  const manager = new ProactiveBanner();
  const handlers = {
    onView: vi.fn(),
    onLater: vi.fn(),
    onSilent: vi.fn(),
    onDisable: vi.fn(),
  };
  if (opts?.initButtons !== false) {
    manager.initProactiveBannerButtons(handlers);
  }
  return { manager, handlers };
}

/** 模拟点击指定 data-action 的按钮 */
function clickActionBtn(action: string): void {
  const btn = document.querySelector<HTMLElement>(`.banner-btn[data-action="${action}"]`);
  if (!btn) throw new Error(`按钮 data-action="${action}" 未找到`);
  btn.click();
}

/** 模拟点击关闭按钮 */
function clickCloseBtn(): void {
  const btn = document.querySelector<HTMLElement>('.banner-close');
  if (!btn) throw new Error('关闭按钮未找到');
  btn.click();
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('ProactiveBanner', () => {
  beforeEach(() => {
    // 每个测试前重置 DOM
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // 清理：移除所有 DOM 元素
    document.body.innerHTML = '';
  });

  // ─── showProactiveBanner ───────────────────────────────

  describe('showProactiveBanner', () => {
    it('正常显示：应移除 hidden 类 + 设置 textContent', () => {
      setupBannerDom();
      const { manager } = createManager({ initButtons: false });
      const banner = document.getElementById('proactive-banner')!;
      const textEl = document.getElementById('proactive-banner-text')!;

      manager.showProactiveBanner('你好，需要帮忙吗？');

      expect(banner.classList.contains('hidden')).toBe(false);
      expect(textEl.textContent).toBe('你好，需要帮忙吗？');
    });

    it('banner 元素缺失时应静默降级（不抛错）', () => {
      // 不设置 DOM
      const { manager } = createManager({ initButtons: false });
      expect(() => manager.showProactiveBanner('test')).not.toThrow();
    });

    it('text 元素缺失时应静默降级（不抛错）', () => {
      // 只设置 banner，不设置 text
      document.body.innerHTML = '<div id="proactive-banner" class="hidden"></div>';
      const { manager } = createManager({ initButtons: false });
      expect(() => manager.showProactiveBanner('test')).not.toThrow();
      // banner 不应被显示（因为 text 元素缺失，提前 return）
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('多次调用应覆盖之前的文本', () => {
      setupBannerDom();
      const { manager } = createManager({ initButtons: false });
      const textEl = document.getElementById('proactive-banner-text')!;

      manager.showProactiveBanner('第一条');
      manager.showProactiveBanner('第二条');

      expect(textEl.textContent).toBe('第二条');
    });
  });

  // ─── hideProactiveBanner ───────────────────────────────

  describe('hideProactiveBanner', () => {
    it('正常隐藏：应添加 hidden 类', () => {
      setupBannerDom();
      const { manager } = createManager({ initButtons: false });
      const banner = document.getElementById('proactive-banner')!;
      // 先显示
      banner.classList.remove('hidden');
      expect(banner.classList.contains('hidden')).toBe(false);

      manager.hideProactiveBanner();

      expect(banner.classList.contains('hidden')).toBe(true);
    });

    it('banner 元素缺失时应静默降级（不抛错）', () => {
      const { manager } = createManager({ initButtons: false });
      expect(() => manager.hideProactiveBanner()).not.toThrow();
    });
  });

  // ─── initProactiveBannerButtons ────────────────────────

  describe('initProactiveBannerButtons', () => {
    it('点击 view 按钮应触发 onView 回调 + 隐藏 banner', () => {
      setupBannerDom();
      const { handlers } = createManager();
      // 先显示 banner
      document.getElementById('proactive-banner')!.classList.remove('hidden');

      clickActionBtn('view');

      expect(handlers.onView).toHaveBeenCalledTimes(1);
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('点击 later 按钮应触发 onLater 回调 + 隐藏 banner', () => {
      setupBannerDom();
      const { handlers } = createManager();
      document.getElementById('proactive-banner')!.classList.remove('hidden');

      clickActionBtn('later');

      expect(handlers.onLater).toHaveBeenCalledTimes(1);
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('点击 silent 按钮应触发 onSilent 回调 + 隐藏 banner', () => {
      setupBannerDom();
      const { handlers } = createManager();
      document.getElementById('proactive-banner')!.classList.remove('hidden');

      clickActionBtn('silent');

      expect(handlers.onSilent).toHaveBeenCalledTimes(1);
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('点击 disable 按钮应触发 onDisable 回调 + 隐藏 banner', () => {
      setupBannerDom();
      const { handlers } = createManager();
      document.getElementById('proactive-banner')!.classList.remove('hidden');

      clickActionBtn('disable');

      expect(handlers.onDisable).toHaveBeenCalledTimes(1);
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('未提供 onDisable 时点击 disable 按钮不应抛错（可选回调）', () => {
      setupBannerDom();
      const manager = new ProactiveBanner();
      // 不提供 onDisable
      manager.initProactiveBannerButtons({
        onView: vi.fn(),
        onLater: vi.fn(),
        onSilent: vi.fn(),
      });

      expect(() => clickActionBtn('disable')).not.toThrow();
      // banner 仍应隐藏
      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
    });

    it('点击关闭按钮应隐藏 banner（不触发任何回调）', () => {
      setupBannerDom();
      const { handlers } = createManager();
      document.getElementById('proactive-banner')!.classList.remove('hidden');

      clickCloseBtn();

      expect(document.getElementById('proactive-banner')!.classList.contains('hidden')).toBe(true);
      // 四个回调都不应被触发
      expect(handlers.onView).not.toHaveBeenCalled();
      expect(handlers.onLater).not.toHaveBeenCalled();
      expect(handlers.onSilent).not.toHaveBeenCalled();
      expect(handlers.onDisable).not.toHaveBeenCalled();
    });

    it('banner 元素缺失时应静默降级（不注册任何监听器）', () => {
      document.body.innerHTML = '';
      const manager = new ProactiveBanner();
      const handlers = {
        onView: vi.fn(),
        onLater: vi.fn(),
        onSilent: vi.fn(),
        onDisable: vi.fn(),
      };

      expect(() => manager.initProactiveBannerButtons(handlers)).not.toThrow();
    });

    it('缺少关闭按钮时不应抛错（可选元素）', () => {
      // 只有 4 个操作按钮，没有关闭按钮
      document.body.innerHTML = `
        <div id="proactive-banner" class="hidden">
          <button class="banner-btn" data-action="view">查看</button>
        </div>
      `;
      const manager = new ProactiveBanner();
      const handlers = {
        onView: vi.fn(),
        onLater: vi.fn(),
        onSilent: vi.fn(),
        onDisable: vi.fn(),
      };

      expect(() => manager.initProactiveBannerButtons(handlers)).not.toThrow();
      // view 按钮仍应正常工作
      clickActionBtn('view');
      expect(handlers.onView).toHaveBeenCalledTimes(1);
    });
  });

  // ─── cleanup ───────────────────────────────────────────

  describe('cleanup', () => {
    it('cleanup 后按钮点击不应再触发回调', () => {
      setupBannerDom();
      const { manager, handlers } = createManager();

      manager.cleanup();

      // 清理后点击按钮不应触发回调
      clickActionBtn('view');
      clickActionBtn('later');
      clickActionBtn('silent');
      clickActionBtn('disable');
      clickCloseBtn();

      expect(handlers.onView).not.toHaveBeenCalled();
      expect(handlers.onLater).not.toHaveBeenCalled();
      expect(handlers.onSilent).not.toHaveBeenCalled();
      expect(handlers.onDisable).not.toHaveBeenCalled();
    });

    it('cleanup 后再 cleanup 不应抛错（幂等）', () => {
      setupBannerDom();
      const { manager } = createManager();

      manager.cleanup();
      expect(() => manager.cleanup()).not.toThrow();
    });
  });
});
