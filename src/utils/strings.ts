/**
 * 字符串工具函数
 *
 * 从各模块提取的公共字符串处理函数，消除跨模块重复代码。
 */

/** slug 最大长度 */
const MAX_SLUG_LENGTH = 40;

/**
 * 将字符串转换为 URL 友好的 slug 格式
 *
 * 规则：
 *   - 冒号和空白替换为连字符
 *   - 只保留字母、数字、中文、连字符、下划号
 *   - 截断到 MAX_SLUG_LENGTH 字符
 *
 * @param value 输入字符串
 * @returns slug 格式的字符串
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
 * 截断文本到指定长度，超长时追加后缀（省略号）
 *
 * 统一内核中 15 处散落的 `slice + suffix` 模式（ADR-017 枝叶层 2 次提取）。
 *
 * 后缀约定：
 *   - 默认 '…'（Unicode U+2026，1 字符）：UI 预览场景，简洁
 *   - '…[截断]'：LLM prompt 场景，明确告知模型"此处被截断，非原文结束"
 *   - 调用方可通过 suffix 参数自定义
 *
 * ellipsis 统一：将散落的 '...'（ASCII 3 字符）统一为 '…'（Unicode 1 字符），
 *
 * @param text 原始文本
 * @param maxLen 最大保留长度（后缀不计入；截断后总长度 = maxLen + suffix.length）
 * @param suffix 超长时追加的后缀，默认 '…'
 * @returns 截断后的文本（含后缀），或原文本（未超长时原样返回）
 */
export function truncate(text: string, maxLen: number, suffix: string = '…'): string {
  // 未超长直接返回原文本（含 text.length === maxLen 的边界情况）
  if (text.length <= maxLen) return text;
  // 超长时截断到 maxLen 并追加后缀
  return text.slice(0, maxLen) + suffix;
}

// ─── 配置名白名单校验 ─────────────────────────────────

/**
 * 配置名默认最大长度（T-B1 数据核查：真实 configDir 最大名长 25，persona 现上限 100）
 */
export const MAX_CONFIG_NAME_LENGTH = 100;

/**
 * 配置名（规则/技能/角色文件名）白名单校验
 *
 * 统一前的三套规则（SSOT 违反 T-B2）：
 *   - 内核 configManager.confirmConfigSuggestion 内联 `/^[\w\u4e00-\u9fa5-]{1,64}$/`（64 字）
 *   - 宿主 shared/inputValidation.isValidConfigName `[\p{L}\p{N}_-]`（200 字）
 *   - 宿主 isValidPersonaName ASCII 100 字（persona 领域独立，保留）
 * 同一「配置名」概念行为分叉：100 字中文名面板可建、内核建议确认拒绝。
 *
 * 统一后：字符集取 `[\p{L}\p{N}_-]`（全 Unicode 字母数字，拒绝路径分隔符 / \、点号、空格），
 * 长度默认 100。宿主 shared/inputValidation.ts 与内核保持同规则（renderer 无法 import memora，
 * 两端各一份实现 + 宿主侧契约测试锁定一致——见 inputValidation.test.ts）。
 *
 * @param name 待校验的配置名
 * @param maxLength 最大长度（默认 100）
 * @returns 校验通过返回 true
 */
export function isValidConfigName(name: string, maxLength: number = MAX_CONFIG_NAME_LENGTH): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > maxLength) return false;
  return /^[\p{L}\p{N}_-]+$/u.test(name);
}

/**
 * 解析配置 ID（`rule:NAME` / `skill:NAME` 格式）为 {source, name}
 *
 * T-D：此前内核 ConfigManager 构造 id（`${source}:${name}`）与宿主 index.ts 手工
 * `id.indexOf(':')` 解析是两套互为镜像的字符串逻辑，靠注释对齐（T5 契约）。
 * 本函数收口解析侧：宿主 fileConsistencyCheck 回调改调用本函数，消除手工对齐。
 *
 * @param id 记忆 ID（source:name 格式，Memory.id 契约）
 * @returns {source, name}；格式非法（无冒号）返回 null（调用方按放行处理）
 */
export function parseConfigId(id: string): { source: string; name: string } | null {
  if (typeof id !== 'string') return null;
  const colonIdx = id.indexOf(':');
  if (colonIdx < 0) return null;
  return { source: id.slice(0, colonIdx), name: id.slice(colonIdx + 1) };
}

