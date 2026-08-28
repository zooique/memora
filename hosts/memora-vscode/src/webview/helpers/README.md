# src/webview/helpers/

Webview 渲染层纯函数 / 工具（时间格式化、工具名映射、文档前缀剥离、滚动等），
无副作用、可独立 vitest 测试。

阶段 B（对抗评估 P2-1）后，helpers 统一为**纯函数/纯工具导出**（非「内联脚本字符串」），
由 webview 运行时脚本（settingsView.js）直接 import，经 esbuild 打包。

已实现：
- `fmtTime.ts` — 时间格式化（ISO → HH:MM），导出 `fmtTime`。
- `toolNameMap.ts` — 工具名中文映射（read_file → 读取文件），导出 `getToolDisplayName`。
- `capabilityLabels.ts` — 角色能力名中文映射（file:read → 读取文件），导出 `capabilityLabel`。
  注意：本文件被 **host 侧**设置面板（`panels/settingsPanel.ts`）使用（host 翻译后推 webview），
  归入 helpers 因其是「能力名 → 中文标签」的展示层纯映射，与 toolNameMap 同类；既可为 host
  侧面板服务，也可被 webview 脚本 import（无 DOM 副作用，esbuild 各端安全）。
- `docContext.ts` — 剥离宿主注入的「当前打磨文档内容」前缀，导出 `stripDocContextPrefix`。
- `scrollToBottom.ts` — 智能吸底滚动（rAF 节流，仅吸底时滚动，上滚阅读不被拽走），
  chatView 共用；导出 `scrollToBottom` + `trackScroll`（滚动事件处理器，更新吸底状态）。
- `cardList.ts` — 列表分区渲染纯函数（`createGroupTitle` + `createEmptyState`），
  SSOT 收敛 configView 与 rolesView 的列表级同构 DOM 构建（分组标题 + 空态引导）。

未来扩展：markdown 渲染、更丰富的时间/日期格式化等。