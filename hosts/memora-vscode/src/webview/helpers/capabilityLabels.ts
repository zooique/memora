/**
 * capabilityLabels — 中立能力名（`域:动作`）→ 中文可读文案（SSOT）
 *
 * 角色管理视图（roles view）展示角色能力时的本地化映射。能力命名空间是内核概念
 * （role-pack-spec §四：`web:search` / `code:execute` / `task:plan`，见内核
 * capabilityMap.ts 的能力→工具映射），本文档只负责「UI 展示文案」，由 host 在
 * 推送 roles_loaded 时把 capability 翻译为 label。
 *
 * 特权模型口径（tool-exposure-model 2026-09-08；task:plan 移出 2026-09-16）：
 * memora 特权键 = web:search / web:fetch / code:execute，均已在此翻译；task:plan /
 * file:* / memory:recall 在 memora 属默认常驻工具、非特权键，但保留翻译作
 * **中立字典兼容**——其它实现生成的角色包若声明这些键（跨实现中立契约），
 * UI 仍能给出可读文案而非生硬回退原始名。
 *
 * 未知能力回退显示原始 capability（不硬造文案，避免误导）。
 */

/** 中立能力名 → 中文可读文案（未知能力不在此表，回退原始名） */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  // 文件域（memora 默认常驻工具；保留翻译 = 中立字典兼容）
  'file:read': '读取文件',
  'file:write': '写入文件',
  'file:list': '浏览目录',
  // 网络域（特权键）
  'web:search': '联网搜索',
  'web:fetch': '抓取网页正文',
  // 通用计算域（特权键）
  'code:execute': '代码执行',
  // 记忆域（memora 默认常驻；中立字典兼容）
  'memory:recall': '召回记忆',
  // 任务域（2026-09-16 起移出 memora 特权面，默认常驻；保留翻译 = 中立字典兼容）
  'task:plan': '任务规划',
  // 内核内部能力
  'llm:summarize': '摘要生成',
};

/** 能力名 → 中文标签（未知能力回退原始 capability 名） */
export function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}
