/**
 * 内核同步脚本 — 编译 memora 内核，确保 sprite 的 node_modules 指向最新 dist
 *
 * 使用场景：
 *   1. 修改了 memora 内核源码后，开发前手动执行一次：npm run sync-memora
 *   2. 打包流程（package.mjs）自动调用 --pack 模式，确保打包只包含最小化内核
 *
 * 不修改内核时无需执行，sprite 的 node_modules/memora/dist 保持上一次同步的状态。
 *
 * 三种模式：
 *   - 开发模式（默认）：Junction 模式自动生效，编译后 dist 自动可用；复制模式则复制 dist
 *   - 打包模式（--pack）：替换 Junction/复制目录为最小化独立目录，
 *     仅含 dist/ + package.json + LICENSE + README.md，
 *     防止 electron-builder 跟随 Junction 将全量仓库文件打入 asar
 *
 * 用法：
 *   node scripts/sync-memora.mjs           # 编译 + 同步（开发模式）
 *   node scripts/sync-memora.mjs --pack    # 编译 + 打包模式（最小化）
 *   node scripts/sync-memora.mjs --no-build # 仅同步（跳过编译，用于调试）
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** sprite 项目根目录 */
const spriteRoot = join(import.meta.dirname, '..');
/** memora 内核根目录（仓库根，package.json 所在） */
const memoraRoot = join(spriteRoot, '../..');
/** memora 内核编译产物目录 */
const memoraDist = join(memoraRoot, 'dist');
/** sprite node_modules 中 memora 的安装位置 */
const targetMemora = join(spriteRoot, 'node_modules', 'memora');
/** sprite node_modules 中 memora 的 dist 目录（复制模式下使用） */
const targetDist = join(targetMemora, 'dist');

/** 解析参数 */
const skipBuild = process.argv.includes('--no-build');
const packMode = process.argv.includes('--pack');

/**
 * 执行内核编译
 *
 * 在 memora 根目录执行 npm run build（tsc + tsc-alias），
 * 生成 dist/ 目录（.js + .d.ts + .map）。
 */
function buildMemora() {
  console.log('[sync-memora] 编译内核 memora...');
  console.log(`[sync-memora] 内核目录: ${memoraRoot}`);
  try {
    execSync('npm run build', {
      cwd: memoraRoot,
      stdio: 'inherit',
    });
    console.log('[sync-memora] 内核编译完成 ✓');
  } catch {
    console.error('[sync-memora] 内核编译失败，请检查 src/ 下的 TypeScript 错误');
    process.exit(1);
  }
}

/**
 * 检测 node_modules/memora 是否为符号链接/Junction
 *
 * npm 在 Windows 上安装 file: 依赖时默认创建 Junction（目录符号链接），
 * 此时 node_modules/memora/dist 就是仓库根的 dist，编译后自动生效，无需复制。
 *
 * @returns {boolean} true 表示是 Junction/symlink，无需复制
 */
function isJunctionMode() {
  if (!existsSync(targetMemora)) {
    return false;
  }
  const stats = lstatSync(targetMemora);
  return stats.isSymbolicLink();
}

/**
 * 同步 dist 到 sprite 的 node_modules（仅复制模式需要）
 *
 * 复制模式下，node_modules/memora 是独立目录，需要将 dist 从仓库根
 * 复制到 node_modules/memora/dist。先清空目标目录避免残留旧文件。
 */
function syncDistCopyMode() {
  // 检查内核 dist 是否存在
  if (!existsSync(memoraDist)) {
    console.error(`[sync-memora] 内核 dist 目录不存在: ${memoraDist}`);
    console.error('[sync-memora] 请先执行 npm run build 或去掉 --no-build 参数');
    process.exit(1);
  }

  // 检查 node_modules/memora 是否存在
  if (!existsSync(targetMemora)) {
    console.error(`[sync-memora] node_modules/memora 不存在: ${targetMemora}`);
    console.error('[sync-memora] 请先在 sprite 目录执行 npm install');
    process.exit(1);
  }

  // 清空目标 dist（避免残留旧文件，如重命名/删除的模块）
  if (existsSync(targetDist)) {
    rmSync(targetDist, { recursive: true, force: true });
  }

  // 递归复制 dist → node_modules/memora/dist
  cpSync(memoraDist, targetDist, { recursive: true });

  // 统计复制结果
  const size = getDirSize(targetDist);
  console.log(`[sync-memora] 已复制 dist → node_modules/memora/dist (${(size / 1024).toFixed(1)} KB)`);
}

/**
 * 递归计算目录大小（字节）
 * @param {string} dirPath 目录路径
 * @returns {number} 总字节数
 */
