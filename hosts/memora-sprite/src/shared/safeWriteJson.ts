/**
 * 安全写入 JSON 文件（跨层共享，含文件权限保护 + 原子写入）
 *
 * 职责：
 *   - 自动创建父目录（recursive，对已存在目录是 no-op）
 *   - JSON.stringify 格式化（2 空格缩进）
 *   - 文件权限 0o600（仅 owner 可读写，保护 apiKey 等敏感字段）
 *   - 原子写入：先写临时文件再 rename，防止崩溃导致原文件损坏
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - async 版：从 cli.ts + spriteConfigStore.ts 共 3 处散落模式提取
 *   - sync 版：从 spriteConfig.ts saveSpriteConfig 提取（消除 mkdir+0o600 重复）
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 toError/truncate 同级），跨 sprite/storage/cli 三层共享
 *   - 不与内核 memora 共享（ADR-002 内核零依赖约束）
 */

import { mkdir, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 安全写入 JSON 文件（async，原子写入保护）
 *
 * 写临时文件 → rename 原子替换，防止崩溃时损坏原文件。
 *
 * @param filePath 目标文件路径
 * @param data 可序列化的数据对象
 */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  // 确保父目录存在（首次运行时 dataDir 可能尚未创建；对已存在目录是 no-op）
  await mkdir(dirname(filePath), { recursive: true });
  // 先写临时文件，再 rename 原子替换（防止崩溃导致原文件损坏）
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await rename(tmpPath, filePath);
}

/**
 * 安全写入 JSON 文件（sync，原子写入保护）
 *
 * sync 版本，用于 saveSpriteConfig 等同步调用链。
 *
 * @param filePath 目标文件路径
 * @param data 可序列化的数据对象
 */
export function safeWriteJsonSync(filePath: string, data: unknown): void {
  // 确保父目录存在（sync 版，首次运行时 dataDir 可能尚未创建）
  mkdirSync(dirname(filePath), { recursive: true });
  // 先写临时文件，再 rename 原子替换（防止崩溃导致原文件损坏）
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmpPath, filePath);
}
