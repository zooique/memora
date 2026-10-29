// webview 侧「复制」逻辑单点（SSOT）。
//
// 承载两类复制：
//   1. copyText —— 按钮等显式调用（整条消息 / 整条问答 / 原始文本 / 代码块），
//      行为与原 chatView.copyText 一致，从 chatView 抽出避免散落。
//   2. installSelectionCopyGuard —— 自由选区复制兜底（见下方根因说明）。
//
// 不引入任何右键菜单：菜单是 Layer B（0.5.0 范围），本模块只解决
// 「选中消息正文后复制不出」这一可用性缺陷。

/**
 * 复制文本到剪贴板（按钮等-point 调用）。
 *
 * 优先 `navigator.clipboard.writeText`（异步，需用户手势）；失败时降级到
 * 临时 textarea + `execCommand('copy')`（旧环境 / 权限受限兜底）。
 */
export function copyText(text: string): void {
  window.navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

/**
 * 选区复制兜底（Layer A）。
 *
 * 根因：VS Code WebviewView 里，非输入区的原生剪贴板（Ctrl+C / 平台菜单 Copy）
 * 不可靠——选中消息正文后复制，字节常常不落盘；插件既有的 copyText 只服务
 * hover 动作按钮，自由选区（选一句/一段）没有入口。这与「右键菜单能弹但复制
 * 无效」是同一根因：两者都走原生复制，而原生复制在 webview 里经常失效。
 *
 * 修复：在 document 级 `copy` 事件上**同步**写剪贴板——`clipboardData.setData`
 * 比异步 `writeText` 可靠，且在用户手势内不会失败。判据 = 「真有文档级选区才接管」：
 *   - 输入框是 `<textarea>`，其选区**不计入** `window.getSelection()` ⇒ 输入选区时
 *     sel 为空，return 放行原生 Ctrl+C（不与图片粘贴 / 原生剪贴板打架）；
 *   - 消息正文选区计入 `getSelection()` ⇒ sel 非空，接管写盘 + preventDefault。
 *
 * 幂等：重复调用只挂一次（installed 标记），chatView 重渲染不重复绑定。
 */
let installed = false;
export function installSelectionCopyGuard(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('copy', (e: ClipboardEvent) => {
    // 仅接管「文档级选区」复制；输入框（<textarea>）选区不计入 getSelection，
    // sel 为空 ⇒ 放行原生（避免吞掉输入框 Ctrl+C / 与 imageCapture 的 paste 监听冲突）。
    const sel = window.getSelection()?.toString() ?? '';
    if (!sel) return;
    // 极旧环境无 clipboardData ⇒ 不接管，交原生（不伪装成失败）。
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/plain', sel);
    e.preventDefault();
  });
}
