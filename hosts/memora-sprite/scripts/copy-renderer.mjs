/**
 * 复制渲染进程静态资源到 dist-electron
 *
 * 将 src/electron/renderer/ 下的 HTML/CSS/静态文件复制到 dist-electron/electron/renderer/，
 * 排除 .ts 文件（编译产物由 tsc 处理）。
 *
 * 此脚本替代 build:electron 中的内联 node -e 脚本，
 * 避免在 ESM 项目中使用 require() 的兼容性问题。
 */

import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 递归复制目录，跳过 .ts 文件
 * @param src  源目录
 * @param dest 目标目录
 */
function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else if (!entry.name.endsWith('.ts')) {
      copyFileSync(srcPath, destPath);
    }
  }
}

const srcDir = join(import.meta.dirname, '..', 'src', 'electron', 'renderer');
const destDir = join(import.meta.dirname, '..', 'dist-electron', 'electron', 'renderer');

copyDir(srcDir, destDir);
console.log(`[copy-renderer] 已复制: ${srcDir} → ${destDir}`);