function getDirSize(dirPath) {
  let total = 0;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else {
      total += statSync(fullPath).size;
    }
  }
  return total;
}

/**
 * 打包模式：替换 node_modules/memora 为最小化独立目录
 *
 * 开发时 node_modules/memora 是 Junction 指向仓库根（全量文件），
 * electron-builder 跟随 Junction 会把 src/、tasks/、hosts/ 等开发文件全部打入 asar。
 * 打包模式下先删除 Junction/目录，再创建独立目录，仅复制运行时需要的文件：
 * dist/ + package.json + LICENSE + README.md
 */
function packModeSync() {
  // 删除现有的 node_modules/memora（Junction 或独立目录）
  if (existsSync(targetMemora)) {
    const wasJunction = lstatSync(targetMemora).isSymbolicLink();
    rmSync(targetMemora, { recursive: true, force: true });
    console.log(`[sync-memora] 已删除${wasJunction ? ' Junction' : ''}: node_modules/memora`);
  }

  // 创建独立目录
  mkdirSync(targetMemora, { recursive: true });
  console.log('[sync-memora] 已创建独立目录: node_modules/memora');

  // 复制 package.json（electron-builder 用它找入口）
  cpSync(join(memoraRoot, 'package.json'), join(targetMemora, 'package.json'));
  console.log('[sync-memora] 已复制: package.json');

  // 复制 LICENSE
  if (existsSync(join(memoraRoot, 'LICENSE'))) {
    cpSync(join(memoraRoot, 'LICENSE'), join(targetMemora, 'LICENSE'));
    console.log('[sync-memora] 已复制: LICENSE');
  }

  // 复制 README.md
  if (existsSync(join(memoraRoot, 'README.md'))) {
    cpSync(join(memoraRoot, 'README.md'), join(targetMemora, 'README.md'));
    console.log('[sync-memora] 已复制: README.md');
  }

  // 复制 dist/（编译产物）
  if (!existsSync(memoraDist)) {
    console.error(`[sync-memora] 内核 dist 目录不存在: ${memoraDist}`);
    console.error('[sync-memora] 请先编译内核（去掉 --no-build 参数）');
    process.exit(1);
  }
  cpSync(memoraDist, join(targetMemora, 'dist'), { recursive: true });
  const size = getDirSize(join(targetMemora, 'dist'));
  console.log(`[sync-memora] 已复制: dist/ (${(size / 1024).toFixed(1)} KB)`);

  // 复制运行时依赖 zod（memora 的唯一 runtime dependency）
  // electron-builder 跟随 Junction 找依赖，--pack 模式删除 Junction 后需手动复制
  const memoraNodeModules = join(memoraRoot, 'node_modules');
  const zodSource = join(memoraNodeModules, 'zod');
  if (existsSync(zodSource)) {
    const targetNodeModules = join(targetMemora, 'node_modules');
    mkdirSync(targetNodeModules, { recursive: true });
    cpSync(zodSource, join(targetNodeModules, 'zod'), { recursive: true });
    const zodSize = getDirSize(join(targetNodeModules, 'zod'));
    console.log(`[sync-memora] 已复制: node_modules/zod (${(zodSize / 1024).toFixed(1)} KB)`);
  } else {
    console.error(`[sync-memora] zod 依赖不存在: ${zodSource}`);
    console.error('[sync-memora] 请在仓库根执行 npm install');
    process.exit(1);
  }

  console.log('[sync-memora] 打包模式同步完成 ✓');
}

// ─── 主流程 ──────────────────────────────────────────────

console.log(`[sync-memora] sprite 目录: ${spriteRoot}`);
console.log(`[sync-memora] 内核目录: ${memoraRoot}`);

if (skipBuild) {
  console.log('[sync-memora] 跳过编译（--no-build）');
} else {
  buildMemora();
}

// 打包模式：替换 Junction 为最小化独立目录
if (packMode) {
  console.log('[sync-memora] 打包模式：准备最小化 node_modules/memora');
  packModeSync();
  console.log('[sync-memora] 同步完成 ✓');
  process.exit(0);
}

// 开发模式：Junction 自动生效，复制模式则复制 dist
const junctionMode = isJunctionMode();
if (junctionMode) {
  console.log('[sync-memora] Junction 模式：node_modules/memora → 仓库根（符号链接）');
  console.log('[sync-memora] 编译后 dist 自动生效，无需复制 ✓');
} else {
  console.log('[sync-memora] 复制模式：node_modules/memora 是独立目录');
  syncDistCopyMode();
}

console.log('[sync-memora] 同步完成 ✓');
