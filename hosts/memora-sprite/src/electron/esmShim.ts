/**
 * ESM 兼容的目录路径 shim
 *
 * CommonJS 的 __dirname 在 ESM 中不可用，模块若需获取当前目录，
 * 通常需要重复 `path.dirname(fileURLToPath(import.meta.url))` 样板代码。
 * 本模块统一计算 sprite 宿主中频繁使用的 electron 目录绝对路径，
 * 消除多处重复定义，并避免样板代码扩散。
 *
 * currentDir 即为 electron 目录。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Electron 主进程代码目录的绝对路径（src/electron/）
 * 用于定位 preload.js、renderer/index.html、resources/ 等静态资源
 */
export const ELECTRON_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 项目根目录绝对路径
 *
 * 开发时指向 hosts/memora-sprite/
 * 打包后指向 app.asar 根目录（dist-electron 的父目录）
 */
export const PROJECT_ROOT = join(ELECTRON_DIR, '..', '..');