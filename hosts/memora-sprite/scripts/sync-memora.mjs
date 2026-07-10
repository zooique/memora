/**
 * 内核同步脚本 — 编译 memora 内核，确保 sprite 的 node_modules 指向最新 dist
 *
 * 使用场景：
 *   1. 修改了 memora 内核源码后，开发前手动执行一次：npm run sync-memora
 *   2. 打包流程（package.mjs）自动调用，确保打包用的是最新内核
 *
 * 不修改内核时无需执行，sprite 的 node_modules/memora/dist 保持上一次同步的状态。
 *
 * 两种安装模式：
 *   - Junction 模式（npm on Windows 默认）：node_modules/memora 是符号链接指向仓库根，
 *     编译后 dist 自动生效，无需复制。
 *   - 复制模式（其他平台或 --force）：node_modules/memora 是独立目录，
 *     需要将 dist 从仓库根复制到 node_modules/memora/dist。
 *
 * 用法：
 *   node scripts/sync-memora.mjs           # 编译 + 同步（自动检测模式）
 *   node scripts/sync-memora.mjs --no-build # 仅同步（跳过编译，用于调试）
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
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

/** 解析 --no-build 参数：跳过编译步骤，仅同步（用于调试） */
const skipBuild = process.argv.includes('--no-build');

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

// ─── 主流程 ──────────────────────────────────────────────

console.log(`[sync-memora] sprite 目录: ${spriteRoot}`);
console.log(`[sync-memora] 内核目录: ${memoraRoot}`);

if (skipBuild) {
  console.log('[sync-memora] 跳过编译（--no-build）');
} else {
  buildMemora();
}

// 检测安装模式：Junction 模式无需复制，复制模式需要同步 dist
const junctionMode = isJunctionMode();
if (junctionMode) {
  console.log('[sync-memora] Junction 模式：node_modules/memora → 仓库根（符号链接）');
  console.log('[sync-memora] 编译后 dist 自动生效，无需复制 ✓');
} else {
  console.log('[sync-memora] 复制模式：node_modules/memora 是独立目录');
  syncDistCopyMode();
}

console.log('[sync-memora] 同步完成 ✓');
