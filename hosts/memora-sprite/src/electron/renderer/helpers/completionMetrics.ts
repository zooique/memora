/**
 * 补全统计埋点模块
 *
 * 职责：
 * - 记录补全展示事件（recordShown）和采纳事件（recordAdoption）
 * - 记录对话轮次（recordChatTurn）作为激活率分母
 * - 记录召回可感知时刻（recordRecallMoment）作为 B2 纵向养成指标
 * - localStorage 持久化（key: memora-completion-stats），LRU 500 条上限
 * - 实时聚合计算（getAggregated）：采纳率 / Top-1 命中率 / 平均采纳位置 / 展示数 / 采纳数 / 激活率 / 召回时刻数
 * - 按日聚合计算（getDailyAggregated）：最近 N 天 5 项指标曲线
 *
 * 设计决策（ADR-017 枝叶层 2 次提取）：
 * - 不做未采纳埋点：采纳率通过 totalAdopted / totalShown 反推，避免侵入 3 个文件的复杂未采纳判定
 * - 按事件流存储 + 实时聚合：避免 aggregated 与 events 不同步
 * - 隐私保护：只记 queryLen + simpleHash(query) + adoptedTextHash，不记原文；chat-turn/recall-moment 仅记时间戳
 * - 独立 localStorage key：不与 adoptedTexts 共用，避免破坏现有 boost 逻辑
 *
 * 数据流：
 *   用户输入 → fetchCandidates → renderCandidates → recordShown（展示事件）
 *   用户采纳 ←/click → recordAdoption → recordAdoption（采纳事件）
 *   用户发送对话 → recordChatTurn（激活率分母）
 *   召回记忆展示 → recordRecallMoment（"你教过我 X"可感知时刻）
 *   统计面板 → getAggregated → 渲染采纳率/Top-1 命中率/平均位置/激活率/召回时刻
 *   统计面板 → getDailyAggregated → 渲染最近 14 天按日趋势
 */

import { safeGetJSON, safeSetJSON } from './safeStorage.js';
// createSingleton 封装懒创建单例模式（ADR-017 枝叶层 2 次提取）
import { createSingleton } from '../../../shared/singleton.js';

// ─── 常量 ────────────────────────────────────────────────

/** localStorage 键名（遵循宿主 `memora-` 前缀约定） */
const METRICS_STORAGE_KEY = 'memora-completion-stats';

/** 事件流最大条目数（LRU 淘汰上限，约 50KB） */
const MAX_METRICS_ENTRIES = 500;

// ─── 类型 ────────────────────────────────────────────────

/**
 * 补全展示事件
 *
 * 每次候选列表展示给用户时记录一条。queryHash 用于聚合相似查询（不记原文）。
 */
export interface CompletionShowEvent {
  /** 事件类型标识（用于 JSON 反序列化区分） */
  type: 'shown';
  /** 查询文本长度（不记原文） */
  queryLen: number;
  /** 查询文本 hash（FNV-1a，用于聚合相似查询，不记原文） */
  queryHash: string;
  /** 展示候选数（≤5，slice 后） */
  shownCount: number;
  /** 合并去重后候选总数（slice 前，用于计算截断率） */
  totalCandidatesCount: number;
  /** 事件时间戳（ISO 字符串） */
  timestamp: string;
}

/**
 * 补全采纳事件
 *
 * 用户采纳某条候选时记录一条。adoptedPosition 为 0-based 索引。
 */
export interface CompletionAdoptEvent {
  /** 事件类型标识（用于 JSON 反序列化区分） */
  type: 'adopted';
  /** 查询文本长度（与展示事件配对，不记原文） */
  queryLen: number;
  /** 查询文本 hash（与展示事件配对） */
  queryHash: string;
  /** 采纳位置（0-based，0=Top-1） */
  adoptedPosition: number;
  /** 采纳文本 hash（不记原文） */
  adoptedTextHash: string;
  /** 事件时间戳（ISO 字符串） */
  timestamp: string;
}

/**
 * 对话轮次事件（R1 激活率分母）
 *
 * 用户发送一次对话消息时记录一条，仅记时间戳。
 * 用途：激活率 = totalShown / totalChatTurns（补全弹窗唤起次数/对话次数）。
 */
export interface CompletionChatTurnEvent {
  /** 事件类型标识（用于 JSON 反序列化区分） */
  type: 'chat-turn';
  /** 事件时间戳（ISO 字符串） */
  timestamp: string;
}

