/**
 * memoryView 入口 — webview 运行时自执行
 *
 * 与 memoryView.ts（导出 createMemoryView 工厂，可测试）分离的独立入口：确保
 * memoryView.js 加载时立即初始化——CSP script-src 'self' 下无法用内联脚本调用工厂，
 * 故由 esbuild 以本文件为入口产出「定义 + 自执行」的 IIFE。
 */

import { createMemoryView, type MemoryViewDeps } from './memoryView.js';

// webview 宿主提供的全局函数（@types/vscode 未声明，此处显式声明）
declare const acquireVsCodeApi: MemoryViewDeps['acquireVsCodeApi'];

createMemoryView({ acquireVsCodeApi, window });
