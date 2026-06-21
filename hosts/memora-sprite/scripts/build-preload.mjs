/**
 * 编译后处理 preload 脚本
 *
 * 将 tsconfig.preload.json 编译产物（dist-preload/electron/preload.js）
 * 复制为 dist-electron/electron/preload.cjs（CommonJS 格式，兼容 Electron sandbox: true），
 * 并清理临时目录和 stale ESM 产物。
 *
 * 此脚本替代 build:electron 中的内联 node -e 脚本，提升可读性和可维护性。
 * 详见 P1-ROOT 修复记录（tasks/待完成任务.md）。
 */

import { copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 临时编译产物路径（tsconfig.preload.json 的 outDir）
const tempPreloadPath = join(import.meta.dirname, '..', 'dist-preload', 'electron', 'preload.js');
// 最终 CommonJS 产物路径
const targetPreloadPath = join(import.meta.dirname, '..', 'dist-electron', 'electron', 'preload.cjs');
// stale ESM 产物路径（tsconfig.electron.json 仍会编译 preload.ts 为 ESM，需清理）
const stalePreloadJsPath = join(import.meta.dirname, '..', 'dist-electron', 'electron', 'preload.js');
const stalePreloadMapPath = join(import.meta.dirname, '..', 'dist-electron', 'electron', 'preload.js.map');
// 临时编译目录
const tempDir = join(import.meta.dirname, '..', 'dist-preload');

// 1. 复制 preload.js → preload.cjs（CommonJS 格式）
if (!existsSync(tempPreloadPath)) {
  throw new Error(`[build-preload] 临时产物不存在: ${tempPreloadPath}，请先执行 tsc -p tsconfig.preload.json`);
}
copyFileSync(tempPreloadPath, targetPreloadPath);
console.log(`[build-preload] 已复制: ${tempPreloadPath} → ${targetPreloadPath}`);

// 2. 清理临时目录
rmSync(tempDir, { recursive: true, force: true });
console.log(`[build-preload] 已清理临时目录: ${tempDir}`);

// 3. 清理 stale ESM 产物（tsconfig.electron.json 仍会编译 preload.ts 为 ESM）
rmSync(stalePreloadJsPath, { force: true });
rmSync(stalePreloadMapPath, { force: true });
console.log(`[build-preload] 已清理 stale ESM 产物: ${stalePreloadJsPath}`);