/**
 * 召回可感知时刻事件（B2 纵向养成指标）
 *
 * 主进程推送 SPRITE_STREAM_RECALL（向用户展示召回记忆摘要）时记录一条。
 * 用途："你教过我 X"可感知时刻数——精灵向用户展示"想起 N 条记忆"的次数。
 * 仅记时间戳 + 召回条数，不记记忆内容。
 */
export interface CompletionRecallMomentEvent {
  /** 事件类型标识（用于 JSON 反序列化区分） */
  type: 'recall-moment';
  /** 召回记忆条数（来自 SPRITE_STREAM_RECALL payload，用于观察召回规模分布） */
  recallCount: number;
  /** 事件时间戳（ISO 字符串） */
  timestamp: string;
}

/** 事件联合类型 */
export type CompletionEvent =
  | CompletionShowEvent
  | CompletionAdoptEvent
  | CompletionChatTurnEvent
  | CompletionRecallMomentEvent;

/**
 * 聚合统计结果
 *
 * 由 getAggregated 从事件流实时计算，供统计面板展示。
 */
export interface CompletionAggregated {
  /** 展示事件总数 */
  totalShown: number;
  /** 采纳事件总数 */
  totalAdopted: number;
  /** 采纳率（0-1，totalAdopted / totalShown） */
  adoptionRate: number;
  /** Top-1 命中率（0-1，adoptedPosition===0 的采纳事件数 / totalAdopted） */
  top1HitRate: number;
  /** 平均采纳位置（0-based，仅统计采纳事件） */
  avgAdoptedPosition: number;
  /** 对话轮次总数（激活率分母，用户发送对话次数） */
  totalChatTurns: number;
  /** 激活率（0-1，totalShown / totalChatTurns，补全弹窗唤起次数/对话次数） */
  activationRate: number;
  /** 召回可感知时刻总数（精灵向用户展示"想起 N 条记忆"的次数） */
  recallMoments: number;
}

/**
 * 按日聚合统计结果（B2 纵向养成曲线）
 *
 * 由 getDailyAggregated 按日期分组计算，供统计面板渲染趋势曲线。
 * 每日一行，覆盖最近 N 天（默认 14 天）。
 */
export interface DailyAggregatedItem {
  /** 日期 key（YYYY-MM-DD，本地时区） */
  date: string;
  /** 当日展示事件数 */
  shown: number;
  /** 当日采纳事件数 */
  adopted: number;
  /** 当日对话轮次数 */
  chatTurns: number;
  /** 当日激活率（0-1，shown / chatTurns，chatTurns=0 时为 0） */
  activationRate: number;
  /** 当日召回可感知时刻数 */
  recallMoments: number;
}

// ─── 私有工具 ────────────────────────────────────────────

/**
 * FNV-1a 32 位 hash（同步，纯 JS 实现）— 统计去标识化场景使用（非安全场景）
 *
 * 算法：FNV offset basis 2166136261，FNV prime 16777619
 * 特点：分布均匀、碰撞率低、速度快，适合统计去标识场景
 *
 * 与内核 workProjection.ts 的 SHA-256 区别：
 * - workProjection 用 node:crypto SHA-256：作品内容去重，需密码学强度防碰撞，仅 Node 主进程可用
 * - 此处用 FNV-1a：统计去标识，碰撞可接受，渲染层（Chromium）可用
 * - 两者场景不同，不应强行复用同一工具
 *
 * @param text 原始文本
 * @returns 32 位无符号整数的十六进制字符串（8 字符），如 "a1b2c3d4"
 */
