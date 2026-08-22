# 召回互斥前置过滤设计

> 定位：设计文档，描述召回互斥排除采用**前置过滤**（在 recall() 取 limit 前排除当前会话最近 N 轮 round-summary）的最终形态。关联：memory-as-summary §4.3 互斥排除、§4.7 召回保底。

> **演进状态**：本设计以 `recentRounds` 固定 N 轮为前提（**当前落地形态**）。目标设计为「动态轮数」——互斥窗口从「固定 N」改为「跟随实际注入轮数」，`recentRoundIds` 来源改为实际注入轮号集合；`recentRounds` 键、`resolveRecentRounds` **直接删除，不留过渡兼容**（设计阶段保持代码纯洁），见 [role-pack-spec.md](role-pack-spec.md)。

## 一、为什么要前置排除

当前会话进行多轮后，最近 N 轮问答通过 `recentRounds` **全量加载**进上下文，其 round-summary 不应再被召回注入。

互斥排除有两种放置位置：**后置**（`recallAndInject` 在注入前剔除）与**前置**（recall() 在 `hybridMerge` 取 limit 前剔除）。最终形态选定**前置排除**，原因是后置排除存在两个实质缺陷：

1. **跨会话记忆被挤占**：持续聚焦的单会话中，当前会话最近几轮 round-summary 与当前输入**最相关、score 最高**，且会话窗口优先（§4.4）让它们排最前。top-`limit` 候选很可能**全部**被最近 N 轮摘要占满，后置互斥把这批全剔除后，跨会话/早轮次记忆被挤到 `limit+1` 名之后，**从未被取到**——而跨会话召回是记忆系统核心价值。
2. **minFallback 被绕过**：后置互斥发生在保底之后，保底补的若是当前会话最近轮摘要，又被互斥剔掉，等于白补，`minFallback=2`"每轮至少 N 条记忆"承诺失效。

前置过滤把互斥排在取 limit 前，被排除的摘要不挤占预算，剩余候选自然补位，跨会话记忆能进入 top-limit，且保底基于过滤后的结果补足、真正生效。

## 二、设计（前置排除）

### 2.1 改动点

**`recall.ts`**：`RecallOptions` 新增可选 `excludeRoundIds?: Set<string>`。
在 `hybridMerge(merged.values(), ...)` **之前**，过滤掉带这些 roundId 的 round-summary：

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

**`agent.ts`**：`recallAndInject` 把已算好的 `recentRoundIds` 传入 `recall({ excludeRoundIds: recentRoundIds })`，去重职责收敛到 recall 一处。

### 2.2 关键澄清（SSOT / 分层）

- **不破坏分层**：`excludeRoundIds` 由 agent 层计算传入（agent 本就在算 `recentRoundIds`），recall 只是多接受一个过滤条件（与 `excludeSources` 语义一致），**不是** recall 自己查 sessionStore。
- **去重权威唯一**：互斥过滤收敛到 recall 内**一处**，符合单一真理源。
- **minFallback 不再白补**：保底基于过滤后的 `active` 计算，补足的是跨会话记忆，不被二次剔除。

### 2.3 默认值

`minFallback`、`recentRounds` 默认值不变。`excludeRoundIds` 缺省为空 Set（不排除），recall 行为对未传该参数的其他调用方完全向后兼容。

## 三、风险与回退

- **风险低**：参数为可选、向后兼容；过滤逻辑收敛到 recall 一处，语义等价（同一 roundId 集合、同一 N 来源 `resolveRecentRounds`）。
- **回退**：若未来需要保留另一调用方的检索路径不受影响，`excludeRoundIds` 缺省为空即还原纯检索行为——设计上保证可随时回退，无契约破坏。

## 四、结论

**前置排除是互斥过滤的最终形态**：修复"跨会话召回被挤占 + minFallback 被绕过"两个实质缺陷，去重职责收敛到 recall 一处（SSOT），代价仅可选参数 `excludeRoundIds` +1（缺省为空集合、向后兼容）。