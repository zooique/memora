/**
 * 跨模块模式的目录路径 shim
 *
 * Electron 主进程以 ESM 运行（package.json type: module），
 * 使用 import.meta.url 定位当前模块路径。
 *
 * 本文件仅被 Electron 主进程（ESM）导入，不被 preload（CJS）导入。
 * currentDir 即为 electron 目录。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Electron 主进程代码目录的绝对路径（dist-electron/electron/）
 * 用于定位 preload.cjs、renderer/index.html 等静态资源
 */
export const ELECTRON_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 项目根目录绝对路径
 *
 * 开发时指向 hosts/memora-sprite/
 * 打包后指向 app.asar 根目录（dist-electron 的父目录）
 */
export const PROJECT_ROOT = join(ELECTRON_DIR, '..', '..');
