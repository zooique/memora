# MIND2-A3 facade 边界收敛方案

## 一、现状分析

### 1.1 演进路径

index.ts 导出 3 类"内部实现"：
- RelationBuilder（line 50）——内部 Manager
- MemoryGovernance（line 81）——内部 Manager
- EvalRunner/EVAL_SCENARIOS（line 176-179）——eval 框架

### 1.2 调研结论：不修（合理设计，已有边界注释）

| 导出项 | 宿主 import 情况 | 内核内部 import 情况 | 判定 |
|--------|-----------------|---------------------|------|
| RelationBuilder | 0 处 | assembler.ts / insightExtractor.ts（用 @/ 路径） | 合理门面 API |
| MemoryGovernance | 0 处 | agent.ts（用 @/ 路径） | 合理门面 API |
| EvalRunner | 0 处 | eval/__tests__/（用 @/ 路径） | 已有注释边界 |

**关键发现**：
1. 宿主（memora-sprite）从未 import 这 3 类——它们是给"第三方宿主"准备的公共 API
2. 内核内部用 `@/agent/managers/...` 路径直接 import，不依赖 index.ts 导出
3. eval 导出已有明确注释：「主要供 CI 回归测试使用，运行时零消费者，不应在业务代码中 import」

### 1.3 与原始审查的对照

原始审查说"index.ts:174-175 注释自承 eval「不应在业务代码中 import」却仍公开导出——自相矛盾"。

**实际不是自相矛盾**：注释说的是"不应在业务代码中 import"——意思是 eval 是测试工具，
不是运行时 API。保留导出是给 CI 和外部宿主编写 eval 场景用。这是明确的定位区分，不是矛盾。

### 1.4 物理隔离的收益评估

将 eval 移到子路径 `memora/eval`：
- 收益：import 时物理区分运行时 API 和测试工具
- 成本：创建 src/eval/index.ts + 修改 index.ts + 修改 package.json exports
- 当前状态：注释已明确边界，无混淆问题

**结论**：收益边际，判定**不修**。

## 二、不提取的归档

| 项 | 理由 |
|----|------|
| eval 移到子路径 | 注释已明确边界，物理隔离是 nice-to-have |
| RelationBuilder 移除导出 | 是合理门面 API，供第三方宿主直接构建关系 |
| MemoryGovernance 移除导出 | 是合理门面 API，供第三方宿主直接调用治理 |

## 三、后续演进路径

```
本轮：判定不修（合理设计，已有边界注释）
  ↓
观察期：若未来 eval 导出导致混淆（如宿主误 import eval 到运行时代码），
  再移到子路径 memora/eval
  ↓
终态：保持 index.ts 统一导出，靠注释维持边界
```

## 四、验证计划

无需验证（判定不修）。

## 五、实施完成

### 5.1 结论
判定不修。归档为"合理设计，已有边界注释"。

### 5.2 实际修改文件清单
无代码修改。仅更新待完成任务文档。
