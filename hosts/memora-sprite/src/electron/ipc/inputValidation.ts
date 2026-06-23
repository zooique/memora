/**
 * IPC 输入验证工具
 *
 * 职责：为所有 IPC 处理器提供统一的输入校验，防止路径遍历、注入等安全风险。
 * 设计原则：白名单优先，拒绝一切含路径分隔符或特殊字符的输入。
 */

import path from 'node:path';

/** 会话名/配置名白名单：仅允许字母、数字、连字符、下划线 */
const NAME_PATTERN = /^[\w-]+$/;

/** 内容长度上限：10MB 文本，防止内存耗尽攻击 */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/**
 * 验证会话名 — 拒绝路径分隔符和特殊字符
 *
 * @param name 待验证的会话名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidSessionName(name: string): boolean {
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return false;
  }
  return NAME_PATTERN.test(name);
}

/**
 * 验证配置文件名（规则/角色/技能名）— 拒绝路径分隔符
 *
 * 配置名用于构造文件路径（如 .memora/rules/{name}.md），
 * 必须严格限制为安全字符，防止路径遍历写入。
 *
 * @param name 待验证的配置名
 * @returns 验证通过返回 true，否则 false
 */
export function isValidConfigName(name: string): boolean {
  if (!name || typeof name !== 'string' || name.length === 0 || name.length > 200) {
    return false;
  }
  return NAME_PATTERN.test(name);
}

/**
 * 验证内容长度 — 防止超大内容导致内存耗尽
 *
 * @param content 待验证的内容
 * @param maxLength 最大允许长度（默认 10MB）
 * @returns 验证通过返回 true，否则 false
 */
export function isValidContent(content: string, maxLength: number = MAX_CONTENT_LENGTH): boolean {
  if (!content || typeof content !== 'string') {
    return false;
  }
  return content.length <= maxLength;
}

/**
 * 验证文件路径是否在允许的目录白名单内
 *
 * 防止路径遍历攻击：解析路径后检查是否以某个允许的目录为前缀。
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
