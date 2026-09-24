/**
 * 通用哈希工具 — 内容指纹生成
 *
 * 职责：
 *   - 提供纯函数 sha256Fingerprint，对任意字符串生成 SHA-256 hex 指纹
 *   - 供可观测性埋点（系统提示指纹、记忆集合指纹）复用，
 *     避免在 agent/ 层各自重复实现 createHash 逻辑
 *
 * 设计约束：
 *   - 纯函数：无状态、无副作用、同输入同输出
 *   - 复用 node:crypto（Node.js 内置），零第三方依赖
 */
import { createHash } from 'node:crypto';

/**
 * 计算字符串的 SHA-256 指纹（hex 格式）
 *
 * 用途：
 *   - "模型看到了什么"可追溯：对系统提示 / 记忆 ID 集合生成轻量指纹，
 *     让宿主在调试时能对比"本轮注入的内容是否变化"，而不必存储全量内容
 *
 * @param input 输入字符串
 * @returns 64 位小写 hex 哈希
 */
export function sha256Fingerprint(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}
