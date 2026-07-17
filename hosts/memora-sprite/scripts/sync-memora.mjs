/**
 * 内核同步脚本 — 编译 memora 内核，复制到 sprite 的 node_modules/memora
 *
 * sprite 不通过 npm file: 依赖获取内核（避免 Junction 将全量仓库打入 asar），
 * 而是由本脚本负责：编译内核 → 创建最小化 node_modules/memora（仅 dist + 元数据）。
 *
 * 使用场景：
 *   1. 开发：build:electron / start:electron 自动调用，确保 node_modules/memora 存在
 *   2. 打包：package.mjs 调用，确保 asar 内仅含最小化内核
 *   3. 手动：修改内核源码后手动执行 npm run sync-memora
 *
 * 用法：
 *   node scripts/sync-memora.mjs           # 编译 + 同步
 *   node scripts/sync-memora.mjs --no-build # 仅同步（跳过编译，用于调试）
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** sprite 项目根目录 */
const spriteRoot = join(import.meta.dirname, '..');
/** memora 内核根目录（仓库根，package.json 所在） */
const memoraRoot = join(spriteRoot, '../..');
/** memora 内核编译产物目录 */
const memoraDist = join(memoraRoot, 'dist');
/** sprite node_modules 中 memora 的位置 */
const targetMemora = join(spriteRoot, 'node_modules', 'memora');

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
 * 同步内核到 node_modules/memora
 *
 * 创建独立目录，仅复制运行时需要的文件：
 *   - dist/（编译产物）
 *   - package.json（electron-builder 用它找入口 + 依赖声明）
 *   - LICENSE、README.md
 *
 * 不复制 src/、tasks/、hosts/、.trae/ 等开发文件，
 * 确保 electron-builder 打包时不会将全量仓库打入 asar。
 */
function syncToNodeModules() {
  // 检查内核 dist 是否存在
  if (!existsSync(memoraDist)) {
    console.error(`[sync-memora] 内核 dist 目录不存在: ${memoraDist}`);
    console.error('[sync-memora] 请先编译内核（去掉 --no-build 参数）');
    process.exit(1);
  }

  // 删除现有的 node_modules/memora（独立目录或 Junction）
  if (existsSync(targetMemora)) {
    rmSync(targetMemora, { recursive: true, force: true });
  }

  // 创建独立目录
  mkdirSync(targetMemora, { recursive: true });

  // 复制 package.json（electron-builder 用它找入口 + 依赖声明）
  cpSync(join(memoraRoot, 'package.json'), join(targetMemora, 'package.json'));

  // 复制 LICENSE
  if (existsSync(join(memoraRoot, 'LICENSE'))) {
    cpSync(join(memoraRoot, 'LICENSE'), join(targetMemora, 'LICENSE'));
  }

  // 复制 README.md
  if (existsSync(join(memoraRoot, 'README.md'))) {
    cpSync(join(memoraRoot, 'README.md'), join(targetMemora, 'README.md'));
  }

  // 复制 dist/（编译产物）
  cpSync(memoraDist, join(targetMemora, 'dist'), { recursive: true });
  const distSize = getDirSize(join(targetMemora, 'dist'));
  console.log(`[sync-memora] 已复制: dist/ (${(distSize / 1024).toFixed(1)} KB)`);
}

// ─── 主流程 ──────────────────────────────────────────────

console.log(`[sync-memora] sprite 目录: ${spriteRoot}`);
console.log(`[sync-memora] 内核目录: ${memoraRoot}`);

if (skipBuild) {
  console.log('[sync-memora] 跳过编译（--no-build）');
} else {
  buildMemora();
}

console.log('[sync-memora] 同步内核到 node_modules/memora...');
syncToNodeModules();

console.log('[sync-memora] 同步完成 ✓');
