/**
 * 打包前清理 release 目录
 *
 * 清除上次打包的残留产物（win-unpacked.tmp、win-unpacked、*.zip、*.exe 等），
 * 防止 Windows 文件锁导致 EPERM rename 失败。
 *
 * 用法：node scripts/clean-release.mjs
 */

import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** release 目录路径 */
const releaseDir = join(import.meta.dirname, '..', 'release');

// release 目录不存在时无需清理
if (!existsSync(releaseDir)) {
  console.log('[clean-release] release 目录不存在，跳过清理');
  process.exit(0);
}

/** 统计清理结果 */
let cleanedCount = 0;
let failedCount = 0;

// 同步删除单条目，失败后延迟 500ms 重试一次（应对 Windows 文件锁）
function removeEntry(entryPath, entryName) {
  try {
    rmSync(entryPath, { recursive: true, force: true });
    console.log(`[clean-release] 已删除: ${entryName}`);
    return true;
  } catch {
    // Windows 文件锁时同步等待后重试
    const start = Date.now();
    while (Date.now() - start < 500) { /* 同步等待 500ms */ }
    try {
      rmSync(entryPath, { recursive: true, force: true });
      console.log(`[clean-release] 已删除（重试）: ${entryName}`);
      return true;
    } catch {
      console.warn(`[clean-release] 删除失败（可能被占用）: ${entryName}`);
      return false;
    }
  }
}

// 遍历 release 目录下所有条目，逐个删除
for (const entry of readdirSync(releaseDir)) {
  const entryPath = join(releaseDir, entry);
  if (removeEntry(entryPath, entry)) {
    cleanedCount++;
  } else {
    failedCount++;
  }
}

console.log(`[clean-release] 清理完成: ${cleanedCount} 项已删, ${failedCount} 项失败`);

// 如果有删除失败的项，退出码 1 提醒用户
if (failedCount > 0) {
  console.warn('[clean-release] 部分文件删除失败，建议关闭可能占用的程序后重试');
  process.exit(1);
}
