# Memora 内核打磨路线（T1–T4）

> 依据：[docs/memora-agent-kernel-review.md](memora-agent-kernel-review.md)（第三方内核评审，2026-08-19）所标示的实现债，逐条对治。
> 原则：**先收敛后大事**；**最小改动验证**；**不为打磨而打磨**。只对治"降低认知负担或真实风险"的债，不借打磨之名顺手重构。

---

## 打磨原则（前置约定）

1. **先收敛，后大事**：第一优先是收敛已存在的散乱，而非新增机制 / 拆分架构。
2. **最小改动验证**：每批先落一个最小改动、跑通 pre-commit（tsc --noEmit + lint-staged + commitlint），再铺开。
3. **不为打磨而打磨**：凡"改了只是更干净、但没降低认知负担或风险"的，一律不列。

---

## 批次与顺序

| 批次 | 任务 | 对治债 | 风险 | 状态 |
|------|------|--------|------|------|
| 第一批 | **T1** 策略打字收敛（11 setter → 单个策略对象） | 4.2 架构债 + 魔数债 | 中（触点多） | ✅ 已完成（落地记录见 T1） |
| 第一批 | **T2** "单一检查点"名实对齐 | 4.3 名实出入 | 极低 | ✅ 已完成（落地记录见 T2） |
| 第二批 | **T4** 文档去时态 / 名实清扫 | 5.2 文档耦合 | 低 | 待做 |
| 第二批 | **T3** `determineTaskType` 加固或接口化 | 5.2 硬编码启发式 | 中 | 待做（按需） |
| 慎做 | 僵尸码 / 僵尸键清扫（guardrail、ArchiveMode 三态残留、type→时间窗残留） | 5.2 冗余 | 低 | 仅洁癖层，非结构 |

**排序依据**：风险越低、ROI 越高、越符合单一真理源哲学者越靠前。T1 虽是中风险，但一次收敛两块债（策略 setter 分散 + 魔数分散）且不改运行时语义，故列第一优先。

---

## T1：策略打字收敛——11 个 setter → 单个 `L2RuntimeStrategy`

### 现状（已核查，非假设）

- **定义**：[loop.ts](../src/agent/loop.ts) 中 **11 个策略 setter**（L670–782）+ 各自 `private` 字段初始化（含魔数默认值 `tokenBudget=8000` L321、`stepBudget=50` L329，retry=2 在构造函数 L402、duplicateThreshold=3 在 L409）。
- **装配**：[agent.ts](./..%2Fsrc%2Fagent%2Fagent.ts) L551–584 **11 处** `loop.setXxx(resolveXxx(strategy))` 逐项调用。
- **解析函数**：[strategyResolver.ts](../src/role-pack/strategyResolver.ts) **10 个 `resolveXxx(strategy)`**（L210/248/266/294/308/322/338/382/426/440），入参为角色包声明的 `BehaviorStrategy`，返回 loop 运行态值；第 11 项 `loopContinue→maxSelfReviewRounds` 在 agent.ts L582–584 内联。
- **测试**：[loop.test.ts](../src/agent/__tests__/loop.test.ts) 中 **9 处**直接调用部分 setter。

### 目标形态（两层分离，对齐角色包边界纪律）

```
BehaviorStrategy（角色包声明，宽松可选键）
        │  resolve* 聚合
        ▼
L2RuntimeStrategy（loop 运行态，补默认值，全字段必填）
        ▼
loop.setStrategy(partial) ──合并──▶ 内部字段（读取点不变）
```

- **`BehaviorStrategy`**：维持现状，是角色包声明层，不动。
- **新增 `L2RuntimeStrategy`**（放 [types.ts](../src/agent/types.ts)）：一枚对象，内聚 11 项运行态策略 + `DEFAULT_L2_STRATEGY` 常量（原魔数收敛于此，**消灭魔数债**）。
- **新增聚合函数**：在 [strategyResolver.ts](../src/role-pack/strategyResolver.ts) 增加 `resolveL2Strategy(strategy): L2RuntimeStrategy`，**等价合并**现有 10 个 `resolveXxx` + loopContinue 分支（不删逐个 `resolveXxx`，若尚有其它消费则保留，无消费则一并折叠）。
- **loop 侧**：`AgentLoop` 新增 `setStrategy(partial: Partial<L2RuntimeStrategy>)`，一次性合并 11 个字段；**删除 11 个离散 setter**（保留 `setProvider/setChatOptions/setCurrentRoundId` 等非策略基础设施）。
- **agent 侧**：L551–584 的 11 处调用**收缩为一次** `loop.setStrategy(resolveL2Strategy(strategy))`。

