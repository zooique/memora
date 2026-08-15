# src/webview/styles/

Webview 面板样式表 — 按 **ITCSS + 设计令牌** 分层（对齐 `ui-engineering-mindset-rules.md` 与 SSOT 原则）。

## 架构

```
styles/
├── tokens.ts        # 设计令牌单一真理源（SSOT）：L1 基础令牌（间距/圆角/字号/阴影）
│                    #   + L2 语义令牌（surface/border/text/accent 映射 --vscode-*）
│                    #   + L3 组件令牌（输入区尺寸契约 --input-* / --control-h）
├── chatStyles.ts    # 对话打磨面板：Base → Layout → Components（只引用令牌，禁止裸值）
├── configStyles.ts  # 大模型配置面板：同上，令牌由 tokens.ts 提供
├── dropdown.ts      # 下拉菜单组件样式（scoped 到 .treedd，引用令牌）
└── toolCard.ts      # 工具调用卡片组件样式（scoped 到 .tool-card，引用令牌）
```

## 铁律（对齐 ui-engineering-mindset-rules.md §一）

1. **令牌即契约**：裸值只允许出现在 `tokens.ts` 的令牌定义处；其余样式文件只能引用令牌。
2. **定义用裸值，使用用引用**：`--red: #dc2626` 是定义，`color: red` 是泄露。
3. **例外**：动画位移（入场 translateY 等）、边框宽度、SVG 描边等「非布局间距」值允许内联，不属于铁律范围。
4. **面板注入令牌**：`chatStyles` / `configStyles` 在自身字符串头部拼接 `${tokens}`；组件样式（dropdown / toolCard）只引用令牌并保留降级默认值，保证即使脱离令牌也能兜底渲染。

## 令牌刻度

- **间距**：`--sp-0: 2px`（紧凑下界）→ `--sp-1: 4px` → `--sp-2: 6px` → `--sp-3: 8px` → `--sp-4: 10px` → `--sp-5: 12px` → `--sp-6: 16px` → `--sp-8: 24px`（大留白）。
- **圆角**：`--radius-sm: 2px`（紧凑下界）→ `--radius: 6px` → `--radius-lg: 8px` → `--radius-xl: 14px` → `--radius-pill: 999px`。
- **字号**：`--font-xs: 10px` → `--font-sm: 11px` → `--font-md: 12px` → `--font-base: 13px` → `--font-lg: 14px`。

## 说明

- 全部使用 `--vscode-*` 语义变量（通过 L2 语义令牌映射），亮/暗主题自适应，禁止硬编码颜色。
- 以「样式字符串」形式导出，由面板 buildHtml 拼进 `<style>`。
- 操作按钮（复制等）「主动可见」，避免 hover-only。
- 键盘可访问：所有可交互控件带 `:focus-visible` 焦点环；`chatStyles` 内置 `prefers-reduced-motion` 全局降级。
