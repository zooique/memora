/**
 * 开发桥夹具运行器（esbuild 现打包后 import）
 *
 * 为什么用 esbuild 现打包而不是引 tsx：与 `gen-remote-fixtures.mjs` 同一理由——
 * 宿主已带 esbuild（构建同源），为一个开发脚本再加一个 TS 运行器依赖是纯依赖债。
 *
 * ⚠️ 与 fixture 生成器的两处差异（都是实测踩出来的）：
 *   ① **不打包 node_modules**（`packages: 'external'`）：`ws` 是 CJS，bundle 进 ESM 后
 *      它的动态 `require('events')` 会抛 `Dynamic require ... is not supported`；
 *      依赖交给 Node 从宿主 `node_modules` 解析（宿主本来就有 ws / reflect-metadata）。
 *   ② 产物落在 `node_modules/.cache/` 内（不是系统临时目录）：external 依赖的解析起点
 *      必须在宿主包内，放系统 temp 会让 `import 'ws'` 找不到；`node_modules` 本身被 git 忽略。
 *
 * 与 fixture 生成器的共同点：`import()` 返回后进程靠 server 的事件循环存活；
 * 产物在 import 完成后即可删除（模块已加载，不影响在跑的桥）。
 *
 * 用法（宿主包目录）：npm run dev:bridge -- --certs <目录> [--host 127.0.0.1] [--port 0]
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 脚本必须从宿主包目录执行（npm run 会保证这一点）
const hostDir = process.cwd();
const cacheDir = path.join(hostDir, 'node_modules', '.cache');
mkdirSync(cacheDir, { recursive: true });
const outfile = path.join(cacheDir, `memora-dev-bridge-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [path.join(hostDir, 'scripts', 'dev-bridge.mts')],
    outfile,
    bundle: true,
    // 依赖不打包：ws 的动态 require 在 ESM bundle 里不可运行（见文件头 ①）
    packages: 'external',
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  await import(pathToFileURL(outfile).href);
} catch (err) {
  // 打包 / 启动失败必须显式可见：否则编排脚本只会看到「READY 一直不来」
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`DEV_BRIDGE_FAILED ${detail}`);
  process.exitCode = 1;
} finally {
  rmSync(outfile, { force: true });
}
