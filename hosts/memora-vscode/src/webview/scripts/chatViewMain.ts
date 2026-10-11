/**
 * chatView 入口 — webview 运行时自执行
 *
 * 与 chatView.ts（导出 createChatView 工厂，可测试）分离的独立入口：确保
 * chatView.js 加载时立即初始化——CSP script-src 'self' 下无法用内联脚本调用工厂，
 * 故由 esbuild 以本文件为入口产出「定义 + 自执行」的 IIFE。
 */

import { createChatView, type ChatViewDeps } from './chatView.js';
import { installWebviewErrorBoundary } from '../helpers/errorBoundary.js';

// webview 宿主提供的全局函数（@types/vscode 未声明，此处显式声明）
declare const acquireVsCodeApi: ChatViewDeps['acquireVsCodeApi'];

// acquire 仅一次（VS Code 每会话限定）：实例由本入口持有，错误边界与工厂共用——
// 边界先装配，工厂初始化期抛出的错误也能被抓到并上报留痕。
const api = acquireVsCodeApi();
installWebviewErrorBoundary({ post: (msg) => api.postMessage(msg), window, document });

createChatView({ acquireVsCodeApi: () => api, window });
