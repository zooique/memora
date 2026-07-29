/**
 * API Key 脱敏工具
 *
 * 统一真理源：minimalHandlers.ts（IPC 路径）和 index.ts（CLI/Web 路径）共用。
 * 脱敏策略：仅保留前 3 位 + 后 4 位，中间用 **** 替代。
 *   - 前 3 位足以识别 Key 类型（如 sk- 前缀）
 *   - 后 4 位便于用户在多 Key 场景下区分
 *   - 中间 **** 防止完整密钥泄漏到渲染进程 / CLI 输出
 *
 * 短 Key（≤8 字符）直接返回 ****，避免脱敏后仍可推断原值。
 */

/**
 * 脱敏 API Key 供显示
 *
 * @param key 原始 API Key（可能为 undefined / 空字符串 / 短字符串）
 * @returns 脱敏后的字符串（空输入返回空字符串，短输入返回 ****）
 */
export function maskApiKey(key: string | undefined): string {
  if (!key || key.length <= 8) {
    return key ? '****' : '';
  }
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}
