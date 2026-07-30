/**
 * 控制器共享纯函数 helpers
 *
 * 提取自 contextAwareness.ts（MIND-D7）和 patternDetector.ts（MIND-D8）的
 * 「按 source 聚合统计」共享模式，消除跨控制器重复遍历。
 *
 * 设计原则：
 *   - 纯函数，不持有状态，不依赖 this 上下文
 *   - 输入 Memory[]，输出聚合结果 Map
 *   - getSourceDistribution 基于 countBySource 派生，避免重复遍历
 */

import type { Memory } from 'memora';

/**
 * 按来源统计记忆数量
 *
 * 提取自 contextAwareness.ts（MIND-D7）和 patternDetector.ts（MIND-D8）的共享聚合模式。
 * 返回 source → 出现次数 的 Map。
 *
 * @param memories 记忆列表
 */
export function countBySource(memories: Memory[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of memories) {
    counts.set(m.source, (counts.get(m.source) ?? 0) + 1);
  }
  return counts;
}

/**
 * 计算来源分布占比
 *
 * 提取自 patternDetector.ts（MIND-D8），基于 countBySource 派生占比。
 * 返回 source → 占比（0-1） 的 Map。
 *
 * @param memories 记忆列表
 */
export function getSourceDistribution(memories: Memory[]): Map<string, number> {
  const total = memories.length;
  if (total === 0) return new Map();

  const counts = countBySource(memories);
  const distribution = new Map<string, number>();
  for (const [source, count] of counts) {
    distribution.set(source, count / total);
  }
  return distribution;
}
