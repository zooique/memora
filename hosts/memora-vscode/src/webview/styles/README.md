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
├── rolesStyles.ts   # 角色管理面板：卡片列表 + 能力标签 chips（2026-08-17 独立视图）
├── memoryStyles.ts  # 记忆管理面板：条目卡片 + 回收站（scoped 到 #memory-root）
├── skillsStyles.ts  # 技能管理面板：全局技能卡片（scoped 到 #skills-root）
├── mcpStyles.ts     # MCP 工具服务器面板：服务器卡片 + 工具行 + 免确认开关（scoped 到 #mcp-root）
├── dropdown.ts      # 下拉菜单组件样式（scoped 到 .treedd，引用令牌）
```

（`toolCard.ts` 已随 v1.5 展示层收敛移除——工具过程并入 chatStyles 的 round-block 段。）

## 铁律（对齐 ui-engineering-mindset-rules.md §一）

1. **令牌即契约**：裸值只允许出现在 `tokens.ts` 的令牌定义处；其余样式文件只能引用令牌。
2. **定义用裸值，使用用引用**：`--red: #dc2626` 是定义，`color: red` 是泄露。
3. **例外**：动画位移（入场 translateY 等）、边框宽度、SVG 描边等「非布局间距」值允许内联，不属于铁律范围。
4. **面板注入令牌（聚合单一注入点）**：`settingsStyles` 在自身字符串头部拼接 `${tokens}` 并**向后聚合**五个子视图样式（`rolesStyles` / `configStyles` / `memoryStyles` / `skillsStyles` / `mcpStyles`）——五者只引用令牌、**不自带注入**；`chatStyles` 头部拼接 `${tokens}` 并聚合 `dropdownStyles`（组件样式 scoped 到 `.treedd`，同样不自带注入，由 chatPanel 随 chatStyles 一并注入）。组件样式只引用令牌并保留降级默认值，保证脱离令牌也能兜底渲染。
5. **新面板按 root 分文件**：每页一个 `xxxStyles.ts`，自有选择符一律 scoped 到该页 root（`#mcp-root` 等）。**安全页是存量例外**：无独立文件、样式内嵌在 `settingsStyles.ts` 尾部（`.security-*` 是全局基线类，memory / MCP 等页**复用**它们；新增面板只许复用、不许把自有样式追加进去）。

## 令牌刻度

* **间距**：`--sp-0: 2px`（紧凑下界）→ `--sp-1: 4px` → `--sp-2: 6px` → `--sp-3: 8px` → `--sp-4: 10px` → `--sp-5: 12px` → `--sp-6: 16px` → `--sp-8: 24px`（大留白）。

* **圆角**：`--radius-sm: 2px`（紧凑下界）→ `--radius: 6px` → `--radius-lg: 8px` → `--radius-xl: 14px` → `--radius-pill: 999px`。

* **字号**：`--font-xs: 10px` → `--font-sm: 11px` → `--font-md: 12px` → `--font-base: 13px` → `--font-lg: 14px`。

## 说明

* 全部使用 `--vscode-*` 语义变量（通过 L2 语义令牌映射），亮/暗主题自适应，禁止硬编码颜色。

* 以「样式字符串」形式导出，由面板 buildHtml 拼进 `<style>`。

* 操作按钮（复制等）「主动可见」，避免 hover-only。

* 键盘可访问：所有可交互控件带 `:focus-visible` 焦点环；`chatStyles` 内置 `prefers-reduced-motion` 全局降级。

<br />