function simpleHash(text: string): string {
  // FNV-1a 参数
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
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

/**
 * ISO 时间戳 → 本地时区日期 key（YYYY-MM-DD）
 *
 * 用于 getDailyAggregated 按日分组。直接对 ISO 字符串 slice(0,10) 会取 UTC 日期，
 * 在东八区跨天边界会错位（UTC 16:00 = 北京次日 00:00），必须本地化后再格式化。
 * 与 shared/dateUtils.ts 的 formatDateKey 行为对齐，但不引入跨层依赖（本模块仅渲染层使用）。
 *
 * @param isoTimestamp ISO 8601 时间字符串（如 "2026-07-23T16:00:00.000Z"）
 * @returns 本地时区日期 key（如 "2026-07-24"，东八区跨天场景）
 */
function localDateKey(isoTimestamp: string): string {
  return localDateKeyFromDate(new Date(isoTimestamp));
}

/**
 * Date 对象 → 本地时区日期 key（YYYY-MM-DD）
 *
 * 直接使用 Date 的本地时区方法（getFullYear/getMonth/getDate），
 * 避免 toISOString().slice(0,10) 的 UTC 错位问题。
 *
 * @param date 日期对象
 * @returns 本地时区日期 key（YYYY-MM-DD，月份/日期两位补零）
 */
function localDateKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ─── 埋点模块 ────────────────────────────────────────────

/**
 * 补全统计埋点器
 *
 * 单例模式（全应用唯一实例），通过 getCompletionMetrics() 获取。
 * 数据持久化到 localStorage，LRU 500 条上限。
 */
export class CompletionMetrics {
  /** 事件流（按时间顺序，新事件追加末尾，超限从头淘汰） */
  private events: CompletionEvent[] = [];

  /**
   * 从 localStorage 加载历史事件
   *
   * 使用 safeGetJSON 静默降级，JSON 解析失败时返回空数组（视为首次使用）。
   * 调用方需校验返回值为数组（safeGetJSON 只负责安全读取 + 解析）。
   */
  constructor() {
    const parsed = safeGetJSON<unknown>(METRICS_STORAGE_KEY, []);
    this.events = Array.isArray(parsed) ? parsed as CompletionEvent[] : [];
  }

  // ─── 埋点方法 ──────────────────────────────────────────

  /**
   * 记录展示事件
   *
   * 在 renderCandidates 展示候选列表时调用。
   *
   * @param query 当前查询文本（只记 len + hash，不记原文）
   * @param shownCount 展示候选数（≤5）
   * @param totalCandidatesCount 合并去重后总数（slice 前）
   */
  recordShown(query: string, shownCount: number, totalCandidatesCount: number): void {
    const event: CompletionShowEvent = {
      type: 'shown',
      queryLen: query.length,
      queryHash: simpleHash(query),
      shownCount,
      totalCandidatesCount,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  /**
   * 记录采纳事件
   *
   * 在 recordAdoption 采纳候选时调用。
   *
   * @param query 当前查询文本（与展示事件配对）
   * @param adoptedText 采纳的候选文本（只记 hash，不记原文）
   * @param adoptedPosition 采纳位置（0-based，0=Top-1）
   */
  recordAdoption(query: string, adoptedText: string, adoptedPosition: number): void {
    const event: CompletionAdoptEvent = {
      type: 'adopted',
      queryLen: query.length,
      queryHash: simpleHash(query),
      adoptedPosition,
      adoptedTextHash: simpleHash(adoptedText),
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  /**
   * 记录对话轮次事件（R1 激活率分母）
   *
   * 用户发送一次对话消息时调用。仅记时间戳，不记消息内容。
   * 用途：激活率 = totalShown / totalChatTurns（补全弹窗唤起次数/对话次数）。
   * 度量不能影响功能：本方法 fire-and-forget，appendEvent 内部 safeSetJSON 失败静默降级。
   */
  recordChatTurn(): void {
    const event: CompletionChatTurnEvent = {
      type: 'chat-turn',
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  /**
   * 记录召回可感知时刻事件（B2 纵向养成指标）
   *
   * 主进程推送 SPRITE_STREAM_RECALL（向用户展示召回记忆摘要）时调用。
   * 用途："你教过我 X"可感知时刻数——精灵向用户展示"想起 N 条记忆"的次数。
   * 仅记时间戳 + 召回条数，不记记忆内容。
   * 度量不能影响功能：本方法 fire-and-forget，appendEvent 内部 safeSetJSON 失败静默降级。
   *
   * @param recallCount 本次召回展示给用户的记忆条数
   */
  recordRecallMoment(recallCount: number): void {
    const event: CompletionRecallMomentEvent = {
      type: 'recall-moment',
      recallCount,
      timestamp: new Date().toISOString(),
    };
    this.appendEvent(event);
  }

  // ─── 聚合查询 ──────────────────────────────────────────

  /**
   * 实时计算聚合统计
   *
   * 每次调用时从事件流遍历计算，避免 aggregated 与 events 不同步。
   * 显式按 type 分支统计（事件类型已扩展为 4 种，禁止用 else 假设非 shown 即 adopted）。
   *
   * @returns 聚合结果（无事件时 totalShown=0，adoptionRate=0）
   */
  getAggregated(): CompletionAggregated {
    let totalShown = 0;
    let totalAdopted = 0;
    let top1Count = 0;
    let positionSum = 0;
    let totalChatTurns = 0;
    let recallMoments = 0;

    for (const event of this.events) {
      switch (event.type) {
        case 'shown':
          totalShown++;
          break;
        case 'adopted':
          totalAdopted++;
          if (event.adoptedPosition === 0) top1Count++;
          positionSum += event.adoptedPosition;
          break;
        case 'chat-turn':
          totalChatTurns++;
          break;
        case 'recall-moment':
          recallMoments++;
          break;
      }
    }

    return {
      totalShown,
      totalAdopted,
      adoptionRate: totalShown > 0 ? totalAdopted / totalShown : 0,
      top1HitRate: totalAdopted > 0 ? top1Count / totalAdopted : 0,
      avgAdoptedPosition: totalAdopted > 0 ? positionSum / totalAdopted : 0,
      totalChatTurns,
      activationRate: totalChatTurns > 0 ? totalShown / totalChatTurns : 0,
      recallMoments,
    };
  }

  /**
   * 按日聚合统计（B2 纵向养成曲线）
   *
   * 按日期（本地时区 YYYY-MM-DD）分组统计最近 N 天的指标，供统计面板渲染趋势曲线。
   * 缺失日期补零（保证曲线连续性，避免空日期跳柱）。
   *
   * @param days 覆盖天数（默认 14，从今天向前回溯）
   * @returns 按日期升序排列的每日聚合数组（最旧日期在前，方便从左到右渲染时间轴）
   */
  getDailyAggregated(days = 14): DailyAggregatedItem[] {
    // 日期 key → 聚合累加器（shown/adopted/chatTurns/recallMoments）
    const dailyMap = new Map<string, { shown: number; adopted: number; chatTurns: number; recallMoments: number }>();

    // 遍历事件流按日累加（一次遍历，O(n)）
    for (const event of this.events) {
      const dateKey = localDateKey(event.timestamp);
      let bucket = dailyMap.get(dateKey);
      if (!bucket) {
        bucket = { shown: 0, adopted: 0, chatTurns: 0, recallMoments: 0 };
        dailyMap.set(dateKey, bucket);
      }
      switch (event.type) {
        case 'shown':
          bucket.shown++;
          break;
        case 'adopted':
          bucket.adopted++;
          break;
        case 'chat-turn':
          bucket.chatTurns++;
          break;
        case 'recall-moment':
          bucket.recallMoments++;
          break;
      }
    }

    // 生成最近 N 天的日期序列，缺失日期补零
    const result: DailyAggregatedItem[] = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = localDateKeyFromDate(date);
      const bucket = dailyMap.get(dateKey) ?? { shown: 0, adopted: 0, chatTurns: 0, recallMoments: 0 };
      result.push({
        date: dateKey,
        shown: bucket.shown,
        adopted: bucket.adopted,
        chatTurns: bucket.chatTurns,
        activationRate: bucket.chatTurns > 0 ? bucket.shown / bucket.chatTurns : 0,
        recallMoments: bucket.recallMoments,
      });
    }
    return result;
  }

  // ─── 数据管理 ──────────────────────────────────────────

  /**
   * 获取最近 N 条事件（供统计面板展示事件流详情）
   *
   * @param limit 返回条数（默认 50）
   */
  getRecentEvents(limit = 50): CompletionEvent[] {
    return this.events.slice(-limit).reverse();
  }

  /**
   * 清空所有统计数据（供测试和"重置统计"功能使用）
   *
   * 使用 safeSetJSON 统一 try-catch 静默降级（ADR-017 枝叶层 2 次提取）。
   */
  clear(): void {
    this.events = [];
    safeSetJSON(METRICS_STORAGE_KEY, this.events);
  }

  // ─── 内部方法 ──────────────────────────────────────────

  /**
   * 追加事件 + LRU 淘汰 + 持久化
   */
  private appendEvent(event: CompletionEvent): void {
    this.events.push(event);
    // LRU 淘汰：超限时从头删除（最老的事件）
    if (this.events.length > MAX_METRICS_ENTRIES) {
      this.events.splice(0, this.events.length - MAX_METRICS_ENTRIES);
    }
    safeSetJSON(METRICS_STORAGE_KEY, this.events);
  }
}

// ─── 单例 ────────────────────────────────────────────────

/**
 * 获取补全统计埋点器单例
 *
 * 懒加载：首次调用时创建实例并从 localStorage 加载历史数据。
 * 后续调用返回同一实例（保证事件流一致性）。
 *
 * 使用 createSingleton 封装懒创建模式（ADR-017 枝叶层 2 次提取）。
 */
export const getCompletionMetrics = createSingleton(() => new CompletionMetrics());
