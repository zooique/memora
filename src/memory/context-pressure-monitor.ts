/**
 * 上下文压力监控器 — ContextPressureMonitor
 *
 * 哲学：「应无所住」——不囤积上下文。
 * Agent Loop 内的"轻量管家"，实时感知上下文窗口压力，
 * 必要时主动卸载不再被强烈需要的话题记忆（不删除，只是不再注入）。
 *
 * 触发条件：上下文总 token 数 > maxContextTokens × PRESSURE_THRESHOLD
 * 卸载策略：按"最近访问时间 × 与当前查询的相关度"评分，得分最低者优先卸载
 * 卸载后状态：原记忆仍存在 SQLite 索引中，只是从 messages 移除
 *   （TopicMount 会在下一轮重新召回需要的）—— 这是「不生不灭」
 *
 * 设计文档：docs/基础设计文档/05-沉思-记忆衰减与炼化.md §设计一
 */
import type { Memory } from './types.js';
import { logger } from '@/logging/logger.js';

// ─── 阈值常量 ────────────────────────────────────────────

/** 触发自动卸载的压力阈值（占 maxContextTokens 的比例） */
const PRESSURE_THRESHOLD = 0.7;

/** 卸载到压力下降到的目标值 */
const TARGET_PRESSURE = 0.5;

/** 单次最多卸载的话题数量（防止一次卸载太多导致 context 抖动） */
const MAX_UNMOUNT_PER_CHECK = 3;

// ─── 接口定义 ────────────────────────────────────────────

/** 监控器配置 */
export interface PressureMonitorOptions {
  /** 模型上下文窗口上限（tokens） */
  maxContextTokens: number;
  /** 当前被"挂载"的话题记忆（按时间顺序，最新在最后） */
  mountedMemories: () => readonly Memory[];
  /** 当前用户输入（用于相关度计算） */
  currentQuery: () => string;
  /** 估算字符串的 token 数（粗估：1 token ≈ 4 个字符，中英文混合） */
  estimateTokens: (text: string) => number;
  /** 卸载时调用：从挂载区移除并触发 L1 炼化钩子 */
  onUnmount: (memory: Memory) => void | Promise<void>;
}

/** 监控结果 */
export interface PressureCheckResult {
  /** 当前上下文总 token 数 */
  totalTokens: number;
  /** 压力比例 (0-1) */
  pressure: number;
  /** 是否超阈值 */
  isOverloaded: boolean;
  /** 本次被卸载的记忆 ID 列表 */
  unmounted: string[];
}

// ─── ContextPressureMonitor 类 ───────────────────────────

export class ContextPressureMonitor {
  private readonly opts: PressureMonitorOptions;

  constructor(opts: PressureMonitorOptions) {
    this.opts = opts;
  }

  // ─── 公开 API ───────────────────────────────────────────

  /**
   * 计算当前上下文的 token 总量
   */
  measure(): number {
    let total = 0;
    // 挂载的话题记忆
    for (const m of this.opts.mountedMemories()) {
      total += this.opts.estimateTokens(m.content) + 50; // 50 = 元信息（name/tags/时间）开销
    }
    return total;
  }

  /**
   * 计算当前压力比例
   */
  pressureRatio(): number {
    return this.measure() / this.opts.maxContextTokens;
  }

  /**
   * 检查并执行自动卸载
   *
   * 行为：
   * - 压力 < 70%：什么都不做（让对话自然流动）
   * - 压力 ≥ 70%：开始按评分卸载
   * - 卸载到压力 ≤ 50% 为止
   * - 每次最多卸载 3 个话题（避免抖动）
   *
   * @returns 检查结果（包含被卸载的列表）
   */
  async check(): Promise<PressureCheckResult> {
    const total = this.measure();
    const pressure = total / this.opts.maxContextTokens;
    const result: PressureCheckResult = {
      totalTokens: total,
      pressure,
      isOverloaded: pressure >= PRESSURE_THRESHOLD,
      unmounted: [],
    };

    // 压力未超阈值，无需卸载
    if (!result.isOverloaded) {
      return result;
    }

    logger.info(
      { pressure, threshold: PRESSURE_THRESHOLD, total },
      '上下文压力超阈值，触发自动卸载',
    );

    // 计算每个挂载话题的"留存价值分"
    const queryKeywords = this.extractKeywords(this.opts.currentQuery());
    const now = Date.now();
    const scored = this.opts.mountedMemories().map((m) => {
      const memKeywords = this.extractKeywords(m.content);
      const relevance = this.jaccard(queryKeywords, memKeywords);
      const recency = this.recencyScore(m, now);
      // 综合分 = 相关度 × 0.6 + 时近度 × 0.4
      const score = relevance * 0.6 + recency * 0.4;
      return { memory: m, score };
    });

    // 升序排列：得分最低的最先卸载
    scored.sort((a, b) => a.score - b.score);

    // 循环卸载，直到压力降到目标值
    let unmountedCount = 0;
    for (const { memory } of scored) {
      if (result.pressure <= TARGET_PRESSURE) break;
      if (unmountedCount >= MAX_UNMOUNT_PER_CHECK) break;

      logger.debug({ memoryId: memory.id, name: memory.name }, '自动卸载话题记忆');

      // 调用 onUnmount 钩子（外部代码负责从挂载区移除 + 触发 L1 炼化）
      await this.opts.onUnmount(memory);
      result.unmounted.push(memory.id);
      unmountedCount++;

      // 重新计算压力
      result.totalTokens = this.measure();
      result.pressure = result.totalTokens / this.opts.maxContextTokens;
    }

    if (result.unmounted.length > 0) {
      logger.info(
        { unmountedCount: result.unmounted.length, newPressure: result.pressure },
        '上下文自动卸载完成',
      );
    }

    return result;
  }

  // ─── 内部方法 ───────────────────────────────────────────

  /**
   * 提取关键词集合（简单分词：取中英文字符 + 数字，2 字以上）
   *
   * 为什么不直接用 segmenter.ts？因为这里是"压力监控"的热路径，
   * 不需要完美分词，粗略即可。
   */
  private extractKeywords(text: string): Set<string> {
    const words = text.match(/[\u4e00-\u9fa5]{2,}|[a-zA-Z]{3,}|\d+/g) ?? [];
    return new Set(words.map((w) => w.toLowerCase()));
  }

  /** Jaccard 相似度 */
  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    const intersection = new Set([...a].filter((x) => b.has(x)));
    const union = new Set([...a, ...b]);
    return intersection.size / union.size;
  }

  /**
   * 时近度评分：0-1，最近的为 1
   * 用 7 天半衰期（一周不碰的话题衰减一半）
   */
  private recencyScore(m: Memory, now: number): number {
    const lastUpdate = new Date(m.updatedAt).getTime();
    const ageDays = (now - lastUpdate) / (24 * 60 * 60 * 1000);
    return Math.exp(-ageDays / 7); // 7 天半衰期
  }
}
