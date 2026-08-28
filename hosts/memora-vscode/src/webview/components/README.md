# src/webview/components/

可复用 Webview UI 组件（消息气泡、输入框、状态卡片等），不绑定具体面板。

已实现：
- `dropdown.ts` — Trae 风格紧凑下拉菜单（展开/收起 + 事件委托转发选择项），提供 `buildDropdownHtml` 生成 HTML、`initDropdowns(document, callbacks)` 显式绑定回调；样式见 `../styles/dropdown.ts`。
（`toolCard.ts` 已随 v1.5 展示层收敛移除——工具过程统一进 round-block 折叠区文本小节。）

未来扩展：对话气泡 MessageBubble、输入框 InputBar 等。
