/**
 * 记忆搜索后端工具 —— 关键词提取 / 访问轨迹刷新。
 *
 * 本模块两函数均为 search_memories / 项目搜索复用：
 * - `extractKeywords`：内核分词 SSOT（`project-search/terms.ts` 用同源断言钉死，不另造分词器）；
 * - `touchScores`：命中后只刷 `accessedAt`（`storage.touch` 唯一写位，score 已物理退役）。
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { segmentLower, STOPWORDS } from '@/utils/segmenter.js';
import { nowIso } from '@/utils/time.js';

/**
 * 从文本提取关键词：segmentText 精确分词 + 停用词过滤 + 英文词补充 + 去重。
 */
export function extractKeywords(input: string): string[] {
  const words = segmentLower(input);

  // 补充英文词（segmentText 可能遗漏连续英文大写缩写，如 APIKey → "apikey" 整词）
  const englishWords = input.match(/[a-z]{2,}/gi) || [];
  words.push(...englishWords.map((w) => w.toLowerCase()));

  // 去重 + 停用词过滤 + 最短长度
  return [...new Set(words)].filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * 批量 touch（召回后 fire-and-forget 调用）：只刷新 accessedAt。
 *
 * 只刷新 accessedAt：accessedAt 是「使用轨迹」唯一事实源（被想起即刷新），storage.touch 即唯一写位，
 * 无 +score / clamp 语义。失败仅 log 不抛错，不阻塞读路径。
 */
export async function touchScores(
  storage: IMemoryStorage,
  ids: string[],
  now: string = nowIso(),
): Promise<void> {
  for (const id of ids) {
    storage.touch(id, now);
  }
}
