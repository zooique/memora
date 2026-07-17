/**
 * 编译后处理 preload 脚本
 *
 * 将 tsconfig.preload.json 编译产物（dist-preload/electron/*.js）
 * 复制为 dist-electron/electron/*.cjs（CommonJS 格式，兼容 Electron sandbox: true），
 * 并清理临时目录和 stale ESM 产物。
 *
 * 处理三个 preload 文件：
 *   - preload.ts → preload.cjs（主窗口，266 API 完整暴露面）
 *   - preload-quick-input.ts → preload-quick-input.cjs（quick-input 浮窗，10 API 最小化暴露面）
 *   - preload-float.ts → preload-float.cjs（浮动窗口，12 API 最小化暴露面，ADR-SP-017 §何时回顾触发）
 *
 * 此脚本替代 build:electron 中的内联 node -e 脚本，提升可读性和可维护性。
 * 详见 P1-ROOT 修复记录（tasks/待完成任务.md）。
 */

import { copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 临时编译产物路径（tsconfig.preload.json 的 outDir）
const tempDir = join(import.meta.dirname, '..', 'dist-preload', 'electron');
// 最终 CommonJS 产物目录
const targetDir = join(import.meta.dirname, '..', 'dist-electron', 'electron');
// stale ESM 产物路径（tsconfig.electron.json 仍会编译 preload 文件为 ESM，需清理）
const stalePreloadJsPath = join(targetDir, 'preload.js');
const stalePreloadMapPath = join(targetDir, 'preload.js.map');
const staleQuickInputJsPath = join(targetDir, 'preload-quick-input.js');
const staleQuickInputMapPath = join(targetDir, 'preload-quick-input.js.map');
const staleFloatJsPath = join(targetDir, 'preload-float.js');
const staleFloatMapPath = join(targetDir, 'preload-float.js.map');

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
copyPreload('preload-quick-input');
copyPreload('preload-float');

// 2. 清理临时目录
rmSync(join(import.meta.dirname, '..', 'dist-preload'), { recursive: true, force: true });
console.log(`[build-preload] 已清理临时目录`);

// 3. 清理 stale ESM 产物（tsconfig.electron.json 仍会编译 preload 文件为 ESM）
for (const stalePath of [stalePreloadJsPath, stalePreloadMapPath, staleQuickInputJsPath, staleQuickInputMapPath, staleFloatJsPath, staleFloatMapPath]) {
  rmSync(stalePath, { force: true });
}
console.log(`[build-preload] 已清理 stale ESM 产物`);