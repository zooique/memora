/**
 * 打包产物完整性验证
 *
 * 检查 electron-builder 打包后的关键文件是否存在且非空，
 * 防止"打包成功"但产物残缺的问题。
 *
 * 支持两种产物模式：
 *   1. asar: true  → app.asar 单文件 + app.asar.unpacked 原生模块目录
 *   2. asar: false → resources/app/ 目录结构
 *
 * 验证项：
 *   1. 可执行文件（Memora Sprite.exe / electron.exe）
 *   2. app.asar 归档文件（asar 模式）或 resources/app/electron/main.js（目录模式）
 *   3. 原生依赖 better-sqlite3.node
 *   4. 预加载脚本 preload.cjs
 *   5. 内核包 memora
 *   6. 打包后的 zip 文件
 *
 * 用法：node scripts/verify-package.mjs [--platform <win|mac|linux>]
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 项目根目录 */
const projectRoot = join(import.meta.dirname, '..');
/** release 输出目录 */
const releaseDir = join(projectRoot, 'release');

// 解析 --platform 参数，默认 win
const platformArg = process.argv.find((a) => a.startsWith('--platform='));
const platform = platformArg ? platformArg.split('=')[1] : 'win';

/** 不同平台的 unpacked 目录名 */
const unpackedDirMap = {
  win: 'win-unpacked',
  mac: 'mac',
  linux: 'linux-unpacked',
};
const unpackedDir = join(releaseDir, unpackedDirMap[platform] || 'win-unpacked');

/** 应用资源目录 */
const resourcesDir = join(unpackedDir, 'resources');

/** 平台对应的可执行文件名 */
const exeNameMap = {
  win: 'Memora Sprite.exe',
  mac: 'Memora Sprite.app',
  linux: 'memora-sprite',
};
// 兼容旧版 / 未设置 productName 的情况
const fallbackExeNameMap = {
  win: 'electron.exe',
  mac: 'electron.app',
  linux: 'electron',
};

/**
 * 查找可执行文件：先查 productName，再查 fallback
 * @returns {{ path: string, name: string } | null}
 */
function findExe() {
  const primary = exeNameMap[platform];
  const fallback = fallbackExeNameMap[platform];

  const primaryPath = join(unpackedDir, primary);
  if (existsSync(primaryPath) && statSync(primaryPath).size > 0) {
    return { path: primaryPath, name: primary };
  }

  const fallbackPath = join(unpackedDir, fallback);
  if (existsSync(fallbackPath) && statSync(fallbackPath).size > 0) {
    return { path: fallbackPath, name: fallback };
  }

  return null;
}

/**
 * 检测 asar 模式：resources/app.asar 存在
 */
function isAsarMode() {
  return existsSync(join(resourcesDir, 'app.asar'));
}

/**
 * 使用 npx asar list 列出归档内容，检查指定文件是否存在
 * @param {string} asarPath asar 文件路径
 * @param {string} pattern 要查找的文件模式（支持部分匹配）
 * @returns {boolean}
 */
