/**
 * 主题管理模块
 *
 * 职责：
 * - 获取/设置当前主题（light/dark/auto）
 * - 缓存主题到 localStorage（供 index.html / float.html 内联脚本同步读取，避免页面闪烁）
 * - 同步设置面板单选按钮状态
 * - 触发主题变更回调通知 renderer.ts
 * - P3-FLOW-12 支持 'auto' 主题：跟随系统 prefers-color-scheme 媒体查询
 *
 * 设计原则（ADR-SP-008 + UX-FD-12）：
 * - 通过 <html> 元素的 data-theme 属性触发 CSS 变量切换
 * - 真理源为 sprite.json（通过 IPC 持久化），localStorage 仅作为内联脚本缓存
 * - localStorage 不可用时静默降级（如隐私模式）
 * - 独立于 UIManager，通过组合方式持有
 */

/** 主题配置类型（P3-FLOW-12 新增 'auto' 跟随系统） */
export type ThemeMode = 'light' | 'dark' | 'auto';

/**
 * 主题管理器
 *
 * 独立管理主题切换和持久化，UIManager 通过组合持有。
 */
export class ThemeManager {
  /** 主题变更回调（由 renderer.ts 注册） */
  private themeChangeCallback: ((theme: 'light' | 'dark', source: 'user' | 'system') => void) | null = null;

  /** P3-FLOW-12 当前主题模式（'light' | 'dark' | 'auto'），'auto' 时跟随系统 */
  private themeMode: ThemeMode = 'light';

  /** P3-FLOW-12 系统主题变化监听器（'auto' 模式下生效） */
  private mediaQueryListener: ((e: MediaQueryListEvent) => void) | null = null;

  /**
   * ADR-SP-008 注册主题变更回调
   *
   * 当用户在设置面板切换主题时触发，renderer.ts 可借此执行：
   * - IPC 持久化到 sprite.json（真理源）— 仅 source='user' 时
   * - 通知主进程同步到浮动窗口 — 两种 source 都需要
   * 主题的 DOM 更新和 localStorage 缓存已在 setTheme 内完成，回调仅用于 IPC 同步。
   *
   * QC-THEME-01 新增 source 参数区分"用户主动切换"与"系统主题变化"：
   * - source='user'：用户在设置面板主动切换，需持久化到 sprite.json
   * - source='system'：auto 模式下系统主题变化，仅同步浮动窗口，不覆盖 sprite.json 中的 'auto'
   *
   * @param cb 主题变更回调函数
   */
  onThemeChange(cb: (theme: 'light' | 'dark', source: 'user' | 'system') => void): void {
    this.themeChangeCallback = cb;
  }

