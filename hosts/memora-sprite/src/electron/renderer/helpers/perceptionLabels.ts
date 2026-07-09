/**
 * 感知数据标签映射（统一真理源）
 *
 * 职责：
 * - 集中管理所有感知数据的中文标签映射（默契度/情感/节奏/连贯性/深度）
 * - 消除 PerceptionPanelManager / SpriteStatusPopover / NarrativeGenerator
 *   中的重复实现，确保全应用标签文案一致
 * - 对齐 sprite 层真理源（rapportController.ts / contextAwareness.ts / affectController.ts）
 *
 * 设计原则：
 * - 纯函数模块，零状态，零副作用
 * - 所有映射与 sprite 层保持一致（标签文案的真理源在 sprite 控制器）
 * - 阈值常量与感知渲染器共享（AFFECT_LOW_THRESHOLD / AFFECT_MID_THRESHOLD）
 */

// ─── 阈值常量（与感知渲染器一致，用于情感维度等级判定） ───

/** 情感维度等级划分阈值：< 低阈值 为"低"，< 中阈值 为"中"，否则为"高" */
export const AFFECT_LOW_THRESHOLD = 0.33;
export const AFFECT_MID_THRESHOLD = 0.67;

// ─── 默契度等级标签 ────────────────────────────────────────

/**
 * 默契度等级 → 中文标签映射
 *
 * 真理源：rapportController.ts / memoryController.ts
 * 四级体系：stranger → 初识, acquaintance → 相识, familiar → 熟悉, close → 亲密
 *
 * @param level 等级标识符
 * @returns 中文标签（初识/相识/熟悉/亲密）
 */
export function getRapportLevelLabel(level: string): string {
  const labelMap: Record<string, string> = {
    stranger: '初识',
    acquaintance: '相识',
    familiar: '熟悉',
    close: '亲密',
  };
  return labelMap[level] ?? level;
}

// ─── 情感维度等级/颜色 ────────────────────────────────────

/**
 * 将 0-1 情感数值映射为中文等级（低/中/高）
 *
 * 阈值：< 0.33 → 低, < 0.67 → 中, ≥ 0.67 → 高
 *
 * @param value 0-1 之间的数值
 * @returns 中文等级（低/中/高）
 */
export function getAffectLevel(value: number): string {
  if (value < AFFECT_LOW_THRESHOLD) return '低';
  if (value < AFFECT_MID_THRESHOLD) return '中';
  return '高';
}

/**
 * 将 0-1 情感数值映射为进度条颜色（CSS 变量引用）
 *
 * 使用 CSS 变量支持主题切换。
 *
 * @param value 0-1 之间的数值
 * @returns CSS 变量引用字符串（var(--affect-low/mid/high)）
 */
export function getAffectColor(value: number): string {
  if (value < AFFECT_LOW_THRESHOLD) return 'var(--affect-low)';
  if (value < AFFECT_MID_THRESHOLD) return 'var(--affect-mid)';
  return 'var(--affect-high)';
}

// ─── 对话上下文标签 ───────────────────────────────────────

/**
 * 对话节奏 → 中文标签映射
 *
 * 真理源：ContextAwareness.describeRhythm
 *
 * @param rhythm 节奏标识符
 * @returns 中文标签（快节奏/正常/慢节奏/空闲）
 */
export function describeRhythm(rhythm: string): string {
  const rhythmMap: Record<string, string> = {
    rapid: '快节奏',
    normal: '正常',
    slow: '慢节奏',
    idle: '空闲',
  };
  return rhythmMap[rhythm] ?? rhythm;
}

/**
 * 话题连贯性 → 中文标签映射
 *
 * 真理源：ContextAwareness.describeCoherence
 *
 * @param coherence 连贯性标识符
 * @returns 中文标签（专注/中等/分散/无）
 */
export function describeCoherence(coherence: string): string {
  const coherenceMap: Record<string, string> = {
    focused: '专注',
    moderate: '中等',
    scattered: '分散',
    none: '无',
  };
  return coherenceMap[coherence] ?? coherence;
}

/**
 * 对话深度 → 中文标签映射
 *
 * 真理源：ContextAwareness.describeDepth
 *
 * @param depth 深度标识符
 * @returns 中文标签（深度讨论/一般讨论/浅层问答/无）
 */
export function describeDepth(depth: string): string {
  const depthMap: Record<string, string> = {
    deep: '深度讨论',
    moderate: '一般讨论',
    shallow: '浅层问答',
    none: '无',
  };
  return depthMap[depth] ?? depth;
}
