/**
 * 话题记忆挂载器 — TopicMount
 *
 * 实现"应无所住，而生其心"的专注模式：
 * - "无所住"：启动时不预载任何话题记忆，保持空灵
 * - "生其心"：用户一开口，话题记忆按语义自然浮现
 * - "专注"：同话题内缓存召回结果，减少上下文抖动，鼓励深潜
 *
 * 设计哲学：
 *   Memora 鼓励用户专注一个领域深度探索，而非频繁切换话题。
 *   话题粘性略高于设计文档的默认阈值（0.2 → 0.25），
 *   让用户有更长的"沉浸窗口"。
 *
 * 生命周期：
 *   mount(focus) → 检测话题 → 召回/缓存 → 注入 AgentLoop → unmount(sleep)
 *
 * 详见 02-上下文组装-v4.0.md §3.5 话题漂移检测
 */
import type { Memory } from './types.js';
import type { RecallPipeline } from './recall.js';
import { segmentText } from './segmenter.js';

// ─── 话题漂移阈值 ────────────────────────────────────────

/**
 * 话题相似度阈值
 *
 * 与设计文档 §3.5 的默认阈值（0.2/0.3）相比，本实现：
 * - 同话题阈值从 0.3 提升到 0.35 → 更粘，鼓励专注
 * - 漂移阈值从 0.2 提升到 0.25 → 更保守，减少误切换
 *
 * 原因：Memora 的哲学是鼓励深度专注，而非频繁跳转。
 * 用户显式切换话题的需求由 switchTopic() 独立支持。
 */
const FOCUS_THRESHOLD = 0.35; // ≥ 此值 → 同一话题，使用缓存
const DRIFT_THRESHOLD = 0.25; // < 此值 → 话题漂移，重新召回

// ─── TopicMount 类 ───────────────────────────────────────

export class TopicMount {
  // 当前挂载的话题关键词（用于漂移检测）
  private currentKeywords: Set<string> = new Set();

  // 当前挂载的记忆（按时间排序）
  private _mounted: Memory[] = [];

  // 被用户踢出的记忆 ID 集合（本话题内抑制，切换话题时清除）
  private suppressedIds: Set<string> = new Set();

  // 召回管线（注入）
  private readonly recall: RecallPipeline;

  constructor(recall: RecallPipeline) {
    this.recall = recall;
  }

  // ─── 公开 API ───────────────────────────────────────────

  /**
   * 聚焦话题：检测话题是否漂移，必要时重新召回记忆
   *
   * 核心逻辑：
   * 1. 从用户输入中提取关键词
   * 2. 与当前挂载的关键词做 Jaccard 相似度
   * 3. 同话题 → 直接返回缓存（零延迟）
   * 4. 话题漂移 → 重新召回并替换缓存
   *
   * @param query - 用户输入文本
   * @returns 当前话题相关的记忆（按创建时间排序）
   */
  async focus(query: string): Promise<Memory[]> {
    const newKeywords = this.extractKeywords(query);

    // 冷启动：没有挂载任何话题 → 直接召回
    if (this.currentKeywords.size === 0) {
      return this.remount(newKeywords, query);
    }

    // 计算话题相似度
    const similarity = this.jaccardSimilarity(this.currentKeywords, newKeywords);

    // 同话题 → 专注模式：直接返回缓存，不重新检索
    if (similarity >= FOCUS_THRESHOLD) {
      return this._mounted;
    }

    // 疑似漂移 → 仍使用缓存，但后台异步预取新话题记忆
    // （下一轮如果继续漂移，缓存已就绪）
    if (similarity >= DRIFT_THRESHOLD) {
      // 异步预取，不阻塞当前回复
      this.remount(newKeywords, query).catch(() => {
        // 预取失败静默降级：下一轮仍用当前缓存
      });
      return this._mounted;
    }

    // 明确漂移 → 同步重新召回
    return this.remount(newKeywords, query);
  }

  /**
   * 获取当前挂载的记忆（只读）
   */
  get mounted(): readonly Memory[] {
    return this._mounted;
  }

  /**
   * 当前是否已挂载话题
   */
  get isMounted(): boolean {
    return this._mounted.length > 0;
  }

  /**
   * 卸载当前话题记忆（sleep 时调用）
   */
  unmount(): void {
    this.currentKeywords = new Set();
    this._mounted = [];
    this.suppressedIds.clear();
  }

  /**
   * 踢出指定记忆（新枝破土 N-103）
   *
   * 将记忆 ID 加入抑制集合，立即从当前挂载中移除。
   * 后续 remount() 会自动过滤被抑制的记忆。
   * 抑制仅在本话题会话内有效，话题切换或 unmount 后清除。
   *
   * @param id - 记忆 ID
   * @returns 是否成功踢出（ID 不存在于挂载中则返回 false）
   */
  suppress(id: string): boolean {
    const found = this._mounted.some((m) => m.id === id);
    if (!found) return false;
    this.suppressedIds.add(id);
    this._mounted = this._mounted.filter((m) => m.id !== id);
    return true;
  }

  /**
   * 检查记忆是否已被踢出（新枝破土 N-103）
   */
  isSuppressed(id: string): boolean {
    return this.suppressedIds.has(id);
  }

  /**
   * 获取已被踢出的记忆 ID 数量（供调试/i18n）
   */
  get suppressedCount(): number {
    return this.suppressedIds.size;
  }

  // ─── 内部方法 ───────────────────────────────────────────

  /**
   * 从文本中提取关键词集合
   * 使用 Intl.Segmenter 分词，取前 8 个有意义的词
   */
  private extractKeywords(text: string): Set<string> {
    const tokens = segmentText(text);
    // 取前 8 个 token 作为关键词（足够做话题判断）
    return new Set(tokens.slice(0, 8));
  }

  /**
   * Jaccard 相似度：|A ∩ B| / |A ∪ B|
   * 返回值范围 [0, 1]，1 表示完全相同
   */
  private jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
  }

  /**
   * 重新挂载：召回新话题记忆并替换缓存
   *
   * 召回策略：
   * - 召回 topic 类型的记忆（话题历史）
   * - 按创建时间升序排列（模拟人类记忆的时间线索）
   * - 限制 topK = 10（避免上下文过度膨胀）
   */
  private async remount(keywords: Set<string>, query: string): Promise<Memory[]> {
    // 召回话题相关记忆：用原始查询文本做语义召回（比关键词更丰富）
    const results = await this.recall.recall(query, {
      types: ['topic'],
      topK: 10,
      minWeight: 0.1,
    });

    // 按创建时间排序（旧 → 新，模拟人类回忆的时间顺序）
    results.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // 过滤被踢出的记忆（新枝破土 N-103）
    const filtered = results.filter((m) => !this.suppressedIds.has(m.id));

    // 更新缓存
    this.currentKeywords = keywords;
    this._mounted = filtered;

    return filtered;
  }
}
