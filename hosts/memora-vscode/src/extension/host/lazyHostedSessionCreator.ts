/**
 * 懒解析 + owner 保活的托管建会话直通包装（2026-11-17 真机缺陷修复 V2）
 *
 * 【为什么有这个模块（双层根因）】
 * ① 装配期 chatProvider 面板实例尚未创建，回调只能在**调用时**解析（与 peekAgent 同一手法）；
 * ② 不能手抄形参表：真机实测缺陷 V1 根因是装配层手抄的 6 参箭头函数吞掉了新增的第 7 个可选
 *    参数 `mandate`，TS 不报错（可选参数使「6 参函数」可赋给「7 参签名」）；
 * ③ V2 回归根因（本模块 V1 引入）：resolve 返回类方法**引用**，裸调用时 `this` 丢——方法内部
 *    第一行就是 `this.sessionModes.isManaged`，直接崩。
 *
 * 【修法（SSOT）】
 * resolve 返回 **owner 对象**（不是裸方法引用），factory 内部用 `owner.createHostedSession(...args)`
 * 方法调用自动绑定 `this`，不靠任何「调用方必须先 bind」的文字契约。参数表仍由
 * `Parameters<HostedSessionCreator>` 派生，增删自动贯通。
 *
 * 【为什么类型检查拦不住这类失效模式】
 * 函数类型只看形参表和返回值，不看接收者绑定——「裸函数」可赋给「class 方法」签名，
 * TS 不报错。真正的 `this` 绑定只有运行时才能验证。所以：
 *   - factory 签名强制返回 owner 对象（类型层面排除裸方法引用）；
 *   - 单测里必须用**有 this 依赖的假对象**（不是 vi.fn）才能暴露这条风险。
 */
import type { HostedSessionCreator } from './workSessionTools.js';

/**
 * owner 形状：只暴露 createHostedSession，其余字段不关心
 *
 * 消费方（装配层 extension.ts）和测试都需要知道 resolve 必须返回这个形状，
 * 所以导出——但它是 type-only，不增加 API surface。
 */
export interface HostedSessionOwner {
  createHostedSession: HostedSessionCreator;
}

/**
 * 造一个「调用时才解析 owner、并保留 this 绑定」的托管建会话回调
 *
 * @param resolve 调用时解析 owner 对象（装配期面板尚未创建，必须延迟取）；
 *   返回值必须是**对象**，不是裸函数——factory 内部以 owner.method(...) 调用，
 *   this 自动绑定，不依赖 .bind() 或箭头函数。
 * @returns 与 HostedSessionCreator 逐参同形的直通函数（参数表由类型派生，不可手抄）
 */
export function lazyHostedSessionCreator(resolve: () => HostedSessionOwner): HostedSessionCreator {
  return (...args: Parameters<HostedSessionCreator>) => {
    const owner = resolve();
    return owner.createHostedSession(...args);
  };
}
