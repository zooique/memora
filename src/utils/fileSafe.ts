/**
 * 文件安全访问原语（读取 / stat / 存在性）——收口两侧重复的私有实现
 *
 * 背景：全局技能（SkillManager）与角色包内嵌技能（RolePackManager）各自在文件访问上
 * 长出了私有辅助函数，且**能力不对等**：
 * - 角色包侧 `readContentSafe` 有**长度上限**（防超大文件膨胀），全局侧 `readFile` 裸读无上限；
 * - 角色包侧 `getSkillScriptPath` 有**存在性校验**，全局侧无。
 * 按「差异点取更全面形态」的收敛原则，把**更全面的一侧**提升为共享原语，两侧同时受益。
 *
 * 边界：本模块只提供**能力**，不替调用方决定失败语义——
 * 读取失败返回 null，由调用方决定是降级为空串（角色包内容文件）还是向上报 null（L3 资源）。
 * 失败语义是对外契约，统一它会造成破坏性变更，故不在本模块收口。
 */
import { readFile } from 'node:fs/promises';
import { statSync, existsSync, type Stats } from 'node:fs';

/**
 * 内容文件读取长度上限（字符）——防超大文件撑爆上下文
 *
 * SSOT 说明：角色包侧原以 `MAX_CONTENT_FILE_LEN` 使用本值；提升为共享原语后，
 * 全局技能读取 L3 资源与 validateFile 也获得同等级保护。
 */
export const DEFAULT_MAX_CONTENT_LEN = 200_000;

/**
 * 读取文本文件内容，超限截断；失败返回 null（不告警，由调用方决定语义）。
 *
 * @param filePath 文件绝对路径
 * @param maxLen 最大长度（字符），超限截断
 */
export async function readFileCapped(
  filePath: string,
  maxLen: number = DEFAULT_MAX_CONTENT_LEN,
): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.length > maxLen ? content.slice(0, maxLen) : content;
  } catch {
    return null;
  }
}

/** 安全的 stat 同步调用：不可访问返回 null，不抛异常（返回完整 `Stats`，调用方按需取字段） */
export function statSyncSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** 安全的存在性同步调用：不可访问按不存在处理，不抛异常（实现即 `existsSync`，名字与之一致） */
export function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
