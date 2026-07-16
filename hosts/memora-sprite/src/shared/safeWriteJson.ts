/**
 * 安全写入 JSON 文件（跨层共享，含文件权限保护）
 *
 * 职责：
 *   - 自动创建父目录（recursive，对已存在目录是 no-op）
 *   - JSON.stringify 格式化（2 空格缩进）
 *   - 文件权限 0o600（仅 owner 可读写，保护 apiKey 等敏感字段）
 *
 * 设计原则（ADR-017 枝叶层 2 次提取）：
 *   - 从 3 处散落的 `writeFile + JSON.stringify + mode:0o600` 模式中提取
 *   - cli.ts（CLI 配置初始化）+ spriteConfigStore.ts（save/saveProviders）共 3 处 async 场景
 *   - spriteConfig.ts 的 sync writeFileSync 场景不迁移（sync 语义不同，避免影响调用链）
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 toError/truncate 同级），跨 sprite/storage/cli 三层共享
 *   - 不与内核 memora 共享（ADR-002 内核零依赖约束）
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 安全写入 JSON 文件（async）
 *
 * 自动创建父目录 + JSON 格式化 + 0o600 权限保护。
 *
 * @param filePath 目标文件路径
 * @param data 可序列化的数据对象
 */
export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  // 确保父目录存在（首次运行时 dataDir 可能尚未创建；对已存在目录是 no-op）
  await mkdir(dirname(filePath), { recursive: true });
  // 写入 JSON（2 空格缩进）+ 0o600 权限（仅 owner 可读写，保护 apiKey 等敏感字段）
  await writeFile(filePath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
