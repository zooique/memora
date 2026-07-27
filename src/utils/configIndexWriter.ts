/**
 * 配置项批量写入索引工具 — PersonaManager / SkillManager 共享
 *
 * 消除两个 Manager 中完全重复的 writeAllToIndex 模板代码。
 *
 * 使用 try/catch 包裹每个 upsert 调用，防止单条写入失败阻断其余条目索引。
 * IMemoryStorage.upsert 是同步方法，但可能因底层存储故障抛异常。
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { nowIso } from '@/utils/time.js';

/**
 * 批量将配置项写入 SQLite 索引
 *
 * @param index    存储实例（undefined 时静默跳过，无需调用方判空）
 * @param items    待写入的配置项数组
 * @param source   Memory.source 标签（如 'persona' / 'skill'）
 * @param idPrefix id 前缀（如 'persona:' / 'skill:'）
 * @param score    固定初始分数（persona=1.0, skill=0.7）
 * @param label    日志用的中文标签（'角色' / '技能'）
 */
export function writeConfigItemsToIndex(
  index: IMemoryStorage | undefined,
  items: Array<{ name: string; content: string; id?: string }>,
  source: string,
  idPrefix: string,
  score: number,
  label: string,
): void {
  if (!index) return;
  let failedCount = 0;
  for (const item of items) {
    try {
      const memory: Memory = {
        id: item.id ?? `${idPrefix}${item.name}`,
        content: item.content,
        source,
        name: item.name,
        createdAt: nowIso(),
        accessedAt: nowIso(),
        score,
      };
      index.upsert(memory);
    } catch (err) {
      failedCount++;
      logger.warn({ err, [label]: item.name }, `${label}记忆写入 SQLite 失败`);
    }
  }
  if (failedCount > 0) {
    logger.warn({ total: items.length, failed: failedCount }, `部分${label}记忆写入失败`);
  } else {
    logger.info({ count: items.length }, `${label}记忆已写入 SQLite`);
  }
}
