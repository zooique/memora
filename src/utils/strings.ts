/**
 * 字符串工具函数——从各模块提取的公共处理函数，消除跨模块重复代码。
 */

/** slug 最大长度 */
const MAX_SLUG_LENGTH = 40;

/**
 * 将字符串转换为 URL 友好 slug：冒号/空白→连字符，只保留字母、数字、中文、连字符、下划线，
 * 折叠重复连字符、去首尾连字符，截断到 MAX_SLUG_LENGTH。
 */
export function slugify(value: string): string {
  return value
    .replace(/[:\s]+/g, '-')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

// ─── 文本截断 ─────────────────────────────────────────

/**
 * 截断文本到指定长度，超长时追加后缀（默认 '…'）。
 * 后缀不计入 maxLen；总长度 = maxLen + suffix.length；未超长原样返回。
 */
export function truncate(text: string, maxLen: number, suffix: string = '…'): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + suffix;
}

// ─── 配置名白名单校验 ─────────────────────────────────

/** 配置名默认最大长度 */
export const MAX_CONFIG_NAME_LENGTH = 100;

/**
 * 配置名（规则/技能/角色文件名）白名单校验——字符集 `[\p{L}\p{N}_-]`
 * （全 Unicode 字母数字，拒绝路径分隔符、点号、空格），长度默认 100。
 * 宿主 shared/inputValidation 与内核保持同规则（两端各一份 + 契约测试锁定一致）。
 */
export function isValidConfigName(name: string, maxLength: number = MAX_CONFIG_NAME_LENGTH): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(name);
}

/** 解析配置 ID（`source:name` 格式）为 {source, name}；无冒号返回 null（调用方按放行处理） */
export function parseConfigId(id: string): { source: string; name: string } | null {
  if (typeof id !== 'string') return null;
  const colonIdx = id.indexOf(':');
  if (colonIdx < 0) return null;
  return { source: id.slice(0, colonIdx), name: id.slice(colonIdx + 1) };
}