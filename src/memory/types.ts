/**
 * 记忆类型定义 — 基元驱动模型：记忆即轮次摘要（memory-as-summary），source 以开放字符串承载溯源标签（替代封闭枚举）
 */

import { configError } from '@/utils/errors.js';
import { isPlainObject } from '@/utils/objects.js';

// ─── 共享类型：消息角色（SSOT 单一真理源） ──────────────

/**
 * 消息角色：统一 agent/types.ts 的 ChatMessage 与 sessionStore.ts 的 SessionMessage
 * 含 tool 角色，用于 LLM 工具调用消息的持久化
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ─── 基元定义 ─────────────────────────────────────────────

/**
 * 记忆基元接口：id/content/source/name/createdAt/accessedAt 6 个基础字段
 * + deletedAt 可选（软删除）
 * 检索为纯关键词单通道，无持久化排序分字段，使用轨迹唯一事实源为 accessedAt
 */
export interface Memory {
  /** 唯一标识，格式 source:name，如 'rule:core'、'round-summary:session:r1' */
  id: string;
  /** 记忆内容（Markdown 文本） */
  content: string;
  /** 来源标签（开放字符串，非枚举） */
  source: string;
  /** 可读名称（文件名或摘要标题） */
  name: string;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /** 最后访问时间（每次召回时刷新） */
  accessedAt: string;
  /** 软删除时间；非 undefined 表示已删除，回收站保留 30 天后物理清理 */
  deletedAt?: string;
  /**
   * 额外的键值对元数据（可选透传字段，内核侧无生产写入方）。
   * ⚠️ 不承载 round-summary 的溯源/分类字段——summaryType/sessionName/roundId 已提升为顶层
   * 持久化字段（metadata 不在存储契约的保证范围内，而分层分轨/会话优先须跨会话生效，见 supersededBy 同款先例）。
   */
  metadata?: Record<string, string>;
  /**
   * round-summary 摘要类型（preference/fact/decision/intent/general）。
   * 顶层持久化字段：metadata 不在存储契约的保证范围内，
   * 而分轨召回须跨会话可靠读取，故提升为顶层列。仅 round-summary 有意义。
   */
  summaryType?: SummaryType;
  /** round-summary 归属会话标识（${date}-${session}）。顶层持久化字段，供会话内/外分层召回。仅 round-summary 有意义 */
  sessionName?: string;
  /** round-summary 归属轮次标识。顶层持久化字段，供互斥轮次排除与 traceSummary 回溯。仅 round-summary 有意义 */
  roundId?: string;
  /** 摘要是否已被人工修改，可能与原始对话不一致；仅 round-summary 有意义 */
  isModified?: boolean;
  /**
   * 写路径取代标记：非 undefined 表示已被更新的摘要覆盖，召回时确定性过滤；
   * 值为取代它的新摘要 id，本条保留以便 traceSummary 回溯。设计为顶层持久化字段而非
   * metadata（宿主不持久化 metadata，而 superseded 须跨会话生效）
   */
  supersededBy?: string;
}

/**
 * round-summary 摘要类型取值集合（单一真源：运行时校验与类型声明均从此派生）。
 * 新增取值只改此处——若类型与运行时校验集双写，类型扩展会静默漏掉校验集，
 * 导致新类型摘要被兜底为 'general'（行为漂移无编译报错）。
 */
export const SUMMARY_TYPES = ['preference', 'fact', 'decision', 'intent', 'general'] as const;

/**
 * round-summary 记忆的摘要类型，摘要生成时由 LLM 自动判断，无独立分类器
 */
export type SummaryType = (typeof SUMMARY_TYPES)[number];

/**
 * 记忆解析器 — 验证原始数据并转换为 Memory
 * 校验：非空对象、字段类型、ISO 8601 日期
 *
 * **白名单构造**：返回值只含 Memory 接口声明的字段，源对象上的任何未知字段（如旧档残留的
 * `score`）一律剥离——宿主读旧档经此函数即完成数据层清洗，无需另写迁移脚本。
 *
 * @param raw - 原始数据（通常来自 JSON 解析或数据库查询）
 * @returns 验证通过的 Memory 对象（仅白名单字段，未知字段已剥离）
 * @throws Error 当数据不符合 Memory 接口定义时
 */
