/**
 * IPC 输入验证工具
 *
 * 架构位置：
 *   - 纯函数（无 Node 依赖）从 shared/inputValidation.ts 重新导出，保证 IPC 层与 Web 层行为一致
 *   - isPathAllowed 依赖 node:path，在本模块本地实现（shared/ 保持无 Node 依赖约束）
 *
 * 设计原因：
 *   全部位于 shared/ 层，但 isPathAllowed 使用了 node:path，
 *   违反了"shared/ 无 Node 运行时依赖"的架构约束（directory-structure.md §2.1）。
 *   迁移后：shared/ 保留纯函数（Web/IPC 共用），isPathAllowed 仅在主进程使用。
 *
 * 向后兼容：所有现有 `from './inputValidation.js'` 的 import 无需修改。
 */
import path from 'node:path';

// 纯函数从 shared/ 重新导出（IPC 层与 Web 层共用真理源）
export {
  isValidSessionName,
  isValidConfigName,
  isValidContent,
  isValidId,
  isValidSearchQuery,
  isValidPersonaName,
  isValidFilePath,
  isValidRelationType,
  isNonEmptyString,
  isValidRelationParams,
  isValidShortcutConfig,
} from '../../shared/inputValidation.js';

/**
 * 验证文件路径是否在允许的目录白名单内
 *
 * 防止路径遍历攻击：解析路径后检查是否以某个允许的目录为前缀。
 *
 * 注意：本函数依赖 node:path，仅在主进程使用。
 * shared/ 层不提供此函数，以保持 shared/ 无 Node 依赖的架构约束。
 *
 * @param filePath 待验证的文件路径
 * @param allowedDirs 允许的目录白名单（绝对路径）
 * @returns 验证通过返回 true，否则 false
 */
export function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  if (!filePath || typeof filePath !== 'string') {
    return false;
  }
  // 解析为绝对路径，消除 ../ 和 ./ 等相对路径
  const resolved = path.resolve(filePath);
  return allowedDirs.some((dir) => {
    const resolvedDir = path.resolve(dir);
    // 确保路径在允许目录内（使用 path.relative 防止前缀匹配绕过）
    const relative = path.relative(resolvedDir, resolved);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}
