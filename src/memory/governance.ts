/**
 * 记忆治理共享常量 — 治理源列表。
 * 排序单归语义分：使用轨迹唯一事实源为 accessedAt，无 score 写位/排序/clamp 位。
 * 纯常量模块（零依赖，仅类型 import），被 agent/managers 多模块消费，符合 agent → memory 单向依赖。
 *
 * 治理模型：supersede（写时取代）；无衰减——
 * 摘要是事实记录无"过时"语义，记忆有效性由 superseded 写时取代判定，
 * 低频记忆经相关性排序自然后移退出召回面，无"沉底/自然遗忘归档"语义。
 */

/**
 * 治理源列表：实际写入记忆库的 source 才参与去重 / 冲突治理。
 * 当前记忆库唯一自动轨 = round-summary（摘要即记忆本体，见 memory-as-summary.md），
 * 其治理由 superseded 写时取代承担，不入本数组；content 历史残留 source 无生产写入路径。
 * 空列表时 dedup/冲突检测空转（测试可显式注入治理源）。
 */
export const GOVERNANCE_SOURCES: readonly string[] = [];
