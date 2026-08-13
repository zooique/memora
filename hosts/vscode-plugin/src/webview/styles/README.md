# src/webview/styles/

Webview 面板样式表（按面板/组件分组，对齐 memora-sprite 的 CSS 功能域分组思路）。
以「样式字符串」形式导出，由面板 buildHtml 拼进 `<style>`；全部使用 `--vscode-*` 语义变量，亮/暗主题自适应。

已实现：
- `chatStyles.ts` — 对话打磨面板整体样式。
- `configStyles.ts` — 大模型配置面板整体样式。
- `dropdown.ts` — 下拉菜单组件样式（scoped 到 `.treedd`）。
- `toolCard.ts` — 工具调用卡片组件样式（scoped 到 `.tool-card`）。
