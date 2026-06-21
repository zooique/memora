/**
 * 主题管理模块
 *
 * 职责：
 * - 获取/设置当前主题（light/dark）
 * - 缓存主题到 localStorage（供 index.html / float.html 内联脚本同步读取，避免页面闪烁）
 * - 同步设置面板单选按钮状态
 * - 触发主题变更回调通知 renderer.ts
 *
 * 设计原则（ADR-SP-008 + UX-FD-12）：
 * - 通过 <html> 元素的 data-theme 属性触发 CSS 变量切换
 * - 真理源为 sprite.json（通过 IPC 持久化），localStorage 仅作为内联脚本缓存
 * - localStorage 不可用时静默降级（如隐私模式）
 * - 独立于 UIManager，通过组合方式持有
 */

/**
 * 主题管理器
 *
 * 独立管理主题切换和持久化，UIManager 通过组合持有。
 */
export class ThemeManager {
  /** 主题变更回调（由 renderer.ts 注册） */
  private themeChangeCallback: ((theme: 'light' | 'dark') => void) | null = null;

  /**
   * ADR-SP-008 注册主题变更回调
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行：
   * - IPC 持久化到 sprite.json（真理源）
   * - 通知主进程同步到浮动窗口
   * 主题的 DOM 更新和 localStorage 缓存已在 setTheme 内完成，回调仅用于 IPC 同步。
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark') => void): void {
    this.themeChangeCallback = cb;
  }

  /**
   * ADR-SP-008 获取当前主题
   *
   * 通过读取 <html> 元素的 data-theme 属性判断当前主题，
   * 未设置（默认）视为浅色。
   *
   * @returns 当前主题（'light' | 'dark'）
   */
  getTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  /**
   * ADR-SP-008 设置主题
   *
   * 1. 设置 <html> 元素的 data-theme 属性（触发 CSS 变量切换）
   * 2. 缓存到 localStorage（供 index.html / float.html 内联脚本同步读取，避免页面闪烁）
   * 3. 同步设置面板单选按钮状态
   * 4. 触发 themeChangeCallback 通知 renderer.ts（由 renderer.ts 负责 IPC 持久化到 sprite.json）
   *
   * 注：localStorage 是缓存层，真理源为 sprite.json。renderer.ts 的 onThemeChange 回调
   * 负责将主题变更通过 IPC 写入 sprite.json。
   *
   * @param theme 目标主题
   */
  setTheme(theme: 'light' | 'dark'): void {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      // 浅色为默认，移除属性即可
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      localStorage.setItem('memora-theme', theme);
    } catch {
      // localStorage 不可用时静默降级（如隐私模式）
    }
    this.syncThemeRadios(theme);
    this.themeChangeCallback?.(theme);
  }

  /**
   * ADR-SP-008 同步设置面板主题单选按钮状态
   *
   * 在外部修改主题后（如初始化加载 sprite.json 配置），调用此方法确保单选按钮选中状态与实际主题一致。
   *
   * @param theme 当前主题
   */
  syncThemeRadios(theme: 'light' | 'dark'): void {
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    radios.forEach((radio) => {
      radio.checked = radio.value === theme;
    });
  }
}
