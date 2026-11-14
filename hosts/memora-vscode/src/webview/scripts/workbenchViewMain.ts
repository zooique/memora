/**
 * workbenchView 入口 — webview 运行时自执行
 *
 * 与 `workbenchView.ts`（导出工厂，可测试）分离：CSP `script-src` 下无法用内联脚本
 * 调用工厂，故由 esbuild 以本文件为入口产出「定义 + 自执行」的 IIFE（与
 * `chatViewMain` / `settingsViewMain` 同一范式）。
 */
import { createWorkbenchView } from './workbenchView.js';
import { installWebviewErrorBoundary } from '../helpers/errorBoundary.js';
import { initWebviewL10n } from '../helpers/webviewL10n.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';

// webview 宿主提供的全局函数（@types/vscode 未声明，此处显式声明）
declare const acquireVsCodeApi: () => { postMessage(message: unknown): void };

// acquire 仅一次（VS Code 每会话限定）：实例由入口持有，错误边界与视图共用
const api = acquireVsCodeApi();
installWebviewErrorBoundary({ post: (msg) => api.postMessage(msg), window, document });
// 装配宿主注入的译文（须先于任何 l10n.t 调用；无注入时保持未配置）
initWebviewL10n(document);

const view = createWorkbenchView({
  document,
  post: (message) => api.postMessage(message),
});

// 宿主每次 `ready` 后整份回放快照；本视图只做整块重建（无增量状态）
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as ExtensionToWebviewMessage;
  if (message?.type === 'workbench_snapshot') view.render(message.snapshot);
});

// 脚本已就绪（监听器已注册）⇒ 告知宿主可以回放
view.ready();
