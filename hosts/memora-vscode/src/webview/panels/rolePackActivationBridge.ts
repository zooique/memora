/**
 * 角色包激活态 → 对话面板的桥（宿主侧唯一注册点）
 *
 * 为什么必须有这条桥：内核 `RolePackManager.onRolePackActivated` 在「删除当前激活包 →
 * 兜底回退」时触发，但该路径**不发射** `rolePackSwitched` 事件；只接事件时对话头部会一直
 * 显示已删除的包名（设置页提示已回退，两头分叉）。
 *
 * 复用既有 `rolePackSwitched` 处理路径（调用方传入同一个处理器）；防双发判据在处理器内
 *（手动切换会经「activate 回调 + rolePackSwitched 事件」两次到达，由「与面板当前值相同
 * 即跳过」收口），本模块不另造第二套判重。
 */

/**
 * 注册角色包激活态回调，把变更转交面板的 `rolePackSwitched` 处理器。
 *
 * @param manager 内核角色包管理器（未装配时为 null/undefined，静默跳过）
 * @param handle 面板既有的 `rolePackSwitched` 处理器
 */
export function bridgeRolePackActivation(
  manager:
    | { onRolePackActivated(cb: (from: string | null, to: string | null) => void): void }
    | null
    | undefined,
  handle: (info: { from: string | null; to: string }) => void,
): void {
  manager?.onRolePackActivated((from, to) => {
    // to=null：激活被清空（兜底包也缺失、降级继续运行）——无可展示角色名，保持现状
    if (to) handle({ from, to });
  });
}
