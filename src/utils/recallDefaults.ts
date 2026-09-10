/**
 * 召回默认值——单一真理源：`DEFAULT_MIN_FALLBACK` **仅 memory 召回层（recall.ts）自持**。
 * （原「被 role-pack 策略层与 memory 层共享」已不成立：召回策略键族随阶段2 整体退役，
 * role-pack 不再跨引用本常量，见 role-pack/strategyResolver.ts 顶部说明。）
 */

/** 召回保底下限默认值：语义召回不足时补足至该条数（0=关闭，默认 2） */
export const DEFAULT_MIN_FALLBACK = 2;

/**
 * 召回排除 source 默认值（空数组）——设定记忆（persona/rule/skill）已归角色包、
 * 记忆库不再写入，不再参与召回排除（memory-role-pack-boundary）。早年"默认排除三类设定
 * 记忆"的补丁式修复已随角色包解耦剪枝，此处仅保留空默认供记忆层与 agent 层共享引用。
 */
export const DEFAULT_RECALL_EXCLUDE_SOURCES: readonly string[] = [];
