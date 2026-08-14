# src/webview/helpers/

Webview 渲染层纯函数 / 工具（时间格式化、工具名映射、文档前缀剥离、滚动等），
无副作用、可独立 vitest 测试。

阶段 B（对抗评估 P2-1）后，helpers 统一为**纯函数/纯工具导出**（非「内联脚本字符串」），
由 webview 运行时脚本（chatView.js / configView.js）直接 import，经 esbuild 打包。

已实现：
- `fmtTime.ts` — 时间格式化（ISO → HH:MM），导出 `fmtTime`。
- `toolNameMap.ts` — 工具名中文映射（read_file → 读取文件），导出 `getToolDisplayName`。
- `docContext.ts` — 剥离宿主注入的「当前打磨文档内容」前缀，导出 `stripDocContextPrefix`。
- `scrollToBottom.ts` — 滚动容器到底部（rAF 节流），chatView / toolCard 共用，导出 `scrollToBottom`。

未来扩展：markdown 渲染、更丰富的时间/日期格式化等。