### 关键设计决策：内部存储

**推荐：保留 loop 内部分字段，只收敛"赋值入口"为 `setStrategy`。** 理由：
- loop 内读取点（`handleIteration`/`handleToolCalls`/`executeOneTool` 读 `this.tokenBudget`、`this.toolReadonly` 等）**全部不动**，改动面最小、风险最低，符合"最小改动验证"。
- 不推荐"loop 内改为单一 `this.strategy.xxx` 对象读取"——那会波及所有读取点，显著扩大改动面且无收益，属过度打磨。

### 向后兼容与测试迁移（决策点，需对齐）

两种路线二选一：

- **路线 A（推荐，稳）**：`setStrategy` 新增 + 11 个旧 setter **保留为薄转发**（`setTokenBudget(n){ this.applyStrategy({tokenBudget:n}) }`），测试零改动，跑通回归后**下一批再删** setter。
- **路线 B（洁癖，激进）**：直接删 11 个 setter，同步迁移 loop.test.ts 的 9 处调用到 `setStrategy({...})`。符合"代码洁癖一次性删干净"，但一次性触碰面大。

> 建议默认走 **A**：先以"新增收敛 + 旧转发"落地并冻结回归，删除动作作为独立的低风险增量，避免在一次提交里既改结构又删 API。

### 调用点清单（已核查）

| 位置 | 行号 | 调用 | 处理 |
|------|------|------|------|
| [agent.ts](../src/agent/agent.ts) | L551 | `setToolCallsBlocked(resolveToolMode(strategy))` | → 并入 `setStrategy` |
| agent.ts | L554 | `setToolStepLimit(resolveToolStepLimit(strategy))` | → 并入 |
| agent.ts | L557 | `setErrorHandling(resolveErrorHandling(strategy))` | → 并入 |
| agent.ts | L560 | `setProviderRouting(resolveProviderRouting(strategy))` | → 并入 |
| agent.ts | L563 | `setInputInterrupt(resolveInputInterrupt(strategy))` | → 并入 |
| agent.ts | L566 | `setTokenBudget(resolveTokenBudget(strategy))` | → 并入 |
| agent.ts | L569 | `setStepBudget(resolveStepBudget(strategy))` | → 并入 |
| agent.ts | L572 | `setMultiStepReasoning(resolveMultiStepReasoning(strategy))` | → 并入 |
| agent.ts | L575 | `setToolReadonly(resolveToolReadonly(strategy))` | → 并入 |
| agent.ts | L578 | `setToolApproval(resolveToolApproval(strategy))` | → 并入 |
| agent.ts | L582–584 | `loopContinue`→`setMaxSelfReviewRounds`（内联） | → 并入聚合函数 |
| [loop.ts](../src/agent/loop.ts) | L670–782 | **11 个 setter 定义** | → 删/转发生 `setStrategy` |
| loop.ts | L249–345 | 策略字段初始化（含魔数默认值） | → 默认值移入 `DEFAULT_L2_STRATEGY` |
| [loop.test.ts](../src/agent/__tests__/loop.test.ts) | L1219/1259/1295/1331/1364 | `setMaxSelfReviewRounds` | → 路线 A 免改 / 路线 B 迁 `setStrategy` |
| loop.test.ts | L1363/1747/1788/1825 | `setToolCallsBlocked` | → 同上 |
| loop.test.ts | L2396/2423 | `setTokenBudget` | → 同上 |

### 验证

- `npx tsc --noEmit` 零错误（必过）。
- 测试回归：`agent/loop` 相关 test 全绿；若走路线 A，测试零改动即应全绿。
- 运行态语义不变（同一批 `resolve*` 结果，只是改一次写入）。

---

### 落地记录（2026-08-19 · 方案 Y 直接收敛）

**决策**：项目未正式启用、无需兼容 → 走**直接收敛**（既不做 setter 转发，也不保留 loop 镜像字段）：
- 直接删除 11 个策略 setter 与对应字段，loop 改为持有**单一 `L2RuntimeStrategy` 对象**，经 `setStrategy(partial)` 浅合并注入（方案 Y）。

