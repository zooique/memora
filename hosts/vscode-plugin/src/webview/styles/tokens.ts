/**
 * 设计令牌 — 全插件 Webview 样式层的单一真理源（SSOT）
 *
 * 分层（对齐 ui-engineering-mindset-rules.md §一 设计令牌）：
 *   L1 基础令牌（foundation）：间距 / 圆角 / 字号 / 阴影 —— 裸值只允许出现在本文件
 *   L2 语义令牌：将 --vscode-* 主题变量映射为语义含义（surface / border / text / accent）
 *   L3 组件令牌：输入区等具体组件的内部尺寸契约
 *
 * 铁律：
 *   - 裸值只能出现在本文件（令牌定义处）；
 *   - 其余所有样式文件（chatStyles / configStyles / dropdown / toolCard）
 *     只能引用令牌，禁止裸值；
 *   - 令牌即契约：间距必须落在刻度上，不存在 margin: 17px；
 *   - 例外：动画位移（入场 translateY 等）、边框宽度、SVG 描边等
 *     「非布局间距」值允许内联，不属于本铁律范围。
 */
export const tokens = `
  :root {
    color-scheme: light dark;

    /* === L1 基础令牌：间距刻度 === */
    --sp-0: 2px;  /* 紧凑间距下界（菜单项间距 / 紧凑 padding） */
    --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;
    --sp-4: 10px; --sp-5: 12px; --sp-6: 16px;

    /* === L1 基础令牌：圆角刻度 === */
    --radius-sm: 2px; /* 紧凑圆角下界（用户消息气泡小角） */
    --radius: 6px; --radius-lg: 8px; --radius-xl: 14px;
    --radius-pill: 999px; /* 胶囊/徽章（无限大圆角） */

    /* === L1 基础令牌：字号阶梯 === */
    --font-xs: 10px; --font-sm: 11px; --font-md: 12px; --font-base: 13px; --font-lg: 14px;

    /* === L1 基础令牌：阴影层级 === */
    --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.15);
    --shadow-card-focus: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(14, 99, 156, 0.35);
    --shadow-modal: 0 4px 16px rgba(0, 0, 0, 0.3);

    /* === L2 语义令牌：表面 === */
    --surface-page: var(--vscode-editor-background, #1e1e1e);
    --surface-input: var(--vscode-input-background, #3c3c3c);
    --surface-card: var(--vscode-editorWidget-background, #252526);
    --surface-hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));

    /* === L2 语义令牌：边框 === */
    --border-input: var(--vscode-input-border, rgba(128, 128, 128, 0.5));
    --border-panel: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
    --border-focus: var(--vscode-focusBorder, #0e639c);

    /* === L2 语义令牌：文本 === */
    --text-primary: var(--vscode-foreground, #cccccc);
    --text-secondary: var(--vscode-descriptionForeground, #9aa0a6);
    --text-input: var(--vscode-input-foreground, #cccccc);

    /* === L2 语义令牌：品牌色（accent） === */
    --accent: var(--vscode-button-background, #0e639c);
    --accent-foreground: var(--vscode-button-foreground, #ffffff);

    /* === L3 组件令牌：底部输入区内部尺寸契约 === */
    --input-wrap-min-h: 96px;  /* 输入卡片最小总高（textarea 64 + footer 32） */
    --input-min-h: 64px;       /* textarea 单行舒适高度（占总高 65%） */
    --input-max-h: 140px;      /* textarea 展开上限（多行不憋屈） */
    --input-footer-h: 32px;    /* 工具条高度（占总高 33%） */
    --control-h: 28px;         /* 输入区控制件统一高度（模型选择器 / 发送按钮） */
  }
`;
