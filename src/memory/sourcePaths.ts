/**
 * 记忆 source → 文件系统目录映射与路径构造（单一真理源）
 *
 * 背景（SSOT 修复 T-A1）：宿主 configFileManager 曾有 TYPE_TO_SUBDIR 私有副本 +
 * 3 处硬编码（skillInstaller/personaWatcher/index.ts）——同一张「source → 子目录」
 * 表多处表达，新增 source 类型时漏改即「写 A 读 B」分叉。
 * 本模块是唯一真理源，所有「source → 子目录 / 文件路径」消费方（内核 + 宿主设定文件层）
 * 从本模块导入，宿主侧不再定义映射。
 *
 * 语义约束：
 *   - SOURCE_TO_DIR 仅覆盖配置类记忆（persona/rule/skill）；
 *     未知 source 透传 source 字符串作目录名（ADR-004 开放字符串设计）。
 *   - source 经 validateSource 校验（拒 `..`/null 字节等），校验失败抛 configError（原语义）。
 *   - name 不做字符白名单（Memory.name 是开放字符串），
 *     但做「目标必须在 baseDir/sourceDir 内」的目录前缀纵深防御（防 name 注入 `../` 逃逸子目录）。
 */
import { resolve, sep } from 'node:path';
import { configError } from '@/utils/errors.js';
import { validateSource } from '@/memory/sourceValidation.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/**
 * 已知 source 到文件系统目录的映射
 *
 * 仅覆盖配置类记忆（persona/rule/skill）；
 * 运行时产生的记忆（work-projection 等）不由文件目录管理。
 * 未知 source 由 sourceToDir 透传 source 字符串作目录名。
 */
export const SOURCE_TO_DIR: Readonly<Record<string, string>> = {
  [SOURCE_LABELS.PERSONA]: 'personas',
  [SOURCE_LABELS.RULE]: 'rules',
  [SOURCE_LABELS.SKILL]: 'skills',
};

/**
 * source → 目录名解析（含安全校验）
 *
 * @param source 来源标签（开放字符串）
 * @returns 子目录名（已知 source 走映射，未知 source 透传）
 * @throws configError source 含路径遍历/null 字节等危险字符时
 */
export function sourceToDir(source: string): string {
  const result = validateSource(source);
  if (result.severity === 'block') {
    // 路径遍历 / null 字节 / 空字符串等安全边界违规，必须拒绝
    throw configError(
      'source 校验失败，拒绝映射到目录',
      result.warning,
      ['检查 source 字段是否包含路径遍历序列或特殊字符'],
    );
  }
  return SOURCE_TO_DIR[source] ?? source;
}

/**
 * 构造 baseDir 下 source 子目录中的目标文件绝对路径（含目录内纵深防御）
 *
 * 格式：{baseDir}/{sourceToDir(source)}/{name}.md
 *
 * 防御：resolve 后校验目标必须在 baseDir/sourceDir 内——防 name 注入 `../` 逃逸出子目录
 * （原宿主 resolveTargetPath 的 startsWith 前缀防护，语义等价）。
 *
 * @param baseDir 基础目录（记忆数据目录 dataDir / 配置目录 configDir / 项目 .memora 目录）
 * @param source 来源标签（开放字符串，未知 source 透传作目录名）
 * @param name 记忆名（不含 .md 扩展名，开放字符串不做字符白名单）
 * @returns 目标文件绝对路径
 * @throws configError source 非法或 name 逃逸出子目录时
 */
export function resolveSourceFilePath(baseDir: string, source: string, name: string): string {
  const dir = sourceToDir(source);
  const resolvedDir = resolve(baseDir, dir);
  const targetPath = resolve(baseDir, dir, `${name}.md`);
  // 目录内纵深防御：目标必须位于 baseDir/sourceDir 之内（追加 sep 防兄弟目录前缀绕过）
  if (!targetPath.startsWith(resolvedDir + sep)) {
    throw configError(
      '目标路径越界',
      `目标文件 ${targetPath} 不在目录 ${resolvedDir} 内`,
      ['检查 name 是否包含路径穿越序列'],
    );
  }
  return targetPath;
}
