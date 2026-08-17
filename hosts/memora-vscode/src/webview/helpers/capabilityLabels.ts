/**
 * capabilityLabels — 中立能力名（`域:动作`）→ 中文可读文案（SSOT）
 *
 * 角色管理视图（roles view）展示角色能力时的本地化映射。能力命名空间是内核概念
 * （role-pack-spec §四：`file:read` / `web:search` / `llm:summarize`，见内核
 * capabilityMap.ts 的能力→工具映射），本文档只负责「UI 展示文案」，由 host 在
 * 推送 roles_loaded 时把 capability 翻译为 label。
 *
 * 未知能力回退显示原始 capability（不硬造文案，避免误导）。
 */

/** 中立能力名 → 中文可读文案（未知能力不在此表，回退原始名） */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  // 文件域
  'file:read': '读取文件',
  'file:write': '写入文件',
  'file:list': '浏览目录',
  // 网络域
  'web:search': '联网搜索',
  // 记忆域
  'memory:recall': '召回记忆',
  // 任务域
  'task:plan': '任务规划',
  // 内核内部能力
  'llm:summarize': '摘要生成',
};

/** 能力名 → 中文标签（未知能力回退原始 capability 名） */
export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}