  /**
   * ADR-SP-008 获取当前主题
   *
   * 通过读取 <html> 元素的 data-theme 属性判断当前主题，
   * 未设置（默认）视为浅色。
   *
   * @returns 当前实际生效的主题（'light' | 'dark'），不含 'auto'
   */
  getTheme(): 'light' | 'dark' {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  /**
   * P3-FLOW-12 获取当前主题模式
   *
   * @returns 当前主题模式（'light' | 'dark' | 'auto'）
   */
  getThemeMode(): ThemeMode {
    return this.themeMode;
  }

  /**
   * ADR-SP-008 设置主题
   *
   * 1. 设置 <html> 元素的 data-theme 属性（触发 CSS 变量切换）
   * 2. 缓存到 localStorage（供 index.html / float.html 内联脚本同步读取，避免页面闪烁）
   * 3. 同步设置面板单选按钮状态
   * 4. 触发 themeChangeCallback 通知 renderer.ts（由 renderer.ts 负责 IPC 持久化到 sprite.json）
   *
   * P3-FLOW-12 新增 'auto' 模式：
   * - 'auto' 时根据系统 prefers-color-scheme 媒体查询自动选择 light/dark
   * - 注册系统主题变化监听器，系统主题改变时自动切换
   * - 切换到非 'auto' 模式时移除监听器
   *
   * 注：localStorage 是缓存层，真理源为 sprite.json。renderer.ts 的 onThemeChange 回调
   * 负责将主题变更通过 IPC 写入 sprite.json。
   *
   * @param mode 目标主题模式（'light' | 'dark' | 'auto'）
   */
  setTheme(mode: ThemeMode): void {
    this.themeMode = mode;

    // P3-FLOW-12 处理 'auto' 模式：根据系统主题选择实际 light/dark
    const effectiveTheme = mode === 'auto' ? this.getSystemTheme() : mode;

    // 应用实际主题到 DOM
    if (effectiveTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      // 浅色为默认，移除属性即可
      document.documentElement.removeAttribute('data-theme');
    }

    // 同步更新 theme-color meta 标签，让任务栏/标题栏颜色跟随主题
    this.syncThemeColorMeta(effectiveTheme);

    try {
      // P3-FLOW-12 'auto' 模式下缓存实际主题（供内联脚本读取，避免闪烁）
      localStorage.setItem('memora-theme', effectiveTheme);
    } catch {
      // localStorage 不可用时静默降级（如隐私模式）
    }
    this.syncThemeRadios(mode);
    // QC-THEME-01：用户主动切换主题，source='user'，renderer.ts 会持久化到 sprite.json
    this.themeChangeCallback?.(effectiveTheme, 'user');

    // 移除此处的直接 IPC 调用，统一由 renderer.ts 的 onThemeChange 回调负责
    // 主题持久化（sprite.json）和主进程通知统一由 renderer.ts onThemeChange 回调处理

    // P3-FLOW-12 管理 'auto' 模式的系统主题变化监听器
    this.updateMediaQueryListener(mode);
  }

  /**
   * P3-FLOW-12 获取系统当前主题
   *
   * 通过 prefers-color-scheme 媒体查询判断系统当前是浅色还是深色。
   *
   * @returns 系统当前主题（'light' | 'dark'）
   */
  private getSystemTheme(): 'light' | 'dark' {
    // matchMedia 可能不支持（如旧版浏览器），降级为浅色
    if (typeof window.matchMedia !== 'function') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /**
   * P3-FLOW-12 更新系统主题变化监听器
   *
   * 仅在 'auto' 模式下注册监听器，其他模式移除监听器。
   * 系统主题变化时自动切换实际主题，并触发 themeChangeCallback 通知 renderer.ts 持久化。
   *
   * @param mode 当前主题模式
   */
  private updateMediaQueryListener(mode: ThemeMode): void {
    // 不支持 matchMedia 时跳过
    if (typeof window.matchMedia !== 'function') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    // 先移除旧监听器（无论之前是否注册）
    if (this.mediaQueryListener) {
      mediaQuery.removeEventListener('change', this.mediaQueryListener);
      this.mediaQueryListener = null;
    }

    // 仅 'auto' 模式注册新监听器
    if (mode === 'auto') {
      this.mediaQueryListener = (e: MediaQueryListEvent) => {
        const effectiveTheme: 'light' | 'dark' = e.matches ? 'dark' : 'light';
        // 应用实际主题到 DOM（不修改 themeMode，保持 'auto'）
        if (effectiveTheme === 'dark') {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
        try {
          localStorage.setItem('memora-theme', effectiveTheme);
        } catch {
          // localStorage 不可用时静默降级
        }
        // QC-THEME-01：系统主题变化，source='system'，renderer.ts 仅同步浮动窗口，不覆盖 sprite.json 中的 'auto'
        this.themeChangeCallback?.(effectiveTheme, 'system');
        // auto 模式下系统主题变化时同步 theme-color
        this.syncThemeColorMeta(effectiveTheme);
      };
      mediaQuery.addEventListener('change', this.mediaQueryListener);
    }
  }

  /**
   * 同步更新 <meta name="theme-color"> 标签内容
   *
   * 让操作系统任务栏/标题栏颜色跟随当前主题：
   * - 浅色主题：#f0f0f2（大底板色）
   * - 深色主题：#1e1e2e（大底板色）
   *
   * @param effectiveTheme 当前实际生效的主题（'light' | 'dark'）
   */
  private syncThemeColorMeta(effectiveTheme: 'light' | 'dark'): void {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = effectiveTheme === 'dark' ? '#1e1e2e' : '#f0f0f2';
    }
  }

  /**
   * ADR-SP-008 同步设置面板主题单选按钮状态
   *
   * 在外部修改主题后（如初始化加载 sprite.json 配置），调用此方法确保单选按钮选中状态与实际主题一致。
   *
   * P3-FLOW-12 支持三态单选按钮：light / dark / auto
   *
   * @param mode 当前主题模式
   */
  syncThemeRadios(mode: ThemeMode): void {
    const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme-mode"]');
    radios.forEach((radio) => {
      radio.checked = radio.value === mode;
    });
  }

  /**
   * 清理系统主题变化监听器（UIManager.cleanup 时调用）
   *
   * 'auto' 模式下注册的 mediaQueryListener 若不清理，
   * 页面卸载后仍会监听系统主题变化，在已销毁的 DOM 上执行引发异常。
   */
  cleanup(): void {
    if (this.mediaQueryListener && typeof window.matchMedia === 'function') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      mediaQuery.removeEventListener('change', this.mediaQueryListener);
      this.mediaQueryListener = null;
    }
  }
}
