/**
 * 懒解析的托管建会话直通包装（2026-11-17 真机缺陷修复）
 *
 * 【为什么有这个模块】
 * 装配期 `chatProvider` 面板实例尚未创建，回调只能在**调用时**解析（与 peekAgent 同一手法）；
 * 但"懒"不等于要手抄形参表——真机实测缺陷根因正是装配层手抄的 6 参箭头函数吞掉了新增的
 * 第 7 个可选参数 `mandate`，导致 `SessionMeta.workOrder` 在生产路径上永不落盘。
 *
 * 【为什么类型检查没拦住】
 * `mandate?: string` 是可选项 ⇒ TS 认为「6 参函数」可赋给「7 参（末位可选）函数」签名，
 * 少写一个可选形参不报错。这不是一次笔误，是"手抄签名"这一结构必然复发的失效模式。
 *
 * 【修法（SSOT）】
 * 参数表唯一真源 = `HostedSessionCreator` 类型本身；以 `Parameters<...>` 展开直通，
 * 后续增删参数自动贯通，装配层不再有任何"需要记得同步"的形参清单。
 */
import type { HostedSessionCreator } from './workSessionTools.js';

/**
 * 造一个「调用时才解析目标实现」的托管建会话回调
 *
 * @param resolve 调用时解析真实现（装配期面板尚未创建，必须延迟取）
 * @returns 与 `HostedSessionCreator` 逐参同形的直通函数（参数表由类型派生，不可手抄）
 */
export function lazyHostedSessionCreator(
  resolve: () => HostedSessionCreator,
): HostedSessionCreator {
  return (...args: Parameters<HostedSessionCreator>) => resolve()(...args);
}
