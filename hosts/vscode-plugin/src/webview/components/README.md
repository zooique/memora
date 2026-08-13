# src/webview/components/

可复用 Webview UI 组件（消息气泡、输入框、状态卡片等），不绑定具体面板。

已实现：
- `dropdown.ts` — Trae 风格紧凑下拉菜单（展开/收起 + 点击项 via `window.__treeddOnSelect`），样式见 `../styles/dropdown.ts`。

未来扩展：对话气泡 MessageBubble、输入框 InputBar、工具调用卡片 ToolCallCard 等。