export function parseMemory(raw: unknown): Memory {
  if (raw === null || typeof raw !== 'object') {
    throw configError(
      'Memory 解析失败',
      '输入必须是非空对象',
      ['检查数据源（JSON 文件 / 数据库查询）是否返回了有效对象'],
    );
  }

  const obj = raw as Record<string, unknown>;

  // 验证必需的 string 字段
  const stringFields = ['id', 'content', 'source', 'name'] as const;
  for (const field of stringFields) {
    if (typeof obj[field] !== 'string') {
      throw configError(
        'Memory 解析失败',
        `${field} 必须是字符串`,
        [`检查数据源中 ${field} 字段的类型（当前为 ${typeof obj[field]}）`],
      );
    }
  }

  // 验证 ISO 8601 日期字段
  const dateFields = ['createdAt', 'accessedAt'] as const;
  for (const field of dateFields) {
    if (typeof obj[field] !== 'string' || isNaN(Date.parse(obj[field] as string))) {
      throw configError(
        'Memory 解析失败',
        `${field} 必须是有效的 ISO 8601 日期字符串`,
        [`检查数据源中 ${field} 字段的格式（当前值: ${JSON.stringify(obj[field])}）`],
      );
    }
  }

  // 验证可选的 deletedAt 字段（null 视为未删除并归一为 undefined：
  // JSON 落盘可能出现 null，而 deletedAt?: string 不允许 null——否则消费方判
  // `deletedAt === undefined` 会因 null !== undefined 把活跃记忆误判为已删除）
  if (obj.deletedAt !== undefined && obj.deletedAt !== null) {
    if (typeof obj.deletedAt !== 'string' || isNaN(Date.parse(obj.deletedAt as string))) {
      throw configError(
        'Memory 解析失败',
        `deletedAt 必须是有效的 ISO 8601 日期字符串（当前值: ${JSON.stringify(obj.deletedAt)}）`,
        ['检查数据源中 deletedAt 字段的格式'],
      );
    }
  }

  // 验证可选语义字段的类型（运行时校验与类型声明同源）：不可信磁盘 JSON 的非法值
  // （如 summaryType: 'bogus' / isModified: 'yes'）靠 as 断言透传会致
  // round-summary 分轨召回与编辑标记消费行为漂移（无编译报错）。
  if (obj.metadata !== undefined && !isPlainObject(obj.metadata)) {
    throw configError(
      'Memory 解析失败',
      `metadata 必须是对象（当前为 ${typeof obj.metadata}）`,
      ['检查数据源中 metadata 字段的类型'],
    );
  }
  if (obj.summaryType !== undefined && !SUMMARY_TYPES.includes(obj.summaryType as SummaryType)) {
    throw configError(
      'Memory 解析失败',
      `summaryType 必须是合法摘要类型之一：${SUMMARY_TYPES.join(' / ')}（当前为 ${JSON.stringify(obj.summaryType)}）`,
      ['检查数据源中 summaryType 字段的取值'],
    );
  }
  if (obj.sessionName !== undefined && typeof obj.sessionName !== 'string') {
    throw configError(
      'Memory 解析失败',
      `sessionName 必须是字符串（当前为 ${typeof obj.sessionName}）`,
      ['检查数据源中 sessionName 字段的类型'],
    );
  }
  if (obj.roundId !== undefined && typeof obj.roundId !== 'string') {
    throw configError(
      'Memory 解析失败',
      `roundId 必须是字符串（当前为 ${typeof obj.roundId}）`,
      ['检查数据源中 roundId 字段的类型'],
    );
  }
  if (obj.isModified !== undefined && typeof obj.isModified !== 'boolean') {
    throw configError(
      'Memory 解析失败',
      `isModified 必须是布尔值（当前为 ${typeof obj.isModified}）`,
      ['检查数据源中 isModified 字段的类型'],
    );
  }
  if (obj.supersededBy !== undefined && typeof obj.supersededBy !== 'string') {
    throw configError(
      'Memory 解析失败',
      `supersededBy 必须是字符串（当前为 ${typeof obj.supersededBy}）`,
      ['检查数据源中 supersededBy 字段的类型'],
    );
  }

  return {
    id: obj.id as string,
    content: obj.content as string,
    source: obj.source as string,
    name: obj.name as string,
    createdAt: obj.createdAt as string,
    accessedAt: obj.accessedAt as string,
    deletedAt: (obj.deletedAt as string | undefined) ?? undefined,
    metadata: obj.metadata as Record<string, string> | undefined,
    summaryType: obj.summaryType as SummaryType | undefined,
    sessionName: obj.sessionName as string | undefined,
    roundId: obj.roundId as string | undefined,
    isModified: obj.isModified as boolean | undefined,
    supersededBy: obj.supersededBy as string | undefined,
  };
}

// ─── source 标签约定（非枚举，仅为当前使用的约定） ──────

/**
 * 当前使用的 source 标签约定；source 是开放字符串，新增来源无需改代码，存储时指定即可
 *
 * persona / rule / skill / work-projection 为残留兼容标签：对应内容不归记忆库管理
 * （角色包内容由角色包管理，作品投影落项目目录 projections/），标签保留用于
 * typo 检测（sourceValidation.ts：KNOWN_SOURCES 集合）与存量行/外部导入识别；
 * 它们不出现在 GOVERNANCE_SOURCES 中（治理系统只治理实际写入记忆库的 source）。
 */
export const SOURCE_LABELS = {
  /** 角色人格（角色包 content/persona.md）— 残留兼容标签，不写入记忆库 */
  PERSONA: 'persona',
  /** 创作规则（角色包 content/rules.md + .memora/rules/*.md）— 残留兼容标签，不写入记忆库 */
  RULE: 'rule',
  /** 技能定义（角色包 skills/ 目录）— 残留兼容标签，不写入记忆库 */
  SKILL: 'skill',
  /** 作品投影（读取用户作品时生成的概要）— 残留兼容标签，作品落项目目录 projections/ */
  WORK_PROJECTION: 'work-projection',
  /** 轮次摘要（每轮对话后生成的溯源式摘要，记忆即摘要） */
  ROUND_SUMMARY: 'round-summary',
  /** 未知来源（未被已知标签覆盖时的兜底值） */
  UNKNOWN: 'unknown',
} as const;

// ─── round-summary 规范 ID 构造（单一真源） ────────────────

/**
 * round-summary 记忆的规范 ID：`{source}:{sessionName}:{roundId}`。
 * 读写/过滤侧一律经本函数构造，禁止散落 `round-summary:` 字面量——
 * 溯源标签变更只需同步 SOURCE_LABELS，此处自动跟随。
 */
export function roundSummaryMemoryId(sessionName: string, roundId: string): string {
  return `${SOURCE_LABELS.ROUND_SUMMARY}:${sessionName}:${roundId}`;
}

/** 会话级前缀（定位某会话的全部摘要记忆），与 roundSummaryMemoryId 同源 */
export function roundSummarySessionPrefix(sessionName: string): string {
  return `${SOURCE_LABELS.ROUND_SUMMARY}:${sessionName}:`;
}