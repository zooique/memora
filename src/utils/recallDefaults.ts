/**
 * 召回默认值——单一真理源（记忆层与 agent 层共享）。
 *
 * `DEFAULT_MIN_FALLBACK` 已随 `recall()` 退役（「减法」2026-09-10）：该保底仅服务
 * 「检查点恢复的温记忆召回」，随跨重启恢复链整体退役而消亡（见 docs/白话设计文档.md 第六步）。
 */

/**
 * 召回排除 source 默认值（空数组）——设定记忆（persona/rule/skill）已归角色包、
 * 记忆库不再写入，不再参与召回排除（memory-role-pack-boundary）。早年"默认排除三类设定
 * 记忆"的补丁式修复已随角色包解耦剪枝，此处仅保留空默认供记忆层与 agent 层共享引用。
 */
export const DEFAULT_RECALL_EXCLUDE_SOURCES: readonly string[] = [];
