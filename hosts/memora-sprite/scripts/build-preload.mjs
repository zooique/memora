/**
 * 编译后处理 preload 脚本
 *
 * 将 tsconfig.preload.json 编译产物（dist-preload/electron/*.js）
 * 复制为 dist-electron/electron/*.cjs（CommonJS 格式，兼容 Electron sandbox: true）。
 *
 * 处理三个 preload 文件：
 *   - preload.ts → preload.cjs（主窗口，266 API 完整暴露面）
 *   - preloadQuickInput.ts → preloadQuickInput.cjs（quick-input 浮窗，10 API 最小化暴露面）
 *   - preloadFloat.ts → preloadFloat.cjs（浮动窗口，12 API 最小化暴露面，ADR-SP-017 §何时回顾触发）
 *
 * 无需清理步骤：tsconfig.electron.json 已排除全部三个 preload 源文件（preload.ts /
 * preloadQuickInput.ts / preloadFloat.ts），主构建不再向 dist-electron 吐出 stale ESM；
 * dist-preload 与 dist-electron 均由各自 tsc 覆盖式写入。改用覆盖式而非破坏式删除，
 * 与 sync-memora / build:electron 一致，避免沙箱 safe-delete 守卫拦截。
 *
 * 此脚本替代 build:electron 中的内联 node -e 脚本，提升可读性和可维护性。
 * 详见 P1-ROOT 修复记录（tasks/待完成任务.md）。
 */

import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 临时编译产物路径（tsconfig.preload.json 的 outDir）
const tempDir = join(import.meta.dirname, '..', 'dist-preload', 'electron');
// 最终 CommonJS 产物目录
const targetDir = join(import.meta.dirname, '..', 'dist-electron', 'electron');

/**
 * 复制单个 preload 产物：preload.js → preload.cjs
 */
function copyPreload(name) {
  const src = join(tempDir, `${name}.js`);
  const dst = join(targetDir, `${name}.cjs`);
  if (!existsSync(src)) {
    throw new Error(`[build-preload] 临时产物不存在: ${src}，请先执行 tsc -p tsconfig.preload.json`);
  }
  copyFileSync(src, dst);
  console.log(`[build-preload] 已复制: ${src} → ${dst}`);
}

// 1. 复制三个 preload 产物
copyPreload('preload');
copyPreload('preloadQuickInput');
copyPreload('preloadFloat');

// 2. （无需清理）dist-preload 由 tsc -p tsconfig.preload.json 覆盖式写入；
//    dist-electron 不含 stale ESM（preload 三件套均已从 tsconfig.electron.json 排除）。