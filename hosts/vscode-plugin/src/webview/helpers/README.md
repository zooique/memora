# src/webview/helpers/

Webview 渲染层纯函数（消息格式化、markdown 渲染、时间格式化等），无副作用、可独立测试。
因 webview 脚本以内联字符串注入（CSP），以「可注入脚本字符串」形式导出，由面板拼进 `<script>`。

已实现：
- `fmtTime.ts` — 时间格式化（ISO → HH:MM），导出 `fmtTimeScript`。
- `toolNameMap.ts` — 工具名中文映射（read_file → 读取文件），导出 `toolNameMapScript`。

未来扩展：markdown 渲染、日期格式化、消息装饰等。
