/**
 * 精灵统计共享类型
 *
 * 跨子系统共享的精灵统计类型定义。从 sprite/controllers/proactiveEngine.ts 提取，
 * 消除 renderer 反向引用 sprite/controllers 的跨子系统依赖。
 *
 * 设计原则：
 *   - 单一真理源：ProactiveStats 类型定义在此文件，sprite/controllers 通过 re-export 复用
 *   - 无 Node 依赖：纯类型定义，符合 shared/ 层约束
 *   - 自然生长：renderer 多处反向引用已超过 ADR-017 枝叶层 2 次提取阈值
 */

/**
 * 主动提示统计快照（供 UI 感知面板展示）
 *
 * 透传 ProactiveEngine 内部的历史反馈和当前生效冷却参数，
 * 让用户看到"我与精灵的互动累计"以及"为什么连续拒绝后精灵变安静"。
 */
export interface ProactiveStats {
  /** 历史主动提示总次数 */
  suggestCount: number;
  /** 用户接受次数 */
  acceptCount: number;
  /** 接受率 0-1（suggestCount=0 时为默认值 0.5） */
  acceptanceRate: number;
  /** 当前连续拒绝次数（每次拒绝递增，接受重置） */
  consecutiveRejects: number;
  /** 当前生效冷却毫秒（受默契度 + 拒绝惩罚双调节） */
  effectiveCooldownMs: number;
  /** 基础冷却毫秒（配置值，用于对比展示生效冷却） */
  baseCooldownMs: number;
}