**改动**：
- [role-pack/types.ts](../src/role-pack/types.ts)：新增 `L2RuntimeStrategy`（11 只读字段，复用既有 7 个策略联合类型）；re-export 增加 `resolveL2Strategy`。
- [role-pack/strategyResolver.ts](../src/role-pack/strategyResolver.ts)：新增 `DEFAULT_L2_STRATEGY`（收敛原 loop 魔数默认）+ `resolveL2Strategy`（聚合 10 个 resolveXxx + loopContinue 归一）。
- [agent/loop.ts](../src/agent/loop.ts)：删 11 策略字段 + 11 setter，改持 `private strategy`，读取点统一 `this.strategy.<field>`（~29 处）。
- [agent/agent.ts](../src/agent/agent.ts)：装配 11 处 setXxx 收缩为 `loop.setStrategy(resolveL2Strategy(strategy))`。
- [agent/__tests__/loop.test.ts](../src/agent/__tests__/loop.test.ts)：9 处调用迁移 `setStrategy`。

**发现（守恒测试纠错）**：`resolveToolStepLimit` 的 JSDoc 声称"非法/缺失回退默认 20"，但实现实际回退 **0**。新增守恒测试 `resolveL2Strategy(undefined) === DEFAULT_L2_STRATEGY` 戳穿该注释/实现不一致，据此将 `DEFAULT_L2_STRATEGY.toolStepLimit` 定为 **0**（对齐运行语义，非注释的 20）。

**验证**：`pnpm typecheck` 零错误；全量 `pnpm exec vitest run` **2242 passed / 1 skipped**；改动作业文件 eslint 清零；新增 `resolveL2Strategy` 用例 4 个（默认守恒 / toolMode 映射 / loopContinue 归一 / 局部覆盖）。

---

## T2：'单一检查点'名实对齐

- **问题**：文档写"统一单一检查点"（§7.2.1），实现是 `executeOneTool` 内 `toolReadonly → toolApproval → preExecutionCheck` 顺序闸门（[loop.ts](../src/agent/loop.ts#L1679-L1717)）。
- **改动**（不动行为）：将三段顺序判断收拢为一个私有 `applyPrechecks(tc)` 三态返回；文档同步改称"单点聚合的多重检查"。纯重构、零行为变化。

### 落地记录（2026-08-19 · 纯重构，零行为变化）

- [agent/loop.ts](../src/agent/loop.ts)：新增 `PreCheckDecision` 三态类型 + `applyPrechecks(tc)` 私有方法，将 `executeOneTool` 内的三段顺序闸门（只读 → 审批 → 宿主 preExecutionCheck）**原位抽取**为统一检查决策；`executeOneTool` 消费三态（denied/skip/execute），onToolExecuted 走改写参数。行为守恒（spring 守卫顺序与日志不变）。
- 文档/注释措辞统一（名实对齐）：[agent-design-philosophy.md §7.2.1](architecture/agent-design-philosophy.md)，及 loop.ts / agent.ts / assembler.ts / types.ts 相关注释，"统一执行前检查点 / 单一检查点 / 单一物理落地载体" → "统一执行入口 · 单点聚合的多重顺序检查"。
- **验证**：`loop.test.ts` 76 通过；`typecheck` 零错；eslint 清零（改动作业文件）。

---

## T3：`determineTaskType` 加固（按需）

- 现状：[loop.ts](../src/agent/loop.ts#L1308-L1322) `>500字符→reasoning`、检代码块→code，用于 Provider 路由（影响成本），过脆。
- 改动：先做"阈值进 `L2RuntimeStrategy`/配置"（治标）；宿主注入点 `taskTypeResolver?` 对齐既有 `DuplicateCallInterceptor` 的"策略参数化"模式，**仅当出现真实消费场景才做**（避免重蹈第 14 章"全景物化"覆辙）。

## T4：文档去时态 / 名实清扫

- 把"已实现/已落地"与"修订历史"从设计正文剥离（正文只留定案，历史下沉 ADR / 变更记录）。
- 核对残留"文档标【已落地】但代码已删"的过期引用（如 InsightExtractor、guardrail 摘除后残留）。

---

## 明确不建议做（防过度打磨）

- **拆分 agent.ts / loop.ts 大文件**：拆文件收益 < 风险，且破坏"门面 + 单一执行引擎"的可读性。真正该清的是已摘除功能的**僵尸码/僵尸键**，而非结构拆分。
- **降级记忆治理栈**：记忆是 memora 最强项，不许动。
- **新增插件系统 / 事件溯源**：harness-borrowing-assessment 已否决，理由依旧成立。