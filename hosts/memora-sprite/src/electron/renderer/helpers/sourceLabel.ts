/**
 * 记忆来源中文标签映射 — 纯函数工具
 *
 * 职责：
 * - 将记忆 source 字符串（开放字符串，ADR-004）映射为用户可读的中文标签
 * - 已知来源返回对应中文，未知来源透传原值（避免信息丢失）
 *
 * 设计原则：
 * - 纯函数，无副作用，无状态
 * - 与 sourceColor.ts 同层，作为 source 相关的共享工具
 * - 统一全 UI 层 source 命名展示，消除"英文原值直显"体验问题（UX-2）
 *
 * 消费点（8 处）：
 * - memoryPanelManager.ts（记忆列表 + 回收站列表）
 * - memoryDetailPanel.ts（详情弹窗 + 演化脉络 2 处）
 * - memoryTimelineView.ts（时间线列表）
 * - insightsRenderer.ts（source 分布条）
 * - profilePanelManager.ts（画像条目）
 * - dashboardPanelManager.ts（sourceHealth 区域，原私有 getSourceLabel 已迁移）
 *
 * 与 quickInputCompletion.ts 的 SOURCE_LABEL_MAP 关系：
 * - 该文件保留独立的 4 项精简映射（insight/profile/work-projection + 默认'记忆'），
 *   因为补全候选场景需要更短的标签（'作品' vs '作品投影'），不强制统一。
 */

/**
 * source → 中文标签映射表
 *
 * 注意：映射表是 source 显示的"单一真理源"，新增 source 类型时同步更新。
 * 保留 dashboardPanelManager.getSourceLabel 原有 12 项映射不变，并补充 4 项缺失：
 * - work-projection → '作品投影'（补全，原 quickInputCompletion 用 '作品'，此处取更准确的全称）
 * - quick-input → '快速输入'（补全，main.ts:839 upsertMemory 使用）
 * - clipboard → '剪贴板'（补全，clipboardManager.ts:283 upsertMemory 使用）
 * - timer → '定时器'（补全，triggers.test.ts 触发器 source）
 *
 * 导出供 sourceColor.ts 派生 KNOWN_SOURCES（消除双真理源同步漂移风险）。
 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
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
  return SOURCE_LABELS[source] ?? source;
}