function asarContains(asarPath, pattern) {
  try {
    const output = execSync(`npx asar list "${asarPath}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.includes(pattern);
  } catch {
    return false;
  }
}

/**
 * 通用文件检查（非空 = 存在且 size > 0）
 * @param {string} label 检查项名称
 * @param {string} path 文件路径
 * @param {boolean} required 是否必需
 * @returns {{ passed: boolean, size: number }}
 */
function checkFile(label, path, required) {
  const exists = existsSync(path);
  const size = exists ? statSync(path).size : 0;

  if (exists && size > 0) {
    console.log(`  ✓ ${label} (${(size / 1024).toFixed(1)} KB)`);
    return { passed: true, size };
  } else if (required) {
    console.log(`  ✗ ${label} — 缺失或为空`);
    console.log(`    期望路径: ${path}`);
    return { passed: false, size: 0 };
  } else {
    console.log(`  - ${label} — 跳过（非必需）`);
    return { passed: true, size: 0 };
  }
}

console.log('[verify-package] 开始验证打包产物...');
console.log(`[verify-package] 平台: ${platform}`);
console.log(`[verify-package] 解压目录: ${unpackedDir}`);
console.log(`[verify-package] asar 模式: ${isAsarMode()}`);
console.log('');

let passed = 0;
let failed = 0;

// 1. 可执行文件
const exe = findExe();
if (exe) {
  const size = statSync(exe.path).size;
  console.log(`  ✓ 可执行文件 ${exe.name} (${(size / 1024).toFixed(1)} KB)`);
  passed++;
} else {
  console.log(`  ✗ 可执行文件 — 缺失（${exeNameMap[platform]} / ${fallbackExeNameMap[platform]}）`);
  failed++;
}

// 2. 应用代码（asar 模式 vs 目录模式）
const asarPath = join(resourcesDir, 'app.asar');
if (isAsarMode()) {
  // asar 模式：检查 app.asar 存在且非空
  const asarResult = checkFile('app.asar 归档', asarPath, true);
  if (asarResult.passed) {
    passed++;

    // 在 asar 内检查关键文件（asar list 输出使用当前平台路径分隔符）
    const sep = process.platform === 'win32' ? '\\' : '/';
    const asarChecks = [
      { label: '应用入口 main.js', pattern: `${sep}dist-electron${sep}electron${sep}main.js` },
      { label: '预加载脚本 preload.cjs', pattern: `${sep}dist-electron${sep}electron${sep}preload.cjs` },
      { label: '内核包 memora', pattern: `${sep}node_modules${sep}memora${sep}dist${sep}index.js` },
      { label: 'package.json', pattern: `${sep}package.json` },
    ];

    for (const check of asarChecks) {
      if (asarContains(asarPath, check.pattern)) {
        console.log(`  ✓ ${check.label} (asar 内)`);
        passed++;
      } else {
        console.log(`  ✗ ${check.label} — asar 内未找到`);
        console.log(`    查找模式: ${check.pattern}`);
        failed++;
      }
    }
  } else {
    failed++;
  }
} else {
  // 目录模式：逐文件检查
  const appDir = join(resourcesDir, 'app');
  const dirChecks = [
    {
      label: '应用入口 main.js',
      path: join(appDir, 'electron', 'main.js'),
      required: true,
    },
    {
      label: '预加载脚本 preload.cjs',
      path: join(appDir, 'electron', 'preload.cjs'),
      required: true,
    },
    {
      label: '内核包 memora',
      path: join(appDir, 'node_modules', 'memora', 'dist', 'index.js'),
      required: true,
    },
    {
      label: 'package.json',
      path: join(appDir, 'package.json'),
      required: true,
    },
  ];

  for (const check of dirChecks) {
    const result = checkFile(check.label, check.path, check.required);
    if (result.passed) passed++;
    else failed++;
  }
}

// 3. 原生依赖 better_sqlite3.node（在 asar.unpacked 中）
const nativeModulePath = join(
  resourcesDir,
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
// 如果 asar.unpacked 不存在，回退到目录模式路径
const altNativePath = join(
  resourcesDir,
  'app',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
const nativePath = existsSync(nativeModulePath) ? nativeModulePath : altNativePath;
const nativeResult = checkFile('原生依赖 better_sqlite3.node', nativePath, true);
if (nativeResult.passed) passed++;
else failed++;

// 4. 打包后的 zip 文件（从 package.json 读取版本号，避免硬编码过时）
const spritePkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
const zipName = `Memora Sprite-${spritePkg.version}-${platform}.zip`;
const zipPath = join(releaseDir, zipName);
const zipResult = checkFile('打包产物 ZIP', zipPath, false);
if (zipResult.passed) passed++;
// ZIP 非必需（macOS 可能产 DMG），不参与 failed 计数

console.log('');
console.log(`[verify-package] 结果: ${passed} 通过, ${failed} 失败`);

if (failed > 0) {
  console.error('[verify-package] 验证失败！产物不完整，请检查打包日志。');
  process.exit(1);
} else {
  console.log('[verify-package] 验证通过，产物完整。');
}