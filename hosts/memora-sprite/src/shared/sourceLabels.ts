/**
 * 记忆来源中文标签映射 — 纯函数工具（shared 层共享真理源）
 *
 * 职责：
 * - 将记忆 source 字符串（开放字符串，ADR-004）映射为用户可读的中文标签
 * - 已知来源返回对应中文，未知来源透传原值（避免信息丢失）
 *
 * 设计原则：
 * - 纯函数，无副作用，无状态
 * - 下沉到 shared 层供 sprite 和 renderer 共享，消除双真理源（MIND-D6 嫁接）
 *
 * 消费点：
 * - renderer/helpers/sourceLabel.ts re-export（向后兼容，消费点零改动）
 * - sprite/controllers/patternDetector.ts 直接 import
 * - renderer/helpers/sourceColor.ts 派生 KNOWN_SOURCES
 */

/**
 * source → 中文标签映射表
 *
 * 注意：映射表是 source 显示标签的"单一真理源"（SOURCE_DISPLAY_LABELS），新增 source 类型时同步更新。
 *
 * 映射项（17 项）：
 * - profile / insight / rule / skill / guardrail / chat / file / work / memory / summary / note（11 项基础）
 * - persona / session / work-projection / quick-input / clipboard / timer（6 项扩展）
 *
 * 导出供 sourceColor.ts 派生 KNOWN_SOURCES（消除双真理源同步漂移风险）。
 */
export const SOURCE_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  profile: '个人偏好',
  insight: '洞察',
  rule: '规则',
  skill: '技能',
  guardrail: '安全',
  chat: '对话',
  file: '文件',
  work: '工作',
  memory: '记忆',
  summary: '摘要',
  note: '笔记',
  persona: '角色',
  session: '会话',
  'work-projection': '作品投影',
  'quick-input': '快速输入',
  clipboard: '剪贴板',
  timer: '定时器',
};

/**
 * 获取记忆来源对应的中文标签
 *
 * @param source 原始 source 字符串（开放字符串，如 'profile'、'insight'、'work-projection'）
 * @returns 中文标签；未知 source 透传原值，避免信息丢失
 */
export function getSourceLabel(source: string): string {
  return SOURCE_DISPLAY_LABELS[source] ?? source;
}
