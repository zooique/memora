# 召回互斥前置过滤 · 方案评估

> 状态：**已落地** · 关联：memory-as-summary §4.3 互斥排除、§4.7 召回保底 · 2026-08-16

## 一、问题背景

当前会话进行多轮后，最近 N 轮问答通过 `recentRounds` **全量加载**进上下文。
为防重复，`recallAndInject` 在注入前用 `getRecentRoundIds(recentRounds)` 做**后置互斥排除**，
剔除当前会话最近 N 轮的 round-summary（[agent.ts:758-767](file:///f:/zooique/memora/src/agent/agent.ts#L758-L767)）。

**缺陷**：持续聚焦的单会话中，当前会话最近几轮 round-summary 与当前输入**最相关、score 最高**，
且会话窗口优先（[recall.ts §4.4](file:///f:/zooique/memora/src/memory/recall.ts#L234)）让它们排最前。
top-`limit` 候选很可能**全部**被最近 N 轮摘要占满，后置互斥把这批全剔除后：

1. **跨会话记忆被挤占**：跨会话/早轮次记忆排在第 `limit+1` 名之后，**从未被取到**。而跨会话召回是记忆系统核心价值。
2. **minFallback 被绕过**：互斥排除发生在保底之后，保底补的若是当前会话最近轮摘要，又被互斥剔掉，等于白补，`minFallback=2`"每轮至少 N 条记忆"承诺失效。

## 二、方案对比

| 维度 | 方案 A（现状 · 后置互斥） | 方案 B（前置排除 · 推荐） |
|------|--------------------------|--------------------------|
| 去重位置 | recall() 返回后，agent 注入前 | recall() 内，`hybridMerge` 取 limit **前** |
| 召回预算 | 被最近 N 轮摘要**挤占** | 精准留给跨会话/早轮次记忆 |
| minFallback | 被绕过（白补） | 基于过滤后结果补足，真正生效 |
| recall 职责 | 纯检索（不知道会话状态） | 纯检索（仅多接受一个过滤条件） |
| 参数 | 无 | 新增 `excludeRoundIds`（+1） |
| 核心缺陷 | 跨会话召回失效 | 无（参数 +1 可控） |

## 三、方案 B 设计（推荐）

### 3.1 改动点

**`recall.ts`**：`RecallOptions` 新增可选 `excludeRoundIds?: Set<string>`。
在 [recall.ts:216](file:///f:/zooique/memora/src/memory/recall.ts#L216) 的 `hybridMerge(merged.values(), ...)` **之前**，过滤掉带这些 roundId 的 round-summary：

```typescript
// 前置排除（§4.3）：候选池先剔除当前会话最近 N 轮 round-summary，
// 避免其挤占 limit 预算，让跨会话/早轮次记忆进入 top-limit。
// 无 roundId 的非 round-summary 不受影响。
let candidates = merged.values();
if (excludeRoundIds && excludeRoundIds.size > 0) {
  candidates = [...candidates].filter(
    ([, e]) => !e.memory.metadata?.roundId || !excludeRoundIds.has(e.memory.metadata.roundId),
  );
}
const sorted = hybridMerge(candidates, limit, weights);
```

**`agent.ts`**：`recallAndInject` 把已算好的 `recentRoundIds` 传入 `recall({ excludeRoundIds: recentRoundIds })`，
并**移除** [agent.ts:758-767](file:///f:/zooique/memora/src/agent/agent.ts#L758-L767) 的后置互斥过滤块（去重职责收敛到 recall 一处）。

### 3.2 关键澄清（SSOT / 分层）

- **不破坏分层**：`excludeRoundIds` 由 agent 层计算传入（agent 本就在算 `recentRoundIds`），
  recall 只是多接受一个过滤条件（与 `excludeSources` 语义一致），**不是** recall 自己查 sessionStore。
- **去重权威唯一**：互斥过滤从 agent 后置块 + recall 前置块两处，收敛为 recall 内**一处**，符合单一真理源。
- **minFallback 不再白补**：保底基于过滤后的 `active` 计算，补足的是跨会话记忆，不被二次剔除。

### 3.3 默认值

`minFallback`、`recentRounds` 默认值不变。`excludeRoundIds` 缺省为空 Set（不排除），
recall 行为对未传该参数的调用方（如 [agent.ts:1335](file:///f:/zooique/memora/src/agent/agent.ts#L1335) 的检索路径）完全向后兼容。

## 四、测试影响

| 测试文件 | 现状 | 需新增 |
|---------|------|--------|
| `recall.test.ts` | 无互斥相关用例（互斥本在 agent 层） | 新增：`excludeRoundIds` 过滤最近 N 轮摘要、无 roundId 不受影响、过滤后跨会话记忆补位 top-limit、与 minFallback 协同 |
| `agent.ts` 相关测试 | 可能有互斥后置用例 | 核对：后置过滤块移除后，更新断言为"recall 内排除" |

## 五、风险与回退

- **风险低**：参数为可选、向后兼容；过滤逻辑从 agent 后置移到 recall 前置，语义等价（同一 roundId 集合、同一 N 来源 `resolveRecentRounds`）。
- **回退**：若发现前置过滤影响其他调用方，`excludeRoundIds` 缺省为空即还原现有行为。

## 六、决策点

✅ **推荐方案 B**：修复"跨会话召回被挤占 + minFallback 被绕过"实质缺陷，去重职责收敛到 recall 一处（SSOT），代价仅可选参数 +1。
成熟后更新 memory-as-summary §4.3 与 §4.7、role-pack-spec、CHANGELOG、README。