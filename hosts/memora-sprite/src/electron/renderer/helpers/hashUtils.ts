/**
 * 渲染层 hash 工具 — 统计去标识化场景使用（非安全场景）
 *
 * 设计决策（ADR-017 枝叶层 2 次提取）：
 * - 选型：同步 FNV-1a 32 位 hash，纯 JS 实现，零依赖
 * - 理由：统计去标识场景不需密码学强度，简单 hash 性能更好且不污染调用链同步性
 * - 未来扩展：若出现第 2 处需求且需密码学强度，再加 sha256Hex（Web Crypto API，异步）
 *
 * 与内核 workProjection.ts 的 SHA-256 区别：
 * - workProjection 用 node:crypto SHA-256：作品内容去重，需密码学强度防碰撞，仅 Node 主进程可用
 * - hashUtils 用 FNV-1a：统计去标识，碰撞可接受，渲染层（Chromium）可用
 * - 两者场景不同，不应强行复用同一工具
 */

/**
 * FNV-1a 32 位 hash（同步，纯 JS 实现）
 *
 * 算法：FNV offset basis 2166136261，FNV prime 16777619
 * 特点：分布均匀、碰撞率低、速度快，适合统计去标识场景
 *
 * @param text 原始文本
 * @returns 32 位无符号整数的十六进制字符串（8 字符），如 "a1b2c3d4"
 */
export function simpleHash(text: string): string {
  // FNV-1a 参数
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  // 32 位无符号整数掩码（JS 位运算是有符号 32 位，需用 >>> 0 转无符号）
  const UINT32_MASK = 0xffffffff;

  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    // XOR 字节
    hash ^= text.charCodeAt(i);
    // 乘 FNV_PRIME（用 Math.imul 避免 53 位精度溢出，等价于 32 位乘法）
    hash = Math.imul(hash, FNV_PRIME);
  }
  // 转无符号 32 位 + 转 16 进制（padStart 确保固定 8 字符长度）
  return (hash >>> 0).toString(16).padStart(8, '0');
}
