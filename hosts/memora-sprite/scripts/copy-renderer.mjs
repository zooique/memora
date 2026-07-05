/**
 * 复制渲染进程静态资源到 dist-electron
 *
 * 将 src/electron/renderer/ 下的 HTML/CSS/静态文件复制到 dist-electron/electron/renderer/，
 * 排除 .ts 文件（编译产物由 tsc 处理）。
 * 同时复制 assets/ 和 build/icons/ 目录到 dist-electron 根目录，
 * 供主进程加载窗口图标和托盘图标使用。
 *
 * 此脚本替代 build:electron 中的内联 node -e 脚本，
 * 避免在 ESM 项目中使用 require() 的兼容性问题。
 */

import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归复制目录，跳过 .ts 文件
 * @param src  源目录
 * @param dest 目标目录
 * @param filter 可选过滤函数，返回 true 表示复制
 */
function copyDir(src, dest, filter) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (filter && !filter(entry.name, entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (!entry.name.endsWith('.ts')) {
      copyFileSync(srcPath, destPath);
    }
  }
}

const projectRoot = join(import.meta.dirname, '..');
const distRoot = join(projectRoot, 'dist-electron');

// 1. 复制渲染进程文件
const srcRendererDir = join(projectRoot, 'src', 'electron', 'renderer');
const destRendererDir = join(distRoot, 'electron', 'renderer');
copyDir(srcRendererDir, destRendererDir);
console.log(`[copy-renderer] 已复制渲染进程: ${srcRendererDir} → ${destRendererDir}`);

// 2. 复制 assets 目录（favicon.png、icon.svg 等）
const srcAssetsDir = join(projectRoot, 'assets');
const destAssetsDir = join(distRoot, 'assets');
if (existsSync(srcAssetsDir)) {
  copyDir(srcAssetsDir, destAssetsDir);
  console.log(`[copy-renderer] 已复制 assets: ${srcAssetsDir} → ${destAssetsDir}`);
}

// 3. 复制 build/icons 目录（窗口图标、托盘图标）
const srcIconsDir = join(projectRoot, 'build', 'icons');
const destIconsDir = join(distRoot, 'build', 'icons');
if (existsSync(srcIconsDir)) {
  copyDir(srcIconsDir, destIconsDir);
  console.log(`[copy-renderer] 已复制图标: ${srcIconsDir} → ${destIconsDir}`);
}
