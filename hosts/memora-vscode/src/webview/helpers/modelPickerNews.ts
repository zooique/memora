/**
 * 模型菜单「新出现项」差集（MODEL-PICKER-NEW-1）
 *
 * 语义边界（排雷后裁定）：高亮 = **刚出现**，不是「刚保存」也不是「已切换」——
 * 保存成功的 saved name 不在 cfg_result 里，chat 侧无从判定「刚保存」；is-active 才是
 * 「当前会话激活」，两者正交，不得互相冒充。这里只从既有 `chat_providers` 的 name 列表
 * 派生差集：零新协议字段、零跨面板状态、零第二真源。
 *
 * 首次快照（prev 为空）不标 New ⇒ 冷启动不会把全部存量模型误报成「新」；只有列表真的
 * 变长（添加模型）才命中。后续任意一次 providers 推送若列表未变，差集自然清空，角标
 * 随之消失——正好对应「用户已经看到/切走」的完成语义，无需额外定时器或选中回调。
 */
export function diffNewProviderNames(
  prev: readonly string[],
  next: readonly string[],
): ReadonlySet<string> {
  if (prev.length === 0) return new Set();
  const before = new Set(prev);
  return new Set(next.filter((name) => !before.has(name)));
}
