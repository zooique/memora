/**
 * 记忆 source → 文件系统目录映射与路径构造（单一真理源）。
 * SSOT 修复 T-A1：宿主 configFileManager 曾有私有副本 + 3 处硬编码导致「写 A 读 B」分叉；
 * 本模块是唯一真理源，所有「source → 子目录 / 文件路径」消费方（内核 + 宿主设定文件层）都从本模块导入。
 * 语义：SOURCE_TO_DIR 仅覆盖配置类记忆（persona/rule/skill），未知 source 透传作目录名；
 * source 经 validateSource 校验（拒 `..`/null 字节），name 不做白名单但做 baseDir 内目录前缀纵深防御
 */
import { resolve, sep } from 'node:path';
import { configError } from '@/utils/errors.js';
import { validateSource } from '@/memory/sourceValidation.js';
import { SOURCE_LABELS } from '@/memory/types.js';

/** source → 目录映射（仅配置类记忆 persona/rule/skill；运行时记忆不由目录管理；未知 source 透传） */
export const SOURCE_TO_DIR: Readonly<Record<string, string>> = {
  [SOURCE_LABELS.PERSONA]: 'personas',
  [SOURCE_LABELS.RULE]: 'rules',
  [SOURCE_LABELS.SKILL]: 'skills',
};

/**
 * source → 目录名解析（含安全校验）；未知 source 透传。
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
 * 构造 baseDir 下 source 子目录中 {name}.md 的绝对路径。
 * resolve 后校验目标须位于 baseDir/sourceDir 内，防 name 注入 `../` 逃逸出子目录
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