/**
 * rolesView 入口 — webview 运行时自执行（阶段 B P2-1 模式）
 *
 * 与 rolesView.ts（导出 createRolesView 工厂，可测试）分离的独立入口：确保
 * rolesView.js 加载时立即初始化——CSP script-src 'self' 下无法用内联脚本调用工厂，
 * 故由 esbuild 以本文件为入口产出「定义 + 自执行」的 IIFE。
 */

import { createRolesView, type RolesViewDeps } from './rolesView.js';

// webview 宿主提供的全局函数（@types/vscode 未声明，此处显式声明）
declare const acquireVsCodeApi: RolesViewDeps['acquireVsCodeApi'];

createRolesView({ acquireVsCodeApi, window });