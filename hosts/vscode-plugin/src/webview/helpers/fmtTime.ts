/**
 * 时间格式化 — Webview 渲染层纯函数（注入脚本）
 *
 * 说明：webview 脚本以内联字符串注入（CSP: script-src 'unsafe-inline'），
 * 无法 import 模块，故以「可注入脚本字符串」形式提供，由面板 buildHtml 拼进 <script>。
 * 面板内通过 fmtTime(ts) 调用；无效/空输入返回空串。
 */
export const fmtTimeScript = `
function fmtTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}`;